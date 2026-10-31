import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateArtifactPath } from "../../goals/acceptance.js";
import type { Oracle, ReliabilityTask, Split } from "./types.js";
export const dataRoot = fileURLToPath(new URL("../../../evals/reliability/", import.meta.url));
export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export function loadTasks(path = `${dataRoot}/tasks.json`): ReliabilityTask[] {
	const data = JSON.parse(readFileSync(path, "utf8")) as ReliabilityTask[];
	const ids = new Set<string>(),
		families = new Map<string, Split>();
	for (const task of data) {
		if (
			!/^[a-z0-9-]+$/.test(task.id) ||
			ids.has(task.id) ||
			!["development", "selection", "blind"].includes(task.split) ||
			!task.family ||
			!task.prompt.trim()
		)
			throw new Error("Invalid/duplicate task identity or split");
		ids.add(task.id);
		if (families.has(task.family) && families.get(task.family) !== task.split)
			throw new Error("Shared template family across splits");
		families.set(task.family, task.split);
		validateArtifactPath(task.output);
		for (const [name, content] of Object.entries(task.inputs)) {
			validateArtifactPath(name);
			if (typeof content !== "string") throw new Error("Input must be text");
		}
	}
	return data;
}
export function loadOracles(): Record<string, Oracle> {
	return JSON.parse(readFileSync(`${dataRoot}/protected/oracles.json`, "utf8")) as Record<string, Oracle>;
}
function shingles(prompt: string): Set<string> {
	const text = prompt
		.split(" 输入位于")[0]
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+|[\p{P}\p{S}\d]/gu, "");
	return new Set(Array.from({ length: Math.max(0, text.length - 3) }, (_, i) => text.slice(i, i + 4)));
}
export function auditData(tasks: ReliabilityTask[]) {
	const exact = new Map<string, string>();
	const nearDuplicates: Array<{ left: string; right: string; jaccard: number }> = [];
	for (const task of tasks) {
		const normalized = task.prompt.split(" 输入位于")[0].replace(/\s/g, "");
		if (exact.has(normalized)) throw new Error("Duplicate task prompt");
		exact.set(normalized, task.id);
	}
	for (let i = 0; i < tasks.length; i++)
		for (let j = i + 1; j < tasks.length; j++) {
			const a = shingles(tasks[i].prompt),
				b = shingles(tasks[j].prompt);
			const overlap = [...a].filter((x) => b.has(x)).length;
			const similarity = overlap / (a.size + b.size - overlap);
			if (similarity >= 0.55) nearDuplicates.push({ left: tasks[i].id, right: tasks[j].id, jaccard: similarity });
		}
	return {
		tasks: tasks.length,
		families: new Set(tasks.map((t) => t.family)).size,
		splitCounts: Object.fromEntries(
			["development", "selection", "blind"].map((s) => [s, tasks.filter((t) => t.split === s).length]),
		),
		nearDuplicates,
		method:
			"NFKC four-character shingles; common response-protocol suffix removed; threshold 0.55; family split checked independently",
		sourceLimit: "hand-authored synthetic tasks, not natural user samples",
	};
}
