import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { arch, cpus, homedir, platform, release, totalmem } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { BenchmarkEnvironment, BenchmarkSource } from "./types.js";

const execFileAsync = promisify(execFile);

async function command(commandName: string, args: string[], cwd: string): Promise<string> {
	const result = await execFileAsync(commandName, args, { cwd, encoding: "utf8" });
	return result.stdout.trim();
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...(await collectTypeScriptFiles(path)));
		else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(path);
	}
	return result;
}

export function parseDockerVersions(output: string): [string, string] {
	const versions = output.trim().split(/\s+/);
	if (versions.length !== 2) throw new Error(`unexpected Docker version output: ${output}`);
	return [versions[0], versions[1]];
}

export async function collectBenchmarkEnvironment(cwd: string): Promise<BenchmarkEnvironment> {
	const docker = { available: false, benchmarkUsesDocker: false as const };
	try {
		const [versions, resources] = await Promise.all([
			command("docker", ["version", "--format", "{{.Client.Version}}\t{{.Server.Version}}"], cwd),
			command("docker", ["info", "--format", "{{.NCPU}}\t{{.MemTotal}}"], cwd),
		]);
		const [clientVersion, serverVersion] = parseDockerVersions(versions);
		const [desktopCpuCount, desktopMemoryBytes] = resources.split(/\s+/).map(Number);
		return {
			nodeVersion: process.version,
			platform: platform(),
			release: release(),
			arch: arch(),
			cpuModel: cpus()[0]?.model ?? "unknown",
			logicalCpuCount: cpus().length,
			hostMemoryBytes: totalmem(),
			docker: {
				available: true,
				benchmarkUsesDocker: false,
				clientVersion,
				serverVersion,
				desktopCpuCount,
				desktopMemoryBytes,
			},
		};
	} catch {
		return {
			nodeVersion: process.version,
			platform: platform(),
			release: release(),
			arch: arch(),
			cpuModel: cpus()[0]?.model ?? "unknown",
			logicalCpuCount: cpus().length,
			hostMemoryBytes: totalmem(),
			docker,
		};
	}
}

export async function collectBenchmarkSource(cwd: string): Promise<BenchmarkSource> {
	const repositoryRoot = await command("git", ["rev-parse", "--show-toplevel"], cwd);
	const packageRoot = join(repositoryRoot, "packages", "lightclaw");
	const files = [
		...(await collectTypeScriptFiles(join(packageRoot, "src"))),
		join(packageRoot, "package.json"),
	].sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(relative(repositoryRoot, file));
		hash.update("\0");
		hash.update(await readFile(file));
		hash.update("\0");
	}
	const [revision, status] = await Promise.all([
		command("git", ["rev-parse", "HEAD"], repositoryRoot),
		command("git", ["status", "--porcelain=v1", "--", "packages/lightclaw"], repositoryRoot),
	]);
	return { revision, dirty: status.length > 0, sourceSha256: hash.digest("hex") };
}

export function isUnsafeOutputDirectory(path: string): boolean {
	return path === "/" || path === homedir();
}
