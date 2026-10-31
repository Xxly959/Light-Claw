import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAuditEvent } from "../src/observability.js";

describe("运行审计", () => {
	const directories: string[] = [];
	afterEach(() => {
		for (const directory of directories) {
			if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
		}
	});

	it("写入不包含对话正文的结构化指标", () => {
		const directory = mkdtempSync(join(tmpdir(), "lightclaw-audit-"));
		directories.push(directory);
		appendAuditEvent(directory, {
			type: "run_finished",
			channelId: "channel-1",
			goalId: "goal-1",
			durationMs: 120,
			toolCalls: 2,
			inputTokens: 100,
			outputTokens: 20,
		});
		const entry = JSON.parse(readFileSync(join(directory, "audit", "runs.jsonl"), "utf8"));
		expect(entry).toMatchObject({ type: "run_finished", toolCalls: 2, inputTokens: 100 });
		expect(entry.timestamp).toBeTypeOf("string");
		expect(JSON.stringify(entry)).not.toContain("OPENAI_API_KEY");
	});
});
