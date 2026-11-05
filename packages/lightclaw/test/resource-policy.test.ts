import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { downloadAttachment } from "../src/attachment-download.js";
import { resolveAuditDirectory } from "../src/audit/storage.js";
import { writeDurableJson } from "../src/durable-state.js";
import * as log from "../src/log.js";
import { appendAuditEvent } from "../src/observability.js";
import { diagnosticText, redactDiagnosticValue, redactSecrets } from "../src/redaction.js";
import { assertResourceCapacity, pruneManagedResources, writePromptDiagnostic } from "../src/resource-policy.js";
import { createSdkLogger } from "../src/sdk-logger.js";
import { ChannelStore } from "../src/store.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});
const roots: string[] = [];
function root(): string {
	const value = mkdtempSync(join(tmpdir(), "lightclaw-resource-"));
	roots.push(value);
	return value;
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const secret =
	'Authorization: Bearer fictional-bearer; {"api_key":"fictional-api", "password":"fictional-password"} https://person:fictional-pass@example.invalid/file?token=fictional-query&safe=1\n-----BEGIN PRIVATE KEY-----\nfictional-key\n-----END PRIVATE KEY-----';
it("redacts quoted assignments, headers, signed URLs, URL auth and PEM consistently", () => {
	const value = redactSecrets(secret);
	for (const part of [
		"fictional-bearer",
		"fictional-api",
		"fictional-password",
		"fictional-pass",
		"fictional-query",
		"fictional-key",
	])
		expect(value).not.toContain(part);
	expect(value).toContain("safe=1");
});
it("defaults diagnostics/console to metadata and bounds redacted debug", () => {
	const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
	log.logUserMessage({ channelId: "C" }, secret);
	log.logToolStart({ channelId: "C" }, "bash", secret, { command: secret });
	log.logToolSuccess({ channelId: "C" }, "bash", 1, secret);
	log.logAgentError("system", secret);
	expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("fictional-");
	expect(diagnosticText("plain private business text")).not.toContain("business");
	vi.stubEnv("LIGHTCLAW_DEBUG_PAYLOADS", "1");
	expect(diagnosticText(secret)).not.toContain("fictional-");
	expect(diagnosticText("x".repeat(9000)).length).toBeLessThan(5000);
});
it("audit redacts every field and critical write failures fail closed", () => {
	const dir = root();
	appendAuditEvent(dir, { type: "delivery_failed", channelId: secret, detail: secret });
	expect(readFileSync(join(resolveAuditDirectory(dir), "runs.jsonl"), "utf8")).not.toContain("fictional-");
	rmSync(resolveAuditDirectory(dir), { recursive: true });
	writeFileSync(resolveAuditDirectory(dir), "blocked");
	expect(() => appendAuditEvent(dir, { type: "run_finished", channelId: "C" })).toThrow();
});
it("prompt capture is opt-in, redacted and expires without pruning control state", () => {
	const dir = root();
	writePromptDiagnostic(dir, { prompt: secret });
	expect(existsSync(join(dir, "last_prompt.jsonl"))).toBe(false);
	vi.stubEnv("LIGHTCLAW_DEBUG_PAYLOADS", "1");
	writePromptDiagnostic(dir, { prompt: secret });
	expect(readFileSync(join(dir, "last_prompt.jsonl"), "utf8")).not.toContain("fictional-");
	writeFileSync(join(dir, "goal.json"), "preserve");
	utimesSync(join(dir, "last_prompt.jsonl"), 0, 0);
	pruneManagedResources(dir, "diagnostic");
	expect(existsSync(join(dir, "last_prompt.jsonl"))).toBe(false);
	expect(existsSync(join(dir, "goal.json"))).toBe(true);
});
it("mandatory message admission preserves raw text, fails closed and remains retryable on quota", async () => {
	const dir = root();
	const store = new ChannelStore({ workingDir: dir });
	vi.stubEnv("LIGHTCLAW_HISTORY_MAX_BYTES", "20");
	const message = { date: new Date().toISOString(), ts: "1", user: "u", text: secret, attachments: [], isBot: false };
	await expect(store.logMessage("C", message)).rejects.toThrow(/quota/i);
	vi.stubEnv("LIGHTCLAW_HISTORY_MAX_BYTES", "10000");
	expect(await store.logMessage("C", message)).toBe(true);
	expect(readFileSync(join(dir, "C/log.jsonl"), "utf8")).toContain("fictional-api");
});
it("attachment and archive quotas do not delete unknown/control files", () => {
	const dir = root();
	mkdirSync(join(dir, "control"));
	writeFileSync(join(dir, "control/goal.json"), "preserve");
	writeFileSync(join(dir, "lightclaw-exec-old.log"), "old");
	utimesSync(join(dir, "lightclaw-exec-old.log"), 0, 0);
	pruneManagedResources(dir, "archive");
	expect(existsSync(join(dir, "lightclaw-exec-old.log"))).toBe(false);
	expect(existsSync(join(dir, "control/goal.json"))).toBe(true);
	vi.stubEnv("LIGHTCLAW_ARCHIVE_MAX_BYTES", "2");
	expect(() => assertResourceCapacity(dir, 3, "archive")).toThrow(/quota/i);
});
it("download counts streamed bytes before buffer growth and persists no partial file", async () => {
	const dir = root();
	vi.stubEnv("LIGHTCLAW_ATTACHMENT_MAX_BYTES", "4");
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(3));
			controller.enqueue(new Uint8Array(3));
		},
		cancel() {
			cancelled = true;
		},
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(body)),
	);
	await expect(
		downloadAttachment(join(dir, "file.bin"), "https://example.invalid/file", "fictional-token"),
	).rejects.toThrow(/size/i);
	expect(cancelled).toBe(true);
	expect(existsSync(join(dir, "file.bin"))).toBe(false);
});
it("download timeout cancels a stalled stream", async () => {
	const dir = root();
	vi.stubEnv("LIGHTCLAW_DOWNLOAD_TIMEOUT_MS", "10");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(new ReadableStream<Uint8Array>())),
	);
	await expect(
		downloadAttachment(join(dir, "file.bin"), "https://example.invalid/file", "fictional-token"),
	).rejects.toThrow(/timeout/i);
	expect(existsSync(join(dir, "file.bin"))).toBe(false);
});

it("SDK callback logger bounds volume and omits raw error objects", () => {
	const sink = vi.spyOn(console, "log").mockImplementation(() => {});
	const logger = createSdkLogger("fixture");
	for (let i = 0; i < 100; i++) logger.error(new Error(secret), { api_key: "fictional-nested" });
	expect(sink.mock.calls.length).toBeLessThanOrEqual(40);
	expect(JSON.stringify(sink.mock.calls)).not.toContain("fictional-");
});
it("ENOSPC in mandatory history fails closed without poisoning dedupe", async () => {
	const dir = root();
	const store = new ChannelStore({ workingDir: dir });
	const fail = vi.spyOn(fs, "appendFileSync").mockImplementationOnce(() => {
		throw Object.assign(new Error("full"), { code: "ENOSPC" });
	});
	const message = {
		date: new Date().toISOString(),
		ts: "space",
		user: "u",
		text: "retry",
		attachments: [],
		isBot: false,
	};
	await expect(store.logMessage("C", message)).rejects.toThrow("full");
	fail.mockRestore();
	expect(await store.logMessage("C", message)).toBe(true);
});

it("mandatory durable state quota preserves previous control state without pruning", () => {
	const dir = root();
	const path = join(dir, "goal.json");
	writeDurableJson(path, { status: "active" });
	vi.stubEnv("LIGHTCLAW_STATE_MAX_BYTES", "8");
	expect(() => writeDurableJson(path, { status: "completed" })).toThrow(/quota/);
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ status: "active" });
});

it("structured diagnostic snapshots have a shared total budget", () => {
	const data = Array.from({ length: 100 }, () => ({ value: "x".repeat(4096) }));
	expect(JSON.stringify(redactDiagnosticValue(data)).length).toBeLessThan(100_000);
});

it("rejects an oversized attachment batch atomically and permits the next download", async () => {
	const dir = root();
	const store = new ChannelStore({ workingDir: dir, botToken: "fictional-token" });
	vi.stubEnv("LIGHTCLAW_DOWNLOAD_QUEUE_MAX", "1");
	const fetchMock = vi.fn(async () => new Response("complete attachment"));
	vi.stubGlobal("fetch", fetchMock);
	expect(() =>
		store.processAttachments(
			"C",
			[
				{ name: "first.txt", url_private: "https://example.invalid/first" },
				{ name: "second.txt", url_private: "https://example.invalid/second" },
			],
			"1",
		),
	).toThrow("Attachment download queue full");
	expect(fetchMock).not.toHaveBeenCalled();
	const accepted = store.processAttachments(
		"C",
		[{ name: "next.txt", url_private: "https://example.invalid/next" }],
		"2",
	);
	expect(accepted).toEqual([{ original: "next.txt", local: "C/attachments/2_next.txt" }]);
	await vi.waitFor(() => expect(existsSync(join(dir, accepted[0].local))).toBe(true));
	expect(readFileSync(join(dir, accepted[0].local), "utf8")).toBe("complete attachment");
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(existsSync(join(dir, "C/attachments/1_first.txt"))).toBe(false);
});
