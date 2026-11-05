import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { assertGoalSnapshots, readGoalArtifact } from "./artifact.js";
import type {
	GoalArtifactSnapshot,
	GoalCheckResult,
	GoalCompletionRequest,
	GoalState,
	GoalVerificationReport,
	GoalVerificationRuntime,
} from "./types.js";

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
function quote(text: string): string {
	return `'${text.replace(/'/g, "'\\''")}'`;
}

export async function verifyGoalCompletion(
	goal: GoalState,
	request: GoalCompletionRequest,
	runtime: GoalVerificationRuntime,
): Promise<GoalVerificationReport> {
	const report: GoalVerificationReport = {
		attemptId: randomUUID(),
		goalId: goal.id,
		revision: goal.revision,
		status: "inconclusive",
		startedAt: new Date().toISOString(),
		finishedAt: "",
		...request,
		checks: [],
		snapshots: [],
	};
	const snapshots = new Map<string, GoalArtifactSnapshot>();
	const active = () => {
		runtime.signal.throwIfAborted();
		runtime.assertActive();
	};
	const add = (check: GoalCheckResult) => report.checks.push(check);
	try {
		active();
		if (request.deliverables?.kind === "files") {
			for (const path of request.deliverables.paths) {
				const read = await readGoalArtifact(runtime.channelDir, path, { signal: runtime.signal });
				active();
				if (read.status !== "snapshot") {
					report.status = "failed";
					return report;
				}
				snapshots.set(path, read.snapshot);
			}
		}
		if (goal.acceptance.mode === "automatic") {
			for (const [index, rule] of goal.acceptance.files.entries()) {
				active();
				const start = performance.now();
				const read = await readGoalArtifact(runtime.channelDir, rule.path, {
					signal: runtime.signal,
					contains: rule.contains,
				});
				active();
				let status: GoalCheckResult["status"] = "failed";
				let reasonCode = "missing";
				if (read.status === "inconclusive") {
					status = "inconclusive";
					reasonCode = read.reasonCode;
				}
				if (read.status === "snapshot") {
					snapshots.set(rule.path, read.snapshot);
					const baseline = goal.baselines.find((item) => item.path === rule.path);
					const changed = !rule.changed || (baseline !== undefined && baseline.sha256 !== read.snapshot.sha256);
					status = read.contentsMatch && changed ? "passed" : "failed";
					reasonCode = !read.contentsMatch ? "content_mismatch" : !changed ? "unchanged" : "matched";
				}
				add({
					checkId: `file-${index}`,
					kind: "file",
					status,
					reasonCode,
					checkedAt: new Date().toISOString(),
					durationMs: performance.now() - start,
					...(read.status === "snapshot" ? { snapshot: read.snapshot } : {}),
				});
			}
			for (const [index, rule] of goal.acceptance.commands.entries()) {
				active();
				const start = performance.now();
				const sources: GoalArtifactSnapshot[] = [];
				let status: GoalCheckResult["status"] = "inconclusive";
				let reasonCode = "source_unavailable";
				for (const path of rule.sourcePaths) {
					const read = await readGoalArtifact(runtime.channelDir, path, { signal: runtime.signal });
					if (read.status === "snapshot") sources.push(read.snapshot);
				}
				let details: Partial<GoalCheckResult> = {};
				if (sources.length === rule.sourcePaths.length && runtime.sandbox.type === "docker") {
					for (const source of sources) {
						const previous = snapshots.get(source.path);
						if (
							previous &&
							(previous.sha256 !== source.sha256 ||
								previous.inode !== source.inode ||
								previous.device !== source.device)
						)
							throw new Error("source_changed");
						snapshots.set(source.path, source);
					}
					active();
					const { timeoutSeconds } = runtime.reserveCommand();
					active();
					try {
						const cwd = join(
							runtime.executor.getWorkspacePath(dirname(runtime.channelDir)),
							basename(runtime.channelDir),
						);
						const result = await runtime.executor.exec(`cd ${quote(cwd)} && ${rule.command}`, {
							timeout: timeoutSeconds,
							signal: runtime.signal,
						});
						active();
						details = {
							exitCode: result.code,
							outputTruncated: result.outputTruncated ?? false,
							stdoutPreviewSha256: digest(result.stdout),
							stderrPreviewSha256: digest(result.stderr),
						};
						status =
							result.code !== 0
								? "failed"
								: rule.stdoutIncludes && result.outputTruncated
									? "inconclusive"
									: rule.stdoutIncludes?.some((text) => !result.stdout.includes(text))
										? "failed"
										: "passed";
						reasonCode =
							status === "passed"
								? "exit_zero"
								: result.code !== 0
									? "exit_nonzero"
									: result.outputTruncated
										? "output_truncated"
										: "output_mismatch";
						await assertGoalSnapshots(runtime.channelDir, sources, runtime.signal);
					} catch {
						active();
						status = "inconclusive";
						reasonCode = "command_unverifiable";
					}
				}
				add({
					checkId: `command-${index}`,
					kind: "command",
					status,
					reasonCode,
					checkedAt: new Date().toISOString(),
					durationMs: performance.now() - start,
					...details,
				});
			}
			await assertGoalSnapshots(runtime.channelDir, [...snapshots.values()], runtime.signal);
			active();
			report.status = report.checks.some((check) => check.status === "failed")
				? "failed"
				: report.checks.some((check) => check.status === "inconclusive") || !report.checks.length
					? "inconclusive"
					: "passed";
		}
	} catch {
		try {
			active();
			report.status = "inconclusive";
		} catch {
			report.status = "aborted";
		}
	} finally {
		report.finishedAt = new Date().toISOString();
		report.snapshots = [...snapshots.values()];
	}
	return report;
}
