import type { ChannelQueue } from "./channel-queue.js";
import { CacheCapacityError } from "./idle-cache.js";
import * as log from "./log.js";
import type { ChatEvent, ChatHandler, ChatTransport } from "./transport.js";

export function enqueueChatEvent(
	queueSource: ChannelQueue | (() => ChannelQueue),
	event: ChatEvent,
	handler: ChatHandler,
	transport: ChatTransport,
	isEvent = false,
): boolean {
	const report = async (reason: "full" | "expired"): Promise<void> => {
		try {
			await handler.handleQueueFailure(event, transport, reason);
		} catch (error) {
			log.logWarning(
				`[${event.channel}] Queue failure reporting failed`,
				error instanceof Error ? error.message : String(error),
			);
		}
	};
	let queue: ChannelQueue;
	try {
		queue = typeof queueSource === "function" ? queueSource() : queueSource;
	} catch (error) {
		if (!(error instanceof CacheCapacityError)) throw error;
		void report("full");
		return false;
	}
	const completion = queue.tryEnqueue(
		() => handler.handleEvent(event, transport, isEvent),
		() => report("expired"),
	);
	if (!completion) {
		void report("full");
		return false;
	}
	return true;
}
