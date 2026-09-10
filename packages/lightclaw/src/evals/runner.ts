import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getOrCreateRunner } from "../agent.js";
import type { LightClawConfig } from "../config.js";
import { GoalStore } from "../goals/store.js";
import type { SandboxConfig } from "../sandbox.js";
import { ChannelStore } from "../store.js";
import type { ChatContext } from "../transport.js";
import { scoreEvalCase } from "./scoring.js";
import type { EvalCase, EvalReport } from "./types.js";

export async function loadEvalCases(path: string): Promise<EvalCase[]> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!Array.isArray(value) || value.length === 0) throw new Error("评测集必须是非空 JSON 数组");
	for (const item of value) {
		if (!item || typeof item !== "object" || !("id" in item) || !("prompt" in item) || !("expect" in item)) {
			throw new Error("每个评测用例都必须包含 id、prompt 和 expect");
		}
	}
	return value as EvalCase[];
}

function createContext(channel: string, prompt: string, capture: { finalText: string }): ChatContext {
	return {
		message: {
			text: prompt,
			rawText: prompt,
			user: "eval-user",
			userName: "eval",
			channel,
			ts: String(Date.now()),
			attachments: [],
		},
		channelName: "LightClaw Eval",
		channels: [{ id: channel, name: "LightClaw Eval" }],
		users: [{ id: "eval-user", userName: "eval", displayName: "Eval Runner" }],
		respond: async (text) => {
			if (!text.startsWith("_→") && !text.startsWith("_Error:")) capture.finalText = text;
		},
		replaceMessage: async (text) => {
			capture.finalText = text;
		},
		respondInThread: async () => {},
		setTyping: async () => {},
		uploadFile: async () => {},
		setWorking: async () => {},
		deleteMessage: async () => {},
	};
}

export async function runEvaluation(options: {
	cases: EvalCase[];
	config: LightClawConfig;
	sandbox: SandboxConfig;
	workingDir: string;
	promptInstructions?: string;
	promptLabel: string;
}): Promise<EvalReport> {
	const results = [];
	const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const store = new ChannelStore({ workingDir: options.workingDir });

	for (const [index, testCase] of options.cases.entries()) {
		const safeId = testCase.id.replace(/[^a-zA-Z0-9_-]/g, "-");
		const channelId = `eval-${runId}-${index}-${safeId}`;
		const channelDir = store.getChannelDir(channelId);
		const goalStore = new GoalStore(channelDir, {
			maxCycles: options.config.maxGoalCycles,
			maxFailures: options.config.maxGoalFailures,
			maxStaleCycles: options.config.maxStaleCycles,
		});
		const capture = { finalText: "" };
		const config =
			options.promptInstructions === undefined
				? options.config
				: { ...options.config, promptInstructions: options.promptInstructions };
		const runner = getOrCreateRunner(options.sandbox, channelId, channelDir, config, goalStore);
		const run = await runner.run(createContext(channelId, testCase.prompt, capture), store);
		results.push(scoreEvalCase(testCase, capture.finalText, run, channelDir));
	}

	const score = results.reduce((sum, result) => sum + result.score, 0) / results.length;
	return {
		createdAt: new Date().toISOString(),
		model: `${options.config.modelProvider}/${options.config.modelId}`,
		promptLabel: options.promptLabel,
		score,
		passedCases: results.filter((result) => result.score === 1).length,
		totalCases: results.length,
		totalCost: results.reduce((sum, result) => sum + result.run.cost, 0),
		totalTokens: results.reduce((sum, result) => sum + result.run.inputTokens + result.run.outputTokens, 0),
		results,
	};
}

export function defaultReportPath(workingDir: string): string {
	return join(workingDir, "evals", `report-${Date.now()}.json`);
}
