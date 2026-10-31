import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunner } from "../src/agent.js";
import type { LightClawConfig } from "../src/config.js";
import { GoalStore } from "../src/goals/store.js";
import { ChannelStore } from "../src/store.js";
import type { ChatContext } from "../src/transport.js";

const temporaryPaths: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const path of temporaryPaths.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

const delaySchema = Type.Object({ label: Type.String() });

describe("createAgentRunner", () => {
	it.each(["host", "docker"] as const)(
		"uses the correct %s environment in the actual model request",
		async (sandbox) => {
			vi.stubEnv("LIGHTCLAW_DEBUG_PAYLOADS", "0");
			const workspace = mkdtempSync(join(tmpdir(), "lightclaw-runner-"));
			temporaryPaths.push(workspace);
			const channelId = "benchmark-channel";
			const channelDir = join(workspace, channelId);
			const faux = registerFauxProvider({ tokenSize: { min: 4, max: 4 } });
			let actualPrompt = "";
			faux.setResponses([
				(context) => {
					actualPrompt = context.systemPrompt ?? "";
					return fauxAssistantMessage("environment checked");
				},
				fauxAssistantMessage(fauxToolCall("benchmark_delay", { label: "wait" }), { stopReason: "toolUse" }),
				(context) => {
					expect(JSON.stringify(context.messages)).toContain("fictional-tool-value");
					return fauxAssistantMessage("benchmark complete");
				},
			]);

			let toolCalls = 0;
			const tool: AgentTool<typeof delaySchema, undefined> = {
				name: "benchmark_delay",
				label: "benchmark delay",
				description: "Deterministic test tool",
				parameters: delaySchema,
				execute: async () => {
					toolCalls++;
					return { content: [{ type: "text", text: "waited api_key=fictional-tool-value" }], details: undefined };
				},
			};
			const config: LightClawConfig = {
				transport: "slack",
				modelProvider: "unused",
				modelId: "unused",
				maxGoalCycles: 8,
				maxGoalFailures: 2,
				maxStaleCycles: 2,
			};
			const goals = new GoalStore({
				channelDir: channelDir,
				controlChannelDir: join(channelDir, "..", "..", "control", basename(channelDir)),
				limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
			});
			const responses: string[] = [];
			const threads: string[] = [];
			const context: ChatContext = {
				message: {
					text: "run benchmark",
					rawText: "run benchmark",
					user: "benchmark-user",
					userName: "benchmark",
					channel: channelId,
					ts: "1",
					attachments: [],
				},
				channelName: channelId,
				channels: [{ id: channelId, name: channelId }],
				users: [{ id: "benchmark-user", userName: "benchmark", displayName: "Benchmark" }],
				respond: async (text) => {
					responses.push(text);
				},
				replaceMessage: async (text) => {
					responses.push(text);
				},
				respondInThread: async (text) => {
					threads.push(text);
				},
				setTyping: async () => {},
				uploadFile: async () => {},
				setWorking: async () => {},
				deleteMessage: async () => {},
			};

			try {
				const runner = createAgentRunner(
					sandbox === "host" ? { type: "host" } : { type: "docker", container: "unused" },
					channelId,
					channelDir,
					config,
					goals,
					{
						model: faux.getModel(),
						tools: [tool],
						apiKey: "faux-key",
					},
				);
				await runner.run(context, new ChannelStore({ workingDir: workspace }));
				expect(actualPrompt).toContain("benchmark-user\t@benchmark\tBenchmark");
				expect(actualPrompt).toContain(
					`Current working directory: ${sandbox === "docker" ? "/workspace" : process.cwd()}`,
				);
				if (sandbox === "docker") {
					expect(actualPrompt).not.toContain(process.cwd());
					expect(actualPrompt).not.toContain("apk add jq");
					expect(actualPrompt).not.toContain("Install packages as needed");
				}
				expect(actualPrompt).toContain(".lightclaw-guide.md");
				expect(actualPrompt).not.toContain("### Cron Format");
				const guide = readFileSync(join(channelDir, ".lightclaw-guide.md"), "utf8");
				expect(guide).toContain("### Cron Format");
				expect(guide).toContain('"type": "periodic"');
				const result = await runner.run(context, new ChannelStore({ workingDir: workspace }));

				expect(result.stopReason).toBe("stop");
				expect(result.toolCalls).toBe(1);
				expect(result.toolErrors).toBe(0);
				expect(toolCalls).toBe(1);
				expect(responses).toContain("benchmark complete");
				expect(faux.state.callCount).toBe(3);
				expect(threads.join("\n")).not.toContain("fictional-tool-value");
				expect(existsSync(join(channelDir, "last_prompt.jsonl"))).toBe(false);
				expect(result.inputTokens).toBeGreaterThan(0);
				vi.stubEnv("LIGHTCLAW_CONTEXT_MAX_BYTES", "1");
				await expect(runner.run(context, new ChannelStore({ workingDir: workspace }))).rejects.toThrow(
					/context.*quota/,
				);
				expect(faux.state.callCount).toBe(3);
				runner.dispose();
			} finally {
				faux.unregister();
			}
		},
	);
});
