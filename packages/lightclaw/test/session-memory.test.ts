import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { expect, it, vi } from "vitest";
import { type AgentRunner, createAgentRunner } from "../src/agent.js";
import type { LightClawConfig } from "../src/config.js";
import { GoalStore } from "../src/goals/store.js";
import { createExecutor } from "../src/sandbox.js";
import { ChannelStore } from "../src/store.js";
import { createReadTool } from "../src/tools/read.js";
import type { ChatContext } from "../src/transport.js";

function createFixture(makeReplies: (workspace: string) => AssistantMessage[], { withReadTool = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "lightclaw-session-memory-"));
	const workspace = join(root, "chat-a-work");
	for (const channel of ["chat-a", "chat-b"]) mkdirSync(join(workspace, channel), { recursive: true });
	const provider = registerFauxProvider();
	const requests: { system: string; messages: string }[] = [];
	provider.setResponses(
		makeReplies(workspace).map((reply) => (context) => {
			requests.push({ system: context.systemPrompt ?? "", messages: JSON.stringify(context.messages) });
			return reply;
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
			tools: withReadTool ? [createReadTool(createExecutor({ type: "host" }))] : [],
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
	const cleanup = () => {
		for (const runner of runners) runner.dispose();
		provider.unregister();
		rmSync(root, { recursive: true, force: true });
	};
	return { workspace, requests, create, context, store, cleanup };
}

it("refreshes file memory and reloads persisted history without mixing channel-private data", async () => {
	const { workspace, requests, create, context, store, cleanup } = createFixture(() =>
		["LC_A_REPLY_ONE", "LC_A_REPLY_TWO", "LC_A_REPLY_RELOADED", "LC_B_REPLY"].map((reply) =>
			fauxAssistantMessage(reply),
		),
	);
	try {
		writeFileSync(join(workspace, "MEMORY.md"), "LC_GLOBAL_MEMORY_V1");
		writeFileSync(join(workspace, "chat-a", "MEMORY.md"), "LC_PRIVATE_A_V1");
		writeFileSync(join(workspace, "chat-b", "MEMORY.md"), "LC_PRIVATE_B");
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
		cleanup();
	}
});

it("loads bounded complete lines from both indexes and reads a detailed note only on demand", async () => {
	const { workspace, requests, create, context, store, cleanup } = createFixture(
		(workspace) => [
			fauxAssistantMessage(
				fauxToolCall("read", {
					label: "Read deployment note",
					path: join(workspace, "chat-a", "memory", "deployment.md"),
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("LC_READ_COMPLETE"),
		],
		{ withReadTool: true },
	);
	try {
		const channelDir = join(workspace, "chat-a");
		const notePath = join(channelDir, "memory", "deployment.md");
		const globalIndex = `LC_GLOBAL_INDEX\nLC_PARTIAL_LINE${"记".repeat(1365)}LC_GLOBAL_TAIL`;
		const channelIndex = `LC_CHANNEL_INDEX: memory/deployment.md\n${"x".repeat(4096)}LC_CHANNEL_TAIL`;
		writeFileSync(join(workspace, "MEMORY.md"), globalIndex);
		writeFileSync(join(channelDir, "MEMORY.md"), channelIndex);
		mkdirSync(join(channelDir, "memory"));
		writeFileSync(notePath, "LC_DEPLOYMENT_DETAILS");
		// Use the actual read tool so a later request receives the note as a tool result.
		const runner = create("chat-a");
		expect((await runner.run(context("chat-a", "LC_REQUEST_DETAILS", "1"), store)).stopReason).toBe("stop");
		expect(requests[0].system).toContain("LC_GLOBAL_INDEX");
		expect(requests[0].system).toContain("LC_CHANNEL_INDEX: memory/deployment.md");
		expect(requests[0].system).toContain(`Channel notes: ${channelDir}/memory/`);
		expect(requests[0].system).toContain("Read this channel's MEMORY.md for the omitted entries");
		expect(requests[0].system).toContain("Read the workspace MEMORY.md for the omitted entries");
		expect(requests[0].system.includes("LC_GLOBAL_TAIL")).toBe(false);
		expect(requests[0].system.includes("LC_CHANNEL_TAIL")).toBe(false);
		expect(requests[0].system).not.toContain("LC_PARTIAL_LINE");
		expect(requests[0].system).not.toContain("LC_DEPLOYMENT_DETAILS");
		expect(requests[1].messages).toContain("LC_DEPLOYMENT_DETAILS");
		expect(readFileSync(join(workspace, "MEMORY.md"), "utf8")).toBe(globalIndex);
		expect(readFileSync(join(channelDir, "MEMORY.md"), "utf8")).toBe(channelIndex);
	} finally {
		cleanup();
	}
});

it("does not inject another channel's memory through a symbolic link", async () => {
	const { workspace, requests, create, context, store, cleanup } = createFixture(() => [
		fauxAssistantMessage("LC_REPLY"),
	]);
	try {
		writeFileSync(join(workspace, "MEMORY.md"), "LC_GLOBAL");
		writeFileSync(join(workspace, "chat-b", "MEMORY.md"), "LC_OTHER_CHANNEL");
		symlinkSync("../chat-b/MEMORY.md", join(workspace, "chat-a", "MEMORY.md"));
		expect((await create("chat-a").run(context("chat-a", "LC_REQUEST", "1"), store)).stopReason).toBe("stop");
		expect(requests[0].system).toContain("LC_GLOBAL");
		expect(requests[0].system).not.toContain("LC_OTHER_CHANNEL");
	} finally {
		cleanup();
	}
});

it("rejects a channel directory replaced with a symbolic link after runner creation", async () => {
	const { workspace, requests, create, context, store, cleanup } = createFixture(() => [
		fauxAssistantMessage("LC_REPLY"),
	]);
	try {
		const channelDir = join(workspace, "chat-a");
		const runner = create("chat-a");
		rmSync(channelDir, { recursive: true });
		symlinkSync("chat-b", channelDir, "dir");
		await expect(runner.run(context("chat-a", "LC_REQUEST", "1"), store)).rejects.toThrow(
			"Channel storage directory must not be linked",
		);
		expect(requests).toHaveLength(0);
	} finally {
		cleanup();
	}
});

it.each([
	{
		name: "a line ending beyond the byte budget",
		index: `LC_OMITTED${"x".repeat(4086)}\nLC_TAIL`,
	},
	{
		name: "invalid UTF-8",
		index: Buffer.concat([Buffer.from("LC_OMITTED"), Buffer.from([0xff])]),
	},
])("omits $name from the system prompt", async ({ index }) => {
	const { workspace, requests, create, context, store, cleanup } = createFixture(() => [
		fauxAssistantMessage("LC_REPLY"),
	]);
	try {
		writeFileSync(join(workspace, "MEMORY.md"), "LC_GLOBAL");
		writeFileSync(join(workspace, "chat-a", "MEMORY.md"), index);
		expect((await create("chat-a").run(context("chat-a", "LC_REQUEST", "1"), store)).stopReason).toBe("stop");
		expect(requests[0].system).toContain("LC_GLOBAL");
		expect(requests[0].system.includes("LC_OMITTED")).toBe(false);
	} finally {
		cleanup();
	}
});

it("opts into lightweight memory guidance without changing the stored memory", async () => {
	const { workspace, requests, create, context, store, cleanup } = createFixture(() => [
		fauxAssistantMessage("LC_REPLY"),
	]);
	vi.stubEnv("MEMORY_FEATURES", "i7");
	try {
		writeFileSync(join(workspace, "MEMORY.md"), "LC_SHARED_GUIDANCE");
		expect((await create("chat-a").run(context("chat-a", "LC_REQUEST", "1"), store)).stopReason).toBe("stop");
		expect(requests[0].system).toContain("Use the current indexes for relevant standing rules");
		expect(requests[0].system).not.toContain("Keep each MEMORY.md index within 4 KiB");
		expect(requests[0].system).toContain("LC_SHARED_GUIDANCE");
	} finally {
		vi.unstubAllEnvs();
		cleanup();
	}
});
