import { describe, expect, it } from "vitest";
import { stripAtTags, textOfContent } from "../src/feishu.js";

describe("飞书消息解析", () => {
	it("解析文本和富文本消息", () => {
		expect(textOfContent("text", JSON.stringify({ text: "你好" }))).toBe("你好");
		expect(textOfContent("post", JSON.stringify({ zh_cn: { content: [[{ tag: "text", text: "执行任务" }]] } }))).toBe(
			"执行任务",
		);
	});

	it("移除机器人提及并容忍非法内容", () => {
		expect(stripAtTags('<at user_id="ou_bot">LightClaw</at> 检查代码')).toBe("检查代码");
		expect(textOfContent("text", "not-json")).toBe("");
		expect(textOfContent("image", "{}")).toBe("");
	});
});
