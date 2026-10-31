import type { SandboxConfig } from "../sandbox.js";
import type { ChatEventOrigin } from "../transport.js";
import { parseGoalCreateInput } from "./acceptance.js";
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
		`目标 ID：${goal.id}`,
		`验收：${goal.acceptance.mode}`,
		`目标：${goal.objective}`,
		`状态：${goal.status}`,
		`完成方式：${goal.completion?.method ?? "尚未完成"}`,
		`轮次：${goal.cycle}`,
		`最近进展：${goal.lastProgress ?? "暂无"}`,
	];
	if (goal.pauseReason) lines.push(`暂停原因：${goal.pauseReason}`);
	if (goal.evidence.length > 0) lines.push(`最近证据：${goal.evidence.at(-1)}`);
	const report = goal.verificationHistory.at(-1);
	if (report)
		lines.push(
			`最近验证：${report.status} (${report.attemptId})`,
			...report.checks.map((check) => `${check.checkId}: ${check.status} (${check.reasonCode})`),
		);
	if (goal.status === "awaiting_confirmation" && report)
		lines.push(`待确认摘要：${report.summary}`, `创建者确认命令：/goal confirm ${goal.id} ${report.attemptId}`);
	return lines.join("\n");
}

export interface GoalCommandContext {
	userId: string;
	origin: ChatEventOrigin;
	sandbox: SandboxConfig;
	signal: AbortSignal;
}
export async function handleGoalCommand(
	text: string,
	store: GoalStore,
	context: GoalCommandContext,
): Promise<GoalCommandResult> {
	const trimmed = text.trim();
	if (!/^\/goal(?:\s|$)/.test(trimmed)) return { handled: false, startRun: false };
	const argument = trimmed.slice("/goal".length).trim();

	if (!argument || argument === "status") {
		return { handled: true, startRun: false, response: formatGoalStatus(store.get()) };
	}
	if (context.origin !== "platform") throw new Error("目标控制命令必须来自真实平台用户");
	if (argument.startsWith("dispute ")) {
		const match = /^dispute\s+(\S+)\s+([\s\S]+)$/.exec(argument);
		if (!match) throw new Error("用法：/goal dispute <attemptId> <原因>");
		store.recordDispute(match[1], context.userId, match[2]);
		return {
			handled: true,
			startRun: false,
			response: "已记录验收争议，等待人工复核；原验证记录和目标状态保持不变。",
		};
	}
	if (argument.startsWith("confirm")) {
		const parts = argument.split(/\s+/);
		if (parts.length !== 3 || parts[0] !== "confirm") throw new Error("用法：/goal confirm <goalId> <attemptId>");
		const goal = await store.confirm(parts[1], parts[2], context.userId, context.signal);
		return { handled: true, startRun: false, goal, response: `目标已由创建者确认完成：${goal.objective}` };
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
	if (current?.status === "active" || current?.status === "paused" || current?.status === "awaiting_confirmation") {
		return {
			handled: true,
			startRun: false,
			response: "已有未结束目标，请先使用 /goal cancel，再创建新目标。",
		};
	}
	const input = parseGoalCreateInput(
		argument.startsWith("create ") ? (JSON.parse(argument.slice(7)) as unknown) : { objective: argument },
		context.userId,
		context.sandbox,
	);
	const goal = await store.create(input, context.signal);
	return {
		handled: true,
		startRun: true,
		response: `已创建长期目标：${goal.objective}\n${goal.acceptance.mode === "manual" ? "完成申请将等待创建者确认。" : goal.acceptance.commands.length ? "验收时将重新执行预定命令，请使用可重复的测试命令。" : "完成前将核验预定文件条件。"}`,
		goal,
	};
}
