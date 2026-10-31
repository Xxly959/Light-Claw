import type { Executor, SandboxConfig } from "../sandbox.js";

export type GoalStatus = "active" | "paused" | "completed" | "cancelled" | "awaiting_confirmation";
export interface GoalFileRule {
	path: string;
	contains?: string[];
	changed: boolean;
}
export interface GoalCommandRule {
	command: string;
	sourcePaths: string[];
	stdoutIncludes?: string[];
}
export type GoalAcceptance =
	| { mode: "manual" }
	| { mode: "automatic"; files: GoalFileRule[]; commands: GoalCommandRule[] };
export interface GoalBaseline {
	path: string;
	sha256: string | null;
}
export interface GoalArtifactSnapshot {
	path: string;
	sha256: string;
	bytes: number;
	device: string;
	inode: string;
}
export type GoalArtifactRead =
	| { status: "missing" }
	| { status: "snapshot"; snapshot: GoalArtifactSnapshot; contentsMatch: boolean }
	| { status: "inconclusive"; reasonCode: string };
export interface GoalCheckResult {
	checkId: string;
	kind: "file" | "command";
	status: "passed" | "failed" | "inconclusive";
	reasonCode: string;
	durationMs: number;
	checkedAt: string;
	snapshot?: GoalArtifactSnapshot;
	exitCode?: number;
	outputTruncated?: boolean;
	stdoutPreviewSha256?: string;
	stderrPreviewSha256?: string;
}
export interface GoalVerificationReport {
	attemptId: string;
	goalId: string;
	revision: number;
	status: "passed" | "failed" | "inconclusive" | "aborted";
	startedAt: string;
	finishedAt: string;
	summary: string;
	evidence: string[];
	checks: GoalCheckResult[];
	snapshots: GoalArtifactSnapshot[];
}
export interface GoalVerificationRuntime {
	channelDir: string;
	sandbox: SandboxConfig;
	executor: Executor;
	signal: AbortSignal;
	assertActive(): void;
	reserveCommand(): { timeoutSeconds: number };
}
export interface GoalCreateInput {
	objective: string;
	ownerUserId: string;
	acceptance: GoalAcceptance;
}
export interface GoalCompletionRequest {
	summary: string;
	evidence: string[];
}
export interface GoalCompletionOutcome {
	goal: GoalState | undefined;
	report: GoalVerificationReport;
	committed: boolean;
}

export interface GoalState {
	schemaVersion: 2;
	ownerUserId: string;
	revision: number;
	verificationVersion?: number;
	acceptance: GoalAcceptance;
	baselines: GoalBaseline[];
	verificationHistory: GoalVerificationReport[];
	completion?: {
		method: "automatic" | "human" | "self_reported";
		attemptId: string;
		confirmedBy?: string;
		confirmedAt?: string;
	};
	id: string;
	objective: string;
	status: GoalStatus;
	cycle: number;
	consecutiveFailures: number;
	staleCycles: number;
	progressVersion: number;
	lastProgress?: string;
	evidence: string[];
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	pauseReason?: string;
}

export interface GoalLimits {
	maxCycles: number;
	maxFailures: number;
	maxStaleCycles: number;
}
