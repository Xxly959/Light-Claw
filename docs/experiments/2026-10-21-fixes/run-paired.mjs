import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { registerApiProvider } from "../../../packages/ai/src/api-registry.ts";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "../../../packages/ai/src/providers/openai-completions.ts";
import { createAgentRunner as createAgentRunnerBefore } from "./before/packages/lightclaw/src/agent.ts";
import { createAgentRunner } from "../../../packages/lightclaw/src/agent.ts";
import { scoreEvalCase } from "../../../packages/lightclaw/src/evals/scoring.ts";
import { GoalStore } from "../../../packages/lightclaw/src/goals/store.ts";
import { ChannelStore } from "../../../packages/lightclaw/src/store.ts";

const [credentialPath, mode = "paired"] = process.argv.slice(2);
const directory = dirname(new URL(import.meta.url).pathname);
const rawDir = join(directory, "raw");
const credential = JSON.parse(await readFile(credentialPath, "utf8"));
assert.equal(credential.baseUrl, "https://api.deepseek.com");
assert.equal(credential.model, "deepseek-flash");
const dataBytes = await readFile(join(directory, "prompt-dataset.json"));
const dataset = JSON.parse(dataBytes.toString());
const datasetHash = createHash("sha256").update(dataBytes).digest("hex");
const workspace = "/private/tmp/lightclaw-prompt-fixes-20261021/workspace";
const store = new ChannelStore({ workingDir: workspace });
const rawRuns = [];
const requests = [];
let contextLabel = {};
let requestCount = 0;
let reportedTokens = 0;
let generation = false;
const model = { id: credential.model, name: credential.model, api: "ablation-deepseek", provider: "deepseek-experiment",
	baseUrl: credential.baseUrl, reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 2048,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: "max_tokens" } };

function wrappedOptions(options) {
	return { ...options, temperature: generation ? 0.7 : 0.2, maxTokens: generation ? 1500 : 2048,
		onPayload: async (payload) => {
			assert.ok(++requestCount <= 450, "experiment API request ceiling reached");
			assert.ok(reportedTokens < 1200000, "experiment reported Token ceiling reached");
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
const sandbox = { type: "docker", container: "lightclaw-fixes-20261021" };
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
	const factory = label.includes("before") ? createAgentRunnerBefore : createAgentRunner;
	const runner = factory(sandbox, channelId, channelDir, { ...config, promptInstructions }, goalStore,
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
const final = dataset.filter((item) => item.split === "final");
assert.equal(final.length, 12);
await writeFile(join(rawDir, "freeze.json"), JSON.stringify({ frozenAt: new Date().toISOString(), datasetHash, model,
  repetitions: 3, order: "balanced AB/BA, rotate tasks by repetition", arms: ["before", "fixed"], candidate: "",
  maxRequests: 450, maxReportedTokens: 1200000, note: "Actual product runners; no system prompt payload transforms. Both use the same current Node runtime and image." }, null, 2));
for (let repetition = 0; repetition < 3; repetition++) {
 for (let offset = 0; offset < final.length; offset++) {
  const item = final[(offset + repetition * 5) % final.length];
  const order = (offset + repetition) % 2 ? ["fixed", "before"] : ["before", "fixed"];
  for (const arm of order) await execute(evalCase(item), "", `final-${arm}-${repetition}`);
 }
}
await writeFile(join(rawDir, "complete.json"), JSON.stringify({ completedAt: new Date().toISOString(), datasetHash,
 runs: rawRuns.length, requestCount, reportedTokens, node: process.version,
 fixedParameters: { thinking: "disabled", taskTemperature: 0.2, maxTokens: 2048 }, sandbox,
 note: "Model cost fields are unknown placeholders; no money savings inferred." }, null, 2));
