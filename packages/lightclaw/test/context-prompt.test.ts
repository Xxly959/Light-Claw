import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { expect, it } from "vitest";
import { syncLogToSessionManager } from "../src/context.js";

it.each([true, false])("excludes only Feishu composer commands when explicitly enabled: %s", (excludePromptForms) => {
	const root = mkdtempSync(join(tmpdir(), "context-prompt-"));
	try {
		const texts = [
			"/prompt",
			"  /prompt 原始预填  ",
			"任务入口",
			"/prompt-entry",
			"/prompter 是普通文字",
			"正文提及 /prompt",
			"普通历史",
		];
		const source = `${texts
			.map((text, i) => JSON.stringify({ date: "2026-11-06T00:00:00Z", ts: String(i), user: "owner", text }))
			.join("\n")}\n`;
		writeFileSync(join(root, "log.jsonl"), source);
		const session = SessionManager.inMemory(root);
		expect(syncLogToSessionManager(session, root, undefined, { excludePromptForms })).toBe(
			excludePromptForms ? 3 : 7,
		);
		const payload = JSON.stringify(session.buildSessionContext().messages);
		expect(payload.includes("原始预填")).toBe(!excludePromptForms);
		for (const text of texts.slice(4)) expect(payload).toContain(text);
		expect(syncLogToSessionManager(session, root, undefined, { excludePromptForms })).toBe(0);
		expect(readFileSync(join(root, "log.jsonl"), "utf8")).toBe(source);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
