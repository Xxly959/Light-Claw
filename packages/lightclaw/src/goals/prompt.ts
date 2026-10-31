import type { GoalState } from "./types.js";

export function formatGoalPrompt(goal: GoalState | undefined): string {
	if (!goal || goal.status !== "active") return "";
	return `\n\n## LightClaw 长期目标\n目标：${goal.objective}\n当前轮次：${goal.cycle + 1}\n最近进展：${goal.lastProgress ?? "暂无"}\n\n你必须持续推进目标。每轮至少调用一次 goal_progress，记录本轮完成的工作和可核验依据。验收契约：${JSON.stringify(goal.acceptance)}\n最近验证：${JSON.stringify(goal.verificationHistory.at(-1)?.checks ?? [])}\n只有目标确实完成并有证据时才能调用 goal_complete。该工具仅申请验证；不能修改验收条件或伪造结果。人工验收会等待创建者发送精确确认命令。遇到无法自行解决的问题时说明阻塞原因，不要伪造完成状态。`;
}
