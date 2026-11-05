import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeDurableJson } from "../../durable-state.js";
import { physicalPath } from "../../goals/control.js";
export class BudgetBusyError extends Error {}
export interface CampaignBudgetSpec {
	path: string;
	limits: ModelBudgetLimits;
}

/** Only contention is retried; exhausted/corrupt budgets fail immediately. Never steals a lock. */
export async function budgetOperation<T>(operation: () => T, signal?: AbortSignal, waitMs = 2000): Promise<T> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		signal?.throwIfAborted();
		try {
			return operation();
		} catch (error) {
			if (!(error instanceof BudgetBusyError) || Date.now() >= deadline) throw error;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

export interface ModelBudgetLimits {
	requests: number;
	tokens: number;
	costMicros: number;
	wallMs: number;
	tokensPerRequest: number;
	costMicrosPerRequest: number;
}

export function parseBudgetLimits(value: unknown): ModelBudgetLimits {
	const fields = ["requests", "tokens", "costMicros", "wallMs", "tokensPerRequest", "costMicrosPerRequest"];
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid budget limits");
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== fields.length ||
		fields.some((key) => !Number.isSafeInteger(record[key]) || Number(record[key]) < 1) ||
		Object.keys(record).some((key) => !fields.includes(key))
	)
		throw new Error("Invalid budget limit fields");
	const limits = value as ModelBudgetLimits;
	if (limits.tokensPerRequest > limits.tokens || limits.costMicrosPerRequest > limits.costMicros)
		throw new Error("Per-request reservation exceeds total budget");
	return {
		requests: limits.requests,
		tokens: limits.tokens,
		costMicros: limits.costMicros,
		wallMs: limits.wallMs,
		tokensPerRequest: limits.tokensPerRequest,
		costMicrosPerRequest: limits.costMicrosPerRequest,
	};
}
interface Reservation {
	id: string;
	model: string;
	purpose: "task" | "candidate_generation" | "selection";
	status: "reserved" | "settled" | "unknown";
	tokens: number | null;
	costMicros: number | null;
}
interface BudgetState {
	schema: 1;
	limits: ModelBudgetLimits;
	startedAt: number;
	breached: boolean;
	humanMinutes: number | null;
	entries: Reservation[];
}
/** Conservative reservations survive crashes and unknown usage. This never treats missing provider usage as zero. */
export class PersistentModelBudget {
	private readonly path: string;
	constructor(
		path: string,
		private readonly limits: ModelBudgetLimits,
		private readonly now = Date.now,
		existingOnly = false,
	) {
		this.path = physicalPath(path);
		this.limits = parseBudgetLimits(limits);
		this.transaction(() => {
			if (existingOnly && !existsSync(this.path)) throw new Error("Persisted budget missing; refusing reset");
			if (!existsSync(this.path))
				this.save({
					schema: 1,
					limits: this.limits,
					startedAt: now(),
					breached: false,
					humanMinutes: null,
					entries: [],
				});
			else this.read();
		});
	}
	private read(): BudgetState {
		const info = lstatSync(this.path);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)
			throw new Error("Invalid budget file");
		const state = JSON.parse(readFileSync(this.path, "utf8")) as BudgetState;
		if (
			state.schema !== 1 ||
			!Array.isArray(state.entries) ||
			!Number.isFinite(state.startedAt) ||
			typeof state.breached !== "boolean" ||
			(state.humanMinutes !== null && (!Number.isFinite(state.humanMinutes) || state.humanMinutes < 0))
		)
			throw new Error("Corrupt budget state");
		if (JSON.stringify(state.limits) !== JSON.stringify(this.limits))
			throw new Error("Frozen budget limits/ceilings changed");
		for (const entry of state.entries)
			if (
				!entry.id ||
				!entry.model ||
				!["reserved", "settled", "unknown"].includes(entry.status) ||
				!["task", "candidate_generation", "selection"].includes(entry.purpose) ||
				(entry.status === "reserved" && (entry.tokens !== null || entry.costMicros !== null)) ||
				(entry.status === "settled" && (entry.tokens === null || entry.costMicros === null)) ||
				(entry.status === "unknown" && entry.tokens !== null && entry.costMicros !== null) ||
				[entry.tokens, entry.costMicros].some(
					(value) => value !== null && (!Number.isSafeInteger(value) || value < 0),
				)
			)
				throw new Error("Corrupt budget reservation");
		return state;
	}
	private save(state: BudgetState): void {
		writeDurableJson(this.path, state);
	}
	private transaction<T>(operation: () => T): T {
		const directory = dirname(this.path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		if (physicalPath(directory) !== directory) throw new Error("Budget directory replaced");
		const lock = join(directory, ".budget.lock");
		try {
			mkdirSync(lock, { mode: 0o700 });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			throw new BudgetBusyError("Budget transaction locked; fail closed");
		}
		try {
			return operation();
		} finally {
			rmdirSync(lock);
		}
	}
	private totals(state: BudgetState) {
		return {
			requests: state.entries.length,
			chargedTokens: state.entries.reduce((sum, entry) => sum + (entry.tokens ?? this.limits.tokensPerRequest), 0),
			chargedCostMicros: state.entries.reduce(
				(sum, entry) => sum + (entry.costMicros ?? this.limits.costMicrosPerRequest),
				0,
			),
			unknown: state.entries.filter((entry) => entry.status !== "settled").length,
			humanMinutes: state.humanMinutes,
			elapsedMs: Math.max(0, this.now() - state.startedAt),
			breached: state.breached,
		};
	}
	snapshot() {
		const state = this.read(),
			totals = this.totals(state);
		const remainingWallMs = this.now() < state.startedAt ? 0 : Math.max(0, this.limits.wallMs - totals.elapsedMs);
		const stopReason =
			remainingWallMs === 0
				? "wall"
				: state.breached
					? "reservation_breach"
					: totals.requests >= this.limits.requests
						? "requests"
						: totals.chargedTokens + this.limits.tokensPerRequest > this.limits.tokens
							? "tokens"
							: totals.chargedCostMicros + this.limits.costMicrosPerRequest > this.limits.costMicros
								? "cost"
								: null;
		return { ...totals, remainingWallMs, stopReason };
	}
	reserve(model: string, purpose: Reservation["purpose"]): string {
		return this.transaction(() => {
			const state = this.read(),
				totals = this.totals(state);
			if (totals.elapsedMs >= this.limits.wallMs || this.now() < state.startedAt)
				throw new Error("Wall-clock budget exhausted across restart");
			if (
				state.breached ||
				totals.requests >= this.limits.requests ||
				totals.chargedTokens + this.limits.tokensPerRequest > this.limits.tokens ||
				totals.chargedCostMicros + this.limits.costMicrosPerRequest > this.limits.costMicros
			)
				throw new Error("Model budget exhausted");
			const id = randomUUID();
			state.entries.push({ id, model, purpose, status: "reserved", tokens: null, costMicros: null });
			this.save(state);
			return id;
		});
	}
	settle(id: string, tokens: number | null, costMicros: number | null): void {
		this.transaction(() => {
			if ([tokens, costMicros].some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0)))
				throw new Error("Invalid usage");
			const state = this.read(),
				entry = state.entries.find((item) => item.id === id);
			if (!entry || entry.status !== "reserved") throw new Error("Unknown/already settled reservation");
			entry.tokens = tokens;
			entry.costMicros = costMicros;
			entry.status = tokens === null || costMicros === null ? "unknown" : "settled";
			const over =
				(tokens ?? 0) > this.limits.tokensPerRequest || (costMicros ?? 0) > this.limits.costMicrosPerRequest;
			state.breached ||= over;
			this.save(state);
			if (over) throw new Error("Provider usage exceeded per-request reservation; budget locked");
		});
	}
	recordHumanMinutes(minutes: number): void {
		this.transaction(() => {
			if (!Number.isFinite(minutes) || minutes < 0) throw new Error("Invalid human cost");
			const state = this.read();
			state.humanMinutes = (state.humanMinutes ?? 0) + minutes;
			this.save(state);
		});
	}
}
