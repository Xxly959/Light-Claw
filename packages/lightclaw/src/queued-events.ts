import type { ChannelQueue } from "./channel-queue.js";
import type { DurableInbox } from "./durable-inbox.js";
import { CacheCapacityError } from "./idle-cache.js";
import * as log from "./log.js";
import type { ChatEvent, ChatHandler, ChatTransport } from "./transport.js";

const scheduled = new WeakMap<DurableInbox, Set<string>>();

export function enqueueChatEvent(
	queueSource: ChannelQueue | (() => ChannelQueue),
	event: ChatEvent,
	handler: ChatHandler,
	transport: ChatTransport,
	isEvent = false,
): boolean {
	const inbox = transport.inbox;
	const report = async (reason: "full" | "expired") => {
		try {
			await handler.handleQueueFailure(event, transport, reason);
		} catch (error) {
			log.logWarning(`[${event.channel}] Queue failure reporting failed`, String(error));
		}
	};
	if (inbox && !inbox.accepting) {
		void report("full");
		return false;
	}
	let queue: ChannelQueue | undefined;
	try {
		queue = typeof queueSource === "function" ? queueSource() : queueSource;
	} catch (error) {
		if (!(error instanceof CacheCapacityError)) throw error;
	}
	const pending = inbox ? (scheduled.get(inbox) ?? new Set<string>()) : undefined;
	if (inbox && pending) scheduled.set(inbox, pending);
	const paused = inbox && (inbox.dispatchPaused || inbox.unresolvedChannels().has(event.channel));
	const waiting = paused
		? inbox.list().filter((r) => r.event.channel === event.channel && r.status === "queued").length
		: 0;
	const capacity = queue?.canAccept() && (!paused || waiting < (transport.queueCapacity ?? 5));
	// New rejection is one durable decision, never a transient queued record followed by async rejection.
	const record = inbox?.admit(
		transport.kind,
		event,
		isEvent,
		transport.queueWaitMs ?? 300_000,
		Date.now(),
		capacity ? "queued" : "rejected",
	);
	if (record && record.status !== "queued") {
		if (record.status === "rejected") void report("full");
		return !["rejected", "expired"].includes(record.status);
	}
	if (!capacity || !queue) {
		if (record?.status !== "queued") void report("full");
		// A previously accepted item stays queued until capacity is available; it is never revoked.
		return record?.status === "queued";
	}
	if (paused || (record && pending?.has(record.id))) return true;
	if (record) pending?.add(record.id);
	const completion = queue.tryEnqueue(
		async () => {
			if (record && inbox && !inbox.start(record.id)) {
				await report("expired");
				return;
			}
			let prepared = event;
			if (transport.prepareEvent) {
				try {
					prepared = await transport.prepareEvent(event);
				} catch (error) {
					if (record)
						inbox?.finish(
							record.id,
							"rejected",
							`Attachment preparation failed before Agent dispatch: ${String(error)}`,
						);
					await transport.postMessage(
						event.channel,
						"附件下载/接纳失败，尚未交给Agent处理；请检查权限、大小或网络后重新发送。",
					);
					return;
				}
				if (record) inbox?.recordPrepared(record.id, prepared);
			}
			try {
				await handler.handleEvent(prepared, transport, isEvent);
				if (record) inbox?.finish(record.id, "completed");
			} catch (error) {
				if (record)
					inbox?.finish(record.id, "unknown", `Execution uncertain; inspect side effects: ${String(error)}`);
				throw error;
			}
		},
		async () => {
			if (record) inbox?.finish(record.id, "expired", "queue wait expired before execution");
			await report("expired");
		},
	);
	if (!completion) {
		if (record) inbox?.finish(record.id, "rejected", "queue closed before dispatch");
		void report("full");
		return false;
	}
	const currentQueue = queue;
	void completion
		.then(() => {
			if (record) pending?.delete(record.id);
			if (!inbox?.accepting || inbox.dispatchPaused || inbox.unresolvedChannels().has(event.channel)) return;
			// Drain persisted backlog after restart, including when configured in-memory capacity shrank.
			for (const next of inbox.list()) {
				if (!currentQueue.canAccept()) break;
				if (next.event.channel === event.channel && next.status === "queued" && !pending?.has(next.id))
					enqueueChatEvent(currentQueue, next.event, handler, transport, next.isEvent);
			}
		})
		.catch((error) => log.logWarning("Persistent queue pump failed", String(error)));
	return true;
}
