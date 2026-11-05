import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { expect, it } from "vitest";
import { createAgentRunner } from "../src/agent.js";
import { GoalStore } from "../src/goals/store.js";
import { ChannelStore } from "../src/store.js";
import type { ChatContext } from "../src/transport.js";

it.each(["automatic", "manual"] as const)(
	"delivers a terminal %s goal outcome without another model request",
	async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "goal-terminal-delivery-"));
		const channelDir = join(root, "work", "task");
		const store = new GoalStore({
			channelDir,
			controlChannelDir: join(root, "control"),
			limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
		});
		const faux = registerFauxProvider();
		const replies: string[] = [];
		const noop = async () => {};
		const context: ChatContext = {
			message: {
				text: "write report",
				rawText: "write report",
				user: "owner",
				channel: "task",
				ts: "1",
				attachments: [],
			},
			channels: [],
			users: [],
			respond: async (text) => {
				replies.push(text);
			},
			replaceMessage: async (text) => {
				replies.push(text);
			},
			respondInThread: noop,
			uploadFile: noop,
			setTyping: noop,
			setWorking: noop,
			deleteMessage: noop,
		};
		await store.create(
			{
				objective: "write report",
				ownerUserId: "owner",
				acceptance:
					mode === "manual"
						? { mode }
						: {
								mode,
								files: [{ path: "scratch/report.txt", changed: false, contains: ["READY"] }],
								commands: [],
							},
			},
			new AbortController().signal,
		);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", {
					label: "write report",
					path: join(channelDir, "scratch/report.txt"),
					content: "READY",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("goal_complete", {
					summary: "Report_READY",
					evidence: ["scratch/report.txt"],
					deliverables: { kind: "files", paths: ["scratch/report.txt"] },
				}),
				{ stopReason: "toolUse" },
			),
		]);
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
			store,
			{ model: faux.getModel(), apiKey: "faux", quiet: true },
		);
		try {
			const result = await runner.run(context, new ChannelStore({ workingDir: join(root, "work") }));
			expect(store.get()?.status).toBe(mode === "manual" ? "awaiting_confirmation" : "completed");
			expect(replies.at(-1)).toContain("Report_READY");
			if (mode === "manual") expect(replies.at(-1)).toContain("/goal confirm");
			expect(result.stopReason).toBe("stop");
			expect(result.toolCalls).toBe(2);
		} finally {
			runner.dispose();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
