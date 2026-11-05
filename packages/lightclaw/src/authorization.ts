import type { ChatActor } from "./transport.js";

export class ControlAuthorizationError extends Error {}

/** Personal-agent control boundary; synthetic execution identities never grant platform authority. */
export function assertControlAuthorized(
	actor: ChatActor,
	ownerUserId: string | undefined,
	adminUserIds: readonly string[] = [],
): void {
	if (
		actor.origin !== "platform" ||
		!actor.user.trim() ||
		(actor.user !== ownerUserId && !adminUserIds.includes(actor.user))
	) {
		throw new ControlAuthorizationError("无权限控制此任务；仅创建者或配置的管理员可操作");
	}
}

/** Execution authority is independent of requesting/owning a task when a trusted list is enabled. */
export function assertExecutionAuthorized(
	actor: ChatActor,
	creator: string | undefined,
	trustedUserIds: readonly string[] = [],
	adminUserIds: readonly string[] = [],
): void {
	if (
		actor.origin !== "platform" ||
		!actor.user.trim() ||
		!(
			adminUserIds.includes(actor.user) ||
			(trustedUserIds.length ? trustedUserIds.includes(actor.user) : actor.user === creator)
		)
	)
		throw new ControlAuthorizationError("无权限批准执行；可信名单启用时仅可信用户或管理员可批准");
}
