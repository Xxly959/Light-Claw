import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
	return {
		schema: 1,
		lock,
		platform: "unverified",
		model: "unverified",
		scope: "local kernel lock only; held does not prove application readiness",
	};
}
