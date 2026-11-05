import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { filterRecords, formatRecords, parseAuditLines, summarizeRecords } from "../src/audit/query.js";
import { resolveAuditDirectory } from "../src/audit/storage.js";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "audit-query-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {}
	}
});

const lines = [
	{
		ts: "2026-11-01T04:00:00.000Z",
		runId: "run-1",
		channelId: "C1",
		toolName: "bash",
		decision: "allow",
		outcome: "ok",
		argsSummary: "bash: npm run check",
		durationMs: 1200,
	},
	{
		ts: "2026-11-01T04:01:00.000Z",
		runId: "run-1",
		channelId: "C1",
		toolName: "bash",
		decision: "approve",
		outcome: "blocked",
		argsSummary: "bash: rm -rf scratch/old",
		durationMs: 0,
	},
	{
		ts: "2026-11-01T04:02:00.000Z",
		runId: "run-2",
		channelId: "C2",
		toolName: "read",
		decision: "allow",
		outcome: "error",
		argsSummary: "read: missing.md",
		durationMs: 8,
		errorClass: "tool-error",
	},
];

function writeAudit(root: string, content: string): string {
	mkdirSync(resolveAuditDirectory(root), { recursive: true });
	writeFileSync(join(resolveAuditDirectory(root), "tool-calls.jsonl"), content);
	return root;
}

describe("审计记录解析", () => {
	it("跳过损坏行与缺字段行，不影响其余记录", () => {
		const content = [
			JSON.stringify(lines[0]),
			"{not json",
			JSON.stringify({ ts: "2026-11-01T04:03:00.000Z", channelId: "C1" }),
			"",
			JSON.stringify(lines[1]),
		].join("\n");
		const records = parseAuditLines(content);
		expect(records).toHaveLength(2);
		expect(records[0].toolName).toBe("bash");
		expect(records[1].outcome).toBe("blocked");
	});
});

describe("审计过滤", () => {
	const records = parseAuditLines(lines.map((line) => JSON.stringify(line)).join("\n"));

	it("按工具、频道、结果、裁决过滤", () => {
		expect(filterRecords(records, { tool: "read" })).toHaveLength(1);
		expect(filterRecords(records, { channel: "C1" })).toHaveLength(2);
		expect(filterRecords(records, { outcome: "blocked" })).toHaveLength(1);
		expect(filterRecords(records, { decision: "approve" })).toHaveLength(1);
		expect(filterRecords(records, { tool: "bash", channel: "C2" })).toHaveLength(0);
	});

	it("--last 取尾部，超出总数时返回全部", () => {
		expect(filterRecords(records, { last: 2 }).map((record) => record.toolName)).toEqual(["bash", "read"]);
		expect(filterRecords(records, { last: 99 })).toHaveLength(3);
	});
});

describe("审计输出", () => {
	const records = parseAuditLines(lines.map((line) => JSON.stringify(line)).join("\n"));

	it("表格包含时间、判定与摘要", () => {
		const table = formatRecords(records);
		expect(table).toContain("2026-11-01 04:00:00");
		expect(table).toContain("approve");
		expect(table).toContain("rm -rf scratch/old");
		expect(table).toContain("(tool-error)");
	});

	it("空结果有明确提示", () => {
		expect(formatRecords([])).toContain("没有匹配");
	});

	it("汇总统计 blocked 与 error", () => {
		expect(summarizeRecords(records)).toContain("blocked 1");
		expect(summarizeRecords(records)).toContain("error 1");
	});
});

describe("审计 CLI 端到端", () => {
	const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
	const script = fileURLToPath(new URL("../src/audit/cli.ts", import.meta.url));

	function run(args: string[]): string {
		return execFileSync(tsx, [script, ...args], { encoding: "utf8" });
	}

	it("默认输出表格并支持 --blocked、--json", () => {
		if (!existsSync(tsx)) return;
		const root = writeAudit(tempRoot(), lines.map((line) => JSON.stringify(line)).join("\n"));

		const all = run([root, "--all"]);
		expect(all).toContain("bash: npm run check");
		expect(all).toContain("显示 3 条");

		const blocked = run([root, "--blocked"]);
		expect(blocked).toContain("rm -rf scratch/old");
		expect(blocked).not.toContain("npm run check");

		const json = run([root, "--json", "--all"]);
		expect(json.trim().split("\n")).toHaveLength(3);
		expect(JSON.parse(json.trim().split("\n")[2]).toolName).toBe("read");
	});

	it("没有审计文件时给出明确提示而不是报错", () => {
		if (!existsSync(tsx)) return;
		const root = tempRoot();
		expect(run([root])).toContain("没有审计记录");
	});
});
