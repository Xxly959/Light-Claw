export { featureEnabled } from "./features.js";

export type TransportKind = "feishu" | "slack";

export interface LightClawFeatures {
	goals: boolean;
	acceptance: boolean;
	feishu: boolean;
	controls: boolean;
	scheduling: boolean;
	optimization: boolean;
	infrastructure: boolean;
}

function loadFeatures(env: NodeJS.ProcessEnv): LightClawFeatures {
	const flag = (name: string): boolean => {
		const value = env[`LIGHTCLAW_FEATURE_${name}`]?.trim().toLowerCase();
		if (value === undefined || value === "true") return true;
		if (value === "false") return false;
		throw new Error(`LIGHTCLAW_FEATURE_${name} 必须是 true 或 false`);
	};
	return {
		goals: flag("GOALS"),
		acceptance: flag("ACCEPTANCE"),
		feishu: flag("FEISHU"),
		controls: flag("CONTROLS"),
		scheduling: flag("SCHEDULING"),
		optimization: flag("OPTIMIZATION"),
		infrastructure: flag("INFRASTRUCTURE"),
	};
}

export interface ModelFallback {
	provider: string;
	id: string;
}

export interface LightClawConfig {
	features?: Partial<LightClawFeatures>;
	transport: TransportKind;
	modelProvider: string;
	modelId: string;
	modelFallbacks?: ModelFallback[];
	openaiBaseUrl?: string;
	promptInstructions?: string;
	controlDir?: string;
	controlAdminUserIds?: string[];
	/** 可信用户名单；为空时所有平台来源视为可信，保持加固前行为。 */
	trustedUserIds?: string[];
	/** 频道能力策略；两个变量都缺省时授予全部能力。 */
	channelPolicyJson?: string;
	channelPolicyMapJson?: string;
	approvalTtlMs?: number;
	goalConfirmationTtlMs?: number;
	modelAttemptTimeoutMs?: number;
	scheduleMisfireMaxLatenessMs?: number;
	/** enforce 走裁决；off 为应急回滚开关，全部放行但仍写审计摘要。 */
	policyMode?: "enforce" | "off";
	auditPayloadMode?: "off" | "digest" | "full";
	/** 频道到专属容器名的映射；配置后该频道只挂自己的目录。 */
	channelContainers?: Record<string, string>;
	/** 频道没有专属容器时：shared 用共享容器，deny 拒绝执行。 */
	sandboxFallback?: "shared" | "deny";
	maxGoalCycles: number;
	maxGoalFailures: number;
	maxStaleCycles: number;
	maxRunDurationMs?: number;
	maxRunToolCalls?: number;
	maxRunTokens?: number;
	bashTimeoutSeconds?: number;
	platformTimeoutMs?: number;
	queueMaxPending?: number;
	queueMaxWaitMs?: number;
	channelCacheMaxEntries?: number;
	channelCacheIdleTtlMs?: number;
	feishu?: { appId: string; appSecret: string };
	slack?: { appToken: string; botToken: string };
}

function splitList(value: string | undefined): string[] {
	return [
		...new Set(
			(value ?? "")
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];
}

/** 形如 `provider/model,provider/model`；模型 ID 自身可含斜杠。 */
function parseModelFallbacks(value: string | undefined): ModelFallback[] {
	return splitList(value).map((entry) => {
		const separator = entry.indexOf("/");
		if (separator <= 0 || separator === entry.length - 1)
			throw new Error(`LIGHTCLAW_MODEL_FALLBACKS 条目必须是 provider/model：${entry}`);
		return { provider: entry.slice(0, separator), id: entry.slice(separator + 1) };
	});
}

function parseEnum<T extends string>(value: string | undefined, allowed: readonly T[], name: string, fallback: T): T {
	const normalized = value?.trim().toLowerCase();
	if (normalized === undefined || normalized === "") return fallback;
	if (!allowed.includes(normalized as T)) throw new Error(`${name} 只能是 ${allowed.join("、")}`);
	return normalized as T;
}

/** 频道到专属容器名的映射。非法项在启动时失败，避免静默退化为共享容器。 */
function parseChannelContainers(value: string | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	if (value === undefined || !value.trim()) return result;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error(
			`LIGHTCLAW_CHANNEL_CONTAINERS_JSON 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("LIGHTCLAW_CHANNEL_CONTAINERS_JSON 必须是 JSON 对象");
	for (const [channelId, container] of Object.entries(parsed as Record<string, unknown>)) {
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(channelId)) throw new Error(`频道容器映射含非法频道 ID：${channelId}`);
		if (typeof container !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container))
			throw new Error(`频道 ${channelId} 的容器名非法`);
		result[channelId] = container;
	}
	return result;
}

function positiveInteger(
	value: string | undefined,
	fallback: number,
	name: string,
	maximum = Number.MAX_SAFE_INTEGER,
): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
		throw new Error(`${name} 必须是 1 到 ${maximum} 之间的正整数`);
	}
	return parsed;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`缺少环境变量：${name}`);
	return value;
}

/**
 * 只加载非凭证配置。供 `--isolation-report` 使用：评审场景通常没有平台凭证，
 * 但隔离等级与策略状态仍然可以完整读出。
 */
export function loadConfigForDiagnostics(env: NodeJS.ProcessEnv = process.env): LightClawConfig {
	return loadBase(env);
}

function loadBase(env: NodeJS.ProcessEnv = process.env): LightClawConfig {
	const transportValue = env.LIGHTCLAW_TRANSPORT?.trim().toLowerCase() || "feishu";
	if (transportValue !== "feishu" && transportValue !== "slack") {
		throw new Error("LIGHTCLAW_TRANSPORT 只支持 feishu 或 slack");
	}
	const features = loadFeatures(env);
	const transport: TransportKind = features.feishu ? transportValue : "slack";
	if (env.LIGHTCLAW_CONTROL_DIR !== undefined && !env.LIGHTCLAW_CONTROL_DIR.trim())
		throw new Error("LIGHTCLAW_CONTROL_DIR 不能为空");

	return {
		features,
		transport,
		controlDir: env.LIGHTCLAW_CONTROL_DIR?.trim(),
		controlAdminUserIds: [
			...new Set(
				(env.LIGHTCLAW_CONTROL_ADMIN_USER_IDS ?? "")
					.split(",")
					.map((id) => id.trim())
					.filter(Boolean),
			),
		],
		modelProvider: env.LIGHTCLAW_MODEL_PROVIDER?.trim() || "zai",
		modelId: env.LIGHTCLAW_MODEL_ID?.trim() || "glm-5.3-flash",
		modelFallbacks: parseModelFallbacks(env.LIGHTCLAW_MODEL_FALLBACKS),
		openaiBaseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
		promptInstructions: env.LIGHTCLAW_PROMPT_INSTRUCTIONS?.trim() || undefined,
		trustedUserIds: splitList(env.LIGHTCLAW_TRUSTED_USER_IDS),
		channelContainers: parseChannelContainers(env.LIGHTCLAW_CHANNEL_CONTAINERS_JSON),
		sandboxFallback: parseEnum(
			env.LIGHTCLAW_SANDBOX_FALLBACK,
			["shared", "deny"] as const,
			"LIGHTCLAW_SANDBOX_FALLBACK",
			"shared",
		),
		channelPolicyJson: env.LIGHTCLAW_CHANNEL_POLICY_JSON?.trim() || undefined,
		channelPolicyMapJson: env.LIGHTCLAW_CHANNEL_POLICY_MAP_JSON?.trim() || undefined,
		scheduleMisfireMaxLatenessMs: positiveInteger(
			env.LIGHTCLAW_SCHEDULE_MISFIRE_MAX_LATENESS_MS,
			300_000,
			"LIGHTCLAW_SCHEDULE_MISFIRE_MAX_LATENESS_MS",
		),
		modelAttemptTimeoutMs: positiveInteger(
			env.LIGHTCLAW_MODEL_ATTEMPT_TIMEOUT_MS,
			120_000,
			"LIGHTCLAW_MODEL_ATTEMPT_TIMEOUT_MS",
			2_147_483_647,
		),
		goalConfirmationTtlMs: positiveInteger(
			env.LIGHTCLAW_GOAL_CONFIRMATION_TTL_MS,
			1_800_000,
			"LIGHTCLAW_GOAL_CONFIRMATION_TTL_MS",
			2_147_483_647,
		),
		approvalTtlMs: positiveInteger(
			env.LIGHTCLAW_APPROVAL_TTL_MS,
			1_800_000,
			"LIGHTCLAW_APPROVAL_TTL_MS",
			2_147_483_647,
		),
		policyMode: parseEnum(env.LIGHTCLAW_POLICY_MODE, ["enforce", "off"] as const, "LIGHTCLAW_POLICY_MODE", "enforce"),
		auditPayloadMode: parseEnum(
			env.LIGHTCLAW_AUDIT_PAYLOAD_MODE,
			["off", "digest", "full"] as const,
			"LIGHTCLAW_AUDIT_PAYLOAD_MODE",
			"digest",
		),
		maxGoalCycles: positiveInteger(env.LIGHTCLAW_GOAL_MAX_CYCLES, 8, "LIGHTCLAW_GOAL_MAX_CYCLES"),
		maxGoalFailures: positiveInteger(env.LIGHTCLAW_GOAL_MAX_FAILURES, 2, "LIGHTCLAW_GOAL_MAX_FAILURES"),
		maxStaleCycles: positiveInteger(env.LIGHTCLAW_GOAL_MAX_STALE_CYCLES, 2, "LIGHTCLAW_GOAL_MAX_STALE_CYCLES"),
		maxRunDurationMs: positiveInteger(
			env.LIGHTCLAW_RUN_MAX_DURATION_MS,
			300_000,
			"LIGHTCLAW_RUN_MAX_DURATION_MS",
			2_147_483_647,
		),
		maxRunToolCalls: positiveInteger(env.LIGHTCLAW_RUN_MAX_TOOL_CALLS, 100, "LIGHTCLAW_RUN_MAX_TOOL_CALLS"),
		maxRunTokens: positiveInteger(env.LIGHTCLAW_RUN_MAX_TOKENS, 100_000, "LIGHTCLAW_RUN_MAX_TOKENS"),
		queueMaxPending: positiveInteger(env.LIGHTCLAW_QUEUE_MAX_PENDING, 5, "LIGHTCLAW_QUEUE_MAX_PENDING"),
		channelCacheMaxEntries: positiveInteger(
			env.LIGHTCLAW_CHANNEL_CACHE_MAX_ENTRIES,
			128,
			"LIGHTCLAW_CHANNEL_CACHE_MAX_ENTRIES",
		),
		channelCacheIdleTtlMs: positiveInteger(
			env.LIGHTCLAW_CHANNEL_CACHE_IDLE_TTL_MS,
			900_000,
			"LIGHTCLAW_CHANNEL_CACHE_IDLE_TTL_MS",
			2_147_483_647,
		),
		queueMaxWaitMs: positiveInteger(
			env.LIGHTCLAW_QUEUE_MAX_WAIT_MS,
			300_000,
			"LIGHTCLAW_QUEUE_MAX_WAIT_MS",
			2_147_483_647,
		),
		bashTimeoutSeconds: positiveInteger(
			env.LIGHTCLAW_BASH_TIMEOUT_SECONDS,
			120,
			"LIGHTCLAW_BASH_TIMEOUT_SECONDS",
			2_147_483,
		),
		platformTimeoutMs: positiveInteger(
			env.LIGHTCLAW_PLATFORM_TIMEOUT_MS,
			30_000,
			"LIGHTCLAW_PLATFORM_TIMEOUT_MS",
			2_147_483_647,
		),
	};
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LightClawConfig {
	const base = loadBase(env);

	if (base.transport === "feishu") {
		return {
			...base,
			feishu: {
				appId: required(env, "LIGHTCLAW_FEISHU_APP_ID"),
				appSecret: required(env, "LIGHTCLAW_FEISHU_APP_SECRET"),
			},
		};
	}

	return {
		...base,
		slack: {
			appToken: required(env, "LIGHTCLAW_SLACK_APP_TOKEN"),
			botToken: required(env, "LIGHTCLAW_SLACK_BOT_TOKEN"),
		},
	};
}
