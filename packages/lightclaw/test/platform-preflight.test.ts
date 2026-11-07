import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/acceptance-plan.mjs", import.meta.url));
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scope() {
	return {
		schema: 1,
		platform: "feishu",
		dedicatedApplication: "fictional-app",
		dedicatedConversation: "fictional-chat",
		participants: ["fictional-owner", "fictional-reviewer"],
		credentialInjection: { kind: "file", reference: "/nonexistent/fictional-credentials.json" },
		allowCounts: { send: 12, edit: 2, recall: 2, upload: 2 },
		allowNetworkInterruption: false,
		allowPermissionChange: false,
	};
}
function run(value: unknown, prepare?: (path: string) => string) {
	const root = mkdtempSync(join(tmpdir(), "platform-scope-"));
	roots.push(root);
	const path = join(root, "scope.json");
	writeFileSync(path, JSON.stringify(value));
	return spawnSync(process.execPath, [script, "platform-check", "--scope", prepare ? prepare(path) : path], {
		encoding: "utf8",
		timeout: 10000,
		env: { PATH: process.env.PATH, HOME: root },
	});
}
it("validates a scope without reading the credential reference or exposing identities", () => {
	const result = run(scope());
	expect(result.status, result.stderr).toBe(0);
	const report = JSON.parse(result.stdout);
	expect(report.status).toBe("scope-validated-not-executed");
	expect(report.requiresExplicitUserAuthorization).toBe(true);
	expect(report.credentialReferenceRead).toBe(false);
	expect(report.scopeSha256).toMatch(/^[a-f0-9]{64}$/);
	expect(report.allowCounts).toEqual(scope().allowCounts);
	expect(result.stdout).not.toContain("fictional");
	expect(result.stdout).not.toContain("nonexistent");
});
it("accepts an environment injection reference without reading inherited credentials", () => {
	const value = scope();
	value.credentialInjection = { kind: "environment", reference: "DEDICATED_FEISHU_ENV" };
	const result = run(value);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).not.toContain("DEDICATED");
});
it.each([
	{ ...scope(), dedicatedApplication: null },
	{ ...scope(), dedicatedConversation: "" },
	{ ...scope(), participants: [] },
	{ ...scope(), participants: ["same", "same"] },
	{ ...scope(), allowCounts: { send: 0, edit: 0, recall: 0, upload: 0 } },
	{ ...scope(), allowCounts: { ...scope().allowCounts, send: -1 } },
	{ ...scope(), allowCounts: { ...scope().allowCounts, edit: 0.5 } },
	{ ...scope(), allowCounts: { ...scope().allowCounts, recall: Number.MAX_SAFE_INTEGER + 1 } },
	{ ...scope(), allowCounts: { send: 1 } },
	{ ...scope(), allowNetworkInterruption: "yes" },
	{ ...scope(), credentialInjection: { kind: "file", reference: "relative.json" } },
	{ ...scope(), credentialInjection: { kind: "inline", reference: "FICTIONAL_SECRET" } },
	{ ...scope(), appSecret: "FICTIONAL_SECRET" },
])("rejects incomplete or unsafe scope %# without disclosing values", (value) => {
	const result = run(value);
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain("NOT READY");
	expect(result.stderr + result.stdout).not.toContain("FICTIONAL_SECRET");
});
it.each(["symlink", "hardlink"])("refuses %s scope files", (kind) => {
	const result = run(scope(), (path) => {
		const link = `${path}.linked`;
		if (kind === "symlink") symlinkSync(path, link);
		else linkSync(path, link);
		return link;
	});
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain("NOT READY");
});
it("rejects oversized or malformed manifests without echoing their contents", () => {
	for (const content of ["x".repeat(65537), '{"secret":"FICTIONAL_SECRET",']) {
		const result = run(scope(), (path) => {
			writeFileSync(path, content);
			return path;
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("NOT READY");
		expect(result.stderr).not.toContain("FICTIONAL_SECRET");
	}
});
it("keeps the original nonexecuting plan available and includes the prompt card case", () => {
	const result = spawnSync(process.execPath, [script, "platform"], { encoding: "utf8" });
	expect(result.status, result.stderr).toBe(0);
	const plan = JSON.parse(result.stdout);
	expect(plan.status).toBe("pending-user-authorization");
	expect(plan.allowCounts.send).toBe(0);
	expect(plan.cases).toContain(
		"prompt composer: explicit submit mode, actor/chat/card binding, unchanged input or structured rewrite preview, edit and confirm before execution",
	);
});
it("provides a blank scope example with no implicit live allowances", () => {
	const example = JSON.parse(readFileSync(new URL("../scripts/platform-scope.example.json", import.meta.url), "utf8"));
	expect(example.allowCounts).toEqual({ send: 0, edit: 0, recall: 0, upload: 0 });
	expect(example.dedicatedApplication).toBeNull();
	expect(example.participants).toEqual([]);
});
