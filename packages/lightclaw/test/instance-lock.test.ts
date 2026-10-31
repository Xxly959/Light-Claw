import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { acquireControlLock } from "../src/goals/control.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
	for (const p of children.splice(0)) p.kill("SIGKILL");
	for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function root() {
	const p = mkdtempSync(join(tmpdir(), "lightclaw-lock-"));
	roots.push(p);
	return p;
}
it("reuses a stale file and excludes a live owner without unlinking", () => {
	const dir = root();
	writeFileSync(join(dir, "instance.lock"), "old-crashed-token");
	const first = acquireControlLock(dir);
	try {
		expect(() => acquireControlLock(dir)).toThrow();
	} finally {
		first.release();
	}
	acquireControlLock(dir).release();
});
it.each(["SIGTERM", "SIGKILL"] as const)("kernel releases ownership after owner %s", async (signal) => {
	const dir = root();
	const module = fileURLToPath(new URL("../src/goals/control.ts", import.meta.url));
	const code = `import {acquireControlLock} from ${JSON.stringify(module)}; acquireControlLock(process.argv[1]); console.log("LOCKED");setInterval(()=>{},1000);`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, dir], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	await new Promise<void>((resolve, reject) => {
		child.stdout?.once("data", () => resolve());
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code) reject(new Error("owner exited early"));
		});
	});
	expect(() => acquireControlLock(dir)).toThrow();
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill(signal);
	await exited;
	acquireControlLock(dir).release();
});
