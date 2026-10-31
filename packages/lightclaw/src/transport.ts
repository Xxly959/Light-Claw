import type { DurableInbox } from "./durable-inbox.js";
import type { Attachment } from "./store.js";

export type ChatEventOrigin = "platform" | "scheduled" | "recovery" | "continuation";

export interface ChatEvent {
	origin: ChatEventOrigin;
	type: "mention" | "dm";
	channel: string;
	ts: string;
	user: string;
	text: string;
	files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
	attachments?: Attachment[];
}

export type ChatActor = Pick<ChatEvent, "user" | "origin">;

export interface ChatUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface ChatChannel {
	id: string;
	name: string;
}

export interface ChatTransport {
	readonly kind: "feishu" | "slack";
	readonly inbox?: DurableInbox;
	readonly queueWaitMs?: number;
	readonly queueCapacity?: number;
	readonly durableAdmission?: boolean;
	stop?(): Promise<void>;
	drain?(): Promise<void>;
	start(): Promise<void>;
	getUser(userId: string): ChatUser | undefined;
	getChannel(channelId: string): ChatChannel | undefined;
	getAllUsers(): ChatUser[];
	getAllChannels(): ChatChannel[];
	postMessage(channel: string, text: string): Promise<string>;
	updateMessage(channel: string, messageId: string, text: string): Promise<void>;
	deleteMessage(channel: string, messageId: string): Promise<void>;
	postInThread(channel: string, rootMessageId: string, text: string): Promise<string>;
	/** filePath is relative to this channel; the transport authorizes the host read. */
	uploadFile(channel: string, filePath: string, title?: string): Promise<void>;
	logBotResponse(channel: string, text: string, messageId: string): void;
	enqueueEvent(event: ChatEvent): boolean;
	enqueueAccepted?(event: ChatEvent, isEvent: boolean): boolean;
}

export interface ChatContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChatChannel[];
	users: ChatUser[];
	respond(text: string, shouldLog?: boolean): Promise<void>;
	replaceMessage(text: string): Promise<void>;
	respondInThread(text: string): Promise<void>;
	setTyping(isTyping: boolean): Promise<void>;
	/** filePath is channel-relative, never an arbitrary host path. */
	uploadFile(filePath: string, title?: string): Promise<void>;
	setWorking(working: boolean): Promise<void>;
	deleteMessage(): Promise<void>;
}

export interface ChatHandler {
	isRunning(channelId: string): boolean;
	handleQueueFailure(event: ChatEvent, transport: ChatTransport, reason: "full" | "expired"): Promise<void>;
	handleEvent(event: ChatEvent, transport: ChatTransport, isEvent?: boolean): Promise<void>;
	handleStop(channelId: string, transport: ChatTransport, actor: ChatActor): Promise<void>;
}

export function isImmediateGoalControl(event: ChatEvent): boolean {
	return (
		event.origin === "platform" &&
		Boolean(event.user.trim()) &&
		/^\/goal\s+(pause|cancel)\s*$/.test(event.text.trim())
	);
}
