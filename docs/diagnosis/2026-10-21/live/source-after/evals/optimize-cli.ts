#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { parseSandboxArg, validateSandbox } from "../sandbox.js";
import { meanScore, optimizePrompt } from "./optimizer.js";
import { loadEvalCases } from "./runner.js";

function argument(name: string, fallback?: string): string | undefined {
	const prefix = `--${name}=`;
	return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const workingDir = resolve(argument("workspace", "./lightclaw-data")!);
const defaultDataset = fileURLToPath(new URL("../../evals/basic.json", import.meta.url));
const datasetPath = resolve(argument("dataset", defaultDataset)!);
const defaultHoldout = fileURLToPath(new URL("../../evals/holdout.json", import.meta.url));
const holdoutPath = resolve(argument("holdout", defaultHoldout)!);
const repetitions = Number(argument("repetitions", "5"));
if (!Number.isSafeInteger(repetitions) || repetitions < 5 || repetitions > 20)
	throw new Error("repetitions 必须是 5 到 20 的整数");
const seeds = argument("seeds")?.split(",").map(Number);
const sandbox = parseSandboxArg(argument("sandbox", "docker:lightclaw-sandbox")!);
const outputPath = resolve(argument("output", `${workingDir}/evals/optimized-prompt.txt`)!);
const baselinePath = argument("prompt");
const count = Number(argument("candidates", "2"));
if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error("candidates 必须是 1 到 5 的整数");
const objective = argument("objective", "quality");
if (objective !== "quality" && objective !== "tokens" && objective !== "latency")
	throw new Error("objective 必须是 quality、tokens 或 latency");
const minImprovement = Number(argument("min-improvement", "0.05"));
const maxRegression = Number(argument("max-regression", "0.05"));
if (
	![minImprovement, maxRegression].every((value) => Number.isFinite(value) && value >= 0 && value < 1) ||
	(objective !== "quality" && minImprovement === 0)
)
	throw new Error("优化比例必须在 [0, 1) 范围内，成本改善阈值必须大于 0");

const config = loadConfig({
	...process.env,
	LIGHTCLAW_FEISHU_APP_ID: process.env.LIGHTCLAW_FEISHU_APP_ID ?? "eval",
	LIGHTCLAW_FEISHU_APP_SECRET: process.env.LIGHTCLAW_FEISHU_APP_SECRET ?? "eval",
	LIGHTCLAW_SLACK_APP_TOKEN: process.env.LIGHTCLAW_SLACK_APP_TOKEN ?? "eval",
	LIGHTCLAW_SLACK_BOT_TOKEN: process.env.LIGHTCLAW_SLACK_BOT_TOKEN ?? "eval",
});
if (baselinePath && !existsSync(baselinePath)) throw new Error(`找不到基线提示词：${baselinePath}`);
const baselinePrompt = baselinePath ? await readFile(baselinePath, "utf8") : (config.promptInstructions ?? "");

await validateSandbox(sandbox);
const cases = await loadEvalCases(datasetPath);
const holdoutCases = await loadEvalCases(holdoutPath);
const result = await optimizePrompt({
	cases,
	holdoutCases,
	repetitions,
	seeds,
	config,
	sandbox,
	workingDir,
	baselinePrompt: baselinePrompt.trim(),
	candidateCount: count,
	promotionPolicy: { objective, minImprovement, maxRegression },
});
await mkdir(dirname(outputPath), { recursive: true });
const reportPath = `${outputPath}.report.json`;
await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

if (result.promoted) {
	await writeFile(outputPath, `${result.bestPrompt.trim()}\n`, "utf8");
	console.log(
		`候选通过重复评测门禁：训练集 ${(meanScore(result.baseline.training) * 100).toFixed(1)}% -> ${(meanScore(result.best.training) * 100).toFixed(1)}%；留出集 ${(meanScore(result.best.holdout) * 100).toFixed(1)}%`,
	);
	console.log(`最佳提示词：${outputPath}`);
} else {
	console.log(
		`没有候选通过门禁，未覆盖提示词文件。训练集基线均分：${(meanScore(result.baseline.training) * 100).toFixed(1)}%`,
	);
}
console.log(`优化报告：${reportPath}`);
