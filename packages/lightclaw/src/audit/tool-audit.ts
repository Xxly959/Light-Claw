/**
 * 两级审计：结构化摘要始终落盘，参数原文按模式受控落盘。
 *
 * 摘要通道回答"谁、在哪个频道、用什么工具、对什么目标、结果如何"；
 * 原文通道默认不写，需要复盘时才开启，避免为了可追溯而关掉脱敏策略。
 */

import { createHash } from "node:crypto";
import type { PolicyDecision } from "../policy/decide.js";
import { redactDiagnosticValue } from "../redaction.js";
import { appendManagedAudit, writeManagedPayload } from "./storage.js";

export type PayloadMode = "off" | "digest" | "full";
export type ToolAuditOutcome = "ok" | "error" | "blocked" | "started";

export interface ToolAuditEvent {
	runId: string;
	channelId: string;
	toolCallId: string;
	toolName: string;
	capabilities: readonly string[];
	trust: string;
	decision: PolicyDecision;
	reason?: string;
	approvalId?: string;
	argsDigest: string;
	argsSummary: string;
	outcome: ToolAuditOutcome;
	exitCode?: number;
	durationMs: number;
	errorClass?: string;
}

const MAX_PAYLOAD_BYTES = 256 * 1024;

export function resolvePayloadMode(env: NodeJS.ProcessEnv = process.env): PayloadMode {
	const value = env.LIGHTCLAW_AUDIT_PAYLOAD_MODE?.trim().toLowerCase();
	if (value === undefined || value === "") return "digest";
	if (value === "off" || value === "digest" || value === "full") return value;
	throw new Error("LIGHTCLAW_AUDIT_PAYLOAD_MODE 只能是 off、digest 或 full");
}

/** toolCallId 来自模型，必须转成安全路径片段。 */
function safeSegment(value: string): string {
	if (/^[A-Za-z0-9_-]{1,64}$/.test(value)) return value;
	return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function appendToolAuditEvent(workspaceDir: string, event: ToolAuditEvent): void {
	const line = `${JSON.stringify(
		redactDiagnosticValue({
			ts: new Date().toISOString(),
			...event,
			capabilities: [...event.capabilities],
		}),
	)}\n`;
	appendManagedAudit(workspaceDir, "tool-calls.jsonl", line);
}

/**
 * 原文通道。mode=full 时才写；写入前统一脱敏，权限 0600。
 * 返回落盘路径，便于审计事件引用；不写时返回 undefined。
 */
export function writeToolPayload(
	workspaceDir: string,
	runId: string,
	toolCallId: string,
	payload: { args?: unknown; output?: string; error?: string },
	mode: PayloadMode = resolvePayloadMode(),
): string | undefined {
	if (mode !== "full") return undefined;

	const body = `${JSON.stringify(redactDiagnosticValue({ ts: new Date().toISOString(), ...payload }), null, 2)}\n`;
	const bounded =
		Buffer.byteLength(body) > MAX_PAYLOAD_BYTES
			? `${JSON.stringify({ truncated: true, preview: body.slice(0, MAX_PAYLOAD_BYTES / 8) })}\n`
			: body;
	return writeManagedPayload(workspaceDir, safeSegment(runId), safeSegment(toolCallId), bounded);
}

/** bash 工具在非零退出时抛错，退出码只出现在错误文本里。 */
export function extractExitCode(text: string): number | undefined {
	const match = /exited with code (\d+)/.exec(text);
	if (!match) return undefined;
	const parsed = Number(match[1]);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** 错误分类只保留稳定的几类，避免把参数或路径写进索引字段。 */
export function classifyToolError(text: string): string {
	if (/timed out/i.test(text)) return "timeout";
	if (/aborted/i.test(text)) return "aborted";
	if (/exited with code \d+/.test(text)) return "nonzero-exit";
	if (/blocked|审批|确认/i.test(text)) return "blocked";
	return "tool-error";
}
