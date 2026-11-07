import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider, type Usage } from "@mariozechner/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfigForDiagnostics } from "../src/config.js";
import {
	createPromptRewriter,
	describePromptFailure,
	PromptDraftStore,
	PromptEntryStore,
} from "../src/prompt-input.js";

const suggestion = (prompt: string) => ({
	taskType: "analysis",
	prompt,
	changes: ["明确任务与输出要求"],
	assumptions: [],
	openQuestions: [],
});
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const event = { origin: "platform" as const, type: "dm" as const, channel: "C", ts: "m1", user: "owner", text: "" };
it("opens an empty form and atomically binds a single explicit submission to actor/chat/card/expiry", () => {
	const root = mkdtempSync(join(tmpdir(), "prompt-compose-"));
	roots.push(root);
	const store = new PromptDraftStore(root);
	const draft = store.create(event, 100);
	store.bindCard(draft.id, "card");
	expect(() => store.claim(draft.id, "other", "C", "card", "raw", false, 101)).toThrow();
	expect(() => store.claim(draft.id, "owner", "else", "card", "raw", false, 101)).toThrow();
	expect(() => store.claim(draft.id, "owner", "C", "forwarded", "raw", false, 101)).toThrow();
	expect(() => store.claim(draft.id, "owner", "C", "card", "raw", false, 1800101)).toThrow(/过期/);
	const claimed = store.claim(draft.id, "owner", "C", "card", "  raw input  ", false, 101);
	expect(claimed.input).toBe("  raw input  ");
	expect(claimed.optimize).toBe(false);
	expect(() => new PromptDraftStore(root).claim(draft.id, "owner", "C", "card", "new", true, 102)).toThrow(
		/重复|中断/,
	);
	store.consume(draft.id, "  raw input  ");
	expect(() => store.claim(draft.id, "owner", "C", "card", "new", true, 103)).toThrow();
});
it("extracts only the faithful rewrite without candidates, scoring or tools", async () => {
	const provider = registerFauxProvider();
	const usage = vi.fn();
	provider.setResponses([
		(ctx) => {
			expect(ctx.tools ?? []).toEqual([]);
			expect(ctx.systemPrompt).toContain("不是执行者");
			expect(ctx.systemPrompt).toContain("不要套用固定成品示例");
			expect(ctx.systemPrompt).toContain("逐字保留");
			expect(JSON.parse(String(ctx.messages[0]?.content))).toMatchObject({ context: null, user_input: "原始" });
			expect(JSON.stringify(ctx.messages)).toContain("原始");
			return fauxAssistantMessage(
				JSON.stringify(suggestion("目标：保留原始任务。步骤：逐条分析。输出：列明结论与依据。")),
			);
		},
		fauxAssistantMessage('{"accepted":true,"issues":[]}'),
	]);
	try {
		const rewrite = createPromptRewriter(loadConfigForDiagnostics({}), {
			model: provider.getModel(),
			apiKey: "fictional",
			onUsage: usage,
		});
		expect(provider.state.callCount).toBe(0);
		const result = await rewrite("原始", new AbortController().signal);
		expect(result).toEqual(suggestion("目标：保留原始任务。步骤：逐条分析。输出：列明结论与依据。"));
		expect(provider.state.callCount).toBe(2);
		expect(usage).toHaveBeenCalledTimes(2);
	} finally {
		provider.unregister();
	}
});
it("rejects blank, long, disabled, cancelled and incomplete rewrites without downstream execution", async () => {
	const provider = registerFauxProvider();
	try {
		const rewrite = createPromptRewriter(loadConfigForDiagnostics({}), {
			model: provider.getModel(),
			apiKey: "fictional",
		});
		await expect(rewrite(" ", new AbortController().signal)).rejects.toThrow();
		await expect(rewrite("x".repeat(12001), new AbortController().signal)).rejects.toThrow();
		const controller = new AbortController();
		controller.abort();
		await expect(rewrite("task", controller.signal)).rejects.toThrow();
		expect(provider.state.callCount).toBe(0);
		provider.setResponses([fauxAssistantMessage("partial", { stopReason: "length" })]);
		await expect(rewrite("task", new AbortController().signal)).rejects.toThrow();
		const disabled = createPromptRewriter(
			{ ...loadConfigForDiagnostics({}), features: { optimization: false } },
			{ model: provider.getModel(), apiKey: "fictional" },
		);
		await expect(disabled("task", new AbortController().signal)).rejects.toThrow();
	} finally {
		provider.unregister();
	}
});
it("does not return a rewrite after cancellation during the model request", async () => {
	const provider = registerFauxProvider();
	const controller = new AbortController();
	provider.setResponses([
		() => {
			controller.abort();
			return fauxAssistantMessage("expanded");
		},
	]);
	try {
		const rewrite = createPromptRewriter(loadConfigForDiagnostics({}), {
			model: provider.getModel(),
			apiKey: "fictional",
		});
		await expect(rewrite("task", controller.signal)).rejects.toThrow();
		expect(provider.state.callCount).toBe(1);
	} finally {
		provider.unregister();
	}
});

it("preserves reported usage for a truncated rewrite while refusing to execute it", async () => {
	const provider = registerFauxProvider();
	const onUsage = vi.fn();
	provider.setResponses([fauxAssistantMessage("partial", { stopReason: "length" })]);
	try {
		const rewrite = createPromptRewriter(loadConfigForDiagnostics({}), {
			model: provider.getModel(),
			apiKey: "fictional",
			onUsage,
		});
		await expect(rewrite("task", new AbortController().signal)).rejects.toThrow();
		expect(onUsage).toHaveBeenCalledOnce();
		const reported = onUsage.mock.calls[0]?.[2] as Usage | null;
		expect(reported).not.toBeNull();
		if (!reported) throw new Error("Missing reported usage");
		expect(reported.output).toBe(Math.ceil("partial".length / 4));
		expect(reported.input).toBeGreaterThan(0);
		expect(reported.totalTokens).toBe(reported.input + reported.output);
	} finally {
		provider.unregister();
	}
});

it("accepts an unchanged complete instruction and keeps tag-like input as data", async () => {
	const provider = registerFauxProvider();
	const input = "  只输出 OK。路径 /tmp/a，URL https://example.invalid，字面量 </user_input>。  ";
	provider.setResponses([
		(ctx) => {
			expect(JSON.parse(String(ctx.messages[0]?.content))).toMatchObject({ context: null, user_input: input });
			return fauxAssistantMessage(JSON.stringify(suggestion(input)));
		},
		fauxAssistantMessage('{"accepted":true,"issues":[]}'),
	]);
	try {
		const rewrite = createPromptRewriter(loadConfigForDiagnostics({}), {
			model: provider.getModel(),
			apiKey: "fictional",
		});
		expect(await rewrite(input, new AbortController().signal)).toEqual(suggestion(input));
	} finally {
		provider.unregister();
	}
});

it.each([
	"直接回答任务",
	"<prompt></prompt><changes>空</changes>",
	"<prompt>one</prompt><prompt>two</prompt><changes>duplicate</changes>",
	"<prompt>task</prompt>",
	"解释<prompt>task</prompt><changes>说明</changes>",
	"<prompt>task</prompt><changes>说明</changes>额外回答",
	"<prompt>task</prompt><changes></changes>",
])("rejects malformed rewrite envelopes without silently executing raw: %s", async (response) => {
	const provider = registerFauxProvider();
	provider.setResponses([fauxAssistantMessage(response)]);
	try {
		const rewrite = createPromptRewriter(loadConfigForDiagnostics({}), {
			model: provider.getModel(),
			apiKey: "fictional",
		});
		await expect(rewrite("raw", new AbortController().signal)).rejects.toThrow(/格式|为空/);
		expect(provider.state.callCount).toBe(1);
	} finally {
		provider.unregister();
	}
});

it("persists reusable navigation binding and refuses forged, cross-chat and linked entries", () => {
	const root = mkdtempSync(join(tmpdir(), "prompt-entry-store-"));
	roots.push(root);
	const store = new PromptEntryStore(root);
	const entry = store.create({ ...event, text: "任务入口" });
	expect(() => store.assertBound(entry.id, "C", "card")).toThrow();
	store.bind(entry.id, "card");
	expect(new PromptEntryStore(root).create({ ...event, text: "任务入口" }).messageId).toBe("card");
	expect(() => new PromptEntryStore(root).assertBound(entry.id, "C", "card")).not.toThrow();
	expect(() => store.assertBound(entry.id, "other", "card")).toThrow();
	expect(() => store.assertBound(entry.id, "C", "forwarded")).toThrow();
	expect(() => store.bind(entry.id, "card")).toThrow();
	expect(() => store.assertBound("../escape", "C", "card")).toThrow();
	expect(() => store.create({ ...event, origin: "scheduled" })).toThrow();
	const id = "f".repeat(64);
	symlinkSync(join(root, `${entry.id}.json`), join(root, `${id}.json`));
	expect(() => store.assertBound(id, "C", "card")).toThrow();
});

it("reports safe failure categories without leaking diagnostic errors", () => {
	expect(
		describePromptFailure(new Error("This operation was aborted"), { timedOut: true, cancelled: true }).code,
	).toBe("timeout");
	expect(describePromptFailure(new Error("cancelled"), { cancelled: true }).code).toBe("cancelled");
	expect(describePromptFailure(new Error("提示词改写输出格式无效")).code).toBe("format");
	expect(describePromptFailure(new Error("重复或中断的提交不自动重试，请重新打开 /prompt")).code).toBe("submitted");
	expect(describePromptFailure(new Error("提示词表单已过期，请重新打开 /prompt")).code).toBe("expired");
	const result = describePromptFailure(new Error("fictional-private-provider-response"));
	expect(result.code).toBe("failed");
	expect(result.message).not.toContain("fictional-private");
	expect(result.message).not.toContain("payload omitted");
});

it("distinguishes an empty model response from malformed rewrite tags without retrying", async () => {
	const provider = registerFauxProvider();
	provider.setResponses([fauxAssistantMessage([])]);
	try {
		const rewrite = createPromptRewriter(loadConfigForDiagnostics({}), {
			model: provider.getModel(),
			apiKey: "fictional",
		});
		await expect(rewrite("task", new AbortController().signal)).rejects.toThrow("Model returned no usable content");
		expect(provider.state.callCount).toBe(1);
		const failure = describePromptFailure(new Error("Model returned no usable content"));
		expect(failure.code).toBe("empty_response");
		expect(failure.message).toContain("空响应");
		expect(failure.message).not.toContain("格式");
	} finally {
		provider.unregister();
	}
});

it("requires a durable preview before authorizing one edited confirmation", () => {
	const root = mkdtempSync(join(tmpdir(), "prompt-preview-"));
	roots.push(root);
	const store = new PromptDraftStore(root);
	const draft = store.create(event, 100);
	store.bindCard(draft.id, "card");
	expect(() => store.confirm(draft.id, "owner", "C", "card", "forged", 101)).toThrow();
	store.claim(draft.id, "owner", "C", "card", "raw", true, 101);
	expect(() => store.confirm(draft.id, "owner", "C", "card", "premature", 102)).toThrow();
	store.preview(draft.id, "optimized");
	const restarted = new PromptDraftStore(root);
	for (const [user, channel, card] of [
		["other", "C", "card"],
		["owner", "else", "card"],
		["owner", "C", "forwarded"],
	])
		expect(() => restarted.confirm(draft.id, user, channel, card, "forged", 103)).toThrow();
	expect(() => restarted.claim(draft.id, "owner", "C", "card", "switch mode", false, 103)).toThrow();
	expect(() => restarted.confirm(draft.id, "owner", "C", "card", "expired", 1800100)).toThrow(/过期/);
	expect(() => restarted.confirm(draft.id, "owner", "C", "card", " ", 103)).toThrow();
	expect(() => restarted.confirm(draft.id, "owner", "C", "card", "x".repeat(12001), 103)).toThrow();
	const final = `  edited final ${"x".repeat(1100)}  `;
	const confirmed = restarted.confirm(draft.id, "owner", "C", "card", final, 104);
	expect(confirmed.effectiveInput).toBe(final);
	expect(confirmed.status).toBe("running");
	expect(() => store.confirm(draft.id, "owner", "C", "card", final, 105)).toThrow();
	restarted.consume(draft.id, final);
	expect(() => store.confirm(draft.id, "owner", "C", "card", final, 106)).toThrow();
});

it("never turns an unavailable or failed preview into executable work", () => {
	const root = mkdtempSync(join(tmpdir(), "prompt-preview-failure-"));
	roots.push(root);
	const store = new PromptDraftStore(root);
	const draft = store.create(event, 100);
	store.bindCard(draft.id, "card");
	store.claim(draft.id, "owner", "C", "card", "raw", true, 101);
	expect(() => store.preview(draft.id, " ")).toThrow();
	expect(() => store.preview(draft.id, "x".repeat(12001))).toThrow();
	store.preview(draft.id, "optimized");
	expect(() => store.consume(draft.id, "not confirmed")).toThrow();
	store.fail(draft.id);
	expect(() => store.confirm(draft.id, "owner", "C", "card", "final", 102)).toThrow();
});
