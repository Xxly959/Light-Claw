import * as Lark from "@larksuiteoapi/node-sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { ChannelQueue, type ChannelQueueOptions } from "./channel-queue.js";
import { IdleResourceCache } from "./idle-cache.js";
import * as log from "./log.js";
import { observePlatformOperation } from "./platform-operations.js";
import { enqueueChatEvent } from "./queued-events.js";
import type { Attachment, ChannelStore } from "./store.js";
import type { ChatChannel, ChatEvent, ChatHandler, ChatTransport, ChatUser } from "./transport.js";
import { isImmediateGoalControl } from "./transport.js";

// ============================================================================
// Types
// ============================================================================

export interface FeishuConfig {
	appId: string; // cli_xxxxxxxx
	appSecret: string;
	workingDir: string;
	store: ChannelStore;
	platformTimeoutMs?: number;
	queueMaxPending?: number;
	queueMaxWaitMs?: number;
	channelCacheMaxEntries?: number;
	channelCacheIdleTtlMs?: number;
}

export function createFeishuHttpClient(timeoutMs: number): Lark.HttpInstance {
	// The SDK interceptor unwraps Axios responses; HttpInstance's R describes that payload.
	const request = <T = unknown, R = T, D = unknown>(options: Lark.HttpRequestOptions<D>): Promise<R> =>
		Lark.defaultHttpInstance.request<T, R, D>({ ...options, timeout: timeoutMs }) as Promise<R>;
	return {
		request,
		get: (url, options) => request({ ...options, url, method: "GET" }),
		delete: (url, options) => request({ ...options, url, method: "DELETE" }),
		head: (url, options) => request({ ...options, url, method: "HEAD" }),
		options: (url, options) => request({ ...options, url, method: "OPTIONS" }),
		post: (url, data, options) => request({ ...options, url, data, method: "POST" }),
		put: (url, data, options) => request({ ...options, url, data, method: "PUT" }),
		patch: (url, data, options) => request({ ...options, url, data, method: "PATCH" }),
	};
}

// ============================================================================
// Helpers
// ============================================================================

/** Extract readable text from a content JSON string. */
export function textOfContent(msgType: string, content: string): string {
	try {
		const o = JSON.parse(content);
		if (msgType === "text") return o.text ?? "";
		if (msgType === "post") {
			const seg = o.zh_cn?.content ?? o.en_us?.content ?? [];
			return seg
				.flat()
				.map((e: { tag?: string; text?: string }) => (e.tag === "text" ? (e.text ?? "") : ""))
				.join("");
		}
		return "";
	} catch {
		return "";
	}
}

/** Strip <at user_id="ou_xxx">Name</at> tags, leaving plain text. */
export function stripAtTags(s: string): string {
	return s
		.replace(/<at\s+user_id="[^"]*">([^<]*)<\/at>/g, "")
		.replace(/<at\s+id="[^"]*">([^<]*)<\/at>/g, "")
		.trim();
}

// ============================================================================
// FeishuBot
// ============================================================================

export class FeishuBot implements ChatTransport {
	readonly kind = "feishu" as const;
	private client: Lark.Client;
	private ws: Lark.WSClient;
	private handler: ChatHandler;
	private workingDir: string;
	private store: ChannelStore;

	private botOpenId: string | null = null;
	private users = new Map<string, ChatUser>();
	private channels = new Map<string, ChatChannel>();
	private readonly queues: IdleResourceCache<ChannelQueue>;
	private readonly queueOptions: ChannelQueueOptions;
	private readonly platformTimeoutMs: number;
	private seenMessageIds = new Set<string>();

	constructor(handler: ChatHandler, config: FeishuConfig) {
		this.queues = new IdleResourceCache<ChannelQueue>(
			{ maxEntries: config.channelCacheMaxEntries ?? 128, idleTtlMs: config.channelCacheIdleTtlMs ?? 900_000 },
			(queue) => queue.isProcessing() || queue.size() > 0,
		);
		this.queueOptions = { maxPending: config.queueMaxPending ?? 5, maxWaitMs: config.queueMaxWaitMs ?? 300_000 };
		this.handler = handler;
		this.platformTimeoutMs = config.platformTimeoutMs ?? 30_000;
		this.workingDir = config.workingDir;
		this.store = config.store;
		const httpInstance = createFeishuHttpClient(config.platformTimeoutMs ?? 30_000);

		this.client = new Lark.Client({
			appId: config.appId,
			appSecret: config.appSecret,
			domain: Lark.Domain.Feishu,
			loggerLevel: Lark.LoggerLevel.info,
			httpInstance,
		});

		this.ws = new Lark.WSClient({
			appId: config.appId,
			appSecret: config.appSecret,
			domain: Lark.Domain.Feishu,
			loggerLevel: Lark.LoggerLevel.info,
			onReady: () => log.logInfo("[feishu] ws connected"),
			httpInstance,
			onError: (err: Error) => log.logWarning("[feishu] ws error", err.message),
			onReconnecting: () => log.logInfo("[feishu] ws reconnecting"),
			onReconnected: () => log.logInfo("[feishu] ws reconnected"),
		});
	}

	// ==========================================================================
	// Public API (mirrors SlackBot)
	// ==========================================================================

	async start(): Promise<void> {
		await this.resolveBotIdentity();
		await this.fetchChannels();
		log.logInfo(`[feishu] loaded ${this.channels.size} chats, ${this.users.size} users`);

		const dispatcher = new Lark.EventDispatcher({}).register({
			"im.message.receive_v1": async (data) => {
				// Must return within 3s or Feishu re-pushes. Only enqueue here.
				this.onMessage(data);
				return;
			},
		});

		await this.ws.start({ eventDispatcher: dispatcher });
		log.logConnected();
	}

	getUser(userId: string): ChatUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): ChatChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): ChatUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): ChatChannel[] {
		return Array.from(this.channels.values());
	}

	async postMessage(channel: string, text: string): Promise<string> {
		const res = await this.client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: channel, msg_type: "text", content: JSON.stringify({ text }) },
		});
		if (res.code !== 0) throw new Error(`feishu send failed: ${res.code} ${res.msg}`);
		const messageId = res.data?.message_id;
		if (!messageId) throw new Error("feishu send failed: no message_id in response");
		return messageId;
	}

	/**
	 * Feishu caps edits at 20 per message and only allows editing your own
	 * text/post messages, so this is best-effort: callers must tolerate failure.
	 */
	async updateMessage(_channel: string, messageId: string, text: string): Promise<void> {
		const res = await this.client.im.v1.message.update({
			path: { message_id: messageId },
			data: { msg_type: "text", content: JSON.stringify({ text }) },
		});
		if (res.code !== 0) throw new Error(`feishu update failed: ${res.code} ${res.msg}`);
	}

	/** Feishu has no delete — this is a recall, and may fail if out of time. */
	async deleteMessage(_channel: string, messageId: string): Promise<void> {
		const res = await this.client.im.v1.message.delete({ path: { message_id: messageId } });
		if (res.code !== 0) throw new Error(`feishu recall failed: ${res.code} ${res.msg}`);
	}

	async postInThread(_channel: string, rootMessageId: string, text: string): Promise<string> {
		const res = await this.client.im.v1.message.reply({
			path: { message_id: rootMessageId },
			data: { msg_type: "text", content: JSON.stringify({ text }), reply_in_thread: true },
		});
		if (res.code !== 0) throw new Error(`feishu reply failed: ${res.code} ${res.msg}`);
		const messageId = res.data?.message_id;
		if (!messageId) throw new Error("feishu reply failed: no message_id in response");
		return messageId;
	}

	/** Requires the `im:resource` scope (advanced). Silently degrades without it. */
	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const up = await this.client.im.v1.file.create({
			data: { file_type: "stream", file_name: fileName, file: readFileSync(filePath) },
		});
		if (!up?.file_key) throw new Error("feishu upload failed: no file_key (needs im:resource?)");
		const res = await this.client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: {
				receive_id: channel,
				msg_type: "file",
				content: JSON.stringify({ file_key: up.file_key }),
			},
		});
		if (res.code !== 0) throw new Error(`feishu send file failed: ${res.code} ${res.msg}`);
	}

	logToFile(channel: string, entry: object): void {
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile(channel, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	/** Applies the same bounded admission and expiry policy as user messages. */
	enqueueEvent(event: ChatEvent): boolean {
		return enqueueChatEvent(() => this.getQueue(event.channel), event, this.handler, this, true);
	}

	// ==========================================================================
	// Private
	// ==========================================================================

	private getQueue(chatId: string): ChannelQueue {
		return this.queues.getOrCreate(chatId, () => new ChannelQueue(undefined, this.queueOptions));
	}

	/** Bot's own open_id is not in the event body; fetch it once at startup. */
	private async resolveBotIdentity(): Promise<void> {
		try {
			const r = await this.client.request<{
				code?: number;
				msg?: string;
				bot?: { open_id?: string };
			}>({ url: "/open-apis/bot/v3/info", method: "GET" });
			if (r?.bot?.open_id) {
				this.botOpenId = r.bot.open_id;
				log.logInfo(`[feishu] bot open_id resolved`);
				return;
			}
			log.logWarning("[feishu] bot open_id unresolved (needs application:bot.basic_info:read)");
		} catch (err) {
			log.logWarning("[feishu] bot identity failed", err instanceof Error ? err.message : String(err));
		}
	}

	/** Only lists groups the bot has joined; p2p chats are cached lazily instead. */
	private async fetchChannels(): Promise<void> {
		try {
			let pageToken: string | undefined;
			do {
				const res = await this.client.im.v1.chat.list({
					params: { page_size: 100, page_token: pageToken },
				});
				if (res.code !== 0) {
					log.logWarning(`[feishu] chat.list failed: ${res.code} ${res.msg}`);
					return;
				}
				for (const c of res.data?.items ?? []) {
					if (c.chat_id && c.name) this.channels.set(c.chat_id, { id: c.chat_id, name: c.name });
				}
				pageToken = res.data?.page_token ?? undefined;
			} while (pageToken);
		} catch (err) {
			log.logWarning("[feishu] fetchChannels failed", err instanceof Error ? err.message : String(err));
		}
	}

	private onMessage(data: {
		sender?: { sender_id?: { open_id?: string }; sender_type?: string };
		message?: {
			message_id?: string;
			chat_id?: string;
			chat_type?: string;
			message_type?: string;
			content?: string;
			create_time?: string;
			mentions?: Array<{ id?: { open_id?: string }; name?: string }>;
		};
	}): void {
		try {
			const message = data.message;
			if (!message?.message_id || !message.chat_id) return;

			// Feishu may re-push; dedupe on message_id (never event_id).
			if (this.seenMessageIds.has(message.message_id)) return;
			this.seenMessageIds.add(message.message_id);
			if (this.seenMessageIds.size > 2000) this.seenMessageIds.clear();

			// Ignore our own messages, otherwise we loop forever.
			if (data.sender?.sender_type === "bot") return;

			const msgType = message.message_type ?? "";
			const text = stripAtTags(textOfContent(msgType, message.content ?? ""));
			if (!text) {
				log.logInfo(`[feishu] ignoring non-text message: ${msgType}`);
				return;
			}

			const isP2p = message.chat_type === "p2p";
			const mentioned =
				this.botOpenId !== null && (message.mentions ?? []).some((m) => m.id?.open_id === this.botOpenId);
			if (!isP2p && !mentioned) return; // group messages only trigger on @bot

			const senderOpenId = data.sender?.sender_id?.open_id ?? "";
			this.rememberUser(senderOpenId, message.mentions ?? []);

			const event: ChatEvent = {
				type: isP2p ? "dm" : "mention",
				origin: "platform",
				channel: message.chat_id,
				ts: message.message_id,
				user: senderOpenId,
				text,
			};
			this.logToFile(message.chat_id, {
				date: message.create_time ? new Date(Number(message.create_time)).toISOString() : new Date().toISOString(),
				ts: message.message_id,
				user: senderOpenId,
				userName: this.users.get(senderOpenId)?.userName,
				text,
				attachments: [],
				isBot: false,
			});

			if (isImmediateGoalControl(event)) {
				void observePlatformOperation(
					() => this.handler.handleEvent(event, this),
					this.workingDir,
					event.channel,
					this.platformTimeoutMs,
					"goal-control",
				);
				return;
			}
			if (text.toLowerCase() === "stop") {
				void observePlatformOperation(
					() =>
						this.handler.isRunning(message.chat_id!)
							? this.handler.handleStop(message.chat_id!, this)
							: this.postMessage(message.chat_id!, "当前没有正在执行的任务"),
					this.workingDir,
					message.chat_id,
					this.platformTimeoutMs,
					"stop",
				);
				return;
			}
			if (this.handler.isRunning(message.chat_id)) {
				this.enqueueEvent(event);
			} else {
				enqueueChatEvent(() => this.getQueue(event.channel), event, this.handler, this);
			}
		} catch (err) {
			log.logWarning("[feishu] onMessage error", err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Cache sender names. The contact API needs extra scopes, so we opportunistically
	 * reuse the display names that ship with mention payloads.
	 */
	private rememberUser(openId: string, mentions: Array<{ id?: { open_id?: string }; name?: string }>): void {
		if (!openId || this.users.has(openId)) return;
		const fromMention = mentions.find((m) => m.id?.open_id === openId)?.name;
		this.users.set(openId, {
			id: openId,
			userName: fromMention ?? openId,
			displayName: fromMention ?? openId,
		});
	}
}

export type { Attachment };
