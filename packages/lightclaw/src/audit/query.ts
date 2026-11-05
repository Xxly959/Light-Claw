/**
 * 审计查询。
 *
 * 只读 `audit/tool-calls.jsonl`。单行损坏不会让整体失败——审计文件可能被并发追加，
 * 查询工具不能因为一行坏了就拒绝出证据。
 */

export interface AuditRecord {
	ts: string;
	runId?: string;
	toolCallId?: string;
	channelId: string;
	toolName: string;
	decision: string;
	outcome: string;
	argsSummary?: string;
	reason?: string;
	durationMs?: number;
	exitCode?: number;
	errorClass?: string;
}

export interface AuditFilter {
	tool?: string;
	channel?: string;
	outcome?: string;
	decision?: string;
	/** 只保留最近 N 条；undefined 表示全部。 */
	last?: number;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseAuditLines(content: string): AuditRecord[] {
	const records: AuditRecord[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const raw = parsed as Record<string, unknown>;
		const toolName = text(raw.toolName);
		const channelId = text(raw.channelId);
		// 缺关键字段的行视为损坏，不进入结果集。
		if (!toolName || !channelId) continue;
		records.push({
			ts: text(raw.ts) ?? "",
			runId: text(raw.runId),
			toolCallId: text(raw.toolCallId),
			channelId,
			toolName,
			decision: text(raw.decision) ?? "unknown",
			outcome: text(raw.outcome) ?? "unknown",
			argsSummary: text(raw.argsSummary),
			reason: text(raw.reason),
			durationMs: count(raw.durationMs),
			exitCode: count(raw.exitCode),
			errorClass: text(raw.errorClass),
		});
	}
	return records;
}

export function filterRecords(records: readonly AuditRecord[], filter: AuditFilter): AuditRecord[] {
	const matched = records.filter(
		(record) =>
			(!filter.tool || record.toolName === filter.tool) &&
			(!filter.channel || record.channelId === filter.channel) &&
			(!filter.outcome || record.outcome === filter.outcome) &&
			(!filter.decision || record.decision === filter.decision),
	);
	if (filter.last === undefined) return matched;
	return filter.last >= matched.length ? matched : matched.slice(-filter.last);
}

function clip(value: string, width: number): string {
	return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function pad(value: string, width: number): string {
	return clip(value, width).padEnd(width, " ");
}

export function formatRecords(records: readonly AuditRecord[]): string {
	if (records.length === 0) return "没有匹配的审计记录。";
	const header = [
		pad("时间", 19),
		pad("频道", 12),
		pad("工具", 10),
		pad("判定", 8),
		pad("结果", 8),
		pad("耗时", 7),
		"摘要",
	].join(" ");
	const lines = records.map((record) => {
		const time = record.ts.replace("T", " ").slice(0, 19);
		const duration = record.durationMs === undefined ? "-" : `${record.durationMs}ms`;
		const summary = record.argsSummary ?? record.toolName;
		const suffix =
			record.outcome === "error" && record.errorClass
				? ` (${record.errorClass}${record.exitCode === undefined ? "" : `, exit ${record.exitCode}`})`
				: "";
		return [
			pad(time, 19),
			pad(record.channelId, 12),
			pad(record.toolName, 10),
			pad(record.decision, 8),
			pad(record.outcome, 8),
			pad(duration, 7),
			`${summary}${suffix}`,
		].join(" ");
	});
	return [header, ...lines].join("\n");
}

export function summarizeRecords(records: readonly AuditRecord[]): string {
	const blocked = records.filter((record) => record.outcome === "blocked").length;
	const errors = records.filter((record) => record.outcome === "error").length;
	return `显示 ${records.length} 条；blocked ${blocked}，error ${errors}`;
}
