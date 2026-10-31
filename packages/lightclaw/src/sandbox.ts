import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, readFileSync, realpathSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { diagnosticText } from "./redaction.js";
import { releaseArchiveReservation, reserveArchiveBytes } from "./resource-policy.js";

export type SandboxConfig = { type: "host" } | { type: "docker"; container: string };

export function parseSandboxArg(value: string): SandboxConfig {
	if (value === "host") {
		return { type: "host" };
	}
	if (value.startsWith("docker:")) {
		const container = value.slice("docker:".length);
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) {
			console.error("Error: docker sandbox requires container name (e.g., docker:lightclaw-sandbox)");
			process.exit(1);
		}
		return { type: "docker", container };
	}
	console.error(`Error: Invalid sandbox type ${diagnosticText(value)}. Use 'host' or 'docker:<container-name>'`);
	process.exit(1);
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Docker sandbox inspect shape invalid");
	return value as Record<string, unknown>;
}
function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export async function validateSandbox(config: SandboxConfig, workspaceDir?: string): Promise<void> {
	if (config.type === "host") {
		return;
	}

	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(config.container)) throw new Error("Docker sandbox container name invalid");
	await execSimple("docker", ["--version"]);
	// Docker CLI inspect returns an array with Config, HostConfig, State and Mounts.
	const inspected: unknown = JSON.parse(await execSimple("docker", ["inspect", config.container]));
	if (!Array.isArray(inspected) || inspected.length !== 1)
		throw new Error("Docker sandbox inspect expected one container");
	const details = object(inspected[0]);
	if (object(details.State).Running !== true) throw new Error("Docker sandbox container must be running");
	const user = object(details.Config).User;
	if (typeof user !== "string" || !user.trim() || /^(root|0+)(:|$)/.test(user))
		throw new Error("Docker sandbox requires configured non-root user");
	const host = object(details.HostConfig);
	if (
		host.Privileged !== false ||
		!Array.isArray(host.CapDrop) ||
		!host.CapDrop.includes("ALL") ||
		(host.CapAdd != null && (!Array.isArray(host.CapAdd) || host.CapAdd.length > 0)) ||
		!Array.isArray(host.SecurityOpt) ||
		!host.SecurityOpt.some((item) => item === "no-new-privileges" || item === "no-new-privileges:true") ||
		host.SecurityOpt.some((item) => typeof item !== "string" || /unconfined|label:disable/.test(item))
	) {
		throw new Error("Docker sandbox requires no privilege/capability escalation and no-new-privileges");
	}
	if (
		typeof host.NetworkMode !== "string" ||
		!host.NetworkMode.trim() ||
		host.NetworkMode === "host" ||
		host.NetworkMode.startsWith("container:") ||
		[host.PidMode, host.IpcMode, host.UTSMode, host.UsernsMode, host.CgroupnsMode].some(
			(mode) => mode != null && mode !== "" && mode !== "private",
		) ||
		[host.Devices, host.DeviceRequests].some(
			(devices) => devices != null && (!Array.isArray(devices) || devices.length > 0),
		)
	) {
		throw new Error("Docker sandbox rejects host namespaces, host network and device passthrough");
	}
	const boundedCpu = positive(host.NanoCpus) || (positive(host.CpuQuota) && positive(host.CpuPeriod));
	if (
		!boundedCpu ||
		!positive(host.Memory) ||
		!positive(host.MemorySwap) ||
		host.MemorySwap !== host.Memory ||
		!positive(host.PidsLimit)
	) {
		throw new Error("Docker sandbox requires bounded CPU, memory, memory-swap and PIDs (docker.sh contract)");
	}
	if (!Array.isArray(details.Mounts)) throw new Error("Docker sandbox inspect missing mounts");
	let workspaceMounted = false;
	for (const entry of details.Mounts) {
		const mount = object(entry);
		if (mount.Type === "tmpfs" && mount.Destination === "/tmp") continue;
		if (
			mount.Type !== "bind" ||
			mount.Destination !== "/workspace" ||
			workspaceMounted ||
			typeof mount.Source !== "string" ||
			!mount.Source.startsWith("/") ||
			resolve(mount.Source) === "/" ||
			/^\/(?:etc|proc|sys|dev|run|root|var\/run)(?:\/|$)/.test(resolve(mount.Source)) ||
			(mount.Propagation !== undefined && mount.Propagation !== "rprivate" && mount.Propagation !== "private")
		) {
			throw new Error("Docker sandbox rejects unsafe/non-workspace mount");
		}
		if (workspaceDir && realpathSync(mount.Source) !== realpathSync(workspaceDir))
			throw new Error("Docker sandbox workspace mount must match current workspace");
		workspaceMounted = true;
	}
	if (!workspaceMounted) throw new Error("Docker sandbox missing workspace mount");
	const uid = (await execSimple("docker", ["exec", config.container, "id", "-u"])).trim();
	if (!/^\d+$/.test(uid) || Number(uid) === 0) throw new Error("Docker sandbox actual UID must be non-root");
	const groups = (await execSimple("docker", ["exec", config.container, "id", "-G"])).trim().split(/\s+/);
	if (!groups.length || groups.some((group) => !/^\d+$/.test(group) || Number(group) === 0))
		throw new Error("Docker sandbox actual groups must exclude root");
	console.log(`  Docker container '${config.container}' passed startup policy validation.`);
}

function execSimple(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let bytes = 0;
		let settled = false;
		const fail = (error: Error, terminate = false) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (terminate) child.kill("SIGKILL");
			reject(error);
		};
		const timer = setTimeout(
			() => fail(new Error("Docker sandbox startup probe timed out after 10000ms"), true),
			10_000,
		);
		const collect = (kind: "stdout" | "stderr", data: Buffer | string) => {
			if (settled) return;
			bytes += Buffer.byteLength(data);
			if (bytes > 1024 * 1024) {
				fail(new Error("Docker sandbox startup probe output exceeded 1MiB limit"), true);
				return;
			}
			if (kind === "stdout") stdout += data.toString();
			else stderr += data.toString();
		};
		child.stdout?.on("data", (data: Buffer | string) => collect("stdout", data));
		child.stderr?.on("data", (data: Buffer | string) => collect("stderr", data));
		child.on("error", (error) => fail(error));
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `Exit code ${code}`));
		});
	});
}

/**
 * Create an executor that runs commands either on host or in Docker container
 */
export function createExecutor(config: SandboxConfig, defaultTimeoutSeconds = 120): Executor {
	if (config.type === "host") {
		return new HostExecutor(defaultTimeoutSeconds);
	}
	return new DockerExecutor(config.container, defaultTimeoutSeconds);
}

export interface Executor {
	/**
	 * Execute a bash command
	 */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;

	/**
	 * Get the workspace path prefix for this executor
	 * Host: returns the actual path
	 * Docker: returns /workspace
	 */
	getWorkspacePath(hostPath: string): string;
}

export interface ExecOptions {
	timeout?: number;
	signal?: AbortSignal;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	outputTruncated?: boolean;
	fullOutputPath?: string;
}

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
export const MAX_EXEC_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

function captureTail(text: string): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= MAX_CAPTURE_BYTES) return text;
	let start = bytes.length - MAX_CAPTURE_BYTES;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

class HostExecutor implements Executor {
	constructor(private readonly defaultTimeoutSeconds: number) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		options = { ...options, timeout: options?.timeout ?? this.defaultTimeoutSeconds };
		if (options?.signal?.aborted) throw new Error("Command aborted", { cause: options.signal.reason });
		if (
			options?.timeout !== undefined &&
			(!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout > MAX_EXEC_TIMEOUT_SECONDS)
		) {
			throw new Error("Command timeout must be a positive finite number within the Node timer range");
		}
		const shell = process.platform === "win32" ? "cmd" : "sh";
		return executeProcess(shell, [process.platform === "win32" ? "/c" : "-c", command], options);
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}
}

interface ProcessHooks {
	cancel(): Promise<void>;
}
function executeProcess(
	program: string,
	args: string[],
	options: ExecOptions,
	hooks?: ProcessHooks,
): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { detached: true, stdio: [hooks ? "pipe" : "ignore", "pipe", "pipe"] });
		child.stdin?.on("error", () => {});
		const heartbeat = hooks
			? setInterval(() => {
					if (!child.stdin?.destroyed) child.stdin?.write("alive\n");
				}, 250)
			: undefined;
		heartbeat?.unref();

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let executionError: Error | undefined;
		let archiveError: unknown;
		let archive: WriteStream | undefined;
		let archiveDone: Promise<void> | undefined;
		let fullOutputPath: string | undefined;

		let stopPromise: Promise<void> | undefined;
		let stopError: unknown;
		const kill = () => {
			if (hooks) {
				stopPromise ??= hooks
					.cancel()
					.catch((error) => {
						stopError = error;
					})
					.finally(() => {
						if (child.pid) killProcessTree(child.pid);
					});
			} else if (child.pid) killProcessTree(child.pid);
		};
		const writeArchive = (data: string) => {
			if (!archive || archiveError || !fullOutputPath) return;
			try {
				reserveArchiveBytes(fullOutputPath, Buffer.byteLength(data, "utf8"));
				if (!archive.write(data)) {
					child.stdout?.pause();
					child.stderr?.pause();
				}
			} catch (error) {
				archiveError = error;
				kill();
				child.stdout?.resume();
				child.stderr?.resume();
			}
		};
		const collect = (kind: "stdout" | "stderr", data: string) => {
			if (archiveError) return;
			const previous = kind === "stdout" ? stdout : stderr;
			if (!archive && Buffer.byteLength(previous + data, "utf8") > MAX_CAPTURE_BYTES) {
				fullOutputPath = join(tmpdir(), `lightclaw-exec-${randomUUID()}.log`);
				archive = createWriteStream(fullOutputPath, { flags: "wx", mode: 0o600 });
				archive.on("drain", () => {
					child.stdout?.resume();
					child.stderr?.resume();
				});
				archiveDone = finished(archive).catch((error: unknown) => {
					archiveError = error;
					kill();
					child.stdout?.resume();
					child.stderr?.resume();
				});
				writeArchive(stdout && stderr ? `${stdout}\n${stderr}` : stdout || stderr);
			}
			writeArchive(data);
			if (kind === "stdout") stdout = captureTail(stdout + data);
			else stderr = captureTail(stderr + data);
		};

		const timeoutHandle =
			options?.timeout && options.timeout > 0
				? setTimeout(() => {
						timedOut = true;
						kill();
					}, options.timeout * 1000)
				: undefined;

		const onAbort = kill;

		if (options?.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		child.stdout?.setEncoding("utf8").on("data", (data: string) => collect("stdout", data));
		child.stderr?.setEncoding("utf8").on("data", (data: string) => collect("stderr", data));
		child.on("error", (error) => {
			executionError = error;
		});

		const finalize = async (code: number | null) => {
			if (heartbeat) clearInterval(heartbeat);
			child.stdin?.end();
			await stopPromise;
			if (stopError) throw new Error("Container task termination unconfirmed", { cause: stopError });
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (options?.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
			if (archive) archive.end();
			await archiveDone;
			if (fullOutputPath) releaseArchiveReservation(fullOutputPath);
			if (archiveError)
				throw new Error(`Command output archive failed: ${String(archiveError)}`, { cause: archiveError });
			if (executionError) throw executionError;
			const preview = `${stdout}\n${stderr}${fullOutputPath ? `\nFull output: ${fullOutputPath}` : ""}`.trim();
			if (options?.signal?.aborted) {
				throw new Error(`${preview}\nCommand aborted`.trim(), { cause: options.signal.reason });
			}

			if (timedOut) {
				throw new Error(`${preview}\nCommand timed out after ${options?.timeout} seconds`.trim());
			}

			resolve({
				stdout,
				stderr,
				code: code ?? 128,
				outputTruncated: fullOutputPath !== undefined,
				fullOutputPath,
			});
		};
		child.on("close", (code) => {
			void finalize(code).catch(reject);
		});
	});
}

const unconfirmedDockerTasks = new Set<string>();
export function assertNoUnconfirmedDockerTasks(): void {
	if (unconfirmedDockerTasks.size)
		throw new Error(`Container task exit remains unconfirmed: ${[...unconfirmedDockerTasks].join(", ")}`);
}

class DockerExecutor implements Executor {
	constructor(
		private container: string,
		private readonly defaultTimeoutSeconds: number,
	) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(this.container)) throw new Error("Invalid container name");
		const timeout = options?.timeout ?? this.defaultTimeoutSeconds;
		if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_EXEC_TIMEOUT_SECONDS)
			throw new Error("Command timeout must be a positive finite number within the Node timer range");
		if (options?.signal?.aborted) throw new Error("Command aborted", { cause: options.signal.reason });
		const identity = randomUUID();
		const script = readFileSync(fileURLToPath(new URL("../src/docker-supervisor.py", import.meta.url)), "utf8");
		const root = "/tmp/lightclaw-exec";
		const cancel = async () => {
			const result = await new HostExecutor(10).exec(
				`docker exec ${this.container} python3 -I -u -c ${shellEscape(script)} cancel ${identity} ${root}`,
				{ timeout: 10 },
			);
			if (result.code !== 0 || !result.stdout.includes("STOPPED"))
				throw new Error("Container task exit could not be confirmed");
			unconfirmedDockerTasks.delete(identity);
		};
		unconfirmedDockerTasks.add(identity);
		try {
			const result = await executeProcess(
				"docker",
				[
					"exec",
					"-i",
					this.container,
					"python3",
					"-I",
					"-u",
					"-c",
					script,
					"run",
					identity,
					root,
					String(timeout + 1),
					command,
				],
				{ ...options, timeout },
				{ cancel },
			);
			if (result.code !== 0) await cancel();
			unconfirmedDockerTasks.delete(identity);
			return result;
		} catch (error) {
			try {
				if (unconfirmedDockerTasks.has(identity)) await cancel();
			} catch (cleanupError) {
				throw new Error("Container task termination unconfirmed; keep instance locked for inspection", {
					cause: cleanupError,
				});
			}
			throw error;
		}
	}

	getWorkspacePath(_hostPath: string): string {
		// Docker container sees /workspace
		return "/workspace";
	}
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			}).on("error", () => {});
		} catch {
			// Ignore errors
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}

function shellEscape(s: string): string {
	// Escape for passing to sh -c
	return `'${s.replace(/'/g, "'\\''")}'`;
}
