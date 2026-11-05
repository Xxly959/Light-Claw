import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAuditDirectory } from "../src/audit/storage.js";
import {
	appendToolAuditEvent,
	extractExitCode,
	resolvePayloadMode,
	writeToolPayload,
} from "../src/audit/tool-audit.js";
import type { LightClawConfig } from "../src/config.js";
import { buildIsolationReport } from "../src/isolation.js";
import { isRetryableModelError, ModelRouter } from "../src/model-router.js";
import { ApprovalStore } from "../src/policy/approvals.js";
import { handleApprovalCommand } from "../src/policy/commands.js";
import { SpanRecorder } from "../src/telemetry/spans.js";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "audit-routing-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		// 清理失败（沙箱禁止删除临时目录）不代表功能失败，只影响磁盘残留。
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {}
	}
});

const baseEvent = {
	runId: "run-1",
	channelId: "C1",
	toolCallId: "call-1",
	toolName: "bash",
	capabilities: ["exec"],
	trust: "trusted",
	decision: "allow" as const,
	argsDigest: "d".repeat(64),
	argsSummary: "bash: ls",
	outcome: "ok" as const,
	durationMs: 12,
};

describe("两级审计", () => {
	it("摘要写入 JSONL 并脱敏凭据", () => {
		const root = tempRoot();
		appendToolAuditEvent(root, {
			...baseEvent,
			argsSummary: "bash: curl -H 'Authorization: Bearer secret-token' sk-live-abcdefgh",
		});
		const text = readFileSync(join(resolveAuditDirectory(root), "tool-calls.jsonl"), "utf8");
		expect(text).not.toContain("secret-token");
		expect(text).not.toContain("sk-live-abcdefgh");
		const parsed = JSON.parse(text.trim());
		expect(parsed).toMatchObject({ runId: "run-1", toolName: "bash", outcome: "ok" });
		expect(parsed.ts).toBeTruthy();
	});

	it("digest 模式不落原文，full 模式落盘且权限 0600", () => {
		const root = tempRoot();
		expect(writeToolPayload(root, "run-1", "call-1", { args: { command: "ls" } }, "digest")).toBeUndefined();

		const path = writeToolPayload(root, "run-1", "call-1", { args: { command: "ls" } }, "full");
		expect(path).toBeTruthy();
		expect(statSync(path!).mode & 0o777).toBe(0o600);
		expect(readFileSync(path!, "utf8")).toContain("ls");
	});

	it("把模型给的 toolCallId 转成安全路径片段", () => {
		const root = tempRoot();
		const path = writeToolPayload(root, "run-1", "../../escape", { args: {} }, "full");
		expect(path).toBeTruthy();
		expect(path!.startsWith(join(resolveAuditDirectory(root), "payloads", "run-1"))).toBe(true);
		expect(path).not.toContain("..");
	});

	it("拒绝非法的原文模式", () => {
		expect(resolvePayloadMode({})).toBe("digest");
		expect(() => resolvePayloadMode({ LIGHTCLAW_AUDIT_PAYLOAD_MODE: "everything" })).toThrow("只能是");
	});

	it("从错误文本提取退出码", () => {
		expect(extractExitCode("boom\n\nCommand exited with code 2")).toBe(2);
		expect(extractExitCode("no code here")).toBeUndefined();
	});
});

describe("链路追踪", () => {
	it("工具 span 的父 span 指向 run span", () => {
		const root = tempRoot();
		const recorder = new SpanRecorder({ workspaceDir: root });
		const run = recorder.begin("run", { attributes: { channel: "C1" } });
		const tool = recorder.begin("tool.bash", { parent: run });
		recorder.end(tool, { code: "OK" }, { duration_ms: 5 });
		recorder.end(run, { code: "OK" });
		recorder.flush();

		const lines = readFileSync(join(resolveAuditDirectory(root), "spans.jsonl"), "utf8")
			.trim()
			.split("\n");
		const spans = lines.map((line) => JSON.parse(line));
		const runSpan = spans.find((span) => span.name === "run");
		const toolSpan = spans.find((span) => span.name === "tool.bash");
		expect(toolSpan.parentSpanId).toBe(runSpan.spanId);
		expect(toolSpan.traceId).toBe(runSpan.traceId);
		expect(toolSpan.attributes.duration_ms).toBe(5);
	});
});

describe("模型主备", () => {
	const primary = { provider: "p", id: "main" } as unknown as Model<Api>;
	const backup = { provider: "p", id: "backup" } as unknown as Model<Api>;

	it("可重试错误触发降级，冷却期内使用备用", () => {
		let clock = 0;
		const router = new ModelRouter({ primary, fallbacks: [backup], cooldownMs: 1000, now: () => clock });
		expect(router.current().id).toBe("main");
		expect(router.recordError(new Error("429 Too Many Requests"))).toBe(true);
		expect(router.current().id).toBe("backup");
		clock = 2000;
		expect(router.current().id).toBe("main");
	});

	it("不可重试错误不触发降级", () => {
		const router = new ModelRouter({ primary, fallbacks: [backup] });
		expect(router.recordError(new Error("invalid api key"))).toBe(false);
		expect(router.current().id).toBe("main");
	});

	it("成功调用清空失败计数", () => {
		const router = new ModelRouter({ primary, fallbacks: [backup], failureThreshold: 2 });
		expect(isRetryableModelError("fetch failed: ECONNRESET")).toBe(true);
		router.recordError(new Error("timeout"));
		router.recordSuccess();
		expect(router.degraded).toBe(false);
		expect(router.current().id).toBe("main");
	});
});

describe("隔离报告", () => {
	const config = { policyMode: "enforce", auditPayloadMode: "digest" } as unknown as LightClawConfig;

	it("host 模式给出无隔离结论", async () => {
		const root = tempRoot();
		const report = await buildIsolationReport({
			workingDir: root,
			sandbox: { type: "host" },
			controlDir: join(root, "..", "control"),
			config,
		});
		expect(report.channelIsolation).toBe("host-unconfined");
		expect(report.findings.join("\n")).toContain("host 模式无沙箱隔离");
		expect(report.trustedUserIdsConfigured).toBe(false);
	});

	it("多频道时提示跨频道可读", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "C1"));
		mkdirSync(join(root, "C2"));
		const report = await buildIsolationReport({
			workingDir: root,
			sandbox: { type: "host" },
			controlDir: join(root, "..", "control"),
			config,
		});
		expect(report.channelCount).toBe(2);
	});
});

describe("审批命令", () => {
	it("列出待审批、按权限批准、拒绝非法 ID", () => {
		const root = tempRoot();
		const store = new ApprovalStore({ channelControlDir: root, channelId: "C1" });
		const ticket = store.create({
			signature: "sig",
			toolName: "bash",
			summary: "bash: rm -rf x",
			reason: "递归删除文件",
			capabilities: ["exec"],
			ownerUserId: "u1",
		});

		const listed = handleApprovalCommand("/approve list", {
			approvals: store,
			userId: "u1",
			origin: "platform",
			ownerUserId: "u1",
		});
		expect(listed.handled).toBe(true);
		expect(listed.response).toContain(ticket.id);

		expect(() =>
			handleApprovalCommand(`/approve ${ticket.id}`, {
				approvals: store,
				userId: "intruder",
				origin: "platform",
				ownerUserId: "u1",
			}),
		).toThrow("无权限");

		const approved = handleApprovalCommand(`/approve ${ticket.id}`, {
			approvals: store,
			userId: "u1",
			origin: "platform",
			ownerUserId: "u1",
		});
		expect(approved.response).toContain("已批准");

		expect(() =>
			handleApprovalCommand("/approve not-a-ticket", {
				approvals: store,
				userId: "u1",
				origin: "platform",
				ownerUserId: "u1",
			}),
		).toThrow("用法");

		expect(handleApprovalCommand("/goal status", { approvals: store, userId: "u1", origin: "platform" })).toEqual({
			handled: false,
		});
	});
});
