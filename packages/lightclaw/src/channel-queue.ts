import * as log from "./log.js";

type QueuedWork = () => Promise<void>;

interface QueueItem {
	work: QueuedWork;
	resolve: () => void;
	timer?: NodeJS.Timeout;
}

export interface ChannelQueueOptions {
	enabled?: boolean;
	maxPending: number;
	maxWaitMs: number;
}

export interface QueueStatistics {
	accepted: number;
	rejected: number;
	expired: number;
	completed: number;
	failed: number;
	peakPending: number;
}

export class ChannelQueue {
	private readonly queue: QueueItem[] = [];
	private processing = false;
	private closed = false;
	private readonly idleWaiters: Array<() => void> = [];
	private readonly counts: QueueStatistics = {
		accepted: 0,
		rejected: 0,
		expired: 0,
		completed: 0,
		failed: 0,
		peakPending: 0,
	};

	constructor(
		private readonly onError: (error: unknown) => void = (error) =>
			log.logWarning("Queue error", error instanceof Error ? error.message : String(error)),
		private readonly options: ChannelQueueOptions = { maxPending: 5, maxWaitMs: 300_000 },
	) {
		if (!Number.isSafeInteger(options.maxPending) || options.maxPending < 1)
			throw new Error("maxPending must be a positive safe integer");
		if (!Number.isSafeInteger(options.maxWaitMs) || options.maxWaitMs < 1 || options.maxWaitMs > 2_147_483_647)
			throw new Error("maxWaitMs must be a positive timer duration");
	}

	enqueue(work: QueuedWork): Promise<void> {
		const completion = this.tryEnqueue(work);
		if (!completion) throw new Error("channel queue capacity exceeded");
		return completion;
	}

	canAccept(): boolean {
		return !this.closed && (this.options.enabled === false || this.queue.length < this.options.maxPending);
	}

	tryEnqueue(work: QueuedWork, onExpired?: () => Promise<void>): Promise<void> | undefined {
		if (this.closed || (this.options.enabled !== false && this.queue.length >= this.options.maxPending)) {
			this.counts.rejected++;
			return undefined;
		}
		let resolve!: () => void;
		const completed = new Promise<void>((done) => {
			resolve = done;
		});
		const item: QueueItem = { work, resolve };
		this.queue.push(item);
		this.counts.accepted++;
		// The first item starts synchronously and does not consume pending capacity.
		if (this.processing) {
			this.counts.peakPending = Math.max(this.counts.peakPending, this.queue.length);
			if (this.options.enabled !== false)
				item.timer = setTimeout(() => {
					const index = this.queue.indexOf(item);
					if (index < 0) return;
					this.queue.splice(index, 1);
					this.counts.expired++;
					item.resolve();
					if (onExpired)
						void Promise.resolve()
							.then(onExpired)
							.catch((error: unknown) => this.reportError(error));
					else this.reportError(new Error("channel queue wait expired before execution"));
				}, this.options.maxWaitMs);
		}
		void this.processNext();
		return completed;
	}

	/** Pending work remains in the persistent inbox; never starts during shutdown. */
	close(): void {
		this.closed = true;
		for (const item of this.queue.splice(0)) {
			if (item.timer) clearTimeout(item.timer);
			item.resolve();
		}
	}
	async drain(): Promise<void> {
		if (!this.processing) return;
		await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
	}

	statistics(): QueueStatistics {
		return { ...this.counts };
	}

	private reportError(error: unknown): void {
		try {
			this.onError(error);
		} catch {
			/* Reporting must not stall the queue. */
		}
	}

	size(): number {
		return this.queue.length;
	}

	isProcessing(): boolean {
		return this.processing;
	}

	private async processNext(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			while (this.queue.length > 0) {
				const item = this.queue.shift();
				if (!item) continue;
				if (item.timer) clearTimeout(item.timer);
				try {
					await item.work();
					this.counts.completed++;
				} catch (error) {
					this.counts.failed++;
					this.reportError(error);
				} finally {
					item.resolve();
				}
			}
		} finally {
			this.processing = false;
			for (const resolve of this.idleWaiters.splice(0)) resolve();
		}
	}
}
