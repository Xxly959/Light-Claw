#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectBenchmarkEnvironment, collectBenchmarkSource, isUnsafeOutputDirectory } from "./environment.js";
import { writeBenchmarkArtifacts } from "./report.js";
import type { BenchmarkConfig } from "./types.js";
import { runBenchmarkWorkload } from "./workload.js";

const ALLOWED_CHANNEL_LEVELS = new Set([1, 5, 10, 20]);

const DEFAULT_CONFIG: BenchmarkConfig = {
	channels: [1, 5, 10, 20],
	warmupRounds: 2,
	measurementRounds: 10,
	tasksPerChannel: 5,
	modelDelayMs: 25,
	toolDelayMs: 10,
	resourceSampleMs: 10,
};

export interface ParsedBenchmarkArgs {
	config: BenchmarkConfig;
	outputDirectory: string;
}

function integer(value: string, name: string, minimum: number): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum) {
		if (minimum === 1) throw new Error(`${name} must be a positive integer`);
		throw new Error(`${name} must be an integer of at least ${minimum}`);
	}
	return parsed;
}

function nonNegativeInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
	return parsed;
}

export function parseBenchmarkArgs(args: string[], cwd = process.cwd()): ParsedBenchmarkArgs {
	const config: BenchmarkConfig = { ...DEFAULT_CONFIG, channels: [...DEFAULT_CONFIG.channels] };
	let outputDirectory = resolve(cwd, "../../lightclaw-data/benchmarks");
	for (const argument of args) {
		const separator = argument.indexOf("=");
		if (!argument.startsWith("--") || separator < 3) throw new Error(`unknown benchmark argument: ${argument}`);
		const name = argument.slice(2, separator);
		const value = argument.slice(separator + 1);
		switch (name) {
			case "channels": {
				const channels = value.split(",").map(Number);
				if (
					channels.length === 0 ||
					channels.some((channel) => !ALLOWED_CHANNEL_LEVELS.has(channel)) ||
					new Set(channels).size !== channels.length
				) {
					throw new Error("channels must contain only 1, 5, 10, or 20 without duplicates");
				}
				config.channels = channels;
				break;
			}
			case "warmup-rounds":
				config.warmupRounds = integer(value, name, 1);
				break;
			case "measurement-rounds":
				config.measurementRounds = integer(value, name, 2);
				break;
			case "tasks-per-channel":
				config.tasksPerChannel = integer(value, name, 1);
				break;
			case "model-delay-ms":
				config.modelDelayMs = nonNegativeInteger(value, name);
				break;
			case "tool-delay-ms":
				config.toolDelayMs = nonNegativeInteger(value, name);
				break;
			case "resource-sample-ms":
				config.resourceSampleMs = integer(value, name, 1);
				break;
			case "output":
				outputDirectory = resolve(cwd, value);
				break;
			default:
				throw new Error(`unknown benchmark argument: --${name}`);
		}
	}
	if (isUnsafeOutputDirectory(outputDirectory)) throw new Error(`unsafe output directory: ${outputDirectory}`);
	return { config, outputDirectory };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const parsed = parseBenchmarkArgs(args);
	const startedAt = new Date().toISOString();
	const runId = `benchmark-${startedAt.replace(/[:.]/g, "-")}`;
	const runDirectory = join(parsed.outputDirectory, runId);
	const temporaryWorkspace = await mkdtemp(join(tmpdir(), "lightclaw-benchmark-"));
	try {
		const [environment, source] = await Promise.all([
			collectBenchmarkEnvironment(process.cwd()),
			collectBenchmarkSource(process.cwd()),
		]);
		const workload = await runBenchmarkWorkload(runId, parsed.config, temporaryWorkspace);
		const artifacts = await writeBenchmarkArtifacts({
			outputDirectory: runDirectory,
			runId,
			startedAt,
			completedAt: new Date().toISOString(),
			config: parsed.config,
			environment,
			source,
			...workload,
		});
		process.stdout.write(`${JSON.stringify(artifacts, null, 2)}\n`);
	} finally {
		await rm(temporaryWorkspace, { recursive: true, force: true });
	}
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
