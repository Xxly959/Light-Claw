import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { GoalStore } from "../goals/store.js";
import type { Executor } from "../sandbox.js";
import { attachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGoalTools } from "./goal.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { setUploadFunction } from "./attach.js";

export function createLightClawTools(executor: Executor, goalStore: GoalStore): AgentTool<any>[] {
	return [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		attachTool,
		...createGoalTools(goalStore),
	];
}
