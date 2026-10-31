import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoalStore as BeforeStore } from "./before/goals/store.ts";
import { createGoalTools as beforeTools } from "./before/tools/goal.ts";
import { GoalStore as AfterStore } from "../../../packages/lightclaw/src/goals/store.ts";
import { createGoalTools as afterTools } from "../../../packages/lightclaw/src/tools/goal.ts";

const output = dirname(fileURLToPath(import.meta.url));
const observations = [];
for (let repetition = 0; repetition < 5; repetition++) {
  for (const [arm, Store, tools] of [["before", BeforeStore, beforeTools], ["after", AfterStore, afterTools]]) {
    for (const scenario of ["actionable-rejection", "progress-during-verification", "duplicate-progress", "pause-resume-during-verification", "artifact-changed-during-verification"]) {
      const root = mkdtempSync(join(tmpdir(), "lightclaw-mechanism-"));
      try {
        const channelDir = join(root, "work");
        const store = new Store({ channelDir, controlChannelDir: join(root, "control"), limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 } });
        const signal = new AbortController().signal;
        const runtime = { channelDir, sandbox: { type: "docker", container: "faux-no-docker-exec" }, signal,
          assertActive() {}, reserveCommand: () => ({ timeoutSeconds: 1 }),
          executor: { getWorkspacePath: path => path, exec: async () => {
            if (scenario === "progress-during-verification") store.updateProgress("verification running", ["answer.txt"]);
            if (scenario === "pause-resume-during-verification") { store.pause(); store.resume(); }
            if (scenario === "artifact-changed-during-verification") writeFileSync(join(channelDir, "answer.txt"), "changed after check");
            return { code: 0, stdout: "", stderr: "" };
          } } };
        const acceptance = scenario === "actionable-rejection"
          ? { mode: "automatic", files: [{ path: "answer.txt", changed: false, contains: ["required text"] }], commands: [] }
          : { mode: "automatic", files: [{ path: "answer.txt", changed: false }], commands: [{ command: "faux-check", sourcePaths: ["answer.txt"] }] };
        await store.create({ objective: "produce answer", ownerUserId: "owner", acceptance }, signal);
        writeFileSync(join(channelDir, "answer.txt"), "correct");
        let success, evidence;
        if (scenario === "duplicate-progress") {
          store.updateProgress("read sources", ["A"]);
          const before = store.get().progressVersion;
          store.updateProgress("read sources", ["A"]);
          evidence = { previous: before, current: store.get().progressVersion };
          success = evidence.previous === evidence.current;
        } else {
          const result = await tools(store, () => runtime)[1].execute("probe", { summary: "done", evidence: ["answer.txt"] });
          const state = store.get();
          evidence = { text: result.content, state, artifact: readFileSync(join(channelDir, "answer.txt"), "utf8") };
          success = scenario === "actionable-rejection" ? JSON.stringify(result.content).includes("answer.txt") && JSON.stringify(result.content).includes("required text")
            : scenario === "progress-during-verification" ? state.status === "completed"
            : state.status !== "completed";
        }
        observations.push({ repetition, arm, scenario, success, evidence });
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
}
writeFileSync(join(output, "mechanism-runs.jsonl"), observations.map(row => JSON.stringify(row)).join("\n") + "\n");
const summary = [];
for (const scenario of new Set(observations.map(row => row.scenario))) {
  summary.push({ scenario, arms: Object.fromEntries(["before", "after"].map(arm => {
    const rows = observations.filter(row => row.arm === arm && row.scenario === scenario);
    return [arm, { runs: rows.length, correct_behavior: rows.filter(row => row.success).length,
      observed_success_variance: rows.every(row => row.success === rows[0].success) ? 0 : null }];
  })) });
}
writeFileSync(join(output, "mechanism-summary.json"), JSON.stringify({ scope: "deterministic filesystem/goal mechanism; no LLM, no Docker calls, no quality or cost estimate", summary }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
