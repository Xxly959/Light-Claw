import type { GoalStore } from "./store.js";
import type { GoalState } from "./types.js";

export interface GoalCommandResult {
	handled: boolean;
	startRun: boolean;
	response?: string;
	goal?: GoalState;
}

export function formatGoalStatus(goal: GoalState | undefined): string {
	if (!goal) return "当前没有长期目标。发送 /goal <目标> 创建一个。";
	const lines = [
		`目标：${goal.objective}`,
		`状态：${goal.status}`,
		`轮次：${goal.cycle}`,
		`最近进展：${goal.lastProgress ?? "暂无"}`,
	];
	if (goal.pauseReason) lines.push(`暂停原因：${goal.pauseReason}`);
	if (goal.evidence.length > 0) lines.push(`最近证据：${goal.evidence.at(-1)}`);
	return lines.join("\n");
}

export function handleGoalCommand(text: string, store: GoalStore): GoalCommandResult {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/goal")) return { handled: false, startRun: false };
	const argument = trimmed.slice("/goal".length).trim();

	if (!argument || argument === "status") {
		return { handled: true, startRun: false, response: formatGoalStatus(store.get()) };
	}
	if (argument === "pause") {
		const goal = store.pause();
		return { handled: true, startRun: false, response: formatGoalStatus(goal), goal };
	}
	if (argument === "resume") {
		const goal = store.resume();
		return { handled: true, startRun: true, response: `继续目标：${goal.objective}`, goal };
	}
	if (argument === "cancel") {
		const goal = store.cancel();
		return { handled: true, startRun: false, response: `已取消目标：${goal.objective}`, goal };
	}

	const current = store.get();
	if (current?.status === "active" || current?.status === "paused") {
		return {
			handled: true,
			startRun: false,
			response: "已有未结束目标，请先使用 /goal cancel，再创建新目标。",
		};
	}
	const goal = store.create(argument);
	return { handled: true, startRun: true, response: `已创建长期目标：${goal.objective}`, goal };
}
