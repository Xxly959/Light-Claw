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
