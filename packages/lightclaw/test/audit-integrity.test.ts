import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CriticalAuditError, resolveAuditDirectory } from "../src/audit/storage.js";
import { appendToolAuditEvent, writeToolPayload } from "../src/audit/tool-audit.js";
import { appendAuditEvent } from "../src/observability.js";
import { assertResourceCapacity, pruneManagedResources } from "../src/resource-policy.js";

const roots: string[] = [];
function root() {
	const r = mkdtempSync(join(tmpdir(), "audit-integrity-"));
	roots.push(r);
	return r;
}
afterEach(() => {
	vi.unstubAllEnvs();
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
it("keeps authoritative records outside the workspace", () => {
	const work = root();
	appendAuditEvent(work, { type: "run_finished", channelId: "C" });
	expect(resolveAuditDirectory(work).startsWith(`${work}/`)).toBe(false);
	expect(existsSync(join(work, "audit"))).toBe(false);
	expect(readFileSync(join(resolveAuditDirectory(work), "runs.jsonl"), "utf8")).toContain("run_finished");
});
it("counts tool calls, spans and nested payloads in one quota", () => {
	const dir = root();
	mkdirSync(join(dir, "payloads", "run"), { recursive: true });
	for (const name of ["runs.jsonl", "tool-calls.jsonl", "spans.jsonl", "payloads/run/a.json"])
		writeFileSync(join(dir, name), "x".repeat(25));
	vi.stubEnv("LIGHTCLAW_AUDIT_MAX_BYTES", "100");
	expect(() => assertResourceCapacity(dir, 1, "audit")).toThrow(/quota/);
});
it("does not prune active logs or recovery state, expires rotated logs and payloads", () => {
	const dir = root();
	mkdirSync(join(dir, "payloads", "run"), { recursive: true });
	const names = [
		"tool-calls.jsonl",
		"spans.jsonl",
		"runs.jsonl",
		"goal.json",
		"tool-calls.jsonl.123",
		"payloads/run/a.json",
	];
	for (const name of names) {
		writeFileSync(join(dir, name), "keep");
		utimesSync(join(dir, name), 0, 0);
	}
	pruneManagedResources(dir, "audit");
	for (const name of names.slice(0, 4)) expect(existsSync(join(dir, name))).toBe(true);
	for (const name of names.slice(4)) expect(existsSync(join(dir, name))).toBe(false);
});
it("fails closed on quota and linked paths", () => {
	const work = root();
	vi.stubEnv("LIGHTCLAW_AUDIT_MAX_BYTES", "1");
	expect(() => appendAuditEvent(work, { type: "run_finished", channelId: "C" })).toThrow();
	vi.unstubAllEnvs();
	const dir = resolveAuditDirectory(work);
	mkdirSync(dir, { recursive: true });
	const outside = join(root(), "outside");
	writeFileSync(outside, "original");
	symlinkSync(outside, join(dir, "runs.jsonl"));
	expect(() => appendAuditEvent(work, { type: "run_finished", channelId: "C" })).toThrow();
	expect(readFileSync(outside, "utf8")).toBe("original");
});
it("does not overwrite payload links or accept hardlinked logs", () => {
	const work = root();
	const dir = resolveAuditDirectory(work);
	mkdirSync(join(dir, "payloads", "r"), { recursive: true });
	const other = join(root(), "other");
	writeFileSync(other, "original");
	symlinkSync(other, join(dir, "payloads", "r", "t.json"));
	expect(() => writeToolPayload(work, "r", "t", { output: "bad" }, "full")).toThrow();
	linkSync(other, join(dir, "runs.jsonl"));
	expect(() => appendAuditEvent(work, { type: "run_finished", channelId: "C" })).toThrow();
	expect(readFileSync(other, "utf8")).toBe("original");
});
it("serializes concurrent writers with a filesystem transaction lock", () => {
	const work = root(),
		dir = resolveAuditDirectory(work);
	mkdirSync(join(dir, ".writer.lock"), { recursive: true });
	expect(() =>
		appendToolAuditEvent(work, {
			runId: "r",
			channelId: "C",
			toolCallId: "t",
			toolName: "bash",
			capabilities: ["exec"],
			trust: "trusted",
			decision: "allow",
			argsDigest: "s",
			argsSummary: "run",
			outcome: "ok",
			durationMs: 0,
		}),
	).toThrow(CriticalAuditError);
});
