import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { registerApiProvider } from "../../../packages/ai/src/api-registry.ts";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "../../../packages/ai/src/providers/openai-completions.ts";
import { createAgentRunner } from "./live/source-before/agent.ts";
import { createAgentRunner as createFixedRunner } from "./live/source-after/agent.ts";
import { createAgentRunner as createLeanRunner } from "./live/source-lean/agent.ts";
import { GoalStore } from "./live/source-before/goals/store.ts";
import { ChannelStore } from "../../../packages/lightclaw/src/store.ts";
import { scoreEvalCase } from "../../../packages/lightclaw/src/evals/scoring.ts";
import { GoalStore as OldGoalStore } from "../../experiments/2026-10-21-fixes/before/packages/lightclaw/src/goals/store.ts";
import { createAgentRunner as createOldRunner } from "../../experiments/2026-10-21-fixes/before/packages/lightclaw/src/agent.ts";
import { configureExperiment, createRunner as createUpstreamRunner } from "./upstream/packages/mom/src/agent-adapter.ts";

const directory = dirname(fileURLToPath(import.meta.url));
const [jobPath, slot] = process.argv.slice(2);
const job = JSON.parse(await readFile(jobPath, "utf8"));
const raw = join(directory, "live", "raw", job.id);
await mkdir(raw, { recursive: true });
const values = {};
for (const line of readFileSync(join(homedir(), ".hermes/.env"), "utf8").split("\n")) {
  const match = /^\s*(?:export\s+)?(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL)=(.*)$/.exec(line);
  if (match) values[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
}
const baseUrl = (values.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
if (!["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(baseUrl) || !values.DEEPSEEK_API_KEY)
  throw new Error("Official DeepSeek configuration is unavailable");
const model = { id: "deepseek-flash", name: "deepseek-flash", api: "openai-completions", provider: "deepseek-diagnosis",
  baseUrl, reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 2048,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: "max_tokens" } };
let requests = 0;
let usageTokens = 0;
const payloads = [];
let reservationId = 0;
const reservations = new Map();
process.on("message", message => {
  if (message.type !== "reservation") return;
  const done = reservations.get(message.id);
  reservations.delete(message.id);
  done?.(message.allowed);
});
async function reserve() {
  if (++requests > 30) throw new Error("External experiment request limit reached");
  if (!process.send) throw new Error("Experiment requires parent budget coordinator");
  const id = ++reservationId;
  const allowed = await new Promise(resolve => { reservations.set(id, resolve); process.send({ type: "reserve", id }); });
  if (!allowed) throw new Error("External experiment global budget reached");
}
function optionsFor(options) {
  return { ...options, temperature: 0.2, maxTokens: 2048,
    onPayload: async payload => {
      await reserve();
      payload.thinking = { type: "disabled" };
      delete payload.reasoning_effort;
      payload.seed = job.seed;
      payloads.push({ index: requests, timestamp: new Date().toISOString(), payload });
      await writeFile(join(raw, "requests.json"), JSON.stringify(payloads) + "\n");
      return payload;
    } };
}
function track(source) {
  const originalResult = source.result.bind(source);
  source.result = async () => {
    const result = await originalResult();
    const tokens = result.usage?.totalTokens ?? 0;
    usageTokens += tokens;
    process.send?.({ type: "usage", tokens });
    return result;
  };
  return source;
}
registerApiProvider({ api: "openai-completions",
  stream: (selected, context, options) => track(streamOpenAICompletions(selected, context, optionsFor(options))),
  streamSimple: (selected, context, options) => track(streamSimpleOpenAICompletions(selected, context, optionsFor(options))) }, "live-diagnosis");

const workspace = `/private/tmp/lightclaw-diagnosis-live-20261021/slot-${slot}/workspace`;
await mkdir(workspace, { recursive: true });
for (const name of await readdir(workspace)) await rm(join(workspace, name), { recursive: true, force: true });
process.chdir(workspace);
const channel = "task";
const channelDir = join(workspace, channel);
const dataset = JSON.parse(await readFile(join(directory, "../../experiments/2026-10-21-ablation/prompt-dataset.json"), "utf8"));
const item = dataset.find(item => item.id === job.caseId);
if (!item) throw new Error("Unknown frozen case");
for (const [path, contents] of Object.entries(item.fixtures)) {
  await mkdir(dirname(join(channelDir, path)), { recursive: true });
  await writeFile(join(channelDir, path), contents);
}
await writeFile(join(workspace, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
const store = new ChannelStore({ workingDir: workspace });
const config = { transport: job.features.feishu ? "feishu" : "slack", modelProvider: model.provider, modelId: model.id,
  features: job.features, maxGoalCycles: 8, maxGoalFailures: 2, maxStaleCycles: 2,
  maxRunDurationMs: 300000, maxRunToolCalls: 100, maxRunTokens: 100000, bashTimeoutSeconds: 120, platformTimeoutMs: 10000 };
const controlDir = join(workspace, "..", "control");
await rm(controlDir, { recursive: true, force: true });
const StoreClass = job.kind === "old" ? OldGoalStore : GoalStore;
const goals = new StoreClass({ channelDir, controlChannelDir: join(controlDir, channel), enabled: job.features.goals,
  acceptanceEnabled: job.features.acceptance, controlsEnabled: job.features.controls,
  limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 } });
if (job.kind !== "upstream" && job.features.goals && job.startGoal !== false) {
  await goals.create({ objective: item.prompt, ownerUserId: "experiment", acceptance: { mode: "automatic",
    files: Object.keys(item.outputs).map(path => ({ path, changed: false })), commands: [] } }, new AbortController().signal);
}
const capture = { text: "" };
const noop = async () => {};
const ctx = { message: { text: item.prompt, rawText: item.prompt, user: "experiment", userName: "experiment", channel, ts: "1", attachments: [] },
  channels: [{ id: channel, name: "Experiment" }], users: [{ id: "experiment", userName: "experiment", displayName: "Experiment" }], channelName: "Experiment",
  respond: async text => { if (!text.startsWith("_→") && !text.startsWith("_Error:")) capture.text = text; },
  replaceMessage: async text => { capture.text = text; }, respondInThread: noop, setTyping: noop, uploadFile: noop, setWorking: noop, deleteMessage: noop };
const sandbox = job.sandbox === "host" ? { type: "host" } : { type: "docker", container: `lightclaw-diagnosis-live-${slot}` };
configureExperiment(model, values.DEEPSEEK_API_KEY);
const runner = job.kind === "upstream" ? createUpstreamRunner(sandbox, channel, channelDir)
  : job.kind === "old" ? createOldRunner(sandbox, channel, channelDir, config, goals, { model, apiKey: values.DEEPSEEK_API_KEY, quiet: true })
  : (job.kind === "lean" ? createLeanRunner : job.kind === "fixed" ? createFixedRunner : createAgentRunner)(sandbox, channel, channelDir, config, goals, { model, apiKey: values.DEEPSEEK_API_KEY, quiet: true });
const cycles = [];
const started = performance.now();
let externalCycleLimit = false;
try {
  do {
    const before = goals.get();
    const result = await runner.run(ctx, store);
    const after = goals.get();
    cycles.push(result);
    if (job.kind === "upstream" || !job.features.goals || after?.status !== "active") break;
    const recorded = goals.recordCycle(result.stopReason === "error" || result.stopReason === "aborted", after.progressVersion > (before?.progressVersion ?? 0));
    if (result.budgetReason || recorded.status !== "active") break;
    if (cycles.length >= 8) { externalCycleLimit = true; break; }
    ctx.message.text = "[LightClaw 自动续跑] 检查当前进展，继续推进长期目标。不要重复已经完成的工作。";
    ctx.message.rawText = ctx.message.text;
  } while (true);
} finally { runner.dispose?.(); }
const durationMs = performance.now() - started;
const session = (await readFile(join(channelDir, "context.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
const assistants = session.filter(entry => entry.type === "message" && entry.message.role === "assistant").map(entry => entry.message);
const results = session.filter(entry => entry.type === "message" && entry.message.role === "toolResult").map(entry => entry.message);
const usage = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "totalTokens"].map(key => [key, assistants.reduce((sum, message) => sum + (message.usage?.[key] ?? 0), 0)]));
const run = { stopReason: externalCycleLimit ? "aborted" : cycles.at(-1)?.stopReason ?? "error", durationMs,
  toolCalls: results.length, toolErrors: results.filter(message => message.isError).length,
  verificationCommandCount: cycles.reduce((sum, cycle) => sum + (cycle.verificationCommandCount ?? 0), 0),
  inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output, cost: 0 };
const result = scoreEvalCase({ id: item.id, prompt: item.prompt, expect: { maxToolErrors: 0 } }, capture.text, run, channelDir);
const artifacts = {};
for (const [path, expected] of Object.entries(item.outputs)) {
  let text = null, passed = false;
  try { text = await readFile(join(channelDir, path), "utf8"); passed = "json" in expected ? isDeepStrictEqual(JSON.parse(text), expected.json) : "textExact" in expected ? text === expected.textExact : text.trim() === expected.textTrimmed; } catch {}
  artifacts[path] = text;
  result.checks.push({ name: `file_strict:${path}`, passed, detail: "Exact structured/text artifact check" });
}
for (const [path, expected] of Object.entries(item.fixtures)) {
  let passed = false;
  try { passed = await readFile(join(channelDir, path), "utf8") === expected; } catch {}
  result.checks.push({ name: `file_unchanged:${path}`, passed, detail: "Input fixture must remain unchanged" });
}
result.score = result.checks.filter(check => check.passed).length / result.checks.length;
const record = { ...job, success: result.checks.every(check => check.passed), result, artifacts, session, usage,
  modelRequests: payloads.length, reportedDuringStreaming: usageTokens, cycles: cycles.length, cycleResults: cycles,
  goal: goals.get(), externalCycleLimit, completedAt: new Date().toISOString(),
  scorerSha256: createHash("sha256").update(await readFile(join(directory, "../../../packages/lightclaw/src/evals/scoring.ts"))).digest("hex") };
await writeFile(join(raw, "run.json"), JSON.stringify(record) + "\n");
process.send?.({ type: "finished", summary: { id: job.id, success: record.success, tokens: usage.totalTokens, modelRequests: payloads.length } });
process.exit(0);
