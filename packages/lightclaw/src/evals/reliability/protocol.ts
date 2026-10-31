import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { auditData, dataRoot, sha256 } from "./data.js";
import type { Freeze, Job, ReliabilityTask, Split } from "./types.js";
export const repository = fileURLToPath(new URL("../../../../../", import.meta.url));
function walk(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(root, e.name)) : [join(root, e.name)],
	);
}
export function frozenHashes(): Record<string, string> {
	const files = [
		...walk(join(repository, "packages/lightclaw/src")),
		...walk(join(repository, "packages/coding-agent/src")),
		...walk(join(repository, "packages/agent/src")),
		...walk(join(repository, "packages/ai/src")),
		...walk(join(repository, "packages/tui/src")),
		join(repository, "tsconfig.json"),
		join(repository, "tsconfig.base.json"),
		...walk(dataRoot),
		join(repository, "package-lock.json"),
		join(repository, "packages/lightclaw/package.json"),
	].filter((p) => /\.(ts|py|json)$/.test(p));
	return Object.fromEntries(files.sort().map((p) => [relative(repository, p), sha256(readFileSync(p))]));
}
export function assertFrozen(freeze: Freeze): void {
	if (JSON.stringify(Object.keys(freeze.hashes).sort()) !== JSON.stringify(Object.keys(frozenHashes()).sort()))
		throw new Error("Incomplete frozen source inventory");
	for (const [name, hash] of Object.entries(freeze.hashes)) {
		const path = join(repository, name);
		if (!existsSync(path) || sha256(readFileSync(path)) !== hash)
			throw new Error(`Frozen source/data changed: ${name}`);
	}
}
export function makeFreeze(
	tasks: ReliabilityTask[],
	axis: "A" | "B",
	splits: Split[],
	repetitions: number,
	candidate = "先核对输入与约束，再提交可验收结果；信息不足时请求澄清。",
): Freeze {
	if (splits.includes("blind"))
		throw new Error("Offline wiring cannot execute blind tasks; approval required for real experiment");
	if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10)
		throw new Error("Invalid repetition count");
	const audit = auditData(tasks);
	if (audit.nearDuplicates.length) throw new Error("Near duplicate audit requires resolution");
	const selected = tasks.filter((t) => splits.includes(t.split));
	const arms: Job["arm"][] = axis === "A" ? ["baseline", "governed"] : ["governed", "candidate"];
	const jobs: Job[] = [];
	for (let repetition = 0; repetition < repetitions; repetition++)
		for (const [index, task] of selected.entries())
			for (const arm of (repetition + index) % 2 ? [...arms].reverse() : arms)
				jobs.push({
					id: `${axis}-${task.id}-r${repetition}-${arm}`,
					caseId: task.id,
					arm,
					repetition,
					seed: 17 + repetition * 104729,
					axis,
					artifactEligible: !["clarify", "refuse", "unable"].includes(task.scenario),
					effectEligible: task.scenario === "controlled-effect",
				});
	return {
		schema: 1,
		evidence: "faux-wiring-only",
		axis,
		splits,
		repetitions,
		jobs,
		hashes: frozenHashes(),
		node: process.version,
		python: execFileSync("python3", ["--version"], { encoding: "utf8" }).trim(),
		runtime: {
			orchestration: "shared runtime.ts used by main.ts",
			gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
			sourceState: "dirty workspace, complete source hashes are authoritative",
			platform: process.platform,
			arch: process.arch,
			seedPolicy: "paired label only in deterministic faux mode; no stochastic model inference",
			candidateOrigin: "manually authored wiring placeholder; automatic generation not run",
			model: "faux/wiring",
			temperature: 0,
			maxTokens: 2048,
			tools: "bounded-file + real goal tools + controlled mock effect; no shell/network",
			sandbox: "bounded-file-tools in isolated temporary directory, no model host commands",
			safety: "same mandatory inbox/lock in both arms",
			A: "toggle goal/acceptance with matched input, tools, budgets; raw and normalized effective payloads retained",
			B: "identical runtime hash/config; only appended candidate string varies; incidental goal IDs/paths are recorded nuisance variables",
		},
		prompts: { baseline: "", candidate: axis === "B" ? candidate : "" },
		budget: { maxConcurrent: 2, externalTimeoutMs: 12_000, maxRequestsPerAttempt: 16 },
		candidateCost: { generation: "not_run", selection: "recorded_per_attempt", money: null },
	};
}
