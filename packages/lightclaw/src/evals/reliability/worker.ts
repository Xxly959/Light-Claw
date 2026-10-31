import { readFileSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { writeDurableJson } from "../../durable-state.js";
import { runFixture } from "./fixture-runner.js";
import type { Job, Oracle, ReliabilityTask } from "./types.js";

// This file is a separate child entry. It never loads configuration or credential files.
Socket.prototype.connect = () => {
	throw new Error("Offline worker network disabled");
};
globalThis.fetch = async () => {
	throw new Error("Offline worker network disabled");
};
const [payloadPath, mode] = process.argv.slice(2);
const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as {
	task: ReliabilityTask;
	oracle: Oracle;
	job: Job;
	root: string;
	prompt: string;
};
writeFileSync(join(payload.root, "started.json"), JSON.stringify({ pid: process.pid, mode }));
const observation = await runFixture(
	payload.task,
	payload.oracle,
	payload.job,
	payload.root,
	payload.prompt,
	mode === "recover",
);
if (payload.task.scenario === "corrupt-record") writeFileSync(join(payload.root, "observation.json"), '{"decision":');
else writeDurableJson(join(payload.root, "observation.json"), observation);
