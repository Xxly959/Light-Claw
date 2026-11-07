import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { resolveApiKey, resolveModel } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { createRoutedStream, ModelRouter } from "../src/model-router.js";
import { createPromptRewriter } from "../src/prompt-input.js";

const paths: string[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function configuration() {
	const dir = mkdtempSync(join(tmpdir(), "lightclaw-gateway-"));
	paths.push(dir);
	const file = join(dir, "models.json");
	writeFileSync(
		file,
		JSON.stringify({
			providers: {
				"fictional-gateway": {
					api: "openai-completions",
					apiKey: "OPENAI_API_KEY",
					baseUrl: "https://gateway.example.invalid/",
					models: [
						{ id: "fictional-flash-v2", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024 },
					],
				},
			},
		}),
	);
	return {
		file,
		config: loadConfig({
			LIGHTCLAW_FEISHU_APP_ID: "fake-app",
			LIGHTCLAW_FEISHU_APP_SECRET: "fake-secret",
			LIGHTCLAW_MODEL_PROVIDER: "fictional-gateway",
			LIGHTCLAW_MODEL_ID: "fictional-flash-v2",
			LIGHTCLAW_MODELS_FILE: file,
		}),
	};
}
it("resolves an explicitly configured gateway model without impersonating a built-in model", async () => {
	const { config } = configuration();
	const model = resolveModel(config);
	expect(model).toMatchObject({
		provider: "fictional-gateway",
		id: "fictional-flash-v2",
		api: "openai-completions",
		baseUrl: "https://gateway.example.invalid/",
		contextWindow: 4096,
	});
	vi.stubEnv("OPENAI_API_KEY", "fictional-gateway-key");
	const key = await resolveApiKey(AuthStorage.inMemory(), model.provider);
	let requestBody: Record<string, unknown> | undefined;
	const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const request = new Request(input, init);
		expect(request.url).toBe("https://gateway.example.invalid/chat/completions");
		expect(request.headers.get("authorization")).toBe("Bearer fictional-gateway-key");
		requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
		return new Response(
			'data: {"id":"fake","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"offline checked"},"finish_reason":null}]}\n\ndata: {"id":"fake","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			{ headers: { "content-type": "text/event-stream" } },
		);
	});
	vi.stubGlobal("fetch", fetchMock);
	const stream = streamSimple(
		model,
		{ messages: [{ role: "user", content: "check", timestamp: 1 }] },
		{ apiKey: key },
	);
	for await (const _event of stream) {
		/* consume actual SDK stream with mocked fetch */
	}
	expect((await stream.result()).stopReason).toBe("stop");
	expect(requestBody?.model).toBe("fictional-flash-v2");
	expect(fetchMock).toHaveBeenCalledOnce();
});
it("rejects malformed explicit model definitions instead of falling back silently", () => {
	const { file, config } = configuration();
	writeFileSync(file, "{broken");
	expect(() => resolveModel(config)).toThrow("模型定义文件无效");
});
it("does not accept an unknown model without explicit definitions", () => {
	const { config } = configuration();
	delete config.modelsFile;
	expect(() => resolveModel(config)).toThrow();
});

it("rejects a missing explicit model file", () => {
	const { file, config } = configuration();
	rmSync(file);
	expect(() => resolveModel(config)).toThrow("模型定义文件不存在");
});
it("rejects an undeclared ID even when the provider is configured", () => {
	const { config } = configuration();
	config.modelId = "another-undeclared-model";
	expect(() => resolveModel(config)).toThrow("找不到模型");
});

it.each([
	{ contentType: "text/event-stream", body: "data: [DONE]\n\n" },
	{ contentType: "text/html", body: "<html>fictional intermediary response</html>" },
])(
	"rejects HTTP 200 $contentType without usable model output in both execution paths",
	async ({ contentType, body }) => {
		const { config } = configuration();
		const model = resolveModel(config);
		const fetchMock = vi.fn(async () => new Response(body, { headers: { "content-type": contentType } }));
		vi.stubGlobal("fetch", fetchMock);
		const routed = createRoutedStream({
			router: new ModelRouter({ primary: model, fallbacks: [] }),
			dispatch: streamSimple,
			getApiKey: () => "fictional",
			onAttempt: (attempt) => {
				expect(attempt.usage).toBeNull();
				expect(attempt.status).toBe("error");
			},
		});
		const stream = await routed(model, { messages: [] });
		for await (const _event of stream) {
		}
		expect((await stream.result()).stopReason).toBe("error");
		expect((await stream.result()).errorMessage).toBe("Model returned no usable content");
		const rewrite = createPromptRewriter(config, { model, apiKey: "fictional" });
		await expect(rewrite("fictional task", new AbortController().signal)).rejects.toThrow(
			"Model returned no usable content",
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	},
);

it("uses the official DeepSeek max_tokens limit and explicitly disables thinking", async () => {
	const { file, config } = configuration();
	writeFileSync(
		file,
		JSON.stringify({
			providers: {
				deepseek: {
					api: "openai-completions",
					apiKey: "OPENAI_API_KEY",
					baseUrl: "https://api.deepseek.com",
					models: [
						{
							id: "deepseek-flash",
							reasoning: true,
							input: ["text"],
							contextWindow: 4096,
							maxTokens: 1024,
							compat: { maxTokensField: "max_tokens" },
						},
					],
				},
			},
		}),
	);
	config.modelProvider = "deepseek";
	config.modelId = "deepseek-flash";
	const model = resolveModel(config);
	const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const request = new Request(input, init);
		expect(request.url).toBe("https://api.deepseek.com/chat/completions");
		const body = JSON.parse(await request.text()) as Record<string, unknown>;
		expect(body.model).toBe("deepseek-flash");
		expect(body.max_tokens).toBe(32);
		expect(body.max_completion_tokens).toBeUndefined();
		expect(body.thinking).toEqual({ type: "disabled" });
		return new Response(
			'data: {"id":"offline","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"offline","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			{ headers: { "content-type": "text/event-stream" } },
		);
	});
	vi.stubGlobal("fetch", fetchMock);
	const stream = streamSimple(
		model,
		{ messages: [{ role: "user", content: "fictional request", timestamp: 1 }] },
		{ apiKey: "fictional", maxTokens: 32 },
	);
	for await (const _event of stream) {
	}
	expect((await stream.result()).stopReason).toBe("stop");
	expect(fetchMock).toHaveBeenCalledOnce();
});
