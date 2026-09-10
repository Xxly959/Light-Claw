export type GoalStatus = "active" | "paused" | "completed" | "cancelled";

export interface GoalState {
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
