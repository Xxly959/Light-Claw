import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";

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
	console.error(`Error: Invalid sandbox type '${value}'. Use 'host' or 'docker:<container-name>'`);
	process.exit(1);
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
	if (config.type === "host") {
		return;
	}

	// Check if Docker is available
	try {
		await execSimple("docker", ["--version"]);
	} catch {
		console.error("Error: Docker is not installed or not in PATH");
		process.exit(1);
	}

	// Check if container exists and is running
	try {
		const result = await execSimple("docker", ["inspect", "-f", "{{.State.Running}}", config.container]);
		if (result.trim() !== "true") {
			console.error(`Error: Container '${config.container}' is not running.`);
			console.error(`Start it with: docker start ${config.container}`);
			process.exit(1);
		}
	} catch {
		console.error(`Error: Container '${config.container}' does not exist.`);
		console.error("Create it with: ./docker.sh create <data-dir>");
		process.exit(1);
	}

	console.log(`  Docker container '${config.container}' is running.`);
}

function execSimple(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => {
			stdout += d;
		});
		child.stderr?.on("data", (d) => {
			stderr += d;
		});
		child.on("error", reject);
		child.on("close", (code) => {
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
		return new Promise((resolve, reject) => {
			const shell = process.platform === "win32" ? "cmd" : "sh";
			const shellArgs = process.platform === "win32" ? ["/c"] : ["-c"];

			const child = spawn(shell, [...shellArgs, command], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let executionError: Error | undefined;
			let archiveError: unknown;
			let archive: WriteStream | undefined;
			let archiveDone: Promise<void> | undefined;
			let fullOutputPath: string | undefined;

			const kill = () => {
				if (child.pid) killProcessTree(child.pid);
			};
			const writeArchive = (data: string) => {
				if (archive && !archive.write(data)) {
					child.stdout?.pause();
					child.stderr?.pause();
				}
			};
			const collect = (kind: "stdout" | "stderr", data: string) => {
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
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}
				if (archive) archive.end();
				await archiveDone;
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

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}
}

class DockerExecutor implements Executor {
	constructor(
		private container: string,
		private readonly defaultTimeoutSeconds: number,
	) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		// 容器名经过白名单校验，命令正文经过 shell 转义，避免宿主机命令注入。
		const dockerCmd = `docker exec ${this.container} sh -c ${shellEscape(command)}`;
		const hostExecutor = new HostExecutor(this.defaultTimeoutSeconds);
		return hostExecutor.exec(dockerCmd, options);
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
