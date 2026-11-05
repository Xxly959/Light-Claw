/**
 * 工具能力表与频道授权策略。
 *
 * 能力由代码声明，不由模型自述；裁决只在这里给出的集合上做判断。
 */

export type ToolCapability = "fs:read" | "fs:write" | "exec" | "upload" | "goal:control";

export const ALL_CAPABILITIES: readonly ToolCapability[] = ["fs:read", "fs:write", "exec", "upload", "goal:control"];

/** 工具名到能力的映射。未登记的工具在裁决阶段直接拒绝。 */
export const TOOL_CAPABILITIES: Readonly<Record<string, readonly ToolCapability[]>> = {
	read: ["fs:read"],
	write: ["fs:write"],
	edit: ["fs:write", "fs:read"],
	bash: ["exec"],
	attach: ["upload", "fs:read"],
	goal_progress: ["goal:control"],
	goal_complete: ["goal:control"],
};

const registry = new Map<string, readonly ToolCapability[]>(Object.entries(TOOL_CAPABILITIES));

/** 扩展工具在创建时注册能力；未注册的工具一律拒绝，避免 fail-open。 */
export function registerToolCapabilities(toolName: string, capabilities: readonly ToolCapability[]): void {
	registry.set(toolName, [...capabilities]);
}

export type ApprovalMode = "off" | "always";

export interface ChannelGrant {
	readonly caps: readonly ToolCapability[];
	readonly approval: ApprovalMode;
}

export interface PolicySet {
	readonly defaultGrant: ChannelGrant;
	readonly profiles: Readonly<Record<string, ChannelGrant>>;
	readonly channelProfiles: Readonly<Record<string, string>>;
}

/** 缺省授权：全部能力、按危险规则审批。与加固前行为一致。 */
export const FULL_GRANT: ChannelGrant = { caps: ALL_CAPABILITIES, approval: "off" };

export function capabilitiesFor(toolName: string): readonly ToolCapability[] {
	return registry.get(toolName) ?? [];
}

function parseGrant(value: unknown, name: string): ChannelGrant {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`策略 ${name} 必须是对象`);
	const record = value as Record<string, unknown>;
	const caps = record.caps ?? ALL_CAPABILITIES;
	if (!Array.isArray(caps)) throw new Error(`策略 ${name}.caps 必须是数组`);
	const parsed: ToolCapability[] = [];
	for (const item of caps) {
		if (!ALL_CAPABILITIES.includes(item as ToolCapability))
			throw new Error(`策略 ${name}.caps 含未知能力：${String(item)}`);
		if (!parsed.includes(item as ToolCapability)) parsed.push(item as ToolCapability);
	}
	const approval = record.approval ?? "off";
	if (approval !== "off" && approval !== "always") throw new Error(`策略 ${name}.approval 只能是 off 或 always`);
	return { caps: parsed, approval };
}

function parseJsonObject(value: string | undefined, name: string): Record<string, unknown> | undefined {
	if (value === undefined || !value.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error(`${name} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} 必须是 JSON 对象`);
	return parsed as Record<string, unknown>;
}

/**
 * 解析 `LIGHTCLAW_CHANNEL_POLICY_JSON` 与 `LIGHTCLAW_CHANNEL_POLICY_MAP_JSON`。
 * 两个变量都缺省时返回全量授权，保证升级不改变既有部署行为。
 */
export function loadPolicySet(policyJson?: string, mapJson?: string): PolicySet {
	const profilesInput = parseJsonObject(policyJson, "LIGHTCLAW_CHANNEL_POLICY_JSON");
	const mapInput = parseJsonObject(mapJson, "LIGHTCLAW_CHANNEL_POLICY_MAP_JSON");

	const profiles: Record<string, ChannelGrant> = {};
	if (profilesInput) {
		for (const [name, grant] of Object.entries(profilesInput)) {
			if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error(`策略名非法：${name}`);
			profiles[name] = parseGrant(grant, name);
		}
	}

	const channelProfiles: Record<string, string> = {};
	if (mapInput) {
		for (const [channelId, profileName] of Object.entries(mapInput)) {
			if (typeof profileName !== "string" || !profiles[profileName])
				throw new Error(`频道 ${channelId} 指向未知策略：${String(profileName)}`);
			channelProfiles[channelId] = profileName;
		}
	}

	const defaultGrant = profiles.default ?? FULL_GRANT;
	return { defaultGrant, profiles, channelProfiles };
}

export function grantForChannel(policy: PolicySet, channelId: string): ChannelGrant {
	const profileName = policy.channelProfiles[channelId];
	if (!profileName) return policy.defaultGrant;
	return policy.profiles[profileName] ?? policy.defaultGrant;
}

export function missingCapabilities(
	grant: ChannelGrant,
	required: readonly ToolCapability[],
): readonly ToolCapability[] {
	return required.filter((capability) => !grant.caps.includes(capability));
}
