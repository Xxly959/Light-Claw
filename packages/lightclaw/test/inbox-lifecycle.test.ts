import * as fs from "node:fs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DurableInbox } from "../src/durable-inbox.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "inbox-life-"));
	roots.push(root);
	return { root, inbox: new DurableInbox(root) };
}
const event = (ts: string) => ({
	origin: "platform" as const,
	type: "dm" as const,
	channel: "C",
	user: "owner",
	text: "fictional payload",
	ts,
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("archives terminal payloads but retains deduplication across restart", () => {
	const { root, inbox } = fixture();
	const r = inbox.admit("faux", event("1"), false, 300000);
	inbox.finish(r.id, "completed");
	const result = inbox.maintain(Date.now(), "C");
	expect(result.archived).toBe(1);
	expect(inbox.list()).toHaveLength(0);
	expect(existsSync(join(root, `${r.id}.json`))).toBe(false);
	const restarted = new DurableInbox(root);
	expect(restarted.admit("faux", event("1"), false, 300000).status).toBe("completed");
	expect(() => restarted.admit("faux", { ...event("1"), text: "changed" }, false, 300000)).toThrow(/identity/);
	expect(readdirSync(join(root, ".archives")).some((name) => name.endsWith(".gz"))).toBe(true);
});
it("never cleans pending, running, unknown or dead records", () => {
	const { inbox } = fixture();
	for (const [ts, status] of [
		["q", "queued"],
		["r", "running"],
		["u", "unknown"],
		["d", "dead"],
	] as const) {
		const r = inbox.admit("faux", event(ts), false, 300000);
		if (status === "running") inbox.start(r.id);
		else if (status !== "queued") inbox.finish(r.id, status);
	}
	inbox.maintain(Date.now() + 40 * 86400000, "C");
	expect(
		inbox
			.list()
			.map((r) => r.status)
			.sort(),
	).toEqual(["dead", "queued", "running", "unknown"]);
});
it("has an explicit dedupe horizon and can compact after it", () => {
	const { inbox } = fixture();
	vi.stubEnv("LIGHTCLAW_INBOX_DEDUPE_HOURS", "1");
	const r = inbox.admit("faux", event("1"), false, 300000);
	inbox.finish(r.id, "completed");
	const now = Date.now();
	inbox.maintain(now, "C");
	expect(inbox.admit("faux", event("1"), false, 300000, now + 1000).status).toBe("completed");
	inbox.maintain(now + 3600001, "C");
	expect(inbox.admit("faux", event("1"), false, 300000, now + 3600001).status).toBe("queued");
});
it("does not reread all historical JSON for each message", () => {
	const { inbox } = fixture();
	for (let n = 0; n < 64; n++) {
		const r = inbox.admit("faux", event(String(n)), false, 300000);
		inbox.finish(r.id, "completed");
	}
	const reads = vi.spyOn(fs, "readFileSync");
	reads.mockClear();
	inbox.unresolvedChannels();
	inbox.list();
	inbox.admit("faux", event("new"), false, 300000);
	expect(reads.mock.calls.length).toBeLessThanOrEqual(1);
});
it("fails closed at capacity and exposes actionable maintenance status", () => {
	const { inbox } = fixture();
	vi.stubEnv("LIGHTCLAW_INBOX_MAX_RECORDS", "1");
	const r = inbox.admit("faux", event("1"), false, 300000);
	expect(() => inbox.admit("faux", event("2"), false, 300000)).toThrow(/capacity|容量/);
	expect(inbox.capacity().warning).toBe(true);
	inbox.finish(r.id, "completed");
	inbox.maintain(Date.now(), "C");
	expect(() => inbox.admit("faux", event("2"), false, 300000)).not.toThrow();
});
it("prefers an active record if interrupted archival left both a tombstone and active payload", () => {
	const { root, inbox } = fixture();
	const r = inbox.admit("faux", event("1"), false, 300000);
	inbox.finish(r.id, "completed");
	const original = readFileSync(join(root, `${r.id}.json`));
	inbox.maintain(Date.now(), "C");
	writeFileSync(join(root, `${r.id}.json`), original);
	const restarted = new DurableInbox(root);
	expect(restarted.get(r.id)?.status).toBe("completed");
	expect(restarted.maintain(Date.now(), "C").archived).toBe(1);
});

it("keeps only dedupe identity in tombstones, not prepared attachment payloads", () => {
	const { root, inbox } = fixture();
	const e = event("prepared");
	const r = inbox.admit("faux", e, false, 300000);
	inbox.start(r.id);
	inbox.recordPrepared(r.id, {
		...e,
		text: "PRIVATE_PREPARED",
		attachments: [{ local: "secret", original: "secret" }],
	});
	inbox.finish(r.id, "completed");
	inbox.maintain(Date.now(), "C");
	const body = readFileSync(join(root, ".dedupe", `${r.id}.json`), "utf8");
	expect(body).not.toContain("PRIVATE_PREPARED");
	expect(body).not.toContain('"preparedEvent"');
});
