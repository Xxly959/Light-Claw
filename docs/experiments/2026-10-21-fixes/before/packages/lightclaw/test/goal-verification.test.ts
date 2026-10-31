import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureGoalBaselines } from "../src/goals/artifact.js";
import type { GoalState, GoalVerificationRuntime } from "../src/goals/types.js";
import { verifyGoalCompletion } from "../src/goals/verifier.js";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "goal-verification-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function goal(): GoalState {
	const now = new Date().toISOString();
	return {
		schemaVersion: 2,
		id: "goal",
		ownerUserId: "owner",
		revision: 0,
		objective: "create file",
		status: "active",
		cycle: 0,
		consecutiveFailures: 0,
		staleCycles: 0,
		progressVersion: 0,
		evidence: [],
		baselines: [],
		verificationHistory: [],
		createdAt: now,
		updatedAt: now,
		acceptance: { mode: "automatic", files: [{ path: "file", changed: true, contains: ["abc"] }], commands: [] },
	};
}
function runtime(): GoalVerificationRuntime {
	return {
		channelDir: directory,
		sandbox: { type: "docker", container: "mock" },
		signal: new AbortController().signal,
		assertActive: () => {},
		reserveCommand: () => ({ timeoutSeconds: 1 }),
		executor: { getWorkspacePath: () => directory, exec: async () => ({ code: 0, stdout: "OK", stderr: "" }) },
	};
}
const request = { summary: "done", evidence: ["claimed success"] };
describe("deterministic goal verification", () => {
	it("does not believe textual evidence for missing files", async () => {
		expect(await verifyGoalCompletion(goal(), request, runtime())).toMatchObject({ status: "failed" });
	});
	it("requires changed content against the creation baseline", async () => {
		writeFileSync(join(directory, "file"), "abc");
		const state = goal();
		state.baselines = await captureGoalBaselines(directory, state.acceptance, runtime().signal);
		expect((await verifyGoalCompletion(state, request, runtime())).status).toBe("failed");
		writeFileSync(join(directory, "file"), "abcd");
		expect((await verifyGoalCompletion(state, request, runtime())).status).toBe("passed");
	});
	it("requests human review for manual tasks", async () => {
		const state = goal();
		state.acceptance = { mode: "manual" };
		expect(await verifyGoalCompletion(state, request, runtime())).toMatchObject({
			status: "inconclusive",
			checks: [],
		});
	});
	it.each([0, 1])("checks actual command exit code %s", async (code) => {
		writeFileSync(join(directory, "file"), "abc");
		const state = goal();
		state.acceptance = { mode: "automatic", files: [], commands: [{ command: "test", sourcePaths: ["file"] }] };
		const context = runtime();
		context.executor.exec = async () => ({ code, stdout: "OK", stderr: "" });
		expect((await verifyGoalCompletion(state, request, context)).status).toBe(code === 0 ? "passed" : "failed");
	});
	it("rejects source mutations during a command", async () => {
		writeFileSync(join(directory, "file"), "abc");
		const state = goal();
		state.acceptance = { mode: "automatic", files: [], commands: [{ command: "test", sourcePaths: ["file"] }] };
		const context = runtime();
		context.executor.exec = async () => {
			writeFileSync(join(directory, "file"), "changed");
			return { code: 0, stdout: "OK", stderr: "" };
		};
		expect((await verifyGoalCompletion(state, request, context)).status).not.toBe("passed");
	});
	it("does not satisfy output checks with truncated previews", async () => {
		writeFileSync(join(directory, "file"), "abc");
		const state = goal();
		state.acceptance = {
			mode: "automatic",
			files: [],
			commands: [{ command: "test", sourcePaths: ["file"], stdoutIncludes: ["OK"] }],
		};
		const context = runtime();
		context.executor.exec = async () => ({ code: 0, stdout: "OK", stderr: "", outputTruncated: true });
		expect((await verifyGoalCompletion(state, request, context)).status).toBe("inconclusive");
	});
	it("cannot spawn after the runtime is cancelled", async () => {
		const context = runtime();
		context.assertActive = () => {
			throw new Error("cancelled");
		};
		expect((await verifyGoalCompletion(goal(), request, context)).status).toBe("aborted");
	});
});

it("runs commands in the channel directory inside the container", async () => {
	writeFileSync(join(directory, "file"), "abc");
	const state = goal();
	state.acceptance = { mode: "automatic", files: [], commands: [{ command: "check", sourcePaths: ["file"] }] };
	const context = runtime();
	context.executor.getWorkspacePath = () => "/workspace";
	let command = "";
	context.executor.exec = async (value) => {
		command = value;
		return { code: 0, stdout: "", stderr: "" };
	};
	await verifyGoalCompletion(state, request, context);
	expect(command).toContain(`/workspace/${directory.split("/").at(-1)}`);
});
