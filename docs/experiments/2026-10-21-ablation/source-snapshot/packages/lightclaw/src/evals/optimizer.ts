import { homedir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { resolveApiKey, resolveModel } from "../agent.js";
import type { LightClawConfig } from "../config.js";
import type { SandboxConfig } from "../sandbox.js";
import { runEvaluation, validateEvalCases } from "./runner.js";
import type { EvalCase, EvalReport } from "./types.js";

export function parsePromptCandidates(text: string): string[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 字符串数组");
	const value: unknown = JSON.parse(text.slice(start, end + 1));
	if (!Array.isArray(value)) throw new Error("候选提示词必须是数组");
	if (value.length === 0 || value.some((item) => typeof item !== "string" || item.trim().length === 0))
		throw new Error("候选提示词必须全部是非空字符串");
	const candidates = value as string[];
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
	if (message.stopReason !== "stop")
		throw new Error(message.errorMessage ?? `生成候选提示词未完成：${message.stopReason}`);
	const text = message.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	return parsePromptCandidates(text).slice(0, count);
}

export interface RepeatedEvaluation {
	training: EvalReport[];
	holdout: EvalReport[];
}

export interface PromotionDecision {
	passed: boolean;
	reasons: string[];
}

export interface OptimizationResult {
	schemaVersion: 2;
	repetitions: number;
	baseline: RepeatedEvaluation;
	candidates: Array<{ prompt: string; evaluation: RepeatedEvaluation; decision: PromotionDecision }>;
	bestPrompt: string;
	best: RepeatedEvaluation;
	promoted: boolean;
}

export interface OptimizationOptions {
	cases: EvalCase[];
	holdoutCases: EvalCase[];
	repetitions?: number;
	config: LightClawConfig;
	sandbox: SandboxConfig;
	workingDir: string;
	baselinePrompt: string;
	candidateCount: number;
}

export function meanScore(reports: EvalReport[]): number {
	if (
		reports.length === 0 ||
		reports.some((report) => !Number.isFinite(report.score) || report.score < 0 || report.score > 1)
	)
		throw new Error("评测报告得分无效");
	return reports.reduce((sum, report) => sum + report.score, 0) / reports.length;
}

function compareDataset(candidate: EvalReport[], current: EvalReport[], label: string, reasons: string[]): void {
	const ids = current[0].results.map((result) => result.id).sort();
	for (const report of [...current, ...candidate]) {
		if (
			report.totalCases !== ids.length ||
			JSON.stringify(report.results.map((result) => result.id).sort()) !== JSON.stringify(ids)
		)
			throw new Error(`${label} 评测用例不一致`);
	}
	for (const id of ids) {
		const before = current.flatMap((report) => report.results.filter((result) => result.id === id));
		const after = candidate.flatMap((report) => report.results.filter((result) => result.id === id));
		if (after.some((result) => !Number.isFinite(result.score) || result.score < 0 || result.score > 1))
			throw new Error(`${label}/${id} 得分无效`);
		const expectedChecks = before[0].checks.map((check) => check.name).sort();
		if (
			[...before, ...after].some(
				(result) =>
					JSON.stringify(result.checks.map((check) => check.name).sort()) !== JSON.stringify(expectedChecks),
			)
		)
			throw new Error(`${label}/${id} 检查规则不一致`);
		if (Math.min(...after.map((result) => result.score)) < Math.min(...before.map((result) => result.score)))
			reasons.push(`${label}/${id}: 最低用例得分退化`);
		if (
			Math.max(...after.map((result) => result.run.toolErrors)) >
				Math.max(...before.map((result) => result.run.toolErrors)) ||
			after.reduce((sum, result) => sum + result.run.toolErrors, 0) >
				before.reduce((sum, result) => sum + result.run.toolErrors, 0)
		)
			reasons.push(`${label}/${id}: 工具错误增加`);
		const failures = (reports: typeof before, prefix: string) =>
			Math.max(
				...reports.map(
					(result) => result.checks.filter((check) => check.name.startsWith(prefix) && !check.passed).length,
				),
			);
		if (failures(after, "file_") > failures(before, "file_")) reasons.push(`${label}/${id}: 产物检查失败增加`);
		for (const name of expectedChecks) {
			if (
				name.startsWith("file_") &&
				after.filter((result) => !result.checks.find((check) => check.name === name)?.passed).length >
					before.filter((result) => !result.checks.find((check) => check.name === name)?.passed).length
			)
				reasons.push(`${label}/${id}: ${name} 失败频率增加`);
			if (
				before.every((result) => result.checks.find((check) => check.name === name)?.passed) &&
				after.some((result) => !result.checks.find((check) => check.name === name)?.passed)
			)
				reasons.push(`${label}/${id}: ${name} 回归`);
		}
	}
}

export function decidePromotion(candidate: RepeatedEvaluation, current: RepeatedEvaluation): PromotionDecision {
	if (
		[candidate.training, candidate.holdout, current.training, current.holdout].some(
			(reports) => reports.length < 3 || reports.length !== current.training.length,
		)
	)
		throw new Error("repetitions 必须一致且至少为 3");
	const reasons: string[] = [];
	if (meanScore(candidate.training) <= meanScore(current.training)) reasons.push("训练集均分未严格提高");
	if (meanScore(candidate.holdout) < meanScore(current.holdout)) reasons.push("留出集均分退化");
	compareDataset(candidate.training, current.training, "训练集", reasons);
	compareDataset(candidate.holdout, current.holdout, "留出集", reasons);
	return { passed: reasons.length === 0, reasons };
}

export async function optimizePrompt(
	options: OptimizationOptions,
	dependencies: { evaluate?: typeof runEvaluation; generate?: typeof generateCandidates } = {},
): Promise<OptimizationResult> {
	validateEvalCases(options.cases);
	validateEvalCases(options.holdoutCases);
	const repetitions = options.repetitions ?? 3;
	if (!Number.isSafeInteger(repetitions) || repetitions < 3 || repetitions > 20)
		throw new Error("repetitions 必须是 3 到 20 的整数");
	if (!Number.isSafeInteger(options.candidateCount) || options.candidateCount < 1 || options.candidateCount > 5)
		throw new Error("candidateCount 必须是 1 到 5 的整数");
	const ids = new Set(options.cases.map((item) => item.id));
	const promptsSeen = new Set(options.cases.map((item) => item.prompt.trim()));
	if (options.holdoutCases.some((item) => ids.has(item.id) || promptsSeen.has(item.prompt.trim())))
		throw new Error("训练集与留出集不能共享 ID 或任务提示");
	const evaluate = dependencies.evaluate ?? runEvaluation;
	const evaluateRepeated = async (prompt: string, label: string): Promise<RepeatedEvaluation> => {
		const result: RepeatedEvaluation = { training: [], holdout: [] };
		for (let repetition = 0; repetition < repetitions; repetition++) {
			for (const dataset of ["training", "holdout"] as const) {
				result[dataset].push(
					await evaluate({
						cases: dataset === "training" ? options.cases : options.holdoutCases,
						config: options.config,
						sandbox: options.sandbox,
						workingDir: options.workingDir,
						promptInstructions: prompt,
						promptLabel: `${label}-${dataset}-${repetition + 1}`,
					}),
				);
			}
		}
		return result;
	};
	const baseline = await evaluateRepeated(options.baselinePrompt, "baseline");
	const prompts = await (dependencies.generate ?? generateCandidates)(
		options.config,
		options.cases,
		options.baselinePrompt,
		baseline.training[0],
		options.candidateCount,
	);
	// Injected generators use the same strict candidate contract as model output.
	parsePromptCandidates(JSON.stringify(prompts));
	const candidates: OptimizationResult["candidates"] = [];
	let bestPrompt = options.baselinePrompt;
	let best = baseline;

	for (const [index, prompt] of prompts.slice(0, options.candidateCount).entries()) {
		const evaluation = await evaluateRepeated(prompt, `candidate-${index + 1}`);
		const decision = decidePromotion(evaluation, best);
		candidates.push({ prompt, evaluation, decision });
		if (decision.passed) {
			bestPrompt = prompt;
			best = evaluation;
		}
	}

	return {
		schemaVersion: 2,
		repetitions,
		baseline,
		candidates,
		bestPrompt,
		best,
		promoted: bestPrompt !== options.baselinePrompt,
	};
}
