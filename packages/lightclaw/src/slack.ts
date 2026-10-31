import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { readChannelAttachment } from "./attachments.js";
import { ChannelQueue, type ChannelQueueOptions } from "./channel-queue.js";
import type { DurableInbox } from "./durable-inbox.js";
import { IdleResourceCache } from "./idle-cache.js";
import * as log from "./log.js";
import { observePlatformOperation } from "./platform-operations.js";
import { enqueueChatEvent } from "./queued-events.js";
import { appendConversationLine } from "./resource-policy.js";
import { createSdkLogger } from "./sdk-logger.js";
import type { Attachment, ChannelStore } from "./store.js";
import type { ChatChannel, ChatEvent, ChatHandler, ChatTransport, ChatUser } from "./transport.js";
import { isImmediateGoalControl } from "./transport.js";

// ============================================================================
// Types
// ============================================================================

export type SlackEvent = ChatEvent;
export type SlackUser = ChatUser;
export type SlackChannel = ChatChannel;
export type LightClawHandler = ChatHandler;

// ============================================================================
// SlackBot
// ============================================================================

export class SlackBot implements ChatTransport {
	readonly kind = "slack" as const;
	readonly inbox?: DurableInbox;
	readonly queueWaitMs: number;
	get queueCapacity(): number {
		return this.queueOptions.maxPending;
	}
	get durableAdmission(): boolean {
		return this.inbox !== undefined;
	}
	async stop(): Promise<void> {
		this.inbox?.stopAdmission();
		const queues = this.queues.values();
		for (const queue of queues) queue.close();
		await Promise.all(queues.map((queue) => queue.drain()));
		this.queues.close();
		await this.socketClient.disconnect();
	}
	enqueueAccepted(event: ChatEvent, isEvent: boolean): boolean {
		return enqueueChatEvent(() => this.getQueue(event.channel), event, this.handler, this, isEvent);
	}

	private socketClient: SocketModeClient;
	private webClient: WebClient;
	private handler: LightClawHandler;
	private workingDir: string;
	private store: ChannelStore;
	private botUserId: string | null = null;
	private startupTs: string | null = null; // Messages older than this are just logged, not processed

	private users = new Map<string, SlackUser>();
	private channels = new Map<string, SlackChannel>();
	private readonly queues: IdleResourceCache<ChannelQueue>;
	private readonly queueOptions: ChannelQueueOptions;
	private readonly platformTimeoutMs: number;

	constructor(
		handler: LightClawHandler,
		config: {
			appToken: string;
			botToken: string;
			workingDir: string;
			inbox?: DurableInbox;
			store: ChannelStore;
			platformTimeoutMs?: number;
			schedulingEnabled?: boolean;
			queueMaxPending?: number;
			queueMaxWaitMs?: number;
			channelCacheMaxEntries?: number;
			channelCacheIdleTtlMs?: number;
		},
	) {
		this.queues = new IdleResourceCache<ChannelQueue>(
			{
				enabled: config.schedulingEnabled,
				maxEntries: config.channelCacheMaxEntries ?? 128,
				idleTtlMs: config.channelCacheIdleTtlMs ?? 900_000,
			},
			(queue) => queue.isProcessing() || queue.size() > 0,
		);
		this.queueOptions = {
			enabled: config.schedulingEnabled,
			maxPending: config.queueMaxPending ?? 5,
			maxWaitMs: config.queueMaxWaitMs ?? 300_000,
		};
		this.handler = handler;
		this.platformTimeoutMs = config.platformTimeoutMs ?? 30_000;
		this.workingDir = config.workingDir;
		this.inbox = config.inbox;
		this.queueWaitMs = config.queueMaxWaitMs ?? 300_000;
		this.store = config.store;
		this.socketClient = new SocketModeClient({ appToken: config.appToken, logger: createSdkLogger("slack-socket") });
		this.webClient = new WebClient(config.botToken, {
			timeout: config.platformTimeoutMs ?? 30_000,
			logger: createSdkLogger("slack-web"),
			retryConfig: { retries: 0 },
			rejectRateLimitedCalls: true,
		});
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;

		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		await this.backfillAllChannels();

		this.setupEventHandlers();
		await this.socketClient.start();

		// Record startup time - messages older than this are just logged, not processed
		this.startupTs = (Date.now() / 1000).toFixed(6);

		log.logConnected();
	}

	getUser(userId: string): SlackUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): SlackChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): SlackUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): SlackChannel[] {
		return Array.from(this.channels.values());
	}

	async postMessage(channel: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, text });
		if (!result.ts) throw new Error("slack send failed: no message ts in response");
		return result.ts;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		await this.webClient.chat.update({ channel, ts, text });
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		await this.webClient.chat.delete({ channel, ts });
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text });
		if (!result.ts) throw new Error("slack send failed: no message ts in response");
		return result.ts;
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = await readChannelAttachment(this.workingDir, channel, filePath);
		await this.webClient.files.uploadV2({
			channel_id: channel,
			file: fileContent,
			filename: fileName,
			title: fileName,
		});
	}

	/**
	 * Log a message to log.jsonl (SYNC)
	 * This is the ONLY place messages are written to log.jsonl
	 */
	logToFile(channel: string, entry: object): void {
		const dir = this.store.getChannelDir(channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendConversationLine(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	/**
	 * Log a bot response to log.jsonl
	 */
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

	// ==========================================================================
	// Events Integration
	// ==========================================================================

	/**
	 * Enqueue an event for processing. Always queues (no "already working" rejection).
	 * Returns false if bounded admission rejects the event.
	 */
	enqueueEvent(event: SlackEvent): boolean {
		return enqueueChatEvent(() => this.getQueue(event.channel), event, this.handler, this, true);
	}

	// ==========================================================================
	// Private - Event Handlers
	// ==========================================================================

	private getQueue(channelId: string): ChannelQueue {
		return this.queues.getOrCreate(channelId, () => new ChannelQueue(undefined, this.queueOptions));
	}

	private setupEventHandlers(): void {
		// Channel @mentions
		this.socketClient.on("app_mention", ({ event, ack }) => {
			const e = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Skip DMs (handled by message event)
			if (e.channel.startsWith("D")) {
				ack();
				return;
			}

			const slackEvent: SlackEvent = {
				origin: "platform",
				type: "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// SYNC: Log to log.jsonl (ALWAYS, even for old messages)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (!this.inbox && this.startupTs && e.ts < this.startupTs) {
				log.logInfo(
					`[${e.channel}] Logged old message (pre-startup), not triggering: ${slackEvent.text.substring(0, 30)}`,
				);
				ack();
				return;
			}

			if (isImmediateGoalControl(slackEvent)) {
				void observePlatformOperation(
					() => this.handler.handleEvent(slackEvent, this),
					this.workingDir,
					e.channel,
					this.platformTimeoutMs,
					"goal-control",
				);
				ack();
				return;
			}
			// Check for stop command - execute immediately, don't queue!
			if (slackEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(e.channel)) {
					void observePlatformOperation(
						() => this.handler.handleStop(e.channel, this, { user: slackEvent.user, origin: "platform" }),
						this.workingDir,
						e.channel,
						this.platformTimeoutMs,
						"stop",
					);
				} else {
					void observePlatformOperation(
						() => this.postMessage(e.channel, "_Nothing running_"),
						this.workingDir,
						e.channel,
						this.platformTimeoutMs,
						"idle-stop",
					);
				}
				ack();
				return;
			}

			// SYNC: Check if busy
			if (!this.inbox && this.handler.isRunning(e.channel)) {
				void observePlatformOperation(
					() => this.postMessage(e.channel, "_Already working. Say `@lightclaw stop` to cancel._"),
					this.workingDir,
					e.channel,
					this.platformTimeoutMs,
					"busy",
				);
			} else {
				enqueueChatEvent(() => this.getQueue(e.channel), slackEvent, this.handler, this);
			}

			ack();
		});

		// All messages (for logging) + DMs (for triggering)
		this.socketClient.on("message", ({ event, ack }) => {
			const e = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Skip bot messages, edits, etc.
			if (e.bot_id || !e.user || e.user === this.botUserId) {
				ack();
				return;
			}
			if (e.subtype !== undefined && e.subtype !== "file_share") {
				ack();
				return;
			}
			if (!e.text && (!e.files || e.files.length === 0)) {
				ack();
				return;
			}

			const isDM = e.channel_type === "im";
			const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

			// Skip channel @mentions - already handled by app_mention event
			if (!isDM && isBotMention) {
				ack();
				return;
			}

			const slackEvent: SlackEvent = {
				origin: "platform",
				type: isDM ? "dm" : "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// SYNC: Log to log.jsonl (ALL messages - channel chatter and DMs)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (!this.inbox && this.startupTs && e.ts < this.startupTs) {
				log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${slackEvent.text.substring(0, 30)}`);
				ack();
				return;
			}

			// Only trigger handler for DMs
			if (isDM) {
				if (isImmediateGoalControl(slackEvent)) {
					void observePlatformOperation(
						() => this.handler.handleEvent(slackEvent, this),
						this.workingDir,
						e.channel,
						this.platformTimeoutMs,
						"goal-control",
					);
					ack();
					return;
				}
				// Check for stop command - execute immediately, don't queue!
				if (slackEvent.text.toLowerCase().trim() === "stop") {
					if (this.handler.isRunning(e.channel)) {
						void observePlatformOperation(
							() => this.handler.handleStop(e.channel, this, { user: slackEvent.user, origin: "platform" }),
							this.workingDir,
							e.channel,
							this.platformTimeoutMs,
							"stop",
						);
					} else {
						void observePlatformOperation(
							() => this.postMessage(e.channel, "_Nothing running_"),
							this.workingDir,
							e.channel,
							this.platformTimeoutMs,
							"idle-stop",
						);
					}
					ack();
					return;
				}

				if (!this.inbox && this.handler.isRunning(e.channel)) {
					void observePlatformOperation(
						() => this.postMessage(e.channel, "_Already working. Say `stop` to cancel._"),
						this.workingDir,
						e.channel,
						this.platformTimeoutMs,
						"busy",
					);
				} else {
					enqueueChatEvent(() => this.getQueue(e.channel), slackEvent, this.handler, this);
				}
			}

			ack();
		});
	}

	/**
	 * Log a user message to log.jsonl (SYNC)
	 * Downloads attachments in background via store
	 */
	private logUserMessage(event: SlackEvent): Attachment[] {
		const user = this.users.get(event.user);
		// Process attachments - queues downloads in background
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];
		this.logToFile(event.channel, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			user: event.user,
			userName: user?.userName,
			displayName: user?.displayName,
			text: event.text,
			attachments,
			isBot: false,
		});
		return attachments;
	}

	// ==========================================================================
	// Private - Backfill
	// ==========================================================================

	private getExistingTimestamps(channelId: string): Set<string> {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;

		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.ts) timestamps.add(entry.ts);
			} catch {}
		}
		return timestamps;
	}

	private async backfillChannel(channelId: string): Promise<number> {
		const existingTs = this.getExistingTimestamps(channelId);

		// Find the biggest ts in log.jsonl
		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Message = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			subtype?: string;
			files?: Array<{ name: string }>;
		};
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: latestTs, // Only fetch messages newer than what we have
				inclusive: false,
				limit: 1000,
				cursor,
			});
			if (result.messages) {
				allMessages.push(...(result.messages as Message[]));
			}
			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		// Filter: include lightclaw's messages, exclude other bots, skip already logged
		const relevantMessages = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false; // Skip duplicates
			if (msg.user === this.botUserId) return true;
			if (msg.bot_id) return false;
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		// Reverse to chronological order
		relevantMessages.reverse();

		// Log each message to log.jsonl
		for (const msg of relevantMessages) {
			const isLightClawMessage = msg.user === this.botUserId;
			const user = this.users.get(msg.user!);
			// Strip @mentions from text (same as live messages)
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			// Process attachments - queues downloads in background
			const attachments = msg.files ? this.store.processAttachments(channelId, msg.files, msg.ts!) : [];

			this.logToFile(channelId, {
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				user: isLightClawMessage ? "bot" : msg.user!,
				userName: isLightClawMessage ? undefined : user?.userName,
				displayName: isLightClawMessage ? undefined : user?.displayName,
				text,
				attachments,
				isBot: isLightClawMessage,
			});
		}

		return relevantMessages.length;
	}

	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();

		// Only backfill channels that already have a log.jsonl (lightclaw has interacted with them before)
		const channelsToBackfill: Array<[string, SlackChannel]> = [];
		for (const [channelId, channel] of this.channels) {
			const logPath = join(this.workingDir, channelId, "log.jsonl");
			if (existsSync(logPath)) {
				channelsToBackfill.push([channelId, channel]);
			}
		}

		log.logBackfillStart(channelsToBackfill.length);

		let totalMessages = 0;
		for (const [channelId, channel] of channelsToBackfill) {
			try {
				const count = await this.backfillChannel(channelId);
				if (count > 0) log.logBackfillChannel(channel.name, count);
				totalMessages += count;
			} catch (error) {
				log.logWarning(`Failed to backfill #${channel.name}`, String(error));
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	// ==========================================================================
	// Private - Fetch Users/Channels
	// ==========================================================================

	private async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
				| undefined;
			if (members) {
				for (const u of members) {
					if (u.id && u.name && !u.deleted) {
						this.users.set(u.id, { id: u.id, userName: u.name, displayName: u.real_name || u.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	private async fetchChannels(): Promise<void> {
		// Fetch public/private channels
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
			if (channels) {
				for (const c of channels) {
					if (c.id && c.name && c.is_member) {
						this.channels.set(c.id, { id: c.id, name: c.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);

		// Also fetch DM channels (IMs)
		cursor = undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "im",
				limit: 200,
				cursor,
			});
			const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
			if (ims) {
				for (const im of ims) {
					if (im.id) {
						// Use user's name as channel name for DMs
						const user = im.user ? this.users.get(im.user) : undefined;
						const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
						this.channels.set(im.id, { id: im.id, name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}
}
