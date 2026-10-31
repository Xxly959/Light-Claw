import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import { expect, it } from "vitest";
import { createAgentRunner } from "../src/agent.js";
import { GoalStore } from "../src/goals/store.js";
import { ChannelStore } from "../src/store.js";
import type { ChatContext } from "../src/transport.js";

it("offers goal tools only while a goal is active, including on a reused runner", async () => {
	const root = mkdtempSync(join(tmpdir(), "goal-tool-discovery-"));
	const channelDir = join(root, "work", "task");
	const goals = new GoalStore({
		channelDir,
		controlChannelDir: join(root, "control"),
		limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
	});
	const faux = registerFauxProvider();
	const visible: string[][] = [];
	faux.setResponses(
		Array.from({ length: 3 }, () => (context: Context) => {
			visible.push(context.tools?.map((tool) => tool.name) ?? []);
			return fauxAssistantMessage("READY");
		}),
	);
	const noop = async () => {};
	const ctx: ChatContext = {
		message: {
			text: "reply READY",
			rawText: "reply READY",
			user: "owner",
			channel: "task",
			ts: "1",
			attachments: [],
		},
		channels: [],
		users: [],
		respond: noop,
		replaceMessage: noop,
		respondInThread: noop,
		uploadFile: noop,
		setTyping: noop,
		setWorking: noop,
		deleteMessage: noop,
	};
	const runner = createAgentRunner(
		{ type: "host" },
		"task",
		channelDir,
		{
			transport: "slack",
			modelProvider: "faux",
			modelId: "faux",
			maxGoalCycles: 8,
			maxGoalFailures: 2,
			maxStaleCycles: 2,
		},
		goals,
		{ model: faux.getModel(), apiKey: "faux", quiet: true },
	);
	try {
		const store = new ChannelStore({ workingDir: join(root, "work") });
		await runner.run(ctx, store);
		await goals.create(
			{ objective: "research", ownerUserId: "owner", acceptance: { mode: "manual" } },
			new AbortController().signal,
		);
		await runner.run(ctx, store);
		goals.pause();
		await runner.run(ctx, store);
		expect(visible[0]).not.toContain("goal_complete");
		expect(visible[1]).toContain("goal_complete");
		expect(visible[2]).not.toContain("goal_complete");
	} finally {
		runner.dispose();
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	}
});
