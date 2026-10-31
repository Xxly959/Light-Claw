import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { ChannelQueue } from "../../../packages/lightclaw/src/channel-queue.ts";
import { LegacyQueue } from "./legacy-queue.mjs";

const arms = ["legacy", "disabled", "capacity", "deadline", "combined"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const output = process.argv[2];
assert.ok(output);
const records = [];
const rounds = [];

async function trial(arm, scenario, repetition) {
	const channelCount = 20;
	const count = scenario === "normal" ? 2 : 40;
	const started = performance.now();
	const tasks = [];
	const promises = [];
	let peakPending = 0;
	for (let channel = 0; channel < channelCount; channel++) {
		const errors = [];
		const queue = arm === "legacy" ? new LegacyQueue() : new ChannelQueue((error) => errors.push(String(error)), {
			maxPending: ["capacity", "combined"].includes(arm) ? 5 : 100000,
			maxWaitMs: ["deadline", "combined"].includes(arm) ? 65 : 2147483647,
		});
		let running = false;
		for (let index = 0; index < count; index++) {
			const task = { arm, scenario, repetition, channel, index, submittedMs: performance.now() - started, status: "pending" };
			tasks.push(task);
			const work = async () => {
				assert.equal(running, false, "same channel overlapped");
				assert.equal(task.status, "pending", "expired task executed");
				running = true;
				task.startedMs = performance.now() - started;
				await sleep(20);
				task.finishedMs = performance.now() - started;
				task.status = "completed";
				running = false;
			};
			if (arm === "legacy") {
				promises.push(new Promise((resolve) => queue.enqueue(async () => { await work(); resolve(); })));
			} else {
				const completion = queue.tryEnqueue(work, async () => {
					task.status = "expired";
					task.finishedMs = performance.now() - started;
				});
				if (completion) promises.push(completion);
				else {
					task.status = "rejected";
					task.finishedMs = performance.now() - started;
				}
			}
			peakPending = Math.max(peakPending, queue.size());
		}
		assert.equal(errors.length, 0);
	}
	await Promise.all(promises);
	await sleep(1);
	for (let channel = 0; channel < channelCount; channel++) {
		const completed = tasks.filter((task) => task.channel === channel && task.status === "completed");
		for (let i = 1; i < completed.length; i++) {
			assert.ok(completed[i].index > completed[i - 1].index, "FIFO violated");
			assert.ok(completed[i].startedMs >= completed[i - 1].finishedMs, "serial execution violated");
		}
	}
	assert.ok(tasks.every((task) => ["completed", "expired", "rejected"].includes(task.status)));
	if (["capacity", "combined"].includes(arm)) assert.ok(peakPending <= 5);
	if (["legacy", "disabled"].includes(arm)) assert.ok(tasks.every((task) => task.status === "completed"));
	records.push(...tasks);
	rounds.push({ arm, scenario, repetition, wallMs: performance.now() - started, peakPending, submitted: tasks.length,
		completed: tasks.filter((task) => task.status === "completed").length,
		expired: tasks.filter((task) => task.status === "expired").length,
		rejected: tasks.filter((task) => task.status === "rejected").length });
}

for (const scenario of ["normal", "burst"]) {
	for (let repetition = -1; repetition < 12; repetition++) {
		for (let offset = 0; offset < arms.length; offset++) {
			await trial(arms[(repetition + 1 + offset) % arms.length], scenario, repetition);
		}
		process.stdout.write(JSON.stringify({ scenario, repetition, done: true }) + "\n");
	}
}
await writeFile(output, JSON.stringify({ version: 1, serviceMs: 20, deadlineMs: 65, capacity: 5, channelCount: 20, arms, rounds, tasks: records }, null, 2) + "\n");
