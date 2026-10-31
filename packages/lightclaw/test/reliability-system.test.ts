import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { auditData, loadOracles, loadTasks, sha256 } from "../src/evals/reliability/data.js";
import { runFixture } from "../src/evals/reliability/fixture-runner.js";
import { checkerPath, judge } from "../src/evals/reliability/scoring.js";
import type { Job, Observation } from "../src/evals/reliability/types.js";

const roots: string[] = [];
afterEach(() => {
	for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function root() {
	const p = mkdtempSync(join(tmpdir(), "lightclaw-eval-v3-"));
	roots.push(p);
	return p;
}
const tasks = loadTasks(),
	oracles = loadOracles();
const job = (id: string): Job => ({
	id: `A-${id}-r0-governed`,
	caseId: id,
	arm: "governed",
	axis: "A",
	repetition: 0,
	seed: 17,
	artifactEligible: true,
	effectEligible: id === "d13",
});
it("audits independent families and never shares a family or exact prompt across splits", () => {
	const audit = auditData(tasks);
	expect(audit.tasks).toBe(36);
	expect(audit.families).toBe(36);
	expect(audit.nearDuplicates).toEqual([]);
	expect(audit.splitCounts).toEqual({ development: 13, selection: 12, blind: 11 });
});
it.each(["d01", "d02", "d03", "d04", "d13"])(
	"runs %s through actual AgentRunner and shared production orchestration without shell/network",
	async (id) => {
		const dir = root(),
			task = tasks.find((t) => t.id === id)!;
		const observed = await runFixture(task, oracles[id], job(id), dir, "");
		const score = judge(
			task,
			oracles[id],
			observed,
			realpathSync(join(dir, "work")),
			"evaluation",
			Object.fromEntries(Object.entries(task.inputs).map(([p, v]) => [p, sha256(v)])),
			sha256(readFileSync(checkerPath)),
		);
		expect(score.artifactCorrect).toBe(true);
		expect(score.inputPreserved).toBe(true);
		if (id === "d02") expect(observed.cycles).toBeGreaterThan(1);
		if (id === "d03") expect(observed.phases).toContain("pause-observed");
		if (id === "d04") {
			expect(observed.compactions).toBe(1);
			expect(observed.phases).toContain("pre-compaction-no-artifact");
			expect(observed.phases).toContain("post-compaction-artifact");
			const requests = readFileSync(join(dir, "requests.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { messages: unknown });
			expect(JSON.stringify(requests.at(-1)?.messages)).toContain("FROZEN_INPUT_CONSTRAINT");
		}
		if (id === "d13") expect(observed.duplicateEffects).toBe(0);
	},
);
it("rejects blind execution before creating an Agent", async () => {
	const task = tasks.find((t) => t.split === "blind")!;
	await expect(runFixture(task, oracles[task.id], job(task.id), root(), "")).rejects.toThrow("Blind");
});
it("distinguishes wrong-artifact completion, right-artifact system failure and shadowed checkers", () => {
	const dir = root(),
		channel = "evaluation",
		work = join(dir, "work");
	mkdirSync(join(work, channel), { recursive: true });
	const task = tasks[0];
	writeFileSync(join(work, channel, "input.json"), task.inputs["input.json"]);
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
		duplicateEffects: null,
		compactions: 0,
		cycles: 1,
		durationMs: 1,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, modelRequests: 1 },
		usageSource: "synthetic-faux-estimate",
		platform: "protocol-simulator",
		evidence: "faux-wiring-only",
	};
	const hashes = { "input.json": sha256(task.inputs["input.json"]) };
	const check = () =>
		judge(
			task,
			oracles[task.id],
			observation,
			realpathSync(work),
			channel,
			hashes,
			sha256(readFileSync(checkerPath)),
		);
	writeFileSync(join(work, channel, "result.json"), '{"net_cents":true}');
	writeFileSync(join(work, channel, "checker.py"), 'print("ALL_PASS")');
	expect(check()).toMatchObject({ artifactCorrect: false, falseCompletion: true, checkerIntegrity: true });
	writeFileSync(join(work, channel, "result.json"), JSON.stringify(oracles[task.id].expected));
	observation.systemFailure = true;
	observation.systemCompleted = false;
	expect(check()).toMatchObject({ artifactCorrect: true, falseCompletion: false, artifactRightSystemFailure: true });
	writeFileSync(join(work, channel, "result.json"), '{"net_cents":0,"net_cents":1700}');
	expect(check().artifactCorrect).toBe(false);
	mkdirSync(join(work, "other-channel"));
	writeFileSync(join(work, "other-channel", "private-fictional.json"), JSON.stringify(oracles[task.id].expected));
	rmSync(join(work, channel, "result.json"));
	symlinkSync(join(work, "other-channel", "private-fictional.json"), join(work, channel, "result.json"));
	expect(check().artifactCorrect).toBe(false);
	expect(() =>
		judge(task, oracles[task.id], observation, realpathSync(work), channel, hashes, "tampered-hash"),
	).toThrow("integrity");
	writeFileSync(join(work, channel, "input.json"), "changed");
	expect(check().inputPreserved).toBe(false);
});
