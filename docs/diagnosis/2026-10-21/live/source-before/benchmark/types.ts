export type BenchmarkPhase = "warmup" | "measurement";

export interface BenchmarkConfig {
	channels: number[];
	warmupRounds: number;
	measurementRounds: number;
	tasksPerChannel: number;
	modelDelayMs: number;
	toolDelayMs: number;
	resourceSampleMs: number;
}

export interface DockerEnvironment {
	available: boolean;
	benchmarkUsesDocker: false;
	clientVersion?: string;
	serverVersion?: string;
	desktopCpuCount?: number;
	desktopMemoryBytes?: number;
}

export interface BenchmarkEnvironment {
	nodeVersion: string;
	platform: string;
	release: string;
	arch: string;
	cpuModel: string;
	logicalCpuCount: number;
	hostMemoryBytes: number;
	docker: DockerEnvironment;
}

export interface BenchmarkSource {
	revision: string;
	dirty: boolean;
	sourceSha256: string;
}

export interface TaskSample {
	runId: string;
	phase: BenchmarkPhase;
	concurrency: number;
	round: number;
	channelId: string;
	taskId: string;
	channelTaskIndex: number;
	enqueuedAtNs: string;
	startedAtNs: string;
	completedAtNs: string;
	modelWaitNs: string[];
	toolWaitNs: string[];
	status: "completed" | "error";
	stopReason: string;
	toolCalls: number;
	toolErrors: number;
	errorMessage?: string;
}

export interface RoundSample {
	runId: string;
	phase: BenchmarkPhase;
	concurrency: number;
	round: number;
	startedAtNs: string;
	completedAtNs: string;
	plannedTasks: number;
	acceptedTasks: number;
	completedTasks: number;
	errorTasks: number;
	maxActiveChannels: number;
}

export interface ResourceSample {
	runId: string;
	phase: BenchmarkPhase;
	concurrency: number;
	round: number;
	offsetNs: string;
	rssBytes: number;
	heapUsedBytes: number;
	cpuUserMicros: number;
	cpuSystemMicros: number;
	intervalNs: string;
	cpuPercentOneCore: number;
	eventLoopDelaySamples: number;
	maxEventLoopDelayMs: number | null;
	sampleLagMs: number;
}

export interface LatencyStatistics {
	p50: number;
	p95: number;
	p99: number;
	max: number;
}

export interface BenchmarkMetrics {
	concurrency: number;
	roundSamples: number;
	taskSamples: number;
	throughputTasksPerSecond: number;
	errorRate: number;
	queueWaitMs: LatencyStatistics;
	endToEndMs: LatencyStatistics;
	modelWaitMs: LatencyStatistics;
	toolWaitMs: LatencyStatistics;
	runtimeOverheadMs: LatencyStatistics;
	peakCpuPercentOneCore: number;
	peakRssBytes: number;
	peakRssDeltaBytes: number;
	peakHeapUsedBytes: number;
	maxActiveChannels: number;
	maxEventLoopDelayMs: number | null;
	maxSampleLagMs: number;
}

export interface BenchmarkRoundSummary extends BenchmarkMetrics {
	round: number;
	durationMs: number;
	plannedTasks: number;
	acceptedTasks: number;
}

export interface BenchmarkLevelSummary extends BenchmarkMetrics {
	rounds: BenchmarkRoundSummary[];
}

export interface BenchmarkSummary {
	schemaVersion: 2;
	runId: string;
	measuredTaskSamples: number;
	levels: BenchmarkLevelSummary[];
}

export interface BenchmarkArtifacts {
	directory: string;
	manifestPath: string;
	tasksPath: string;
	roundsPath: string;
	resourcesPath: string;
	summaryPath: string;
	reportPath: string;
}
