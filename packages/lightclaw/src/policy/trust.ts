/**
 * 来源信任定级。
 *
 * 不做内容意图识别（不可靠），只回答一个问题：这次 run 的触发者是否在可信名单内。
 * 名单为空时保持兼容，全部视为可信；一旦配置，名单外用户触发的 run 走能力降级。
 */

import type { ChatEventOrigin } from "../transport.js";

export type TrustLevel = "trusted" | "untrusted";

export interface TrustInput {
	origin: ChatEventOrigin;
	user: string;
	trustedUserIds: readonly string[];
}

export function resolveTrust(input: TrustInput): TrustLevel {
	// Scheduling/recovery/continuation retain the originating actor, never grant trust by entry point.
	// 未配置名单：保持加固前行为。是否开启降级由部署方显式决定。
	if (input.trustedUserIds.length === 0) return "trusted";
	return input.trustedUserIds.includes(input.user.trim()) ? "trusted" : "untrusted";
}

/** 降级判定：不可信来源下的执行、外发与写入能力需要人工确认。 */
export function requiresApprovalUnderTrust(toolCapabilities: readonly string[], trust: TrustLevel): boolean {
	if (trust === "trusted") return false;
	return toolCapabilities.some(
		(capability) => capability === "exec" || capability === "upload" || capability === "fs:write",
	);
}
