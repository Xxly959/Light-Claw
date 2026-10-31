import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { summarizeBenchmark } from "./statistics.js";
import type {
	BenchmarkArtifacts,
	BenchmarkConfig,
	BenchmarkEnvironment,
	BenchmarkSource,
	BenchmarkSummary,
	LatencyStatistics,
	ResourceSample,
	RoundSample,
	TaskSample,
} from "./types.js";

function jsonLines(values: unknown[]): string {
	return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

async function readJsonLines<T>(path: string): Promise<T[]> {
	const content = await readFile(path, "utf8");
	return content
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as T);
}

export async function rebuildBenchmarkSummary(
	outputDirectory: string,
	runId: string,
	config: BenchmarkConfig,
): Promise<BenchmarkSummary> {
	const [tasks, rounds, resources] = await Promise.all([
		readJsonLines<TaskSample>(join(outputDirectory, "tasks.jsonl")),
		readJsonLines<RoundSample>(join(outputDirectory, "rounds.jsonl")),
		readJsonLines<ResourceSample>(join(outputDirectory, "resources.jsonl")),
	]);
	return summarizeBenchmark(runId, config, tasks, rounds, resources);
}

async function writeAtomic(path: string, content: string): Promise<void> {
	const temporaryPath = `${path}.tmp`;
	await writeFile(temporaryPath, content, "utf8");
	await rename(temporaryPath, path);
}

function renderMetric(value: number | null, digits = 3): string {
	return value !== null && Number.isFinite(value) ? value.toFixed(digits) : "unavailable";
}

function renderLatency(value: LatencyStatistics): string {
	return [value.p50, value.p95, value.p99, value.max].map((metric) => renderMetric(metric)).join(" / ");
}

export function renderBenchmarkReport(
	summary: BenchmarkSummary,
	config: BenchmarkConfig,
	environment: BenchmarkEnvironment,
): string {
	const rows = summary.levels.map(
		(level) =>
			`| ${level.concurrency} | ${level.taskSamples} | ${renderMetric(level.throughputTasksPerSecond)} | ${renderLatency(level.queueWaitMs)} | ${renderLatency(level.endToEndMs)} | ${renderLatency(level.modelWaitMs)} | ${renderLatency(level.toolWaitMs)} | ${renderLatency(level.runtimeOverheadMs)} | ${renderMetric(level.errorRate * 100)}% | ${renderMetric(level.peakCpuPercentOneCore)}% | ${level.peakRssBytes} | ${level.peakRssDeltaBytes} | ${renderMetric(level.maxEventLoopDelayMs)} | ${renderMetric(level.maxSampleLagMs)} |`,
	);
	const roundRows = summary.levels.flatMap((level) =>
		level.rounds.map(
			(round) =>
				`| ${level.concurrency} | ${round.round} | ${round.acceptedTasks}/${round.plannedTasks} | ${round.taskSamples} | ${renderMetric(round.durationMs)} | ${renderMetric(round.throughputTasksPerSecond)} | ${renderLatency(round.endToEndMs)} | ${renderMetric(round.errorRate * 100)}% | ${renderMetric(round.maxEventLoopDelayMs)} | ${renderMetric(round.maxSampleLagMs)} |`,
		),
	);
	const docker = environment.docker;
	const dockerDetails = docker.available
		? `- Docker available: yes; client ${docker.clientVersion}; server ${docker.serverVersion}; allocated CPUs ${docker.desktopCpuCount}; allocated memory ${docker.desktopMemoryBytes} bytes\n`
		: `- Docker available: no\n`;
	return (
		`# LightClaw faux provider 并发基准\n\n` +
		`本报告仅适用于本次记录的测试环境和参数。faux provider 延迟不是实际模型性能，内存 transport 也不代表 Slack 或飞书 API 性能。\n\n` +
		`## 环境与参数\n\n` +
		`- Node.js: ${environment.nodeVersion}\n` +
		`- Platform: ${environment.platform} ${environment.release} ${environment.arch}\n` +
		`- CPU: ${environment.cpuModel}, ${environment.logicalCpuCount} logical CPUs\n` +
		`- Host memory: ${environment.hostMemoryBytes} bytes\n` +
		dockerDetails +
		`- Docker used by benchmark: no (host Node.js process)\n` +
		`- Channels: ${config.channels.join(", ")}\n` +
		`- Warmup rounds: ${config.warmupRounds}; measurement rounds: ${config.measurementRounds}\n` +
		`- Tasks per channel: ${config.tasksPerChannel}\n` +
		`- Model delay: ${config.modelDelayMs} ms per response; tool delay: ${config.toolDelayMs} ms\n` +
		`- Resource sample interval: ${config.resourceSampleMs} ms\n\n` +
		`## 汇总\n\n` +
		`| Channels | Tasks | Throughput | Queue P50/P95/P99/max ms | E2E P50/P95/P99/max ms | Model wait P50/P95/P99/max ms | Tool wait P50/P95/P99/max ms | Runtime overhead P50/P95/P99/max ms | Error rate | Peak sampled CPU | Peak RSS bytes | Peak RSS delta bytes | Max event loop delay ms | Max sample lag ms |\n` +
		`|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n` +
		`${rows.join("\n")}\n\n` +
		`吞吐量单位为 tasks/s。CPU 为 ${config.resourceSampleMs} ms 间隔下的进程采样峰值，100% 表示一个逻辑核。百分位数从全部正式任务按 nearest-rank 计算，不平均逐轮百分位数。\n\n` +
		`## 逐轮结果\n\n` +
		`| Channels | Round | Accepted/planned | Tasks | Duration ms | Throughput | E2E P50/P95/P99/max ms | Error rate | Max event loop delay ms | Max sample lag ms |\n` +
		`|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n` +
		`${roundRows.join("\n")}\n\n` +
		`事件循环延迟来自 Node monitorEventLoopDelay，分辨率为 min(资源采样间隔, 10) ms；汇总取各窗口最大值，未观测到样本记 unavailable。sample lag 记录周期资源采样相对配置间隔的迟到量，末尾不完整间隔不计迟到。这些观测不能单独确认模型、宿主暂停或其他长尾根因。\n`
	);
}

export async function writeBenchmarkArtifacts(options: {
	outputDirectory: string;
	runId: string;
	startedAt: string;
	completedAt: string;
	config: BenchmarkConfig;
	environment: BenchmarkEnvironment;
	source: BenchmarkSource;
	tasks: TaskSample[];
	rounds: RoundSample[];
	resources: ResourceSample[];
}): Promise<BenchmarkArtifacts> {
	await mkdir(options.outputDirectory, { recursive: true });
	const tasksPath = join(options.outputDirectory, "tasks.jsonl");
	const roundsPath = join(options.outputDirectory, "rounds.jsonl");
	const resourcesPath = join(options.outputDirectory, "resources.jsonl");
	const summaryPath = join(options.outputDirectory, "summary.json");
	const reportPath = join(options.outputDirectory, "report.md");
	const manifestPath = join(options.outputDirectory, "manifest.json");
	const tasksContent = jsonLines(options.tasks);
	const roundsContent = jsonLines(options.rounds);
	const resourcesContent = jsonLines(options.resources);
	await Promise.all([
		writeAtomic(tasksPath, tasksContent),
		writeAtomic(roundsPath, roundsContent),
		writeAtomic(resourcesPath, resourcesContent),
	]);

	const summary = await rebuildBenchmarkSummary(options.outputDirectory, options.runId, options.config);
	const summaryContent = `${JSON.stringify(summary, null, 2)}\n`;
	const reportContent = renderBenchmarkReport(summary, options.config, options.environment);
	await Promise.all([writeAtomic(summaryPath, summaryContent), writeAtomic(reportPath, reportContent)]);

	const manifest = {
		schemaVersion: 2,
		runId: options.runId,
		startedAt: options.startedAt,
		completedAt: options.completedAt,
		config: options.config,
		environment: options.environment,
		source: options.source,
		files: {
			tasks: { path: "tasks.jsonl", records: options.tasks.length, sha256: sha256(tasksContent) },
			rounds: { path: "rounds.jsonl", records: options.rounds.length, sha256: sha256(roundsContent) },
			resources: { path: "resources.jsonl", records: options.resources.length, sha256: sha256(resourcesContent) },
			summary: { path: "summary.json", sha256: sha256(summaryContent) },
			report: { path: "report.md", sha256: sha256(reportContent) },
		},
	};
	await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

	return {
		directory: options.outputDirectory,
		manifestPath,
		tasksPath,
		roundsPath,
		resourcesPath,
		summaryPath,
		reportPath,
	};
}
