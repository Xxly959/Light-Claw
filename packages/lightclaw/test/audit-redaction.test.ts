import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { appendAuditEvent } from "../src/observability.js";

it("redacts common credentials from failure details without hiding the failure", () => {
	const root = mkdtempSync(join(tmpdir(), "audit-redaction-"));
	try {
		appendAuditEvent(root, {
			type: "run_finished",
			channelId: "channel",
			stopReason: "error",
			detail: "request failed: Bearer secret-authorization; api_key=private-value; sk-fakekey123456789",
		});
		const text = readFileSync(join(root, "audit/runs.jsonl"), "utf8");
		expect(text).not.toContain("secret-authorization");
		expect(text).not.toContain("private-value");
		expect(text).not.toContain("sk-fakekey123456789");
		expect(JSON.parse(text)).toMatchObject({ type: "run_finished", stopReason: "error", channelId: "channel" });
		expect(JSON.parse(text).detail).toContain("request failed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
