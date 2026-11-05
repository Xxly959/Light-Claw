import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfigForDiagnostics } from "../src/config.js";
import { acquireControlLock } from "../src/goals/control.js";
import { inspectLocalHealth } from "../src/health.js";
import { createLightClawRuntime, type RuntimeFault } from "../src/runtime.js";
import type { ChatTransport } from "../src/transport.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("separates held kernel lock, live process, readiness and platform status", () => {
	const root = mkdtempSync(join(tmpdir(), "health-ready-"));
	roots.push(root);
	const work = join(root, "work"),
		control = join(root, "control");
	mkdirSync(work);
	const lock = acquireControlLock(control);
	try {
		const write = (heartbeatAt: number, ready: boolean) =>
			writeFileSync(
				join(control, "health.json"),
				JSON.stringify({ schema: 1, pid: process.pid, heartbeatAt, ready, platform: "reconnecting" }),
			);
		write(Date.now(), false);
		expect(inspectLocalHealth(work, control)).toMatchObject({
			lock: "held",
			process: "alive",
			runtime: "starting",
			platform: "reconnecting",
		});
		write(Date.now(), true);
		expect(inspectLocalHealth(work, control).runtime).toBe("ready");
		write(Date.now() - 120000, true);
		expect(inspectLocalHealth(work, control).runtime).toBe("stale");
	} finally {
		lock.release();
	}
	expect(inspectLocalHealth(work, control).runtime).not.toBe("ready");
});

it("wires faults to a local hook without connecting an external service", async () => {
	const root = mkdtempSync(join(tmpdir(), "health-fault-"));
	roots.push(root);
	const faults: RuntimeFault[] = [];
	const transport: ChatTransport = {
		kind: "feishu",
		connectionStatus: () => "connected",
		start: async () => {},
		getUser: () => undefined,
		getChannel: () => undefined,
		getAllUsers: () => [],
		getAllChannels: () => [],
		postMessage: async () => "reply",
		updateMessage: async () => {},
		deleteMessage: async () => {},
		postInThread: async () => "reply",
		uploadFile: async () => {},
		logBotResponse() {},
		enqueueEvent: () => false,
	};
	const work = join(root, "work"),
		control = join(root, "control");
	const runtime = await createLightClawRuntime({
		config: { ...loadConfigForDiagnostics({}), controlDir: control },
		workingDir: work,
		sandbox: { type: "host" },
		createTransport: () => transport,
		onFault: (fault) => {
			faults.push(fault);
		},
	});
	try {
		await runtime.start();
		expect(inspectLocalHealth(work, control).healthy).toBe(true);
		await runtime.handler.handleQueueFailure(
			{ origin: "platform", type: "dm", channel: "C", user: "owner", ts: "1", text: "work" },
			transport,
			"full",
		);
		await Promise.resolve();
		expect(faults[0]?.kind).toBe("queue_full");
	} finally {
		await runtime.shutdown();
	}
	expect(inspectLocalHealth(work, control).healthy).toBe(false);
});
