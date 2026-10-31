import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readReport, runJob } from "../src/evals/reliability/controller.js";
import { loadOracles, loadTasks } from "../src/evals/reliability/data.js";
import { makeFreeze } from "../src/evals/reliability/protocol.js";

const roots: string[] = [];
afterEach(() => {
	for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
it("B dispatches the same effective payload and tool schemas except the declared candidate section", async () => {
	const root = mkdtempSync(join(tmpdir(), "lightclaw-v3-prompt-pair-"));
	roots.push(root);
	const task = loadTasks().find((t) => t.id === "d01")!,
		freeze = makeFreeze(loadTasks(), "B", ["development"], 1, "FROZEN_CANDIDATE_V1");
	const payloads: Array<{ normalizedSystemPrompt: string; tools: unknown }> = [];
	for (const arm of ["governed", "candidate"]) {
		const job = freeze.jobs.find((j) => j.caseId === task.id && j.arm === arm)!;
		const out = join(root, job.id);
		await runJob(freeze, job, task, loadOracles()[task.id], out);
		payloads.push(JSON.parse(readFileSync(join(out, "requests.jsonl"), "utf8").split("\n")[0]));
	}
	expect(payloads[1].normalizedSystemPrompt).toContain("FROZEN_CANDIDATE_V1");
	expect(payloads[1].normalizedSystemPrompt.replace("\n## 可迭代行为指令\nFROZEN_CANDIDATE_V1", "")).toBe(
		payloads[0].normalizedSystemPrompt,
	);
	expect(payloads[1].tools).toEqual(payloads[0].tools);
});
it.each(["s06", "s07", "s08", "s09", "d05", "d08", "d09", "d10"])(
	"records %s fault through an isolated real worker, never hiding failed attempts",
	async (id) => {
		const root = mkdtempSync(join(tmpdir(), "lightclaw-v3-controller-"));
		roots.push(root);
		mkdirSync(join(root, "runs"));
		const task = loadTasks().find((t) => t.id === id)!,
			freeze = makeFreeze(loadTasks(), "A", [task.split], 1),
			job = freeze.jobs.find((j) => j.caseId === id && j.arm === "governed")!;
		const record = await runJob(freeze, job, task, loadOracles()[id], join(root, "runs", job.id));
		expect(record.observation).not.toBeNull();
		expect(record.score).not.toBeNull();
		expect(record.controller.timeout).toBe(false);
		if (id === "s06") {
			expect(record.observation?.phases).toContain("queue-expired");
			expect(record.terminal).toBe("task_failed");
		}
		if (id === "s07") {
			expect(record.controller.boots).toBe(2);
			expect(record.observation?.phases).toContain("crash-recovered-unknown");
			expect(record.observation?.humanRequired).toBe(true);
			expect(record.terminal).toBe("task_failed");
			expect(readFileSync(join(root, "runs", job.id, "controller.json"), "utf8")).toContain("SIGKILL");
		}
		if (id === "s08") expect(record.observation?.productTimeout).toBe(true);
		if (id === "s09") expect(record.score?.artifactRightSystemFailure).toBe(true);
		if (id === "d05") {
			expect(record.observation?.systemFailure).toBe(true);
			expect(record.observation?.phases).toContain("final-delivery-unresolved");
			expect(record.terminal).toBe("task_failed");
			expect(record.score?.artifactCorrect).toBe(true);
		}
		if (id === "d08") expect(record.observation?.humanInterventions).toBe(1);
		if (id === "d09") {
			expect(record.observation?.goalStatus).toBe("awaiting_confirmation");
			expect(record.observation?.phases).toContain("old-approval-rejected");
		}
		if (id === "d10") expect(record.score?.falseCompletion).toBe(true);
	},
	30_000,
);
it("keeps a truncated worker observation as a failed attempt rather than aborting the controller", async () => {
	const root = mkdtempSync(join(tmpdir(), "lightclaw-v3-corrupt-worker-"));
	roots.push(root);
	const task = { ...loadTasks().find((t) => t.id === "d01")!, scenario: "corrupt-record" },
		freeze = makeFreeze(loadTasks(), "A", ["development"], 1),
		job = freeze.jobs.find((j) => j.caseId === task.id)!;
	const row = await runJob(freeze, job, task, loadOracles()[task.id], join(root, "run"));
	expect(row.terminal).toBe("worker_error");
	expect(row.observation).toBeNull();
	expect(readFileSync(join(root, "run", "observation.json"), "utf8")).toBe('{"decision":');
});
it("recovers an interrupted JSONL append, retains the frozen denominator and preserves a known timeout", () => {
	const root = mkdtempSync(join(tmpdir(), "lightclaw-v3-corrupt-log-"));
	roots.push(root);
	const freeze = makeFreeze(loadTasks(), "A", ["development"], 1),
		job = freeze.jobs[0];
	const dir = join(root, "runs", job.id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "launched.jsonl"), "{}\n");
	writeFileSync(
		join(dir, "controller.json"),
		JSON.stringify({ exits: [{ code: 0, signal: null, timeout: true, injectedCrash: false }] }),
	);
	writeFileSync(join(root, "attempts.jsonl"), '{"job":');
	const report = readReport(freeze, root);
	expect(report.overall.planned).toBe(freeze.jobs.length);
	expect(report.overall.terminal.external_timeout).toBe(1);
	expect(report.overall.terminal.not_started).toBe(freeze.jobs.length - 1);
	expect(readFileSync(join(root, "attempts.jsonl"), "utf8")).toBe('{"job":');
});
