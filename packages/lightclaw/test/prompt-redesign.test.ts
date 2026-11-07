import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import { expect, it } from "vitest";
import { loadConfigForDiagnostics } from "../src/config.js";
import { createPromptRewriter } from "../src/prompt-input.js";
import { parseRewrite, validateProtectedLiterals } from "../src/prompt-rewrite.js";

const result = (prompt: string) => ({
	taskType: "analysis",
	prompt,
	changes: ["明确输出要求"],
	assumptions: [],
	openQuestions: [],
});
it("keeps user material separate from structured suggestions and an independent review", async () => {
	const faux = registerFauxProvider();
	const input = "比较两个方案";
	faux.setResponses([
		(ctx) => {
			expect(ctx.tools ?? []).toEqual([]);
			const payload = JSON.parse(String(ctx.messages[0].content));
			expect(payload.user_input).toBe(input);
			expect(payload.target.tools).toContain("read");
			expect(payload.target.webSearch).toBe("unverified");
			expect(payload.context).toBeNull();
			return fauxAssistantMessage(JSON.stringify(result("请比较两个方案的适用条件与差异，说明判断依据。")));
		},
		(ctx) => {
			expect(ctx.tools ?? []).toEqual([]);
			expect(ctx.messages).toHaveLength(1);
			const payload = JSON.parse(String(ctx.messages[0].content));
			expect(payload.original).toBe(input);
			expect(payload.candidate.prompt).toContain("适用条件");
			return fauxAssistantMessage('{"accepted":true,"issues":[]}');
		},
	]);
	try {
		const rewrite = createPromptRewriter(loadConfigForDiagnostics({}), {
			model: faux.getModel(),
			apiKey: "fictional",
		});
		expect(await rewrite(input, new AbortController().signal)).toEqual(
			result("请比较两个方案的适用条件与差异，说明判断依据。"),
		);
		expect(faux.state.callCount).toBe(2);
	} finally {
		faux.unregister();
	}
});
it("rejects semantic review failures instead of publishing an unchecked candidate", async () => {
	const faux = registerFauxProvider();
	faux.setResponses([
		fauxAssistantMessage(JSON.stringify(result("修改并部署"))),
		fauxAssistantMessage('{"accepted":false,"issues":["将询问升级为部署授权"]}'),
	]);
	try {
		const rewrite = createPromptRewriter(loadConfigForDiagnostics({}), {
			model: faux.getModel(),
			apiKey: "fictional",
		});
		await expect(rewrite("看看怎么修改", new AbortController().signal)).rejects.toThrow(/复核/);
	} finally {
		faux.unregister();
	}
});
it("validates the complete bounded schema without accepting task answers or extra keys", () => {
	expect(parseRewrite(JSON.stringify(result("task")))).toEqual(result("task"));
	for (const value of [
		{ ...result("task"), surprise: "execute" },
		{ ...result("task"), changes: "explanation" },
		{ ...result("task"), prompt: " " },
		{ ...result("task"), openQuestions: ["x".repeat(501)] },
	])
		expect(() => parseRewrite(JSON.stringify(value))).toThrow();
});
it.each([
	["保留 {{user_id}} 和 /tmp/a.txt", "保留 {{user}} 和 /tmp/a.txt"],
	["读取 `foo(1)`，最多 20 字", "读取 `foo(2)`，最多 200 字"],
	["参考 https://example.invalid/a?q=1", "参考 https://example.invalid/b?q=1"],
	["原样引用：\n```js\nconst x = 1;\n```", "原样引用：\n```js\nconst x = 2;\n```"],
])("rejects lost literals: %s", (original, changed) => {
	expect(() => validateProtectedLiterals(original, changed)).toThrow(/保留/);
	expect(() => validateProtectedLiterals(original, original)).not.toThrow();
});

it("stops after literal loss without requesting a semantic review", async () => {
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage(JSON.stringify(result("请读取 /tmp/b.txt，最多200字")))]);
	try {
		const rewrite = createPromptRewriter(loadConfigForDiagnostics({}), {
			model: faux.getModel(),
			apiKey: "fictional",
		});
		await expect(rewrite("请读取 /tmp/a.txt，最多20字", new AbortController().signal)).rejects.toThrow(/保留/);
		expect(faux.state.callCount).toBe(1);
	} finally {
		faux.unregister();
	}
});
it("never returns a candidate when cancellation happens during independent review", async () => {
	const faux = registerFauxProvider();
	const controller = new AbortController();
	faux.setResponses([
		fauxAssistantMessage(JSON.stringify(result("task"))),
		() => {
			controller.abort();
			return fauxAssistantMessage('{"accepted":true,"issues":[]}');
		},
	]);
	try {
		const rewrite = createPromptRewriter(loadConfigForDiagnostics({}), {
			model: faux.getModel(),
			apiKey: "fictional",
		});
		await expect(rewrite("task", controller.signal)).rejects.toThrow();
		expect(faux.state.callCount).toBe(2);
	} finally {
		faux.unregister();
	}
});
