import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { GoalStore } from "../goals/store.js";

const progressSchema = Type.Object({
	summary: Type.String({ description: "本轮完成的工作或遇到的阻塞" }),
	evidence: Type.Optional(Type.Array(Type.String({ description: "文件、命令结果或其他可核验依据" }))),
});

const completeSchema = Type.Object({
	summary: Type.String({ description: "目标完成总结" }),
	evidence: Type.Array(Type.String({ description: "证明目标已完成的依据" }), { minItems: 1 }),
});

export function createGoalTools(store: GoalStore) {
	const progressTool: AgentTool<typeof progressSchema> = {
		name: "goal_progress",
		label: "记录目标进展",
		description: "仅当系统提示词显示有进行中的长期目标时调用；普通单轮任务不要调用。长期目标每轮至少调用一次。",
		parameters: progressSchema,
		async execute(_id, { summary, evidence }) {
			const goal = store.updateProgress(summary, evidence);
			return { content: [{ type: "text", text: `已记录目标进展：${goal.lastProgress}` }], details: goal };
		},
	};
	const completeTool: AgentTool<typeof completeSchema> = {
		name: "goal_complete",
		label: "完成长期目标",
		description: "仅当系统提示词显示有进行中的长期目标，且目标确实完成并有可核验依据时调用。普通单轮任务不要调用。",
		parameters: completeSchema,
		async execute(_id, { summary, evidence }) {
			const goal = store.complete(summary, evidence);
			return {
				content: [{ type: "text", text: `目标已完成：${goal.objective}` }],
				details: goal,
				terminate: true,
			};
		},
	};
	return [progressTool, completeTool];
}
