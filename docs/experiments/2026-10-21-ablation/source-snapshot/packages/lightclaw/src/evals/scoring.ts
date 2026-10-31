import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { AgentRunResult } from "../agent.js";
import type { EvalCase, EvalCaseResult, EvalCheck } from "./types.js";

function check(name: string, passed: boolean, detail: string): EvalCheck {
	return { name, passed, detail };
}

function resolveArtifact(channelDir: string, relativePath: string): string | undefined {
	const root = resolve(channelDir);
	const target = resolve(root, relativePath);
	if (!target.startsWith(`${root}${sep}`)) return undefined;
	try {
		const realRoot = realpathSync(root);
		const realTarget = realpathSync(target);
		return realTarget.startsWith(`${realRoot}${sep}`) && statSync(realTarget).isFile() ? realTarget : undefined;
	} catch {
		return undefined;
	}
}

export function scoreEvalCase(
	testCase: EvalCase,
	response: string,
	run: AgentRunResult,
	channelDir: string,
): EvalCaseResult {
	const checks: EvalCheck[] = [
		check(
			"agent_run",
			run.stopReason === "stop" && !run.budgetReason && !run.deliveryError,
			run.errorMessage ?? run.budgetReason ?? run.deliveryError ?? run.stopReason,
		),
	];

	for (const text of testCase.expect.responseIncludes ?? []) {
		checks.push(check(`response_includes:${text}`, response.includes(text), `响应应包含“${text}”`));
	}
	for (const path of testCase.expect.filesExist ?? []) {
		const absolutePath = resolveArtifact(channelDir, path);
		checks.push(check(`file_exists:${path}`, absolutePath !== undefined, absolutePath ?? "非法路径"));
	}
	for (const expected of testCase.expect.filesContain ?? []) {
		const absolutePath = resolveArtifact(channelDir, expected.path);
		let content: string | undefined;
		let detail = `应包含“${expected.text}”`;
		try {
			if (absolutePath) content = readFileSync(absolutePath, "utf8");
		} catch (error) {
			detail = error instanceof Error ? error.message : String(error);
		}
		checks.push(check(`file_contains:${expected.path}`, content?.includes(expected.text) ?? false, detail));
	}
	{
		const maximum = testCase.expect.maxToolErrors ?? 0;
		checks.push(check("tool_errors", run.toolErrors <= maximum, `${run.toolErrors} <= ${maximum}`));
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
