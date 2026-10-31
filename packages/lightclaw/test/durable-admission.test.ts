import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelQueue } from "../src/channel-queue.js";
import { DurableInbox } from "../src/durable-inbox.js";
import { EventsWatcher } from "../src/events.js";
import { enqueueChatEvent } from "../src/queued-events.js";
import type { ChatEvent, ChatHandler, ChatTransport } from "../src/transport.js";

const roots: string[] = [];
const watchers: EventsWatcher[] = [];
afterEach(() => {
	for (const watcher of watchers.splice(0)) watcher.stop();
	vi.useRealTimers();
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const event: ChatEvent = {
	origin: "platform",
	type: "dm",
	channel: "channel",
	ts: "1",
	user: "fictional",
	text: "work",
};
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "lightclaw-admission-"));
	roots.push(dir);
	const inbox = new DurableInbox(join(dir, "inbox"));
	const queue = new ChannelQueue(undefined, { maxPending: 1, maxWaitMs: 30 });
	const handler: ChatHandler = {
		isRunning: () => false,
		handleStop: async () => {},
		handleEvent: async () => {},
		handleQueueFailure: async () => {},
	};
	const transport: ChatTransport = {
		kind: "slack",
		inbox,
		durableAdmission: true,
		queueWaitMs: 60_000,
		start: async () => {},
		getUser: () => undefined,
		getChannel: () => undefined,
		getAllUsers: () => [],
		getAllChannels: () => [],
		postMessage: async () => "mock",
		updateMessage: async () => {},
		deleteMessage: async () => {},
		postInThread: async () => "mock",
		uploadFile: async () => {},
		logBotResponse: () => {},
		enqueueEvent: (e) => enqueueChatEvent(queue, e, handler, transport, true),
	};
	return { dir, inbox, queue, handler, transport };
}
it("persists acceptance before running and retains queued work across shutdown/restart", async () => {
	const f = fixture();
	let release!: () => void;
	const head = f.queue.enqueue(
		() =>
			new Promise<void>((r) => {
				release = r;
			}),
	);
	expect(enqueueChatEvent(f.queue, event, f.handler, f.transport)).toBe(true);
	const stored = f.inbox.list()[0];
	expect(stored.status).toBe("queued");
	f.inbox.stopAdmission();
	f.queue.close();
	expect(enqueueChatEvent(f.queue, { ...event, ts: "2" }, f.handler, f.transport)).toBe(false);
	release();
	await head;
	await f.queue.drain();
	const recovered = new DurableInbox(join(f.dir, "inbox"));
	expect(recovered.recover().map((r) => r.id)).toEqual([stored.id]);
	let executed = 0;
	f.handler.handleEvent = async () => {
		executed++;
	};
	const nextQueue = new ChannelQueue();
	const transport = { ...f.transport, inbox: recovered };
	expect(enqueueChatEvent(nextQueue, event, f.handler, transport)).toBe(true);
	await nextQueue.drain();
	expect(executed).toBe(1);
	expect(recovered.get(stored.id)?.status).toBe("completed");
	expect(enqueueChatEvent(nextQueue, event, f.handler, transport)).toBe(true);
	await nextQueue.drain();
	expect(executed).toBe(1);
});
it("records capacity rejection and expiry without silently executing either", async () => {
	const f = fixture();
	let release!: () => void;
	const head = f.queue.enqueue(
		() =>
			new Promise<void>((r) => {
				release = r;
			}),
	);
	expect(enqueueChatEvent(f.queue, event, f.handler, f.transport)).toBe(true);
	expect(enqueueChatEvent(f.queue, { ...event, ts: "2" }, f.handler, f.transport)).toBe(false);
	await vi.waitFor(() =>
		expect(
			f.inbox
				.list()
				.map((r) => r.status)
				.sort(),
		).toEqual(["expired", "rejected"]),
	);
	release();
	await head;
});
it("does not acknowledge acceptance or execute when persistence fails", () => {
	const f = fixture();
	rmSync(join(f.dir, "inbox"), { recursive: true });
	writeFileSync(join(f.dir, "inbox"), "blocked");
	expect(() => enqueueChatEvent(f.queue, event, f.handler, f.transport)).toThrow();
	expect(f.queue.statistics().accepted).toBe(0);
});
it("retains an event source after memory-only enqueue or rejection, and removes it only after durable acceptance", async () => {
	const f = fixture();
	const events = join(f.dir, "events");
	mkdirSync(events);
	const path = join(events, "once.json");
	const body = { type: "one-shot", at: "2020-01-01T00:00:00Z", channelId: "channel", text: "fictional overdue work" };
	writeFileSync(path, JSON.stringify(body));
	const memory = new EventsWatcher(events, { enqueueEvent: () => true });
	watchers.push(memory);
	memory.start();
	await new Promise((r) => setTimeout(r, 50));
	expect(existsSync(path)).toBe(true);
	memory.stop();
	const durable = new EventsWatcher(events, f.transport);
	watchers.push(durable);
	durable.start();
	await vi.waitFor(() => expect(existsSync(path)).toBe(false));
	const record = f.inbox.list()[0];
	expect(record.event.origin).toBe("scheduled");
	expect(record.status).toBe("completed");
	expect(readFileSync(join(f.dir, "inbox", `${record.id}.json`), "utf8")).toContain("fictional overdue work");
});

it("drains a durable backlog after restart even with a smaller memory queue", async () => {
	const f = fixture();
	for (const ts of ["1", "2", "3", "4"]) f.inbox.admit("slack", { ...event, ts }, false, 60_000);
	const ran: string[] = [];
	f.handler.handleEvent = async (e) => {
		ran.push(e.ts);
		await new Promise((r) => setTimeout(r, 5));
	};
	for (const r of f.inbox.recover()) expect(enqueueChatEvent(f.queue, r.event, f.handler, f.transport)).toBe(true);
	await vi.waitFor(() => expect(ran).toEqual(["1", "2", "3", "4"]));
	await f.queue.drain();
	expect(f.inbox.list().every((r) => r.status === "completed")).toBe(true);
});
it("persists startup arrivals without dispatching them, and holds follow-ups behind unknown work", async () => {
	const f = fixture();
	let ran = 0;
	f.handler.handleEvent = async () => {
		ran++;
	};
	f.inbox.dispatchPaused = true;
	expect(enqueueChatEvent(f.queue, event, f.handler, f.transport)).toBe(true);
	expect(ran).toBe(0);
	const first = f.inbox.list()[0];
	f.inbox.dispatchPaused = false;
	f.inbox.start(first.id);
	f.inbox.recover();
	expect(enqueueChatEvent(f.queue, { ...event, ts: "2" }, f.handler, f.transport)).toBe(true);
	await Promise.resolve();
	expect(ran).toBe(0);
	expect(
		f.inbox
			.list()
			.map((r) => r.status)
			.sort(),
	).toEqual(["queued", "unknown"]);
});
