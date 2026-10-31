import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { SandboxConfig } from "../sandbox.js";

export function physicalPath(path: string): string {
	const target = resolve(path);
	if (existsSync(target)) {
		if (lstatSync(target).isSymbolicLink()) throw new Error("控制路径禁止符号链接");
		return realpathSync(target);
	}
	return join(physicalPath(dirname(target)), target.slice(dirname(target).length + 1));
}
export function isWithin(root: string, path: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
export function resolveControlDirectory(workspaceDir: string, configured?: string): string {
	const workspace = physicalPath(workspaceDir);
	const target = physicalPath(
		configured ?? join(homedir(), ".pi/lightclaw/control", createHash("sha256").update(workspace).digest("hex")),
	);
	if (isWithin(workspace, target) || isWithin(target, workspace))
		throw new Error("控制目录必须在工作区外，且不能包含工作区");
	return target;
}
export function resolveControlChannelDirectory(controlDir: string, channelId: string): string {
	assertChannelId(channelId);
	const target = join(controlDir, channelId);
	if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error("频道控制目录禁止符号链接");
	return target;
}
export function assertChannelId(channelId: string): void {
	if (
		!channelId ||
		channelId === "." ||
		channelId === ".." ||
		channelId === ".migrations" ||
		/[\\/\0]/.test(channelId)
	)
		throw new Error("非法频道 ID");
}

export async function assertControlIsolation(
	workspaceDir: string,
	controlDir: string,
	sandbox: SandboxConfig,
): Promise<void> {
	const control = resolveControlDirectory(workspaceDir, controlDir);
	if (sandbox.type !== "docker") return;
	const result: unknown = JSON.parse(
		execFileSync("docker", ["inspect", sandbox.container], {
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
		}),
	);
	if (
		!Array.isArray(result) ||
		result.length !== 1 ||
		typeof result[0] !== "object" ||
		result[0] === null ||
		!Array.isArray(result[0].Mounts)
	)
		throw new Error("Docker inspect 输出缺少 Mounts");
	let workspaceMounted = false;
	const workspace = physicalPath(workspaceDir);
	for (const mount of result[0].Mounts) {
		// Docker reports tmpfs with Source:""; only the dedicated scratch mount has no host source.
		if (
			typeof mount === "object" &&
			mount !== null &&
			mount.Type === "tmpfs" &&
			mount.Source === "" &&
			mount.Destination === "/tmp"
		)
			continue;
		if (
			typeof mount !== "object" ||
			mount === null ||
			typeof mount.Source !== "string" ||
			!mount.Source.startsWith("/") ||
			typeof mount.Destination !== "string" ||
			!mount.Destination.startsWith("/")
		)
			throw new Error("Docker mount Source 非法");
		const source = realpathSync(mount.Source);
		if (isWithin(source, control) || isWithin(control, source)) throw new Error("Docker 挂载暴露控制目录，拒绝启动");
		const destination = resolve(mount.Destination);
		if (destination === "/workspace") {
			if (workspaceMounted || source !== workspace) throw new Error("Docker /workspace 必须映射当前工作区");
			workspaceMounted = true;
		} else if (isWithin("/workspace", destination) || isWithin(destination, "/workspace"))
			throw new Error("Docker 嵌套挂载遮蔽工作区");
	}
	if (!workspaceMounted) throw new Error("Docker 缺少当前工作区的 /workspace 挂载");
}
/** Kernel flock is attached to the shared open-file-description, not the helper PID. */
export function acquireControlLock(controlDir: string): { release(): void } {
	const root = physicalPath(controlDir);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const path = join(root, "instance.lock");
	const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1) throw new Error("锁文件必须是单链接普通文件");
		// Node retains fd; helper fd 3 is a duplicate of the SAME open description.
		// flock remains held after helper exit, and the kernel releases it on parent exit.
		execFileSync("python3", ["-I", "-c", "import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)"], {
			stdio: ["ignore", "pipe", "pipe", fd],
			timeout: 5000,
		});
	} catch (error) {
		closeSync(fd);
		throw new Error(`控制目录锁不可用：${path}；已有活实例或宿主Python/POSIX锁不可用`, { cause: error });
	}
	let released = false;
	return {
		release() {
			if (!released) {
				released = true;
				closeSync(fd);
			}
		},
	};
}
