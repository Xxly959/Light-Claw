import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requestFingerprint, stableId, writeDurableJson } from "./durable-state.js";

export type OperationQuery = { status: "found"; result: unknown } | { status: "absent" | "unknown" };
export interface OperationService {
	/** True only when the service atomically deduplicates this ID, including concurrent/in-flight retries. */
	replaySafe: boolean;
	execute(operationId: string, request: unknown): Promise<unknown>;
	query(operationId: string): Promise<OperationQuery>;
}
export interface OperationRecord {
	version: 1;
	revision?: number;
	ownerUserId?: string;
	id: string;
	scope: string;
	key: string;
	request: unknown;
	fingerprint: string;
	status: "prepared" | "started" | "succeeded" | "unknown" | "manual";
	result?: unknown;
	detail?: string;
}
export class OperationJournal {
	private readonly active = new Map<string, Promise<OperationRecord>>();
	constructor(private readonly directory: string) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	}
	get(id: string): OperationRecord | undefined {
		if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid operation ID");
		const path = join(this.directory, `${id}.json`);
		if (!existsSync(path)) return undefined;
		const r = JSON.parse(readFileSync(path, "utf8")) as OperationRecord;
		if (
			r.version !== 1 ||
			r.id !== id ||
			!["prepared", "started", "succeeded", "unknown", "manual"].includes(r.status)
		)
			throw new Error("Corrupt operation record");
		return { ...r, revision: r.revision ?? 0 };
	}
	list(): OperationRecord[] {
		return readdirSync(this.directory)
			.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
			.map((name) => this.get(name.slice(0, -5))!);
	}
	private save(record: OperationRecord): OperationRecord {
		record = { ...record, revision: (this.get(record.id)?.revision ?? -1) + 1 };
		writeDurableJson(join(this.directory, `${record.id}.json`), record);
		return record;
	}
	async execute(
		scope: string,
		key: string,
		request: unknown,
		service: OperationService,
		ownerUserId?: string,
	): Promise<OperationRecord> {
		const id = stableId(scope, key);
		const existing = this.active.get(id);
		if (existing) {
			await existing;
			return this.execute(scope, key, request, service, ownerUserId);
		}
		const pending = this.run(id, scope, key, request, service, ownerUserId);
		this.active.set(id, pending);
		try {
			return await pending;
		} finally {
			this.active.delete(id);
		}
	}
	private async run(
		id: string,
		scope: string,
		key: string,
		request: unknown,
		service: OperationService,
		ownerUserId?: string,
	): Promise<OperationRecord> {
		const fingerprint = requestFingerprint(request);
		let record =
			this.get(id) ??
			this.save({ version: 1, id, scope, key, request, fingerprint, status: "prepared", ownerUserId });
		if (record.fingerprint !== fingerprint) throw new Error("Operation ID reused with different request");
		if (record.status === "succeeded" || record.status === "manual") return record;
		if (record.status !== "prepared") {
			let query: OperationQuery;
			try {
				query = await service.query(id);
			} catch {
				query = { status: "unknown" };
			}
			if (query.status === "found")
				return this.save({
					...record,
					status: "succeeded",
					result: query.result,
					detail: "reconciled by service query",
				});
			if (query.status !== "absent" || !service.replaySafe)
				return this.save({
					...record,
					status: "manual",
					detail: "Service cannot confirm a replay-safe outcome; manual reconciliation required",
				});
		}
		record = this.save({ ...record, status: "started" });
		try {
			const result = await service.execute(id, request);
			return this.save({ ...record, status: "succeeded", result });
		} catch (error) {
			return this.save({
				...record,
				status: "unknown",
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}
	retryManually(id: string, revision: number): OperationRecord {
		const record = this.get(id);
		if (
			!record ||
			record.revision !== revision ||
			!["unknown", "manual", "started"].includes(record.status) ||
			this.active.has(id)
		)
			throw new Error("Operation version/status changed or still active");
		return this.save({
			...record,
			status: "prepared",
			detail: "Operator acknowledged duplicate risk and explicitly authorized retry",
		});
	}
	/** Operator records independently verified outcome; never auto-reissues an uncertain action. */
	resolveManually(id: string, result: unknown): OperationRecord {
		const record = this.get(id);
		if (!record || !["manual", "unknown", "started"].includes(record.status))
			throw new Error("Operation is not awaiting reconciliation");
		return this.save({ ...record, status: "succeeded", result, detail: "operator confirmed external outcome" });
	}
}
