import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { buildSystemPrompt } from "../../../packages/coding-agent/src/core/system-prompt.ts";
import { decidePromotion } from "../../../packages/lightclaw/src/evals/optimizer.ts";

const directory = new URL("./", import.meta.url);
const previous = JSON.parse(await readFile(new URL("../2026-10-21-ablation/raw/prompt-selection.json", directory), "utf8"));
const cheaper = structuredClone(previous.baseline);
for (const split of ["training", "holdout"]) {
	for (const report of cheaper[split]) {
		report.totalTokens /= 2;
		for (const result of report.results) {
			result.run.durationMs /= 2;
			result.run.inputTokens /= 2;
			result.run.outputTokens /= 2;
		}
	}
}
const decision = decidePromotion(cheaper, previous.baseline);
assert.equal(decision.passed, false);
assert.deepEqual(decision.reasons, ["训练集均分未严格提高"]);
const prompt = buildSystemPrompt({ customPrompt: "Docker working directory: /workspace", cwd: "/host-path-that-is-not-in-container", selectedTools: ["bash"] });
assert.ok(prompt.includes("Docker working directory: /workspace"));
assert.ok(prompt.endsWith("Current working directory: /host-path-that-is-not-in-container"));
const generation = JSON.parse(await readFile(new URL("../2026-10-21-ablation/raw/prompt-generated-candidate.json", directory), "utf8"));
assert.equal(generation.instruction.includes("file: not found"), false);
assert.equal(generation.instruction.includes("Current working directory"), false);
const results = { sameQualityHalfTokenAndLatency: { accepted: decision.passed, reasons: decision.reasons },
	customSystemPromptStillGetsHostCwdAppended: true, reproducedPrompt: prompt,
	candidateGeneratorReceivedActualMissingCommandError: false,
	candidateGeneratorReceivedActualSystemPrompt: false,
	note: "Counterfactual report checks policy, not an achieved 50% saving; no model API calls." };
await writeFile(new URL("raw/policy-probes.json", directory), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results));
