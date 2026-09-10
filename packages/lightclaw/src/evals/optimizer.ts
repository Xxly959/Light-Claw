import { homedir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { resolveApiKey, resolveModel } from "../agent.js";
import type { LightClawConfig } from "../config.js";
import type { SandboxConfig } from "../sandbox.js";
import { runEvaluation } from "./runner.js";
import type { EvalCase, EvalReport } from "./types.js";

export function parsePromptCandidates(text: string): string[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 字符串数组");
	const value: unknown = JSON.parse(text.slice(start, end + 1));
	if (!Array.isArray(value)) throw new Error("候选提示词必须是数组");
	const candidates = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	if (candidates.length === 0) throw new Error("模型没有生成有效候选提示词");
	return [...new Set(candidates.map((item) => item.trim()))];
}

export function isBetterReport(candidate: EvalReport, current: EvalReport): boolean {
	return candidate.score > current.score;
}

async function generateCandidates(
	config: LightClawConfig,
	cases: EvalCase[],
	baselinePrompt: string,
	baselineReport: EvalReport,
	count: number,
): Promise<string[]> {
	const model = resolveModel(config);
	const authStorage = AuthStorage.create(join(homedir(), ".pi", "lightclaw", "auth.json"));
	const apiKey = await resolveApiKey(authStorage, model.provider);
	const taskSummary = cases.map((item) => ({ id: item.id, prompt: item.prompt, expect: item.expect }));
	const failures = baselineReport.results.map((result) => ({
		id: result.id,
		score: result.score,
		failed: result.checks.filter((item) => !item.passed).map((item) => item.name),
	}));
	const request = `你是 Agent 系统提示词优化器。请生成 ${count} 个不同的中文行为指令候选，用于追加到既有系统提示词末尾。
要求：候选必须简洁、通用，不得包含 API Key，不得放宽安全边界，不得针对用例硬编码答案。
当前追加指令：${baselinePrompt || "（无）"}
评测任务：${JSON.stringify(taskSummary)}
当前结果：${JSON.stringify(failures)}
只输出 JSON 字符串数组，不要输出 Markdown。`;
	const message = await completeSimple(
		model,
		{ messages: [{ role: "user", content: request, timestamp: Date.now() }] },
		{ apiKey, temperature: 0.7, maxTokens: 2500 },
	);
	if (message.stopReason === "error") throw new Error(message.errorMessage ?? "生成候选提示词失败");
	const text = message.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	return parsePromptCandidates(text).slice(0, count);
}

export interface OptimizationResult {
	baseline: EvalReport;
	candidates: Array<{ prompt: string; report: EvalReport }>;
	bestPrompt: string;
	bestReport: EvalReport;
	promoted: boolean;
}

export async function optimizePrompt(options: {
	cases: EvalCase[];
	config: LightClawConfig;
	sandbox: SandboxConfig;
	workingDir: string;
	baselinePrompt: string;
	candidateCount: number;
}): Promise<OptimizationResult> {
	const baseline = await runEvaluation({
		...options,
		promptInstructions: options.baselinePrompt || undefined,
		promptLabel: "baseline",
	});
	const prompts = await generateCandidates(
		options.config,
		options.cases,
		options.baselinePrompt,
		baseline,
		options.candidateCount,
	);
	const candidates: Array<{ prompt: string; report: EvalReport }> = [];
	let bestPrompt = options.baselinePrompt;
	let bestReport = baseline;

	for (const [index, prompt] of prompts.entries()) {
		const report = await runEvaluation({
			...options,
			promptInstructions: prompt,
			promptLabel: `candidate-${index + 1}`,
		});
		candidates.push({ prompt, report });
		if (isBetterReport(report, bestReport)) {
			bestPrompt = prompt;
			bestReport = report;
		}
	}

	return { baseline, candidates, bestPrompt, bestReport, promoted: bestPrompt !== options.baselinePrompt };
}
