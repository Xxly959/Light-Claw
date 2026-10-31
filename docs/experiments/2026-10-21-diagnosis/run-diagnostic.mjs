import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { registerApiProvider } from "../../../packages/ai/src/api-registry.ts";
import { completeSimple } from "../../../packages/ai/src/index.ts";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "../../../packages/ai/src/providers/openai-completions.ts";
import { createAgentRunner } from "../../../packages/lightclaw/src/agent.ts";
import { optimizePrompt, parsePromptCandidates } from "../../../packages/lightclaw/src/evals/optimizer.ts";
import { scoreEvalCase } from "../../../packages/lightclaw/src/evals/scoring.ts";
import { GoalStore } from "../../../packages/lightclaw/src/goals/store.ts";
import { ChannelStore } from "../../../packages/lightclaw/src/store.ts";

const [credentialPath, mode = "diagnostic"] = process.argv.slice(2);
const directory = dirname(new URL(import.meta.url).pathname);
const rawDir = join(directory, "raw");
const credential = JSON.parse(await readFile(credentialPath, "utf8"));
assert.equal(credential.baseUrl, "https://api.deepseek.com");
assert.equal(credential.model, "deepseek-flash");
const dataBytes = await readFile(join(directory, "../2026-10-21-ablation/prompt-dataset.json"));
const dataset = JSON.parse(dataBytes.toString());
const datasetHash = createHash("sha256").update(dataBytes).digest("hex");
const workspace = "/private/tmp/lightclaw-prompt-diagnosis-20261021/workspace";
const store = new ChannelStore({ workingDir: workspace });
const rawRuns = [];
const requests = [];
let contextLabel = {};
let requestCount = 0;
let reportedTokens = 0;
let generation = false;
let diagnosticArm = "control";
const model = { id: credential.model, name: credential.model, api: "ablation-deepseek", provider: "deepseek-experiment",
	baseUrl: credential.baseUrl, reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 2048,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: "max_tokens" } };

function wrappedOptions(options) {
	return { ...options, temperature: generation ? 0.7 : 0.2, maxTokens: generation ? 1500 : 2048,
		onPayload: async (payload) => {
			assert.ok(++requestCount <= 800, "experiment API request ceiling reached");
			assert.ok(reportedTokens < 1500000, "experiment reported Token ceiling reached");
			payload.messages = payload.messages.map((message) => {
				if (message.role !== "system") return message;
				let content = message.content;
				if (diagnosticArm === "slim") {
					content = content.replace(/## Skills \(Custom CLI Tools\)[\s\S]*?(?=## Memory)/, "");
					content = content.replace(/## System Configuration Log[\s\S]*?(?=## Tools)/, "");
				}
				if (diagnosticArm === "capabilities") content += "\n\n## Actual command availability\nAvailable: bash, curl, git, jq, python3 and BusyBox utilities. The file command is NOT installed. You cannot install system packages.\n";
				if (diagnosticArm === "cwd") content = content.replace(/^Current working directory: .*$/m, "Current working directory: /workspace");
				return { ...message, content };
			});
			payload.thinking = { type: "disabled" };
			delete payload.reasoning_effort;
			requests.push({ label: { ...contextLabel }, index: requestCount, createdAt: new Date().toISOString(), payload });
			await writeFile(join(rawDir, `prompt-${mode}-requests.json`), JSON.stringify(requests, null, 2) + "\n");
			return payload;
		} };
}
registerApiProvider({ api: "ablation-deepseek",
	stream: (selected, input, options) => streamOpenAICompletions({ ...selected, api: "openai-completions" }, input, wrappedOptions(options)),
	streamSimple: (selected, input, options) => streamSimpleOpenAICompletions({ ...selected, api: "openai-completions" }, input, wrappedOptions(options)) }, "ablation-deepseek");

const config = { transport: "slack", modelProvider: "deepseek-experiment", modelId: credential.model,
	maxGoalCycles: 8, maxGoalFailures: 2, maxStaleCycles: 2, maxRunDurationMs: 90000, maxRunToolCalls: 12, maxRunTokens: 20000,
	bashTimeoutSeconds: 10, platformTimeoutMs: 10000 };
const sandbox = { type: "docker", container: "lightclaw-diagnosis-20261021" };
const caseById = new Map(dataset.map((item) => [item.id, item]));
const evalCase = (item) => ({ id: item.id, prompt: item.prompt, expect: { maxToolErrors: 0 } });
await mkdir(rawDir, { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));

function createContext(channel, prompt, capture) {
	return { message: { text: prompt, rawText: prompt, user: "experiment", userName: "experiment", channel, ts: "1", attachments: [] },
		channelName: "Prompt Ablation", channels: [{ id: channel, name: "Prompt Ablation" }],
		users: [{ id: "experiment", userName: "experiment", displayName: "experiment" }],
		respond: async (text) => { if (!text.startsWith("_→") && !text.startsWith("_Error:")) capture.text = text; },
		replaceMessage: async (text) => { capture.text = text; }, respondInThread: async () => {}, setTyping: async () => {},
		uploadFile: async () => {}, setWorking: async () => {}, deleteMessage: async () => {} };
}
async function execute(testCase, promptInstructions, label) {
	const item = caseById.get(testCase.id);
	assert.ok(item);
	const channelId = `prompt-${mode}-${String(rawRuns.length).padStart(3, "0")}-${item.id}`;
	const channelDir = join(workspace, channelId);
	for (const [path, contents] of Object.entries(item.fixtures)) {
		await mkdir(dirname(join(channelDir, path)), { recursive: true });
		await writeFile(join(channelDir, path), contents);
	}
	const goalStore = new GoalStore({ channelDir, controlChannelDir: join(workspace, "..", "control", channelId),
		limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 } });
	const capture = { text: "" };
	const runner = createAgentRunner(sandbox, channelId, channelDir, { ...config, promptInstructions }, goalStore,
		{ model, apiKey: credential.apiKey, quiet: true });
	contextLabel = { phase: item.split, caseId: item.id, label, runIndex: rawRuns.length };
	const requestStart = requestCount;
	let run;
	const started = performance.now();
	try { run = await runner.run(createContext(channelId, item.prompt, capture), store); }
	finally { runner.dispose(); }
	const result = scoreEvalCase(testCase, capture.text, run, channelDir);
	const artifacts = {};
	for (const [path, expected] of Object.entries(item.outputs)) {
		let text;
		let passed = false;
		try {
			text = await readFile(join(channelDir, path), "utf8");
			if ("json" in expected) passed = isDeepStrictEqual(JSON.parse(text), expected.json);
			else if ("textExact" in expected) passed = text === expected.textExact;
			else passed = text.trim() === expected.textTrimmed;
		} catch {}
		artifacts[path] = text ?? null;
		result.checks.push({ name: `file_strict:${path}`, passed, detail: "Exact structured/text artifact check" });
	}
	for (const [path, expected] of Object.entries(item.fixtures)) {
		let passed = false;
		try { passed = await readFile(join(channelDir, path), "utf8") === expected; } catch {}
		result.checks.push({ name: `file_unchanged:${path}`, passed, detail: "Input fixture must remain unchanged" });
	}
	result.score = result.checks.filter((check) => check.passed).length / result.checks.length;
	const session = (await readFile(join(channelDir, "context.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const assistant = session.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").map((entry) => entry.message);
	const usage = assistant.reduce((sum, message) => {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) sum[key] += message.usage?.[key] ?? 0;
		return sum;
	}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
	reportedTokens += usage.totalTokens;
	const record = { ...contextLabel, channelId, createdAt: new Date().toISOString(), wallMs: performance.now() - started,
		promptSha256: createHash("sha256").update(promptInstructions).digest("hex"), success: result.score === 1,
		result, usage, requests: requestCount - requestStart, responseChars: capture.text.length, artifacts, session };
	rawRuns.push(record);
	const serialized = JSON.stringify(record);
	assert.equal(serialized.includes(credential.apiKey), false, "credential must not enter artifacts");
	await appendFile(join(rawDir, `prompt-${mode}-runs.jsonl`), serialized + "\n");
	// Keep previous task answers out of the next task's mounted workspace.
	await rm(channelDir, { recursive: true, force: true });
	process.stdout.write(JSON.stringify({ phase: item.split, label, case: item.id, success: record.success,
		score: result.score, requests: record.requests, tokens: usage.totalTokens, ms: run.durationMs, completed: rawRuns.length }) + "\n");
	return result;
}
async function evaluate(options) {
	const results = [];
	for (const item of options.cases) results.push(await execute(item, options.promptInstructions ?? "", options.promptLabel));
	return { createdAt: new Date().toISOString(), model: credential.model, promptLabel: options.promptLabel,
		score: results.reduce((sum, result) => sum + result.score, 0) / results.length,
		passedCases: results.filter((result) => result.score === 1).length, totalCases: results.length,
		totalTokens: results.reduce((sum, result) => sum + result.run.inputTokens + result.run.outputTokens, 0), totalCost: 0, results };
}
async function generate(_config, cases, baselinePrompt, report) {
	generation = true;
	contextLabel = { phase: "generation" };
	const instruction = `你是Agent系统提示词优化器。生成一个简洁、通用的中文行为指令候选，用于追加到既有系统提示词末尾。不得硬编码任务答案，不得扩大权限或放宽安全边界，不超过250个汉字。只输出JSON字符串数组，恰好一个元素。\n当前追加指令：${baselinePrompt || "无"}\n训练任务：${JSON.stringify(cases)}\n基线检查：${JSON.stringify(report.results.map((r) => ({ id: r.id, score: r.score, failed: r.checks.filter((c) => !c.passed) })))}`;
	const message = await completeSimple(model, { messages: [{ role: "user", content: instruction, timestamp: Date.now() }] },
		{ apiKey: credential.apiKey, temperature: 0.7, maxTokens: 1500, signal: AbortSignal.timeout(60000) });
	assert.equal(message.stopReason, "stop", message.errorMessage);
	const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	const candidates = parsePromptCandidates(text).slice(0, 1);
	await writeFile(join(rawDir, "prompt-generated-candidate.json"), JSON.stringify({ createdAt: new Date().toISOString(),
		instruction, response: message, candidates, datasetHash, finalTestNotYetRun: true }, null, 2) + "\n");
	reportedTokens += message.usage.totalTokens;
	generation = false;
	return candidates;
}

const frozen = JSON.parse(await readFile(join(directory, "../2026-10-21-ablation/raw/prompt-final-freeze.json"), "utf8"));
const arms = ["control", "candidate", "slim", "capabilities", "cwd"];
const selectedIds = ["final-text-replacement", "final-nested-config", "select-space-path"];
await writeFile(join(rawDir, "diagnostic-freeze.json"), JSON.stringify({ arms, selectedIds, repetitions: 3, datasetHash, originalCandidateHash: frozen.candidateSha256, note: "Known-case diagnosis, not blind evaluation; one factor per arm." }, null, 2));
for (let repetition = 0; repetition < 3; repetition++) {
  for (let taskOffset = 0; taskOffset < selectedIds.length; taskOffset++) {
    const item = caseById.get(selectedIds[(taskOffset + repetition) % selectedIds.length]);
    for (let armOffset = 0; armOffset < arms.length; armOffset++) {
      diagnosticArm = arms[(armOffset + repetition + taskOffset) % arms.length];
      await execute(evalCase(item), diagnosticArm === "candidate" ? frozen.candidate : "", `diag-${diagnosticArm}-${repetition}`);
    }
  }
}
await writeFile(join(rawDir, "diagnostic-complete.json"), JSON.stringify({ completedAt: new Date().toISOString(), runs: rawRuns.length, requestCount, reportedTokens, datasetHash }, null, 2) + "\n");
