import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { hrtime } from "node:process";
import type { BenchmarkPhase, ResourceSample } from "./types.js";

export class ResourceSampler {
	private readonly samples: ResourceSample[] = [];
	private timer: NodeJS.Timeout | undefined;
	private startedAtNs = 0n;
	private previousAtNs = 0n;
	private previousCpu = process.cpuUsage();
	private histogram: IntervalHistogram | undefined;
	private started = false;

	constructor(
		private readonly metadata: {
			runId: string;
			phase: BenchmarkPhase;
			concurrency: number;
			round: number;
		},
		private readonly intervalMs: number,
	) {
		if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
			throw new Error("resource sample interval must be a valid positive timer duration");
		}
	}

	start(): void {
		if (this.started) throw new Error("resource sampler already started");
		this.started = true;
		this.histogram = monitorEventLoopDelay({ resolution: Math.min(this.intervalMs, 10) });
		this.histogram.enable();
		this.startedAtNs = hrtime.bigint();
		this.previousAtNs = this.startedAtNs;
		this.previousCpu = process.cpuUsage();
		this.capture(true);
		this.timer = setInterval(() => this.capture(false, true), this.intervalMs);
	}

	stop(): ResourceSample[] {
		if (!this.started) throw new Error("resource sampler has not started");
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
			try {
				this.capture(false);
			} finally {
				this.histogram?.disable();
			}
		}
		return [...this.samples];
	}

	private capture(initial: boolean, periodic = false): void {
		const now = hrtime.bigint();
		const cpu = process.cpuUsage();
		const intervalNs = initial ? 0n : now - this.previousAtNs;
		const userMicros = initial ? 0 : cpu.user - this.previousCpu.user;
		const systemMicros = initial ? 0 : cpu.system - this.previousCpu.system;
		const intervalMicros = Number(intervalNs) / 1000;
		const memory = process.memoryUsage();
		const eventLoopDelaySamples = initial ? 0 : (this.histogram?.count ?? 0);
		this.samples.push({
			...this.metadata,
			offsetNs: (now - this.startedAtNs).toString(),
			rssBytes: memory.rss,
			heapUsedBytes: memory.heapUsed,
			cpuUserMicros: userMicros,
			cpuSystemMicros: systemMicros,
			intervalNs: intervalNs.toString(),
			cpuPercentOneCore: intervalMicros > 0 ? ((userMicros + systemMicros) / intervalMicros) * 100 : 0,
			eventLoopDelaySamples,
			maxEventLoopDelayMs: eventLoopDelaySamples > 0 && this.histogram ? this.histogram.max / 1_000_000 : null,
			sampleLagMs: periodic ? Math.max(0, Number(intervalNs) / 1_000_000 - this.intervalMs) : 0,
		});
		// Resetting before the first observation restarts Node's histogram timer;
		// fast resource sampling would otherwise prevent it from ever collecting.
		if (eventLoopDelaySamples > 0) this.histogram?.reset();
		this.previousAtNs = now;
		this.previousCpu = cpu;
	}
}
