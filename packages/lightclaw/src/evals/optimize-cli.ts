#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { parseSandboxArg, validateSandbox } from "../sandbox.js";
import { optimizePrompt } from "./optimizer.js";
import { loadEvalCases } from "./runner.js";

function argument(name: string, fallback?: string): string | undefined {
	const prefix = `--${name}=`;
	return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const workingDir = resolve(argument("workspace", "./lightclaw-data")!);
const defaultDataset = fileURLToPath(new URL("../../evals/basic.json", import.meta.url));
const datasetPath = resolve(argument("dataset", defaultDataset)!);
const sandbox = parseSandboxArg(argument("sandbox", "docker:lightclaw-sandbox")!);
const outputPath = resolve(argument("output", `${workingDir}/evals/optimized-prompt.txt`)!);
const baselinePath = argument("prompt");
const count = Number(argument("candidates", "2"));
if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error("candidates 必须是 1 到 5 的整数");

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
const result = await optimizePrompt({
	cases,
	config,
	sandbox,
	workingDir,
	baselinePrompt: baselinePrompt.trim(),
	candidateCount: count,
});
await mkdir(dirname(outputPath), { recursive: true });
const reportPath = `${outputPath}.report.json`;
await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

if (result.promoted) {
	await writeFile(outputPath, `${result.bestPrompt.trim()}\n`, "utf8");
	console.log(
		`提示词已提升：${(result.baseline.score * 100).toFixed(1)}% -> ${(result.bestReport.score * 100).toFixed(1)}%`,
	);
	console.log(`最佳提示词：${outputPath}`);
} else {
	console.log(`没有候选超过基线，未覆盖提示词文件。基线得分：${(result.baseline.score * 100).toFixed(1)}%`);
}
console.log(`优化报告：${reportPath}`);
