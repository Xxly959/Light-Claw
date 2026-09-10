import type { AgentRunResult } from "../agent.js";

export interface EvalCase {
	id: string;
	prompt: string;
	expect: {
		responseIncludes?: string[];
		filesExist?: string[];
		filesContain?: Array<{ path: string; text: string }>;
		maxToolErrors?: number;
		maxDurationMs?: number;
	};
}

export interface EvalCheck {
	name: string;
	passed: boolean;
	detail: string;
}

export interface EvalCaseResult {
	id: string;
	score: number;
	response: string;
	checks: EvalCheck[];
	run: AgentRunResult;
}

export interface EvalReport {
	createdAt: string;
	model: string;
	promptLabel: string;
	score: number;
	passedCases: number;
	totalCases: number;
	totalCost: number;
	totalTokens: number;
	results: EvalCaseResult[];
}
