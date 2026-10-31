import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fauxAssistantMessage, registerFauxProvider } from "../../../packages/ai/src/index.ts";
import { getOrCreateRunner, releaseRunner } from "../../../packages/lightclaw/src/agent.ts";
import { GoalStore } from "../../../packages/lightclaw/src/goals/store.ts";
import { IdleResourceCache } from "../../../packages/lightclaw/src/idle-cache.ts";
import { ChannelStore } from "../../../packages/lightclaw/src/store.ts";

const [arm, output] = process.argv.slice(2);
assert.ok(["disabled", "capacity", "ttl", "combined"].includes(arm));
assert.ok(output);
assert.equal(typeof global.gc, "function", "run with --expose-gc");
const workspace = await mkdtemp(join(tmpdir(), "lightclaw-cache-ablation-"));
const store = new ChannelStore({ workingDir: workspace });
const config = { transport: "slack", modelProvider: "unused", modelId: "unused", maxGoalCycles: 8, maxGoalFailures: 2, maxStaleCycles: 2 };
const samples = [];
const tasks = [];
const phases = [];
const keys = [];
let created = 0;
let released = 0;
let peakRetained = 0;
let faux = registerFauxProvider({ api: "cache-ablation", provider: "cache-ablation", tokenSize: { min: 8192, max: 8192 } });
const cache = new IdleResourceCache({ maxEntries: ["capacity", "combined"].includes(arm) ? 128 : 100000,
	idleTtlMs: ["ttl", "combined"].includes(arm) ? 1000 : 2147483647 },
	(value) => value.busy, (_value, key) => { releaseRunner(join(workspace, key)); released++; });
const snapshot = (phase) => ({ phase, elapsedMs: performance.now() - started, retained: cache.size, created, released, ...process.memoryUsage() });
const started = performance.now();
const sampleTimer = setInterval(() => samples.push(snapshot("periodic")), 20);
// Equal keepalive in all arms isolates expiry to the idle phase.
const keepalive = setInterval(() => { for (const key of keys) cache.get(key); }, 100);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function phase(name) {
	phases.push(snapshot(`${name}-natural`));
	global.gc(); global.gc();
	phases.push(snapshot(`${name}-gc`));
}
function context(id, text, index) {
	return { message: { text, rawText: text, user: "ablation", userName: "ablation", channel: id, ts: String(index), attachments: [] },
		channelName: id, channels: [{ id, name: id }], users: [{ id: "ablation", userName: "ablation", displayName: "ablation" }],
		respond: async () => {}, replaceMessage: async () => {}, respondInThread: async () => {}, setTyping: async () => {},
		uploadFile: async () => {}, setWorking: async () => {}, deleteMessage: async () => {} };
}
function payload(id, turn, role) { return `${id}:${turn}:${role}:` + createHash("sha256").update(`${id}:${turn}:${role}`).digest("hex").repeat(64); }
async function execute(id, turn, stage) {
	const before = performance.now();
	const hit = cache.peek(id) !== undefined;
	const item = cache.getOrCreate(id, () => {
		const dir = join(workspace, id);
		const goal = new GoalStore({ channelDir: dir, controlChannelDir: join(workspace, "control", id),
			limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 } });
		created++;
		return { busy: false, runner: getOrCreateRunner({ type: "host" }, id, dir, config, goal,
			{ model: faux.getModel(), tools: [], apiKey: "faux-key", quiet: true }) };
	});
	const createMs = performance.now() - before;
	peakRetained = Math.max(peakRetained, cache.size);
	item.busy = true;
	let messageCount = 0;
	let contextChars = 0;
	faux.setResponses([(input) => {
		messageCount = input.messages.length;
		contextChars = JSON.stringify(input.messages.map((message) => ({ role: message.role, content: message.content }))).length;
		return fauxAssistantMessage(payload(id, turn, "assistant"));
	}]);
	const runStarted = performance.now();
	try {
		const result = await item.runner.run(context(id, payload(id, turn, "user"), turn), store);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.toolErrors, 0);
		assert.equal(messageCount, turn * 2 + 1, "context lost after recreation");
	} finally { item.busy = false; }
	tasks.push({ id, turn, stage, hit, createMs, runMs: performance.now() - runStarted, messageCount, contextChars });
	// Drop faux's own synthetic prefix cache between requests: it is not a production runner cache.
	faux.unregister();
	faux = registerFauxProvider({ api: "cache-ablation", provider: "cache-ablation", tokenSize: { min: 8192, max: 8192 } });
}
try {
	phase("baseline");
	for (let channel = 0; channel < 320; channel++) {
		const id = `channel-${String(channel).padStart(4, "0")}`;
		keys.push(id);
		await execute(id, 0, "fill");
		await execute(id, 1, "fill");
	}
	clearInterval(keepalive);
	assert.equal(cache.size, ["capacity", "combined"].includes(arm) ? 128 : 320, "TTL interfered with fill phase");
	phase("filled");
	await sleep(1250);
	cache.sweep();
	phase("idle");
	const retainedAfterIdle = cache.size;
	for (const index of [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 32 }, (_, i) => i + 288)]) {
		await execute(`channel-${String(index).padStart(4, "0")}`, 2, "revisit");
	}
	phase("revisited");
	cache.close();
	assert.equal(cache.size, 0);
	assert.equal(created, released);
	phase("closed");
	clearInterval(sampleTimer);
	await writeFile(output, JSON.stringify({ version: 1, arm, node: process.version, channels: 320, turnsPerChannel: 2,
		payloadChars: 4096, ttlMs: 1000, capacity: 128, retainedAfterIdle, peakRetained, created, released,
		wallMs: performance.now() - started, phases, samples, tasks, realModelCalls: 0, realTokens: null }, null, 2) + "\n");
	process.stdout.write(JSON.stringify({ arm, created, released, retainedAfterIdle, peakRetained, output }) + "\n");
} finally {
	clearInterval(keepalive); clearInterval(sampleTimer); cache.close(); faux.unregister();
	await rm(workspace, { recursive: true, force: true });
}
