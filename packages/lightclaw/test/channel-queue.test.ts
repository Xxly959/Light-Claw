import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelQueue } from "../src/channel-queue.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("ChannelQueue", () => {
	it("rejects excess pending work before executing it and admits new work after completion", async () => {
		const errors: unknown[] = [];
		const queue = new ChannelQueue((error) => errors.push(error), { maxPending: 1, maxWaitMs: 100 });
		const release = deferred();
		const first = queue.enqueue(() => release.promise);
		const waiting = vi.fn(async () => {});
		const second = queue.enqueue(waiting);
		const excess = vi.fn(async () => {});
		expect(queue.tryEnqueue(excess)).toBeUndefined();
		expect(() => queue.enqueue(excess)).toThrow("queue capacity");
		expect(queue.size()).toBe(1);
		expect(excess).not.toHaveBeenCalled();
		release.resolve();
		await Promise.all([first, second]);
		await queue.enqueue(excess);
		expect(excess).toHaveBeenCalledOnce();
		expect(queue.statistics()).toMatchObject({ accepted: 3, rejected: 2, expired: 0, completed: 3, peakPending: 1 });
	});

	it("expires pending work while the head is blocked and recovers capacity without executing it", async () => {
		vi.useFakeTimers();
		const queue = new ChannelQueue(undefined, { maxPending: 1, maxWaitMs: 50 });
		const release = deferred();
		const first = queue.enqueue(() => release.promise);
		const stale = vi.fn(async () => {});
		const expired = vi.fn(async () => {});
		const second = queue.tryEnqueue(stale, expired);
		await vi.advanceTimersByTimeAsync(51);
		await second;
		expect(queue.size()).toBe(0);
		expect(expired).toHaveBeenCalledOnce();
		expect(stale).not.toHaveBeenCalled();
		const fresh = vi.fn(async () => {});
		const third = queue.enqueue(fresh);
		release.resolve();
		await Promise.all([first, third]);
		expect(fresh).toHaveBeenCalledOnce();
		expect(queue.statistics()).toMatchObject({ accepted: 3, expired: 1, completed: 2 });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("validates queue bounds and isolates a throwing expiry reporter", async () => {
		expect(() => new ChannelQueue(undefined, { maxPending: 0, maxWaitMs: 50 })).toThrow("maxPending");
		expect(() => new ChannelQueue(undefined, { maxPending: 1, maxWaitMs: 2_147_483_648 })).toThrow("maxWaitMs");
		vi.useFakeTimers();
		const errors: unknown[] = [];
		const queue = new ChannelQueue((error) => errors.push(error), { maxPending: 1, maxWaitMs: 5 });
		const release = deferred();
		const first = queue.enqueue(() => release.promise);
		const second = queue.tryEnqueue(
			async () => {},
			async () => {
				throw new Error("expiry reporter failed");
			},
		);
		await vi.advanceTimersByTimeAsync(6);
		await second;
		release.resolve();
		await first;
		expect(errors).toHaveLength(1);
		await queue.enqueue(async () => {});
		expect(queue.isProcessing()).toBe(false);
	});
	it("processes work in FIFO order with at most one active item", async () => {
		const queue = new ChannelQueue();
		const first = deferred();
		const completed: number[] = [];
		let active = 0;
		let maximumActive = 0;

		const finished = [
			queue.enqueue(async () => {
				active++;
				maximumActive = Math.max(maximumActive, active);
				await first.promise;
				completed.push(1);
				active--;
			}),
			queue.enqueue(async () => {
				active++;
				maximumActive = Math.max(maximumActive, active);
				completed.push(2);
				active--;
			}),
		];

		expect(queue.size()).toBe(1);
		first.resolve();
		await Promise.all(finished);

		expect(completed).toEqual([1, 2]);
		expect(maximumActive).toBe(1);
		expect(queue.size()).toBe(0);
	});

	it("allows independent channel queues to overlap", async () => {
		const firstQueue = new ChannelQueue();
		const secondQueue = new ChannelQueue();
		const release = deferred();
		let active = 0;
		let maximumActive = 0;

		const work = async (): Promise<void> => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			await release.promise;
			active--;
		};
		const first = firstQueue.enqueue(work);
		const second = secondQueue.enqueue(work);

		await Promise.resolve();
		expect(maximumActive).toBe(2);
		release.resolve();
		await Promise.all([first, second]);
	});

	it("continues after a failed item and reports the error", async () => {
		const errors: unknown[] = [];
		const queue = new ChannelQueue((error) => errors.push(error));
		const completed: string[] = [];

		const failed = queue.enqueue(async () => {
			throw new Error("expected failure");
		});
		const succeeded = queue.enqueue(async () => {
			completed.push("second");
		});

		await failed;
		await succeeded;
		expect(completed).toEqual(["second"]);
		expect(errors).toHaveLength(1);
	});
});
