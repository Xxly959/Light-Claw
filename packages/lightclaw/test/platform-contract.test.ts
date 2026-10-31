import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurableInbox } from "../src/durable-inbox.js";
import { FeishuBot } from "../src/feishu.js";
import { SlackBot } from "../src/slack.js";
import { ChannelStore } from "../src/store.js";
import type { ChatEvent, ChatHandler, ChatTransport } from "../src/transport.js";

type Envelope = {
	event: { channel: string; ts: string; user: string; text: string; channel_type: string };
	ack: () => void;
};
const sdk = vi.hoisted(() => ({
	callbacks: new Map<string, (e: Envelope) => void>(),
	feishu: new Map<string, (e: unknown) => Promise<void>>(),
	feishuOptions: {} as { onReconnected?: () => void },
	webOptions: {} as Record<string, unknown>,
	post: vi.fn(async (_args: unknown): Promise<{ ts?: string }> => ({ ts: "reply" })),
	update: vi.fn(async (_args: unknown) => ({ ok: true })),
	remove: vi.fn(async (_args: unknown) => ({ ok: true })),
	upload: vi.fn(async (_args: unknown) => ({ ok: true })),
	create: vi.fn(
		async (_args: unknown): Promise<{ code: number; msg?: string; data?: { message_id?: string } }> => ({
			code: 0,
			data: { message_id: "reply" },
		}),
	),
	edit: vi.fn(async (_args: unknown) => ({ code: 0 })),
	recall: vi.fn(async (_args: unknown) => ({ code: 0 })),
	reply: vi.fn(async (_args: unknown) => ({ code: 0, data: { message_id: "thread" } })),
	file: vi.fn(async (_args: unknown) => ({ file_key: "file-key" })),
	socketStart: vi.fn(async () => {}),
	socketStop: vi.fn(async () => {}),
	wsStart: vi.fn(async () => {}),
	wsStop: vi.fn(),
}));
vi.mock("@slack/socket-mode", () => ({
	SocketModeClient: class {
		on(name: string, callback: (e: Envelope) => void) {
			sdk.callbacks.set(name, callback);
		}
		start = sdk.socketStart;
		disconnect = sdk.socketStop;
	},
}));
vi.mock("@slack/web-api", () => ({
	LogLevel: { WARN: "warn", INFO: "info", ERROR: "error", DEBUG: "debug" },
	WebClient: class {
		constructor(_token: string, options: Record<string, unknown>) {
			sdk.webOptions = options;
		}
		auth = { test: async () => ({ user_id: "BOT" }) };
		users = { list: async () => ({ members: [] }) };
		conversations = { list: async () => ({ channels: [] }), history: async () => ({ messages: [] }) };
		chat = { postMessage: sdk.post, update: sdk.update, delete: sdk.remove };
		files = { uploadV2: sdk.upload };
	},
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({
	Domain: { Feishu: "feishu" },
	LoggerLevel: { info: "info", warn: "warn", error: "error" },
	defaultHttpInstance: { request: vi.fn() },
	EventDispatcher: class {
		register(entries: Record<string, (e: unknown) => Promise<void>>) {
			for (const [name, fn] of Object.entries(entries)) sdk.feishu.set(name, fn);
			return this;
		}
	},
	Client: class {
		request = async () => ({ bot: { open_id: "BOT" } });
		im = {
			v1: {
				chat: { list: async () => ({ code: 0, data: { items: [] } }) },
				message: { create: sdk.create, update: sdk.edit, delete: sdk.recall, reply: sdk.reply },
				file: { create: sdk.file },
			},
		};
	},
	WSClient: class {
		constructor(options: typeof sdk.feishuOptions) {
			sdk.feishuOptions = options;
		}
		start = sdk.wsStart;
		close = sdk.wsStop;
	},
}));
const roots: string[] = [],
	bots: Array<SlackBot | FeishuBot> = [];
beforeEach(() => {
	vi.clearAllMocks();
	sdk.callbacks.clear();
	sdk.feishu.clear();
	sdk.post.mockResolvedValue({ ts: "reply" });
	sdk.create.mockResolvedValue({ code: 0, data: { message_id: "reply" } });
});
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.stop();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(kind: "slack" | "feishu", failDelivery = false) {
	const root = mkdtempSync(join(tmpdir(), "lightclaw-platform-contract-"));
	roots.push(root);
	const work = join(root, "work"),
		inbox = new DurableInbox(join(root, "control", "inbox"));
	mkdirSync(join(work, "channel"), { recursive: true });
	const run = vi.fn(async (event: ChatEvent, transport: ChatTransport) => {
		transport.logBotResponse(event.channel, "saved fictional result", "reply");
		await transport.postMessage(event.channel, "saved fictional result");
	});
	const stop = vi.fn(async () => {});
	const handler: ChatHandler = {
		isRunning: () => true,
		handleEvent: run,
		handleQueueFailure: async () => {},
		handleStop: stop,
	};
	const config = {
		workingDir: work,
		store: new ChannelStore({ workingDir: work }),
		inbox,
		appToken: "fictional",
		botToken: "fictional",
		appId: "fictional",
		appSecret: "fictional",
		platformTimeoutMs: 50,
	};
	const bot = kind === "slack" ? new SlackBot(handler, config) : new FeishuBot(handler, config);
	bots.push(bot);
	const emit = async (text = "task", ts = "1") => {
		if (kind === "slack") {
			sdk.callbacks.get("message")!({
				event: { channel: "channel", ts, user: "owner", text, channel_type: "im" },
				ack: () => {},
			});
		} else
			await sdk.feishu.get("im.message.receive_v1")!({
				sender: { sender_id: { open_id: "owner" } },
				message: {
					message_id: ts,
					chat_id: "channel",
					chat_type: "p2p",
					message_type: "text",
					content: JSON.stringify({ text }),
				},
			});
	};
	return { root, work, inbox, run, stop, bot, emit, failDelivery };
}
describe.each(["slack", "feishu"] as const)("%s actual-adapter offline contract", (kind) => {
	it("rejects noncanonical storage channel paths before writing outside its workspace", () => {
		const f = fixture(kind);
		expect(() => f.bot.logToFile("../escape", { text: "fictional" })).toThrow();
		expect(existsSync(join(f.root, "escape", "log.jsonl"))).toBe(false);
	});
	it("starts/stops the SDK boundary, deduplicates redelivery after reconnect, and persists result", async () => {
		const f = fixture(kind);
		await f.bot.start();
		await f.emit();
		await vi.waitFor(() => expect(f.inbox.list()[0]?.status).toBe("completed"));
		if (kind === "feishu") sdk.feishuOptions.onReconnected?.();
		await f.emit();
		await new Promise((r) => setTimeout(r, 10));
		expect(f.run).toHaveBeenCalledOnce();
		expect(readFileSync(join(f.work, "channel", "log.jsonl"), "utf8")).toContain("saved fictional result");
		if (kind === "slack")
			expect(sdk.webOptions).toMatchObject({ retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
	});
	it("surfaces permission and rate-limit errors without an application retry", async () => {
		const f = fixture(kind);
		const error = new Error("fictional missing_scope or 429 Retry-After=2");
		if (kind === "slack") sdk.post.mockRejectedValue(error);
		else sdk.create.mockResolvedValue({ code: 99991672, msg: error.message });
		await expect(f.bot.postMessage("channel", "test")).rejects.toThrow();
		expect(kind === "slack" ? sdk.post : sdk.create).toHaveBeenCalledOnce();
	});
	it("retains saved output and uncertain admission after delivery failure", async () => {
		const f = fixture(kind);
		await f.bot.start();
		if (kind === "slack") sdk.post.mockRejectedValue(new Error("fictional transport failed"));
		else sdk.create.mockResolvedValue({ code: 230002, msg: "fictional permission denied" });
		await f.emit();
		await vi.waitFor(() => expect(f.inbox.list()[0]?.status).toBe("unknown"));
		expect(readFileSync(join(f.work, "channel", "log.jsonl"), "utf8")).toContain("saved fictional result");
	});
	it("carries authenticated platform actor on stop", async () => {
		const f = fixture(kind);
		await f.bot.start();
		await f.emit("stop");
		await vi.waitFor(() =>
			expect(f.stop).toHaveBeenCalledWith("channel", f.bot, { user: "owner", origin: "platform" }),
		);
	});
	it("supports edit/thread/delete and current-channel bounded attachment bytes", async () => {
		const f = fixture(kind);
		writeFileSync(join(f.work, "channel", "result.txt"), "fictional attachment");
		await f.bot.updateMessage("channel", "reply", "edit");
		await f.bot.postInThread("channel", "reply", "thread");
		await f.bot.deleteMessage("channel", "reply");
		await f.bot.uploadFile("channel", "result.txt");
		expect(kind === "slack" ? sdk.upload : sdk.file).toHaveBeenCalledOnce();
		await expect(f.bot.uploadFile("channel", "../other/result.txt")).rejects.toThrow();
	});
	it("rejects a successful SDK response that omitted the required message identity", async () => {
		const f = fixture(kind);
		if (kind === "slack") sdk.post.mockResolvedValue({});
		else sdk.create.mockResolvedValue({ code: 0 });
		await expect(f.bot.postMessage("channel", "test")).rejects.toThrow();
	});
});
