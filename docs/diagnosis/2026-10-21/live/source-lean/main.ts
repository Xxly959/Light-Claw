#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { type AgentRunner, getOrCreateRunner, releaseRunner } from "./agent.js";
import { loadConfig } from "./config.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import { featureEnabled } from "./features.js";
import { FeishuBot } from "./feishu.js";
import type { GoalCommandResult } from "./goals/commands.js";
import { handleGoalCommand } from "./goals/commands.js";
import {
	acquireControlLock,
	assertControlIsolation,
	resolveControlChannelDirectory,
	resolveControlDirectory,
} from "./goals/control.js";
import { GoalStore } from "./goals/store.js";
import { CacheCapacityError, IdleResourceCache } from "./idle-cache.js";
import * as log from "./log.js";
import { type RunAuditEvent, appendAuditEvent as writeAuditEvent } from "./observability.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { SlackBot } from "./slack.js";
import { ChannelStore } from "./store.js";
import { OperationTimeoutError, withTimeout } from "./timeouts.js";
import {
	type ChatContext,
	type ChatEvent,
	type ChatHandler,
	type ChatTransport,
	isImmediateGoalControl,
} from "./transport.js";

setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

function appendAuditEvent(workspace: string, event: RunAuditEvent): void {
	if (featureEnabled(config, "infrastructure")) writeAuditEvent(workspace, event);
}

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
}

function parseArgs(args = process.argv.slice(2)): ParsedArgs {
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannel: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument.startsWith("--sandbox=")) sandbox = parseSandboxArg(argument.slice(10));
		else if (argument === "--sandbox") sandbox = parseSandboxArg(args[++index] || "");
		else if (argument.startsWith("--download=")) downloadChannel = argument.slice(11);
		else if (argument === "--download") downloadChannel = args[++index];
		else if (!argument.startsWith("-")) workingDir = argument;
	}
	return { workingDir: workingDir ? resolve(workingDir) : undefined, sandbox, downloadChannel };
}

const parsedArgs = parseArgs();
let config: ReturnType<typeof loadConfig>;
try {
	config = loadConfig();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

if (parsedArgs.downloadChannel) {
	if (config.transport !== "slack" || !config.slack) {
		console.error("--download 仅支持 Slack 模式");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, config.slack.botToken);
	process.exit(0);
}
if (!parsedArgs.workingDir) {
	console.error("用法：lightclaw [--sandbox=host|docker:<名称>] <工作目录>");
	process.exit(1);
}

const { workingDir, sandbox } = {
	workingDir: parsedArgs.workingDir,
	sandbox: featureEnabled(config, "infrastructure") ? parsedArgs.sandbox : { type: "host" as const },
};
await validateSandbox(sandbox);
mkdirSync(workingDir, { recursive: true });
const controlDir = resolveControlDirectory(workingDir, config.controlDir);
if (featureEnabled(config, "goals")) await assertControlIsolation(workingDir, controlDir, sandbox);
const controlLock = featureEnabled(config, "goals") ? acquireControlLock(controlDir) : { release() {} };
process.once("exit", () => controlLock.release());
function goalStore(channelId: string): GoalStore {
	return new GoalStore({
		enabled: featureEnabled(config, "goals"),
		acceptanceEnabled: featureEnabled(config, "acceptance"),
		controlsEnabled: featureEnabled(config, "controls"),
		channelDir: join(workingDir, channelId),
		controlChannelDir: resolveControlChannelDirectory(controlDir, channelId),
		limits: {
			maxCycles: config.maxGoalCycles,
			maxFailures: config.maxGoalFailures,
			maxStaleCycles: config.maxStaleCycles,
		},
	});
}

interface ChannelState {
	running: boolean;
	inUse: number;
	runner: AgentRunner;
	store: ChannelStore;
	goals: GoalStore;
	stopRequested: boolean;
	stopMessageId?: string;
}

const channelStates = new IdleResourceCache<ChannelState>(
	{
		enabled: featureEnabled(config, "scheduling"),
		maxEntries: config.channelCacheMaxEntries ?? 128,
		idleTtlMs: config.channelCacheIdleTtlMs ?? 900_000,
	},
	(state) => state.running || state.inUse > 0,
	(_state, channelId) => releaseRunner(join(workingDir, channelId)),
);

function createStore(): ChannelStore {
	return new ChannelStore({ workingDir, botToken: config.slack?.botToken });
}

function getState(channelId: string): ChannelState {
	return channelStates.getOrCreate(channelId, () => {
		const channelDir = join(workingDir, channelId);
		const goals = goalStore(channelId);
		goals.get();
		return {
			running: false,
			inUse: 0,
			store: createStore(),
			goals,
			runner: getOrCreateRunner(sandbox, channelId, channelDir, config, goals),
			stopRequested: false,
		};
	});
}

function createChatContext(event: ChatEvent, transport: ChatTransport, isEvent?: boolean): ChatContext {
	let messageId: string | null = null;
	const threadMessageIds: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	let updatePromise = Promise.resolve();
	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;
	const user = transport.getUser(event.user);
	const limit = transport.kind === "slack" ? 35_000 : 25_000;
	let expired: OperationTimeoutError | undefined;
	const send = async <T>(operation: () => Promise<T>): Promise<T> => {
		if (expired) throw expired;
		try {
			return await withTimeout(operation, config.platformTimeoutMs ?? 30_000, "chat request");
		} catch (error) {
			if (error instanceof OperationTimeoutError) expired = error;
			throw error;
		}
	};

	const serialize = (operation: () => Promise<void>): Promise<void> => {
		const next = () => {
			if (expired) throw expired;
			return operation();
		};
		updatePromise = updatePromise.then(next, next);
		return updatePromise;
	};
	const fit = (text: string): string => (text.length <= limit ? text : `${text.slice(0, limit - 24)}\n\n[消息已截断]`);

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments ?? []).map(({ local }) => ({ local })),
		},
		channelName: transport.getChannel(event.channel)?.name,
		channels: transport.getAllChannels(),
		users: transport.getAllUsers(),
		respond: (text, shouldLog = true) =>
			serialize(async () => {
				accumulatedText = fit(accumulatedText ? `${accumulatedText}\n${text}` : text);
				const displayText = isWorking ? `${accumulatedText} ...` : accumulatedText;
				if (messageId) await send(() => transport.updateMessage(event.channel, messageId!, displayText));
				else messageId = await send(() => transport.postMessage(event.channel, displayText));
				if (shouldLog) transport.logBotResponse(event.channel, text, messageId);
			}),
		replaceMessage: (text) =>
			serialize(async () => {
				accumulatedText = fit(text);
				const displayText = isWorking ? `${accumulatedText} ...` : accumulatedText;
				if (messageId) await send(() => transport.updateMessage(event.channel, messageId!, displayText));
				else messageId = await send(() => transport.postMessage(event.channel, displayText));
			}),
		respondInThread: (text) =>
			serialize(async () => {
				if (!messageId) return;
				threadMessageIds.push(await send(() => transport.postInThread(event.channel, messageId!, fit(text))));
			}),
		setTyping: (typing) =>
			serialize(async () => {
				if (!typing || messageId) return;
				accumulatedText = eventFilename ? `开始执行事件：${eventFilename}` : "正在思考";
				messageId = await send(() => transport.postMessage(event.channel, `${accumulatedText} ...`));
			}),
		uploadFile: (filePath, title) => send(() => transport.uploadFile(event.channel, filePath, title)),
		setWorking: (working) =>
			serialize(async () => {
				isWorking = working;
				if (messageId)
					await send(() =>
						transport.updateMessage(event.channel, messageId!, `${accumulatedText}${working ? " ..." : ""}`),
					);
			}),
		deleteMessage: () =>
			serialize(async () => {
				for (const id of threadMessageIds.reverse()) {
					try {
						await send(() => transport.deleteMessage(event.channel, id));
					} catch {}
				}
				if (messageId) await send(() => transport.deleteMessage(event.channel, messageId!));
				messageId = null;
			}),
	};
}

function continuationEvent(event: ChatEvent, cycle: number): ChatEvent {
	return {
		...event,
		origin: "continuation",
		ts: `goal-${Date.now()}-${cycle}`,
		text: "[LightClaw 自动续跑] 检查当前进展，继续推进长期目标。不要重复已经完成的工作。",
		attachments: [],
		files: undefined,
	};
}

async function deliver(channelId: string, phase: string, operation: () => Promise<unknown>): Promise<boolean> {
	try {
		await withTimeout(operation, config.platformTimeoutMs ?? 30_000, phase);
		return true;
	} catch (error) {
		const detail = `${phase}: ${error instanceof Error ? error.message : String(error)}`;
		log.logWarning(`[${channelId}] Delivery error`, detail);
		appendAuditEvent(workingDir, { type: "delivery_failed", channelId, detail });
		return false;
	}
}

function pauseActive(state: ChannelState, channelId: string, reason: string): void {
	if (state.goals.get()?.status !== "active") return;
	const goal = state.goals.pause(reason);
	appendAuditEvent(workingDir, {
		type: "goal_state_changed",
		channelId,
		goalId: goal.id,
		cycle: goal.cycle,
		detail: reason,
	});
}

const handler: ChatHandler = {
	isRunning: (channelId) => channelStates.peek(channelId)?.running ?? false,

	async handleQueueFailure(event, transport, reason) {
		const detail =
			reason === "full"
				? "频道待处理队列已满，任务未接纳，请稍后重试。"
				: "任务排队等待超时，尚未执行，请重新发送。";
		appendAuditEvent(workingDir, { type: `queue_${reason}`, channelId: event.channel, detail, messageId: event.ts });
		const state = channelStates.peek(event.channel);
		if (!state?.running && (reason === "expired" || event.ts.startsWith("goal-recovery-"))) {
			const goals = state?.goals ?? goalStore(event.channel);
			if (goals.get()?.status === "active") goals.pause(`${detail} 检查后发送 /goal resume。`);
		}
		await deliver(event.channel, "queue-notice", () => transport.postMessage(event.channel, detail));
	},

	async handleStop(channelId, transport) {
		const state = channelStates.peek(channelId);
		if (!state?.running) {
			await deliver(channelId, "idle-stop", () => transport.postMessage(channelId, "当前没有正在执行的任务"));
			return;
		}
		state.stopRequested = true;
		state.runner.abort();
		if (state.goals.get()?.status === "active") state.goals.pause("用户停止");
		await deliver(channelId, "stop", async () => {
			state.stopMessageId = await withTimeout(
				() => transport.postMessage(channelId, "正在停止..."),
				config.platformTimeoutMs ?? 30_000,
				"stop notification",
			);
		});
	},

	async handleEvent(event, transport, isEvent) {
		let state: ChannelState;
		let command: GoalCommandResult;
		try {
			state = getState(event.channel);
			if (state.running && isImmediateGoalControl(event)) {
				state.stopRequested = true;
				state.runner.abort();
			}
			state.inUse++;
			try {
				command = featureEnabled(config, "goals")
					? await handleGoalCommand(event.text, state.goals, {
							userId: event.user,
							origin: event.origin,
							sandbox,
							signal: featureEnabled(config, "controls")
								? AbortSignal.timeout(config.maxRunDurationMs ?? 300_000)
								: new AbortController().signal,
						})
					: { handled: false, startRun: false };
			} finally {
				state.inUse--;
			}
		} catch (error) {
			if (error instanceof CacheCapacityError) {
				await handler.handleQueueFailure(event, transport, "full");
				return;
			}
			await deliver(event.channel, "command-error", () =>
				transport.postMessage(
					event.channel,
					`目标命令失败：${error instanceof Error ? error.message : String(error)}`,
				),
			);
			return;
		}
		state.inUse++;
		try {
			if (command.handled) {
				if (command.goal) {
					appendAuditEvent(workingDir, {
						type:
							command.goal.completion?.method === "human"
								? "goal_confirmed"
								: command.startRun && command.goal.cycle === 0
									? "goal_created"
									: "goal_state_changed",
						channelId: event.channel,
						goalId: command.goal.id,
						cycle: command.goal.cycle,
						detail: command.goal.status,
						attemptId: command.goal.completion?.attemptId,
						completionMethod: command.goal.completion?.method,
					});
				}
				if (
					command.response &&
					!(await deliver(event.channel, "command", () => transport.postMessage(event.channel, command.response!)))
				) {
					if (command.startRun) pauseActive(state, event.channel, "目标确认消息投递失败，发送 /goal resume 重试");
					return;
				}

				if (!command.startRun) return;
			}

			state.running = true;
			state.stopRequested = false;
			let currentEvent = command.goal ? { ...event, text: command.goal.objective } : event;
			try {
				while (!state.stopRequested) {
					const before = state.goals.get();
					const ctx = createChatContext(currentEvent, transport, isEvent);
					if (!(await deliver(event.channel, "typing", () => ctx.setTyping(true)))) {
						pauseActive(state, event.channel, "平台投递失败，发送 /goal resume 重试");
						break;
					}
					if (state.stopRequested) break;
					const startedAt = Date.now();
					let result: Awaited<ReturnType<AgentRunner["run"]>>;
					try {
						result = await state.runner.run(ctx, state.store);
					} catch (error) {
						const detail = error instanceof Error ? error.message : String(error);
						appendAuditEvent(workingDir, {
							type: "run_finished",
							channelId: event.channel,
							goalId: before?.id,
							cycle: before ? before.cycle + 1 : undefined,
							durationMs: Date.now() - startedAt,
							stopReason: "error",
							detail,
						});
						if (state.goals.get()?.status === "active") state.goals.recordCycle(true, false);
						pauseActive(state, event.channel, "执行异常已暂停，检查副作用后发送 /goal resume 重试");
						await deliver(event.channel, "execution-error", () =>
							transport.postMessage(event.channel, `执行失败：${detail}`),
						);
						break;
					}

					appendAuditEvent(workingDir, {
						type: "run_finished",
						channelId: event.channel,
						goalId: before?.id,
						cycle: before ? before.cycle + 1 : undefined,
						durationMs: result.durationMs,
						stopReason: result.stopReason,
						toolCalls: result.toolCalls,
						verificationCommandCount: result.verificationCommandCount,
						toolErrors: result.toolErrors,
						inputTokens: result.inputTokens,
						outputTokens: result.outputTokens,
						cost: result.cost,
						detail: result.budgetReason,
					});

					const after = state.goals.get();
					for (const report of after?.verificationHistory ?? []) {
						if (before?.verificationHistory.some((item) => item.attemptId === report.attemptId)) continue;
						appendAuditEvent(workingDir, {
							type: "verification_finished",
							channelId: event.channel,
							goalId: after?.id,
							attemptId: report.attemptId,
							verificationStatus: report.status,
							completionMethod: after?.completion?.method,
							verificationCommandCount: result.verificationCommandCount,
							detail: report.checks.map((check) => check.reasonCode).join(","),
						});
					}
					if (before && after?.status !== before.status) {
						appendAuditEvent(workingDir, {
							type: "goal_state_changed",
							channelId: event.channel,
							goalId: after?.id,
							cycle: after?.cycle,
							detail: after?.status,
						});
					}
					const failed =
						result.stopReason === "error" || (result.stopReason === "aborted" && !result.deliveryError);
					const recorded =
						after?.status === "active"
							? state.goals.recordCycle(failed, after.progressVersion > (before?.progressVersion ?? 0))
							: after;
					if (result.budgetReason) pauseActive(state, event.channel, result.budgetReason);
					if (result.deliveryError) {
						appendAuditEvent(workingDir, {
							type: "delivery_failed",
							channelId: event.channel,
							detail: result.deliveryError,
						});
						pauseActive(
							state,
							event.channel,
							`平台投递失败；检查结果后发送 /goal resume：${result.deliveryError}`,
						);
						break;
					}
					if (!(await deliver(event.channel, "final-update", () => ctx.setWorking(false)))) {
						pauseActive(state, event.channel, "结果已保存但平台投递失败，发送 /goal resume 重试");
						await deliver(event.channel, "delivery-notice", () =>
							transport.postMessage(
								event.channel,
								after?.status === "completed"
									? "目标已完成，结果已保存；最终消息投递失败"
									: "本轮执行结果已保存；最终消息投递失败",
							),
						);
						break;
					}
					if (!recorded || after?.status !== "active" || result.budgetReason) break;
					if (recorded.status !== "active") {
						appendAuditEvent(workingDir, {
							type: "goal_state_changed",
							channelId: event.channel,
							goalId: recorded.id,
							cycle: recorded.cycle,
							detail: recorded.pauseReason,
						});
						await deliver(event.channel, "paused", () =>
							transport.postMessage(event.channel, `长期目标已暂停：${recorded.pauseReason}`),
						);
						break;
					}
					currentEvent = continuationEvent(event, recorded.cycle);
					isEvent = true;
				}

				if (state.stopMessageId) {
					await deliver(event.channel, "stopped", () =>
						transport.updateMessage(event.channel, state.stopMessageId!, "已停止"),
					);
					state.stopMessageId = undefined;
				}
			} catch (error) {
				log.logWarning(`[${event.channel}] Run error`, error instanceof Error ? error.message : String(error));
				const goal = state.goals.get();
				if (goal?.status === "active")
					pauseActive(state, event.channel, "入口异常已暂停，检查后发送 /goal resume 重试");
				await deliver(event.channel, "entry-error", () =>
					transport.postMessage(
						event.channel,
						`执行失败：${error instanceof Error ? error.message : String(error)}`,
					),
				);
			} finally {
				state.running = false;
			}
		} finally {
			state.inUse--;
		}
	},
};

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);
const sharedStore = createStore();
const transport: ChatTransport =
	config.transport === "slack" && config.slack
		? new SlackBot(handler, {
				...config.slack,
				workingDir,
				store: sharedStore,
				platformTimeoutMs: config.platformTimeoutMs,
				schedulingEnabled: featureEnabled(config, "scheduling"),
				queueMaxPending: config.queueMaxPending,
				queueMaxWaitMs: config.queueMaxWaitMs,
				channelCacheMaxEntries: config.channelCacheMaxEntries,
				channelCacheIdleTtlMs: config.channelCacheIdleTtlMs,
			})
		: new FeishuBot(handler, {
				...config.feishu!,
				workingDir,
				store: sharedStore,
				platformTimeoutMs: config.platformTimeoutMs,
				schedulingEnabled: featureEnabled(config, "scheduling"),
				queueMaxPending: config.queueMaxPending,
				queueMaxWaitMs: config.queueMaxWaitMs,
				channelCacheMaxEntries: config.channelCacheMaxEntries,
				channelCacheIdleTtlMs: config.channelCacheIdleTtlMs,
			});
const eventsWatcher = createEventsWatcher(workingDir, transport);
eventsWatcher.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		log.logInfo("LightClaw 正在关闭...");
		eventsWatcher.stop();
		channelStates.close();
		controlLock.release();
		process.exit(0);
	});
}

await transport.start();

const recoveryChannels = new Set(
	(featureEnabled(config, "goals")
		? [...readdirSync(controlDir, { withFileTypes: true }), ...readdirSync(workingDir, { withFileTypes: true })]
		: []
	)
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name),
);
for (const channelId of featureEnabled(config, "goals") ? recoveryChannels : []) {
	const channelDir = join(workingDir, channelId);
	if (!existsSync(join(channelDir, "goal.json")) && !existsSync(join(controlDir, channelId, "goal.json"))) continue;
	try {
		const goal = goalStore(channelId).get();
		if (goal?.status !== "active") continue;
		transport.enqueueEvent({
			type: "dm",
			origin: "recovery",
			channel: channelId,
			ts: `goal-recovery-${Date.now()}`,
			user: "lightclaw",
			text: "[LightClaw 崩溃恢复] 读取已保存进展，继续推进长期目标。",
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		log.logWarning(`[${channelId}] Goal recovery skipped`, detail);
		appendAuditEvent(workingDir, { type: "goal_state_invalid", channelId, detail });
	}
}
