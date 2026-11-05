import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PersistentModelBudget } from "../src/evals/reliability/budget-ledger.js";
import { reliabilityCli } from "../src/evals/reliability/cli.js";
import { readReport, resumeFrozen, runFrozen, runJob } from "../src/evals/reliability/controller.js";
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
		if (id === "d10") {
			expect(record.score?.falseCompletion).toBe(false);
			expect(record.observation?.goalStatus).toBe("awaiting_confirmation");
			expect(record.observation?.humanRequired).toBe(true);
		}
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

it("enforces one global request ceiling across workers and controller resume without replay", async () => {
	const root = mkdtempSync(join(tmpdir(), "global-budget-controller-"));
	roots.push(root);
	const freeze = makeFreeze(loadTasks(), "B", ["development"], 1);
	freeze.jobs = freeze.jobs.slice(0, 4);
	freeze.budget.campaign = {
		requests: 1,
		tokens: 100000,
		costMicros: 1000000,
		wallMs: 60000,
		tokensPerRequest: 100000,
		costMicrosPerRequest: 1000000,
	};
	const out = join(root, "experiment");
	const report = await runFrozen(freeze, out);
	const ledger = JSON.parse(readFileSync(join(out, "campaign-budget.json"), "utf8"));
	expect(ledger.entries).toHaveLength(1);
	expect(report.overall.terminal.not_started).toBeGreaterThanOrEqual(2);
	const launches = report.accounting.osLaunched;
	const resumed = await resumeFrozen(freeze, out);
	expect(resumed.accounting.osLaunched).toBe(launches);
	expect(JSON.parse(readFileSync(join(out, "campaign-budget.json"), "utf8")).entries).toHaveLength(1);
	await expect(
		resumeFrozen(
			{ ...freeze, budget: { ...freeze.budget, campaign: { ...freeze.budget.campaign, requests: 10 } } },
			out,
		),
	).rejects.toThrow(/frozen|manifest/i);
});

it("shares a depleted campaign ledger across A/B axes and preserves unknown reservations", async () => {
	const root = mkdtempSync(join(tmpdir(), "shared-axis-budget-"));
	roots.push(root);
	const limits = {
		requests: 1,
		tokens: 100000,
		costMicros: 1000000,
		wallMs: 60000,
		tokensPerRequest: 100000,
		costMicrosPerRequest: 1000000,
	};
	const path = join(root, "shared", "budget.json");
	const ledger = new PersistentModelBudget(path, limits);
	ledger.reserve("faux/generator", "candidate_generation");
	for (const axis of ["A", "B"] as const) {
		const freeze = makeFreeze(loadTasks(), axis, ["development"], 1, undefined, limits);
		freeze.jobs = freeze.jobs.slice(0, 2);
		const report = await runFrozen(freeze, join(root, axis), { budgetPath: path });
		expect(report.accounting.osLaunched).toBe(0);
		expect(report.overall.terminal.not_started).toBe(2);
	}
	expect(new PersistentModelBudget(path, limits).snapshot()).toMatchObject({
		requests: 1,
		unknown: 1,
		chargedTokens: 100000,
		chargedCostMicros: 1000000,
	});
});
it("rejects changing limit files during resume before touching an experiment", async () => {
	await expect(reliabilityCli(["--mode=resume", "--out=nonexistent", "--limits=unused"])).rejects.toThrow(/limits/);
});

it("refuses resume after a lost global ledger instead of resetting spent requests", async () => {
	const root = mkdtempSync(join(tmpdir(), "lost-campaign-ledger-"));
	roots.push(root);
	const freeze = makeFreeze(loadTasks(), "A", ["development"], 1);
	freeze.jobs = [];
	const out = join(root, "run");
	await runFrozen(freeze, out);
	rmSync(join(out, "campaign-budget.json"));
	await expect(resumeFrozen(freeze, out)).rejects.toThrow(/missing|reset/i);
	expect(readReport(freeze, out).accounting.campaign?.status).toBe("missing");
});

it("initializes a shared faux budget through CLI and refuses to overwrite it", async () => {
	const root = mkdtempSync(join(tmpdir(), "budget-cli-init-"));
	roots.push(root);
	const limits = join(root, "limits.json"),
		budget = join(root, "budget.json");
	writeFileSync(
		limits,
		JSON.stringify({
			requests: 3,
			tokens: 300,
			costMicros: 3000,
			wallMs: 60000,
			tokensPerRequest: 100,
			costMicrosPerRequest: 1000,
		}),
	);
	const output = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		await reliabilityCli(["--mode=budget", `--budget=${budget}`, `--limits=${limits}`]);
		const first = readFileSync(budget, "utf8");
		await expect(reliabilityCli(["--mode=budget", `--budget=${budget}`, `--limits=${limits}`])).rejects.toThrow(
			/exists/,
		);
		expect(readFileSync(budget, "utf8")).toBe(first);
	} finally {
		output.mockRestore();
	}
});
