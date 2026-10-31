import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRunner } from "../src/agent.js";
import type { LightClawConfig } from "../src/config.js";
import { GoalStore } from "../src/goals/store.js";
import { ChannelStore } from "../src/store.js";
import type { ChatContext } from "../src/transport.js";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

const delaySchema = Type.Object({ label: Type.String() });

describe("createAgentRunner", () => {
	it("runs a faux provider tool round without API credentials", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "lightclaw-runner-"));
		temporaryPaths.push(workspace);
		const channelId = "benchmark-channel";
		const channelDir = join(workspace, channelId);
		const faux = registerFauxProvider({ tokenSize: { min: 4, max: 4 } });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("benchmark_delay", { label: "wait" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("benchmark complete"),
		]);

		let toolCalls = 0;
		const tool: AgentTool<typeof delaySchema, undefined> = {
			name: "benchmark_delay",
			label: "benchmark delay",
			description: "Deterministic test tool",
			parameters: delaySchema,
			execute: async () => {
				toolCalls++;
				return { content: [{ type: "text", text: "waited" }], details: undefined };
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
			respondInThread: async () => {},
			setTyping: async () => {},
			uploadFile: async () => {},
			setWorking: async () => {},
			deleteMessage: async () => {},
		};

		try {
			const runner = createAgentRunner({ type: "host" }, channelId, channelDir, config, goals, {
				model: faux.getModel(),
				tools: [tool],
				apiKey: "faux-key",
			});
			const result = await runner.run(context, new ChannelStore({ workingDir: workspace }));

			expect(result.stopReason).toBe("stop");
			expect(result.toolCalls).toBe(1);
			expect(result.toolErrors).toBe(0);
			expect(toolCalls).toBe(1);
			expect(responses).toContain("benchmark complete");
			expect(faux.state.callCount).toBe(2);
		} finally {
			faux.unregister();
		}
	});
});
