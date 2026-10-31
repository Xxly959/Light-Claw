import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleGoalCommand } from "../src/goals/commands.js";
import { GoalStore } from "../src/goals/store.js";
import type { GoalVerificationRuntime } from "../src/goals/types.js";

let root: string;
let store: GoalStore;
const context = {
	userId: "owner",
	origin: "platform",
	sandbox: { type: "host" },
	signal: new AbortController().signal,
} as const;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "goal-command-"));
	store = new GoalStore({
		channelDir: join(root, "work", "channel"),
		controlChannelDir: join(root, "control", "channel"),
		limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
	});
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("goal commands authorize their real source", () => {
	it("creates a manual goal owned by the platform sender", async () => {
		const result = await handleGoalCommand("/goal research", store, context);
		expect(result.goal).toMatchObject({ ownerUserId: "owner", acceptance: { mode: "manual" } });
		expect(result.startRun).toBe(true);
	});
	it("rejects scheduled creation even if text claims to be the owner", async () => {
		await expect(handleGoalCommand("/goal research", store, { ...context, origin: "scheduled" })).rejects.toThrow();
		expect(store.get()).toBeUndefined();
	});
	it("rejects malformed JSON before changing state", async () => {
		await expect(
			handleGoalCommand('/goal create {"objective":"goal","acceptance":{"files":[]}}', store, context),
		).rejects.toThrow();
		expect(store.get()).toBeUndefined();
	});
	it("waits for a current owner confirmation and blocks replacement", async () => {
		await handleGoalCommand("/goal research", store, context);
		const runtime: GoalVerificationRuntime = {
			channelDir: join(root, "work", "channel"),
			sandbox: { type: "host" },
			signal: context.signal,
			assertActive: () => {},
			reserveCommand: () => ({ timeoutSeconds: 1 }),
			executor: { getWorkspacePath: (path) => path, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
		};
		const result = await store.requestCompletion({ summary: "research done", evidence: ["report"] }, runtime);
		expect((await handleGoalCommand("/goal status", store, context)).response).toContain(
			`/goal confirm ${result.report.goalId} ${result.report.attemptId}`,
		);
		expect((await handleGoalCommand("/goal replacement", store, context)).startRun).toBe(false);
		const command = `/goal confirm ${result.report.goalId} ${result.report.attemptId}`;
		await expect(handleGoalCommand(command, store, { ...context, origin: "recovery" })).rejects.toThrow();
		await expect(handleGoalCommand(command, store, { ...context, userId: "other" })).rejects.toThrow();
		expect((await handleGoalCommand(command, store, context)).goal?.status).toBe("completed");
	});
});
