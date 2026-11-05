import { appendManagedAudit } from "./audit/storage.js";
import type { ModelAttempt } from "./model-router.js";
import { redactDiagnosticValue } from "./redaction.js";

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
		| "queue_expired"
		| "model_fallback"
		| "model_attempt"
		| "approval_decided"
		| "approval_maintenance"
		| "recovery_decided"
		| "fault_raised"
		| "prompt_optimization";
	modelAttempt?: ModelAttempt;
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
	usageIncomplete?: boolean;
	detail?: string;
}

export function appendAuditEvent(workspaceDir: string, event: RunAuditEvent): void {
	appendManagedAudit(
		workspaceDir,
		"runs.jsonl",
		`${JSON.stringify(redactDiagnosticValue({ ...event, timestamp: new Date().toISOString() }))}\n`,
	);
}
