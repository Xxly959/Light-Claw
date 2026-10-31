import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBenchmarkArgs } from "../src/benchmark/cli.js";
import { parseDockerVersions } from "../src/benchmark/environment.js";
import { rebuildBenchmarkSummary, writeBenchmarkArtifacts } from "../src/benchmark/report.js";
import { nearestRank, summarizeBenchmark } from "../src/benchmark/statistics.js";
import type {
	BenchmarkConfig,
	BenchmarkEnvironment,
	ResourceSample,
	RoundSample,
	TaskSample,
} from "../src/benchmark/types.js";
import { runBenchmarkWorkload } from "../src/benchmark/workload.js";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

const config: BenchmarkConfig = {
	channels: [1],
	warmupRounds: 0,
	measurementRounds: 1,
	tasksPerChannel: 2,
	modelDelayMs: 20,
	toolDelayMs: 10,
	resourceSampleMs: 10,
};

const environment: BenchmarkEnvironment = {
	nodeVersion: "v-test",
	platform: "test",
	release: "test",
	arch: "test",
	cpuModel: "test cpu",
	logicalCpuCount: 4,
	hostMemoryBytes: 1024,
	docker: { available: false, benchmarkUsesDocker: false },
};

function task(overrides: Partial<TaskSample>): TaskSample {
	return {
		runId: "run",
		phase: "measurement",
		concurrency: 1,
		round: 0,
		channelId: "channel-0",
		taskId: "task-0",
		channelTaskIndex: 0,
		enqueuedAtNs: "0",
		startedAtNs: "10000000",
		completedAtNs: "100000000",
		modelWaitNs: ["20000000", "20000000"],
		toolWaitNs: ["10000000"],
		status: "completed",
		stopReason: "stop",
		toolCalls: 1,
		toolErrors: 0,
		...overrides,
	};
}

const tasks: TaskSample[] = [
	task({ taskId: "task-1" }),
	task({
		taskId: "task-2",
		channelTaskIndex: 1,
		startedAtNs: "20000000",
		completedAtNs: "120000000",
		status: "error",
		stopReason: "error",
	}),
];

const rounds: RoundSample[] = [
	{
		runId: "run",
		phase: "measurement",
		concurrency: 1,
		round: 0,
		startedAtNs: "0",
		completedAtNs: "200000000",
		plannedTasks: 2,
		acceptedTasks: 2,
		completedTasks: 2,
		errorTasks: 1,
		maxActiveChannels: 1,
	},
];

const resources: ResourceSample[] = [
	{
		runId: "run",
		phase: "measurement",
		concurrency: 1,
		round: 0,
		offsetNs: "0",
		rssBytes: 100,
		heapUsedBytes: 60,
		cpuUserMicros: 0,
		cpuSystemMicros: 0,
		intervalNs: "0",
		cpuPercentOneCore: 0,
		eventLoopDelaySamples: 0,
		maxEventLoopDelayMs: null,
		sampleLagMs: 0,
	},
	{
		runId: "run",
		phase: "measurement",
		concurrency: 1,
		round: 0,
		offsetNs: "10000000",
		rssBytes: 200,
		heapUsedBytes: 100,
		cpuUserMicros: 6000,
		cpuSystemMicros: 1500,
		intervalNs: "10000000",
		cpuPercentOneCore: 75,
		eventLoopDelaySamples: 2,
		maxEventLoopDelayMs: 18,
		sampleLagMs: 3,
	},
];

describe("benchmark statistics", () => {
	it("uses nearest-rank percentiles", () => {
		expect(nearestRank([40, 10, 30, 20], 0.5)).toBe(20);
		expect(nearestRank([40, 10, 30, 20], 0.95)).toBe(40);
	});

	it("derives latency, throughput, error, CPU, and memory metrics from raw samples", () => {
		const summary = summarizeBenchmark("run", config, tasks, rounds, resources);
		const level = summary.levels[0];

		expect(level.taskSamples).toBe(2);
		expect(level.throughputTasksPerSecond).toBe(10);
		expect(level.errorRate).toBe(0.5);
		expect(level.queueWaitMs).toEqual({ p50: 10, p95: 20, p99: 20, max: 20 });
		expect(level.endToEndMs).toEqual({ p50: 100, p95: 120, p99: 120, max: 120 });
		expect(level.modelWaitMs).toEqual({ p50: 40, p95: 40, p99: 40, max: 40 });
		expect(level.toolWaitMs).toEqual({ p50: 10, p95: 10, p99: 10, max: 10 });
		expect(level.runtimeOverheadMs).toEqual({ p50: 40, p95: 50, p99: 50, max: 50 });
		expect(level.peakCpuPercentOneCore).toBe(75);
		expect(level.peakRssBytes).toBe(200);
		expect(level.peakRssDeltaBytes).toBe(100);
		expect(level.peakHeapUsedBytes).toBe(100);
		expect(level.maxEventLoopDelayMs).toBe(18);
		expect(level.maxSampleLagMs).toBe(3);
		expect(summary.schemaVersion).toBe(2);
		expect(level.rounds[0]).toMatchObject({ round: 0, taskSamples: 2, errorRate: 0.5, durationMs: 200 });
	});

	it("exposes tails hidden by P95 and separates slow measurement rounds", () => {
		const samples = Array.from({ length: 100 }, (_, index) =>
			task({
				taskId: `tail-${index}`,
				round: index < 98 ? 0 : 1,
				completedAtNs: String(BigInt(index < 98 ? 100 : index === 98 ? 1000 : 8000) * 1_000_000n),
			}),
		);
		const roundSamples = [
			{ ...rounds[0], completedTasks: 98, plannedTasks: 98, acceptedTasks: 98, errorTasks: 0 },
			{ ...rounds[0], round: 1, completedAtNs: "8000000000", errorTasks: 0 },
		];
		const level = summarizeBenchmark("run", config, samples, roundSamples, [
			...resources,
			...resources.map((sample) => ({ ...sample, round: 1, maxEventLoopDelayMs: null, eventLoopDelaySamples: 0 })),
		]).levels[0];
		expect(level.endToEndMs).toEqual({ p50: 100, p95: 100, p99: 1000, max: 8000 });
		expect(level.rounds.map((round) => round.endToEndMs.max)).toEqual([100, 8000]);
		expect(level.rounds[1].maxEventLoopDelayMs).toBeNull();
	});

	it("rejects incomplete resources instead of inventing delay or memory measurements", () => {
		expect(() => summarizeBenchmark("run", config, tasks, rounds, [])).toThrow("missing resource samples");
		const legacy = resources.map(({ eventLoopDelaySamples, maxEventLoopDelayMs, sampleLagMs, ...sample }) => sample);
		expect(() => summarizeBenchmark("run", config, tasks, rounds, legacy as ResourceSample[])).toThrow("schema 2");
	});
});

describe("benchmark report", () => {
	it("writes per-record JSONL and derives machine-readable and Markdown summaries", async () => {
		const output = mkdtempSync(join(tmpdir(), "lightclaw-benchmark-report-"));
		temporaryPaths.push(output);

		const artifacts = await writeBenchmarkArtifacts({
			outputDirectory: output,
			runId: "run",
			startedAt: "2026-09-14T00:00:00.000Z",
			completedAt: "2026-09-14T00:00:01.000Z",
			config,
			environment,
			source: { revision: "abc", dirty: true, sourceSha256: "source-hash" },
			tasks,
			rounds,
			resources,
		});

		expect(readFileSync(artifacts.tasksPath, "utf8").trim().split("\n")).toHaveLength(2);
		expect(readFileSync(artifacts.roundsPath, "utf8").trim().split("\n")).toHaveLength(1);
		expect(readFileSync(artifacts.resourcesPath, "utf8").trim().split("\n")).toHaveLength(2);

		const summary = JSON.parse(readFileSync(artifacts.summaryPath, "utf8"));
		const rebuiltSummary = await rebuildBenchmarkSummary(output, "run", config);
		const manifest = JSON.parse(readFileSync(artifacts.manifestPath, "utf8"));
		const report = readFileSync(artifacts.reportPath, "utf8");
		expect(summary.levels[0].endToEndMs.p95).toBe(120);
		expect(rebuiltSummary).toEqual(summary);
		expect(report).toContain("| 1 | 2 | 10.000 |");
		expect(report).toContain("Model wait P50/P95/P99/max ms");
		expect(report).toContain("Tool wait P50/P95/P99/max ms");
		expect(report).toContain("逐轮结果");
		expect(report).toContain("Max event loop delay ms");
		expect(manifest.schemaVersion).toBe(2);
		expect(report).toContain("Docker available: no");
		expect(report).toContain("吞吐量单位为 tasks/s");
		expect(report).toContain("仅适用于本次记录的测试环境");
		expect(manifest.files.tasks.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(manifest.files.tasks.records).toBe(2);
	});
});

describe("benchmark workload", () => {
	it("uses deterministic faux rounds with warmup exclusion and per-channel serialization", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "lightclaw-benchmark-workload-"));
		temporaryPaths.push(workspace);
		const workloadConfig: BenchmarkConfig = {
			channels: [1, 2],
			warmupRounds: 1,
			measurementRounds: 2,
			tasksPerChannel: 2,
			modelDelayMs: 2,
			toolDelayMs: 1,
			resourceSampleMs: 1,
		};

		const result = await runBenchmarkWorkload("workload-run", workloadConfig, workspace);
		const measuredTasks = result.tasks.filter((sample) => sample.phase === "measurement");
		const warmupTasks = result.tasks.filter((sample) => sample.phase === "warmup");

		expect(result.tasks).toHaveLength(18);
		expect(warmupTasks).toHaveLength(6);
		expect(measuredTasks).toHaveLength(12);
		expect(result.rounds).toHaveLength(6);
		expect(result.resources.length).toBeGreaterThan(6);
		expect(result.tasks.every((sample) => sample.modelWaitNs.length === 2)).toBe(true);
		expect(result.tasks.every((sample) => sample.toolWaitNs.length === 1)).toBe(true);
		expect(result.tasks.every((sample) => sample.toolCalls === 1 && sample.toolErrors === 0)).toBe(true);
		expect(result.tasks.every((sample) => sample.status === "completed")).toBe(true);
		expect(result.resources.every((sample) => Number.isFinite(sample.sampleLagMs))).toBe(true);
		expect(result.resources.some((sample) => sample.eventLoopDelaySamples > 0)).toBe(true);

		for (const round of result.rounds) {
			expect(round.acceptedTasks).toBe(round.plannedTasks);
			expect(round.completedTasks).toBe(round.plannedTasks);
		}
		const twoChannelRounds = result.rounds.filter((round) => round.concurrency === 2);
		expect(twoChannelRounds.every((round) => round.maxActiveChannels === 2)).toBe(true);

		for (const channelId of new Set(result.tasks.map((sample) => sample.channelId))) {
			const channelTasks = result.tasks
				.filter((sample) => sample.channelId === channelId)
				.sort((left, right) => left.channelTaskIndex - right.channelTaskIndex);
			for (let index = 1; index < channelTasks.length; index++) {
				if (channelTasks[index].round !== channelTasks[index - 1].round) continue;
				expect(BigInt(channelTasks[index].startedAtNs)).toBeGreaterThanOrEqual(
					BigInt(channelTasks[index - 1].completedAtNs),
				);
			}
		}
	});
});

describe("benchmark CLI", () => {
	it("parses Docker's aligned client and server version output", () => {
		expect(parseDockerVersions("29.7.2              29.7.2")).toEqual(["29.7.2", "29.7.2"]);
	});

	it("parses reproducible workload controls", () => {
		const parsed = parseBenchmarkArgs(
			[
				"--channels=1,5,10,20",
				"--warmup-rounds=3",
				"--measurement-rounds=4",
				"--tasks-per-channel=5",
				"--model-delay-ms=30",
				"--tool-delay-ms=12",
				"--resource-sample-ms=8",
				"--output=benchmark-output",
			],
			"/tmp/lightclaw-cli-test",
		);

		expect(parsed.config).toEqual({
			channels: [1, 5, 10, 20],
			warmupRounds: 3,
			measurementRounds: 4,
			tasksPerChannel: 5,
			modelDelayMs: 30,
			toolDelayMs: 12,
			resourceSampleMs: 8,
		});
		expect(parsed.outputDirectory).toBe("/tmp/lightclaw-cli-test/benchmark-output");
	});

	it("rejects unsupported levels, missing warmup, single measurement, and unsafe output roots", () => {
		expect(() => parseBenchmarkArgs(["--channels=1,2"], "/tmp/lightclaw-cli-test")).toThrow(
			"channels must contain only 1, 5, 10, or 20",
		);
		expect(() => parseBenchmarkArgs(["--warmup-rounds=0"], "/tmp/lightclaw-cli-test")).toThrow(
			"warmup-rounds must be a positive integer",
		);
		expect(() => parseBenchmarkArgs(["--measurement-rounds=1"], "/tmp/lightclaw-cli-test")).toThrow(
			"measurement-rounds must be an integer of at least 2",
		);
		expect(() => parseBenchmarkArgs(["--output=/"], "/tmp/lightclaw-cli-test")).toThrow("unsafe output directory");
	});
});
