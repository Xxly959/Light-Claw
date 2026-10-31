import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RunAuditEvent {
	type:
		| "verification_finished"
		| "goal_confirmed"
		| "run_finished"
		| "goal_created"
		| "goal_state_changed"
		| "delivery_failed"
		| "goal_state_invalid"
		| "queue_full"
		| "queue_expired";
	channelId: string;
	attemptId?: string;
	verificationStatus?: string;
	completionMethod?: "automatic" | "human" | "self_reported";
	verificationCommandCount?: number;
	messageId?: string;
	goalId?: string;
	cycle?: number;
	durationMs?: number;
	stopReason?: string;
	toolCalls?: number;
	toolErrors?: number;
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
	detail?: string;
}

export function appendAuditEvent(workspaceDir: string, event: RunAuditEvent): void {
	const path = join(workspaceDir, "audit", "runs.jsonl");
	mkdirSync(dirname(path), { recursive: true });
	const detail = event.detail
		?.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
		.replace(/Bearer\s+[^\s;]+/gi, "Bearer [REDACTED]")
		.replace(/((?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*)[^\s;]+/gi, "$1[REDACTED]")
		.slice(0, 8000);
	appendFileSync(path, `${JSON.stringify({ ...event, detail, timestamp: new Date().toISOString() })}\n`, "utf8");
}
