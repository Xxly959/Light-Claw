import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveControlDirectory } from "./goals/control.js";

/** A local lock probe; it deliberately makes no platform/model availability claim. */
export function inspectLocalHealth(workspace: string, configuredControl?: string) {
	const control = resolveControlDirectory(workspace, configuredControl),
		path = join(control, "instance.lock");
	let lock: "absent" | "held" | "free" | "unavailable" = "absent";
	if (existsSync(path))
		try {
			const result = execFileSync(
				"python3",
				[
					"-I",
					"-c",
					`import os,fcntl,stat,sys
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW)
s=os.fstat(fd)
if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1: raise ValueError('invalid lock')
try:
 fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
 print('free')
except BlockingIOError: print('held')
finally: os.close(fd)`,
					path,
				],
				{ encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
			).trim();
			lock = result === "held" ? "held" : result === "free" ? "free" : "unavailable";
		} catch {
			lock = "unavailable";
		}

	let processState = "unverified",
		runtime = "unverified",
		platform = "unverified";
	const healthPath = join(control, "health.json");
	if (existsSync(healthPath)) {
		try {
			const fd = openSync(healthPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			let value: unknown;
			try {
				const info = fstatSync(fd);
				if (!info.isFile() || info.nlink !== 1 || info.size > 8192) throw new Error("invalid health state");
				value = JSON.parse(readFileSync(fd, "utf8"));
			} finally {
				closeSync(fd);
			}
			if (!value || typeof value !== "object") throw new Error("invalid health object");
			const state = value as {
				schema?: number;
				pid?: number;
				heartbeatAt?: number;
				ready?: boolean;
				platform?: string;
			};
			if (
				state.schema !== 1 ||
				!Number.isSafeInteger(state.pid) ||
				(state.pid ?? 0) < 1 ||
				!Number.isFinite(state.heartbeatAt) ||
				typeof state.ready !== "boolean"
			)
				throw new Error("invalid health fields");
			try {
				process.kill(state.pid!, 0);
				processState = "alive";
			} catch {
				processState = "dead";
			}
			const age = Date.now() - state.heartbeatAt!;
			if (lock !== "held" || processState !== "alive") runtime = "stopped";
			else if (age < -5000 || age > 30000) runtime = "stale";
			else {
				runtime = state.ready ? "ready" : "starting";
				platform = state.platform ?? "unverified";
			}
		} catch {
			runtime = "unverified";
		}
	}
	return {
		schema: 2,
		lock,
		process: processState,
		runtime,
		platform,
		model: "unverified",
		healthy: runtime === "ready" && platform === "connected",
		scope: "Local heartbeat and native SDK connection status; no external platform/model roundtrip verified",
	};
}
