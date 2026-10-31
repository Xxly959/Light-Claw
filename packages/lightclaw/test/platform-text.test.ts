import { expect, it } from "vitest";
import { fitPlatformText } from "../src/platform-text.js";

it("bounds escaped Unicode Feishu previews by serialized UTF-8 bytes without breaking code points", () => {
	const value = '中文😀"\\\n'.repeat(10_000),
		preview = fitPlatformText(value, "feishu");
	expect(Buffer.byteLength(JSON.stringify({ text: preview }))).toBeLessThanOrEqual(18_000);
	expect(preview).toContain("消息已截断");
	expect(preview).not.toContain("\ufffd");
});
it("preserves normal text and reserves room under Slack's character ceiling", () => {
	expect(fitPlatformText("正常回复", "slack")).toBe("正常回复");
	const text = fitPlatformText("x".repeat(50_000), "slack");
	expect(text.length).toBeLessThanOrEqual(35_000);
	expect(text).toContain("消息已截断");
});
