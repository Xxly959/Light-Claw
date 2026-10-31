import { expect, it } from "vitest";
import { decidePromotion } from "../src/evals/optimizer.js";
import type { EvalReport } from "../src/evals/types.js";

function reports(id: string, scores: number[], tokens = 100): EvalReport[] {
	return scores.map((score) => ({
		createdAt: new Date(0).toISOString(),
		model: "faux",
		promptLabel: "noise",
		score,
		passedCases: 0,
		totalCases: 1,
		totalTokens: tokens,
		totalCost: 0,
		results: [
			{
				id,
				score,
				response: "ok",
				checks: [{ name: "response", passed: true, detail: "fixture" }],
				run: {
					stopReason: "stop",
					durationMs: 100,
					toolCalls: 0,
					toolErrors: 0,
					verificationCommandCount: 0,
					inputTokens: tokens,
					outputTokens: 0,
					cost: 0,
				},
			},
		],
	}));
}
const evaluation = (scores: number[], tokens = 100) => ({
	training: reports("train", scores, tokens),
	holdout: reports("holdout", scores, tokens),
});

it("rejects a positive mean gain smaller than measured baseline variation", () => {
	const before = evaluation([0.5, 0.7, 0.5, 0.7, 0.6]);
	const after = evaluation([0.61, 0.61, 0.61, 0.61, 0.61]);
	expect(decidePromotion(after, before).passed).toBe(false);
});
it("rejects training-only gains even when holdout does not regress", () => {
	const before = evaluation(Array(5).fill(0.5));
	const after = { training: reports("train", Array(5).fill(0.8)), holdout: reports("holdout", Array(5).fill(0.5)) };
	expect(decidePromotion(after, before).passed).toBe(false);
});
it("rejects resource savings smaller than baseline resource variation", () => {
	const before = evaluation(Array(5).fill(1));
	before.training[0].totalTokens = 60;
	before.holdout[0].totalTokens = 60;
	const after = evaluation(Array(5).fill(1), 90);
	// Every paired run except the noisy low run improves; use equal pairs to
	// isolate the missing population-noise guard from the existing paired guard.
	after.training[0].totalTokens = 54;
	after.holdout[0].totalTokens = 54;
	expect(decidePromotion(after, before, { objective: "tokens" }).passed).toBe(false);
});
