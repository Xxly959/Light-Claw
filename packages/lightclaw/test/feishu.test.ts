import * as Lark from "@larksuiteoapi/node-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeishuHttpClient, stripAtTags, textOfContent } from "../src/feishu.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("飞书消息解析", () => {
	it("binds HTTP deadlines per client without changing SDK global defaults", async () => {
		const defaultTimeout = Lark.defaultHttpInstance.defaults.timeout;
		const request = vi.spyOn(Lark.defaultHttpInstance, "request").mockResolvedValue({ code: 0 });
		const first = createFeishuHttpClient(50);
		const second = createFeishuHttpClient(100);
		expect(await first.request({ url: "/first", timeout: 999 })).toEqual({ code: 0 });
		await second.post("/second", { text: "test" }, { headers: { "x-test": "test" } });
		expect(request.mock.calls[0]?.[0]).toMatchObject({ url: "/first", timeout: 50 });
		expect(request.mock.calls[1]?.[0]).toMatchObject({
			url: "/second",
			method: "POST",
			data: { text: "test" },
			timeout: 100,
			headers: { "x-test": "test" },
		});
		expect(Lark.defaultHttpInstance.defaults.timeout).toBe(defaultTimeout);
	});
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
