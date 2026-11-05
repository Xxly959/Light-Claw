import { assertControlAuthorized, assertExecutionAuthorized } from "./authorization.js";
import type { DurableInbox, InboxRecord } from "./durable-inbox.js";
import type { OperationJournal, OperationRecord } from "./operations.js";
import type { ChatEvent } from "./transport.js";
export interface RecoveryContext {
	inbox: DurableInbox;
	operations?: OperationJournal;
	event: ChatEvent;
	adminUserIds?: readonly string[];
	trustedUserIds?: readonly string[];
	/** Must be supplied by the owning runtime while its kernel lock is held and channel idle. */
	assertExclusive(): void;
	audit(entry: { action: string; id: string; revision: number; actor: string; note: string }): void;
}
function summary(record: InboxRecord): string {
	return `ID=${record.id} version=${record.revision ?? 0} source=${record.source ?? record.event.origin} channel=${record.event.channel} requester=${record.event.user} status=${record.status} attempts=${record.attempts}\n失败阶段/详情：${record.detail ?? "未记录"}\n可能副作用：工具执行、写入、外发或最终通知可能已经发生；未经核对不得重放。`;
}
export function handleRecoveryCommand(
	text: string,
	context: RecoveryContext,
): { response: string; retry?: InboxRecord; operationRetry?: OperationRecord } | undefined {
	if (!/^\/recover(?:\s|$)/.test(text.trim())) return undefined;
	const [_, action = "list", id, version, ...rest] = text.trim().split(/\s+/);
	const { inbox, event } = context;
	if (event.origin !== "platform" || !event.user.trim()) throw new Error("人工处置必须来自平台用户");
	if (action === "capacity") {
		assertExecutionAuthorized(event, event.user, context.trustedUserIds, context.adminUserIds);
		return { response: JSON.stringify(inbox.capacity()) };
	}
	if (action === "maintain") {
		for (const r of inbox.list().filter((r) => r.event.channel === event.channel))
			assertControlAuthorized(event, r.event.user, context.adminUserIds);
		context.assertExclusive();
		context.audit({
			action: "inbox_maintenance_intent",
			id: event.channel,
			revision: 0,
			actor: event.user,
			note: "terminal archive; dedupe horizon applies",
		});
		const result = inbox.maintain(Date.now(), event.channel);
		context.audit({
			action: "inbox_maintenance_applied",
			id: event.channel,
			revision: 0,
			actor: event.user,
			note: JSON.stringify(result),
		});
		return { response: JSON.stringify(result) };
	}
	if (action === "operations" || action.startsWith("op-")) {
		const journal = context.operations;
		if (!journal) throw new Error("Operation journal unavailable");
		const visible = (record: OperationRecord) => record.scope.startsWith(`notification:${event.channel}:`);
		const authorize = (record: OperationRecord) =>
			assertControlAuthorized(event, record.ownerUserId, context.adminUserIds);
		const describe = (record: OperationRecord) =>
			`operation ID=${record.id} version=${record.revision ?? 0} source=${record.scope} status=${record.status}\n失败阶段/详情：${record.detail ?? "未记录"}\n可能副作用：通知可能已投递；重试可能重复。`;
		if (action === "operations") {
			const records = journal
				.list()
				.filter((record) => visible(record) && ["unknown", "manual", "started"].includes(record.status));
			for (const record of records) authorize(record);
			return { response: records.map(describe).join("\n\n") || "本频道没有未决外部操作" };
		}
		const record = id ? journal.get(id) : undefined;
		if (!record || !visible(record)) throw new Error("操作不存在或超出频道边界");
		authorize(record);
		if (action === "op-show") return { response: describe(record) };
		const revision = Number(version);
		if (
			!Number.isSafeInteger(revision) ||
			record.revision !== revision ||
			!["unknown", "manual", "started"].includes(record.status)
		)
			throw new Error("状态版本已变化或无需核对");
		if (!["op-resolve", "op-retry"].includes(action)) throw new Error("未知操作处置命令");
		if (action === "op-retry") {
			assertExecutionAuthorized(event, record.ownerUserId, context.trustedUserIds, context.adminUserIds);
			if (rest.shift() !== "ACK_DUPLICATE_RISK") throw new Error("重试必须显式承担重复副作用风险");
		}
		const note = rest.join(" ");
		if (!note.trim() || note.length > 2000) throw new Error("必须提供核对说明");
		context.assertExclusive();
		context.audit({ action: `${action}_intent`, id: record.id, revision, actor: event.user, note });
		if (journal.get(record.id)?.revision !== revision) throw new Error("状态版本已变化");
		const next =
			action === "op-resolve"
				? journal.resolveManually(record.id, { noReplay: true, operator: event.user, note })
				: journal.retryManually(record.id, revision);
		context.audit({
			action: `${action}_applied`,
			id: next.id,
			revision: next.revision ?? 0,
			actor: event.user,
			note,
		});
		return {
			response: action === "op-resolve" ? "已核对外部操作，不重放" : "已明确授权重复风险后的通知重试",
			...(action === "op-retry" ? { operationRetry: next } : {}),
		};
	}
	if (action === "list") {
		const records = inbox
			.list()
			.filter((r) => r.event.channel === event.channel && ["unknown", "dead"].includes(r.status));
		for (const r of records) assertControlAuthorized(event, r.event.user, context.adminUserIds);
		return { response: records.map(summary).join("\n\n") || "本频道没有 unknown/dead 记录" };
	}
	if (!id)
		throw new Error(
			"用法：/recover show <ID>；/recover resolve <ID> <version> <核对说明>；/recover retry <ID> <version> ACK_DUPLICATE_RISK <说明>",
		);
	const record = inbox.get(id);
	if (!record || record.event.channel !== event.channel) throw new Error("记录不存在或超出频道边界");
	assertControlAuthorized(event, record.event.user, context.adminUserIds);
	if (action === "show") return { response: summary(record) };
	if (!["resolve", "retry"].includes(action)) throw new Error("未知处置命令");
	const revision = Number(version);
	if (!Number.isSafeInteger(revision) || revision !== (record.revision ?? 0))
		throw new Error("状态版本已变化，先重新查询核对");
	if (!["unknown", "dead"].includes(record.status)) throw new Error("记录不再等待人工处置");
	if (action === "retry") {
		assertExecutionAuthorized(event, record.event.user, context.trustedUserIds, context.adminUserIds);
		if (rest.shift() !== "ACK_DUPLICATE_RISK") throw new Error("重试必须显式承担重复副作用风险：ACK_DUPLICATE_RISK");
	}
	const note = rest.join(" ");
	if (!note.trim() || note.length > 2000) throw new Error("必须提供1到2000字符核对说明");
	context.assertExclusive();
	context.audit({ action: `${action}_intent`, id, revision, actor: event.user, note });
	if ((inbox.get(id)?.revision ?? 0) !== revision) throw new Error("状态版本已变化，拒绝处置");
	if (action === "resolve") inbox.finish(id, "completed", `人工核对，不重放：${note}`);
	else inbox.retry(id, true);
	context.audit({ action: `${action}_applied`, id, revision: inbox.get(id)!.revision ?? 0, actor: event.user, note });
	return {
		response: action === "resolve" ? "已核对并标记处理，不重放操作" : "已记录重复风险确认，等待频道安全恢复后重试",
		...(action === "retry" ? { retry: inbox.get(id) } : {}),
	};
}
