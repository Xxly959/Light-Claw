import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DurableInbox } from "../src/durable-inbox.js";
import { OperationJournal } from "../src/operations.js";
import { handleRecoveryCommand } from "../src/recovery-control.js";
import type { ChatEvent } from "../src/transport.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "recovery-control-"));
	roots.push(root);
	const inbox = new DurableInbox(root);
	const event: ChatEvent = { origin: "platform", type: "dm", user: "owner", channel: "C", ts: "1", text: "action" };
	const r = inbox.admit("feishu", event, false, 300000);
	inbox.start(r.id);
	inbox.finish(r.id, "unknown", "after tool dispatch; side effects uncertain");
	const record = inbox.get(r.id)!;
	const audit: unknown[] = [];
	const context = {
		inbox,
		event,
		adminUserIds: ["admin"],
		trustedUserIds: [],
		assertExclusive() {},
		audit: (entry: unknown) => {
			audit.push(entry);
		},
	};
	return { inbox, record, context, audit };
}
it("lists source, state version, failure detail and side effects", () => {
	const { record, context } = fixture();
	const result = handleRecoveryCommand("/recover list", context);
	expect(result?.response).toContain(record.id);
	expect(result?.response).toContain("unknown");
	expect(result?.response).toContain("副作用");
	expect(result?.response).toContain("feishu");
});
it("marks reconciled without replay and unblocks only that channel's resolved record", () => {
	const { inbox, record, context, audit } = fixture();
	const other = inbox.admit("feishu", { ...record.event, ts: "2" }, false, 300000);
	inbox.start(other.id);
	inbox.finish(other.id, "unknown");
	handleRecoveryCommand(`/recover resolve ${record.id} ${record.revision} verified externally`, context);
	expect(inbox.get(record.id)?.status).toBe("completed");
	expect(inbox.unresolvedChannels().has("C")).toBe(true);
	expect(audit.length).toBeGreaterThan(0);
});
it("requires explicit duplicate-risk acknowledgement and rejects stale revisions", () => {
	const { record, context, inbox } = fixture();
	expect(() => handleRecoveryCommand(`/recover retry ${record.id} ${record.revision} no`, context)).toThrow();
	handleRecoveryCommand(`/recover retry ${record.id} ${record.revision} ACK_DUPLICATE_RISK checked`, context);
	expect(inbox.get(record.id)?.status).toBe("queued");
	expect(() => handleRecoveryCommand(`/recover resolve ${record.id} ${record.revision} old`, context)).toThrow();
});
it.each(["other", "synthetic", "busy", "audit"])("fails closed for %s", (mode) => {
	const { record, context, inbox } = fixture();
	const before = inbox.get(record.id);
	if (mode === "other") context.event.user = "stranger";
	if (mode === "synthetic") context.event.origin = "recovery";
	if (mode === "busy")
		context.assertExclusive = () => {
			throw new Error("instance/channel busy");
		};
	if (mode === "audit")
		context.audit = () => {
			throw new Error("audit unavailable");
		};
	expect(() => handleRecoveryCommand(`/recover resolve ${record.id} ${record.revision} check`, context)).toThrow();
	expect(inbox.get(record.id)).toEqual(before);
});
it("cannot operate across channel boundaries", () => {
	const { record, context } = fixture();
	context.event.channel = "other";
	expect(() => handleRecoveryCommand(`/recover resolve ${record.id} ${record.revision} check`, context)).toThrow();
});

it("reconciles operation-journal records with identity, version and duplicate risk", async () => {
	const { context, inbox } = fixture();
	const operations = new OperationJournal(join(roots.at(-1)!, "operations"));
	const op = await operations.execute(
		"notification:C:platform:1",
		"final",
		{ status: "completed" },
		{
			replaySafe: false,
			query: async () => ({ status: "unknown" }),
			execute: async () => {
				throw new Error("notification outcome unknown");
			},
		},
		"owner",
	);
	const input = { ...context, operations };
	expect(handleRecoveryCommand("/recover operations", input)?.response).toContain(op.id);
	expect(() => handleRecoveryCommand(`/recover op-retry ${op.id} ${op.revision} checked`, input)).toThrow();
	const retried = handleRecoveryCommand(`/recover op-retry ${op.id} ${op.revision} ACK_DUPLICATE_RISK checked`, input);
	expect(retried?.operationRetry?.status).toBe("prepared");
	expect(operations.get(op.id)?.revision).not.toBe(op.revision);
	expect(inbox.unresolvedChannels().has("C")).toBe(true);
});
