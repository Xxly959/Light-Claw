import type {
	BenchmarkConfig,
	BenchmarkLevelSummary,
	BenchmarkMetrics,
	BenchmarkSummary,
	LatencyStatistics,
	ResourceSample,
	RoundSample,
	TaskSample,
} from "./types.js";

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const NANOSECONDS_PER_SECOND = 1_000_000_000;

export function nearestRank(values: number[], percentile: number): number {
	if (values.length === 0) throw new Error("percentile requires at least one value");
	if (percentile <= 0 || percentile > 1) throw new Error("percentile must be greater than 0 and at most 1");
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(percentile * sorted.length) - 1];
}

function nanosecondsBetween(start: string, end: string): number {
	return Number(BigInt(end) - BigInt(start));
}

function nanosecondsToMilliseconds(value: bigint | number): number {
	return Number(value) / NANOSECONDS_PER_MILLISECOND;
}

function sumNanoseconds(values: string[]): number {
	return nanosecondsToMilliseconds(values.reduce((sum, value) => sum + BigInt(value), 0n));
}

function percentiles(values: number[]): LatencyStatistics {
	return {
		p50: nearestRank(values, 0.5),
		p95: nearestRank(values, 0.95),
		p99: nearestRank(values, 0.99),
		max: Math.max(...values),
	};
}

function summarizeMetrics(
	concurrency: number,
	tasks: TaskSample[],
	rounds: RoundSample[],
	resources: ResourceSample[],
): BenchmarkMetrics {
	if (tasks.length === 0 || rounds.length === 0) {
		throw new Error(`missing measurement samples for concurrency ${concurrency}`);
	}
	if (resources.length === 0) throw new Error(`missing resource samples for concurrency ${concurrency}`);
	for (const sample of resources) {
		if (
			!Number.isSafeInteger(sample.eventLoopDelaySamples) ||
			sample.eventLoopDelaySamples < 0 ||
			!Number.isFinite(sample.sampleLagMs) ||
			sample.sampleLagMs < 0 ||
			(sample.eventLoopDelaySamples === 0
				? sample.maxEventLoopDelayMs !== null
				: typeof sample.maxEventLoopDelayMs !== "number" ||
					!Number.isFinite(sample.maxEventLoopDelayMs) ||
					sample.maxEventLoopDelayMs < 0)
		) {
			throw new Error("resource samples require schema 2 event-loop and sample-lag measurements");
		}
	}
	const queueWait = tasks.map((task) =>
		nanosecondsToMilliseconds(nanosecondsBetween(task.enqueuedAtNs, task.startedAtNs)),
	);
	const endToEnd = tasks.map((task) =>
		nanosecondsToMilliseconds(nanosecondsBetween(task.enqueuedAtNs, task.completedAtNs)),
	);
	const service = tasks.map((task) =>
		nanosecondsToMilliseconds(nanosecondsBetween(task.startedAtNs, task.completedAtNs)),
	);
	const modelWait = tasks.map((task) => sumNanoseconds(task.modelWaitNs));
	const toolWait = tasks.map((task) => sumNanoseconds(task.toolWaitNs));
	const runtimeOverhead = service.map((duration, index) => duration - modelWait[index] - toolWait[index]);
	if (runtimeOverhead.some((value) => value < 0)) {
		throw new Error(`negative runtime overhead for concurrency ${concurrency}`);
	}
	const roundDurationNs = rounds.reduce(
		(sum, round) => sum + nanosecondsBetween(round.startedAtNs, round.completedAtNs),
		0,
	);
	const completedTasks = rounds.reduce((sum, round) => sum + round.completedTasks, 0);
	const peakRssBytes = Math.max(...resources.map((sample) => sample.rssBytes));
	const peakHeapUsedBytes = Math.max(...resources.map((sample) => sample.heapUsedBytes));
	const peakRssDeltaBytes = Math.max(
		...rounds.map((round) => {
			const samples = resources.filter((sample) => sample.round === round.round);
			if (samples.length === 0) return 0;
			return Math.max(...samples.map((sample) => sample.rssBytes)) - samples[0].rssBytes;
		}),
	);
	const delays = resources.flatMap((sample) =>
		sample.maxEventLoopDelayMs === null ? [] : [sample.maxEventLoopDelayMs],
	);

	return {
		concurrency,
		roundSamples: rounds.length,
		taskSamples: tasks.length,
		throughputTasksPerSecond: completedTasks / (roundDurationNs / NANOSECONDS_PER_SECOND),
		errorRate: tasks.filter((task) => task.status === "error").length / tasks.length,
		queueWaitMs: percentiles(queueWait),
		endToEndMs: percentiles(endToEnd),
		modelWaitMs: percentiles(modelWait),
		toolWaitMs: percentiles(toolWait),
		runtimeOverheadMs: percentiles(runtimeOverhead),
		peakCpuPercentOneCore: Math.max(...resources.map((sample) => sample.cpuPercentOneCore)),
		peakRssBytes,
		peakRssDeltaBytes,
		peakHeapUsedBytes,
		maxActiveChannels: Math.max(...rounds.map((round) => round.maxActiveChannels)),
		maxEventLoopDelayMs: delays.length === 0 ? null : Math.max(...delays),
		maxSampleLagMs: Math.max(...resources.map((sample) => sample.sampleLagMs)),
	};
}

function summarizeLevel(
	concurrency: number,
	tasks: TaskSample[],
	rounds: RoundSample[],
	resources: ResourceSample[],
): BenchmarkLevelSummary {
	return {
		...summarizeMetrics(concurrency, tasks, rounds, resources),
		rounds: rounds.map((round) => ({
			...summarizeMetrics(
				concurrency,
				tasks.filter((task) => task.round === round.round),
				[round],
				resources.filter((sample) => sample.round === round.round),
			),
			round: round.round,
			durationMs: nanosecondsToMilliseconds(nanosecondsBetween(round.startedAtNs, round.completedAtNs)),
			plannedTasks: round.plannedTasks,
			acceptedTasks: round.acceptedTasks,
		})),
	};
}

export function summarizeBenchmark(
	runId: string,
	config: BenchmarkConfig,
	tasks: TaskSample[],
	rounds: RoundSample[],
	resources: ResourceSample[],
): BenchmarkSummary {
	const measuredTasks = tasks.filter((sample) => sample.phase === "measurement");
	const measuredRounds = rounds.filter((sample) => sample.phase === "measurement");
	const measuredResources = resources.filter((sample) => sample.phase === "measurement");
	return {
		schemaVersion: 2,
		runId,
		measuredTaskSamples: measuredTasks.length,
		levels: config.channels.map((concurrency) =>
			summarizeLevel(
				concurrency,
				measuredTasks.filter((sample) => sample.concurrency === concurrency),
				measuredRounds.filter((sample) => sample.concurrency === concurrency),
				measuredResources.filter((sample) => sample.concurrency === concurrency),
			),
		),
	};
}
