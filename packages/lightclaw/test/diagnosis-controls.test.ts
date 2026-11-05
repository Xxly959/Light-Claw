import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelQueue } from "../src/channel-queue.js";
import { loadConfig } from "../src/config.js";
import { handleGoalCommand } from "../src/goals/commands.js";
import { GoalStore } from "../src/goals/store.js";
import type { GoalVerificationRuntime } from "../src/goals/types.js";
import { IdleResourceCache } from "../src/idle-cache.js";
import { createGoalTools } from "../src/tools/goal.js";

const roots: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(options: { acceptanceEnabled?: boolean; controlsEnabled?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "diagnosis-"));
	roots.push(root);
	const channelDir = join(root, "work");
	const store = new GoalStore({
		channelDir,
		controlChannelDir: join(root, "control"),
		limits: { maxCycles: 3, maxFailures: 2, maxStaleCycles: 2 },
		...options,
	});
	const runtime: GoalVerificationRuntime = {
		channelDir,
		sandbox: { type: "host" },
		signal: new AbortController().signal,
		assertActive: () => {},
		reserveCommand: () => ({ timeoutSeconds: 1 }),
		executor: { getWorkspacePath: (path) => path, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
	};
	return { store, runtime, channelDir };
}

describe("diagnostic switches at execution boundaries", () => {
	it("loads seven independent switches and rejects misspellings", () => {
		const env = { LIGHTCLAW_SLACK_APP_TOKEN: "faux", LIGHTCLAW_SLACK_BOT_TOKEN: "faux" };
		const names = ["GOALS", "ACCEPTANCE", "FEISHU", "CONTROLS", "SCHEDULING", "OPTIMIZATION", "INFRASTRUCTURE"];
		const config = loadConfig({
			...env,
			...Object.fromEntries(names.map((name) => [`LIGHTCLAW_FEATURE_${name}`, "false"])),
		});
		expect(config.transport).toBe("slack");
		expect(Object.values(config.features ?? {})).toEqual(Array(7).fill(false));
		expect(() => loadConfig({ ...env, LIGHTCLAW_FEATURE_GOALS: "flase" })).toThrow("true");
	});
	it("disabled scheduling preserves all FIFO work without eviction or expiry", async () => {
		vi.useFakeTimers();
		const released: string[] = [];
		const cache = new IdleResourceCache(
			{ maxEntries: 1, idleTtlMs: 1, enabled: false },
			() => false,
			(_value, key) => released.push(key),
		);
		cache.getOrCreate("a", () => "a");
		cache.getOrCreate("b", () => "b");
		await vi.advanceTimersByTimeAsync(100);
		cache.sweep();
		expect(cache.size).toBe(2);
		expect(released).toEqual([]);
		const queue = new ChannelQueue(() => {}, { maxPending: 1, maxWaitMs: 1, enabled: false });
		let release!: () => void;
		const executed: number[] = [];
		const first = queue.enqueue(
			() =>
				new Promise<void>((done) => {
					release = done;
				}),
		);
		const rest = Array.from({ length: 10 }, (_, index) =>
			queue.enqueue(async () => {
				executed.push(index);
			}),
		);
		await vi.advanceTimersByTimeAsync(100);
		release();
		await Promise.all([first, ...rest]);
		expect(executed).toEqual(Array.from({ length: 10 }, (_, index) => index));
		expect(queue.statistics()).toMatchObject({ completed: 11, rejected: 0, expired: 0 });
		cache.close();
	});
	it("acceptance off records self-reported completion without fabricating a passed check", async () => {
		const { store, runtime } = fixture({ acceptanceEnabled: false });
		await store.create(
			{ objective: "write report", ownerUserId: "owner", acceptance: { mode: "manual" } },
			runtime.signal,
		);
		const result = await store.requestCompletion(
			{ summary: "done", evidence: ["report"], deliverables: { kind: "files", paths: ["report.md"] } },
			runtime,
		);
		expect(result.goal).toMatchObject({ status: "completed", completion: { method: "self_reported" } });
		expect(result.report.status).toBe("inconclusive");
		expect(result.report.checks).toEqual([]);
		expect(store.get()?.completion?.method).toBe("self_reported");
	});
	it("controls off retains cycle accounting without pausing", async () => {
		const { store, runtime } = fixture({ controlsEnabled: false });
		await store.create(
			{ objective: "research", ownerUserId: "owner", acceptance: { mode: "manual" } },
			runtime.signal,
		);
		for (let cycle = 0; cycle < 6; cycle++) store.recordCycle(false, false);
		expect(store.get()).toMatchObject({ status: "active", cycle: 6 });
	});
	it("does not count identical repeated progress as new progress", async () => {
		const { store, runtime } = fixture();
		await store.create(
			{ objective: "research", ownerUserId: "owner", acceptance: { mode: "manual" } },
			runtime.signal,
		);
		store.updateProgress("read sources", ["source A"]);
		const version = store.get()?.progressVersion;
		store.recordCycle(false, true);
		store.updateProgress("read sources", ["source A"]);
		expect(store.get()?.progressVersion).toBe(version);
	});
	it("returns the failing path and corrective condition to the model", async () => {
		const { store, runtime, channelDir } = fixture();
		await store.create(
			{
				objective: "write",
				ownerUserId: "owner",
				acceptance: {
					mode: "automatic",
					files: [{ path: "answer.txt", changed: false, contains: ["required text"] }],
					commands: [],
				},
			},
			runtime.signal,
		);
		writeFileSync(join(channelDir, "answer.txt"), "wrong");
		const tool = createGoalTools(store, () => runtime)[1];
		const result = await tool.execute("attempt", { summary: "done", evidence: ["answer.txt"] });
		expect(result.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("answer.txt") })]),
		);
		expect(JSON.stringify(result.content)).toContain("required text");
	});
	it("progress bookkeeping does not invalidate an unchanged verified artifact", async () => {
		const { store, runtime, channelDir } = fixture();
		await store.create(
			{
				objective: "write",
				ownerUserId: "owner",
				acceptance: { mode: "automatic", files: [], commands: [{ command: "check", sourcePaths: ["answer.txt"] }] },
			},
			runtime.signal,
		);
		writeFileSync(join(channelDir, "answer.txt"), "correct");
		runtime.sandbox = { type: "docker", container: "faux" };
		runtime.executor.exec = async () => {
			store.updateProgress("verification running", ["answer.txt"]);
			return { code: 0, stdout: "", stderr: "" };
		};
		const result = await store.requestCompletion({ summary: "done", evidence: ["answer.txt"] }, runtime);
		expect(result.goal?.status).toBe("completed");
		expect(result.report.status).toBe("passed");
	});
	it("records an owner dispute without rewriting the rejected result", async () => {
		const { store, runtime, channelDir } = fixture();
		await store.create(
			{
				objective: "write",
				ownerUserId: "owner",
				acceptance: { mode: "automatic", files: [{ path: "missing", changed: false }], commands: [] },
			},
			runtime.signal,
		);
		const outcome = await store.requestCompletion({ summary: "done", evidence: ["proof"] }, runtime);
		const text = `/goal dispute ${outcome.report.attemptId} false rejection`;
		const context = {
			userId: "owner",
			origin: "platform" as const,
			sandbox: runtime.sandbox,
			signal: runtime.signal,
		};
		await expect(handleGoalCommand(text, store, { ...context, userId: "other" })).rejects.toThrow();
		expect((await handleGoalCommand(text, store, context)).response).toContain("已记录");
		expect(store.get()?.verificationHistory.at(-1)?.status).toBe("failed");
		expect(readFileSync(join(channelDir, "..", "control", "verification-disputes.jsonl"), "utf8")).toContain(
			"false rejection",
		);
	});
});
