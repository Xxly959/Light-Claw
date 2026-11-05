import { existsSync, type FSWatcher, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventsWatcher } from "../src/events.js";
import type { ChatEvent } from "../src/transport.js";

let directory: string;
let watcher: EventsWatcher | undefined;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "event-boundaries-"));
});
afterEach(() => {
	watcher?.stop();
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});
function source(at: unknown): void {
	writeFileSync(
		join(directory, "job.json"),
		JSON.stringify({ type: "one-shot", channelId: "channel", text: "work", at }),
	);
}
function start(admitted: ChatEvent[]): void {
	watcher = new EventsWatcher(directory, {
		durableAdmission: true,
		enqueueEvent: (event) => {
			admitted.push(event);
			return true;
		},
	});
	watcher.start();
}
it.each([
	"nonsense",
	"2026-11-01T12:00:00",
	"2026-02-30T00:00:00Z",
	"2026-13-01T00:00:00Z",
	"2026-11-01T24:01:00Z",
	"2026-11-01T00:00:00+24:00",
	42,
])("dead-letters invalid one-shot date %s without execution", async (at) => {
	source(at);
	const admitted: ChatEvent[] = [];
	start(admitted);
	await vi.waitFor(() => expect(existsSync(join(directory, "dead-letter"))).toBe(true));
	expect(readdirSync(join(directory, "dead-letter"))).toHaveLength(1);
	expect(admitted).toEqual([]);
});
it("chunks dates beyond Node's timer limit and never admits them early", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	const delay = 2_147_483_647 + 50_000;
	const deadline = Date.now() + delay;
	source(new Date(deadline).toISOString());
	const timeouts = vi.spyOn(globalThis, "setTimeout");
	const admitted: ChatEvent[] = [];
	start(admitted);
	// Isolate the timer from native filesystem notifications while fake time advances by weeks.
	(watcher as unknown as { watcher: FSWatcher }).watcher.close();
	await vi.waitFor(() => expect(timeouts.mock.calls.some((call) => call[1] === 2_147_483_647)).toBe(true));
	await vi.advanceTimersByTimeAsync(2_147_483_647);
	expect(admitted).toEqual([]);
	await vi.advanceTimersByTimeAsync(deadline - Date.now());
	expect(admitted).toHaveLength(1);
	expect(admitted[0]?.origin).toBe("scheduled");
});
it("admits overdue sources after restart exactly once when durable admission succeeds", async () => {
	source(new Date(Date.now() - 1000).toISOString());
	const admitted: ChatEvent[] = [];
	start(admitted);
	await vi.waitFor(() => expect(admitted).toHaveLength(1));
	watcher?.stop();
	start(admitted);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(admitted).toHaveLength(1);
	expect(existsSync(join(directory, "job.json"))).toBe(false);
});
it("retains a rejected overdue source for a later restart", async () => {
	source(new Date(Date.now() - 1000).toISOString());
	const rejected = vi.fn(() => false);
	watcher = new EventsWatcher(directory, { durableAdmission: true, enqueueEvent: rejected });
	watcher.start();
	await vi.waitFor(() => expect(rejected).toHaveBeenCalledTimes(1));
	expect(existsSync(join(directory, "job.json"))).toBe(true);
	watcher.stop();
	const admitted: ChatEvent[] = [];
	start(admitted);
	await vi.waitFor(() => expect(admitted).toHaveLength(1));
});

it("does not execute historically expired one-shot work under a bounded misfire policy", async () => {
	source("2000-01-01T00:00:00Z");
	const admitted: ChatEvent[] = [],
		faults: unknown[] = [];
	watcher = new EventsWatcher(
		directory,
		{
			durableAdmission: true,
			enqueueEvent: (event) => {
				admitted.push(event);
				return true;
			},
		},
		{
			misfireMaxLatenessMs: 60000,
			onFault: (fault) => {
				faults.push(fault);
			},
		},
	);
	watcher.start();
	await vi.waitFor(() => expect(existsSync(join(directory, "dead-letter"))).toBe(true));
	expect(admitted).toHaveLength(0);
	expect(faults).toHaveLength(1);
});
