#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { loadConfig } from "./config.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import { FeishuBot } from "./feishu.js";
import type { GoalCommandResult } from "./goals/commands.js";
import { handleGoalCommand } from "./goals/commands.js";
import { GoalStore } from "./goals/store.js";
import * as log from "./log.js";
import { appendAuditEvent } from "./observability.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { SlackBot } from "./slack.js";
import { ChannelStore } from "./store.js";
import type { ChatContext, ChatEvent, ChatHandler, ChatTransport } from "./transport.js";

setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

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

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };
await validateSandbox(sandbox);

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	goals: GoalStore;
	stopRequested: boolean;
	stopMessageId?: string;
}

const channelStates = new Map<string, ChannelState>();

function createStore(): ChannelStore {
	return new ChannelStore({ workingDir, botToken: config.slack?.botToken });
}

function getState(channelId: string): ChannelState {
	let state = channelStates.get(channelId);
	if (state) return state;
	const channelDir = join(workingDir, channelId);
	const goals = new GoalStore(channelDir, {
		maxCycles: config.maxGoalCycles,
		maxFailures: config.maxGoalFailures,
		maxStaleCycles: config.maxStaleCycles,
	});
	state = {
		running: false,
		store: createStore(),
		goals,
		runner: getOrCreateRunner(sandbox, channelId, channelDir, config, goals),
		stopRequested: false,
	};
	channelStates.set(channelId, state);
	return state;
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

	const serialize = (operation: () => Promise<void>): Promise<void> => {
		updatePromise = updatePromise.then(operation);
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
				if (messageId) await transport.updateMessage(event.channel, messageId, displayText);
				else messageId = await transport.postMessage(event.channel, displayText);
				if (shouldLog) transport.logBotResponse(event.channel, text, messageId);
			}),
		replaceMessage: (text) =>
			serialize(async () => {
				accumulatedText = fit(text);
				const displayText = isWorking ? `${accumulatedText} ...` : accumulatedText;
				if (messageId) await transport.updateMessage(event.channel, messageId, displayText);
				else messageId = await transport.postMessage(event.channel, displayText);
			}),
		respondInThread: (text) =>
			serialize(async () => {
				if (!messageId) return;
				threadMessageIds.push(await transport.postInThread(event.channel, messageId, fit(text)));
			}),
		setTyping: (typing) =>
			serialize(async () => {
				if (!typing || messageId) return;
				accumulatedText = eventFilename ? `开始执行事件：${eventFilename}` : "正在思考";
				messageId = await transport.postMessage(event.channel, `${accumulatedText} ...`);
			}),
		uploadFile: (filePath, title) => transport.uploadFile(event.channel, filePath, title),
		setWorking: (working) =>
			serialize(async () => {
				isWorking = working;
				if (messageId)
					await transport.updateMessage(event.channel, messageId, `${accumulatedText}${working ? " ..." : ""}`);
			}),
		deleteMessage: () =>
			serialize(async () => {
				for (const id of threadMessageIds.reverse()) {
					try {
						await transport.deleteMessage(event.channel, id);
					} catch {}
				}
				if (messageId) await transport.deleteMessage(event.channel, messageId);
				messageId = null;
			}),
	};
}

function continuationEvent(event: ChatEvent, cycle: number): ChatEvent {
	return {
		...event,
		ts: `goal-${Date.now()}-${cycle}`,
		text: "[LightClaw 自动续跑] 检查当前进展，继续推进长期目标。不要重复已经完成的工作。",
		attachments: [],
		files: undefined,
	};
}

const handler: ChatHandler = {
	isRunning: (channelId) => channelStates.get(channelId)?.running ?? false,

	async handleStop(channelId, transport) {
		const state = channelStates.get(channelId);
		if (!state?.running) {
			await transport.postMessage(channelId, "当前没有正在执行的任务");
			return;
		}
		state.stopRequested = true;
		state.runner.abort();
		if (state.goals.get()?.status === "active") state.goals.pause("用户停止");
		state.stopMessageId = await transport.postMessage(channelId, "正在停止...");
	},

	async handleEvent(event, transport, isEvent) {
		const state = getState(event.channel);
		let command: GoalCommandResult;
		try {
			command = handleGoalCommand(event.text, state.goals);
		} catch (error) {
			await transport.postMessage(
				event.channel,
				`目标命令失败：${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (command.handled) {
			if (command.response) await transport.postMessage(event.channel, command.response);
			if (command.goal) {
				appendAuditEvent(workingDir, {
					type: command.startRun && command.goal.cycle === 0 ? "goal_created" : "goal_state_changed",
					channelId: event.channel,
					goalId: command.goal.id,
					cycle: command.goal.cycle,
					detail: command.goal.status,
				});
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
				await ctx.setTyping(true);
				const result = await state.runner.run(ctx, state.store);
				await ctx.setWorking(false);

				appendAuditEvent(workingDir, {
					type: "run_finished",
					channelId: event.channel,
					goalId: before?.id,
					cycle: before ? before.cycle + 1 : undefined,
					durationMs: result.durationMs,
					stopReason: result.stopReason,
					toolCalls: result.toolCalls,
					toolErrors: result.toolErrors,
					inputTokens: result.inputTokens,
					outputTokens: result.outputTokens,
					cost: result.cost,
				});

				const after = state.goals.get();
				if (before && after?.status !== before.status) {
					appendAuditEvent(workingDir, {
						type: "goal_state_changed",
						channelId: event.channel,
						goalId: after?.id,
						cycle: after?.cycle,
						detail: after?.status,
					});
				}
				if (!after || after.status !== "active") break;
				const failed = result.stopReason === "error" || result.stopReason === "aborted";
				const recorded = state.goals.recordCycle(failed, after.progressVersion > (before?.progressVersion ?? 0));
				if (recorded.status !== "active") {
					appendAuditEvent(workingDir, {
						type: "goal_state_changed",
						channelId: event.channel,
						goalId: recorded.id,
						cycle: recorded.cycle,
						detail: recorded.pauseReason,
					});
					await transport.postMessage(event.channel, `长期目标已暂停：${recorded.pauseReason}`);
					break;
				}
				currentEvent = continuationEvent(event, recorded.cycle);
				isEvent = true;
			}

			if (state.stopMessageId) {
				await transport.updateMessage(event.channel, state.stopMessageId, "已停止");
				state.stopMessageId = undefined;
			}
		} catch (error) {
			log.logWarning(`[${event.channel}] Run error`, error instanceof Error ? error.message : String(error));
			const goal = state.goals.get();
			if (goal?.status === "active") state.goals.recordCycle(true, false);
			await transport.postMessage(
				event.channel,
				`执行失败：${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			state.running = false;
		}
	},
};

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);
const sharedStore = createStore();
const transport: ChatTransport =
	config.transport === "slack" && config.slack
		? new SlackBot(handler, { ...config.slack, workingDir, store: sharedStore })
		: new FeishuBot(handler, { ...config.feishu!, workingDir, store: sharedStore });
const eventsWatcher = createEventsWatcher(workingDir, transport);
eventsWatcher.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		log.logInfo("LightClaw 正在关闭...");
		eventsWatcher.stop();
		process.exit(0);
	});
}

await transport.start();

for (const entry of readdirSync(workingDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const channelId = entry.name;
	const channelDir = join(workingDir, channelId);
	if (!existsSync(join(channelDir, "goal.json"))) continue;
	const goal = getState(channelId).goals.get();
	if (goal?.status !== "active") continue;
	transport.enqueueEvent({
		type: "dm",
		channel: channelId,
		ts: `goal-recovery-${Date.now()}`,
		user: "lightclaw",
		text: "[LightClaw 崩溃恢复] 读取已保存进展，继续推进长期目标。",
	});
}
