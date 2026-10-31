import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunResult } from "../src/agent.js";
import { isBetterReport, parsePromptCandidates } from "../src/evals/optimizer.js";
import { scoreEvalCase } from "../src/evals/scoring.js";
import type { EvalReport } from "../src/evals/types.js";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function run(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
	return {
		stopReason: "stop",
		durationMs: 100,
		toolCalls: 1,
		toolErrors: 0,
		verificationCommandCount: 0,
		inputTokens: 10,
		outputTokens: 5,
		cost: 0.001,
		...overrides,
	};
}

function report(score: number, tokens: number, toolErrors = 0): EvalReport {
	return {
		createdAt: "2026-01-01T00:00:00.000Z",
		model: "test/model",
		promptLabel: "test",
		score,
		passedCases: score === 1 ? 1 : 0,
		totalCases: 1,
		totalCost: 0,
		totalTokens: tokens,
		results: [{ id: "case", score, response: "", checks: [], run: run({ toolErrors }) }],
	};
}

describe("Agent 评测", () => {
	it.each(["aborted", "length"])("does not award a full pass to %s outcomes", (stopReason) => {
		const directory = mkdtempSync(join(tmpdir(), "lightclaw-eval-status-"));
		temporaryPaths.push(directory);
		expect(
			scoreEvalCase(
				{ id: "status", prompt: "task", expect: { responseIncludes: ["ok"] } },
				"ok",
				run({ stopReason }),
				directory,
			).score,
		).toBeLessThan(1);
	});
	it("checks regular in-workspace artifacts and records read failures instead of throwing", () => {
		const directory = mkdtempSync(join(tmpdir(), "lightclaw-eval-artifact-"));
		const outside = mkdtempSync(join(tmpdir(), "lightclaw-eval-outside-"));
		temporaryPaths.push(directory, outside);
		writeFileSync(join(outside, "proof.txt"), "secret");
		symlinkSync(join(outside, "proof.txt"), join(directory, "escaped.txt"));
		mkdirSync(join(directory, "folder"));
		const result = scoreEvalCase(
			{
				id: "artifact",
				prompt: "task",
				expect: {
					filesExist: ["escaped.txt", "folder"],
					filesContain: [
						{ path: "folder", text: "secret" },
						{ path: "escaped.txt", text: "secret" },
					],
				},
			},
			"ok",
			run(),
			directory,
		);
		expect(result.checks.filter((item) => item.name.startsWith("file_")).every((item) => !item.passed)).toBe(true);
	});
	it("同时检查回复、文件内容和运行指标", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "lightclaw-eval-"));
		temporaryPaths.push(channelDir);
		mkdirSync(join(channelDir, "scratch"));
		writeFileSync(join(channelDir, "scratch", "proof.txt"), "pass");

		const result = scoreEvalCase(
			{
				id: "artifact",
				prompt: "test",
				expect: {
					responseIncludes: ["完成"],
					filesExist: ["scratch/proof.txt"],
					filesContain: [{ path: "scratch/proof.txt", text: "pass" }],
					maxToolErrors: 0,
				},
			},
			"已完成",
			run(),
			channelDir,
		);

		expect(result.score).toBe(1);
		expect(result.checks).toHaveLength(5);
	});

	it("错误运行不能获得满分", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "lightclaw-eval-"));
		temporaryPaths.push(channelDir);
		const result = scoreEvalCase(
			{ id: "error", prompt: "test", expect: { maxToolErrors: 0 } },
			"",
			run({ stopReason: "error", errorMessage: "gateway error" }),
			channelDir,
		);
		expect(result.score).toBeLessThan(1);
	});
});

describe("提示词优化", () => {
	it("解析带有额外文本的候选 JSON", () => {
		expect(parsePromptCandidates('result: ["先检查", "再验证", "先检查"]')).toEqual(["先检查", "再验证"]);
	});

	it("只有得分严格提高才接受候选", () => {
		expect(isBetterReport(report(0.9, 100), report(0.8, 10))).toBe(true);
		expect(isBetterReport(report(1, 100, 0), report(1, 80, 1))).toBe(false);
		expect(isBetterReport(report(1, 70), report(1, 80))).toBe(false);
	});
});
