#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { parseSandboxArg, validateSandbox } from "../sandbox.js";
import { defaultReportPath, loadEvalCases, runEvaluation } from "./runner.js";

function argument(name: string, fallback?: string): string | undefined {
	const prefix = `--${name}=`;
	return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const workingDir = resolve(argument("workspace", "./lightclaw-data")!);
const defaultDataset = fileURLToPath(new URL("../../evals/basic.json", import.meta.url));
const datasetPath = resolve(argument("dataset", defaultDataset)!);
const sandbox = parseSandboxArg(argument("sandbox", "docker:lightclaw-sandbox")!);
const reportPath = resolve(argument("report", defaultReportPath(workingDir))!);
const config = loadConfig({
	...process.env,
	LIGHTCLAW_FEISHU_APP_ID: process.env.LIGHTCLAW_FEISHU_APP_ID ?? "eval",
	LIGHTCLAW_FEISHU_APP_SECRET: process.env.LIGHTCLAW_FEISHU_APP_SECRET ?? "eval",
	LIGHTCLAW_SLACK_APP_TOKEN: process.env.LIGHTCLAW_SLACK_APP_TOKEN ?? "eval",
	LIGHTCLAW_SLACK_BOT_TOKEN: process.env.LIGHTCLAW_SLACK_BOT_TOKEN ?? "eval",
});

await validateSandbox(sandbox);
const cases = await loadEvalCases(datasetPath);
const report = await runEvaluation({ cases, config, sandbox, workingDir, promptLabel: "current" });
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`评测完成：${report.passedCases}/${report.totalCases}，得分 ${(report.score * 100).toFixed(1)}%`);
console.log(`报告：${reportPath}`);
