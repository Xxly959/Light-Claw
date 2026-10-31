import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelQueue } from "../src/channel-queue.js";
import { enqueueChatEvent } from "../src/queued-events.js";
import type { ChatEvent, ChatHandler, ChatTransport } from "../src/transport.js";

afterEach(() => vi.useRealTimers());

const event: ChatEvent = {
	origin: "scheduled",
	type: "dm",
	channel: "channel",
	user: "user",
	ts: "1",
	text: "task",
};
const transport: ChatTransport = {
	kind: "feishu",
	start: async () => {},
	getUser: () => undefined,
	getChannel: () => undefined,
	getAllUsers: () => [],
	getAllChannels: () => [],
	postMessage: async () => "id",
	updateMessage: async () => {},
	deleteMessage: async () => {},
	postInThread: async () => "id",
	uploadFile: async () => {},
	logBotResponse: () => {},
	enqueueEvent: () => false,
};

describe("shared transport queue admission", () => {
	it("reports both full and expired work and executes neither rejected request", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const head = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handleEvent = vi.fn(async () => {});
		const handleQueueFailure = vi.fn(async () => {});
		const handler: ChatHandler = {
			isRunning: () => false,
			handleStop: async () => {},
			handleEvent,
			handleQueueFailure,
		};
		const queue = new ChannelQueue(undefined, { maxPending: 1, maxWaitMs: 10 });
		const first = queue.enqueue(() => head);
		expect(enqueueChatEvent(queue, event, handler, transport, true)).toBe(true);
		expect(enqueueChatEvent(queue, { ...event, ts: "2" }, handler, transport)).toBe(false);
		expect(handleQueueFailure).toHaveBeenCalledWith(expect.objectContaining({ ts: "2" }), transport, "full");
		await vi.advanceTimersByTimeAsync(11);
		expect(handleQueueFailure).toHaveBeenCalledWith(event, transport, "expired");
		expect(handleEvent).not.toHaveBeenCalled();
		release();
		await first;
		expect(enqueueChatEvent(queue, { ...event, ts: "3" }, handler, transport, true)).toBe(true);
		await Promise.resolve();
		expect(handleEvent).toHaveBeenCalledWith(expect.objectContaining({ ts: "3" }), transport, true);
	});
});
