import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { requestFingerprint, stableId, writeDurableFile, writeDurableJson } from "./durable-state.js";
import { physicalPath } from "./goals/control.js";
import { resourceNumber } from "./resource-policy.js";
import type { ChatEvent } from "./transport.js";

export type InboxStatus = "queued" | "running" | "completed" | "rejected" | "expired" | "dead" | "unknown";
export interface InboxRecord {
	version: 1;
	revision?: number;
	source?: string;
	manualRetries?: number;
	archivedAt?: number;
	dedupeUntil?: number;
	id: string;
	event: ChatEvent;
	preparedEvent?: ChatEvent;
	isEvent: boolean;
	fingerprint: string;
	status: InboxStatus;
	acceptedAt: number;
	expiresAt: number;
	attempts: number;
	detail?: string;
}
const statuses: InboxStatus[] = ["queued", "running", "completed", "rejected", "expired", "dead", "unknown"];
/** One instance owns this local journal under the process kernel lock. */
export class DurableInbox {
	private readonly records = new Map<string, InboxRecord>();
	private loaded = false;
	accepting = true;
	dispatchPaused = false;
	stopAdmission(): void {
		this.accepting = false;
	}
	constructor(
		private readonly directory: string,
		private readonly maxAttempts = 3,
	) {
		this.directory = physicalPath(directory);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
	}
	private path(id: string): string {
		if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid inbox ID");
		return join(this.directory, `${id}.json`);
	}

	private readRecord(path: string, id: string): InboxRecord | undefined {
		if (!existsSync(path)) return undefined;
		if (physicalPath(dirname(path)) !== dirname(path)) throw new Error("Inbox parent directory replaced");
		const info = lstatSync(path);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4 * 1024 * 1024)
			throw new Error("Invalid inbox file");
		const r = JSON.parse(readFileSync(path, "utf8")) as InboxRecord;
		if (
			r.version !== 1 ||
			r.id !== id ||
			!statuses.includes(r.status) ||
			!r.event ||
			!Number.isSafeInteger(r.attempts) ||
			!Number.isFinite(r.expiresAt)
		)
			throw new Error(`Corrupt inbox record ${id}`);
		return { ...r, revision: r.revision ?? 0 };
	}
	private load(): void {
		if (this.loaded) return;
		if (physicalPath(this.directory) !== this.directory) throw new Error("Inbox directory replaced");
		for (const name of readdirSync(this.directory).filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) {
			const r = this.readRecord(join(this.directory, name), name.slice(0, -5))!;
			this.records.set(r.id, r);
		}
		this.loaded = true;
	}
	get(id: string): InboxRecord | undefined {
		this.path(id);
		this.load();
		const record = this.records.get(id) ?? this.readRecord(join(this.directory, ".dedupe", `${id}.json`), id);
		return record ? structuredClone(record) : undefined;
	}
	list(): InboxRecord[] {
		this.load();
		return [...this.records.values()]
			.sort((a, b) => a.acceptedAt - b.acceptedAt || a.id.localeCompare(b.id))
			.map((r) => structuredClone(r));
	}
	private save(record: InboxRecord): void {
		if (physicalPath(this.directory) !== this.directory) throw new Error("Inbox directory replaced");
		writeDurableJson(this.path(record.id), record);
		this.records.set(record.id, structuredClone(record));
	}
	capacity(): { activeRecords: number; maximum: number; warning: boolean; maintenance: string } {
		this.load();
		const maximum = resourceNumber("INBOX_MAX_RECORDS", 10000);
		return {
			activeRecords: this.records.size,
			maximum,
			warning: this.records.size >= maximum * 0.8,
			maintenance: "/recover maintain",
		};
	}
	/** Archive first, durable tombstone second, remove active payload last: interruption never creates a dedupe gap. */
	maintain(
		now = Date.now(),
		channel?: string,
	): { archived: number; dedupeRemoved: number; capacity: ReturnType<DurableInbox["capacity"]> } {
		this.load();
		const terminal = [...this.records.values()].filter(
			(r) => ["completed", "rejected", "expired"].includes(r.status) && (!channel || r.event.channel === channel),
		);
		const archive = join(this.directory, ".archives"),
			dedupe = join(this.directory, ".dedupe");
		for (const directory of [archive, dedupe]) {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			if (physicalPath(directory) !== directory) throw new Error("Inbox archive directory replaced");
		}
		if (terminal.length) {
			const body = terminal.map((r) => JSON.stringify(r)).join("\n");
			writeDurableFile(join(archive, `${now}-${randomUUID()}.jsonl.gz`), gzipSync(body));
			const hours = resourceNumber("INBOX_DEDUPE_HOURS", 168);
			for (const r of terminal) {
				const { preparedEvent: _preparedEvent, ...summary } = r;
				const {
					text: _text,
					attachments: _attachments,
					files: _files,
					resources: _resources,
					...identity
				} = r.event;
				writeDurableJson(join(dedupe, `${r.id}.json`), {
					...summary,
					event: { ...identity, text: "[archived]" },
					archivedAt: now,
					dedupeUntil: now + hours * 3600000,
				});
				unlinkSync(this.path(r.id));
				this.records.delete(r.id);
			}
		}
		let dedupeRemoved = 0;
		for (const name of readdirSync(dedupe).filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) {
			const path = join(dedupe, name),
				r = this.readRecord(path, name.slice(0, -5))!;
			if (
				(!channel || r.event.channel === channel) &&
				r.dedupeUntil !== undefined &&
				r.dedupeUntil <= now &&
				!this.records.has(r.id)
			) {
				unlinkSync(path);
				dedupeRemoved++;
			}
		}
		const retention = resourceNumber("INBOX_ARCHIVE_RETENTION_HOURS", 720) * 3600000;
		for (const name of readdirSync(archive).filter((n) => /^\d+-[a-f0-9-]+\.jsonl\.gz$/.test(n))) {
			const path = join(archive, name),
				stat = lstatSync(path);
			if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Invalid inbox archive");
			if (now - Number(name.split("-")[0]) > retention) unlinkSync(path);
		}
		return { archived: terminal.length, dedupeRemoved, capacity: this.capacity() };
	}

	unresolvedChannels(): Set<string> {
		return new Set(
			this.list()
				.filter((r) => ["unknown", "dead"].includes(r.status))
				.map((r) => r.event.channel),
		);
	}

	admit(
		source: string,
		event: ChatEvent,
		isEvent: boolean,
		maxWaitMs: number,
		now = Date.now(),
		initialStatus: "queued" | "rejected" = "queued",
	): InboxRecord {
		const id = stableId(source, event.origin, event.channel, event.ts);
		const fingerprint = requestFingerprint({ event, isEvent });
		const existing = this.get(id);
		if (existing) {
			if (existing.fingerprint !== fingerprint) throw new Error("Inbox identity reused for a different payload");
			return existing;
		}
		const capacity = this.capacity();
		if (capacity.activeRecords >= capacity.maximum)
			throw new Error("Inbox capacity reached; run /recover maintain after reconciling terminal work");
		const record: InboxRecord = {
			version: 1,
			revision: 0,
			source,
			id,
			event,
			isEvent,
			fingerprint,
			status: initialStatus,
			acceptedAt: now,
			expiresAt: now + maxWaitMs,
			attempts: 0,
		};
		this.save(record);
		return record;
	}
	recordPrepared(id: string, event: ChatEvent): void {
		const record = this.get(id);
		if (
			!record ||
			record.status !== "running" ||
			record.event.channel !== event.channel ||
			record.event.user !== event.user ||
			record.event.origin !== event.origin ||
			record.event.ts !== event.ts
		)
			throw new Error("Invalid prepared inbox identity");
		this.save({ ...record, revision: (record.revision ?? 0) + 1, preparedEvent: event });
	}

	start(id: string): boolean {
		const r = this.get(id);
		if (!r || r.status !== "queued") return false;
		if (r.attempts >= this.maxAttempts + (r.manualRetries ?? 0)) {
			this.finish(id, "dead", "attempt limit");
			return false;
		}
		if (r.expiresAt <= Date.now()) {
			this.finish(id, "expired", "queue deadline before start");
			return false;
		}
		this.save({
			...r,
			revision: (r.revision ?? 0) + 1,
			status: "running",
			attempts: r.attempts + 1,
		});
		return true;
	}
	finish(id: string, status: Exclude<InboxStatus, "running" | "queued">, detail?: string): void {
		const r = this.get(id);
		if (!r) throw new Error("Missing inbox record");
		this.save({
			...r,
			revision: (r.revision ?? 0) + 1,
			status: status === "unknown" && r.attempts >= this.maxAttempts + (r.manualRetries ?? 0) ? "dead" : status,
			detail,
		});
	}
	recover(now = Date.now()): InboxRecord[] {
		for (const r of this.list()) {
			if (r.status === "running")
				this.finish(
					r.id,
					"unknown",
					"Process interrupted after execution began; inspect side effects before manual retry",
				);
			else if (r.status === "queued" && r.expiresAt <= now)
				this.finish(r.id, "expired", "queue deadline across restart");
		}
		return this.list().filter((r) => r.status === "queued");
	}
	retry(id: string, manualAcknowledgement = false): InboxRecord {
		const r = this.get(id);
		if (!r) throw new Error("Missing inbox record");
		if (r.archivedAt !== undefined)
			throw new Error("Archived terminal request cannot be replayed; create a new explicit request");
		if (["unknown", "dead"].includes(r.status) && !manualAcknowledgement)
			throw new Error("manual acknowledgement of uncertain side effects required");
		if (!["rejected", "expired", "dead", "unknown"].includes(r.status))
			throw new Error("Inbox record is not retryable");
		if (r.attempts >= this.maxAttempts + (r.manualRetries ?? 0) && !manualAcknowledgement)
			throw new Error("attempt limit reached; retained as dead/unknown");
		const next: InboxRecord = {
			...r,
			revision: (r.revision ?? 0) + 1,
			manualRetries: (r.manualRetries ?? 0) + (manualAcknowledgement ? 1 : 0),
			status: "queued",
			expiresAt: Date.now() + 300_000,
			detail: "explicit retry; operator acknowledged possible duplicate effects",
		};
		this.save(next);
		return next;
	}
}
