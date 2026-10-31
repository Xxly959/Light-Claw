import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("LightClaw 配置", () => {
	it.each([
		["LIGHTCLAW_RUN_MAX_DURATION_MS", "2147483648"],
		["LIGHTCLAW_BASH_TIMEOUT_SECONDS", "2147484"],
		["LIGHTCLAW_RUN_MAX_TOOL_CALLS", "9007199254740992"],
		["LIGHTCLAW_RUN_MAX_TOKENS", "9007199254740992"],
		["LIGHTCLAW_QUEUE_MAX_PENDING", "9007199254740992"],
		["LIGHTCLAW_QUEUE_MAX_WAIT_MS", "2147483648"],
		["LIGHTCLAW_CHANNEL_CACHE_MAX_ENTRIES", "9007199254740992"],
		["LIGHTCLAW_CHANNEL_CACHE_IDLE_TTL_MS", "2147483648"],
	])("拒绝溢出的预算 %s", (name, value) => {
		expect(() =>
			loadConfig({ LIGHTCLAW_FEISHU_APP_ID: "app", LIGHTCLAW_FEISHU_APP_SECRET: "secret", [name]: value }),
		).toThrow(name);
	});
	it("提供并允许覆盖单轮和投递预算", () => {
		const credentials = { LIGHTCLAW_FEISHU_APP_ID: "app", LIGHTCLAW_FEISHU_APP_SECRET: "secret" };
		expect(loadConfig(credentials)).toMatchObject({
			maxRunDurationMs: 300000,
			maxRunToolCalls: 100,
			maxRunTokens: 100000,
			bashTimeoutSeconds: 120,
			platformTimeoutMs: 30000,
			queueMaxPending: 5,
			queueMaxWaitMs: 300000,
			channelCacheMaxEntries: 128,
			channelCacheIdleTtlMs: 900000,
		});
		expect(
			loadConfig({
				...credentials,
				LIGHTCLAW_RUN_MAX_DURATION_MS: "1000",
				LIGHTCLAW_RUN_MAX_TOOL_CALLS: "2",
				LIGHTCLAW_RUN_MAX_TOKENS: "400",
				LIGHTCLAW_BASH_TIMEOUT_SECONDS: "3",
				LIGHTCLAW_PLATFORM_TIMEOUT_MS: "50",
				LIGHTCLAW_QUEUE_MAX_PENDING: "2",
				LIGHTCLAW_QUEUE_MAX_WAIT_MS: "80",
				LIGHTCLAW_CHANNEL_CACHE_MAX_ENTRIES: "4",
				LIGHTCLAW_CHANNEL_CACHE_IDLE_TTL_MS: "60000",
			}),
		).toMatchObject({
			maxRunDurationMs: 1000,
			maxRunToolCalls: 2,
			maxRunTokens: 400,
			bashTimeoutSeconds: 3,
			platformTimeoutMs: 50,
			queueMaxPending: 2,
			queueMaxWaitMs: 80,
			channelCacheMaxEntries: 4,
			channelCacheIdleTtlMs: 60000,
		});
	});
	it.each(["0", "-1", "0.5", "", " ", "NaN", "Infinity", "2147483648"])("拒绝非法投递期限 %s", (value) => {
		expect(() =>
			loadConfig({
				LIGHTCLAW_FEISHU_APP_ID: "app",
				LIGHTCLAW_FEISHU_APP_SECRET: "secret",
				LIGHTCLAW_PLATFORM_TIMEOUT_MS: value,
			}),
		).toThrow("LIGHTCLAW_PLATFORM_TIMEOUT_MS");
	});
	it("默认使用飞书和轻量目标限制", () => {
		const config = loadConfig({ LIGHTCLAW_FEISHU_APP_ID: "app", LIGHTCLAW_FEISHU_APP_SECRET: "secret" });
		expect(config.transport).toBe("feishu");
		expect(config.modelProvider).toBe("zai");
		expect(config.maxGoalCycles).toBe(8);
	});

	it("支持 Slack 和自定义模型", () => {
		const config = loadConfig({
			LIGHTCLAW_TRANSPORT: "slack",
			LIGHTCLAW_SLACK_APP_TOKEN: "app-token",
			LIGHTCLAW_SLACK_BOT_TOKEN: "bot-token",
			LIGHTCLAW_MODEL_PROVIDER: "deepseek",
			LIGHTCLAW_MODEL_ID: "deepseek-chat",
			OPENAI_BASE_URL: "https://example.com/v1",
			LIGHTCLAW_PROMPT_INSTRUCTIONS: "先验证，再回答",
		});
		expect(config.slack?.botToken).toBe("bot-token");
		expect(config.modelId).toBe("deepseek-chat");
		expect(config.openaiBaseUrl).toBe("https://example.com/v1");
		expect(config.promptInstructions).toBe("先验证，再回答");
	});

	it("拒绝缺少凭证或非法轮次", () => {
		expect(() => loadConfig({ LIGHTCLAW_TRANSPORT: "slack" })).toThrow("LIGHTCLAW_SLACK_APP_TOKEN");
		expect(() =>
			loadConfig({
				LIGHTCLAW_FEISHU_APP_ID: "app",
				LIGHTCLAW_FEISHU_APP_SECRET: "secret",
				LIGHTCLAW_GOAL_MAX_CYCLES: "0",
			}),
		).toThrow("正整数");
	});
});

it("validates the optional control directory", () => {
	const credentials = { LIGHTCLAW_FEISHU_APP_ID: "app", LIGHTCLAW_FEISHU_APP_SECRET: "secret" };
	expect(loadConfig({ ...credentials, LIGHTCLAW_CONTROL_DIR: "/tmp/control" }).controlDir).toBe("/tmp/control");
	expect(() => loadConfig({ ...credentials, LIGHTCLAW_CONTROL_DIR: " " })).toThrow("LIGHTCLAW_CONTROL_DIR");
});
