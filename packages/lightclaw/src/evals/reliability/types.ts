export type Split = "development" | "selection" | "blind";
export type Decision = "complete" | "refuse" | "clarify" | "unable" | "unknown";
export interface ReliabilityTask {
	id: string;
	split: Split;
	source: string;
	family: string;
	scenario: string;
	prompt: string;
	inputs: Record<string, string>;
	output: string;
}
export interface Oracle {
	decision: Exclude<Decision, "unknown">;
	expected: unknown;
	constraints: Array<Record<string, unknown>>;
	provenance: string;
}
export interface Job {
	id: string;
	caseId: string;
	arm: "baseline" | "governed" | "candidate";
	repetition: number;
	seed: number;
	axis: "A" | "B";
	artifactEligible: boolean;
	effectEligible: boolean;
}
export interface Usage {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	modelRequests: number | null;
}
export interface Observation {
	decision: Decision;
	systemCompleted: boolean;
	goalStatus: string | null;
	phases: string[];
	humanRequired: boolean;
	taskLost: boolean;
	inboxStatus: string | null;
	humanInterventions: number;
	toolErrors: number;
	productTimeout: boolean;
	systemFailure: boolean;
	accepted: boolean;
	consumed: boolean;
	unresolved: number;
	duplicateEffects: number | null;
	compactions: number;
	cycles: number;
	durationMs: number;
	usage: Usage;
	usageSource: "synthetic-faux-estimate";
	platform: "protocol-simulator";
	evidence: "faux-wiring-only";
}
export interface Score {
	artifactCorrect: boolean | null;
	inputPreserved: boolean;
	businessValid: boolean | null;
	checkerIntegrity: boolean;
	handlingCorrect: boolean | null;
	falseCompletion: boolean | null;
	modelFalseCompletion: boolean | null;
	falseRefusal: boolean | null;
	artifactRightSystemFailure: boolean | null;
}
export interface Attempt {
	job: Job;
	terminal: "completed" | "task_failed" | "external_timeout" | "worker_error" | "missing_record" | "not_started";
	controller: {
		code: number | null;
		signal: string | null;
		timeout: boolean;
		boots: number;
		elapsedMs?: number;
		recordError?: boolean;
	};
	observation: Observation | null;
	score: Score | null;
	cost: null;
}
export interface Freeze {
	schema: 1;
	evidence: "faux-wiring-only";
	axis: "A" | "B";
	splits: Split[];
	repetitions: number;
	jobs: Job[];
	hashes: Record<string, string>;
	node: string;
	python: string;
	runtime: Record<string, unknown>;
	prompts: { baseline: string; candidate: string };
	budget: { maxConcurrent: number; externalTimeoutMs: number; maxRequestsPerAttempt: number };
	candidateCost: { generation: "not_run"; selection: "recorded_per_attempt"; money: null };
}
