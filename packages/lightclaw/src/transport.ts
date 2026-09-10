import type { Attachment } from "./store.js";

export interface ChatEvent {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	user: string;
	text: string;
	files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
	attachments?: Attachment[];
}

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
	start(): Promise<void>;
	getUser(userId: string): ChatUser | undefined;
	getChannel(channelId: string): ChatChannel | undefined;
	getAllUsers(): ChatUser[];
	getAllChannels(): ChatChannel[];
	postMessage(channel: string, text: string): Promise<string>;
	updateMessage(channel: string, messageId: string, text: string): Promise<void>;
	deleteMessage(channel: string, messageId: string): Promise<void>;
	postInThread(channel: string, rootMessageId: string, text: string): Promise<string>;
	uploadFile(channel: string, filePath: string, title?: string): Promise<void>;
	logBotResponse(channel: string, text: string, messageId: string): void;
	enqueueEvent(event: ChatEvent): boolean;
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
	uploadFile(filePath: string, title?: string): Promise<void>;
	setWorking(working: boolean): Promise<void>;
	deleteMessage(): Promise<void>;
}

export interface ChatHandler {
	isRunning(channelId: string): boolean;
	handleEvent(event: ChatEvent, transport: ChatTransport, isEvent?: boolean): Promise<void>;
	handleStop(channelId: string, transport: ChatTransport): Promise<void>;
}
