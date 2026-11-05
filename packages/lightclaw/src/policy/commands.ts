/**
 * `/approve` 命令处理。
 *
 * 只做票据的确认与拒绝，不启动 run；批准后由 Agent 重新发起同一操作，
 * 票据在放行时转为 consumed，因此同一张票据不能重复使用。
 */

import { assertExecutionAuthorized } from "../authorization.js";
import type { ChatEventOrigin } from "../transport.js";
import type { ApprovalStore } from "./approvals.js";

export interface ApprovalCommandContext {
	approvals: ApprovalStore;
	userId: string;
	origin: ChatEventOrigin;
	ownerUserId?: string;
	adminUserIds?: readonly string[];
	trustedUserIds?: readonly string[];
	assertMaintenance?: () => void;
}

export interface ApprovalCommandResult {
	handled: boolean;
	response?: string;
	/** 批准后立即续跑一次，让模型重试被拦截的操作；拒绝时不续跑。 */
	startRun?: boolean;
	retryText?: string;
	executionUserId?: string;
}

function formatClock(iso: string): string {
	const date = new Date(iso);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

function formatPending(store: ApprovalStore): string {
	const expired = store
		.list()
		.filter(
			(ticket) => ["pending", "approved"].includes(ticket.status) && Date.parse(ticket.expiresAt) <= Date.now(),
		);
	const pending = store.pending();
	const history = expired
		.slice(-20)
		.map((ticket) => `- ${ticket.id} 已过期（原状态 ${ticket.status}）：${ticket.summary}；请重新申请`);
	if (expired.length > 20)
		history.push(`另有 ${expired.length - 20} 条过期历史；用 /approve show <id> 查询指定记录。`);
	if (pending.length === 0) return ["当前没有待审批操作。", ...history].join("\n");
	const lines = [`待审批操作（${pending.length}）：`];
	for (const ticket of pending) {
		lines.push(`- ${ticket.id}  ${ticket.summary}`);
		lines.push(`  原因：${ticket.reason}　过期：${formatClock(ticket.expiresAt)}`);
	}
	lines.push(...history, "批准：/approve <id>　拒绝：/approve deny <id>");
	return lines.join("\n");
}

export function handleApprovalCommand(text: string, context: ApprovalCommandContext): ApprovalCommandResult {
	const trimmed = text.trim();
	if (!/^\/approve(?:\s|$)/.test(trimmed)) return { handled: false };
	const argument = trimmed.slice("/approve".length).trim();

	if (!argument || argument === "list" || argument === "help") {
		return { handled: true, response: formatPending(context.approvals) };
	}

	if (argument === "maintain") {
		if (!context.assertMaintenance) throw new Error("审批维护需要当前实例的独占处置上下文");
		context.assertMaintenance();
		const result = context.approvals.maintain({ origin: context.origin, user: context.userId });
		return {
			handled: true,
			response: `已归档 ${result.archived} 条历史，保留 ${result.activeRecords} 条活动票据。历史可用 /approve show <id> 查询；有效待审批/已批准票据不会归档。`,
		};
	}
	if (argument.startsWith("show ")) {
		const id = argument.slice(5).trim();
		if (!/^(?:[a-f0-9]{8}|[a-f0-9]{32})$/.test(id)) throw new Error("票据ID非法");
		const ticket = context.approvals.get(id);
		if (!ticket) throw new Error("找不到审批票据");
		assertExecutionAuthorized(
			{ origin: context.origin, user: context.userId },
			ticket.taskCreatorUserId ?? ticket.ownerUserId,
			context.trustedUserIds,
			context.adminUserIds,
		);
		return {
			handled: true,
			response: `${ticket.id} ${ticket.archiveId ? "已归档" : "活动"} ${ticket.status}${Date.parse(ticket.expiresAt) <= Date.now() ? " 已过期" : ""}\n${ticket.summary}\n请求者：${ticket.ownerUserId}；任务创建者：${ticket.taskCreatorUserId ?? ticket.ownerUserId}；批准者：${ticket.decidedBy ?? "无"}\n到期：${ticket.expiresAt}`,
		};
	}
	const deny = argument.startsWith("deny ");
	const id = (deny ? argument.slice("deny ".length) : argument).trim();
	if (!/^(?:[a-f0-9]{8}|[a-f0-9]{32})$/.test(id))
		throw new Error(
			"用法：/approve <票据ID>、/approve deny <票据ID> 、/approve show <票据ID>、/approve maintain 或 /approve list",
		);

	// 票据自带发起者：频道状态被回收后仍能判定谁有权批准。
	const known = context.approvals.get(id);
	if (!known) throw new Error(`找不到审批票据：${id}`);

	assertExecutionAuthorized(
		{ user: context.userId, origin: context.origin },
		known.taskCreatorUserId ?? known.ownerUserId,
		context.trustedUserIds ?? [],
		context.adminUserIds ?? [],
	);

	if (deny) {
		const ticket = context.approvals.deny(id, context.userId);
		return {
			handled: true,
			response: `已拒绝票据 ${ticket.id}：${ticket.summary}\n之后相同的调用仍会被拦截。`,
		};
	}

	const ticket = context.approvals.approve(id, context.userId);
	return {
		handled: true,
		startRun: true,
		executionUserId: ticket.ownerUserId,
		retryText: [
			`[已批准] 票据 ${ticket.id} 已由 ${context.userId} 批准：${ticket.summary}`,
			"请立即重新执行同一操作，参数保持不变；不要再次询问确认，也不要改用其他路径或命令。",
			"如果参数发生变化，系统会重新拦截并要求新的批准。",
		].join("\n"),
		response: [
			`已批准票据 ${ticket.id}：${ticket.summary}`,
			`批准人：${context.userId}`,
			"正在重试同一操作；票据只能使用一次。",
		].join("\n"),
	};
}
