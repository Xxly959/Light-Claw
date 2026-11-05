import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	registerFauxProvider,
	streamSimple,
} from "@mariozechner/pi-ai";
import { afterEach, expect, it } from "vitest";
import { createRoutedStream, type ModelAttempt, ModelRouter } from "../src/model-router.js";

const primary = registerFauxProvider({ provider: "fictional-primary" });
const backup = registerFauxProvider({ provider: "fictional-backup" });
const third = registerFauxProvider({ provider: "fictional-third" });
afterEach(() => {
	primary.setResponses([]);
	backup.setResponses([]);
	third.setResponses([]);
});
function setup(dispatch: StreamFn = streamSimple) {
	let now = 0;
	const router = new ModelRouter({
		primary: primary.getModel(),
		fallbacks: [backup.getModel(), third.getModel()],
		now: () => now,
		cooldownMs: 100,
	});
	const attempts: ModelAttempt[] = [];
	const routed = createRoutedStream({
		router,
		dispatch,
		getApiKey: (provider) => `${provider}-fake-key`,
		onAttempt: (attempt) => attempts.push(attempt),
		timeoutMs: 100,
	});
	return {
		router,
		routed,
		attempts,
		advance: () => {
			now += 101;
		},
	};
}
it.each(["429 rate limit", "fetch failed ECONNRESET", "502 gateway"])(
	"routes stream error %s and uses each provider's credential",
	async (message) => {
		const keys: Array<string | undefined> = [];
		primary.setResponses([
			(_ctx, options) => {
				keys.push(options?.apiKey);
				return fauxAssistantMessage([], { stopReason: "error", errorMessage: message });
			},
		]);
		backup.setResponses([
			(_ctx, options) => {
				keys.push(options?.apiKey);
				return fauxAssistantMessage("backup response");
			},
		]);
		const { routed, attempts, router, advance } = setup();
		const result = await routed(primary.getModel(), { messages: [] }, { apiKey: "must-not-leak" });
		for await (const _event of result) {
			/* consume production stream */
		}
		expect((await result.result()).provider).toBe("fictional-backup");
		expect(keys).toEqual(["fictional-primary-fake-key", "fictional-backup-fake-key"]);
		expect(attempts.map((item) => item.attempt)).toEqual([1, 2]);
		expect(attempts[0].usage).toBeNull();
		expect(router.degraded).toBe(true);
		advance();
		expect(router.current().provider).toBe("fictional-primary");
	},
);
it("does not combine partial output with a backup response", async () => {
	primary.setResponses([fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "429" })]);
	const { routed, attempts } = setup();
	const stream = await routed(primary.getModel(), { messages: [] });
	const events = [];
	for await (const event of stream) events.push(event);
	expect((await stream.result()).stopReason).toBe("error");
	expect(attempts).toHaveLength(1);
	expect(events.some((item) => item.type === "text_delta")).toBe(true);
});
it("traverses the whole backup chain and retains known failed usage", async () => {
	primary.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "503" })]);
	backup.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "429" })]);
	third.setResponses([fauxAssistantMessage("third")]);
	const { routed, attempts } = setup();
	const stream = await routed(primary.getModel(), {
		messages: [{ role: "user", content: "known input", timestamp: 1 }],
	});
	for await (const _event of stream) {
	}
	expect((await stream.result()).provider).toBe("fictional-third");
	expect(attempts).toHaveLength(3);
	expect(attempts[0].usage!.input).toBeGreaterThan(0);
});
it("does not retry authentication errors", async () => {
	primary.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 unauthorized" })]);
	const { routed, attempts } = setup();
	const stream = await routed(primary.getModel(), { messages: [] });
	for await (const _event of stream) {
	}
	expect(attempts).toHaveLength(1);
	expect((await stream.result()).errorMessage).toContain("401");
});
it("cancels even a provider that never finishes", async () => {
	const controller = new AbortController();
	const { routed, attempts } = setup(() => createAssistantMessageEventStream());
	const stream = await routed(primary.getModel(), { messages: [] }, { signal: controller.signal });
	controller.abort();
	for await (const _event of stream) {
	}
	expect((await stream.result()).stopReason).toBe("aborted");
	expect(attempts).toHaveLength(1);
});
it("times out a stalled attempt and tries a backup", async () => {
	const { routed, attempts } = setup((model, context, options) =>
		model.provider === "fictional-primary"
			? createAssistantMessageEventStream()
			: streamSimple(model, context, options),
	);
	backup.setResponses([fauxAssistantMessage("after timeout")]);
	const stream = await routed(primary.getModel(), { messages: [] });
	for await (const _event of stream) {
	}
	expect((await stream.result()).provider).toBe("fictional-backup");
	expect(attempts[0].reason).toMatch(/timeout/i);
});
