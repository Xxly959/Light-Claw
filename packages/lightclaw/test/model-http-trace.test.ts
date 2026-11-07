import { expect, it, vi } from "vitest";
import { instrumentModelFetch } from "../src/model-http-trace.js";

it("observes SSE once without changing the response or retaining secrets or content", async () => {
	const traces: unknown[] = [];
	const body =
		'data: {"choices":[{"delta":{"content":"private-answer","tool_calls":[{}]}}]}\n\ndata: {"choices":[],"usage":{"total_tokens":12}}\n\ndata: [DONE]\n\n';
	const response = new Response(body, {
		headers: { "content-type": "text/event-stream; charset=utf-8", "content-encoding": "br" },
	});
	const original = vi.fn<typeof fetch>().mockResolvedValue(response);
	const observed = instrumentModelFetch({
		fetch: original,
		origin: "https://api.deepseek.com",
		expectedApiKey: "fictional-secret",
		onTrace: (trace) => traces.push(trace),
	});
	const options = {
		method: "POST",
		headers: { authorization: "Bearer fictional-secret" },
		body: JSON.stringify({
			model: "deepseek-flash",
			messages: [{ role: "user", content: "private-input" }],
			max_tokens: 32,
			stream: true,
			tools: [],
			thinking: { type: "disabled" },
		}),
	};
	const actual = await observed("https://api.deepseek.com/chat/completions", options);
	expect(actual).toBe(response);
	expect(await actual.text()).toBe(body);
	await vi.waitFor(() =>
		expect(traces.at(-1)).toMatchObject({
			phase: "complete",
			httpStatus: 200,
			contentType: "text/event-stream",
			contentEncoding: "br",
			textCharacters: 14,
			toolCallDeltas: 1,
			reportedTotalTokens: 12,
			configuredKeyMatches: true,
			maxTokens: 32,
			stream: true,
			bodyKind: "sse",
		}),
	);
	expect(JSON.stringify(traces)).not.toMatch(/private-answer|private-input|fictional-secret/);
	await observed("https://api.deepseek.com/chat/completions", options);
	expect(traces.filter((t) => (t as { phase: string }).phase === "request")).toHaveLength(1);
	expect(original).toHaveBeenCalledTimes(2);
});

it("leaves other destinations alone and distinguishes HTML from SSE", async () => {
	const traces: unknown[] = [];
	const original = vi
		.fn<typeof fetch>()
		.mockImplementation(
			async () => new Response("<html>private-page</html>", { headers: { "content-type": "text/html" } }),
		);
	const observed = instrumentModelFetch({
		fetch: original,
		origin: "https://api.deepseek.com",
		onTrace: (t) => traces.push(t),
	});
	await observed("https://example.invalid/");
	expect(traces).toEqual([]);
	const response = await observed("https://api.deepseek.com/chat/completions");
	await response.text();
	await vi.waitFor(() =>
		expect(traces.at(-1)).toMatchObject({
			phase: "complete",
			contentType: "text/html",
			sseDataLines: 0,
			textCharacters: 0,
		}),
	);
	expect(JSON.stringify(traces)).not.toContain("private-page");
});

it("identifies a non-stream JSON completion instead of confusing it with an empty response", async () => {
	const traces: unknown[] = [];
	const original = vi
		.fn<typeof fetch>()
		.mockResolvedValue(
			new Response(JSON.stringify({ id: "private-id", choices: [{ message: { content: "private-answer" } }] })),
		);
	const observed = instrumentModelFetch({
		fetch: original,
		origin: "https://api.deepseek.com",
		onTrace: (t) => traces.push(t),
	});
	const response = await observed("https://api.deepseek.com/chat/completions", {
		method: "POST",
		body: JSON.stringify({ stream: true }),
	});
	await response.text();
	await vi.waitFor(() =>
		expect(traces.at(-1)).toMatchObject({
			phase: "complete",
			stream: true,
			bodyKind: "json",
			jsonFields: ["id", "choices"],
			sseDataLines: 0,
		}),
	);
	expect(JSON.stringify(traces)).not.toMatch(/private-id|private-answer/);
});
