import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { GoalStore } from "../goals/store.js";
import type { GoalVerificationRuntime } from "../goals/types.js";
import type { Executor } from "../sandbox.js";
import { createAttachTool, type UploadFunction } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGoalTools } from "./goal.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export function createLightClawTools(
	executor: Executor,
	goalStore: GoalStore,
	upload: UploadFunction,
	runtime: () => GoalVerificationRuntime,
): AgentTool[] {
	return [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		createAttachTool(upload),
		...createGoalTools(goalStore, runtime),
	];
}
