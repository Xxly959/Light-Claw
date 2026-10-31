import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createLightClawRuntime } from "../src/runtime.js";
import type { ChatTransport } from "../src/transport.js";

const roots: string[] = [];
afterEach(() => {
	for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
it("uses the production goal loop and preserves awaiting-confirmation semantics", async () => {
	const root = mkdtempSync(join(tmpdir(), "lightclaw-shared-runtime-"));
	roots.push(root);
	mkdirSync(join(root, "work"));
	let calls = 0;
	const runtime = await createLightClawRuntime({
		workingDir: join(root, "work"),
		sandbox: { type: "host" },
		config: {
			transport: "slack",
			modelProvider: "unused",
			modelId: "unused",
			controlDir: join(root, "control"),
			maxGoalCycles: 4,
			maxGoalFailures: 3,
			maxStaleCycles: 3,
		},
		createTransport: () =>
			({
				kind: "slack",
				start: async () => {},
				getUser: () => undefined,
				getChannel: () => undefined,
				getAllUsers: () => [],
				getAllChannels: () => [],
				postMessage: async () => "mock",
				updateMessage: async () => {},
				deleteMessage: async () => {},
				postInThread: async () => "mock",
				uploadFile: async () => {},
				logBotResponse: () => {},
				enqueueEvent: () => false,
			}) satisfies ChatTransport,
		createRunner: (_sandbox, channel, directory, _config, goals) => ({
			abort: () => {},
			dispose: () => {},
			run: async (ctx) => {
				calls++;
				if (calls === 1) goals.updateProgress("draft ready");
				else
					await goals.requestCompletion(
						{ summary: "needs confirmation", evidence: ["draft"] },
						{
							channelDir: directory,
							sandbox: { type: "host" },
							signal: new AbortController().signal,
							assertActive: () => {},
							reserveCommand: () => ({ timeoutSeconds: 1 }),
							executor: {
								getWorkspacePath: (p) => p,
								exec: async () => {
									throw new Error("no shell");
								},
							},
						},
					);
				await ctx.respond(channel);
				return {
					stopReason: "stop",
					durationMs: 1,
					toolCalls: 0,
					verificationCommandCount: 0,
					toolErrors: 0,
					inputTokens: 0,
					outputTokens: 0,
					cost: 0,
				};
			},
		}),
		releaseRunner: () => {},
	});
	try {
		await runtime.start();
		await runtime.handler.handleEvent(
			{ origin: "platform", type: "dm", channel: "channel", user: "owner", ts: "1", text: "/goal draft a document" },
			runtime.transport,
		);
		expect(calls).toBe(2);
		expect(runtime.goalStore("channel").get()?.status).toBe("awaiting_confirmation");
	} finally {
		await runtime.shutdown();
	}
});
