import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./data.js";
import { resolveTerminal } from "./statistics.js";
import type { Attempt, Freeze, Observation } from "./types.js";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected record object");
	return value as Record<string, unknown>;
}
function count(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
export function observationRecord(value: unknown): Observation {
	const row = object(value),
		usage = object(row.usage);
	if (
		!["complete", "refuse", "clarify", "unable", "unknown"].includes(String(row.decision)) ||
		row.evidence !== "faux-wiring-only" ||
		row.platform !== "protocol-simulator" ||
		row.usageSource !== "synthetic-faux-estimate"
	)
		throw new Error("Invalid observation identity");
	for (const key of [
		"systemCompleted",
		"humanRequired",
		"taskLost",
		"productTimeout",
		"systemFailure",
		"accepted",
		"consumed",
	])
		if (typeof row[key] !== "boolean") throw new Error(`Invalid observation ${key}`);
	for (const key of ["humanInterventions", "toolErrors", "unresolved", "compactions", "cycles", "durationMs"])
		if (!count(row[key])) throw new Error(`Invalid observation ${key}`);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "modelRequests"])
		if (usage[key] !== null && !count(usage[key])) throw new Error(`Invalid usage ${key}`);
	for (const key of ["goalStatus", "inboxStatus"])
		if (row[key] !== null && typeof row[key] !== "string") throw new Error(`Invalid observation ${key}`);
	if (row.duplicateEffects !== null && !count(row.duplicateEffects)) throw new Error("Invalid effect count");
	if (!Array.isArray(row.phases) || row.phases.some((v) => typeof v !== "string")) throw new Error("Invalid phases");
	return value as Observation;
}
function controllerRecord(value: unknown): Attempt["controller"] {
	const row = object(value);
	if (
		(row.code !== null && !Number.isInteger(row.code)) ||
		(row.signal !== null && typeof row.signal !== "string") ||
		typeof row.timeout !== "boolean" ||
		!count(row.boots)
	)
		throw new Error("Invalid controller record");
	return value as Attempt["controller"];
}
function attemptRecord(value: unknown): Attempt {
	const row = object(value);
	object(row.job);
	controllerRecord(row.controller);
	if (row.observation !== null) observationRecord(row.observation);
	if (row.score !== null) {
		const score = object(row.score);
		for (const key of [
			"artifactCorrect",
			"inputPreserved",
			"businessValid",
			"checkerIntegrity",
			"handlingCorrect",
			"falseCompletion",
			"modelFalseCompletion",
			"falseRefusal",
			"artifactRightSystemFailure",
		])
			if (score[key] !== null && typeof score[key] !== "boolean") throw new Error("Invalid score");
	}
	return value as Attempt;
}
export function loadAttemptRecords(freeze: Freeze, out: string) {
	const records: Attempt[] = [],
		diagnostics: Array<{ file: string; error: string; hash?: string }> = [];
	const raw = join(out, "attempts.jsonl");
	if (existsSync(raw))
		for (const [index, line] of readFileSync(raw, "utf8").split("\n").entries())
			if (line.trim()) {
				try {
					records.push(attemptRecord(JSON.parse(line) as unknown));
				} catch (error) {
					diagnostics.push({ file: `attempts.jsonl:${index + 1}`, error: String(error), hash: sha256(line) });
				}
			}
	const ids = new Set(records.map((r) => r.job.id));
	for (const job of freeze.jobs) {
		if (ids.has(job.id)) continue;
		const dir = join(out, "runs", job.id),
			attempt = join(dir, "attempt.json"),
			control = join(dir, "controller.json");
		if (existsSync(attempt))
			try {
				const row = attemptRecord(JSON.parse(readFileSync(attempt, "utf8")) as unknown);
				if (row.job.id !== job.id) throw new Error("Mismatched recovered job");
				records.push(row);
				ids.add(job.id);
				diagnostics.push({ file: attempt, error: "Recovered durable attempt missing from JSONL" });
				continue;
			} catch (error) {
				diagnostics.push({ file: attempt, error: String(error) });
			}
		if (existsSync(control))
			try {
				const stored = object(JSON.parse(readFileSync(control, "utf8")) as unknown);
				let controller: Attempt["controller"];
				if (stored.controller) controller = controllerRecord(stored.controller);
				else {
					if (!Array.isArray(stored.exits) || !stored.exits.length) throw new Error("Missing exits");
					const exits = stored.exits.map(object),
						last = exits.at(-1)!;
					controller = controllerRecord({
						code: last.code,
						signal: last.signal,
						timeout: exits.some((e) => e.timeout === true),
						boots: exits.length,
					});
				}
				records.push({
					job,
					controller,
					terminal: resolveTerminal(controller, null),
					observation: null,
					score: null,
					cost: null,
				});
				ids.add(job.id);
				diagnostics.push({ file: control, error: "Recovered controller only; observation/score remain unknown" });
			} catch (error) {
				diagnostics.push({ file: control, error: String(error) });
			}
	}
	return { records, diagnostics };
}
