import { afterEach, describe, expect, it, vi } from "vitest";
import { IdleResourceCache } from "../src/idle-cache.js";

afterEach(() => vi.useRealTimers());

describe("bounded idle resource cache", () => {
	it("expires idle entries, releases them exactly once and retains busy resources", async () => {
		vi.useFakeTimers();
		const released: string[] = [];
		const cache = new IdleResourceCache<{ id: string; busy: boolean }>(
			{ maxEntries: 2, idleTtlMs: 10 },
			(item) => item.busy,
			(item) => released.push(item.id),
		);
		cache.getOrCreate("idle", () => ({ id: "idle", busy: false }));
		const busy = cache.getOrCreate("busy", () => ({ id: "busy", busy: true }));
		await vi.advanceTimersByTimeAsync(11);
		expect(cache.size).toBe(1);
		expect(released).toEqual(["idle"]);
		busy.busy = false;
		await vi.advanceTimersByTimeAsync(10);
		expect(cache.size).toBe(0);
		expect(released).toEqual(["idle", "busy"]);
		cache.close();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("evicts the least recently used idle entry and rejects admission when all entries are busy", () => {
		const released: string[] = [];
		const cache = new IdleResourceCache<{ id: string; busy: boolean }>(
			{ maxEntries: 2, idleTtlMs: 1000 },
			(item) => item.busy,
			(item) => released.push(item.id),
		);
		cache.getOrCreate("first", () => ({ id: "first", busy: false }));
		cache.getOrCreate("second", () => ({ id: "second", busy: false }));
		cache.get("first");
		cache.getOrCreate("third", () => ({ id: "third", busy: true }));
		expect(released).toEqual(["second"]);
		cache.get("first")!.busy = true;
		const factory = vi.fn(() => ({ id: "excess", busy: false }));
		expect(() => cache.getOrCreate("excess", factory)).toThrow("channel cache capacity");
		expect(factory).not.toHaveBeenCalled();
		cache.get("first")!.busy = false;
		cache.get("third")!.busy = false;
		cache.close();
	});

	it("keeps 1000 channel admissions bounded and preserves release accounting", () => {
		let created = 0;
		let released = 0;
		const cache = new IdleResourceCache<number>(
			{ maxEntries: 8, idleTtlMs: 1000 },
			() => false,
			() => released++,
		);
		for (let index = 0; index < 1000; index++) {
			cache.getOrCreate(String(index), () => ++created);
			expect(cache.size).toBeLessThanOrEqual(8);
		}
		cache.close();
		expect(created).toBe(1000);
		expect(released).toBe(created);
		expect(cache.size).toBe(0);
	});
});
