import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createExecutor } from "../src/sandbox.js";

const resources: Array<{ id: string; label: string; root: string }> = [];
const owners: ChildProcess[] = [];
const labelKey = "io.lightclaw.batch2-test";
const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 15_000 });
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
afterEach(async () => {
	for (const child of owners.splice(0))
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGKILL");
			await exited;
		}
	for (const r of resources.splice(0)) {
		const label = docker(["inspect", "-f", `{{index .Config.Labels ${JSON.stringify(labelKey)}}}`, r.id]).trim();
		if (label !== r.label) throw new Error("Refusing cleanup: resource ownership label mismatch");
		docker(["rm", "-f", r.id]);
		rmSync(r.root, { recursive: true, force: true });
	}
});
// Explicit opt-in only. Default CI and local offline suite never contact Docker.
it.skipIf(process.env.LIGHTCLAW_DOCKER_FAULT_TESTS !== "1").each(["cancel", "timeout", "SIGTERM", "SIGKILL"] as const)(
	"real isolated Docker task stops descendants: %s",
	async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "lightclaw-batch2-live-"));
		const label = randomUUID();
		const name = `lightclaw-batch2-${label}`;
		let id: string;
		try {
			id = docker([
				"run",
				"--pull=never",
				"-d",
				"--name",
				name,
				"--label",
				`${labelKey}=${label}`,
				"--network=none",
				"--read-only",
				"--cpus=1",
				"--memory=128m",
				"--pids-limit=64",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges",
				"--user",
				`${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
				"--tmpfs",
				"/tmp:rw,nosuid,nodev,size=16m",
				"--mount",
				`type=bind,source=${root},target=/workspace`,
				process.env.LIGHTCLAW_DOCKER_TEST_IMAGE ?? "lightclaw-sandbox:local",
				"sh",
				"-c",
				"while :; do sleep 3600; done",
			]).trim();
		} catch (error) {
			rmSync(root, { recursive: true, force: true });
			throw error;
		}
		if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid created container ID");
		resources.push({ id, label, root });
		const log = join(root, "writes");
		const detached =
			"import time; f=open('/workspace/writes','a'); [(f.write('detached\\n'),f.flush(),time.sleep(.03)) for _ in iter(int,1)]";
		const launch = `import subprocess; subprocess.Popen(['python3','-c',${JSON.stringify(detached)}],start_new_session=True,env={'PATH':'/usr/local/bin:/usr/bin:/bin'})`;
		const command = `python3 -c ${quote(launch)}; while :; do echo parent >> /workspace/writes; sleep .03; done`;
		const waitWriting = async () => {
			await vi.waitFor(() => expect(existsSync(log) && readFileSync(log, "utf8").includes("detached")).toBe(true), {
				timeout: 5000,
			});
		};
		if (mode === "cancel") {
			const controller = new AbortController();
			const result = createExecutor({ type: "docker", container: id }, 10).exec(command, {
				signal: controller.signal,
			});
			const done = expect(result).rejects.toThrow("aborted");
			await waitWriting();
			controller.abort();
			await done;
		} else if (mode === "timeout") {
			await expect(createExecutor({ type: "docker", container: id }).exec(command, { timeout: 1 })).rejects.toThrow(
				"timed out",
			);
			await waitWriting();
		} else {
			const source = fileURLToPath(new URL("../src/sandbox.ts", import.meta.url));
			const code = `import {createExecutor} from ${JSON.stringify(source)}; await createExecutor({type:'docker',container:process.argv[1]},30).exec(process.argv[2]);`;
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, id, command], {
				stdio: ["ignore", "ignore", "pipe"],
			});
			owners.push(child);
			await waitWriting();
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill(mode);
			await exited;
			await new Promise((r) => setTimeout(r, 2000));
		}
		const size = statSync(log).size;
		await new Promise((r) => setTimeout(r, 400));
		expect(statSync(log).size).toBe(size);
	},
	15_000,
);
