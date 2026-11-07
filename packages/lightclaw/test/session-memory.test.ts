import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import { expect, it } from "vitest";
import { type AgentRunner, createAgentRunner } from "../src/agent.js";
import type { LightClawConfig } from "../src/config.js";
import { GoalStore } from "../src/goals/store.js";
import { ChannelStore } from "../src/store.js";
import type { ChatContext } from "../src/transport.js";

it("refreshes file memory and reloads persisted history without mixing channel-private data", async () => {
	// Catches cached memory, a wrong channel memory path, or dropping the persisted session on recreation.
	const root = mkdtempSync(join(tmpdir(), "lightclaw-session-memory-"));
	const workspace = join(root, "work");
	for (const channel of ["chat-a", "chat-b"]) mkdirSync(join(workspace, channel), { recursive: true });
	writeFileSync(join(workspace, "MEMORY.md"), "LC_GLOBAL_MEMORY_V1");
	writeFileSync(join(workspace, "chat-a", "MEMORY.md"), "LC_PRIVATE_A_V1");
	writeFileSync(join(workspace, "chat-b", "MEMORY.md"), "LC_PRIVATE_B");
	const provider = registerFauxProvider();
	const requests: { system: string; messages: string }[] = [];
	provider.setResponses(
		["LC_A_REPLY_ONE", "LC_A_REPLY_TWO", "LC_A_REPLY_RELOADED", "LC_B_REPLY"].map((reply) => (context) => {
			requests.push({ system: context.systemPrompt ?? "", messages: JSON.stringify(context.messages) });
			return fauxAssistantMessage(reply);
		}),
	);
	const config: LightClawConfig = {
		transport: "feishu",
		modelProvider: "unused",
		modelId: "unused",
		maxGoalCycles: 8,
		maxGoalFailures: 2,
		maxStaleCycles: 2,
	};
	const runners: AgentRunner[] = [];
	const create = (channel: string) => {
		const channelDir = join(workspace, channel);
		const goals = new GoalStore({
			channelDir,
			controlChannelDir: join(root, "control", channel),
			limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
		});
		const runner = createAgentRunner({ type: "host" }, channel, channelDir, config, goals, {
			model: provider.getModel(),
			apiKey: "faux-key",
			tools: [],
			inMemoryState: true,
			quiet: true,
		});
		runners.push(runner);
		return runner;
	};
	const context = (channel: string, text: string, timestamp: string): ChatContext => ({
		message: { text, rawText: text, user: "fixture-owner", channel, ts: timestamp, attachments: [] },
		channels: [],
		users: [],
		respond: async () => {},
		replaceMessage: async () => {},
		respondInThread: async () => {},
		setTyping: async () => {},
		uploadFile: async () => {},
		setWorking: async () => {},
		deleteMessage: async () => {},
	});
	const store = new ChannelStore({ workingDir: workspace });
	try {
		const first = create("chat-a");
		expect((await first.run(context("chat-a", "LC_A_REQUEST_ONE", "1"), store)).stopReason).toBe("stop");
		expect(requests[0].system).toContain("LC_GLOBAL_MEMORY_V1");
		expect(requests[0].system).toContain("LC_PRIVATE_A_V1");
		expect(requests[0].system).not.toContain("LC_PRIVATE_B");

		writeFileSync(join(workspace, "MEMORY.md"), "LC_GLOBAL_MEMORY_V2");
		writeFileSync(join(workspace, "chat-a", "MEMORY.md"), "LC_PRIVATE_A_V2");
		expect((await first.run(context("chat-a", "LC_A_REQUEST_TWO", "2"), store)).stopReason).toBe("stop");
		expect(requests[1].system).toContain("LC_GLOBAL_MEMORY_V2");
		expect(requests[1].system).toContain("LC_PRIVATE_A_V2");
		expect(requests[1].system).not.toContain("LC_GLOBAL_MEMORY_V1");
		expect(requests[1].system).not.toContain("LC_PRIVATE_A_V1");
		expect(requests[1].messages).toContain("LC_A_REQUEST_ONE");
		expect(requests[1].messages).toContain("LC_A_REPLY_ONE");
		first.dispose();

		const reloaded = create("chat-a");
		expect((await reloaded.run(context("chat-a", "LC_A_REQUEST_RELOADED", "3"), store)).stopReason).toBe("stop");
		expect(requests[2].messages).toContain("LC_A_REQUEST_ONE");
		expect(requests[2].messages).toContain("LC_A_REPLY_ONE");
		expect(requests[2].messages).toContain("LC_A_REQUEST_TWO");
		expect(requests[2].system).toContain("LC_PRIVATE_A_V2");

		const other = create("chat-b");
		expect((await other.run(context("chat-b", "LC_B_REQUEST", "4"), store)).stopReason).toBe("stop");
		expect(requests[3].system).toContain("LC_GLOBAL_MEMORY_V2");
		expect(requests[3].system).toContain("LC_PRIVATE_B");
		expect(requests[3].system).not.toContain("LC_PRIVATE_A");
		expect(requests[3].messages).not.toContain("LC_A_REQUEST");
		expect(requests[3].messages).not.toContain("LC_A_REPLY");
		expect(readFileSync(join(workspace, "chat-a", "context.jsonl"), "utf8")).toContain("LC_A_REQUEST_ONE");
	} finally {
		for (const runner of runners) runner.dispose();
		provider.unregister();
		rmSync(root, { recursive: true, force: true });
	}
});
