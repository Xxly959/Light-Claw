import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DurableInbox } from "../src/durable-inbox.js";
import { OperationJournal, type OperationService } from "../src/operations.js";
import type { ChatEvent } from "../src/transport.js";

const roots: string[] = [];
afterEach(() => {
	for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function root() {
	const p = mkdtempSync(join(tmpdir(), "lightclaw-durable-"));
	roots.push(p);
	return p;
}
const event: ChatEvent = {
	origin: "platform",
	type: "dm",
	channel: "channel",
	user: "fictional",
	ts: "1",
	text: "work",
};
it("recovers queued work, preserves deduplication and quarantines interrupted execution", () => {
	const dir = root();
	const first = new DurableInbox(dir);
	const a = first.admit("slack", event, false, 60_000);
	const b = first.admit("slack", { ...event, ts: "2" }, false, 60_000);
	first.start(a.id);
	const next = new DurableInbox(dir);
	const queued = next.recover();
	expect(queued.map((r) => r.id)).toEqual([b.id]);
	expect(next.get(a.id)?.status).toBe("unknown");
	expect(next.admit("slack", event, false, 60_000).id).toBe(a.id);
	expect(next.get(a.id)?.status).toBe("unknown");
	expect(() => next.retry(a.id)).toThrow("manual");
	next.retry(a.id, true);
	next.start(a.id);
	next.finish(a.id, "dead", "injected");
	next.retry(a.id, true);
	next.start(a.id);
	next.finish(a.id, "dead", "injected");
	const manuallyQueued = next.retry(a.id, true);
	expect(manuallyQueued.status).toBe("queued");
	expect(manuallyQueued.attempts).toBeGreaterThan(0);
	expect(manuallyQueued.manualRetries).toBeGreaterThan(0);
});
it("retains expired and rejected outcomes and refuses changed payload for a duplicate identity", () => {
	const inbox = new DurableInbox(root());
	const item = inbox.admit("feishu", event, true, 1, 100);
	expect(inbox.recover(102)).toEqual([]);
	expect(inbox.get(item.id)?.status).toBe("expired");
	expect(() => inbox.admit("feishu", { ...event, text: "changed" }, true, 10)).toThrow("identity");
});
it("uses stable external IDs, queries uncertain effects, and never silently retries an unknown service", async () => {
	const dir = root();
	let writes = 0;
	const effects = new Map<string, unknown>();
	const service: OperationService = {
		replaySafe: true,
		execute: async (id, request) => {
			writes++;
			effects.set(id, request);
			throw new Error("response lost after external success");
		},
		query: async (id) => (effects.has(id) ? { status: "found", result: effects.get(id) } : { status: "absent" }),
	};
	const first = await new OperationJournal(dir).execute("goal", "step-1", { value: 1 }, service);
	expect(first.status).toBe("unknown");
	const next = await new OperationJournal(dir).execute("goal", "step-1", { value: 1 }, service);
	expect(next.status).toBe("succeeded");
	expect(next.id).toBe(first.id);
	expect(writes).toBe(1);
	await expect(new OperationJournal(dir).execute("goal", "step-1", { value: 2 }, service)).rejects.toThrow("request");
	const unknown: OperationService = {
		replaySafe: false,
		execute: async () => {
			throw new Error("lost");
		},
		query: async () => ({ status: "unknown" }),
	};
	const journal = new OperationJournal(dir);
	await journal.execute("goal", "unknown", {}, unknown);
	expect((await new OperationJournal(dir).execute("goal", "unknown", {}, unknown)).status).toBe("manual");
});
it("serializes concurrent callers and safely reuses a saved success before notification", async () => {
	const journal = new OperationJournal(root());
	let writes = 0;
	const service: OperationService = {
		replaySafe: true,
		query: async () => ({ status: "absent" }),
		execute: async () => {
			writes++;
			return { receipt: "r1" };
		},
	};
	const records = await Promise.all([
		journal.execute("task", "send", {}, service),
		journal.execute("task", "send", {}, service),
	]);
	expect(records.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
	expect(writes).toBe(1);
});
