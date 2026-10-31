import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requestFingerprint, stableId, writeDurableJson } from "./durable-state.js";
import type { ChatEvent } from "./transport.js";

export type InboxStatus = "queued" | "running" | "completed" | "rejected" | "expired" | "dead" | "unknown";
export interface InboxRecord {
	version: 1;
	id: string;
	event: ChatEvent;
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
	accepting = true;
	dispatchPaused = false;
	stopAdmission(): void {
		this.accepting = false;
	}
	constructor(
		private readonly directory: string,
		private readonly maxAttempts = 3,
	) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	}
	private path(id: string): string {
		if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid inbox ID");
		return join(this.directory, `${id}.json`);
	}
	get(id: string): InboxRecord | undefined {
		if (!existsSync(this.path(id))) return undefined;
		const r = JSON.parse(readFileSync(this.path(id), "utf8")) as InboxRecord;
		if (
			r.version !== 1 ||
			r.id !== id ||
			!statuses.includes(r.status) ||
			!r.event ||
			!Number.isSafeInteger(r.attempts) ||
			!Number.isFinite(r.expiresAt)
		)
			throw new Error(`Corrupt inbox record ${id}`);
		return r;
	}
	list(): InboxRecord[] {
		return readdirSync(this.directory)
			.filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
			.map((n) => this.get(n.slice(0, -5))!)
			.sort((a, b) => a.acceptedAt - b.acceptedAt || a.id.localeCompare(b.id));
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
		const record: InboxRecord = {
			version: 1,
			id,
			event,
			isEvent,
			fingerprint,
			status: initialStatus,
			acceptedAt: now,
			expiresAt: now + maxWaitMs,
			attempts: 0,
		};
		writeDurableJson(this.path(id), record);
		return record;
	}
	start(id: string): boolean {
		const r = this.get(id);
		if (!r || r.status !== "queued") return false;
		if (r.attempts >= this.maxAttempts) {
			this.finish(id, "dead", "attempt limit");
			return false;
		}
		if (r.expiresAt <= Date.now()) {
			this.finish(id, "expired", "queue deadline before start");
			return false;
		}
		writeDurableJson(this.path(id), { ...r, status: "running", attempts: r.attempts + 1 });
		return true;
	}
	finish(id: string, status: Exclude<InboxStatus, "running" | "queued">, detail?: string): void {
		const r = this.get(id);
		if (!r) throw new Error("Missing inbox record");
		writeDurableJson(this.path(id), {
			...r,
			status: status === "unknown" && r.attempts >= this.maxAttempts ? "dead" : status,
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
		if (["unknown", "dead"].includes(r.status) && !manualAcknowledgement)
			throw new Error("manual acknowledgement of uncertain side effects required");
		if (!["rejected", "expired", "dead", "unknown"].includes(r.status))
			throw new Error("Inbox record is not retryable");
		if (r.attempts >= this.maxAttempts) throw new Error("attempt limit reached; retained as dead/unknown");
		const next: InboxRecord = { ...r, status: "queued", expiresAt: Date.now() + 300_000, detail: "explicit retry" };
		writeDurableJson(this.path(id), next);
		return next;
	}
}
