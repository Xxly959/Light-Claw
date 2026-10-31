import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dataRoot, sha256 } from "./data.js";
import type { Observation, Oracle, ReliabilityTask, Score } from "./types.js";
export const checkerPath = `${dataRoot}/protected/check-artifacts.py`;
export const readerPath = fileURLToPath(new URL("../../attachment-reader.py", import.meta.url));
export function judge(
	task: ReliabilityTask,
	oracle: Oracle,
	observation: Observation,
	root: string,
	channel: string,
	inputHashes: Record<string, string>,
	expectedCheckerHash: string,
): Score {
	if (sha256(readFileSync(checkerPath)) !== expectedCheckerHash)
		throw new Error("Protected checker integrity mismatch");
	const result = JSON.parse(
		execFileSync("python3", ["-I", checkerPath, readerPath], {
			input: JSON.stringify({ root, channel, output: task.output, inputHashes, oracle }),
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 1024 * 1024,
		}),
	) as Pick<Score, "artifactCorrect" | "inputPreserved" | "businessValid">;
	if (sha256(readFileSync(checkerPath)) !== expectedCheckerHash)
		throw new Error("Protected checker changed during read");
	const claim = observation.systemCompleted;
	const wrong =
		result.artifactCorrect === null
			? oracle.decision !== "complete"
			: !result.artifactCorrect || !result.inputPreserved || result.businessValid === false;
	return {
		...result,
		checkerIntegrity: true,
		handlingCorrect: observation.decision === "unknown" ? null : observation.decision === oracle.decision,
		falseCompletion: claim && wrong,
		modelFalseCompletion: observation.decision === "complete" && wrong,
		falseRefusal: oracle.decision === "complete" ? observation.decision === "refuse" : null,
		artifactRightSystemFailure:
			result.artifactCorrect === null
				? null
				: result.artifactCorrect &&
					(observation.systemFailure || observation.productTimeout || observation.decision === "unable"),
	};
}
