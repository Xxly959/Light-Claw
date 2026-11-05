import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DurableInbox } from "../../src/durable-inbox.js";
import { acquireControlLock } from "../../src/goals/control.js";
import { GoalStore } from "../../src/goals/store.js";
import { OperationJournal, type OperationQuery, type OperationService } from "../../src/operations.js";

const [root, endpoint, phase] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error("Mock loopback endpoint required");
const lock = acquireControlLock(join(root, "control"));
const inbox = new DurableInbox(join(root, "control", "inbox"));
const record = inbox.admit(
	"mock",
	{ origin: "platform", channel: "channel", type: "dm", ts: "message-1", user: "fictional", text: "controlled step" },
	false,
	60_000,
);
const goals = new GoalStore({
	channelDir: join(root, "workspace", "channel"),
	controlChannelDir: join(root, "control", "channel"),
	limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
});
if (!goals.get())
	await goals.create(
		{
			objective: "controlled fictional effect",
			ownerUserId: "fictional",
			acceptance: { mode: "manual" },
		},
		new AbortController().signal,
	);
const checkpoint = async (name: string) => {
	console.log(name);
	await new Promise<void>(() => {
		setInterval(() => {}, 1000);
	});
};
if (phase === "queued") await checkpoint("QUEUED");
const service: OperationService = {
	replaySafe: true,
	query: async (id) => (await (await fetch(`${endpoint}/operations/${id}`)).json()) as OperationQuery,
	execute: async (id, request) => {
		if (phase === "before-operation") await checkpoint("BEFORE_OPERATION");
		const response = await fetch(`${endpoint}/operations/${id}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
		});
		if (!response.ok) throw new Error(`mock service error ${response.status}`);
		const receipt: unknown = await response.json();
		if (phase === "effect-before-progress") await checkpoint("EFFECT_SAVED");
		return receipt;
	},
};
inbox.recover();
if (inbox.get(record.id)?.status === "queued") inbox.start(record.id);
const result = await new OperationJournal(join(root, "control", "operations")).execute(
	"goal-id",
	"business-step-1",
	{ action: "fictional-credit", amount: 7 },
	service,
);
if (result.status !== "succeeded") throw new Error(`unresolved ${result.status}`);
if (goals.get()?.status !== "completed") {
	const completion = await goals.requestCompletion(
		{
			summary: "mock effect reconciled",
			evidence: [result.id],
			deliverables: { kind: "none", reason: "external mock receipt" },
		},
		{
			channelDir: join(root, "workspace", "channel"),
			sandbox: { type: "host" },
			signal: new AbortController().signal,
			assertActive: () => {},
			reserveCommand: () => ({ timeoutSeconds: 1 }),
			executor: {
				getWorkspacePath: (path) => path,
				exec: async () => {
					throw new Error("mock flow has no shell command");
				},
			},
		},
	);
	if (!completion.goal) throw new Error("missing goal completion");
	await goals.confirm(completion.goal.id, completion.report.attemptId, "fictional", new AbortController().signal);
}
writeFileSync(join(root, "saved-result.json"), JSON.stringify(result));
if (phase === "state-before-notification") await checkpoint("STATE_SAVED");
writeFileSync(join(root, "notification.json"), JSON.stringify({ operationId: result.id, receipt: result.result }));
inbox.finish(record.id, "completed", "controlled mock result reconciled; no arbitrary shell replay");
console.log("DONE");
lock.release();
