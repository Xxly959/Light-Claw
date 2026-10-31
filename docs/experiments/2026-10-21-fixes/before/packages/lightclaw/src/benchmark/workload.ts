import { join } from "node:path";
import { hrtime } from "node:process";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
	type FauxProviderRegistration,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { type AgentRunner, type AgentRunResult, createAgentRunner } from "../agent.js";
import { ChannelQueue } from "../channel-queue.js";
import type { LightClawConfig } from "../config.js";
import { GoalStore } from "../goals/store.js";
import { ChannelStore } from "../store.js";
import type { ChatContext } from "../transport.js";
import { ResourceSampler } from "./resources.js";
import type { BenchmarkConfig, BenchmarkPhase, ResourceSample, RoundSample, TaskSample } from "./types.js";

const delaySchema = Type.Object({
	label: Type.String(),
	taskId: Type.String(),
});

interface MutableTaskSample extends TaskSample {
	modelWaitNs: string[];
	toolWaitNs: string[];
}

interface BenchmarkChannel {
	id: string;
	queue: ChannelQueue;
	runner: AgentRunner;
	store: ChannelStore;
	faux: FauxProviderRegistration;
	tasks: MutableTaskSample[];
}

export interface BenchmarkWorkloadResult {
	tasks: TaskSample[];
	rounds: RoundSample[];
	resources: ResourceSample[];
}

function sleep(milliseconds: number): Promise<void> {
	if (milliseconds === 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function measuredSleep(milliseconds: number): Promise<string> {
	const startedAt = hrtime.bigint();
	await sleep(milliseconds);
	return (hrtime.bigint() - startedAt).toString();
}

function benchmarkConfig(): LightClawConfig {
	return {
		transport: "slack",
		modelProvider: "faux",
		modelId: "faux-1",
		maxGoalCycles: 8,
		maxGoalFailures: 2,
		maxStaleCycles: 2,
	};
}

function createContext(channelId: string, taskId: string): ChatContext {
	return {
		message: {
			text: `Run deterministic benchmark task ${taskId}`,
			rawText: `Run deterministic benchmark task ${taskId}`,
			user: "benchmark-user",
			userName: "benchmark",
			channel: channelId,
			ts: taskId,
			attachments: [],
		},
		channelName: channelId,
		channels: [{ id: channelId, name: channelId }],
		users: [{ id: "benchmark-user", userName: "benchmark", displayName: "Benchmark" }],
		respond: async () => {},
		replaceMessage: async () => {},
		respondInThread: async () => {},
		setTyping: async () => {},
		uploadFile: async () => {},
		setWorking: async () => {},
		deleteMessage: async () => {},
	};
}

function applyRunResult(sample: MutableTaskSample, result: AgentRunResult): void {
	sample.stopReason = result.stopReason;
	sample.toolCalls = result.toolCalls;
	sample.toolErrors = result.toolErrors;
	sample.errorMessage = result.errorMessage;
	sample.status =
		result.stopReason === "error" || result.stopReason === "aborted" || result.toolErrors > 0 ? "error" : "completed";
}

function createChannel(options: {
	runId: string;
	phase: BenchmarkPhase;
	concurrency: number;
	round: number;
	channelIndex: number;
	workingDirectory: string;
	config: BenchmarkConfig;
}): BenchmarkChannel {
	const id = `${options.phase}-${options.concurrency}-${options.round}-channel-${options.channelIndex}`;
	const channelDir = join(options.workingDirectory, id);
	const tasks: MutableTaskSample[] = Array.from({ length: options.config.tasksPerChannel }, (_, taskIndex) => ({
		runId: options.runId,
		phase: options.phase,
		concurrency: options.concurrency,
		round: options.round,
		channelId: id,
		taskId: `${id}-task-${taskIndex}`,
		channelTaskIndex: taskIndex,
		enqueuedAtNs: "0",
		startedAtNs: "0",
		completedAtNs: "0",
		modelWaitNs: [],
		toolWaitNs: [],
		status: "error",
		stopReason: "not_started",
		toolCalls: 0,
		toolErrors: 0,
	}));
	const taskById = new Map(tasks.map((task) => [task.taskId, task]));
	const providerId = `faux-${options.runId}-${id}`;
	const faux = registerFauxProvider({
		api: providerId,
		provider: providerId,
		tokenSize: { min: 4, max: 4 },
	});
	const responses: FauxResponseStep[] = [];
	for (const task of tasks) {
		responses.push(async () => {
			task.modelWaitNs.push(await measuredSleep(options.config.modelDelayMs));
			return fauxAssistantMessage(fauxToolCall("benchmark_delay", { label: "wait", taskId: task.taskId }), {
				stopReason: "toolUse",
			});
		});
		responses.push(async () => {
			task.modelWaitNs.push(await measuredSleep(options.config.modelDelayMs));
			return fauxAssistantMessage("benchmark complete");
		});
	}
	faux.setResponses(responses);
	const delayTool: AgentTool<typeof delaySchema, undefined> = {
		name: "benchmark_delay",
		label: "benchmark delay",
		description: "Waits for the configured deterministic benchmark tool delay.",
		parameters: delaySchema,
		execute: async (_toolCallId, parameters) => {
			const task = taskById.get(parameters.taskId);
			if (!task) throw new Error(`unknown benchmark task ${parameters.taskId}`);
			task.toolWaitNs.push(await measuredSleep(options.config.toolDelayMs));
			return { content: [{ type: "text", text: "benchmark delay complete" }], details: undefined };
		},
	};
	const goals = new GoalStore({
		channelDir,
		controlChannelDir: join(options.workingDirectory, "..", `lightclaw-benchmark-control-${options.runId}`, id),
		limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
	});
	const store = new ChannelStore({ workingDir: options.workingDirectory });
	const runner = createAgentRunner({ type: "host" }, id, channelDir, benchmarkConfig(), goals, {
		model: faux.getModel(),
		tools: [delayTool],
		apiKey: "faux-key",
		quiet: true,
	});
	return {
		id,
		queue: new ChannelQueue(undefined, { maxPending: options.config.tasksPerChannel, maxWaitMs: 300_000 }),
		runner,
		store,
		faux,
		tasks,
	};
}

async function runRound(options: {
	runId: string;
	phase: BenchmarkPhase;
	concurrency: number;
	round: number;
	workingDirectory: string;
	config: BenchmarkConfig;
}): Promise<BenchmarkWorkloadResult> {
	const channels: BenchmarkChannel[] = [];
	for (let channelIndex = 0; channelIndex < options.concurrency; channelIndex++) {
		channels.push(createChannel({ ...options, channelIndex }));
	}
	const tasks = channels.flatMap((channel) => channel.tasks);
	const activeChannels = new Set<string>();
	let maxActiveChannels = 0;
	const roundStartedAt = hrtime.bigint();
	const sampler = new ResourceSampler(
		{
			runId: options.runId,
			phase: options.phase,
			concurrency: options.concurrency,
			round: options.round,
		},
		options.config.resourceSampleMs,
	);
	sampler.start();
	let resources: ResourceSample[] = [];

	try {
		const completions: Promise<void>[] = [];
		for (const channel of channels) {
			for (const task of channel.tasks) {
				task.enqueuedAtNs = hrtime.bigint().toString();
				completions.push(
					channel.queue.enqueue(async () => {
						task.startedAtNs = hrtime.bigint().toString();
						activeChannels.add(channel.id);
						maxActiveChannels = Math.max(maxActiveChannels, activeChannels.size);
						try {
							const result = await channel.runner.run(createContext(channel.id, task.taskId), channel.store);
							applyRunResult(task, result);
						} catch (error) {
							task.status = "error";
							task.stopReason = "exception";
							task.errorMessage = error instanceof Error ? error.message : String(error);
						} finally {
							task.completedAtNs = hrtime.bigint().toString();
							activeChannels.delete(channel.id);
						}
					}),
				);
			}
		}
		await Promise.all(completions);
	} finally {
		try {
			resources = sampler.stop();
		} finally {
			for (const channel of channels) {
				try {
					channel.runner.dispose();
				} finally {
					channel.faux.unregister();
				}
			}
		}
	}

	const roundCompletedAt = hrtime.bigint();
	const round: RoundSample = {
		runId: options.runId,
		phase: options.phase,
		concurrency: options.concurrency,
		round: options.round,
		startedAtNs: roundStartedAt.toString(),
		completedAtNs: roundCompletedAt.toString(),
		plannedTasks: tasks.length,
		acceptedTasks: tasks.length,
		completedTasks: tasks.length,
		errorTasks: tasks.filter((task) => task.status === "error").length,
		maxActiveChannels,
	};
	return { tasks, rounds: [round], resources };
}

export async function runBenchmarkWorkload(
	runId: string,
	config: BenchmarkConfig,
	workingDirectory: string,
): Promise<BenchmarkWorkloadResult> {
	const result: BenchmarkWorkloadResult = { tasks: [], rounds: [], resources: [] };
	const phases: Array<{ phase: BenchmarkPhase; count: number }> = [
		{ phase: "warmup", count: config.warmupRounds },
		{ phase: "measurement", count: config.measurementRounds },
	];
	for (const { phase, count } of phases) {
		for (let round = 0; round < count; round++) {
			for (let offset = 0; offset < config.channels.length; offset++) {
				const concurrency = config.channels[(round + offset) % config.channels.length];
				const roundResult = await runRound({ runId, phase, concurrency, round, workingDirectory, config });
				result.tasks.push(...roundResult.tasks);
				result.rounds.push(...roundResult.rounds);
				result.resources.push(...roundResult.resources);
			}
		}
	}
	return result;
}
