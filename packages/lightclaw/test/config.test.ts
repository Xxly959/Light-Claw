import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("LightClaw 配置", () => {
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
		});
		expect(config.slack?.botToken).toBe("bot-token");
		expect(config.modelId).toBe("deepseek-chat");
		expect(config.openaiBaseUrl).toBe("https://example.com/v1");
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
