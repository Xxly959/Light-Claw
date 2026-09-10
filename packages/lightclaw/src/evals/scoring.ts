import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { AgentRunResult } from "../agent.js";
import type { EvalCase, EvalCaseResult, EvalCheck } from "./types.js";

function check(name: string, passed: boolean, detail: string): EvalCheck {
	return { name, passed, detail };
}

function resolveArtifact(channelDir: string, relativePath: string): string | undefined {
	const root = resolve(channelDir);
	const target = resolve(root, relativePath);
	return target.startsWith(`${root}${sep}`) ? target : undefined;
}

export function scoreEvalCase(
	testCase: EvalCase,
	response: string,
	run: AgentRunResult,
	channelDir: string,
): EvalCaseResult {
	const checks: EvalCheck[] = [check("agent_run", run.stopReason !== "error", run.errorMessage ?? run.stopReason)];

	for (const text of testCase.expect.responseIncludes ?? []) {
		checks.push(check(`response_includes:${text}`, response.includes(text), `响应应包含“${text}”`));
	}
	for (const path of testCase.expect.filesExist ?? []) {
		const absolutePath = resolveArtifact(channelDir, path);
		checks.push(
			check(
				`file_exists:${path}`,
				absolutePath !== undefined && existsSync(absolutePath),
				absolutePath ?? "非法路径",
			),
		);
	}
	for (const expected of testCase.expect.filesContain ?? []) {
		const absolutePath = resolveArtifact(channelDir, expected.path);
		const content = absolutePath && existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
		checks.push(check(`file_contains:${expected.path}`, content.includes(expected.text), `应包含“${expected.text}”`));
	}
	if (testCase.expect.maxToolErrors !== undefined) {
		checks.push(
			check(
				"tool_errors",
				run.toolErrors <= testCase.expect.maxToolErrors,
				`${run.toolErrors} <= ${testCase.expect.maxToolErrors}`,
			),
		);
	}
	if (testCase.expect.maxDurationMs !== undefined) {
		checks.push(
			check(
				"duration",
				run.durationMs <= testCase.expect.maxDurationMs,
				`${run.durationMs}ms <= ${testCase.expect.maxDurationMs}ms`,
			),
		);
	}

	return {
		id: testCase.id,
		score: checks.filter((item) => item.passed).length / checks.length,
		response,
		checks,
		run,
	};
}
