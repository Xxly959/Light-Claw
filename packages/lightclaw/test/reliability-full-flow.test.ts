import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { PersistentModelBudget } from "../src/evals/reliability/budget-ledger.js";
import { runFrozen } from "../src/evals/reliability/controller.js";
import { loadTasks } from "../src/evals/reliability/data.js";
import { makeFreeze } from "../src/evals/reliability/protocol.js";

it("retains a fresh full faux A/B matrix, frozen splits, failures, costs and paired reports", async () => {
	const base = resolve("../../docs/diagnosis/2026-11-05-continuation", `faux-v4-${randomUUID()}`);
	mkdirSync(base, { recursive: true });
	const defaults = makeFreeze(loadTasks(), "A", ["development", "selection"], 2).budget.campaign!;
	const limits = {
		...defaults,
		requests: defaults.requests * 2,
		tokens: defaults.tokens * 2,
		costMicros: defaults.costMicros * 2,
		wallMs: defaults.wallMs * 2,
	};
	const budgetPath = join(base, "shared-budget.json");
	new PersistentModelBudget(budgetPath, limits);
	let previousRequests = 0;
	for (const axis of ["A", "B"] as const) {
		const freeze = makeFreeze(loadTasks(), axis, ["development", "selection"], 2, undefined, limits);
		const out = join(base, axis),
			report = await runFrozen(freeze, out, { budgetPath });
		expect(report.overall.planned).toBe(100);
		expect(report.accounting.controllerRecords).toBe(100);
		const campaign = JSON.parse(readFileSync(budgetPath, "utf8"));
		expect(campaign.entries.length).toBeGreaterThan(previousRequests + 100);
		previousRequests = campaign.entries.length;
		expect(campaign.entries.length).toBeLessThanOrEqual(freeze.budget.campaign!.requests);
		expect(
			campaign.entries.every((row: { status: string }) => ["reserved", "settled", "unknown"].includes(row.status)),
		).toBe(true);
		expect(report.accounting.campaign).not.toBeNull();
		expect(report.accounting.osLaunched).toBe(100);
		expect(report.recordDiagnostics).toBeDefined();
		expect(report.paired?.tasks).toBe(25);
		expect(report.accounting.budgets.every((row) => row.ledger !== null)).toBe(true);
		expect(existsSync(join(out, "freeze.json"))).toBe(true);
		expect(readFileSync(join(out, "report.json"), "utf8")).toContain("faux-wiring-only");
		expect(freeze.jobs.every((job) => !job.caseId.startsWith("b"))).toBe(true);
	}
	console.log(JSON.stringify({ evidence: "faux-wiring-only", output: base, plannedAttempts: 200, realModelCalls: 0 }));
}, 360000);
