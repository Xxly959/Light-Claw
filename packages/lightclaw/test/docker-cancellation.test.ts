import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createExecutor } from "../src/sandbox.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lightclaw-docker-offline-"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin);
	const executable = join(bin, "docker");
	// Transport shim executes the actual Python supervisor locally. This is NOT Docker evidence.
	writeFileSync(
		executable,
		`#!/usr/bin/env python3\nimport os,sys\na=sys.argv[1:]\nassert a.pop(0)=='exec'\nif a[0]=='-i':a.pop(0)\nassert a.pop(0)=='batch2-offline'\nassert a[0]=='python3'\na=[v.replace('/tmp/lightclaw-exec', ${JSON.stringify(join(root, "tasks"))}) for v in a]\nos.execvp(a[0],a)\n`,
	);
	chmodSync(executable, 0o700);
	vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
	const log = join(root, "writes");
	const command = `while :; do echo child >> '${log}'; sleep 0.03; done & while :; do echo parent >> '${log}'; sleep 0.03; done`;
	return { root, log, command, executor: createExecutor({ type: "docker", container: "batch2-offline" }, 10) };
}
async function writing(path: string) {
	await vi.waitFor(() => expect(existsSync(path) && statSync(path).size > 20).toBe(true), { timeout: 3000 });
}
async function stopped(path: string) {
	const size = statSync(path).size;
	await pause(250);
	expect(statSync(path).size).toBe(size);
}
it("cancellation confirms that both shell and background child stopped writing", async () => {
	const f = fixture();
	const signal = new AbortController();
	const run = f.executor.exec(f.command, { signal: signal.signal });
	const result = expect(run).rejects.toThrow("aborted");
	await writing(f.log);
	signal.abort();
	await result;
	await stopped(f.log);
	expect(readFileSync(f.log, "utf8")).toContain("parent");
	expect(readFileSync(f.log, "utf8")).toContain("child");
});
it("timeout stops actual task bytes, not only the host client", async () => {
	const f = fixture();
	await expect(f.executor.exec(f.command, { timeout: 0.4 })).rejects.toThrow("timed out");
	await stopped(f.log);
});
it.each(["SIGTERM", "SIGKILL"] as const)("owner %s loses heartbeat and the task stops writing", async (signal) => {
	const f = fixture();
	const source = fileURLToPath(new URL("../src/sandbox.ts", import.meta.url));
	const code = `import {createExecutor} from ${JSON.stringify(source)}; await createExecutor({type:'docker',container:'batch2-offline'},30).exec(process.argv[1]);`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, f.command], {
		stdio: ["ignore", "ignore", "pipe"],
		env: { ...process.env },
	});
	children.push(child);
	await writing(f.log);
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill(signal);
	await exited;
	await pause(1800);
	await stopped(f.log);
});
