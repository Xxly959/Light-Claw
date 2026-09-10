export type TransportKind = "feishu" | "slack";

export interface LightClawConfig {
	transport: TransportKind;
	modelProvider: string;
	modelId: string;
	openaiBaseUrl?: string;
	promptInstructions?: string;
	maxGoalCycles: number;
	maxGoalFailures: number;
	maxStaleCycles: number;
	feishu?: { appId: string; appSecret: string };
	slack?: { appToken: string; botToken: string };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} 必须是正整数`);
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

	const base = {
		transport,
		modelProvider: env.LIGHTCLAW_MODEL_PROVIDER?.trim() || "zai",
		modelId: env.LIGHTCLAW_MODEL_ID?.trim() || "glm-5.3-flash",
		openaiBaseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
		promptInstructions: env.LIGHTCLAW_PROMPT_INSTRUCTIONS?.trim() || undefined,
		maxGoalCycles: positiveInteger(env.LIGHTCLAW_GOAL_MAX_CYCLES, 8, "LIGHTCLAW_GOAL_MAX_CYCLES"),
		maxGoalFailures: positiveInteger(env.LIGHTCLAW_GOAL_MAX_FAILURES, 2, "LIGHTCLAW_GOAL_MAX_FAILURES"),
		maxStaleCycles: positiveInteger(env.LIGHTCLAW_GOAL_MAX_STALE_CYCLES, 2, "LIGHTCLAW_GOAL_MAX_STALE_CYCLES"),
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
