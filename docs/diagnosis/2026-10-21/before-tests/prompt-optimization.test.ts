import { describe, expect, it, vi } from "vitest";
import type { LightClawConfig } from "../src/config.js";
import { decidePromotion, optimizePrompt, parsePromptCandidates } from "../src/evals/optimizer.js";
import type { runEvaluation } from "../src/evals/runner.js";
import type { EvalCase, EvalReport } from "../src/evals/types.js";

const cases: EvalCase[] = [{ id: "train", prompt: "training task", expect: { responseIncludes: ["ok"] } }];
const holdoutCases: EvalCase[] = [{ id: "holdout", prompt: "unseen task", expect: { responseIncludes: ["ok"] } }];

function report(id: string, score: number, toolErrors = 0, artifactPassed = true): EvalReport {
	return {
		createdAt: "2026-01-01T00:00:00.000Z",
		model: "faux/model",
		promptLabel: "test",
		score,
		passedCases: score === 1 ? 1 : 0,
		totalCases: 1,
		totalCost: 0,
		totalTokens: 0,
		results: [
			{
				id,
				score,
				response: "ok",
				checks: [{ name: "file_exists:proof.txt", passed: artifactPassed, detail: "local" }],
				run: {
					stopReason: "stop",
					durationMs: 1,
					toolCalls: 1,
					verificationCommandCount: 0,
					toolErrors,
					inputTokens: 0,
					outputTokens: 0,
					cost: 0,
				},
			},
		],
	};
}

const options = {
	cases,
	holdoutCases,
	repetitions: 3,
	config: {
		transport: "feishu" as const,
		modelProvider: "unused",
		modelId: "unused",
		maxGoalCycles: 1,
		maxGoalFailures: 1,
		maxStaleCycles: 1,
	},
	sandbox: { type: "host" as const },
	workingDir: "/tmp/unused",
	baselinePrompt: "baseline",
	candidateCount: 1,
};

describe("repeated holdout prompt promotion", () => {
	it("accepts repeatable token savings with equal quality and rejects latency tradeoffs", () => {
		const evaluation = (tokens: number, duration: number, score = 1) => {
			const reports = (id: string) =>
				Array.from({ length: 3 }, () => {
					const item = report(id, score);
					item.totalTokens = tokens;
					item.results[0].run.durationMs = duration;
					return item;
				});
			return { training: reports("train"), holdout: reports("holdout") };
		};
		const baseline = evaluation(100, 100);
		const policy = { objective: "tokens" as const, minImprovement: 0.05, maxRegression: 0.05 };
		expect(decidePromotion(evaluation(80, 100), baseline, policy).passed).toBe(true);
		expect(decidePromotion(evaluation(80, 120), baseline, policy).passed).toBe(false);
		expect(decidePromotion(evaluation(80, 100, 0.9), baseline, policy).passed).toBe(false);
		expect(decidePromotion(evaluation(99, 100), baseline, policy).passed).toBe(false);
		const noisy = evaluation(80, 100);
		noisy.holdout[1].totalTokens = 110;
		expect(decidePromotion(noisy, baseline, policy).passed).toBe(false);
		const broken = evaluation(80, 100);
		broken.training[0].results[0].run.toolErrors = 1;
		expect(decidePromotion(broken, baseline, policy).passed).toBe(false);
		broken.training[0].totalTokens = Number.NaN;
		expect(() => decidePromotion(broken, baseline, policy)).toThrow("成本指标");
		expect(decidePromotion(evaluation(100, 80), baseline, { ...policy, objective: "latency" }).passed).toBe(true);
		expect(() => decidePromotion(baseline, baseline, { ...policy, minImprovement: Number.NaN })).toThrow();
	});
	it("keeps holdout cases out of generation and repeats every dataset for each prompt", async () => {
		const generate = vi.fn(
			async (
				_config: LightClawConfig,
				_cases: EvalCase[],
				_prompt: string,
				_reports: EvalReport[],
				_count: number,
			) => ["candidate"],
		);
		const evaluate = vi.fn(async (input: Parameters<typeof runEvaluation>[0]) =>
			report(input.cases[0].id, input.promptInstructions === "candidate" && input.cases[0].id === "train" ? 1 : 0.5),
		);
		const result = await optimizePrompt(options, { generate, evaluate });
		expect(generate.mock.calls[0]?.[1]).toEqual(cases);
		expect(generate.mock.calls[0]?.[3]).toHaveLength(3);
		expect(JSON.stringify(generate.mock.calls)).not.toContain("unseen task");
		expect(evaluate).toHaveBeenCalledTimes(12);
		expect(result.baseline.training).toHaveLength(3);
		expect(result.candidates[0].evaluation.holdout).toHaveLength(3);
		expect(result.promoted).toBe(true);
	});

	it.each(["holdout", "tool", "artifact", "unstable", "tool_frequency", "artifact_frequency"])(
		"rejects training gains with a %s regression",
		async (regression) => {
			let holdoutRun = 0;
			const runs = new Map<string, number>();
			const evaluate = async (input: Parameters<typeof runEvaluation>[0]) => {
				const id = input.cases[0].id;
				const candidate = input.promptInstructions === "candidate";
				const iteration = (runs.get(`${id}-${candidate}`) ?? 0) + 1;
				runs.set(`${id}-${candidate}`, iteration);
				const weak =
					candidate &&
					id === "holdout" &&
					(regression === "holdout" || (regression === "unstable" && ++holdoutRun === 1));
				if (regression === "tool_frequency" || regression === "artifact_frequency")
					return report(
						id,
						candidate ? 1 : 0.5,
						regression === "tool_frequency" && (candidate || iteration === 3) ? 1 : 0,
						!(regression === "artifact_frequency" && (candidate || iteration === 3)),
					);
				return report(
					id,
					weak ? 0.1 : candidate ? 1 : 0.5,
					candidate && regression === "tool" ? 1 : 0,
					!(candidate && regression === "artifact"),
				);
			};
			const result = await optimizePrompt(options, { generate: async () => ["candidate"], evaluate });
			expect(result.promoted).toBe(false);
			expect(result.candidates[0].decision.reasons.length).toBeGreaterThan(0);
		},
	);

	it("rejects overlapping datasets or too few repetitions before any model work", async () => {
		const evaluate = vi.fn();
		const generate = vi.fn();
		await expect(optimizePrompt({ ...options, holdoutCases: cases }, { evaluate, generate })).rejects.toThrow(
			"留出集",
		);
		await expect(optimizePrompt({ ...options, repetitions: 1 }, { evaluate, generate })).rejects.toThrow(
			"repetitions",
		);
		expect(evaluate).not.toHaveBeenCalled();
		expect(generate).not.toHaveBeenCalled();
	});

	it("rejects mixed candidate schemas instead of dropping invalid entries", () => {
		expect(() => parsePromptCandidates('["valid", 17]')).toThrow("字符串");
	});
});
