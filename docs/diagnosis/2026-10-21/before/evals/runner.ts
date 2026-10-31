import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { type AgentRunnerOverrides, getOrCreateRunner, releaseRunner } from "../agent.js";
import type { LightClawConfig } from "../config.js";
import { GoalStore } from "../goals/store.js";
import type { SandboxConfig } from "../sandbox.js";
import { ChannelStore } from "../store.js";
import type { ChatContext } from "../transport.js";
import { assertCount, assertRecord, assertText, assertTextArray } from "../validation.js";
import { scoreEvalCase } from "./scoring.js";
import type { EvalCase, EvalCaseResult, EvalReport } from "./types.js";

function redactDiagnostic(text: string): string {
	return text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

async function readDiagnostics(channelDir: string): Promise<NonNullable<EvalCaseResult["diagnostics"]>> {
	const snapshot: { systemPrompt: string } = JSON.parse(await readFile(join(channelDir, "last_prompt.jsonl"), "utf8"));
	const entries: SessionEntry[] = (await readFile(join(channelDir, "context.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const toolFailures = entries
		.flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || !entry.message.isError) return [];
			return [
				redactDiagnostic(
					entry.message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n"),
				).slice(0, 800),
			];
		})
		.slice(0, 8);
	return { systemPrompt: redactDiagnostic(snapshot.systemPrompt).slice(0, 12000), toolFailures };
}

export async function loadEvalCases(path: string): Promise<EvalCase[]> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	validateEvalCases(value);
	return value;
}

function knownFields(value: Record<string, unknown>, fields: string[], prefix: string): void {
	for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`${prefix}.${key} 是未知字段`);
}

function artifactPath(value: string, field: string): void {
	if (
		isAbsolute(value) ||
		win32.isAbsolute(value) ||
		value.split(/[\\/]/).some((part) => part === "." || part === ".." || part === "")
	)
		throw new Error(`${field} 必须是频道目录内的相对文件路径`);
}

export function validateEvalCases(value: unknown): asserts value is EvalCase[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("评测集必须是非空 JSON 数组");
	const ids = new Set<string>();
	for (const [index, item] of value.entries()) {
		const prefix = `cases[${index}]`;
		assertRecord(item, prefix);
		knownFields(item, ["id", "prompt", "expect"], prefix);
		assertText(item.id, `${prefix}.id`);
		assertText(item.prompt, `${prefix}.prompt`);
		assertRecord(item.expect, `${prefix}.expect`);
		knownFields(
			item.expect,
			["responseIncludes", "filesExist", "filesContain", "maxToolErrors", "maxDurationMs"],
			`${prefix}.expect`,
		);
		if (Object.keys(item.expect).length === 0) throw new Error(`${prefix}.expect 必须包含至少一个检查`);
		if (ids.has(item.id)) throw new Error(`${prefix}.id 重复：${item.id}`);
		ids.add(item.id);
		for (const field of ["responseIncludes", "filesExist"]) {
			if (item.expect[field] !== undefined) {
				assertTextArray(item.expect[field], `${prefix}.expect.${field}`);
				if (item.expect[field].length === 0) throw new Error(`${prefix}.expect.${field} 不能为空数组`);
				if (field === "filesExist")
					for (const path of item.expect[field]) artifactPath(path, `${prefix}.expect.filesExist`);
			}
		}
		if (item.expect.filesContain !== undefined) {
			if (!Array.isArray(item.expect.filesContain)) throw new Error(`${prefix}.expect.filesContain 必须是数组`);
			if (item.expect.filesContain.length === 0) throw new Error(`${prefix}.expect.filesContain 不能为空数组`);
			for (const [fileIndex, file] of item.expect.filesContain.entries()) {
				const field = `${prefix}.expect.filesContain[${fileIndex}]`;
				assertRecord(file, field);
				knownFields(file, ["path", "text"], field);
				assertText(file.path, `${field}.path`);
				artifactPath(file.path, `${field}.path`);
				assertText(file.text, `${field}.text`);
			}
		}
		if (item.expect.maxToolErrors !== undefined)
			assertCount(item.expect.maxToolErrors, `${prefix}.expect.maxToolErrors`);
		if (item.expect.maxDurationMs !== undefined) {
			const duration = item.expect.maxDurationMs;
			if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
				throw new Error(`${prefix}.expect.maxDurationMs 必须是非负有限数值`);
			}
		}
	}
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
	runnerOverrides?: AgentRunnerOverrides;
}): Promise<EvalReport> {
	validateEvalCases(options.cases);
	const results = [];
	const runId = randomUUID();
	const store = new ChannelStore({ workingDir: options.workingDir });

	for (const [index, testCase] of options.cases.entries()) {
		const safeId = testCase.id.replace(/[^a-zA-Z0-9_-]/g, "-");
		const channelId = `eval-${runId}-${index}-${safeId}`;
		const channelDir = store.getChannelDir(channelId);
		const goalStore = new GoalStore({
			channelDir,
			controlChannelDir: join(options.workingDir, "..", `lightclaw-eval-control-${runId}`, channelId),
			limits: {
				maxCycles: options.config.maxGoalCycles,
				maxFailures: options.config.maxGoalFailures,
				maxStaleCycles: options.config.maxStaleCycles,
			},
		});
		const capture = { finalText: "" };
		const config =
			options.promptInstructions === undefined
				? options.config
				: { ...options.config, promptInstructions: options.promptInstructions };
		const runner = getOrCreateRunner(
			options.sandbox,
			channelId,
			channelDir,
			config,
			goalStore,
			options.runnerOverrides,
		);
		try {
			const run = await runner.run(createContext(channelId, testCase.prompt, capture), store);
			const result = scoreEvalCase(testCase, capture.finalText, run, channelDir);
			try {
				result.diagnostics = await readDiagnostics(channelDir);
			} catch (error) {
				result.diagnosticError = redactDiagnostic(error instanceof Error ? error.message : String(error));
			}
			results.push(result);
		} finally {
			releaseRunner(channelDir);
		}
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
	return join(workingDir, "evals", `report-${Date.now()}-${randomUUID()}.json`);
}
