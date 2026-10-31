import * as log from "./log.js";

export interface IdleCacheOptions {
	enabled?: boolean;
	maxEntries: number;
	idleTtlMs: number;
}

export class CacheCapacityError extends Error {
	constructor() {
		super("channel cache capacity reached; all retained channels are busy");
	}
}

export class IdleResourceCache<T> {
	private readonly entries = new Map<string, { value: T; usedAt: number }>();
	private readonly timer?: NodeJS.Timeout;
	private closed = false;

	constructor(
		private readonly options: IdleCacheOptions,
		private readonly isBusy: (value: T) => boolean,
		private readonly release: (value: T, key: string) => void = () => {},
	) {
		if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1)
			throw new Error("maxEntries must be a positive safe integer");
		if (!Number.isSafeInteger(options.idleTtlMs) || options.idleTtlMs < 1 || options.idleTtlMs > 2_147_483_647)
			throw new Error("idleTtlMs must be a positive timer duration");
		if (options.enabled !== false) {
			this.timer = setInterval(() => this.sweep(), Math.min(options.idleTtlMs, 60_000));
			this.timer.unref();
		}
	}

	get size(): number {
		return this.entries.size;
	}
	peek(key: string): T | undefined {
		return this.entries.get(key)?.value;
	}

	get(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		this.entries.delete(key);
		entry.usedAt = Date.now();
		this.entries.set(key, entry);
		return entry.value;
	}

	getOrCreate(key: string, create: () => T): T {
		if (this.closed) throw new Error("channel cache is closed");
		this.sweep();
		const existing = this.get(key);
		if (existing !== undefined) return existing;
		if (this.options.enabled !== false && this.entries.size >= this.options.maxEntries) {
			for (const [candidate, entry] of this.entries) {
				if (!this.isBusy(entry.value) && this.remove(candidate, entry.value)) break;
			}
			if (this.entries.size >= this.options.maxEntries) throw new CacheCapacityError();
		}
		const value = create();
		this.entries.set(key, { value, usedAt: Date.now() });
		return value;
	}

	sweep(): void {
		if (this.options.enabled === false) return;
		const now = Date.now();
		for (const [key, entry] of this.entries) {
			if (!this.isBusy(entry.value) && now - entry.usedAt >= this.options.idleTtlMs) this.remove(key, entry.value);
		}
	}

	close(): void {
		this.closed = true;
		clearInterval(this.timer);
		for (const [key, entry] of this.entries) {
			if (!this.isBusy(entry.value)) this.remove(key, entry.value);
		}
	}

	private remove(key: string, value: T): boolean {
		try {
			this.release(value, key);
		} catch (error) {
			log.logWarning("Channel resource release failed", error instanceof Error ? error.message : String(error));
			return false;
		}
		this.entries.delete(key);
		return true;
	}
}
