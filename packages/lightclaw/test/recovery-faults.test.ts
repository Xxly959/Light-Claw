import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
	for (const child of children.splice(0))
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGKILL");
			await exited;
		}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function line(child: ChildProcess, expected?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let text = "",
			error = "";
		const timer = setTimeout(() => reject(new Error(`checkpoint timeout ${text} ${error}`)), 5000);
		child.stderr?.on("data", (data) => {
			error += data;
		});
		child.stdout?.on("data", (data) => {
			text += data;
			if (text.includes("\n") && (!expected || text.includes(expected))) {
				clearTimeout(timer);
				resolve(text.trim());
			}
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code) reject(new Error(`worker ${code}: ${error}`));
		});
	});
}
it.each([
	["before-operation", "BEFORE_OPERATION", "SIGKILL"],
	["effect-before-progress", "EFFECT_SAVED", "SIGKILL"],
	["state-before-notification", "STATE_SAVED", "SIGKILL"],
	["queued", "QUEUED", "SIGKILL"],
	["effect-before-progress", "EFFECT_SAVED", "SIGTERM"],
] as const)("recovers %s after %s (%s) with one externally recorded side effect", async (phase, checkpoint, signal) => {
	const root = mkdtempSync(join(tmpdir(), "lightclaw-fault-mock-"));
	roots.push(root);
	const serverScript = fileURLToPath(new URL("./fixtures/mock-operation-service.py", import.meta.url));
	const workerScript = fileURLToPath(new URL("./fixtures/recovery-worker.ts", import.meta.url));
	const server = spawn("python3", ["-I", "-u", serverScript, join(root, "external-service")], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(server);
	const port = await line(server);
	const endpoint = `http://127.0.0.1:${port}`;
	const start = (step: string) => {
		const child = spawn(process.execPath, ["--import", "tsx", workerScript, root, endpoint, step], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.push(child);
		return child;
	};
	const first = start(phase);
	await line(first, checkpoint);
	const exited = new Promise((resolve) => first.once("exit", resolve));
	first.kill(signal);
	await exited;
	const effectFile = join(root, "external-service", "effects.json");
	if (phase === "before-operation" || phase === "queued") expect(existsSync(effectFile)).toBe(false);
	else expect(Object.keys(JSON.parse(readFileSync(effectFile, "utf8")))).toHaveLength(1);
	if (phase === "state-before-notification") {
		expect(existsSync(join(root, "saved-result.json"))).toBe(true);
		expect(JSON.parse(readFileSync(join(root, "control", "channel", "goal.json"), "utf8")).status).toBe("completed");
		expect(existsSync(join(root, "notification.json"))).toBe(false);
	}
	const next = start("recover");
	await line(next, "DONE");
	await new Promise<void>((resolve, reject) =>
		next.exitCode !== null
			? resolve()
			: next.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`recovery exit ${code}`)))),
	);
	const effects = JSON.parse(readFileSync(join(root, "external-service", "effects.json"), "utf8"));
	expect(Object.keys(effects)).toHaveLength(1);
	expect(JSON.parse(readFileSync(join(root, "control", "channel", "goal.json"), "utf8")).status).toBe("completed");
	const notification = JSON.parse(readFileSync(join(root, "notification.json"), "utf8"));
	expect(notification.operationId).toBe(Object.keys(effects)[0]);
	const again = start("recover");
	await line(again, "DONE");
	expect(JSON.parse(readFileSync(join(root, "external-service", "effects.json"), "utf8"))).toEqual(effects);
});
