import { ChannelQueue } from "../../channel-queue.js";
import type { DurableInbox } from "../../durable-inbox.js";
import { enqueueChatEvent } from "../../queued-events.js";
import type { ChatEvent, ChatHandler, ChatTransport } from "../../transport.js";
export class SimulatedPlatform implements ChatTransport {
	readonly kind = "slack" as const;
	readonly durableAdmission = true;
	get queueWaitMs(): number {
		return this.maxWaitMs;
	}
	readonly queueCapacity = 4;
	readonly messages: Array<{ method: string; text: string; id: string }> = [];
	private readonly queues = new Map<string, ChannelQueue>();
	private serial = 0;
	failUpdates = 0;
	failFinalUpdates = 0;
	constructor(
		private readonly handler: ChatHandler,
		readonly inbox: DurableInbox,
		private readonly maxWaitMs = 30_000,
	) {}
	private queue(channel: string) {
		let queue = this.queues.get(channel);
		if (!queue) {
			queue = new ChannelQueue(undefined, { maxPending: 4, maxWaitMs: this.maxWaitMs });
			this.queues.set(channel, queue);
		}
		return queue;
	}
	receive(event: ChatEvent, isEvent = false): boolean {
		return enqueueChatEvent(() => this.queue(event.channel), event, this.handler, this, isEvent);
	}
	enqueueAccepted(event: ChatEvent, isEvent: boolean): boolean {
		return this.receive(event, isEvent);
	}
	enqueueEvent(event: ChatEvent): boolean {
		return this.receive(event, true);
	}
	start = async () => {};
	async drain() {
		await Promise.all([...this.queues.values()].map((q) => q.drain()));
	}
	async stop() {
		this.inbox.stopAdmission();
		for (const q of this.queues.values()) q.close();
		await this.drain();
	}
	getUser(id: string) {
		return { id, userName: "fixture", displayName: "Fixture owner" };
	}
	getChannel(id: string) {
		return { id, name: "Evaluation" };
	}
	getAllUsers() {
		return [this.getUser("owner")];
	}
	getAllChannels() {
		return [this.getChannel("evaluation")];
	}
	async postMessage(_channel: string, text: string) {
		const id = String(++this.serial);
		this.messages.push({ method: "post", text, id });
		return id;
	}
	async updateMessage(_channel: string, id: string, text: string) {
		if (!text.endsWith(" ...") && this.failFinalUpdates-- > 0)
			throw new Error("Injected final platform delivery failure");
		if (this.failUpdates-- > 0) throw new Error("Injected platform delivery failure");
		this.messages.push({ method: "update", text, id });
	}
	async deleteMessage(_channel: string, id: string) {
		this.messages.push({ method: "delete", text: "", id });
	}
	async postInThread(channel: string, _root: string, text: string) {
		return this.postMessage(channel, text);
	}
	async uploadFile() {
		throw new Error("Upload is not exposed in this offline fixture");
	}
	logBotResponse() {}
}
