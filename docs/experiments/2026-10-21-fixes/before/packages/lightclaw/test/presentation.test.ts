import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { formatRunError, splitAssistantContent } from "../src/presentation.js";

describe("消息展示", () => {
	it("不会把模型推理内容当成用户回答", () => {
		const content: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "内部推理", thinkingSignature: "" },
			{ type: "text", text: "最终回答" },
		];
		expect(splitAssistantContent(content)).toEqual({ text: "最终回答", thinking: ["内部推理"] });
	});

	it("目标完成后不让网关错误覆盖成功结果", () => {
		const result = formatRunError("401 server_login_retry", true);
		expect(result.message).toContain("目标已完成");
		expect(result.detail).toBeUndefined();
	});

	it("普通失败仍保留可诊断详情", () => {
		const result = formatRunError("401 unauthorized", false);
		expect(result.detail).toBe("401 unauthorized");
	});
});
