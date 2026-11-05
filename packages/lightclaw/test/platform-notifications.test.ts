import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAuditDirectory } from "../src/audit/storage.js";
import { DurableInbox } from "../src/durable-inbox.js";
import { FeishuBot } from "../src/feishu.js";
import { GoalStore } from "../src/goals/store.js";
import { observePlatformOperation } from "../src/platform-operations.js";
import { SlackBot } from "../src/slack.js";
import { ChannelStore } from "../src/store.js";
import type { ChatEvent, ChatHandler } from "../src/transport.js";

type SocketCallback = (input: {
	event: { channel: string; ts: string; user: string; text: string; channel_type: string };
	ack: () => void;
}) => void;
const socket = vi.hoisted(() => ({ callbacks: new Map<string, SocketCallback>() }));
vi.mock("@slack/socket-mode", () => ({
	SocketModeClient: class {
		on(name: string, callback: SocketCallback) {
			socket.callbacks.set(name, callback);
		}
	},
}));
vi.mock("@slack/web-api", () => ({ WebClient: class {} }));
vi.mock("@larksuiteoapi/node-sdk", () => ({
	Client: class {},
	WSClient: class {},
	Domain: { Feishu: "feishu" },
	LoggerLevel: { info: "info" },
	defaultHttpInstance: { request: vi.fn() },
}));

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0)) cleanup();
	socket.callbacks.clear();
});

describe("platform immediate notification boundaries", () => {
	it("bounds a hanging notification and observes its late rejection", async () => {
		vi.useFakeTimers();
		const directory = mkdtempSync(join(tmpdir(), "lightclaw-notice-deadline-"));
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
		let reject!: (error: Error) => void;
		const hanging = new Promise<void>((_resolve, fail) => {
			reject = fail;
		});
		const operation = vi.fn(() => hanging);
		let settled = false;
		const pending = observePlatformOperation(operation, directory, "channel", 20, "busy").then(() => {
			settled = true;
		});
		expect(operation).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(21);
		expect(settled).toBe(true);
		await pending;
		expect(readFileSync(join(resolveAuditDirectory(directory), "runs.jsonl"), "utf8")).toContain(
			"timed out after 20ms",
		);
		reject(new Error("late rejection"));
		await Promise.resolve();
		await expect(
			observePlatformOperation(async () => "next", directory, "channel", 20, "next"),
		).resolves.toBeUndefined();
	});
	it("contains synchronous operation and audit write failures", async () => {
		const directory = mkdtempSync(join(tmpdir(), "lightclaw-notice-audit-"));
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
		mkdirSync(resolveAuditDirectory(directory), { recursive: true });
		rmSync(resolveAuditDirectory(directory), { recursive: true });
		writeFileSync(resolveAuditDirectory(directory), "blocked directory");
		await expect(
			observePlatformOperation(
				() => {
					throw new Error("synchronous SDK failure");
				},
				directory,
				"channel",
				20,
				"stop",
			),
		).resolves.toBeUndefined();
	});
	it.each([
		"mention-busy",
		"dm-busy",
		"mention-idle-stop",
		"dm-idle-stop",
		"mention-running-stop",
		"dm-running-stop",
		"feishu-idle-stop",
		"feishu-running-stop",
	])("observes rejection and permits the next event: %s", async (branch) => {
		const directory = mkdtempSync(join(tmpdir(), "lightclaw-platform-notice-"));
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
		const running = branch.includes("busy") || branch.includes("running-stop");
		const stop = vi.fn(async (): Promise<void> => {
			throw new Error("stop boundary rejected");
		});
		const handler: ChatHandler = {
			isRunning: () => running,
			handleStop: stop,
			handleEvent: async () => {},
			handleQueueFailure: async () => {},
		};
		const config = {
			appToken: "unused",
			botToken: "unused",
			appId: "unused",
			appSecret: "unused",
			workingDir: directory,
			store: new ChannelStore({ workingDir: directory }),
			platformTimeoutMs: 20,
		};
		const bot = branch.startsWith("feishu") ? new FeishuBot(handler, config) : new SlackBot(handler, config);
		const post = vi.spyOn(bot, "postMessage").mockRejectedValue(new Error("rate limited notification"));
		const hooks = bot as unknown as {
			setupEventHandlers(): void;
			onMessage(data: unknown): void;
			queues: { close(): void };
		};
		cleanups.push(() => hooks.queues.close());
		const ack = vi.fn();
		const dispatch = (ts: string) => {
			if (branch.startsWith("feishu"))
				hooks.onMessage({
					sender: { sender_id: { open_id: "user" } },
					message: {
						message_id: ts,
						chat_id: "channel",
						chat_type: "p2p",
						message_type: "text",
						content: JSON.stringify({ text: "stop" }),
					},
				});
			else {
				const callback = socket.callbacks.get(branch.startsWith("dm") ? "message" : "app_mention");
				if (!callback) throw new Error("missing socket callback");
				callback({
					event: {
						channel: "channel",
						ts,
						user: "user",
						text: branch.includes("stop") ? "stop" : "task",
						channel_type: "im",
					},
					ack,
				});
			}
		};
		if (!branch.startsWith("feishu")) hooks.setupEventHandlers();
		dispatch("1");
		await vi.waitFor(
			() => {
				const audit = readFileSync(join(resolveAuditDirectory(directory), "runs.jsonl"), "utf8");
				expect(audit).toContain('"type":"delivery_failed"');
				expect(audit).toContain(
					branch.includes("running-stop") ? "stop boundary rejected" : "rate limited notification",
				);
			},
			{ timeout: 300, interval: 5 },
		);
		post.mockResolvedValue("reply");
		stop.mockResolvedValue(undefined);
		dispatch("2");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(branch.includes("running-stop") ? stop : post).toHaveBeenCalledTimes(2);
		if (!branch.startsWith("feishu")) expect(ack).toHaveBeenCalledTimes(2);
	});
});

it.each(["slack-dm", "slack-mention", "feishu"])(
	"routes pause/cancel immediately during pending verification: %s",
	async (platform) => {
		const directory = mkdtempSync(join(tmpdir(), "goal-control-platform-"));
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
		const channelDir = join(directory, "work", "channel");
		mkdirSync(channelDir, { recursive: true });
		const store = new GoalStore({
			channelDir,
			controlChannelDir: join(directory, "control", "channel"),
			limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
		});
		await store.create(
			{
				objective: "check",
				ownerUserId: "user",
				acceptance: { mode: "automatic", files: [], commands: [{ command: "check", sourcePaths: ["source"] }] },
			},
			new AbortController().signal,
		);
		writeFileSync(join(channelDir, "source"), "abc");
		const controller = new AbortController();
		let release!: () => void;
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = store.requestCompletion(
			{ summary: "done", evidence: ["claim"] },
			{
				channelDir,
				sandbox: { type: "docker", container: "mock" },
				signal: controller.signal,
				assertActive: () => controller.signal.throwIfAborted(),
				reserveCommand: () => ({ timeoutSeconds: 1 }),
				executor: {
					getWorkspacePath: () => "/workspace",
					exec: async () => {
						entered();
						await gate;
						return { code: 0, stdout: "", stderr: "" };
					},
				},
			},
		);
		await ready;
		const handle = vi.fn(async (event: ChatEvent) => {
			expect(event.origin).toBe("platform");
			controller.abort();
			if (event.text === "/goal cancel") store.cancel();
			else store.pause();
		});
		const handler: ChatHandler = {
			isRunning: () => true,
			handleStop: async () => {},
			handleQueueFailure: async () => {},
			handleEvent: handle,
		};
		const config = {
			appToken: "unused",
			botToken: "unused",
			appId: "unused",
			appSecret: "unused",
			workingDir: join(directory, "work"),
			store: new ChannelStore({ workingDir: join(directory, "work") }),
		};
		const bot = platform === "feishu" ? new FeishuBot(handler, config) : new SlackBot(handler, config);
		vi.spyOn(bot, "postMessage").mockResolvedValue("message");
		const hooks = bot as unknown as {
			setupEventHandlers(): void;
			onMessage(data: unknown): void;
			queues: { close(): void };
			getQueue(channel: string): { enqueue(operation: () => Promise<void>): void };
		};
		cleanups.push(() => hooks.queues.close());
		const text = platform === "feishu" ? "/goal cancel" : "/goal pause";
		if (platform === "feishu") {
			let started!: () => void;
			const queueReady = new Promise<void>((resolve) => {
				started = resolve;
			});
			hooks.getQueue("channel").enqueue(async () => {
				started();
				await gate;
			});
			await queueReady;
		}
		try {
			if (platform === "feishu")
				hooks.onMessage({
					sender: { sender_id: { open_id: "user" } },
					message: {
						message_id: "control",
						chat_id: "channel",
						chat_type: "p2p",
						message_type: "text",
						content: JSON.stringify({ text }),
					},
				});
			else {
				hooks.setupEventHandlers();
				const callback = socket.callbacks.get(platform === "slack-dm" ? "message" : "app_mention");
				if (!callback) throw new Error("missing callback");
				callback({
					event: { channel: "channel", ts: String(Date.now() / 1000 + 1), user: "user", text, channel_type: "im" },
					ack: () => {},
				});
			}
			expect(handle).toHaveBeenCalledOnce();
			expect(controller.signal.aborted).toBe(true);
		} finally {
			release();
			await pending;
		}
		expect(store.get()?.status).toBe(platform === "feishu" ? "cancelled" : "paused");
	},
);

it("durable Slack mentions still interrupt active work with stop", async () => {
	const directory = mkdtempSync(join(tmpdir(), "lightclaw-durable-stop-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	let stopped = false;
	const handler: ChatHandler = {
		isRunning: () => true,
		handleStop: async () => {
			stopped = true;
		},
		handleEvent: async () => {},
		handleQueueFailure: async () => {},
	};
	const bot = new SlackBot(handler, {
		appToken: "mock",
		botToken: "mock",
		workingDir: directory,
		store: new ChannelStore({ workingDir: directory }),
		inbox: new DurableInbox(join(directory, "inbox")),
	});
	const hooks = bot as unknown as { setupEventHandlers(): void; queues: { close(): void } };
	cleanups.push(() => hooks.queues.close());
	hooks.setupEventHandlers();
	const callback = socket.callbacks.get("app_mention");
	if (!callback) throw new Error("missing callback");
	callback({
		event: { channel: "C1", ts: "1", user: "mock-user", text: "stop", channel_type: "channel" },
		ack: () => {},
	});
	await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 100 });
});
