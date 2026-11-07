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
import { type Context, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentRunResult, createAgentRunner } from "../src/agent.js";
import { loadConfigForDiagnostics } from "../src/config.js";
import { DurableInbox } from "../src/durable-inbox.js";
import { FeishuBot } from "../src/feishu.js";
import { GoalStore } from "../src/goals/store.js";
import { createPromptRewriter } from "../src/prompt-input.js";
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
	feishu: new Map<string, (e: unknown) => Promise<unknown>>(),
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
	patchCard: vi.fn(async (_args: unknown) => ({ code: 0 })),
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
		register(entries: Record<string, (e: unknown) => Promise<unknown>>) {
			for (const [name, fn] of Object.entries(entries)) sdk.feishu.set(name, fn);
			return this;
		}
	},
	Client: class {
		request = async () => ({ bot: { open_id: "BOT" } });
		im = {
			v1: {
				chat: { list: async () => ({ code: 0, data: { items: [] } }) },
				message: {
					create: sdk.create,
					update: sdk.edit,
					patch: sdk.patchCard,
					delete: sdk.recall,
					reply: sdk.reply,
				},
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
	sdk.patchCard.mockResolvedValue({ code: 0 });
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

const suggestion = (prompt: string) => ({
	taskType: "analysis",
	prompt,
	changes: ["明确任务与输出要求"],
	assumptions: [],
	openQuestions: [],
});
type ComposerValue = { action: string; draftId: string; optimize: boolean };
function formAction(optimize: boolean): ComposerValue {
	const request = sdk.create.mock.calls
		.map(([value]) => value as { data: { msg_type: string; content: string } })
		.filter((value) => value.data.msg_type === "interactive")
		.at(-1);
	if (!request) throw new Error("No form");
	const card = JSON.parse(request.data.content) as {
		body: { elements: Array<{ tag: string; elements?: Array<{ behaviors?: Array<{ value: ComposerValue }> }> }> };
	};
	const button = card.body.elements
		.find((value) => value.tag === "form")
		?.elements?.find((value) => value.behaviors?.[0]?.value.optimize === optimize);
	if (!button?.behaviors?.[0]) throw new Error("No submit mode");
	return button.behaviors[0].value;
}
it("renders a before-send form and durably admits only validated explicit submissions", async () => {
	const { bot, run, inbox } = fixture("feishu");
	await bot.start();
	if (!(bot instanceof FeishuBot)) throw new Error("fixture");
	await bot.postPromptComposerCard("channel", "a".repeat(64), "prefill");
	expect(JSON.stringify(sdk.create.mock.calls)).toContain("form_action_type");
	expect(JSON.stringify(sdk.create.mock.calls)).toContain("multiline_text");
	expect(JSON.stringify(sdk.create.mock.calls)).toContain("优化并预览");
	expect(JSON.stringify(sdk.create.mock.calls)).toContain("每张表单仅提交一次");
	expect(JSON.stringify(sdk.create.mock.calls)).not.toContain("扩写");
	const value = formAction(false);
	const emit = (overrides: Record<string, unknown> = {}) =>
		sdk.feishu.get("card.action.trigger")!({
			context: { open_chat_id: "channel", open_message_id: "reply" },
			operator: { open_id: "owner" },
			action: { value, form_value: { prompt_input: "  original input  " } },
			...overrides,
		});
	const retired = await sdk.feishu.get("card.action.trigger")!({
		action: { value: { action: "prompt_optimize", draftId: "a".repeat(64) } },
	});
	expect(retired).toEqual({ toast: { type: "info", content: expect.stringContaining("/prompt") } });
	await emit({ action: { value: { ...value, optimize: "true" }, form_value: { prompt_input: "bad" } } });
	expect(run).not.toHaveBeenCalled();
	expect(await emit()).toMatchObject({ toast: { type: "info" } });
	await vi.waitFor(() => expect(inbox.list()[0]?.status).toBe("completed"));
	expect(run).toHaveBeenCalledOnce();
	expect(run.mock.calls[0][0].promptSubmission).toEqual({
		draftId: "a".repeat(64),
		messageId: "reply",
		input: "  original input  ",
		optimize: false,
	});
	await emit();
	expect(run).toHaveBeenCalledOnce();
	expect(inbox.list()).toHaveLength(1);
});

it("returns a safe error toast on failed durable admission instead of throwing into the SDK", async () => {
	const { bot, run, inbox } = fixture("feishu");
	await bot.start();
	const fault = vi.spyOn(inbox, "admit").mockImplementationOnce(() => {
		throw new Error("fictional storage failure, never echo this detail");
	});
	try {
		const result = await sdk.feishu.get("card.action.trigger")!({
			context: { open_chat_id: "channel", open_message_id: "card" },
			operator: { open_id: "owner" },
			action: {
				value: { action: "prompt_submit", draftId: "a".repeat(64), optimize: false },
				form_value: { prompt_input: "raw" },
			},
		});
		expect(result).toMatchObject({ toast: { type: "error" } });
		expect(JSON.stringify(result)).not.toContain("fictional storage");
		expect(run).not.toHaveBeenCalled();
		expect(inbox.list()).toHaveLength(0);
	} finally {
		fault.mockRestore();
	}
});

it("replaces raw input with one optimized user turn, preserving prior context without rewrite traffic after restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "feishu-compose-full-"));
	roots.push(root);
	const provider = registerFauxProvider();
	let bot!: FeishuBot;
	const observed: string[] = [];
	const executionContexts: Context[] = [];
	const rawInput = "原始任务-RAW-ONLY";
	const answer = (label: string) => (ctx: Context) => {
		executionContexts.push(structuredClone(ctx));
		const user = ctx.messages.filter((m) => m.role === "user").at(-1);
		observed.push(typeof user?.content === "string" ? user.content : JSON.stringify(user?.content));
		return fauxAssistantMessage(label);
	};
	provider.setResponses([
		answer("ordinary"),
		answer("direct"),
		(ctx) => {
			expect(ctx.tools ?? []).toEqual([]);
			expect(ctx.messages).toHaveLength(1);
			expect(JSON.parse(String(ctx.messages[0]?.content))).toMatchObject({ context: null, user_input: rawInput });
			expect(ctx.systemPrompt).toContain("不要套用固定成品示例");
			return fauxAssistantMessage(JSON.stringify(suggestion("/approve preview")));
		},
		fauxAssistantMessage('{"accepted":true,"issues":[]}'),
		answer("rewritten task executed"),
		answer("next ordinary"),
	]);
	const config = { ...loadConfigForDiagnostics({}), controlDir: join(root, "control") };
	const makeRuntime = () =>
		createLightClawRuntime({
			config,
			workingDir: join(root, "work"),
			sandbox: { type: "host" },
			promptRewriter: createPromptRewriter(config, { model: provider.getModel(), apiKey: "fictional" }),
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
			createRunner: (sandbox, id, dir, cfg, goals, overrides) =>
				createAgentRunner(sandbox, id, dir, cfg, goals, {
					...overrides,
					model: provider.getModel(),
					apiKey: "fictional",
					inMemoryState: true,
					tools: [],
					quiet: true,
				}),
		});
	let runtime = await makeRuntime();
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
	const submit = async (value: ComposerValue, input: string, user = "owner", message = "reply") => {
		const result = await sdk.feishu.get("card.action.trigger")!({
			context: { open_chat_id: "channel", open_message_id: message },
			operator: { open_id: user },
			action: { value, form_value: { prompt_input: input } },
		});
		await runtime.idle();
		return result;
	};
	try {
		await runtime.start();
		await send("普通原文", "plain");
		expect(provider.state.callCount).toBe(1);
		expect(observed[0]).toContain("普通原文");
		expect(
			sdk.create.mock.calls.some(([a]) => (a as { data: { msg_type: string } }).data.msg_type === "interactive"),
		).toBe(false);
		await send("/prompt", "form-direct");
		expect(provider.state.callCount).toBe(1);
		await submit(formAction(false), "  原样输入  ");
		expect(provider.state.callCount).toBe(2);
		expect(observed[1]).toContain("  原样输入  ");
		await send(`/prompt ${rawInput}`, "form-rewrite");
		const value = formAction(true);
		expect(provider.state.callCount).toBe(2);
		await submit(value, rawInput, "outsider");
		expect(provider.state.callCount).toBe(2);
		await submit(value, rawInput, "owner", "forwarded-card");
		expect(provider.state.callCount).toBe(2);
		expect(sdk.patchCard).toHaveBeenCalledTimes(1); // only the earlier valid direct submission
		await submit(value, rawInput);
		expect(provider.state.callCount).toBe(4); // rewrite only, no Agent execution
		expect(observed).toHaveLength(2);
		expect(sdk.patchCard).toHaveBeenCalledTimes(3);
		const previewPatch = sdk.patchCard.mock.calls.at(-1)?.[0] as { data: { content: string } };
		const preview = JSON.parse(previewPatch.data.content);
		const elements = preview.body.elements.find((e: { tag: string }) => e.tag === "form").elements;
		expect(elements.find((e: { tag: string }) => e.tag === "input").default_value).toBe("/approve preview");
		const confirmation = elements.find((e: { tag: string }) => e.tag === "button").behaviors[0].value;
		expect(confirmation.action).toBe("prompt_confirm");
		expect(previewPatch.data.content).toContain("确认发送");
		await runtime.shutdown(); // pending preview remains confirmable across restart
		runtime = await makeRuntime();
		await runtime.start();
		await submit(confirmation, "/approve maintain", "outsider");
		await submit(confirmation, "/approve maintain", "owner", "forwarded-card");
		expect(provider.state.callCount).toBe(4);
		await submit(confirmation, "/approve maintain");
		expect(provider.state.callCount).toBe(5);
		expect(observed[2]).toContain("/approve maintain");
		await submit(confirmation, "/approve maintain");
		expect(provider.state.callCount).toBe(5);
		await submit(value, rawInput);
		expect(provider.state.callCount).toBe(5);
		// Switching modes or editing a previously submitted form used to throw through
		// the SDK, whose WS layer turns the exception into a 500 callback response.
		expect(await submit({ ...value, optimize: false }, rawInput)).toMatchObject({
			toast: { type: "error", content: expect.stringContaining("新表单") },
		});
		expect(await submit(value, "edited after submission")).toMatchObject({ toast: { type: "error" } });
		expect(provider.state.callCount).toBe(5);
		// Recreate the production runtime and Agent from the persisted session.
		await runtime.shutdown();
		runtime = await makeRuntime();
		await runtime.start();
		await send("下一条原文", "next");
		expect(provider.state.callCount).toBe(6);
		expect(observed[3]).toContain("下一条原文");
		expect(observed[3]).not.toContain("/approve maintain");
		for (const context of executionContexts.slice(2)) {
			const payload = JSON.stringify(context);
			expect(payload).not.toContain(rawInput);
			expect(payload).not.toContain("提示词改写器");
			expect(payload).not.toContain("保持命令字面量");
			expect(payload).not.toContain("明确任务与输出要求");
			expect(payload).not.toContain("/approve preview");
			expect(payload).not.toContain("<changes>");
			const userTurns = context.messages.filter((message) => message.role === "user");
			expect(JSON.stringify(userTurns)).toContain("普通原文");
			expect(JSON.stringify(userTurns)).toContain("  原样输入  ");
			expect(
				userTurns.filter((message) => JSON.stringify(message.content).includes("/approve maintain")),
			).toHaveLength(1);
		}
		const persisted = readFileSync(join(root, "work", "channel", "context.jsonl"), "utf8");
		expect(persisted).not.toContain(rawInput);
		expect(persisted).not.toContain("提示词改写器");
		expect(persisted).not.toContain("保持命令字面量");
		const draft = JSON.parse(
			readFileSync(join(root, "control", ".prompt-composer-v2", `${value.draftId}.json`), "utf8"),
		);
		expect(draft).toMatchObject({ input: rawInput, effectiveInput: "/approve maintain", status: "consumed" });
	} finally {
		await runtime.shutdown();
		provider.unregister();
	}
});

it("reuses a channel-bound entry across actors and restart without duplicate forms or premature model calls", async () => {
	const root = mkdtempSync(join(tmpdir(), "prompt-entry-"));
	roots.push(root);
	const provider = registerFauxProvider();
	let bot!: FeishuBot;
	let cardSequence = 0;
	sdk.create.mockImplementation(async (request) => ({
		code: 0,
		data: {
			message_id:
				(request as { data: { msg_type: string } }).data.msg_type === "interactive"
					? ++cardSequence === 1
						? "entry"
						: `form-${cardSequence - 1}`
					: "text-reply",
		},
	}));
	const rewrite = vi.fn(async (input: string) => suggestion(`优化后的任务：${input}`));
	const config = { ...loadConfigForDiagnostics({}), controlDir: join(root, "control") };
	const makeRuntime = () =>
		createLightClawRuntime({
			config,
			promptRewriter: rewrite,
			workingDir: join(root, "work"),
			sandbox: { type: "host" },
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
			createRunner: (sandbox, id, dir, cfg, goals, overrides) =>
				createAgentRunner(sandbox, id, dir, cfg, goals, {
					...overrides,
					model: provider.getModel(),
					apiKey: "fictional",
					inMemoryState: true,
					tools: [],
					quiet: true,
				}),
		});
	let runtime = await makeRuntime();
	const cards = () =>
		sdk.create.mock.calls
			.map(([request]) => request as { data: { msg_type: string; content: string } })
			.filter((r) => r.data.msg_type === "interactive");
	try {
		await runtime.start();
		await sdk.feishu.get("im.message.receive_v1")!({
			sender: { sender_id: { open_id: "owner" }, sender_type: "user" },
			message: {
				message_id: "entry-command",
				chat_id: "channel",
				chat_type: "group",
				message_type: "text",
				mentions: [{ key: "@_user_1", id: { open_id: "BOT" } }],
				content: JSON.stringify({ text: "@_user_1 任务入口" }),
			},
		});
		await runtime.idle();
		expect(cards()).toHaveLength(1);
		const entryCard = JSON.parse(cards()[0].data.content);
		expect(JSON.stringify(entryCard)).toContain("输入任务");
		const value = entryCard.body.elements.find((e: { tag: string }) => e.tag === "button").behaviors[0].value;
		const open = async (token: string | undefined, user = "owner", message = "entry", channel = "channel") => {
			await sdk.feishu.get("card.action.trigger")!({
				token,
				context: { open_chat_id: channel, open_message_id: message },
				operator: { open_id: user },
				action: { value },
			});
			await runtime.idle();
		};
		await open(undefined);
		expect(cards()).toHaveLength(1);
		await open("click-1");
		expect(cards()).toHaveLength(2);
		const ownerForm = formAction(false);
		await open("click-1");
		expect(cards()).toHaveLength(2);
		await open("click-forwarded", "owner", "forwarded");
		expect(cards()).toHaveLength(2);
		await open("click-cross", "owner", "entry", "other");
		expect(cards()).toHaveLength(2);
		await open("click-2", "other");
		expect(cards()).toHaveLength(3);
		const otherForm = formAction(false);
		expect(otherForm.draftId).not.toBe(ownerForm.draftId);
		await runtime.shutdown();
		runtime = await makeRuntime();
		await runtime.start();
		await open("click-1");
		expect(cards()).toHaveLength(3);
		await open("click-3");
		expect(cards()).toHaveLength(4);
		expect(formAction(false).draftId).not.toBe(ownerForm.draftId);
		const drafts = readdirSync(join(root, "control", ".prompt-composer-v2")).map((f) =>
			JSON.parse(readFileSync(join(root, "control", ".prompt-composer-v2", f), "utf8")),
		);
		expect(drafts.filter((d) => d.user === "owner")).toHaveLength(2);
		expect(drafts.filter((d) => d.user === "other")).toHaveLength(1);
		expect(provider.state.callCount).toBe(0);
		const latest = formAction(false);
		const submit = async (user: string) => {
			await sdk.feishu.get("card.action.trigger")!({
				context: { open_chat_id: "channel", open_message_id: "form-3" },
				operator: { open_id: user },
				action: { value: latest, form_value: { prompt_input: "入口任务" } },
			});
			await runtime.idle();
		};
		await submit("other");
		expect(provider.state.callCount).toBe(0);
		provider.setResponses([
			(ctx) => {
				const payload = JSON.stringify(ctx.messages);
				expect(payload).toContain("入口任务");
				expect(payload).not.toContain("任务入口");
				expect(payload).not.toContain("prompt_open");
				return fauxAssistantMessage("入口任务已处理");
			},
			fauxAssistantMessage("优化一已处理"),
			fauxAssistantMessage("优化二已处理"),
		]);
		await submit("owner");
		expect(provider.state.callCount).toBe(1);
		await submit("owner");
		expect(provider.state.callCount).toBe(1);
		const ids = new Set<string>();
		for (const token of ["click-4", "click-5"]) {
			await open(token);
			const form = formAction(true);
			ids.add(form.draftId);
			await sdk.feishu.get("card.action.trigger")!({
				context: { open_chat_id: "channel", open_message_id: `form-${cards().length - 1}` },
				operator: { open_id: "owner" },
				action: { value: form, form_value: { prompt_input: "再次优化" } },
			});
			await runtime.idle();
			expect(provider.state.callCount).toBe(token === "click-4" ? 1 : 2);
			const previewPatch = sdk.patchCard.mock.calls.at(-1)?.[0] as { data: { content: string } };
			const preview = JSON.parse(previewPatch.data.content);
			const confirmation = preview.body.elements
				.find((e: { tag: string }) => e.tag === "form")
				.elements.find((e: { tag: string }) => e.tag === "button").behaviors[0].value;
			await sdk.feishu.get("card.action.trigger")!({
				context: { open_chat_id: "channel", open_message_id: `form-${cards().length - 1}` },
				operator: { open_id: "owner" },
				action: { value: confirmation, form_value: { prompt_input: "修改后任务" } },
			});
			await runtime.idle();
		}
		expect(ids.size).toBe(2);
		expect(rewrite).toHaveBeenCalledTimes(2);
		expect(provider.state.callCount).toBe(3);
		expect(sdk.patchCard).toHaveBeenCalledTimes(7);
		for (const [patch] of sdk.patchCard.mock.calls)
			expect((patch as { path: { message_id: string } }).path.message_id).not.toBe("entry");
	} finally {
		await runtime.shutdown();
		provider.unregister();
	}
});

it.each(["timeout", "format", "service", "close_failure", "close_cancel", "preview_failure"] as const)(
	"closes a claimed form and reports a safe outcome without replay: %s",
	async (scenario) => {
		const root = mkdtempSync(join(tmpdir(), "prompt-outcome-"));
		roots.push(root);
		const provider = registerFauxProvider();
		let bot!: FeishuBot;
		const rewrite = vi.fn(async (_input: string, signal: AbortSignal) => {
			if (scenario === "timeout")
				return new Promise<never>((_, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
				);
			if (scenario === "format") throw new Error("提示词改写输出格式无效");
			if (scenario === "service") throw new Error("fictional-private-provider-detail");
			return suggestion("有效任务");
		});
		let finishClose: ((result: { code: number }) => void) | undefined;
		if (scenario === "close_failure") sdk.patchCard.mockResolvedValueOnce({ code: 123 });
		if (scenario === "preview_failure")
			sdk.patchCard.mockResolvedValueOnce({ code: 0 }).mockResolvedValueOnce({ code: 123 });
		if (scenario === "close_cancel")
			sdk.patchCard.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishClose = resolve;
					}),
			);
		provider.setResponses([fauxAssistantMessage("任务已处理")]);
		const runtime = await createLightClawRuntime({
			config: { ...loadConfigForDiagnostics({}), controlDir: join(root, "control"), modelAttemptTimeoutMs: 50 },
			workingDir: join(root, "work"),
			sandbox: { type: "host" },
			promptRewriter: rewrite,
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
					inMemoryState: true,
					tools: [],
					quiet: true,
				}),
		});
		try {
			await runtime.start();
			await sdk.feishu.get("im.message.receive_v1")!({
				sender: { sender_id: { open_id: "owner" } },
				message: {
					message_id: "outcome-form",
					chat_id: "channel",
					chat_type: "p2p",
					message_type: "text",
					content: JSON.stringify({ text: "/prompt" }),
				},
			});
			await runtime.idle();
			const value = formAction(true);
			const click = () =>
				sdk.feishu.get("card.action.trigger")!({
					context: { open_chat_id: "channel", open_message_id: "reply" },
					operator: { open_id: "owner" },
					action: { value, form_value: { prompt_input: "raw" } },
				});
			await click();
			if (scenario === "close_cancel") {
				await vi.waitFor(() => expect(sdk.patchCard).toHaveBeenCalledOnce());
				await runtime.handler.handleStop("channel", bot, { origin: "platform", user: "owner" });
				finishClose?.({ code: 0 });
			}
			await runtime.idle();
			await click();
			await runtime.idle();
			expect(rewrite).toHaveBeenCalledTimes(scenario === "close_cancel" ? 0 : 1);
			expect(provider.state.callCount).toBe(0);
			const text = JSON.stringify(sdk.create.mock.calls);
			expect(text).not.toContain("payload omitted");
			expect(text).not.toContain("fictional-private");
			const draft = JSON.parse(
				readFileSync(join(root, "control", ".prompt-composer-v2", `${value.draftId}.json`), "utf8"),
			);
			if (scenario === "close_failure") {
				expect(draft.status).toBe("preview");
				expect(sdk.patchCard).toHaveBeenCalledTimes(2);
			} else {
				expect(draft.status).toBe("failed");
				expect(draft.failureCode).toBe(
					scenario === "service" || scenario === "preview_failure"
						? "failed"
						: scenario === "close_cancel"
							? "cancelled"
							: scenario,
				);
				expect(sdk.patchCard).toHaveBeenCalledTimes(scenario === "preview_failure" ? 3 : 2);
				if (scenario === "timeout") expect(text).toContain("优化超时");
			}
		} finally {
			await runtime.shutdown();
			provider.unregister();
		}
	},
);

it("lets only the creator cancel a pending form rewrite and never executes its task or retries it", async () => {
	const root = mkdtempSync(join(tmpdir(), "feishu-compose-stop-"));
	roots.push(root);
	const provider = registerFauxProvider();
	let bot!: FeishuBot;
	let rejectPending: ((error: Error) => void) | undefined;
	const rewrite = vi.fn(
		(_input: string, signal: AbortSignal) =>
			new Promise<never>((_resolve, reject) => {
				rejectPending = reject;
				signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
			}),
	);
	const runtime = await createLightClawRuntime({
		config: { ...loadConfigForDiagnostics({}), controlDir: join(root, "control") },
		workingDir: join(root, "work"),
		sandbox: { type: "host" },
		promptRewriter: rewrite,
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
		createRunner: (sandbox, id, dir, cfg, goals, overrides) =>
			createAgentRunner(sandbox, id, dir, cfg, goals, {
				...overrides,
				model: provider.getModel(),
				apiKey: "fictional",
				inMemoryState: true,
				tools: [],
				quiet: true,
			}),
	});
	try {
		await runtime.start();
		await sdk.feishu.get("im.message.receive_v1")!({
			sender: { sender_id: { open_id: "owner" } },
			message: {
				message_id: "open-form",
				chat_id: "channel",
				chat_type: "p2p",
				message_type: "text",
				content: '{"text":"/prompt"}',
			},
		});
		await runtime.idle();
		const value = formAction(true);
		const click = () =>
			sdk.feishu.get("card.action.trigger")!({
				context: { open_chat_id: "channel", open_message_id: "reply" },
				operator: { open_id: "owner" },
				action: { value, form_value: { prompt_input: "原文" } },
			});
		await click();
		await vi.waitFor(() => expect(rewrite).toHaveBeenCalledOnce());
		expect(sdk.patchCard).toHaveBeenCalledTimes(1);
		await runtime.handler.handleEvent(
			{
				origin: "platform",
				type: "dm",
				channel: "channel",
				user: "outsider",
				ts: "concurrent-submission",
				text: "",
				promptSubmission: { draftId: value.draftId, messageId: "reply", input: "foreign", optimize: true },
			},
			bot,
		);
		expect(runtime.handler.isRunning("channel")).toBe(true);
		await runtime.handler.handleStop("channel", bot, { origin: "platform", user: "outsider" });
		expect(runtime.handler.isRunning("channel")).toBe(true);
		await runtime.handler.handleStop("channel", bot, { origin: "platform", user: "owner" });
		await runtime.idle();
		expect(runtime.handler.isRunning("channel")).toBe(false);
		await click();
		await runtime.idle();
		expect(rewrite).toHaveBeenCalledOnce();
		expect(provider.state.callCount).toBe(0);
		const messages = sdk.create.mock.calls
			.map(([request]) => (request as { data: { content: string } }).data.content)
			.join("\n");
		expect(messages).toContain("已取消");
		expect(messages).not.toContain("payload omitted");
		expect(sdk.patchCard).toHaveBeenCalledTimes(2);
		const failed = sdk.patchCard.mock.calls[1]?.[0] as { data: { content: string } };
		expect(failed.data.content).not.toContain("form_action_type");
		expect(failed.data.content).toContain("未执行");
		const draft = JSON.parse(
			readFileSync(join(root, "control", ".prompt-composer-v2", `${value.draftId}.json`), "utf8"),
		);
		expect(draft.failureCode).toBe("cancelled");
	} finally {
		rejectPending?.(new Error("cleanup"));
		await runtime.shutdown();
		provider.unregister();
	}
});

it("passes SDK group mention text to the production queue without the bot invocation token", async () => {
	const f = fixture("feishu");
	await f.bot.start();
	await sdk.feishu.get("im.message.receive_v1")!({
		sender: { sender_id: { open_id: "owner" } },
		message: {
			message_id: "sdk-key-regression",
			chat_id: "channel",
			chat_type: "group",
			message_type: "text",
			content: JSON.stringify({ text: "@_user_1 只回复 AGENT-fixed。 @_user_10" }),
			mentions: [
				{ key: "@_user_1", id: { open_id: "BOT" }, name: "Bot" },
				{ key: "@_user_10", id: { open_id: "OTHER" }, name: "Other" },
			],
		},
	});
	await vi.waitFor(() => expect(f.inbox.list()[0]?.status).toBe("completed"));
	expect(f.run).toHaveBeenCalledOnce();
	expect(f.run.mock.calls[0]?.[0].text).toBe("只回复 AGENT-fixed。 @_user_10");
	expect(f.inbox.list()[0]?.status).toBe("completed");
});

it("renders long previews in bounded editable parts and admits only lossless valid confirmations", async () => {
	const { bot, run, inbox } = fixture("feishu");
	await bot.start();
	if (!(bot instanceof FeishuBot)) throw new Error("fixture");
	const maximum = `${"x".repeat(999)}😀${"x".repeat(10999)}`;
	await bot.showPromptPreviewCard("channel", "card", "a".repeat(64), maximum);
	const maxRequest = sdk.patchCard.mock.calls.at(-1)?.[0] as { data: { content: string } };
	const maxCard = JSON.parse(maxRequest.data.content);
	const maxInputs = maxCard.body.elements
		.find((e: { tag: string }) => e.tag === "form")
		.elements.filter((e: { tag: string }) => e.tag === "input") as Array<{ default_value: string }>;
	expect(maxInputs).toHaveLength(13);
	expect(maxInputs.map((i) => i.default_value).join("")).toBe(maximum);
	await expect(bot.showPromptPreviewCard("channel", "card", "a".repeat(64), "x".repeat(12001))).rejects.toThrow();
	const text = `${"x".repeat(999)}😀\nsecond segment  `;
	await bot.showPromptPreviewCard("channel", "card", "a".repeat(64), text);
	const request = sdk.patchCard.mock.calls.at(-1)?.[0] as { data: { content: string } };
	const card = JSON.parse(request.data.content);
	const elements = card.body.elements.find((e: { tag: string }) => e.tag === "form").elements;
	const inputs = elements.filter((e: { tag: string }) => e.tag === "input") as Array<{
		name: string;
		default_value: string;
		max_length: number;
	}>;
	expect(inputs).toHaveLength(2);
	expect(inputs.map((i) => i.default_value).join("")).toBe(text);
	expect(inputs[0].default_value).toBe("x".repeat(999));
	expect(inputs[1].default_value).toBe("😀\nsecond segment  ");
	expect(inputs.every((i) => i.default_value.length <= i.max_length && i.max_length === 1000)).toBe(true);
	const value = elements.find((e: { tag: string }) => e.tag === "button").behaviors[0].value;
	const fields = Object.fromEntries(inputs.map((i) => [i.name, i.default_value]));
	const emit = async (form: Record<string, unknown>, count: unknown = value.inputParts) => {
		const result = await sdk.feishu.get("card.action.trigger")!({
			context: { open_chat_id: "channel", open_message_id: "card" },
			operator: { open_id: "owner" },
			action: { value: { ...value, inputParts: count }, form_value: form },
		});
		return result;
	};
	await emit({ prompt_input: "missing part" });
	await emit({ ...fields, prompt_input: "x".repeat(1001) });
	await emit({ ...fields, prompt_input_2: 123 });
	await emit(fields, 14);
	await emit(fields, 1.5);
	await emit({ prompt_input: " ", prompt_input_2: "" });
	expect(run).not.toHaveBeenCalled();
	expect(await emit(fields)).toMatchObject({ toast: { type: "info" } });
	await vi.waitFor(() => expect(inbox.list()[0]?.status).toBe("completed"));
	expect(run).toHaveBeenCalledOnce();
	expect(run.mock.calls[0][0].promptConfirmation).toEqual({ draftId: "a".repeat(64), messageId: "card", input: text });
	expect(run.mock.calls[0][0].text).toBe("");
	await emit(fields);
	expect(run).toHaveBeenCalledOnce();
});

it.each(["expired", "busy", "goal_active"] as const)(
	"rechecks %s at confirmation without executing the preview",
	async (scenario) => {
		const root = mkdtempSync(join(tmpdir(), "prompt-confirm-recheck-"));
		roots.push(root);
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const result: AgentRunResult = {
			stopReason: "stop",
			durationMs: 0,
			toolCalls: 0,
			verificationCommandCount: 0,
			toolErrors: 0,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
		};
		const run = vi.fn(async () => {
			await pending;
			return result;
		});
		let bot!: FeishuBot;
		const config = { ...loadConfigForDiagnostics({}), controlDir: join(root, "control") };
		const rewrite = vi.fn(async () => suggestion("optimized preview"));
		const runtime = await createLightClawRuntime({
			config,
			workingDir: join(root, "work"),
			sandbox: { type: "host" },
			promptRewriter: rewrite,
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
			createRunner: () => ({ run, abort: release, dispose: () => {} }),
		});
		let busy: Promise<void> | undefined;
		try {
			await runtime.start();
			const event: ChatEvent = {
				origin: "platform",
				type: "dm",
				channel: "channel",
				user: "owner",
				ts: "form",
				text: "/prompt",
			};
			await runtime.handler.handleEvent(event, bot);
			const form = formAction(true);
			await runtime.handler.handleEvent(
				{
					...event,
					ts: "rewrite",
					text: "",
					promptSubmission: { draftId: form.draftId, messageId: "reply", input: "raw", optimize: true },
				},
				bot,
			);
			expect(run).not.toHaveBeenCalled();
			const path = join(root, "control", ".prompt-composer-v2", `${form.draftId}.json`);
			expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("preview");
			if (scenario === "expired") {
				const draft = JSON.parse(readFileSync(path, "utf8"));
				writeFileSync(path, JSON.stringify({ ...draft, expiresAt: Date.now() - 1 }));
			} else if (scenario === "goal_active") {
				const goals = new GoalStore({
					channelDir: join(root, "work", "channel"),
					controlChannelDir: join(root, "control", "channel"),
					limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
				});
				await goals.create(
					{ objective: "ongoing goal", ownerUserId: "owner", acceptance: { mode: "manual" } },
					new AbortController().signal,
				);
			} else {
				busy = runtime.handler.handleEvent({ ...event, ts: "busy", text: "another task" }, bot);
				await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
			}
			await runtime.handler.handleEvent(
				{
					...event,
					ts: "confirm",
					text: "",
					promptConfirmation: { draftId: form.draftId, messageId: "reply", input: "edited final" },
				},
				bot,
			);
			expect(run).toHaveBeenCalledTimes(scenario === "busy" ? 1 : 0);
			expect(rewrite).toHaveBeenCalledOnce();
			expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("preview");
			const feedback = JSON.stringify(sdk.create.mock.calls);
			expect(feedback).toContain(
				scenario === "expired" ? "过期" : scenario === "busy" ? "频道正在处理" : "暂停当前长期目标",
			);
		} finally {
			release();
			await busy;
			await runtime.shutdown();
		}
	},
);

it.each([
	[
		"帮我调研一下现在有哪些 agent 提示词自动优化的方法，整理一下",
		"帮我调研一下现在有哪些 agent 提示词自动优化的方法，整理一下。",
		"仅调整了标点或空白",
	],
	["只回复 OK。", "只回复 OK。", "模型返回了原文"],
] as const)("labels non-substantive rewrite previews honestly: %s", async (original, rewritten, notice) => {
	const { bot } = fixture("feishu");
	if (!(bot instanceof FeishuBot)) throw new Error("fixture");
	await bot.showPromptPreviewCard("channel", "card", "a".repeat(64), rewritten, original);
	const request = sdk.patchCard.mock.calls.at(-1)?.[0] as { data: { content: string } };
	const card = JSON.parse(request.data.content);
	expect(card.body.elements[0].content).toContain(notice);
	expect(card.body.elements[0].content).not.toContain("已优化");
	const form = card.body.elements.find((e: { tag: string }) => e.tag === "form");
	expect(form.elements.find((e: { tag: string }) => e.tag === "input").default_value).toBe(rewritten);
	expect(form.elements.find((e: { tag: string }) => e.tag === "button").text.content).toBe("确认发送");
});

it("shows rewrite explanations outside the editable task as literal text", async () => {
	const { bot } = fixture("feishu");
	if (!(bot instanceof FeishuBot)) throw new Error("fixture");
	const details = {
		taskType: "contextual",
		prompt: "请检查上述问题",
		changes: ["保留指代，不编造背景"],
		assumptions: ["尚未提供背景"],
		openQuestions: ["<at id=all>上述内容指什么？"],
	};
	await bot.showPromptPreviewCard("channel", "card", "a".repeat(64), details.prompt, "看看上面的问题", details);
	const request = sdk.patchCard.mock.calls.at(-1)?.[0] as { data: { content: string } };
	const card = JSON.parse(request.data.content);
	const explanation = card.body.elements.find(
		(e: { tag: string; text?: { tag: string } }) => e.text?.tag === "plain_text",
	);
	expect(explanation.text.content).toContain("保留指代");
	expect(explanation.text.content).toContain("尚未提供背景");
	expect(explanation.text.content).toContain("上述内容指什么");
	const form = card.body.elements.find((e: { tag: string }) => e.tag === "form");
	expect(form.elements.find((e: { tag: string }) => e.tag === "input").default_value).toBe(details.prompt);
});
