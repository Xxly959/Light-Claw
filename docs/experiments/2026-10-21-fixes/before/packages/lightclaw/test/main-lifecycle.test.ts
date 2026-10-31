import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner, AgentRunResult } from "../src/agent.js";
import type { LightClawConfig } from "../src/config.js";
import type { GoalStore } from "../src/goals/store.js";
import type { GoalState } from "../src/goals/types.js";
import type { ChatContext, ChatEvent, ChatHandler, ChatTransport } from "../src/transport.js";

type RunPlan = (store: GoalStore, ctx: ChatContext, call: number) => Promise<AgentRunResult>;

const audit = vi.hoisted(() => {
	const originalArgs = process.argv;
	const originalSignals = new Map(
		(["SIGINT", "SIGTERM"] as const).map((name) => [name, new Set(process.listeners(name))]),
	);
	const directory = `${process.env.TMPDIR || "/tmp"}/lightclaw-entry-regression-${process.pid}-${Date.now()}`;
	const fixtureRoot = directory;
	const workspace = `${directory}/work`;
	const control = `${directory}/control`;
	process.argv = [process.execPath, "lightclaw-entry-audit", workspace];
	const state = {
		handler: undefined as ChatHandler | undefined,
		transport: undefined as ChatTransport | undefined,
		plans: new Map<string, RunPlan>(),
		goals: new Map<string, GoalStore>(),
		calls: new Map<string, number>(),
		inputs: new Map<string, string[]>(),
		abortHandlers: new Map<string, () => void>(),
		aborts: [] as string[],
		messages: [] as Array<{ kind: string; channel: string; text: string }>,
		recovery: [] as ChatEvent[],
		failPost: undefined as ((channel: string, text: string) => boolean) | undefined,
		hangPost: undefined as ((channel: string, text: string) => Promise<void> | undefined) | undefined,
		failUpdate: undefined as ((channel: string, text: string) => boolean) | undefined,
		observations: [] as Array<Record<string, unknown>>,
	};
	const result = (): AgentRunResult => ({
		stopReason: "stop",
		durationMs: 1,
		toolCalls: 0,
		verificationCommandCount: 0,
		toolErrors: 0,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
	});
	class AuditTransport implements ChatTransport {
		readonly kind = "feishu" as const;
		constructor(handler: ChatHandler) {
			state.handler = handler;
			state.transport = this;
		}
		async start(): Promise<void> {}
		getUser(): undefined {
			return undefined;
		}
		getChannel(): undefined {
			return undefined;
		}
		getAllUsers(): [] {
			return [];
		}
		getAllChannels(): [] {
			return [];
		}
		async postMessage(channel: string, text: string): Promise<string> {
			state.messages.push({ kind: "post", channel, text });
			if (state.failPost?.(channel, text)) throw new Error("audit platform post failure");
			await state.hangPost?.(channel, text);
			return `audit-message-${state.messages.length}`;
		}
		async updateMessage(channel: string, _id: string, text: string): Promise<void> {
			state.messages.push({ kind: "update", channel, text });
			if (state.failUpdate?.(channel, text)) throw new Error("audit platform update failure");
		}
		async deleteMessage(): Promise<void> {}
		async postInThread(): Promise<string> {
			return "audit-thread";
		}
		async uploadFile(): Promise<void> {}
		logBotResponse(): void {}
		enqueueEvent(event: ChatEvent): boolean {
			state.recovery.push(event);
			return true;
		}
	}
	return { directory: workspace, fixtureRoot, control, originalArgs, originalSignals, state, result, AuditTransport };
});

vi.mock("undici", () => ({ EnvHttpProxyAgent: class {}, setGlobalDispatcher: () => {} }));
vi.mock("../src/config.js", () => ({
	loadConfig: (): LightClawConfig => {
		mkdirSync(audit.directory, { recursive: true });
		for (const status of ["active", "paused", "completed", "cancelled", "awaiting_confirmation"] as const) {
			const channel = `recovery-${status}`;
			const now = new Date().toISOString();
			const report = {
				attemptId: "attempt",
				goalId: channel,
				revision: 0,
				status: "inconclusive",
				startedAt: now,
				finishedAt: now,
				summary: "done",
				evidence: ["proof"],
				checks: [],
				snapshots: [],
			};
			mkdirSync(join(audit.control, channel), { recursive: true });
			writeFileSync(
				join(audit.control, channel, "goal.json"),
				JSON.stringify({
					schemaVersion: 2,
					id: channel,
					ownerUserId: "audit-user",
					revision: 0,
					objective: "recover valid goal",
					status,
					cycle: 0,
					consecutiveFailures: 0,
					staleCycles: 0,
					progressVersion: 0,
					acceptance: { mode: "manual" },
					baselines: [],
					evidence: ["proof"],
					verificationHistory: status === "completed" || status === "awaiting_confirmation" ? [report] : [],
					createdAt: now,
					updatedAt: now,
					...(status === "completed"
						? {
								completedAt: now,
								completion: {
									method: "human",
									attemptId: "attempt",
									confirmedBy: "audit-user",
									confirmedAt: now,
								},
							}
						: {}),
				}),
			);
		}
		mkdirSync(join(audit.control, "broken"));
		writeFileSync(join(audit.control, "broken", "goal.json"), "{}");
		mkdirSync(join(audit.directory, "legacy"));
		writeFileSync(join(audit.directory, "legacy", "goal.json"), "{}");
		return {
			transport: "feishu",
			controlDir: audit.control,
			modelProvider: "faux",
			modelId: "audit",
			maxGoalCycles: 4,
			maxGoalFailures: 2,
			maxStaleCycles: 2,
			platformTimeoutMs: 50,
			channelCacheMaxEntries: 2,
			feishu: { appId: "test-id", appSecret: "test-secret" },
		};
	},
}));
vi.mock("../src/feishu.js", () => ({ FeishuBot: audit.AuditTransport }));
vi.mock("../src/slack.js", () => ({ SlackBot: audit.AuditTransport }));
vi.mock("../src/download.js", () => ({ downloadChannel: async () => {} }));
vi.mock("../src/events.js", () => ({ createEventsWatcher: () => ({ start: () => {}, stop: () => {} }) }));
vi.mock("../src/agent.js", () => ({
	releaseRunner: vi.fn(),
	getOrCreateRunner: (
		_sandbox: unknown,
		channel: string,
		_directory: string,
		_config: unknown,
		store: GoalStore,
	): AgentRunner => {
		audit.state.goals.set(channel, store);
		return {
			dispose: () => {},
			run: async (ctx) => {
				const call = (audit.state.calls.get(channel) ?? 0) + 1;
				audit.state.calls.set(channel, call);
				audit.state.inputs.set(channel, [...(audit.state.inputs.get(channel) ?? []), ctx.message.text]);
				return audit.state.plans.get(channel)?.(store, ctx, call) ?? audit.result();
			},
			abort: () => {
				audit.state.aborts.push(channel);
				audit.state.abortHandlers.get(channel)?.();
			},
		};
	},
}));

import "../src/main.js";

function handler(): ChatHandler {
	if (!audit.state.handler) throw new Error("main did not construct transport");
	return audit.state.handler;
}
function transport(): ChatTransport {
	if (!audit.state.transport) throw new Error("main did not construct transport");
	return audit.state.transport;
}
function event(channel: string, text: string): ChatEvent {
	return { origin: "platform", type: "dm", channel, text, user: "audit-user", ts: `audit-${channel}` };
}
async function execute(channel: string, text: string): Promise<void> {
	await handler().handleEvent(event(channel, text), transport());
}
function goal(channel: string): GoalState | undefined {
	return audit.state.goals.get(channel)?.get();
}
async function complete(store: GoalStore, summary: string, evidence: string[]): Promise<void> {
	const channel = [...audit.state.goals].find(([, value]) => value === store)?.[0];
	if (!channel) throw new Error("missing channel");
	const outcome = await store.requestCompletion(
		{ summary, evidence },
		{
			channelDir: join(audit.directory, channel),
			sandbox: { type: "host" },
			signal: new AbortController().signal,
			assertActive: () => {},
			reserveCommand: () => ({ timeoutSeconds: 1 }),
			executor: {
				getWorkspacePath: (path) => path,
				exec: async () => {
					throw new Error("unexpected exec");
				},
			},
		},
	);
	if (!outcome.goal) throw new Error("missing goal");
	await store.confirm(outcome.goal.id, outcome.report.attemptId, "audit-user", new AbortController().signal);
}
function messages(channel: string): string[] {
	return audit.state.messages.filter((item) => item.channel === channel).map((item) => item.text);
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	return {
		promise: new Promise<T>((done) => {
			resolve = done;
		}),
		resolve: (value) => resolve(value),
	};
}

afterAll(() => {
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		for (const listener of process.listeners(signal))
			if (!audit.originalSignals.get(signal)?.has(listener)) process.removeListener(signal, listener);
	}
	process.argv = audit.originalArgs;
	rmSync(audit.fixtureRoot, { recursive: true, force: true });
});
afterEach(() => {
	vi.useRealTimers();
	audit.state.hangPost = undefined;
});

describe("main lifecycle with isolated platform boundary", () => {
	it("does not launch the runner when stop arrives during typing delivery", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		audit.state.hangPost = (channel, text) =>
			channel === "stop-during-typing" && text.includes("正在思考") ? gate : undefined;
		const pending = execute("stop-during-typing", "/goal should not start");
		await vi.waitFor(
			() => expect(messages("stop-during-typing").some((text) => text.includes("正在思考"))).toBe(true),
			{ interval: 1 },
		);
		await handler().handleStop("stop-during-typing", transport());
		release();
		await pending;
		expect(audit.state.calls.get("stop-during-typing")).toBeUndefined();
		expect(goal("stop-during-typing")).toMatchObject({ status: "paused", cycle: 0 });
	});
	it("pauses an expired recovery goal without executing a cycle and can resume it", async () => {
		await execute("queue-expiry", "/goal status");
		const store = audit.state.goals.get("queue-expiry");
		if (!store) throw new Error("missing goal store");
		await store.create(
			{ objective: "queued goal", ownerUserId: "audit-user", acceptance: { mode: "manual" } },
			new AbortController().signal,
		);
		await handler().handleQueueFailure(event("queue-expiry", "recovery"), transport(), "expired");
		expect(store.get()).toMatchObject({ status: "paused", cycle: 0 });
		expect(store.get()?.pauseReason).toContain("/goal resume");
		expect(audit.state.calls.get("queue-expiry")).toBeUndefined();
		expect(readFileSync(join(audit.directory, "audit", "runs.jsonl"), "utf8")).toContain("queue_expired");
		audit.state.plans.set("queue-expiry", async (goals) => {
			await complete(goals, "done", ["proof"]);
			return audit.result();
		});
		await execute("queue-expiry", "/goal resume");
		expect(store.get()?.status).toBe("completed");
	});
	it("pauses when the initial typing request hangs and ignores its late completion", async () => {
		vi.useFakeTimers();
		const entered = deferred<void>();
		const release = deferred<void>();
		audit.state.hangPost = (channel, text) => {
			if (channel === "typing-timeout" && text.includes("正在思考")) {
				entered.resolve();
				return release.promise;
			}
			return undefined;
		};
		let settled = false;
		const pending = execute("typing-timeout", "/goal hanging typing").then(() => {
			settled = true;
		});
		try {
			await entered.promise;
			await vi.advanceTimersByTimeAsync(60);
			expect(settled).toBe(true);
			expect(goal("typing-timeout")).toMatchObject({ status: "paused", cycle: 0 });
			expect(goal("typing-timeout")?.pauseReason).toContain("/goal resume");
			expect(audit.state.calls.has("typing-timeout")).toBe(false);
			expect(handler().isRunning("typing-timeout")).toBe(false);
		} finally {
			release.resolve();
			await pending;
		}
		audit.state.hangPost = undefined;
		await execute("typing-timeout", "/goal resume");
		expect(audit.state.calls.get("typing-timeout")).toBe(2);
	});
	it("pauses on a runner delivery timeout without counting it as an execution failure", async () => {
		audit.state.plans.set("run-delivery-timeout", async () => ({
			...audit.result(),
			stopReason: "aborted",
			deliveryError: "uploadFile timed out",
		}));
		await execute("run-delivery-timeout", "/goal uploading task");
		expect(goal("run-delivery-timeout")).toMatchObject({ status: "paused", cycle: 1, consecutiveFailures: 0 });
		expect(audit.state.calls.get("run-delivery-timeout")).toBe(1);
		expect(readFileSync(join(audit.directory, "audit", "runs.jsonl"), "utf8")).toContain("uploadFile timed out");
	});
	it("pauses immediately on a run budget outcome and records its reason", async () => {
		audit.state.plans.set("run-budget", async () => ({
			...audit.result(),
			stopReason: "aborted",
			budgetReason: "Run tool call budget exhausted (1)",
		}));
		await execute("run-budget", "/goal bounded task");
		expect(goal("run-budget")).toMatchObject({
			status: "paused",
			cycle: 1,
			pauseReason: "Run tool call budget exhausted (1)",
		});
		expect(audit.state.calls.get("run-budget")).toBe(1);
	});
	it("enqueues only active persisted goals at startup", () => {
		expect(audit.state.recovery.map((item) => item.channel)).toEqual(["recovery-active"]);
		expect(audit.state.recovery[0]?.origin).toBe("recovery");
		expect(audit.state.goals.has("recovery-awaiting_confirmation")).toBe(false);
		expect(audit.state.recovery[0]?.text).toContain("崩溃恢复");
		expect(audit.state.goals.has("recovery-paused")).toBe(false);
		expect(audit.state.goals.has("recovery-completed")).toBe(false);
		expect(readFileSync(join(audit.control, "broken", "goal.json"), "utf8")).toBe("{}");
		expect(readFileSync(join(audit.directory, "audit", "runs.jsonl"), "utf8")).toContain("goal_state_invalid");
	});
	it("rejects a new channel while all retained channels are running, then admits it after release", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started: string[] = [];
		for (const channel of ["cache-busy-a", "cache-busy-b"])
			audit.state.plans.set(channel, async () => {
				started.push(channel);
				await gate;
				return audit.result();
			});
		const first = execute("cache-busy-a", "one");
		const second = execute("cache-busy-b", "two");
		while (started.length < 2) await Promise.resolve();
		await execute("cache-excess", "three");
		expect(audit.state.calls.get("cache-excess")).toBeUndefined();
		expect(messages("cache-excess").join(" ")).toContain("未接纳");
		expect(handler().isRunning("cache-busy-a")).toBe(true);
		expect(handler().isRunning("cache-busy-b")).toBe(true);
		release();
		await Promise.all([first, second]);
		await execute("cache-excess", "retry");
		expect(audit.state.calls.get("cache-excess")).toBe(1);
	});
	it("executes ordinary input once without creating a goal", async () => {
		await execute("ordinary", "single task");
		expect(audit.state.calls.get("ordinary")).toBe(1);
		expect(goal("ordinary")).toBeUndefined();
		expect(handler().isRunning("ordinary")).toBe(false);
	});
	it("continues a goal to completion and preserves evidence", async () => {
		audit.state.plans.set("complete", async (store, _ctx, call) => {
			if (call === 1) store.updateProgress("first step", ["first proof"]);
			else await complete(store, "done", ["final proof"]);
			return audit.result();
		});
		await execute("complete", "/goal two step task");
		expect(audit.state.calls.get("complete")).toBe(2);
		expect(goal("complete")).toMatchObject({ status: "completed", evidence: ["first proof", "final proof"] });
		expect(audit.state.inputs.get("complete")?.[1]).toContain("自动续跑");
	});
	it("waits without continuation and preserves confirmed completion after notification failure", async () => {
		audit.state.plans.set("human-confirm", async (store) => {
			await store.requestCompletion(
				{ summary: "review me", evidence: ["proof"] },
				{
					channelDir: join(audit.directory, "human-confirm"),
					sandbox: { type: "host" },
					signal: new AbortController().signal,
					assertActive: () => {},
					reserveCommand: () => ({ timeoutSeconds: 1 }),
					executor: {
						getWorkspacePath: (path) => path,
						exec: async () => {
							throw new Error("unexpected exec");
						},
					},
				},
			);
			return audit.result();
		});
		await execute("human-confirm", "/goal research");
		const state = goal("human-confirm");
		if (!state) throw new Error("missing goal");
		expect(state.status).toBe("awaiting_confirmation");
		expect(audit.state.calls.get("human-confirm")).toBe(1);
		const command = `/goal confirm ${state.id} ${state.verificationHistory.at(-1)?.attemptId}`;
		await handler().handleEvent({ ...event("human-confirm", command), origin: "scheduled" }, transport(), true);
		expect(goal("human-confirm")?.status).toBe("awaiting_confirmation");
		audit.state.failPost = (channel) => channel === "human-confirm";
		try {
			await execute("human-confirm", command);
		} finally {
			audit.state.failPost = undefined;
		}
		expect(goal("human-confirm")?.status).toBe("completed");
		expect(audit.state.calls.get("human-confirm")).toBe(1);
	});

	it("pauses at the configured cycle ceiling even with progress", async () => {
		audit.state.plans.set("cycle-limit", async (store) => {
			store.updateProgress("progress");
			return audit.result();
		});
		await execute("cycle-limit", "/goal keep progressing");
		expect(audit.state.calls.get("cycle-limit")).toBe(4);
		expect(goal("cycle-limit")).toMatchObject({ status: "paused", cycle: 4, pauseReason: "达到最大轮次" });
	});
	it("pauses stalled goals after two cycles", async () => {
		await execute("stale-limit", "/goal no progress");
		expect(goal("stale-limit")).toMatchObject({ status: "paused", cycle: 2, pauseReason: "连续多轮没有进展" });
	});
	it("retries returned error outcomes until the failure ceiling", async () => {
		audit.state.plans.set("returned-error", async () => ({ ...audit.result(), stopReason: "error" }));
		await execute("returned-error", "/goal returned error");
		expect(audit.state.calls.get("returned-error")).toBe(2);
		expect(goal("returned-error")).toMatchObject({
			status: "paused",
			consecutiveFailures: 2,
			pauseReason: "连续执行失败",
		});
	});
	it("pauses an unexpected runner exception instead of leaving an unscheduled active goal", async () => {
		audit.state.plans.set("thrown-error", async () => {
			throw new Error("audit runner rejection");
		});
		await execute("thrown-error", "/goal thrown error");
		expect(audit.state.calls.get("thrown-error")).toBe(1);
		expect(goal("thrown-error")).toMatchObject({ status: "paused", cycle: 1, consecutiveFailures: 1 });
		expect(handler().isRunning("thrown-error")).toBe(false);
	});
	it("stops an in-flight goal and pauses it without another cycle", async () => {
		const entered = deferred<void>();
		const completion = deferred<AgentRunResult>();
		audit.state.abortHandlers.set("stop", () => completion.resolve({ ...audit.result(), stopReason: "aborted" }));
		audit.state.plans.set("stop", async () => {
			entered.resolve();
			return completion.promise;
		});
		const pending = execute("stop", "/goal in flight");
		await entered.promise;
		expect(handler().isRunning("stop")).toBe(true);
		await handler().handleStop("stop", transport());
		await pending;
		expect(audit.state.aborts).toContain("stop");
		expect(goal("stop")).toMatchObject({ status: "paused", pauseReason: "用户停止" });
		expect(audit.state.calls.get("stop")).toBe(1);
		expect(messages("stop")).toContain("已停止");
	});
	it("pauses on typing delivery failure without charging an execution cycle", async () => {
		let failed = false;
		audit.state.failPost = (channel, text) => {
			if (channel === "typing-error" && text.includes("正在思考") && !failed) {
				failed = true;
				return true;
			}
			return false;
		};
		await execute("typing-error", "/goal typing failure");
		audit.state.failPost = undefined;
		expect(audit.state.calls.has("typing-error")).toBe(false);
		expect(goal("typing-error")).toMatchObject({ status: "paused", cycle: 0, consecutiveFailures: 0 });
		expect(handler().isRunning("typing-error")).toBe(false);
	});
	it("keeps completed state when the final platform update fails", async () => {
		audit.state.plans.set("final-delivery", async (store) => {
			await complete(store, "done", ["proof"]);
			return audit.result();
		});
		audit.state.failUpdate = (channel) => channel === "final-delivery";
		await execute("final-delivery", "/goal complete despite delivery failure");
		audit.state.failUpdate = undefined;
		expect(goal("final-delivery")?.status).toBe("completed");
		expect(messages("final-delivery").some((text) => text.startsWith("执行失败："))).toBe(false);
		const events: Array<{ type: string; channelId: string }> = readFileSync(
			join(audit.directory, "audit", "runs.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(events.filter((item) => item.channelId === "final-delivery" && item.type === "run_finished")).toHaveLength(
			1,
		);
		expect(
			events.filter((item) => item.channelId === "final-delivery" && item.type === "delivery_failed"),
		).toHaveLength(1);
	});
	it("allows the next message update after a transient platform rejection", async () => {
		let failed = false;
		let laterRejected = false;
		audit.state.failUpdate = (channel, text) => {
			if (channel === "serializer" && text.includes("first-response") && !failed) {
				failed = true;
				return true;
			}
			return false;
		};
		audit.state.plans.set("serializer", async (_store, ctx) => {
			try {
				await ctx.respond("first-response");
			} catch {}
			try {
				await ctx.replaceMessage("recovered-response");
			} catch {
				laterRejected = true;
			}
			return audit.result();
		});
		await execute("serializer", "single task");
		audit.state.failUpdate = undefined;
		expect(laterRejected).toBe(false);
		expect(messages("serializer").some((text) => text.includes("recovered-response"))).toBe(true);
	});
	it("reports stop on an idle channel without aborting a runner", async () => {
		await handler().handleStop("idle", transport());
		expect(messages("idle")).toContain("当前没有正在执行的任务");
		expect(audit.state.aborts).not.toContain("idle");
	});

	it("charges the executed cycle before a final delivery failure", async () => {
		audit.state.failUpdate = (channel) => channel === "active-final-delivery";
		await execute("active-final-delivery", "/goal task with failed delivery");
		audit.state.failUpdate = undefined;
		expect(goal("active-final-delivery")).toMatchObject({ status: "paused", cycle: 1, consecutiveFailures: 0 });
	});
});

it.each(["pause", "cancel"])("interrupts an active run with /goal %s", async (control) => {
	const channel = `immediate-${control}`;
	const entered = deferred<void>();
	const completion = deferred<AgentRunResult>();
	audit.state.abortHandlers.set(channel, () => completion.resolve({ ...audit.result(), stopReason: "aborted" }));
	audit.state.plans.set(channel, async () => {
		entered.resolve();
		return completion.promise;
	});
	const pending = execute(channel, "/goal pending verification");
	await entered.promise;
	try {
		await execute(channel, `/goal ${control}`);
	} finally {
		completion.resolve(audit.result());
		await pending;
	}
	expect(audit.state.aborts).toContain(channel);
	expect(goal(channel)?.status).toBe(control === "cancel" ? "cancelled" : "paused");
	expect(audit.state.calls.get(channel)).toBe(1);
});
