import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { arch, cpus, homedir, platform, release, totalmem } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BenchmarkEnvironment, BenchmarkSource } from "./types.js";

const execFileAsync = promisify(execFile);

async function command(commandName: string, args: string[], cwd: string): Promise<string> {
	const result = await execFileAsync(commandName, args, { cwd, encoding: "utf8" });
	return result.stdout.trim();
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

export async function collectBenchmarkSource(_cwd: string): Promise<BenchmarkSource> {
	const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
	let directory = join(packageRoot, "src");
	try {
		await access(directory);
	} catch {
		directory = join(packageRoot, "dist");
	}
	const walk = async (root: string): Promise<string[]> => {
		const entries = await readdir(root, { withFileTypes: true });
		const groups = await Promise.all(
			entries.map((entry) =>
				entry.isDirectory()
					? walk(join(root, entry.name))
					: Promise.resolve(
							entry.isFile() && /\.(?:ts|js|py|json)$/.test(entry.name) ? [join(root, entry.name)] : [],
						),
			),
		);
		return groups.flat();
	};
	const files = [...(await walk(directory)), join(packageRoot, "package.json")].sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(relative(packageRoot, file));
		hash.update("\0");
		hash.update(await readFile(file));
		hash.update("\0");
	}
	let revision = "installed-package-no-git",
		dirty = false;
	try {
		revision = await command("git", ["rev-parse", "HEAD"], packageRoot);
		dirty = (await command("git", ["status", "--porcelain=v1", "--", "."], packageRoot)).length > 0;
	} catch {
		/* An installed package has no repository. The artifact hash is still recorded. */
	}
	return { revision, dirty, sourceSha256: hash.digest("hex") };
}

export function isUnsafeOutputDirectory(path: string): boolean {
	return path === "/" || path === homedir();
}
