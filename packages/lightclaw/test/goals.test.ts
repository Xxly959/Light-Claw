import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoalStore } from "../src/goals/store.js";
import type { GoalCompletionRequest, GoalVerificationRuntime } from "../src/goals/types.js";

let directory: string;
let channelDir: string;
let controlChannelDir: string;
let store: GoalStore;
const signal = () => new AbortController().signal;
function runtime(): GoalVerificationRuntime {
	return {
		channelDir,
		sandbox: { type: "host" },
		signal: signal(),
		assertActive: () => {},
		reserveCommand: () => ({ timeoutSeconds: 1 }),
		executor: { getWorkspacePath: (path) => path, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
	};
}
async function create(objective = "goal") {
	return store.create({ objective, ownerUserId: "owner", acceptance: { mode: "manual" } }, signal());
}
const request: GoalCompletionRequest = {
	summary: "done",
	evidence: ["tests passed"],
	deliverables: { kind: "none", reason: "no file delivery in this fixture" },
};
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "lightclaw-goal-"));
	channelDir = join(directory, "work", "channel");
	controlChannelDir = join(directory, "control", "channel");
	mkdirSync(channelDir, { recursive: true });
	store = new GoalStore({
		channelDir,
		controlChannelDir,
		limits: { maxCycles: 3, maxFailures: 2, maxStaleCycles: 2 },
	});
});
afterEach(() => {
	if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
});
describe("verified goal state machine", () => {
	it("restores schema2 state outside the tool workspace", async () => {
		await create("restore");
		expect(store.get()).toMatchObject({ schemaVersion: 2, ownerUserId: "owner", status: "active" });
		expect(existsSync(join(channelDir, "goal.json"))).toBe(false);
		expect(existsSync(join(controlChannelDir, "goal.json"))).toBe(true);
	});
	it("text evidence requests owner confirmation instead of completing", async () => {
		await create();
		const outcome = await store.requestCompletion(request, runtime());
		expect(outcome.goal?.status).toBe("awaiting_confirmation");
		const finished = await store.confirm(outcome.report.goalId, outcome.report.attemptId, "owner", signal());
		expect(finished).toMatchObject({
			status: "completed",
			cycle: 1,
			completion: { method: "human", confirmedBy: "owner" },
		});
	});
	it("empty summary or blank evidence cannot alter state", async () => {
		await create();
		const before = readFileSync(join(controlChannelDir, "goal.json"), "utf8");
		await expect(store.requestCompletion({ summary: "done", evidence: [" "] }, runtime())).rejects.toThrow();
		await expect(store.requestCompletion({ summary: " ", evidence: ["proof"] }, runtime())).rejects.toThrow();
		expect(readFileSync(join(controlChannelDir, "goal.json"), "utf8")).toBe(before);
	});
	it("completes only after real file verification", async () => {
		await store.create(
			{
				objective: "create abc",
				ownerUserId: "owner",
				acceptance: {
					mode: "automatic",
					files: [{ path: "file", contains: ["abc"], changed: true }],
					commands: [],
				},
			},
			signal(),
		);
		writeFileSync(join(channelDir, "file"), "abc");
		expect((await store.requestCompletion(request, runtime())).goal).toMatchObject({
			status: "completed",
			completion: { method: "automatic" },
		});
	});
	it("failed checks do not count as progress and remain bounded", async () => {
		await store.create(
			{
				objective: "file",
				ownerUserId: "owner",
				acceptance: { mode: "automatic", files: [{ path: "file", changed: true }], commands: [] },
			},
			signal(),
		);
		expect((await store.requestCompletion(request, runtime())).goal).toMatchObject({
			status: "active",
			progressVersion: 0,
		});
		store.recordCycle(false, false);
		expect(store.recordCycle(false, false).status).toBe("paused");
	});
	it("keeps the current state when verification is cancelled", async () => {
		await create();
		const context = runtime();
		context.assertActive = () => {
			store.pause("stop");
			throw new Error("stopped");
		};
		const result = await store.requestCompletion(request, context);
		expect(result.committed).toBe(false);
		expect(store.get()).toMatchObject({ status: "paused", pauseReason: "stop" });
	});
	it("rejects wrong-owner and stale confirmation", async () => {
		await create();
		const result = await store.requestCompletion(request, runtime());
		await expect(store.confirm(result.report.goalId, result.report.attemptId, "other", signal())).rejects.toThrow();
		store.resume();
		await expect(store.confirm(result.report.goalId, result.report.attemptId, "owner", signal())).rejects.toThrow();
		expect(store.get()?.status).toBe("active");
	});
	it("confirmation rejects changed observed artifacts", async () => {
		await store.create(
			{
				objective: "file",
				ownerUserId: "owner",
				acceptance: {
					mode: "automatic",
					files: [{ path: "file", changed: true }],
					commands: [{ command: "test", sourcePaths: ["file"] }],
				},
			},
			signal(),
		);
		writeFileSync(join(channelDir, "file"), "abc");
		const result = await store.requestCompletion(request, runtime());
		expect(result.goal?.status).toBe("awaiting_confirmation");
		writeFileSync(join(channelDir, "file"), "changed");
		await expect(store.confirm(result.report.goalId, result.report.attemptId, "owner", signal())).rejects.toThrow();
	});
	it("preserves failures, pause, cancel and resume rules", async () => {
		await create();
		store.recordCycle(true, false);
		expect(store.recordCycle(true, false).pauseReason).toBe("连续执行失败");
		expect(store.resume()).toMatchObject({ cycle: 0, consecutiveFailures: 0, staleCycles: 0 });
		store.pause();
		expect(() => store.updateProgress("no")).toThrow();
		store.cancel();
		expect(() => store.resume()).toThrow();
	});
	it("refuses overwrite and invalid progress", async () => {
		await create();
		await expect(create("replacement")).rejects.toThrow();
		expect(() => store.updateProgress(" ")).toThrow();
		expect(store.get()?.progressVersion).toBe(0);
	});
	it.each([
		["id", ""],
		["objective", " "],
		["status", ["active"]],
		["cycle", -1],
		["consecutiveFailures", 0.5],
		["staleCycles", "0"],
		["progressVersion", null],
		["evidence", [17]],
		["createdAt", "2026-02-31T00:00:00.000Z"],
		["updatedAt", null],
		["revision", -1],
		["schemaVersion", 1],
		["ownerUserId", ""],
		["verificationHistory", [{}]],
	])("rejects malformed persisted %s", async (field, value) => {
		const goal = await create();
		writeFileSync(join(controlChannelDir, "goal.json"), JSON.stringify({ ...goal, [field]: value }));
		expect(() => store.get()).toThrow(field);
	});
});

it("rejects linked protected state instead of trusting workspace bytes", async () => {
	await create();
	const path = join(controlChannelDir, "goal.json");
	const raw = readFileSync(path);
	const malicious = join(channelDir, "forged.json");
	writeFileSync(malicious, raw);
	rmSync(path);
	symlinkSync(malicious, path);
	expect(() => store.get()).toThrow();
});

it("rejects automatic completion on a manual contract even with a passed label", async () => {
	await create();
	const result = await store.requestCompletion(request, runtime());
	const goal = await store.confirm(result.report.goalId, result.report.attemptId, "owner", signal());
	writeFileSync(
		join(controlChannelDir, "goal.json"),
		JSON.stringify({
			...goal,
			completion: { method: "automatic", attemptId: result.report.attemptId },
			verificationHistory: [{ ...result.report, status: "passed" }],
		}),
	);
	expect(() => store.get()).toThrow();
});
it("rejects pending confirmation without the current inconclusive report", async () => {
	const goal = await create();
	writeFileSync(join(controlChannelDir, "goal.json"), JSON.stringify({ ...goal, status: "awaiting_confirmation" }));
	expect(() => store.get()).toThrow();
});

it("rejects confirmation after replacement with identical bytes", async () => {
	await store.create(
		{
			objective: "file",
			ownerUserId: "owner",
			acceptance: {
				mode: "automatic",
				files: [{ path: "file", changed: true }],
				commands: [{ command: "check", sourcePaths: ["file"] }],
			},
		},
		signal(),
	);
	writeFileSync(join(channelDir, "file"), "abc");
	const result = await store.requestCompletion(request, runtime());
	writeFileSync(join(channelDir, "replacement"), "abc");
	renameSync(join(channelDir, "replacement"), join(channelDir, "file"));
	await expect(store.confirm(result.report.goalId, result.report.attemptId, "owner", signal())).rejects.toThrow();
});
it.each(["replacement", "pause/resume"])("does not commit late verification after %s", async (mode) => {
	await store.create(
		{
			objective: "old",
			ownerUserId: "owner",
			acceptance: { mode: "automatic", files: [], commands: [{ command: "check", sourcePaths: ["file"] }] },
		},
		signal(),
	);
	writeFileSync(join(channelDir, "file"), "abc");
	const context = runtime();
	context.sandbox = { type: "docker", container: "mock" };
	let enter!: () => void;
	const ready = new Promise<void>((resolve) => {
		enter = resolve;
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	context.executor.exec = async () => {
		enter();
		await gate;
		return { code: 0, stdout: "", stderr: "" };
	};
	const pending = store.requestCompletion(request, context);
	await ready;
	try {
		if (mode === "replacement") {
			store.cancel();
			await create("new goal");
		} else {
			store.pause();
			store.resume();
		}
	} finally {
		release();
	}
	const result = await pending;
	expect(result.committed).toBe(false);
	expect(store.get()?.status).toBe("active");
	if (mode === "replacement") expect(store.get()?.objective).toBe("new goal");
	else expect(store.get()?.status).toBe("active");
});
