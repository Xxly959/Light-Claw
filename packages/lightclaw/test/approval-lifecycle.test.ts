import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalStore } from "../src/policy/approvals.js";
import { handleApprovalCommand } from "../src/policy/commands.js";

let root: string;
let store: ApprovalStore;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "approval-life-"));
	store = new ApprovalStore({ channelControlDir: root, channelId: "C", ttlMs: 100 });
	vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});
function create(signature = "same") {
	return store.create({
		signature,
		toolName: "bash",
		summary: "action",
		reason: "review",
		capabilities: ["exec"],
		ownerUserId: "owner",
	});
}
it("renews the same expired signature and retains old evidence", () => {
	const old = create();
	vi.advanceTimersByTime(101);
	const fresh = create();
	expect(fresh.id).not.toBe(old.id);
	expect(store.get(old.id)).toBeDefined();
	expect(() => store.approve(old.id, "owner")).toThrow(/过期/);
	expect(() => store.deny(old.id, "owner")).toThrow(/过期/);
	store.approve(fresh.id, "owner");
	expect(store.consume("changed")).toBeUndefined();
	expect(store.consume("same")?.id).toBe(fresh.id);
	expect(store.consume("same")).toBeUndefined();
	expect(store.get(old.id)).toBeDefined();
});
it("expired pending tickets do not consume quota", () => {
	for (let i = 0; i < 20; i++) create(String(i));
	vi.advanceTimersByTime(101);
	expect(() => create("new")).not.toThrow();
	expect(store.pending()).toHaveLength(1);
	const listed = handleApprovalCommand("/approve list", { approvals: store, userId: "owner", origin: "platform" });
	expect(listed.response).toContain("过期");
});
it("deduplicates valid pending and approved operations", () => {
	const first = create();
	expect(create().id).toBe(first.id);
	store.approve(first.id, "owner");
	expect(create().id).toBe(first.id);
	expect(() => store.approve(first.id, "owner")).toThrow();
	expect(store.consume("same")?.id).toBe(first.id);
	expect(create().id).not.toBe(first.id);
	expect(store.get(first.id)?.status).toBe("consumed");
});
it("expired approvals cannot be consumed", () => {
	const first = create();
	store.approve(first.id, "owner");
	vi.advanceTimersByTime(101);
	expect(store.consume("same")).toBeUndefined();
	expect(create().id).not.toBe(first.id);
});
it("fails closed while another process holds the ticket transaction", () => {
	mkdirSync(join(root, "approvals.lock"));
	expect(() => create()).toThrow(/锁/);
});
it("approval returns an exact one-shot continuation", () => {
	const ticket = create();
	const result = handleApprovalCommand(`/approve ${ticket.id}`, {
		approvals: store,
		userId: "owner",
		origin: "platform",
	});
	expect(result.startRun).toBe(true);
	expect(result.retryText).toContain(ticket.id);
	expect(store.consume("same")?.status).toBe("consumed");
});

it("archives terminal history through an authorized command without losing evidence or consuming live approvals", () => {
	const old = create("old");
	const row = JSON.parse(readFileSync(join(root, "approvals.json"), "utf8"));
	row.tickets = Array.from({ length: 200 }, (_, i) => ({
		...row.tickets[0],
		id: i.toString(16).padStart(8, "0"),
		signature: `old-${i}`,
	}));
	writeFileSync(join(root, "approvals.json"), JSON.stringify(row));
	vi.advanceTimersByTime(101);
	expect(() => create("fresh")).toThrow();
	const result = handleApprovalCommand("/approve maintain", {
		approvals: store,
		userId: "owner",
		origin: "platform",
		assertMaintenance: () => {},
	});
	expect(result.response).toContain("200");
	expect(store.list()).toHaveLength(200);
	expect(store.pending()).toHaveLength(0);
	const fresh = create("fresh");
	store.approve(fresh.id, "owner");
	expect(() => store.consume("old-0")).not.toThrow();
	expect(store.consume("old-0")).toBeUndefined();
	expect(store.consume("fresh")?.id).toBe(fresh.id);
	expect(
		handleApprovalCommand("/approve show 00000000", { approvals: store, userId: "owner", origin: "platform" })
			.response,
	).toContain("归档");
	expect(old).toBeDefined();
});
it("denies synthetic and unrelated maintenance and retains valid approved tickets", () => {
	const old = create("old");
	store.approve(old.id, "owner");
	expect(() => store.maintain({ origin: "scheduled", user: "owner" })).toThrow();
	expect(() => store.maintain({ origin: "platform", user: "outsider" })).toThrow();
	expect(store.maintain({ origin: "platform", user: "owner" }).archived).toBe(0);
	expect(store.consume("same")).toBeUndefined();
	expect(store.consume("old")?.id).toBe(old.id);
});
it("does not lose evidence if interrupted after archive publication before active compaction", () => {
	const ticket = create();
	vi.advanceTimersByTime(101);
	const before = readFileSync(join(root, "approvals.json"));
	store.maintain({ origin: "platform", user: "owner" });
	writeFileSync(join(root, "approvals.json"), before);
	expect(store.list()).toHaveLength(1);
	expect(() => store.approve(ticket.id, "owner")).toThrow(/过期/);
	expect(store.maintain({ origin: "platform", user: "owner" }).archived).toBe(1);
	expect(readdirSync(join(root, "approval-archives"))).toHaveLength(1);
	expect(store.get(ticket.id)).toBeDefined();
	expect(create().id).not.toBe(ticket.id);
});

it("fails before mutation on intent-audit failure and can reconcile an applied-audit failure", () => {
	const ticket = create();
	vi.advanceTimersByTime(101);
	const make = (failure: string) =>
		new ApprovalStore({
			channelControlDir: root,
			channelId: "C",
			onMaintenance: (phase) => {
				if (phase === failure) throw new Error("audit unavailable");
			},
		});
	expect(() => make("intent").maintain({ origin: "platform", user: "owner" })).toThrow(/audit/);
	expect(JSON.parse(readFileSync(join(root, "approvals.json"), "utf8")).tickets).toHaveLength(1);
	expect(() => make("applied").maintain({ origin: "platform", user: "owner" })).toThrow(/audit/);
	expect(store.get(ticket.id)?.archiveId).toBeTruthy();
	expect(store.maintain({ origin: "platform", user: "owner" }).archived).toBe(0);
});
