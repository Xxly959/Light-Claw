import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { physicalPath, resolveControlDirectory } from "../goals/control.js";
import { assertResourceCapacity, resourceNumber } from "../resource-policy.js";

export class CriticalAuditError extends Error {}
const roots = new Map<string, string>();
export function configureAuditDirectory(workspace: string, control: string): void {
	roots.set(physicalPath(workspace), join(resolveControlDirectory(workspace, control), ".audit"));
}
export function resolveAuditDirectory(workspace: string): string {
	return (
		roots.get(physicalPath(workspace)) ??
		join(resolveControlDirectory(workspace, process.env.LIGHTCLAW_CONTROL_DIR), ".audit")
	);
}
function assertDirectory(directory: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (physicalPath(directory) !== directory) throw new Error("审计目录路径被替换");
}
function transaction<T>(directory: string, operation: () => T): T {
	assertDirectory(directory);
	const lock = join(directory, ".writer.lock");
	try {
		mkdirSync(lock, { mode: 0o700 });
	} catch {
		throw new Error("审计事务锁占用；检查写入进程或停机残留锁");
	}
	try {
		return operation();
	} finally {
		rmdirSync(lock);
	}
}
function assertFile(path: string): void {
	if (!existsSync(path)) return;
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("审计文件必须为单链接普通文件");
}
/** Critical records fail closed. This retention policy is bounded local evidence, not an immutable archive. */
export function appendManagedAudit(
	workspace: string,
	name: "runs.jsonl" | "tool-calls.jsonl" | "spans.jsonl",
	line: string,
): void {
	const directory = resolveAuditDirectory(workspace);
	try {
		transaction(directory, () => {
			const path = join(directory, name);
			assertFile(path);
			const bytes = Buffer.byteLength(line);
			const segmentLimit = resourceNumber("AUDIT_SEGMENT_MAX_BYTES", 1024 * 1024);
			if (existsSync(path) && lstatSync(path).size + bytes > segmentLimit)
				renameSync(path, `${path}.${Date.now()}-${randomUUID()}`);
			assertResourceCapacity(directory, bytes, "audit");
			const fd = openSync(
				path,
				constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				const info = fstatSync(fd);
				if (!info.isFile() || info.nlink !== 1) throw new Error("审计文件身份非法");
				appendFileSync(fd, line, "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		});
	} catch (error) {
		throw new CriticalAuditError("Critical audit write failed; execution cannot claim complete audit", {
			cause: error,
		});
	}
}
export function writeManagedPayload(workspace: string, run: string, call: string, body: string): string {
	const root = resolveAuditDirectory(workspace);
	try {
		return transaction(root, () => {
			const directory = join(root, "payloads", run);
			assertDirectory(directory);
			const path = join(directory, `${call}.json`);
			assertFile(path);
			assertResourceCapacity(root, Buffer.byteLength(body), "audit");
			// Payload calls are unique. A duplicate must not silently replace its original evidence.
			const fd = openSync(
				path,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				writeFileSync(fd, body, "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			return path;
		});
	} catch (error) {
		throw new CriticalAuditError("Critical audit payload write failed", { cause: error });
	}
}
/** Includes retained segments while preserving the original CLI filters. */
export function readToolAudit(workspace: string): string {
	const directory = resolveAuditDirectory(workspace);
	if (!existsSync(directory)) return "";
	assertDirectory(directory);
	return readdirSync(directory)
		.filter((name) => /^tool-calls\.jsonl(?:\.[a-zA-Z0-9-]+)?$/.test(name))
		.sort((a, b) => (a === "tool-calls.jsonl" ? 1 : b === "tool-calls.jsonl" ? -1 : a.localeCompare(b)))
		.map((name) => {
			const path = join(directory, name);
			assertFile(path);
			return readFileSync(path, "utf8");
		})
		.join("\n");
}
