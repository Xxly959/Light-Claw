import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../docs/diagnosis/2026-10-21/analyze-live-v2.py", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function sample() {
	const root = mkdtempSync(join(tmpdir(), "lightclaw-stats-"));
	dirs.push(root);
	const live = join(root, "live");
	const out = join(root, "out");
	mkdirSync(live);
	const save = (path: string, data: unknown) => {
		mkdirSync(join(live, path, ".."), { recursive: true });
		writeFileSync(join(live, path), JSON.stringify(data));
	};
	const job = (id: string) => ({ id, arm: "fixture", caseId: id, repetition: 0 });
	const record = (id: string, success = true, usage: object | null = { totalTokens: 10 }) => ({
		...job(id),
		success,
		cycles: 1,
		modelRequests: 1,
		usage,
		result: { checks: [{ name: "agent_run", passed: success }], run: { durationMs: 2, toolErrors: 0, cost: 0 } },
	});
	const ids = [
		"success",
		"failure",
		"timeout-success",
		"worker",
		"missing",
		"no-controller",
		"not-started",
		"invalid",
		"no-usage",
	];
	save("phase-freeze.json", { jobs: ids.map(job) });
	save("phase-complete.json", {
		finished: 7,
		planned: 9,
		budgetLimited: true,
		reserved: 12,
		reportedTokens: 75,
		results: [
			{ id: "success", code: 0, timeout: false },
			{ id: "failure", code: 0, timeout: false },
			{ id: "timeout-success", code: 0, timeout: true },
			{ id: "worker", code: 1, timeout: false },
			{ id: "missing", code: 0, timeout: false },
			{ id: "invalid", code: 0, timeout: false },
			{ id: "no-usage", code: 0, timeout: false },
		],
	});
	for (const id of ["success", "timeout-success", "no-controller"]) save(`raw/${id}/run.json`, record(id));
	save("raw/failure/run.json", record("failure", false));
	save("raw/invalid/run.json", { id: "invalid", success: true });
	save("raw/no-usage/run.json", record("no-usage", true, null));
	const run = (...args: string[]) =>
		execFileSync("python3", ["-I", script, "--live-dir", live, "--output-dir", out, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	return { root, live, out, save, run };
}
it("joins frozen plans, start evidence, controllers and records without double counting", () => {
	const f = sample();
	f.run();
	const report = JSON.parse(readFileSync(join(f.out, "live-summary.v2.json"), "utf8"));
	const m = report.formal;
	expect(m.counts).toMatchObject({
		planned: 9,
		started_evidenced: 8,
		controller_results: 7,
		record_files: 6,
		complete_records: 5,
		not_started: 1,
		missing_records_started: 2,
		invalid_records: 1,
	});
	expect(m.terminal_states).toMatchObject({
		success: 2,
		task_failure: 1,
		external_timeout: 1,
		worker_error: 1,
		missing_record: 1,
		missing_controller: 1,
		not_started: 1,
		invalid_record: 1,
	});
	expect(Object.values(m.terminal_states).reduce((a: number, b) => a + Number(b), 0)).toBe(9);
	expect(m.success_rate_started).toBe(2 / 8);
	expect(m.resources.totalTokens).toMatchObject({
		known_attempts: 4,
		missing_attempts: 4,
		observed_total: 40,
		total_if_complete: null,
		mean_of_known: 10,
	});
	expect(m.cost).toBeNull();
	expect(report.conflicts).toEqual(
		expect.arrayContaining([expect.objectContaining({ id: "timeout-success", kind: "timeout_with_success_record" })]),
	);
	expect(f.run("--check")).toContain("verified");
	expect(() => f.run()).toThrow();
});
it("does not confuse pre-created job files or empty dispatch directories with started workers", () => {
	const f = sample();
	f.save("unfinished-freeze.json", {
		jobs: [
			{ id: "uncertain", arm: "fixture" },
			{ id: "dispatched", arm: "fixture" },
		],
	});
	f.save("jobs/uncertain.json", { id: "uncertain" });
	mkdirSync(join(f.live, "raw/dispatched"), { recursive: true });
	f.run();
	const report = JSON.parse(readFileSync(join(f.out, "live-summary.v2.json"), "utf8"));
	expect(report.phases.unfinished.counts).toMatchObject({
		planned: 2,
		started_evidenced: 0,
		start_unknown: 2,
		not_started: 0,
	});
});
it("keeps progress-only outcomes and never overwrites conflicting controller evidence", () => {
	const f = sample();
	f.save("phase-progress.jsonl", { id: "success", code: null, signal: "SIGKILL", timeout: true });
	f.run();
	const report = JSON.parse(readFileSync(join(f.out, "live-summary.v2.json"), "utf8"));
	expect(report.formal.terminal_states.success).toBe(1);
	expect(report.formal.terminal_states.external_timeout).toBe(2);
	expect(report.conflicts).toEqual(
		expect.arrayContaining([expect.objectContaining({ id: "success", kind: "controller_disagreement" })]),
	);
});
it("rejects duplicate frozen identities instead of silently overwriting a job", () => {
	const f = sample();
	f.save("duplicate-freeze.json", { jobs: [{ id: "success" }] });
	expect(() => f.run()).toThrow();
});
