import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import { expect, it, vi } from "vitest";
import { createAgentRunner } from "../src/agent.js";
import type { LightClawConfig, LightClawFeatures } from "../src/config.js";
import { GoalStore } from "../src/goals/store.js";
import * as sandboxModule from "../src/sandbox.js";
import { ChannelStore } from "../src/store.js";
import type { ChatContext } from "../src/transport.js";

const names: Array<keyof LightClawFeatures> = [
	"goals",
	"acceptance",
	"feishu",
	"controls",
	"scheduling",
	"optimization",
	"infrastructure",
];
const flags = (value: boolean) =>
	Object.fromEntries(names.map((name) => [name, value])) as unknown as LightClawFeatures;
const arms = [
	{ name: "all-off-control", features: flags(false) },
	...names.map((name) => ({ name: `only-${name}`, features: { ...flags(false), [name]: true } })),
	{ name: "all-on", features: flags(true) },
	...names.map((name) => ({ name: `without-${name}`, features: { ...flags(true), [name]: false } })),
];

it.each(arms)("wires $name into the actual runner request (faux boundary check)", async ({ features }) => {
	const root = mkdtempSync(join(tmpdir(), "feature-runner-"));
	const faux = registerFauxProvider();
	let actualPrompt = "";
	let actualTools: string[] = [];
	faux.setResponses([
		(context) => {
			actualPrompt = context.systemPrompt ?? "";
			actualTools = context.tools?.map((tool) => tool.name) ?? [];
			return fauxAssistantMessage("READY");
		},
	]);
	const executor = vi.spyOn(sandboxModule, "createExecutor").mockImplementation((sandbox) => ({
		getWorkspacePath: (path) => (sandbox.type === "host" ? path : "/workspace"),
		exec: async () => ({ code: 0, stdout: "bash\npython3\n", stderr: "" }),
	}));
	const channelDir = join(root, "work", "channel");
	const goalStore = new GoalStore({
		channelDir,
		controlChannelDir: join(root, "control"),
		limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
		enabled: features.goals,
		acceptanceEnabled: features.acceptance,
		controlsEnabled: features.controls,
	});
	const config: LightClawConfig = {
		features,
		transport: features.feishu ? "feishu" : "slack",
		modelProvider: "faux",
		modelId: "faux",
		maxGoalCycles: 8,
		maxGoalFailures: 2,
		maxStaleCycles: 2,
		maxRunTokens: 1,
		promptInstructions: "CANDIDATE_MARKER",
	};
	if (features.goals)
		await goalStore.create(
			{ objective: "GOAL_MARKER", ownerUserId: "owner", acceptance: { mode: "manual" } },
			new AbortController().signal,
		);
	const noop = async () => {};
	const ctx: ChatContext = {
		message: {
			text: "reply READY",
			rawText: "reply READY",
			user: "owner",
			channel: "channel",
			ts: "1",
			attachments: [],
		},
		channels: [],
		users: [],
		respond: noop,
		replaceMessage: noop,
		respondInThread: noop,
		setTyping: noop,
		setWorking: noop,
		uploadFile: noop,
		deleteMessage: noop,
	};
	const runner = createAgentRunner(
		{ type: "docker", container: "faux-no-docker-exec" },
		"channel",
		channelDir,
		config,
		goalStore,
		{ model: faux.getModel(), apiKey: "faux", quiet: true },
	);
	try {
		const result = await runner.run(ctx, new ChannelStore({ workingDir: join(root, "work") }));
		expect(actualPrompt.includes("GOAL_MARKER")).toBe(features.goals);
		expect(actualTools.includes("goal_complete")).toBe(features.goals);
		expect(actualPrompt.includes("CANDIDATE_MARKER")).toBe(true);
		expect(executor.mock.calls[0]?.[0].type).toBe(features.infrastructure ? "docker" : "host");
		expect(Boolean(result.budgetReason)).toBe(features.controls);
	} finally {
		runner.dispose();
		executor.mockRestore();
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	}
});
