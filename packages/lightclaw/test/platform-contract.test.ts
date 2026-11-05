import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentRunner } from "../src/agent.js";
import { loadConfigForDiagnostics } from "../src/config.js";
import { DurableInbox } from "../src/durable-inbox.js";
import { FeishuBot } from "../src/feishu.js";
import { createPromptOptimizer } from "../src/prompt-input.js";
import { createLightClawRuntime } from "../src/runtime.js";
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
	resource: vi.fn(async (_args: unknown) => ({
		getReadableStream: () => Readable.from([Buffer.from("fictional inbound file")]),
		headers: {},
	})),
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
				messageResource: { get: sdk.resource },
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
	sdk.resource.mockReset().mockResolvedValue({
		getReadableStream: () => Readable.from([Buffer.from("fictional inbound file")]),
		headers: {},
	});
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

it("downloads a Feishu file before dispatch and durably deduplicates the message", async () => {
	const f = fixture("feishu");
	await f.bot.start();
	const emit = () =>
		sdk.feishu.get("im.message.receive_v1")!({
			sender: { sender_id: { open_id: "owner" } },
			message: {
				message_id: "file-1",
				chat_id: "channel",
				chat_type: "p2p",
				message_type: "file",
				content: JSON.stringify({ file_key: "fictional-resource-key", file_name: "../../report.txt" }),
			},
		});
	await emit();
	await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
	const received = f.run.mock.calls[0][0];
	expect(received.attachments).toHaveLength(1);
	expect(readFileSync(join(f.work, received.attachments![0].local), "utf8")).toBe("fictional inbound file");
	expect(received.user).toBe("owner");
	expect(received.origin).toBe("platform");
	await emit();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(f.run).toHaveBeenCalledOnce();
	expect(sdk.resource).toHaveBeenCalledOnce();
});
it("reports unsupported Feishu types explicitly", async () => {
	const f = fixture("feishu");
	await f.bot.start();
	await sdk.feishu.get("im.message.receive_v1")!({
		sender: { sender_id: { open_id: "owner" } },
		message: {
			message_id: "unsupported",
			chat_id: "channel",
			chat_type: "p2p",
			message_type: "sticker",
			content: "{}",
		},
	});
	await vi.waitFor(() => expect(sdk.create).toHaveBeenCalled());
	expect(JSON.stringify(sdk.create.mock.calls)).toContain("不支持");
	expect(f.run).not.toHaveBeenCalled();
});
it.each(["permission", "size", "timeout"])("rejects inbound attachment %s before Agent dispatch", async (mode) => {
	const f = fixture("feishu");
	await f.bot.start();
	if (mode === "permission") sdk.resource.mockRejectedValueOnce(new Error("fictional missing im:resource permission"));
	if (mode === "size") {
		vi.stubEnv("LIGHTCLAW_ATTACHMENT_FILE_MAX_BYTES", "4");
	}
	if (mode === "timeout") {
		vi.stubEnv("LIGHTCLAW_DOWNLOAD_TIMEOUT_MS", "20");
		sdk.resource.mockResolvedValueOnce({ getReadableStream: () => new Readable({ read() {} }), headers: {} });
	}
	try {
		await sdk.feishu.get("im.message.receive_v1")!({
			sender: { sender_id: { open_id: "owner" } },
			message: {
				message_id: "bad-file",
				chat_id: "channel",
				chat_type: "p2p",
				message_type: "file",
				content: JSON.stringify({ file_key: "fictional-resource-key", file_name: "file.txt" }),
			},
		});
		await vi.waitFor(() => expect(sdk.create).toHaveBeenCalled());
		expect(f.run).not.toHaveBeenCalled();
		expect(f.inbox.list()[0].status).toBe("rejected");
	} finally {
		vi.unstubAllEnvs();
	}
});

it.each(["file", "image"] as const)(
	"runs the production adapter, runtime and faux Agent for inbound %s",
	async (kind) => {
		const root = mkdtempSync(join(tmpdir(), "feishu-full-flow-"));
		roots.push(root);
		const work = join(root, "work"),
			control = join(root, "control");
		mkdirSync(work);
		const provider = registerFauxProvider();
		const bytes = Buffer.from("fictional inbound file");
		let observed = false;
		provider.setResponses(
			kind === "file"
				? [
						() => {
							const name = readdirSync(join(work, "channel", "attachments"))[0];
							return fauxAssistantMessage(
								fauxToolCall("read", {
									label: "read received file",
									path: join(work, "channel", "attachments", name),
								}),
								{ stopReason: "toolUse" },
							);
						},
						(context) => {
							expect(JSON.stringify(context.messages)).toContain(bytes.toString());
							observed = true;
							return fauxAssistantMessage("file processed");
						},
					]
				: [
						(context) => {
							expect(JSON.stringify(context.messages)).toContain(bytes.toString("base64"));
							expect(JSON.stringify(context.messages)).toContain("不可信数据");
							observed = true;
							return fauxAssistantMessage("image processed");
						},
					],
		);
		const config = { ...loadConfigForDiagnostics({}), controlDir: control, features: { scheduling: false } };
		const runtime = await createLightClawRuntime({
			config,
			workingDir: work,
			sandbox: { type: "host" },
			createRunner: (sandbox, id, dir, cfg, goals, overrides) =>
				createAgentRunner(sandbox, id, dir, cfg, goals, {
					...overrides,
					model: provider.getModel(),
					inMemoryState: true,
					apiKey: "fictional-faux-key",
					quiet: true,
				}),
			createTransport: (handler, inbox) =>
				new FeishuBot(handler, {
					appId: "fictional",
					appSecret: "fictional",
					workingDir: work,
					inbox,
					store: new ChannelStore({ workingDir: work }),
				}),
		});
		try {
			await runtime.start();
			await sdk.feishu.get("im.message.receive_v1")!({
				sender: { sender_id: { open_id: "owner" } },
				message: {
					message_id: `production-${kind}`,
					chat_id: "channel",
					chat_type: "p2p",
					message_type: kind,
					content: JSON.stringify(
						kind === "file"
							? { file_key: "fictional-key", file_name: "input.txt" }
							: { image_key: "fictional-image" },
					),
				},
			});
			await vi.waitFor(() => expect(observed).toBe(true), { timeout: 5000 });
			await vi.waitFor(() =>
				expect(JSON.stringify(sdk.edit.mock.calls) + JSON.stringify(sdk.create.mock.calls)).toContain(
					`${kind} processed`,
				),
			);
		} finally {
			await runtime.shutdown();
			provider.unregister();
		}
	},
);
it("rejects a linked inbound attachment directory without modifying another channel", async () => {
	const f = fixture("feishu"),
		other = join(f.work, "other");
	mkdirSync(other);
	symlinkSync(other, join(f.work, "channel", "attachments"));
	await f.bot.start();
	await sdk.feishu.get("im.message.receive_v1")!({
		sender: { sender_id: { open_id: "owner" } },
		message: {
			message_id: "linked-file",
			chat_id: "channel",
			chat_type: "p2p",
			message_type: "file",
			content: JSON.stringify({ file_key: "fictional-key", file_name: "input.txt" }),
		},
	});
	await vi.waitFor(() => expect(f.inbox.list()[0]?.status).toBe("rejected"));
	expect(f.run).not.toHaveBeenCalled();
	expect(readdirSync(other)).toEqual([]);
});

it("offers a Feishu optimization button and durably admits only its authenticated action", async () => {
	const { bot, run, inbox } = fixture("feishu");
	await bot.start();
	expect(bot.kind).toBe("feishu");
	if (!(bot instanceof FeishuBot)) throw new Error("fixture");
	await bot.postPromptOptimizationCard("channel", "a".repeat(64));
	const request = JSON.stringify(sdk.create.mock.calls.at(-1)?.[0]);
	expect(request).toContain("提示词优化");
	expect(request).toContain("interactive");
	await sdk.feishu.get("card.action.trigger")!({
		context: { open_chat_id: "channel", open_message_id: "reply" },
		operator: { open_id: "owner" },
		action: { value: { action: "prompt_optimize", draftId: "a".repeat(64) } },
	});
	await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
	const e = run.mock.calls[0][0];
	expect(e.user).toBe("owner");
	expect(e.promptOptimization).toEqual({ draftId: "a".repeat(64), messageId: "reply" });
	await sdk.feishu.get("card.action.trigger")!({
		context: { open_chat_id: "channel", open_message_id: "reply" },
		operator: { open_id: "owner" },
		action: { value: { action: "prompt_optimize", draftId: "a".repeat(64) } },
	});
	expect(run).toHaveBeenCalledTimes(1);
	expect(inbox.list()).toHaveLength(1);
});

it("uses original input normally, optimizes only on the Feishu button, then returns to direct input", async () => {
	const root = mkdtempSync(join(tmpdir(), "feishu-prompt-full-"));
	roots.push(root);
	const provider = registerFauxProvider();
	let bot!: FeishuBot;
	const observed: string[] = [];
	provider.setResponses([
		(ctx) => {
			observed.push(JSON.stringify(ctx.messages));
			return fauxAssistantMessage("ordinary response");
		},
		fauxAssistantMessage('["高分候选"]'),
		fauxAssistantMessage('[{"index":0,"score":50,"reason":"原文"},{"index":1,"score":90,"reason":"清晰"}]'),
		(ctx) => {
			observed.push(JSON.stringify(ctx.messages));
			return fauxAssistantMessage("next response");
		},
	]);
	const runtime = await createLightClawRuntime({
		config: { ...loadConfigForDiagnostics({}), controlDir: join(root, "control") },
		workingDir: join(root, "work"),
		sandbox: { type: "host" },
		promptOptimizer: createPromptOptimizer(loadConfigForDiagnostics({}), {
			model: provider.getModel(),
			apiKey: "fictional",
		}),
		createTransport: (handler, inbox) => {
			bot = new FeishuBot(handler, {
				appId: "fictional",
				appSecret: "fictional",
				workingDir: join(root, "work"),
				store: new ChannelStore({ workingDir: join(root, "work") }),
				inbox,
			});
			return bot;
		},
		createRunner: (sandbox, id, dir, config, goals, overrides) =>
			createAgentRunner(sandbox, id, dir, config, goals, {
				...overrides,
				model: provider.getModel(),
				apiKey: "fictional",
				quiet: true,
			}),
	});
	try {
		await runtime.start();
		const send = async (text: string, id: string) => {
			await sdk.feishu.get("im.message.receive_v1")!({
				sender: { sender_id: { open_id: "owner" }, sender_type: "user" },
				message: {
					message_id: id,
					chat_id: "channel",
					chat_type: "p2p",
					message_type: "text",
					content: JSON.stringify({ text }),
				},
			});
			await runtime.idle();
		};
		await send("原始输入", "first");
		expect(provider.state.callCount).toBe(1);
		expect(observed[0]).toContain("原始输入");
		const card = sdk.create.mock.calls
			.map(([a]) => a as { data: { msg_type: string; content: string } })
			.find((a) => a.data.msg_type === "interactive")!;
		expect(card).toBeDefined();
		const value = JSON.parse(card.data.content).elements[1].actions[0].value;
		const click = async (user = "owner") => {
			await sdk.feishu.get("card.action.trigger")!({
				context: { open_chat_id: "channel", open_message_id: "reply" },
				operator: { open_id: user },
				action: { value },
			});
			await runtime.idle();
		};
		await click("outsider");
		expect(provider.state.callCount).toBe(1);
		await click();
		expect(provider.state.callCount).toBe(3);
		expect(JSON.stringify(sdk.create.mock.calls)).toContain("高分候选");
		await click();
		expect(provider.state.callCount).toBe(3);
		await send("下一条原文", "second");
		expect(provider.state.callCount).toBe(4);
		expect(observed[1]).toContain("下一条原文");
		expect(observed[1]).not.toContain("高分候选");
	} finally {
		await runtime.shutdown();
		provider.unregister();
	}
});

it("lets only the requester stop a pending prompt optimization and never retries it", async () => {
	const root = mkdtempSync(join(tmpdir(), "feishu-prompt-stop-"));
	roots.push(root);
	const provider = registerFauxProvider();
	provider.setResponses([fauxAssistantMessage("ordinary")]);
	let bot!: FeishuBot;
	const optimize = vi.fn(
		(_input: string, signal: AbortSignal) =>
			new Promise<never>((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
			),
	);
	const runtime = await createLightClawRuntime({
		config: { ...loadConfigForDiagnostics({}), controlDir: join(root, "control") },
		workingDir: join(root, "work"),
		sandbox: { type: "host" },
		promptOptimizer: optimize,
		createTransport: (handler, inbox) => {
			bot = new FeishuBot(handler, {
				appId: "fictional",
				appSecret: "fictional",
				workingDir: join(root, "work"),
				store: new ChannelStore({ workingDir: join(root, "work") }),
				inbox,
			});
			return bot;
		},
		createRunner: (sandbox, id, dir, config, goals, overrides) =>
			createAgentRunner(sandbox, id, dir, config, goals, {
				...overrides,
				model: provider.getModel(),
				apiKey: "fictional",
				quiet: true,
			}),
	});
	try {
		await runtime.start();
		await sdk.feishu.get("im.message.receive_v1")!({
			sender: { sender_id: { open_id: "owner" }, sender_type: "user" },
			message: {
				message_id: "stop-input",
				chat_id: "channel",
				chat_type: "p2p",
				message_type: "text",
				content: '{"text":"原文"}',
			},
		});
		await runtime.idle();
		const card = sdk.create.mock.calls
			.map(([a]) => a as { data: { msg_type: string; content: string } })
			.find((a) => a.data.msg_type === "interactive")!;
		const value = JSON.parse(card.data.content).elements[1].actions[0].value;
		const click = () =>
			sdk.feishu.get("card.action.trigger")!({
				context: { open_chat_id: "channel", open_message_id: "reply" },
				operator: { open_id: "owner" },
				action: { value },
			});
		await click();
		await vi.waitFor(() => expect(optimize).toHaveBeenCalledTimes(1));
		await runtime.handler.handleStop("channel", bot, { origin: "platform", user: "outsider" });
		expect(runtime.handler.isRunning("channel")).toBe(true);
		await runtime.handler.handleStop("channel", bot, { origin: "platform", user: "owner" });
		await runtime.idle();
		expect(runtime.handler.isRunning("channel")).toBe(false);
		await click();
		await runtime.idle();
		expect(optimize).toHaveBeenCalledTimes(1);
		expect(provider.state.callCount).toBe(1);
	} finally {
		await runtime.shutdown();
		provider.unregister();
	}
});
