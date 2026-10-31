import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { GoalStore } from "../goals/store.js";
import type { GoalVerificationRuntime } from "../goals/types.js";

const progressSchema = Type.Object({
	summary: Type.String({ description: "本轮完成的工作或遇到的阻塞" }),
	evidence: Type.Optional(Type.Array(Type.String({ description: "文件、命令结果或其他可核验依据" }))),
});

const completeSchema = Type.Object(
	{
		summary: Type.String({ description: "目标完成总结" }),
		evidence: Type.Array(Type.String({ description: "证明目标已完成的依据" }), { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export function createGoalTools(store: GoalStore, runtime: () => GoalVerificationRuntime) {
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
		description:
			"仅当系统提示词显示有进行中的长期目标，且申请由宿主机核验完成；文本证据不能直接完成目标时调用。普通单轮任务不要调用。",
		parameters: completeSchema,
		async execute(_id, { summary, evidence }, signal) {
			const context = runtime();
			const outcome = await store.requestCompletion(
				{ summary, evidence },
				{ ...context, signal: signal ? AbortSignal.any([context.signal, signal]) : context.signal },
			);
			const goal = outcome.goal;
			const text =
				goal?.status === "completed"
					? `目标已验证完成：${goal.objective}`
					: goal?.status === "awaiting_confirmation"
						? `等待目标创建者确认：/goal confirm ${goal.id} ${outcome.report.attemptId}`
						: `验收未通过：${outcome.report.status}；${outcome.report.checks.map((check) => check.reasonCode).join("、")}`;
			return {
				content: [{ type: "text", text }],
				details: outcome,
				terminate: outcome.committed && (goal?.status === "completed" || goal?.status === "awaiting_confirmation"),
			};
		},
	};
	return [progressTool, completeTool];
}
