import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GoalStore } from "../src/goals/store.js";
import type { GoalCompletionRequest, GoalVerificationRuntime } from "../src/goals/types.js";

let root: string;
let store: GoalStore;
let runtime: GoalVerificationRuntime;
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "manual-binding-"));
	const channelDir = join(root, "channel");
	mkdirSync(channelDir);
	store = new GoalStore({
		channelDir,
		controlChannelDir: join(root, "control"),
		confirmationTtlMs: 1000,
		limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
	});
	runtime = {
		channelDir,
		sandbox: { type: "host" },
		signal: new AbortController().signal,
		assertActive() {},
		reserveCommand: () => ({ timeoutSeconds: 1 }),
		executor: { getWorkspacePath: () => channelDir, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
	};
	await store.create({ objective: "deliver", ownerUserId: "creator", acceptance: { mode: "manual" } }, runtime.signal);
	writeFileSync(join(channelDir, "result.txt"), "v1");
});
afterEach(() => {
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});
const request: GoalCompletionRequest = {
	summary: "done",
	evidence: ["result.txt exists"],
	deliverables: { kind: "files", paths: ["result.txt"] },
};
async function apply(input = request) {
	return (await store.requestCompletion(input, runtime)).report;
}
async function confirm(id: string, user = "creator") {
	return store.confirm(store.get()!.id, id, user, runtime.signal);
}
it("binds explicit paths and digest and rejects changed files", async () => {
	const report = await apply();
	expect(report.snapshots).toHaveLength(1);
	writeFileSync(join(runtime.channelDir, "result.txt"), "v2");
	await expect(confirm(report.attemptId)).rejects.toThrow(/产物已变化/);
	expect(store.get()!.status).toBe("awaiting_confirmation");
});
it.each(["delete", "link", "replace"])("rejects %s after request", async (action) => {
	const report = await apply();
	const path = join(runtime.channelDir, "result.txt");
	unlinkSync(path);
	if (action === "link") symlinkSync(join(root, "outside"), path);
	if (action === "replace") writeFileSync(path, "v1");
	await expect(confirm(report.attemptId)).rejects.toThrow(/产物已变化/);
});
it("expires, allows reapplication and rejects the old attempt", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const old = await apply();
	vi.advanceTimersByTime(1001);
	await expect(confirm(old.attemptId)).rejects.toThrow(/过期/);
	expect(store.get()!.status).not.toBe("completed");
	const fresh = await apply();
	await expect(confirm(old.attemptId)).rejects.toThrow();
	expect((await confirm(fresh.attemptId)).status).toBe("completed");
});
it("requires an explicit declaration, never parses evidence as paths", async () => {
	await expect(apply({ summary: "done", evidence: ["result.txt"] })).rejects.toThrow(/交付/);
});
it("supports explicit no-file delivery and creator identity", async () => {
	const report = await apply({ ...request, deliverables: { kind: "none", reason: "advice only" } });
	await expect(confirm(report.attemptId, "other")).rejects.toThrow();
	expect((await confirm(report.attemptId)).completion?.confirmedBy).toBe("creator");
});
it("cannot confirm uncaptured or out-of-bound files", async () => {
	await expect(apply({ ...request, deliverables: { kind: "files", paths: ["../outside"] } })).rejects.toThrow();
	unlinkSync(join(runtime.channelDir, "result.txt"));
	const report = await apply();
	expect(report.status).toBe("failed");
	await expect(confirm(report.attemptId)).rejects.toThrow();
});

it("invalidates a rewrite even if original bytes are restored", async () => {
	const report = await apply();
	writeFileSync(join(runtime.channelDir, "result.txt"), "changed");
	writeFileSync(join(runtime.channelDir, "result.txt"), "v1");
	await expect(confirm(report.attemptId)).rejects.toThrow(/产物已变化/);
});
