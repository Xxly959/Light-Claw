#!/usr/bin/env node
/**
 * 审计查询 CLI。
 *
 * 用法：lightclaw-audit <工作目录> [--last=N] [--tool=bash] [--channel=C1]
 *                        [--outcome=blocked|ok|error] [--decision=allow|approve|deny]
 *                        [--blocked] [--all] [--json]
 */

import { resolve } from "node:path";
import { type AuditFilter, filterRecords, formatRecords, parseAuditLines, summarizeRecords } from "./query.js";

import { readToolAudit, resolveAuditDirectory } from "./storage.js";

const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
	console.log(
		[
			"用法：lightclaw-audit <工作目录> [选项]",
			"  --last=N        只显示最近 N 条（默认 20）",
			"  --all           显示全部",
			"  --tool=bash     按工具过滤",
			"  --channel=C1    按频道过滤",
			"  --outcome=ok|error|blocked  按结果过滤",
			"  --decision=allow|approve|deny  按裁决过滤",
			"  --blocked       等价于 --outcome=blocked",
			"  --json          输出 JSON 行，便于二次处理",
		].join("\n"),
	);
	process.exit(0);
}

function flag(name: string): string | undefined {
	const prefix = `--${name}=`;
	return cliArgs.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || undefined;
}

const workingDir = resolve(cliArgs.find((arg) => !arg.startsWith("-")) ?? ".");
const content = readToolAudit(workingDir);
if (!content) {
	console.log(`没有审计记录：${resolveAuditDirectory(workingDir)}`);
	process.exit(0);
}

const lastArg = flag("last");
const all = cliArgs.includes("--all");
const last = all ? undefined : lastArg === undefined ? 20 : Number(lastArg);
if (last !== undefined && (!Number.isSafeInteger(last) || last < 1)) {
	console.error("--last 必须是正整数");
	process.exit(1);
}

const filter: AuditFilter = {
	tool: flag("tool"),
	channel: flag("channel"),
	outcome: cliArgs.includes("--blocked") ? "blocked" : flag("outcome"),
	decision: flag("decision"),
	last,
};

const records = parseAuditLines(content);
const selected = filterRecords(records, filter);

if (cliArgs.includes("--json")) {
	for (const record of selected) console.log(JSON.stringify(record));
} else {
	console.log(formatRecords(selected));
	console.log(`\n${summarizeRecords(selected)}（总记录 ${records.length}）`);
}
