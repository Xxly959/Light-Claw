import { expect, it } from "vitest";
import { loadTasks } from "../src/evals/reliability/data.js";
import { makeFreeze } from "../src/evals/reliability/protocol.js";
import { joinAttempts, pairedTaskEffect, resolveTerminal, summarize } from "../src/evals/reliability/statistics.js";
import type { Attempt, Observation, Score } from "../src/evals/reliability/types.js";

const observation: Observation = {
	decision: "complete",
	systemCompleted: true,
	goalStatus: "completed",
	phases: [],
	humanRequired: false,
	taskLost: false,
	inboxStatus: "completed",
	humanInterventions: 0,
	toolErrors: 0,
	productTimeout: false,
	systemFailure: false,
	accepted: true,
	consumed: true,
	unresolved: 0,
	duplicateEffects: 0,
	compactions: 0,
	cycles: 1,
	durationMs: 10,
	usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, modelRequests: 1 },
	usageSource: "synthetic-faux-estimate",
	platform: "protocol-simulator",
	evidence: "faux-wiring-only",
};
const score: Score = {
	artifactCorrect: true,
	inputPreserved: true,
	businessValid: true,
	checkerIntegrity: true,
	handlingCorrect: true,
	falseCompletion: false,
	modelFalseCompletion: false,
	falseRefusal: false,
	artifactRightSystemFailure: false,
};
const freeze = () => makeFreeze(loadTasks(), "A", ["development"], 2);
function row(index = 0): Attempt {
	return {
		job: freeze().jobs[index],
		terminal: "completed",
		controller: { code: 0, signal: null, timeout: false, boots: 1 },
		observation: structuredClone(observation),
		score: structuredClone(score),
		cost: null,
	};
}
it("gives external timeout exclusive priority even when the worker exited zero and claimed success", () => {
	const record = row();
	record.controller.timeout = true;
	expect(resolveTerminal(record.controller, record.observation)).toBe("external_timeout");
	expect(joinAttempts(freeze(), [record])[0].terminal).toBe("external_timeout");
});
it("separates unstarted, missing records, incomplete workers and unresolved tasks", () => {
	const plan = freeze(),
		first = plan.jobs[0].id;
	expect(
		joinAttempts(plan, [], new Set([first]))
			.slice(0, 2)
			.map((r) => r.terminal),
	).toEqual(["missing_record", "not_started"]);
	expect(resolveTerminal({ code: 0, signal: null, timeout: false, boots: 1 }, null)).toBe("missing_record");
	expect(resolveTerminal({ code: 1, signal: null, timeout: false, boots: 1 }, observation)).toBe("worker_error");
	expect(resolveTerminal(row().controller, { ...observation, unresolved: 1 })).toBe("task_failed");
	expect(() => joinAttempts(plan, [row(), row()])).toThrow("duplicate");
	const forged = row();
	forged.job = { ...forged.job, caseId: "unplanned" };
	expect(() => joinAttempts(plan, [forged])).toThrow("plan");
});
it("keeps missing usage unknown, failures in denominator and non-artifact tasks N/A", () => {
	const good = row(),
		failed = row(1);
	failed.controller.timeout = true;
	failed.observation = null;
	failed.score = null;
	failed.terminal = "external_timeout";
	const refusal = row(2);
	refusal.job = { ...refusal.job, artifactEligible: false };
	refusal.score = { ...score, artifactCorrect: null, businessValid: null };
	const stats = summarize([good, failed, refusal]);
	expect(stats.metrics.artifactExact).toMatchObject({
		denominator: 2,
		known: 1,
		unknown: 1,
		value: null,
		lowerBound: 0.5,
		upperBound: 1,
	});
	expect(stats.metrics.artifactNotApplicable).toBe(1);
	expect(stats.resources.input).toMatchObject({ known: 2, unknown: 1, observedTotal: 200, fullTotal: null });
	expect(stats.cost).toBeNull();
});
it("averages repetitions within tasks and bootstraps tasks, never treating repeated attempts as independent tasks", () => {
	const rows = freeze()
		.jobs.filter((j) => ["d01", "d02"].includes(j.caseId))
		.map((job) => ({ ...row(), job }));
	for (const record of rows)
		if (record.job.caseId === "d01" && record.job.arm === "baseline")
			record.score = { ...score, artifactCorrect: false };
	const effect = pairedTaskEffect(rows, "baseline", "governed")!;
	expect(effect.tasks).toBe(2);
	expect(effect.attempts).toBe(8);
	expect(effect.difference).toBe(0.5);
	expect(() => pairedTaskEffect(rows.slice(1), "baseline", "governed")).toThrow("Unbalanced");
});
it("freezes disjoint A and B comparisons and blocks blind faux execution", () => {
	const a = freeze(),
		b = makeFreeze(loadTasks(), "B", ["selection"], 2, "candidate v1");
	expect(new Set(a.jobs.map((j) => j.arm))).toEqual(new Set(["baseline", "governed"]));
	expect(new Set(b.jobs.map((j) => j.arm))).toEqual(new Set(["governed", "candidate"]));
	expect(b.prompts.candidate).toBe("candidate v1");
	expect(a.jobs[0].arm).not.toBe(a.jobs[2].arm);
	expect(() => makeFreeze(loadTasks(), "B", ["blind"], 1)).toThrow("blind");
});
