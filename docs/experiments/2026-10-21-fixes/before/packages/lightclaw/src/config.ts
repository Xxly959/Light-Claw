export type TransportKind = "feishu" | "slack";

export interface LightClawConfig {
	transport: TransportKind;
	modelProvider: string;
	modelId: string;
	openaiBaseUrl?: string;
	promptInstructions?: string;
	controlDir?: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LightClawConfig {
	const transportValue = env.LIGHTCLAW_TRANSPORT?.trim().toLowerCase() || "feishu";
	if (transportValue !== "feishu" && transportValue !== "slack") {
		throw new Error("LIGHTCLAW_TRANSPORT 只支持 feishu 或 slack");
	}
	const transport: TransportKind = transportValue;
	if (env.LIGHTCLAW_CONTROL_DIR !== undefined && !env.LIGHTCLAW_CONTROL_DIR.trim())
		throw new Error("LIGHTCLAW_CONTROL_DIR 不能为空");

	const base = {
		transport,
		controlDir: env.LIGHTCLAW_CONTROL_DIR?.trim(),
		modelProvider: env.LIGHTCLAW_MODEL_PROVIDER?.trim() || "zai",
		modelId: env.LIGHTCLAW_MODEL_ID?.trim() || "glm-5.3-flash",
		openaiBaseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
		promptInstructions: env.LIGHTCLAW_PROMPT_INSTRUCTIONS?.trim() || undefined,
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

	if (transport === "feishu") {
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
