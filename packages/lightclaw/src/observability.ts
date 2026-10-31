import { join } from "node:path";
import { redactDiagnosticValue } from "./redaction.js";
import { appendDiagnostic } from "./resource-policy.js";

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
	appendDiagnostic(
		path,
		`${JSON.stringify(redactDiagnosticValue({ ...event, timestamp: new Date().toISOString() }))}\n`,
	);
}
