import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfigForDiagnostics } from "../src/config.js";
import { createPromptOptimizer, PromptDraftStore } from "../src/prompt-input.js";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "prompt-card-"));
	roots.push(root);
	return { root, store: new PromptDraftStore(root) };
}
const input = {
	origin: "platform" as const,
	type: "dm" as const,
	channel: "C",
	ts: "m1",
	user: "owner",
	text: "  用户原始输入  ",
};
it("binds explicit actions to actor, channel, card and expiry; never resumes an interrupted optimization", () => {
	const { root, store } = fixture();
	const draft = store.create(input, 100);
	store.bindCard(draft.id, "card");
	expect(() => store.claim(draft.id, "other", "C", "card", 101)).toThrow();
	expect(() => store.claim(draft.id, "owner", "else", "card", 101)).toThrow();
	expect(() => store.claim(draft.id, "owner", "C", "forwarded", 101)).toThrow();
	expect(() => store.claim(draft.id, "owner", "C", "card", 100 + 1800001)).toThrow(/过期/);
	expect(store.claim(draft.id, "owner", "C", "card", 101).input).toBe(input.text);
	expect(() => new PromptDraftStore(root).claim(draft.id, "owner", "C", "card", 102)).toThrow(/重复|中断/);
});
it("generates and then scores candidates only on explicit optimizer invocation, with no tools", async () => {
	const provider = registerFauxProvider();
	const usage = vi.fn();
	provider.setResponses([
		(ctx) => {
			expect(ctx.tools ?? []).toEqual([]);
			expect(JSON.stringify(ctx.messages)).toContain("原始");
			return fauxAssistantMessage(JSON.stringify(["明确目标和交付格式", "明确范围和验收"]));
		},
		(ctx) => {
			expect(ctx.tools ?? []).toEqual([]);
			return fauxAssistantMessage(
				JSON.stringify([
					{ index: 0, score: 50, reason: "输入简短" },
					{ index: 1, score: 90, reason: "结构清晰" },
					{ index: 2, score: 70, reason: "范围清楚" },
				]),
			);
		},
	]);
	try {
		const optimize = createPromptOptimizer(loadConfigForDiagnostics({}), {
			model: provider.getModel(),
			apiKey: "fictional",
			onUsage: usage,
		});
		expect(provider.state.callCount).toBe(0);
		const result = await optimize("原始", new AbortController().signal);
		expect(result.prompt).toBe("明确目标和交付格式");
		expect(result.score).toBe(0.9);
		expect(result.candidates.map((c) => c.score)).toEqual([0.9, 0.7, 0.5]);
		expect(provider.state.callCount).toBe(2);
		expect(usage).toHaveBeenCalledTimes(2);
	} finally {
		provider.unregister();
	}
});
it("rejects bad scoring, cancellation and long input without tool or downstream task execution", async () => {
	const provider = registerFauxProvider();
	try {
		const optimize = createPromptOptimizer(loadConfigForDiagnostics({}), {
			model: provider.getModel(),
			apiKey: "fictional",
		});
		await expect(optimize("x".repeat(12001), new AbortController().signal)).rejects.toThrow();
		const abort = new AbortController();
		abort.abort();
		await expect(optimize("task", abort.signal)).rejects.toThrow();
		expect(provider.state.callCount).toBe(0);
		provider.setResponses([fauxAssistantMessage('["candidate"]'), fauxAssistantMessage('[{"index":1,"score":999}]')]);
		await expect(optimize("task", new AbortController().signal)).rejects.toThrow();
	} finally {
		provider.unregister();
	}
});

it("does not start scoring after cancellation during candidate generation", async () => {
	const provider = registerFauxProvider();
	const controller = new AbortController();
	provider.setResponses([
		() => {
			controller.abort();
			return fauxAssistantMessage('["candidate"]');
		},
	]);
	try {
		const optimize = createPromptOptimizer(loadConfigForDiagnostics({}), {
			model: provider.getModel(),
			apiKey: "fictional",
		});
		await expect(optimize("task", controller.signal)).rejects.toThrow();
		expect(provider.state.callCount).toBe(1);
	} finally {
		provider.unregister();
	}
});
