/**
 * 工具调用裁决。
 *
 * 判定顺序固定：能力缺失直接拒绝 -> 危险规则/信任降级/策略强制 -> 查一次性票据 -> 放行。
 * 任何一步都不依赖模型输出，只依赖工具名、参数与部署方配置。
 */

import { createHash } from "node:crypto";
import { type ApprovalTicket, signatureFor } from "./approvals.js";
import { type ChannelGrant, capabilitiesFor, missingCapabilities, type ToolCapability } from "./capabilities.js";
import { assessDanger } from "./danger.js";
import { requiresApprovalUnderTrust, type TrustLevel } from "./trust.js";

export type PolicyDecision = "allow" | "approve" | "deny";

export interface DecideInput {
	toolName: string;
	args: Record<string, unknown> | undefined;
	trust: TrustLevel;
	grant: ChannelGrant;
	channelId: string;
	/** 工具自声明能力；缺省时回落到注册表。 */
	capabilities?: readonly ToolCapability[];
	approvals?: { consume(signature: string): ApprovalTicket | undefined };
}

export interface DecisionResult {
	decision: PolicyDecision;
	reason: string;
	summary: string;
	signature: string;
	argsDigest: string;
	capabilities: readonly ToolCapability[];
	dangerReasons: readonly string[];
}

/** 参数摘要：稳定序列化后取 sha256，保证同样的调用得到同样的签名。 */
export function stableStringify(value: unknown, depth = 0): string {
	if (depth > 12) return '"[depth-limit]"';
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value !== "object") return "null";
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, depth + 1)).join(",")}]`;
	const record = value as Record<string, unknown>;
	const entries = Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], depth + 1)}`);
	return `{${entries.join(",")}}`;
}

export function digestArguments(args: Record<string, unknown> | undefined): string {
	return createHash("sha256")
		.update(stableStringify(args ?? {}))
		.digest("hex");
}

/** 策略强制审批只覆盖可能改变外部状态的写操作，避免 goal 控制被反复打断。 */
function forceApproval(grant: ChannelGrant, capabilities: readonly ToolCapability[]): boolean {
	if (grant.approval !== "always") return false;
	return capabilities.some(
		(capability) => capability === "fs:write" || capability === "exec" || capability === "upload",
	);
}

export function decideToolCall(input: DecideInput): DecisionResult {
	const capabilities = input.capabilities ?? capabilitiesFor(input.toolName);
	const argsDigest = digestArguments(input.args);
	const signature = signatureFor(input.channelId, input.toolName, argsDigest);
	const assessment = assessDanger(input.toolName, input.args);
	const base = {
		summary: assessment.summary,
		signature,
		argsDigest,
		capabilities,
		dangerReasons: assessment.reasons,
	};

	if (capabilities.length === 0) {
		return { ...base, decision: "deny", reason: `工具 ${input.toolName} 未登记能力，拒绝执行` };
	}

	const missing = missingCapabilities(input.grant, capabilities);
	if (missing.length > 0) {
		return {
			...base,
			decision: "deny",
			reason: `频道策略未授予能力：${missing.join(", ")}`,
		};
	}

	const reasons: string[] = [...assessment.reasons];
	if (requiresApprovalUnderTrust(capabilities, input.trust)) reasons.push("来源不可信，执行或外发需要确认");
	if (forceApproval(input.grant, capabilities)) reasons.push("频道策略要求每次确认");

	if (reasons.length === 0) {
		return { ...base, decision: "allow", reason: "符合频道策略" };
	}

	const ticket = input.approvals?.consume(signature);
	if (ticket) {
		return {
			...base,
			decision: "allow",
			reason: `已获批准（票据 ${ticket.id}，批准人 ${ticket.decidedBy ?? "unknown"}）`,
		};
	}

	return { ...base, decision: "approve", reason: reasons.join("；") };
}
