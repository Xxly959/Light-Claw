import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@mariozechner/pi-ai";
import { AgentSession, SettingsManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunner, getOrCreateRunner, releaseRunner } from "../src/agent.js";
import { CriticalAuditError, resolveAuditDirectory } from "../src/audit/storage.js";
import type { LightClawConfig } from "../src/config.js";
import { FeishuBot } from "../src/feishu.js";
import { GoalStore } from "../src/goals/store.js";
import { IdleResourceCache } from "../src/idle-cache.js";
import type { SandboxConfig } from "../src/sandbox.js";
import * as sandboxModule from "../src/sandbox.js";
import { SlackBot } from "../src/slack.js";
import { ChannelStore } from "../src/store.js";
import type { ChatContext } from "../src/transport.js";

const temporaryPaths: string[] = [];
const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const provider of providers.splice(0)) provider.unregister();
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createFixture(
	channelId: string,
	sandbox: SandboxConfig = { type: "host" },
	limits: Partial<LightClawConfig> = {},
) {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "lightclaw-lifecycle-"));
	temporaryPaths.push(fixtureRoot);
	const workspace = join(fixtureRoot, "work");
	const channelDir = join(workspace, channelId);
	const provider = registerFauxProvider({ api: `faux-${channelId}`, provider: `faux-${channelId}` });
	providers.push(provider);
	const config: LightClawConfig = {
		transport: "slack",
		modelProvider: "unused",
		modelId: "unused",
		maxGoalCycles: 8,
		maxGoalFailures: 2,
		maxStaleCycles: 2,
		...limits,
	};
	const goals = new GoalStore({
		channelDir: channelDir,
		controlChannelDir: join(channelDir, "..", "..", "control", basename(channelDir)),
		limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
	});
	const runner = createAgentRunner(sandbox, channelId, channelDir, config, goals, {
		model: provider.getModel(),
		apiKey: "faux-key",
		quiet: true,
	});
	const store = new ChannelStore({ workingDir: workspace });
	return { workspace, channelDir, provider, runner, store, config, goals };
}

function createContext(channelId: string, ts = "1") {
	const messages: string[] = [];
	const uploads: Array<{ path: string; title?: string }> = [];
	const context: ChatContext = {
		message: {
			text: "share report",
			rawText: "share report",
			user: "test-user",
			channel: channelId,
			ts,
			attachments: [],
		},
		channels: [],
		users: [],
		respond: async (text) => {
			messages.push(text);
		},
		replaceMessage: async (text) => {
			messages.push(text);
		},
		respondInThread: async () => {},
		setTyping: async () => {},
		uploadFile: async (path, title) => {
			uploads.push({ path, title });
		},
		setWorking: async () => {},
		deleteMessage: async () => {},
	};
	return { context, messages, uploads };
}

describe("runner attachment isolation and lifecycle", () => {
	it("verifies real files and resets the runtime for the next run", async () => {
		const fixture = createFixture("verified-file");
		await fixture.goals.create(
			{
				objective: "write abc",
				ownerUserId: "test-user",
				acceptance: {
					mode: "automatic",
					files: [{ path: "file", changed: true, contains: ["abc"] }],
					commands: [],
				},
			},
			new AbortController().signal,
		);
		writeFileSync(join(fixture.channelDir, "file"), "abc");
		fixture.provider.setResponses([
			fauxAssistantMessage(fauxToolCall("goal_complete", { summary: "done", evidence: ["claim"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("complete"),
		]);
		const result = await fixture.runner.run(createContext("verified-file", "finish").context, fixture.store);
		expect(fixture.goals.get()?.status).toBe("completed");
		expect(result.toolErrors).toBe(0);
		fixture.provider.setResponses([fauxAssistantMessage("next task")]);
		expect(
			(await fixture.runner.run(createContext("verified-file", "again").context, fixture.store))
				.verificationCommandCount,
		).toBe(0);
	});

	it("requires owner confirmation for model completion claims", async () => {
		const fixture = createFixture("verify-manual");
		await fixture.goals.create(
			{ objective: "research", ownerUserId: "test-user", acceptance: { mode: "manual" } },
			new AbortController().signal,
		);
		fixture.provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall("goal_complete", {
					summary: "done",
					evidence: ["tests passed"],
					deliverables: { kind: "none", reason: "advice only" },
				}),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("done"),
		]);
		const result = await fixture.runner.run(createContext("verify-manual").context, fixture.store);
		expect(fixture.goals.get()?.status).toBe("awaiting_confirmation");
		expect(result.toolErrors).toBe(0);
	});
	it("cannot dispatch verifier commands after the shared tool budget is spent", async () => {
		const fixture = createFixture(
			"verify-budget",
			{ type: "docker", container: "never-call-docker" },
			{ maxRunToolCalls: 1 },
		);
		await fixture.goals.create(
			{
				objective: "test",
				ownerUserId: "test-user",
				acceptance: {
					mode: "automatic",
					files: [],
					commands: [{ command: "echo should-not-run", sourcePaths: ["source.txt"] }],
				},
			},
			new AbortController().signal,
		);
		writeFileSync(join(fixture.channelDir, "source.txt"), "source");
		fixture.provider.setResponses([
			fauxAssistantMessage(fauxToolCall("goal_complete", { summary: "done", evidence: ["passed"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const result = await fixture.runner.run(createContext("verify-budget").context, fixture.store);
		expect(result.verificationCommandCount).toBe(0);
		expect(result.budgetReason).toContain("tool");
		expect(fixture.goals.get()?.status).not.toBe("completed");
	});

	it("keeps cancellation sticky at the prompt boundary and resets it next run", async () => {
		const fixture = createFixture("prompt-stop");
		const original = AgentSession.prototype.prompt;
		vi.spyOn(AgentSession.prototype, "prompt").mockImplementationOnce(async function (
			this: AgentSession,
			text,
			options,
		) {
			fixture.runner.abort();
			return original.call(this, text, options);
		});
		fixture.provider.setResponses([fauxAssistantMessage("must not dispatch")]);
		expect((await fixture.runner.run(createContext("prompt-stop").context, fixture.store)).stopReason).toBe(
			"aborted",
		);
		expect(fixture.provider.state.callCount).toBe(0);
		fixture.provider.setResponses([fauxAssistantMessage("recovered")]);
		expect((await fixture.runner.run(createContext("prompt-stop", "2").context, fixture.store)).stopReason).toBe(
			"stop",
		);
		expect(fixture.provider.state.callCount).toBe(1);
	});
	it.each(["budget", "platform", "stop"])("cancels the Session retry delay with %s", async (reason) => {
		vi.useFakeTimers();
		const fixture = createFixture(
			"retry-deadline",
			{ type: "host" },
			{ maxRunDurationMs: reason === "budget" ? 50 : 1000, platformTimeoutMs: 30 },
		);
		const ctx = createContext("retry-deadline").context;
		if (reason === "platform") ctx.respond = async () => new Promise<void>(() => {});
		const entered = deferred();
		let session: AgentSession | undefined;
		const original = AgentSession.prototype.prompt;
		vi.spyOn(AgentSession.prototype, "prompt").mockImplementationOnce(async function (
			this: AgentSession,
			text,
			options,
		) {
			session = this;
			this.subscribe((event) => {
				if (event.type === "auto_retry_start") entered.resolve();
			});
			return original.call(this, text, options);
		});
		fixture.provider.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" }),
			fauxAssistantMessage("retry must not dispatch"),
		]);
		let settled = false;
		const pending = fixture.runner.run(ctx, fixture.store).then((result) => {
			settled = true;
			return result;
		});
		try {
			await entered.promise;
			if (reason === "stop") fixture.runner.abort();
			await vi.advanceTimersByTimeAsync(60);
			expect(settled).toBe(true);
			expect((await pending).stopReason).toBe("aborted");
			if (reason === "budget") expect((await pending).budgetReason).toContain("duration");
			if (reason === "platform") expect((await pending).deliveryError).toContain("timed out");
			expect(fixture.provider.state.callCount).toBe(1);
		} finally {
			session?.abortRetry();
			await pending;
		}
		fixture.config.maxRunDurationMs = 1000;
		fixture.provider.setResponses([fauxAssistantMessage("recovered")]);
		expect((await fixture.runner.run(createContext("retry-deadline", "2").context, fixture.store)).stopReason).toBe(
			"stop",
		);
	});
	it.each(["budget", "stop"])("cancels a pre-prompt auto-compaction with %s", async (reason) => {
		vi.useFakeTimers();
		const fixture = createFixture(`compact-${reason}`, { type: "host" }, { maxRunDurationMs: 50 });
		vi.spyOn(SettingsManager.prototype, "getCompactionSettings").mockReturnValue({
			enabled: true,
			reserveTokens: 1024,
			keepRecentTokens: 1,
		});
		const original = AgentSession.prototype.prompt;
		let session: AgentSession | undefined;
		vi.spyOn(AgentSession.prototype, "prompt").mockImplementationOnce(async function (
			this: AgentSession,
			text,
			options,
		) {
			session = this;
			const model = fixture.provider.getModel();
			const message = {
				...fauxAssistantMessage("large history"),
				provider: model.provider,
				model: model.id,
				usage: { ...fauxAssistantMessage("").usage, input: model.contextWindow },
			};
			this.sessionManager.appendMessage({ role: "user", content: "history ".repeat(100), timestamp: Date.now() });
			this.sessionManager.appendMessage(message);
			this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
			return original.call(this, text, options);
		});
		const entered = deferred();
		const release = deferred();
		let signal: AbortSignal | undefined;
		fixture.provider.setResponses([
			async (_context, options) => {
				signal = options?.signal;
				entered.resolve();
				if (!signal?.aborted)
					await Promise.race([
						release.promise,
						new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
					]);
				return fauxAssistantMessage("cancelled summary");
			},
			fauxAssistantMessage("must not dispatch after compaction"),
		]);
		let settled = false;
		const pending = fixture.runner.run(createContext(`compact-${reason}`).context, fixture.store).then((result) => {
			settled = true;
			return result;
		});
		try {
			await entered.promise;
			if (reason === "stop") fixture.runner.abort();
			await vi.advanceTimersByTimeAsync(60);
			expect(signal?.aborted).toBe(true);
			expect(settled).toBe(true);
			expect((await pending).stopReason).toBe("aborted");
			expect(fixture.provider.state.callCount).toBe(1);
		} finally {
			session?.abortCompaction();
			release.resolve();
			await pending;
		}
		vi.spyOn(SettingsManager.prototype, "getCompactionSettings").mockReturnValue({
			enabled: false,
			reserveTokens: 1024,
			keepRecentTokens: 1,
		});
		fixture.config.maxRunDurationMs = 1000;
		fixture.provider.setResponses([fauxAssistantMessage("recovered")]);
		expect(
			(await fixture.runner.run(createContext(`compact-${reason}`, "2").context, fixture.store)).stopReason,
		).toBe("stop");
	});
	it("isolates equal channel IDs in different workspaces and reloads released sessions", async () => {
		const left = createFixture("cache-left");
		const right = createFixture("cache-right");
		const options = { model: left.provider.getModel(), apiKey: "faux-key", quiet: true };
		const first = getOrCreateRunner(
			{ type: "host" },
			"same",
			left.channelDir,
			left.config,
			new GoalStore({
				channelDir: left.channelDir,
				controlChannelDir: join(left.channelDir, "..", "..", "control", basename(left.channelDir)),
				limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
			}),
			options,
		);
		const second = getOrCreateRunner(
			{ type: "host" },
			"same",
			right.channelDir,
			right.config,
			new GoalStore({
				channelDir: right.channelDir,
				controlChannelDir: join(right.channelDir, "..", "..", "control", basename(right.channelDir)),
				limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
			}),
			options,
		);
		expect(first).not.toBe(second);
		expect(
			getOrCreateRunner(
				{ type: "host" },
				"same",
				left.channelDir,
				left.config,
				new GoalStore({
					channelDir: left.channelDir,
					controlChannelDir: join(left.channelDir, "..", "..", "control", basename(left.channelDir)),
					limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
				}),
				options,
			),
		).toBe(first);
		releaseRunner(left.channelDir);
		const reloaded = getOrCreateRunner(
			{ type: "host" },
			"same",
			left.channelDir,
			left.config,
			new GoalStore({
				channelDir: left.channelDir,
				controlChannelDir: join(left.channelDir, "..", "..", "control", basename(left.channelDir)),
				limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
			}),
			options,
		);
		expect(reloaded).not.toBe(first);
		left.provider.setResponses([fauxAssistantMessage("restored")]);
		expect((await reloaded.run(createContext("same").context, left.store)).stopReason).toBe("stop");
		releaseRunner(left.channelDir);
		releaseRunner(right.channelDir);
		left.runner.dispose();
		right.runner.dispose();
	});

	it("runs 100 faux channels with bounded retention and releases all sessions", async () => {
		const fixture = createFixture("churn");
		fixture.runner.dispose();
		const dispose = vi.spyOn(AgentSession.prototype, "dispose");
		const cache = new IdleResourceCache<{ runner: ReturnType<typeof createAgentRunner>; directory: string }>(
			{ maxEntries: 8, idleTtlMs: 900000 },
			() => false,
			(entry) => releaseRunner(entry.directory),
		);
		const observations: Array<{ channels: number; retained: number; rssBytes: number; heapUsedBytes: number }> = [];
		try {
			for (let index = 0; index < 100; index++) {
				const channel = `churn-${index}`;
				const directory = join(fixture.workspace, channel);
				const entry = cache.getOrCreate(channel, () => ({
					directory,
					runner: getOrCreateRunner(
						{ type: "host" },
						channel,
						directory,
						fixture.config,
						new GoalStore({
							channelDir: directory,
							controlChannelDir: join(directory, "..", "..", "control", basename(directory)),
							limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
						}),
						{ model: fixture.provider.getModel(), apiKey: "faux-key", quiet: true },
					),
				}));
				fixture.provider.setResponses([fauxAssistantMessage("done")]);
				expect((await entry.runner.run(createContext(channel).context, fixture.store)).stopReason).toBe("stop");
				expect(cache.size).toBeLessThanOrEqual(8);
				if ((index + 1) % 10 === 0) {
					const memory = process.memoryUsage();
					observations.push({
						channels: index + 1,
						retained: cache.size,
						rssBytes: memory.rss,
						heapUsedBytes: memory.heapUsed,
					});
				}
			}
		} finally {
			cache.close();
		}
		expect(cache.size).toBe(0);
		expect(dispose).toHaveBeenCalledTimes(100);
		process.stdout.write(
			`${JSON.stringify({ diagnostic: "faux-channel-churn", created: 100, disposed: dispose.mock.calls.length, retainedAfterClose: cache.size, observations })}\n`,
		);
	});
	it("disposes an idle session once and refuses future work on the disposed runner", async () => {
		const fixture = createFixture("dispose");
		const dispose = vi.spyOn(AgentSession.prototype, "dispose");
		fixture.runner.dispose();
		fixture.runner.dispose();
		expect(dispose).toHaveBeenCalledOnce();
		await expect(fixture.runner.run(createContext("dispose").context, fixture.store)).rejects.toThrow("disposed");
	});
	it("reports a transient delivery failure while preserving successful execution and later updates", async () => {
		const fixture = createFixture("delivery-rejection");
		const ctx = createContext("delivery-rejection");
		ctx.context.respond = async () => {
			throw new Error("platform unavailable");
		};
		fixture.provider.setResponses([fauxAssistantMessage("completed response")]);
		const result = await fixture.runner.run(ctx.context, fixture.store);
		expect(result).toMatchObject({ stopReason: "stop", deliveryError: "platform unavailable" });
		expect(ctx.messages).toContain("completed response");
	});
	it("releases a run after a hanging reply without retrying an uncertain delivery", async () => {
		vi.useFakeTimers();
		const fixture = createFixture("reply-timeout", { type: "host" }, { platformTimeoutMs: 50 });
		const ctx = createContext("reply-timeout");
		const entered = deferred();
		const release = deferred();
		let sends = 0;
		ctx.context.respond = async () => {
			sends++;
			entered.resolve();
			await release.promise;
		};
		fixture.provider.setResponses([fauxAssistantMessage("saved result")]);
		let settled = false;
		const pending = fixture.runner.run(ctx.context, fixture.store).then((result) => {
			settled = true;
			return result;
		});
		try {
			await entered.promise;
			await vi.advanceTimersByTimeAsync(60);
			expect(settled).toBe(true);
			expect(await pending).toMatchObject({ deliveryError: expect.stringContaining("timed out") });
			expect(sends).toBe(1);
		} finally {
			release.resolve();
			await pending;
		}
		fixture.provider.setResponses([fauxAssistantMessage("recovered")]);
		const next = createContext("reply-timeout", "2");
		expect((await fixture.runner.run(next.context, fixture.store)).stopReason).toBe("stop");
		expect(next.messages).toContain("recovered");
	});
	it("cancels continuation after an upload timeout and resets the delivery boundary next run", async () => {
		vi.useFakeTimers();
		const fixture = createFixture("upload-timeout", { type: "host" }, { platformTimeoutMs: 50 });
		const ctx = createContext("upload-timeout");
		const entered = deferred();
		const release = deferred();
		ctx.context.uploadFile = async () => {
			entered.resolve();
			await release.promise;
		};
		fixture.provider.setResponses([
			fauxAssistantMessage(fauxToolCall("attach", { label: "upload", path: "report" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("must not continue"),
		]);
		let settled = false;
		const pending = fixture.runner.run(ctx.context, fixture.store).then((result) => {
			settled = true;
			return result;
		});
		try {
			await entered.promise;
			await vi.advanceTimersByTimeAsync(60);
			expect(settled).toBe(true);
			expect(await pending).toMatchObject({ deliveryError: expect.stringContaining("uploadFile") });
			expect(fixture.provider.state.callCount).toBe(1);
		} finally {
			release.resolve();
			await pending;
		}
		fixture.provider.setResponses([fauxAssistantMessage("upload recovered")]);
		expect((await fixture.runner.run(createContext("upload-timeout", "2").context, fixture.store)).stopReason).toBe(
			"stop",
		);
	});
	it("cancels a slow model at the run deadline and can run again", async () => {
		const fixture = createFixture("time-budget", { type: "host" }, { maxRunDurationMs: 40 });
		const first = createContext("time-budget");
		fixture.provider.setResponses([
			async (_context, options) => {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 200);
					options?.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
				});
				return fauxAssistantMessage("late response");
			},
		]);
		const result = await fixture.runner.run(first.context, fixture.store);
		expect(result.stopReason).toBe("aborted");
		expect(result.budgetReason).toContain("duration");
		fixture.config.maxRunDurationMs = 1000;
		fixture.provider.setResponses([fauxAssistantMessage("budget recovered")]);
		const next = createContext("time-budget", "2");
		expect((await fixture.runner.run(next.context, fixture.store)).stopReason).toBe("stop");
		expect(next.messages).toContain("budget recovered");
	});

	it("blocks the next tool side effect when the per-run tool quota is exhausted", async () => {
		const fixture = createFixture("tool-budget", { type: "host" }, { maxRunToolCalls: 1 });
		const ctx = createContext("tool-budget");
		fixture.provider.setResponses([
			fauxAssistantMessage(fauxToolCall("attach", { label: "first", path: "first.txt" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("attach", { label: "second", path: "second.txt" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("must not continue"),
		]);
		const result = await fixture.runner.run(ctx.context, fixture.store);
		expect(ctx.uploads).toEqual([{ path: "first.txt", title: "first.txt" }]);
		expect(result.stopReason).toBe("aborted");
		expect(result.budgetReason).toContain("tool");
		expect(fixture.provider.state.callCount).toBe(2);
	});

	it("prevents tool side effects after reported token usage exhausts the budget", async () => {
		const fixture = createFixture("token-budget", { type: "host" }, { maxRunTokens: 1 });
		const ctx = createContext("token-budget");
		fixture.provider.setResponses([
			fauxAssistantMessage(fauxToolCall("attach", { label: "blocked", path: "blocked.txt" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("must not continue"),
		]);
		const result = await fixture.runner.run(ctx.context, fixture.store);
		expect(ctx.uploads).toEqual([]);
		expect(result.stopReason).toBe("aborted");
		expect(result.budgetReason).toContain("token");
		expect(fixture.provider.state.callCount).toBe(1);
	});

	it("routes interleaved channel uploads to their own contexts", async () => {
		const a = createFixture("channel-a");
		const b = createFixture("channel-b");
		const ctxA = createContext("channel-a");
		const ctxB = createContext("channel-b");
		const enteredA = deferred();
		const enteredB = deferred();
		const releaseA = deferred();
		const releaseB = deferred();
		a.provider.setResponses([
			async () => {
				enteredA.resolve();
				await releaseA.promise;
				return fauxAssistantMessage(fauxToolCall("attach", { label: "A report", path: "channel-a.txt" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("A delivered"),
		]);
		b.provider.setResponses([
			async () => {
				enteredB.resolve();
				await releaseB.promise;
				return fauxAssistantMessage(fauxToolCall("attach", { label: "B report", path: "channel-b.txt" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("B delivered"),
		]);
		const runA = a.runner.run(ctxA.context, a.store);
		await enteredA.promise;
		const runB = b.runner.run(ctxB.context, b.store);
		try {
			await enteredB.promise;
			releaseA.resolve();
			expect((await runA).toolErrors).toBe(0);
			releaseB.resolve();
			expect((await runB).toolErrors).toBe(0);
			expect(ctxA.uploads).toEqual([{ path: "channel-a.txt", title: "channel-a.txt" }]);
			expect(ctxB.uploads).toEqual([{ path: "channel-b.txt", title: "channel-b.txt" }]);
		} finally {
			releaseA.resolve();
			releaseB.resolve();
			await Promise.allSettled([runA, runB]);
		}
	});

	it("rejects reentry without replacing the active channel context", async () => {
		const fixture = createFixture("reentry");
		const first = createContext("reentry");
		const second = createContext("reentry", "2");
		const entered = deferred();
		const release = deferred();
		fixture.provider.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage(fauxToolCall("attach", { label: "report", path: "first.txt" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("first delivered"),
		]);
		const firstRun = fixture.runner.run(first.context, fixture.store);
		try {
			await entered.promise;
			await expect(fixture.runner.run(second.context, fixture.store)).rejects.toThrow();
			release.resolve();
			expect((await firstRun).toolErrors).toBe(0);
			expect(first.uploads).toEqual([{ path: "first.txt", title: "first.txt" }]);
			expect(second.uploads).toEqual([]);
			expect(second.messages).toEqual([]);
		} finally {
			release.resolve();
			await Promise.allSettled([firstRun]);
		}
	});

	it("drains queued replies and releases the upload context when prompting throws", async () => {
		const fixture = createFixture("recovery");
		const first = createContext("recovery");
		const second = createContext("recovery", "2");
		const replyStarted = deferred();
		const releaseReply = deferred();
		first.context.respond = async (text) => {
			replyStarted.resolve();
			await releaseReply.promise;
			first.messages.push(text);
		};
		fixture.provider.setResponses([
			fauxAssistantMessage("queued reply"),
			fauxAssistantMessage(fauxToolCall("attach", { label: "new report", path: "new.txt" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("recovered"),
		]);
		const originalPrompt = AgentSession.prototype.prompt;
		let capturedAttach: AgentTool | undefined;
		vi.spyOn(AgentSession.prototype, "prompt").mockImplementationOnce(async function (
			this: AgentSession,
			text,
			options,
		) {
			capturedAttach = this.agent.state.tools.find((tool) => tool.name === "attach");
			await originalPrompt.call(this, text, options);
			throw new Error("injected prompt failure");
		});
		let settled = false;
		const failedRun = fixture.runner.run(first.context, fixture.store).finally(() => {
			settled = true;
		});
		const rejection = expect(failedRun).rejects.toThrow("injected prompt failure");
		try {
			await replyStarted.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			releaseReply.resolve();
			await rejection;
			expect(first.messages).toEqual(["queued reply"]);
			expect(capturedAttach).toBeDefined();
			if (!capturedAttach) throw new Error("attach tool missing");
			await expect(capturedAttach.execute("stale", { label: "stale", path: "stale.txt" })).rejects.toThrow(
				/active run/i,
			);
			expect(first.uploads).toEqual([]);
			expect((await fixture.runner.run(second.context, fixture.store)).toolErrors).toBe(0);
			expect(second.uploads).toEqual([{ path: "new.txt", title: "new.txt" }]);
			expect(second.messages).toContain("recovered");
		} finally {
			releaseReply.resolve();
			await rejection;
		}
	});

	it("keeps optional diagnostic write failure nonfatal and can run again", async () => {
		const fixture = createFixture("setup-recovery");
		const ctx = createContext("setup-recovery");
		mkdirSync(join(fixture.channelDir, "last_prompt.jsonl"), { recursive: true });
		fixture.provider.setResponses([fauxAssistantMessage("diagnostic failure tolerated")]);
		expect((await fixture.runner.run(ctx.context, fixture.store)).stopReason).toBe("stop");
		rmSync(join(fixture.channelDir, "last_prompt.jsonl"), { recursive: true });
		fixture.provider.setResponses([fauxAssistantMessage("setup recovered")]);
		expect((await fixture.runner.run(ctx.context, fixture.store)).stopReason).toBe("stop");
		expect(ctx.messages).toContain("setup recovered");
	});

	it("uses each new run's upload context and maps only its Docker channel", async () => {
		const fixture = createFixture("docker-path", { type: "docker", container: "unused-test-container" });
		const first = createContext("docker-path");
		const second = createContext("docker-path", "2");
		fixture.provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall("attach", {
					label: "local report",
					path: "/workspace/docker-path/report.txt",
					title: "Report",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("first done"),
			fauxAssistantMessage(
				fauxToolCall("attach", { label: "shared report", path: "/workspace/docker-path/shared.txt" }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("second done"),
		]);
		expect((await fixture.runner.run(first.context, fixture.store)).toolErrors).toBe(0);
		expect((await fixture.runner.run(second.context, fixture.store)).toolErrors).toBe(0);
		expect(first.uploads).toEqual([{ path: "report.txt", title: "Report" }]);
		expect(second.uploads).toEqual([{ path: "shared.txt", title: "shared.txt" }]);
	});
});

it.each([
	"/workspace/other/private.txt",
	"/workspace/shared.txt",
	"/tmp/fictional-outside.txt",
	"/workspace/own/../other/private.txt",
	"../other/private.txt",
])("runner rejects unauthorized attach path %s", async (path) => {
	const f = createFixture("own", { type: "docker", container: "unused" });
	const ctx = createContext("own");
	f.provider.setResponses([
		fauxAssistantMessage(fauxToolCall("attach", { label: "blocked", path }), { stopReason: "toolUse" }),
		fauxAssistantMessage("attachment rejected"),
	]);
	const result = await f.runner.run(ctx.context, f.store);
	expect(result.toolErrors).toBe(1);
	expect(ctx.uploads).toEqual([]);
});

it.each([
	{ platform: "feishu", sandbox: "host" },
	{ platform: "slack", sandbox: "host" },
	{ platform: "feishu", sandbox: "docker" },
	{ platform: "slack", sandbox: "docker" },
] as const)(
	"delivers actual channel bytes through attach, $sandbox runner and $platform SDK boundary",
	async ({ platform, sandbox }) => {
		const f = createFixture(
			"delivery",
			sandbox === "host" ? { type: "host" } : { type: "docker", container: "unused" },
		);
		mkdirSync(f.channelDir, { recursive: true });
		writeFileSync(join(f.channelDir, "report.txt"), "fictional delivery bytes");
		const delivered: Buffer[] = [];
		const bot = Object.assign(
			Object.create(platform === "feishu" ? FeishuBot.prototype : SlackBot.prototype) as object,
			{
				workingDir: f.workspace,
				client: {
					im: {
						v1: {
							file: {
								create: async ({ data }: { data: { file: Buffer } }) => {
									delivered.push(data.file);
									return { file_key: "mock" };
								},
							},
							message: { create: async () => ({ code: 0 }) },
						},
					},
				},
				webClient: {
					files: {
						uploadV2: async ({ file }: { file: Buffer }) => {
							delivered.push(file);
						},
					},
				},
			},
		) as unknown as Pick<FeishuBot, "uploadFile">;
		const ctx = createContext("delivery");
		ctx.context.uploadFile = (path, title) => bot.uploadFile("delivery", path, title);
		f.provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall("attach", {
					label: "report",
					path: sandbox === "host" ? join(f.channelDir, "report.txt") : "/workspace/delivery/report.txt",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("delivered"),
		]);
		expect((await f.runner.run(ctx.context, f.store)).toolErrors).toBe(0);
		expect(delivered.map((bytes) => bytes.toString())).toEqual(["fictional delivery bytes"]);
	},
);

it("reserves each verifier command against the same per-run tool quota", async () => {
	const exec = vi.fn(async (_command: string) => ({ code: 0, stdout: "OK", stderr: "" }));
	vi.spyOn(sandboxModule, "createExecutor").mockReturnValue({ getWorkspacePath: () => "/workspace", exec });
	const fixture = createFixture("verify-two", { type: "docker", container: "mock" }, { maxRunToolCalls: 2 });
	await fixture.goals.create(
		{
			objective: "two checks",
			ownerUserId: "test-user",
			acceptance: {
				mode: "automatic",
				files: [],
				commands: [
					{ command: "first", sourcePaths: ["source"] },
					{ command: "second", sourcePaths: ["source"] },
				],
			},
		},
		new AbortController().signal,
	);
	writeFileSync(join(fixture.channelDir, "source"), "abc");
	fixture.provider.setResponses([
		fauxAssistantMessage(fauxToolCall("goal_complete", { summary: "done", evidence: ["claim"] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	]);
	const result = await fixture.runner.run(createContext("verify-two").context, fixture.store);
	const commands = exec.mock.calls.map(([command]) => command);
	expect(commands.filter((command) => command.includes("first"))).toHaveLength(1);
	expect(commands.some((command) => command.includes("second"))).toBe(false);
	expect(result.verificationCommandCount).toBe(1);
	expect(result.toolCalls).toBe(2);
	expect(result.budgetReason).toContain("tool");
	expect(fixture.goals.get()?.status).not.toBe("completed");
});

it("retains partial totals as known-only and marks unknown provider usage explicitly", async () => {
	const f = createFixture("unknown-provider-usage", { type: "host" }, { maxRunDurationMs: 30 });
	f.provider.setResponses([
		async (_context, options) => {
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "aborted before usage" });
		},
	]);
	const result = await f.runner.run(createContext("unknown-provider-usage").context, f.store);
	expect(result.usageIncomplete).toBe(true);
	f.runner.dispose();
});

it("fails the run when model-attempt audit cannot be persisted", async () => {
	const fixture = createFixture("critical-attempt-audit");
	fixture.provider.setResponses([fauxAssistantMessage("done")]);
	mkdirSync(join(resolveAuditDirectory(fixture.workspace), ".writer.lock"), { recursive: true });
	await expect(fixture.runner.run(createContext("critical-attempt-audit").context, fixture.store)).rejects.toThrow(
		CriticalAuditError,
	);
	expect(fixture.provider.state.callCount).toBeLessThanOrEqual(1);
});
