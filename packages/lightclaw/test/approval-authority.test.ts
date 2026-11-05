import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ApprovalStore } from "../src/policy/approvals.js";
import { handleApprovalCommand } from "../src/policy/commands.js";
import { resolveTrust } from "../src/policy/trust.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "approval-authority-"));
	roots.push(root);
	const options = { channelControlDir: root, channelId: "C", trustedUserIds: ["trusted"], adminUserIds: ["admin"] };
	const store = new ApprovalStore(options);
	const ticket = store.create({
		signature: "s",
		toolName: "write",
		summary: "write",
		reason: "untrusted requester",
		capabilities: ["fs:write"],
		ownerUserId: "outsider",
		taskCreatorUserId: "creator",
	});
	return { store, ticket, options };
}
it.each(["outsider", "creator"])("does not let %s self-approve a downgraded operation", (user) => {
	const { store, ticket } = fixture();
	expect(() => store.approve(ticket.id, user)).toThrow(/权限/);
	expect(() =>
		handleApprovalCommand(`/approve ${ticket.id}`, {
			approvals: store,
			origin: "platform",
			userId: user,
			trustedUserIds: ["trusted"],
			ownerUserId: user,
		}),
	).toThrow(/权限/);
	expect(store.get(ticket.id)?.status).toBe("pending");
});
it.each(["trusted", "admin"])("lets configured %s approve and preserves requester on continuation", (user) => {
	const { options, ticket } = fixture();
	const restarted = new ApprovalStore(options);
	const result = handleApprovalCommand(`/approve ${ticket.id}`, {
		approvals: restarted,
		origin: "platform",
		userId: user,
		trustedUserIds: ["trusted"],
		adminUserIds: ["admin"],
	});
	expect(result.startRun).toBe(true);
	expect(result.executionUserId).toBe("outsider");
	expect(restarted.consume("s")?.id).toBe(ticket.id);
});
it("retains personal confirmation without a trusted list", () => {
	const { options, ticket } = fixture();
	const personal = new ApprovalStore({ ...options, trustedUserIds: [] });
	expect(personal.approve(ticket.id, "creator").status).toBe("approved");
});
it.each(["scheduled", "recovery", "continuation"] as const)("does not elevate %s provenance", (origin) => {
	expect(resolveTrust({ origin, user: "outsider", trustedUserIds: ["trusted"] })).toBe("untrusted");
});
it("synthetic identities cannot approve even if trusted", () => {
	const { store, ticket } = fixture();
	expect(() =>
		handleApprovalCommand(`/approve ${ticket.id}`, {
			approvals: store,
			origin: "recovery",
			userId: "trusted",
			trustedUserIds: ["trusted"],
		}),
	).toThrow();
});
