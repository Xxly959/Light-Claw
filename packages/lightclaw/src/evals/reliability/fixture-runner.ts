import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	getApiProvider,
	type Usage as ModelUsage,
	registerApiProvider,
	registerFauxProvider,
} from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { type AgentRunner, type AgentRunResult, createAgentRunner } from "../../agent.js";
import { writeDurableJson } from "../../durable-state.js";
import { validateArtifactPath } from "../../goals/acceptance.js";
import { OperationJournal, type OperationRecord } from "../../operations.js";
import { createLightClawRuntime } from "../../runtime.js";
import type { Executor } from "../../sandbox.js";
import { createGoalTools } from "../../tools/goal.js";
import type { ChatEvent } from "../../transport.js";
import { sha256 } from "./data.js";
import { SimulatedPlatform } from "./simulated-platform.js";
import type { Decision, Job, Observation, Oracle, ReliabilityTask } from "./types.js";

const schema = Type.Object({
	operation: Type.Union([Type.Literal("read"), Type.Literal("write")]),
	path: Type.String(),
	content: Type.Optional(Type.String()),
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function runFixture(
	task: ReliabilityTask,
	oracle: Oracle,
	job: Job,
	root: string,
	prompt: string,
	recoverOnly = false,
): Promise<Observation> {
	if (task.split === "blind") throw new Error("Blind tasks cannot enter faux wiring runs or candidate selection");
	const started = Date.now(),
		work = join(root, "work"),
		channel = "evaluation",
		directory = join(work, channel);
	mkdirSync(directory, { recursive: true });
	if (!recoverOnly)
		for (const [path, text] of Object.entries(task.inputs)) {
			mkdirSync(dirname(join(directory, path)), { recursive: true });
			writeFileSync(join(directory, path), text);
		}
	const model = registerFauxProvider({
		api: "faux-reliability-v1",
		provider: "faux-reliability-v1",
		models: [{ id: "wiring", contextWindow: 16_384, maxTokens: 2048 }],
		tokenSize: { min: 128, max: 128 },
	});
	const runs: AgentRunResult[] = [],
		usage: ModelUsage[] = [];
	let human = 0,
		compactions = 0;
	const phases: string[] = [];
	let platform!: SimulatedPlatform;
	const messages: Record<string, unknown>[] = [];
	const runners = new Map<string, AgentRunner>();
	const restricted: Executor = {
		getWorkspacePath: () => "/workspace",
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
	const complete = JSON.stringify({
		decision: oracle.decision,
		reason: "fixed offline fixture; no semantic model inference",
	});
	const call = (name: string, args: Record<string, unknown>) =>
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	const governed = job.arm !== "baseline" || job.axis === "B";
	const longGoal =
		["multi-goal", "manual-confirm", "stale-confirm", "artifact-change", "pause-resume", "process-crash"].includes(
			task.scenario,
		) && governed;
	const steps: FauxResponseStep[] = [];
	if (task.scenario === "controlled-effect") {
		const input = JSON.parse(task.inputs["input.json"]) as { business_key: string; payload: unknown };
		steps.push(
			call("controlled_effect", { key: input.business_key, payload: JSON.stringify(input.payload) }),
			call("controlled_effect", { key: input.business_key, payload: JSON.stringify(input.payload) }),
		);
	}
	if (task.scenario === "timeout")
		steps.push(async (_ctx, options) => {
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return fauxAssistantMessage("", { stopReason: "aborted" });
		});
	else if (oracle.expected === null) steps.push(fauxAssistantMessage(complete));
	else if (task.scenario === "compaction")
		steps.push(
			call("file_action", { operation: "read", path: "input.json" }),
			fauxAssistantMessage(
				JSON.stringify({
					decision: "unknown",
					reason: "phase one inspected input; final artifact must follow compaction",
				}),
			),
		);
	else {
		steps.push(call("file_action", { operation: "read", path: "input.json" }));
		if (task.scenario === "multi-goal" && governed)
			steps.push(
				call("goal_progress", { summary: "phase one inspected input", evidence: ["input.json"] }),
				fauxAssistantMessage(JSON.stringify({ decision: "unknown", reason: "phase one saved" })),
			);
		if (task.scenario === "checker-tamper")
			steps.push(call("file_action", { operation: "write", path: "checker.py", content: "print('ALL_PASS')" }));
		steps.push(
			call("file_action", { operation: "write", path: task.output, content: JSON.stringify(oracle.expected) }),
		);
		if (task.scenario === "system-error")
			steps.push(
				fauxAssistantMessage(complete, {
					stopReason: "error",
					errorMessage: "Injected system failure after correct artifact",
				}),
			);
		else if (longGoal) steps.push(call("goal_complete", { summary: complete, evidence: [task.output] }));
		else steps.push(fauxAssistantMessage(complete));
	}
	model.setResponses(steps);
	const runtime = await createLightClawRuntime({
		workingDir: work,
		sandbox: { type: "host" },
		config: {
			transport: "slack",
			modelProvider: model.getModel().provider,
			modelId: model.getModel().id,
			controlDir: join(root, "control"),
			promptInstructions: prompt,
			maxGoalCycles: 4,
			maxGoalFailures: 2,
			maxStaleCycles: 3,
			maxRunDurationMs: task.scenario === "timeout" ? 30 : 4000,
			maxRunToolCalls: 32,
			maxRunTokens: 100_000,
			platformTimeoutMs: 100,
			features: { goals: governed, acceptance: governed, controls: true, scheduling: true },
		},
		createTransport: (handler, inbox) => {
			platform = new SimulatedPlatform(handler, inbox, task.scenario === "queue-expiry" ? 20 : 30_000);
			return platform;
		},
		createRunner: (sandbox, id, path, config, goals) => {
			const tool: AgentTool<typeof schema> = {
				name: "file_action",
				label: "Bounded file action",
				description:
					"Read/write only channel-relative text files, maximum 1 MiB; no commands, network, symlinks or absolute paths.",
				parameters: schema,
				async execute(_id, args) {
					const relative = validateArtifactPath(args.path);
					const target = join(path, relative);
					mkdirSync(dirname(target), { recursive: true });
					if (
						!realpathSync(dirname(target)).startsWith(`${realpathSync(path)}/`) &&
						realpathSync(dirname(target)) !== realpathSync(path)
					)
						throw new Error("outside channel");
					if (
						existsSync(target) &&
						(lstatSync(target).isSymbolicLink() ||
							!lstatSync(target).isFile() ||
							lstatSync(target).size > 1024 * 1024)
					)
						throw new Error("linked, non-regular or oversized file");
					if (args.operation === "write") {
						if (Buffer.byteLength(args.content ?? "") > 1024 * 1024) throw new Error("file too large");
						writeFileSync(target, args.content ?? "");
						if (task.scenario === "process-crash") {
							console.log("RELIABILITY_CRASH_POINT");
							await new Promise(() => {
								setInterval(() => {}, 1000);
							});
						}
					}
					return {
						content: [
							{ type: "text", text: args.operation === "read" ? readFileSync(target, "utf8") : "written" },
						],
						details: undefined,
					};
				},
			};
			const effectSchema = Type.Object({ key: Type.String(), payload: Type.String() });
			const effect: AgentTool<typeof effectSchema> = {
				name: "controlled_effect",
				label: "Mock controlled effect",
				description:
					"Persistently register a fictional effect by business key; query/reconcile the same ID after a lost receipt.",
				parameters: effectSchema,
				async execute(_id, args) {
					const journal = new OperationJournal(join(root, "control", ".fixture-operations"));
					const effectPath = join(root, "external-effects.json");
					const result = await journal.execute(task.id, args.key, JSON.parse(args.payload) as unknown, {
						replaySafe: true,
						query: async (id) => {
							const entries = existsSync(effectPath)
								? (JSON.parse(readFileSync(effectPath, "utf8")) as Record<string, { count: number }>)
								: {};
							return entries[id] ? { status: "found", result: { receipt: id } } : { status: "absent" };
						},
						execute: async (id) => {
							const entries = existsSync(effectPath)
								? (JSON.parse(readFileSync(effectPath, "utf8")) as Record<string, { count: number }>)
								: {};
							entries[id] = { count: (entries[id]?.count ?? 0) + 1 };
							writeDurableJson(effectPath, entries);
							throw new Error("Injected lost mock receipt after effect");
						},
					});
					return { content: [{ type: "text", text: result.status }], details: result };
				},
			};
			const goalTools = createGoalTools(goals, () => ({
				channelDir: path,
				sandbox,
				executor: restricted,
				signal: new AbortController().signal,
				assertActive: () => {},
				reserveCommand: () => {
					throw new Error("No model-generated host commands permitted");
				},
			}));
			const runner = createAgentRunner(sandbox, id, path, config, goals, {
				model: model.getModel(),
				apiKey: "faux-only",
				quiet: true,
				inMemoryState: true,
				executor: restricted,
				tools: [tool, effect, ...goalTools],
			});
			runners.set(path, runner);
			const original = getApiProvider(model.api);
			if (!original) throw new Error("missing faux provider");
			const observe = (source: AssistantMessageEventStream) => {
				const output = createAssistantMessageEventStream();
				void (async () => {
					try {
						for await (const event of source) {
							if (event.type === "done" || event.type === "error") {
								const response = event.type === "done" ? event.message : event.error;
								usage.push(response.usage);
								appendFileSync(join(root, "usage.jsonl"), `${JSON.stringify(response.usage)}\n`);
							}
							output.push(event);
						}
					} catch (error) {
						output.push({
							type: "error",
							reason: "error",
							error: fauxAssistantMessage("", { stopReason: "error", errorMessage: String(error) }),
						});
						output.end();
					}
				})();
				return output;
			};
			let requestCount = 0;
			const request = (context: { systemPrompt?: string; tools?: unknown; messages: unknown[] }) => {
				if (++requestCount > 16) throw new Error("Offline request ceiling reached");
				const normalized = (context.systemPrompt ?? "")
					.split(root)
					.join("<RUN_ROOT>")
					.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>");
				appendFileSync(
					join(root, "requests.jsonl"),
					`${JSON.stringify({
						systemPrompt: context.systemPrompt,
						normalizedSystemPrompt: normalized,
						tools: context.tools,
						messages: context.messages,
						messageCount: context.messages.length,
						payloadHash: sha256(JSON.stringify(context)),
					})}\n`,
				);
			};
			registerApiProvider({
				api: model.api,
				stream: (m, c, o) => {
					request(c);
					return observe(original.stream(m, c, o));
				},
				streamSimple: (m, c, o) => {
					request(c);
					return observe(original.streamSimple(m, c, o));
				},
			});
			return runner;
		},
		releaseRunner: (path) => {
			runners.get(path)?.dispose();
			runners.delete(path);
		},
		onRun: (event, result) => {
			runs.push(result);
			messages.push({ event: event.ts, result });
			writeFileSync(join(root, "runs.json"), JSON.stringify(messages));
		},
	});
	const event = (text: string, ts = "initial"): ChatEvent => ({
		origin: "platform",
		type: "dm",
		channel,
		user: "owner",
		ts,
		text,
	});
	try {
		await runtime.start();
		if (!recoverOnly) {
			if (task.scenario === "delivery-failure") platform.failFinalUpdates = 1;
			const text = longGoal
				? `/goal create ${JSON.stringify({ objective: task.prompt, ...(["manual-confirm", "stale-confirm", "artifact-change"].includes(task.scenario) ? {} : { acceptance: { files: [{ path: task.output }] } }) })}`
				: task.prompt;
			if (task.scenario === "queue-expiry") {
				model.setResponses([
					async () => {
						await pause(70);
						return fauxAssistantMessage(complete);
					},
					...steps,
				]);
				platform.receive(event("queue blocker", "blocker"));
				platform.receive(event(text));
				await platform.drain();
			} else if (task.scenario === "pause-resume" && governed) {
				let entered!: () => void;
				const gate = new Promise<void>((resolve) => {
					entered = resolve;
				});
				model.setResponses([
					async (_ctx, options) => {
						entered();
						await new Promise<void>((resolve) => {
							if (options?.signal?.aborted) resolve();
							else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
						});
						return fauxAssistantMessage("", { stopReason: "aborted" });
					},
				]);
				platform.receive(event(text));
				writeFileSync(join(root, "admitted.json"), "true");
				await gate;
				await runtime.handler.handleEvent(event("/goal pause", "pause"), platform);
				await runtime.idle();
				if (runtime.goalStore(channel).get()?.status === "paused") phases.push("pause-observed");
				model.setResponses(steps);
				platform.receive(event("/goal resume", "resume"));
				await runtime.idle();
				human += 2;
				phases.push("resume-dispatched");
			} else {
				const admitted = platform.receive(event(text));
				writeFileSync(join(root, "admitted.json"), JSON.stringify(admitted));
				await runtime.idle();
			}
			const goal = runtime.goalStore(channel).get(),
				report = goal?.verificationHistory.at(-1);
			if (goal?.status === "awaiting_confirmation" && report) {
				if (task.scenario === "stale-confirm") {
					await runtime.handler.handleEvent(event("/goal pause", "pause-approval"), platform);
					model.setResponses(steps);
					platform.receive(event("/goal resume", "replace-approval"));
					await runtime.idle();
					human += 2;
				}
				if (task.scenario === "artifact-change")
					writeFileSync(join(directory, task.output), JSON.stringify({ tampered: true }));
				await runtime.handler.handleEvent(
					event(`/goal confirm ${goal.id} ${report.attemptId}`, "confirmation"),
					platform,
				);
				human++;
				if (
					task.scenario === "stale-confirm" &&
					runtime.goalStore(channel).get()?.status === "awaiting_confirmation" &&
					runtime.goalStore(channel).get()?.verificationHistory.at(-1)?.attemptId !== report.attemptId
				)
					phases.push("old-approval-rejected");
			}
			if (task.scenario === "compaction") {
				if (existsSync(join(directory, task.output)))
					throw new Error("Compaction fixture produced artifact before the tested continuation");
				phases.push("pre-compaction-no-artifact");
				model.appendResponses([
					fauxAssistantMessage(
						`## Goal\n${task.prompt}\n## Progress\nFROZEN_INPUT_CONSTRAINT ${sha256(task.inputs["input.json"])}\n${task.inputs["input.json"]}\nFinal artifact has not been written.`,
					),
					call("file_action", { operation: "read", path: "input.json" }),
					call("file_action", { operation: "write", path: task.output, content: JSON.stringify(oracle.expected) }),
					fauxAssistantMessage(complete),
				]);
				await runtime.compact(channel);
				compactions++;
				phases.push("persisted-compaction");
				platform.receive(event("压缩后继续，遵守原始输入约束。", "after-compaction"));
				await runtime.idle();
				if (existsSync(join(directory, task.output))) phases.push("post-compaction-artifact");
			}
		}
		const goal = runtime.goalStore(channel).get();
		let decision: Decision = "unknown";
		const context = join(directory, "context.jsonl");
		if (existsSync(context))
			for (const line of readFileSync(context, "utf8").split("\n").filter(Boolean)) {
				const row = JSON.parse(line) as {
					type?: string;
					message?: { role?: string; content?: Array<{ type: string; text?: string; name?: string }> };
				};
				if (row.message?.role !== "assistant") continue;
				for (const part of row.message.content ?? []) {
					if (part.type === "toolCall" && part.name === "goal_complete") decision = "complete";
					if (part.type === "text")
						try {
							const value = JSON.parse(part.text ?? "") as { decision?: Decision };
							if (
								value.decision &&
								["complete", "refuse", "clarify", "unable", "unknown"].includes(value.decision)
							)
								decision = value.decision;
						} catch {}
				}
			}
		if (task.scenario === "queue-expiry") decision = "unknown";
		if (recoverOnly) {
			const previous = join(root, "usage.jsonl");
			if (existsSync(previous))
				usage.splice(
					0,
					usage.length,
					...readFileSync(previous, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((l) => JSON.parse(l) as ModelUsage),
				);
		}
		const records = runtime.inbox.list();
		const notifications = readdirSync(join(root, "control", ".operations"))
			.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
			.map(
				(name) => JSON.parse(readFileSync(join(root, "control", ".operations", name), "utf8")) as OperationRecord,
			);
		const unsettledNotifications = notifications.filter((record) => record.status !== "succeeded").length;
		if (unsettledNotifications) phases.push("final-delivery-unresolved");
		const own = records.find((r) => r.event.ts === "initial");
		const ack = join(root, "admitted.json");
		const accepted = existsSync(ack)
			? JSON.parse(readFileSync(ack, "utf8")) === true
			: Boolean(own && own.status !== "rejected");
		if (own?.status === "expired") phases.push("queue-expired");
		if (recoverOnly && own?.status === "unknown") phases.push("crash-recovered-unknown");
		return {
			decision,
			systemCompleted: goal
				? goal.status === "completed"
				: decision === "complete" && runs.length > 0 && !runs.some((r) => r.stopReason !== "stop"),
			phases,
			humanRequired: Boolean(
				unsettledNotifications ||
					records.some((r) => ["unknown", "dead"].includes(r.status)) ||
					goal?.status === "awaiting_confirmation",
			),
			taskLost: accepted && !own,
			inboxStatus: own?.status ?? null,
			goalStatus: goal?.status ?? null,
			humanInterventions: human,
			toolErrors: runs.reduce((n, r) => n + r.toolErrors, 0),
			productTimeout: runs.some((r) => Boolean(r.budgetReason)),
			systemFailure: Boolean(
				unsettledNotifications ||
					(runs.at(-1) &&
						(runs.at(-1)!.stopReason === "error" ||
							runs.at(-1)!.stopReason === "aborted" ||
							runs.at(-1)!.deliveryError)),
			),
			accepted,
			consumed: own?.status === "completed",
			unresolved: unsettledNotifications + records.filter((r) => ["unknown", "dead"].includes(r.status)).length,
			duplicateEffects: existsSync(join(root, "external-effects.json"))
				? Object.values(
						JSON.parse(readFileSync(join(root, "external-effects.json"), "utf8")) as Record<
							string,
							{ count: number }
						>,
					).reduce((n, e) => n + Math.max(0, e.count - 1), 0)
				: null,
			compactions,
			cycles: runs.length,
			durationMs: Date.now() - started,
			usage: {
				input: usage.length ? usage.reduce((n, u) => n + u.input, 0) : null,
				output: usage.length ? usage.reduce((n, u) => n + u.output, 0) : null,
				cacheRead: usage.length ? usage.reduce((n, u) => n + u.cacheRead, 0) : null,
				cacheWrite: usage.length ? usage.reduce((n, u) => n + u.cacheWrite, 0) : null,
				modelRequests: existsSync(join(root, "requests.jsonl"))
					? readFileSync(join(root, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).length
					: 0,
			},
			usageSource: "synthetic-faux-estimate",
			platform: "protocol-simulator",
			evidence: "faux-wiring-only",
		};
	} finally {
		await runtime.shutdown();
		model.unregister();
	}
}
