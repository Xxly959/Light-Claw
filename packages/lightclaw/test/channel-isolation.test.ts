import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildSystemPrompt, buildWorkspaceGuide } from "../src/agent.js";
import type { LightClawConfig } from "../src/config.js";
import { loadConfig, loadConfigForDiagnostics } from "../src/config.js";
import type { GoalStore } from "../src/goals/store.js";
import { buildIsolationReport } from "../src/isolation.js";
import { ApprovalStore } from "../src/policy/approvals.js";
import { handleApprovalCommand } from "../src/policy/commands.js";
import { resolveChannelSandbox, resolveRunText } from "../src/runtime.js";
import { assertManagedMounts, validateChannelSandbox } from "../src/sandbox.js";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "channel-isolation-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {}
	}
});

function bind(source: string, destination: string, rw = true) {
	return { Type: "bind", Source: source, Destination: destination, RW: rw, Propagation: "rprivate" };
}

/**
 * 用假的 docker 可执行文件走真实校验路径（spawn -> 解析 inspect -> 挂载契约）。
 * 本机没有运行中的 daemon，但校验逻辑本身不依赖 daemon。
 */
function fakeDocker(inspect: unknown, logPath?: string): () => void {
	const root = mkdtempSync(join(tmpdir(), "fake-docker-"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "docker"),
		`#!/bin/sh
${logPath ? `echo "$@" >> "${logPath}"` : ""}
case "$1" in
  --version) echo "Docker version 29.7.2, build fake" ;;
  inspect) printf '%s' "$FAKE_INSPECT_JSON" ;;
  exec)
    case "$4" in
      -u) echo "\${FAKE_UID:-501}" ;;
      -G) echo "\${FAKE_GROUPS:-20 501}" ;;
      *) echo "unsupported exec" >&2; exit 1 ;;
    esac ;;
  ps) exit 0 ;;
  build) echo "sha256:fake" ;;
  run) echo "fake-container-id" ;;
  *) echo "unsupported command: $*" >&2; exit 1 ;;
esac
`,
		{ mode: 0o755 },
	);
	const previousPath = process.env.PATH;
	const previousInspect = process.env.FAKE_INSPECT_JSON;
	const previousUid = process.env.FAKE_UID;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	process.env.FAKE_INSPECT_JSON = JSON.stringify(inspect);
	process.env.FAKE_UID = "501";
	return () => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousInspect === undefined) delete process.env.FAKE_INSPECT_JSON;
		else process.env.FAKE_INSPECT_JSON = previousInspect;
		if (previousUid === undefined) delete process.env.FAKE_UID;
		else process.env.FAKE_UID = previousUid;
	};
}

function inspectPayload(options: {
	mounts: unknown[];
	user?: string;
	networkMode?: string;
	memory?: number;
	memorySwap?: number;
}) {
	const memory = options.memory ?? 512 * 1024 * 1024;
	return [
		{
			State: { Running: true },
			Config: { User: options.user ?? "501:20" },
			HostConfig: {
				Privileged: false,
				CapDrop: ["ALL"],
				CapAdd: [],
				SecurityOpt: ["no-new-privileges:true"],
				NetworkMode: options.networkMode ?? "none",
				NanoCpus: 1_000_000_000,
				Memory: memory,
				MemorySwap: options.memorySwap ?? memory,
				PidsLimit: 128,
				PidMode: "",
			},
			Mounts: options.mounts,
		},
	];
}

describe("挂载契约", () => {
	it("共享模式接受工作区根挂到 /workspace", () => {
		const root = tempRoot();
		expect(() =>
			assertManagedMounts(
				[bind(root, "/workspace")],
				{ required: { source: root, destination: "/workspace" } },
				"T",
			),
		).not.toThrow();
	});

	it("频道模式接受频道目录挂到 /workspace/<id>", () => {
		const root = tempRoot();
		const channel = join(root, "C1");
		mkdirSync(channel);
		expect(() =>
			assertManagedMounts(
				[bind(channel, "/workspace/C1")],
				{ required: { source: channel, destination: "/workspace/C1" } },
				"T",
			),
		).not.toThrow();
	});

	it("频道模式拒绝把工作区根当频道目录挂载", () => {
		const root = tempRoot();
		const channel = join(root, "C1");
		mkdirSync(channel);
		expect(() =>
			assertManagedMounts(
				[bind(root, "/workspace/C1")],
				{ required: { source: channel, destination: "/workspace/C1" } },
				"T",
			),
		).toThrow("must match");
	});

	it("频道模式拒绝多余挂载，避免悄悄挂进其他频道", () => {
		const root = tempRoot();
		const channel = join(root, "C1");
		const other = join(root, "C2");
		mkdirSync(channel);
		mkdirSync(other);
		expect(() =>
			assertManagedMounts(
				[bind(channel, "/workspace/C1"), bind(other, "/workspace/C2")],
				{ required: { source: channel, destination: "/workspace/C1" } },
				"T",
			),
		).toThrow("unexpected mount destination");
	});

	it("共享目录必须是只读，且路径要对得上", () => {
		const root = tempRoot();
		const channel = join(root, "C1");
		const shared = join(root, ".shared");
		mkdirSync(channel);
		mkdirSync(shared);
		const contract = {
			required: { source: channel, destination: "/workspace/C1" },
			shared: { source: shared, destination: "/workspace/.shared" },
		};
		expect(() =>
			assertManagedMounts([bind(channel, "/workspace/C1"), bind(shared, "/workspace/.shared", true)], contract, "T"),
		).toThrow("read-only");
		expect(() =>
			assertManagedMounts(
				[bind(channel, "/workspace/C1"), bind(shared, "/workspace/.shared", false)],
				contract,
				"T",
			),
		).not.toThrow();
	});

	it("拒绝把系统目录挂进容器", () => {
		expect(() =>
			assertManagedMounts([bind("/etc", "/workspace")], { required: { destination: "/workspace" } }, "T"),
		).toThrow("unsafe/non-workspace mount");
	});

	it("缺少必需挂载时拒绝", () => {
		expect(() => assertManagedMounts([], { required: { destination: "/workspace" } }, "T")).toThrow(
			"missing workspace mount",
		);
	});
});

describe("频道沙箱解析", () => {
	const base = { type: "docker" as const, container: "shared" };

	it("有专属容器时使用专属容器", () => {
		const config = { channelContainers: { C1: "chan-1" } } as unknown as LightClawConfig;
		expect(resolveChannelSandbox("C1", base, config)).toEqual({ type: "docker", container: "chan-1" });
	});

	it("未配置时按回退策略使用共享容器", () => {
		const config = { channelContainers: {}, sandboxFallback: "shared" } as unknown as LightClawConfig;
		expect(resolveChannelSandbox("C9", base, config)).toEqual(base);
	});

	it("deny 策略下未配置专属容器则拒绝执行", () => {
		const config = { channelContainers: {}, sandboxFallback: "deny" } as unknown as LightClawConfig;
		expect(() => resolveChannelSandbox("C9", base, config)).toThrow("deny");
	});

	it("基础设施特性关闭时忽略频道映射", () => {
		const config = {
			channelContainers: { C1: "chan-1" },
			features: { infrastructure: false },
		} as unknown as LightClawConfig;
		expect(resolveChannelSandbox("C1", { type: "host" }, config)).toEqual({ type: "host" });
	});
});

describe("频道容器配置", () => {
	const credentials = { LIGHTCLAW_FEISHU_APP_ID: "app", LIGHTCLAW_FEISHU_APP_SECRET: "secret" };

	it("解析频道到容器的映射", () => {
		const config = loadConfig({
			...credentials,
			LIGHTCLAW_CHANNEL_CONTAINERS_JSON: '{"C1":"chan-1","C2":"chan-2"}',
			LIGHTCLAW_SANDBOX_FALLBACK: "deny",
		});
		expect(config.channelContainers).toEqual({ C1: "chan-1", C2: "chan-2" });
		expect(config.sandboxFallback).toBe("deny");
	});

	it("拒绝非法映射，避免静默退化为共享容器", () => {
		expect(() => loadConfig({ ...credentials, LIGHTCLAW_CHANNEL_CONTAINERS_JSON: "{oops" })).toThrow("不是合法 JSON");
		expect(() => loadConfig({ ...credentials, LIGHTCLAW_CHANNEL_CONTAINERS_JSON: '{"a/b":"x"}' })).toThrow(
			"非法频道 ID",
		);
		expect(() => loadConfig({ ...credentials, LIGHTCLAW_CHANNEL_CONTAINERS_JSON: '{"C1":"bad name"}' })).toThrow(
			"容器名非法",
		);
		expect(() => loadConfig({ ...credentials, LIGHTCLAW_SANDBOX_FALLBACK: "maybe" })).toThrow(
			"LIGHTCLAW_SANDBOX_FALLBACK",
		);
	});
});

describe("频道容器真实校验路径", () => {
	it("接受只挂自己目录的频道容器", async () => {
		const root = tempRoot();
		const channel = join(root, "C1");
		mkdirSync(channel);
		const restore = fakeDocker(inspectPayload({ mounts: [bind(channel, "/workspace/C1")] }));
		try {
			await expect(
				validateChannelSandbox({ type: "docker", container: "lightclaw-chan-C1" }, channel, "C1"),
			).resolves.toBeUndefined();
		} finally {
			restore();
		}
	});

	it("拒绝把频道目录挂到工作区根", async () => {
		const root = tempRoot();
		const channel = join(root, "C1");
		mkdirSync(channel);
		const restore = fakeDocker(inspectPayload({ mounts: [bind(channel, "/workspace")] }));
		try {
			await expect(
				validateChannelSandbox({ type: "docker", container: "lightclaw-chan-C1" }, channel, "C1"),
			).rejects.toThrow("unexpected mount destination");
		} finally {
			restore();
		}
	});

	it("拒绝额外挂载其他频道目录", async () => {
		const root = tempRoot();
		const channel = join(root, "C1");
		const other = join(root, "C2");
		mkdirSync(channel);
		mkdirSync(other);
		const restore = fakeDocker(
			inspectPayload({ mounts: [bind(channel, "/workspace/C1"), bind(other, "/workspace/C2")] }),
		);
		try {
			await expect(
				validateChannelSandbox({ type: "docker", container: "lightclaw-chan-C1" }, channel, "C1"),
			).rejects.toThrow("unexpected mount destination");
		} finally {
			restore();
		}
	});

	it("拒绝以 root 运行或提权的容器", async () => {
		const root = tempRoot();
		const channel = join(root, "C1");
		mkdirSync(channel);
		const restore = fakeDocker(inspectPayload({ mounts: [bind(channel, "/workspace/C1")], user: "0:0" }));
		try {
			await expect(
				validateChannelSandbox({ type: "docker", container: "lightclaw-chan-C1" }, channel, "C1"),
			).rejects.toThrow("non-root");
		} finally {
			restore();
		}
	});

	it("拒绝宿主网络", async () => {
		const root = tempRoot();
		const channel = join(root, "C1");
		mkdirSync(channel);
		const restoreHostNet = fakeDocker(
			inspectPayload({ mounts: [bind(channel, "/workspace/C1")], networkMode: "host" }),
		);
		try {
			await expect(
				validateChannelSandbox({ type: "docker", container: "lightclaw-chan-C1" }, channel, "C1"),
			).rejects.toThrow("host namespaces");
		} finally {
			restoreHostNet();
		}
	});

	it("拒绝 memory-swap 与 memory 不一致的容器", async () => {
		const root = tempRoot();
		const channel = join(root, "C1");
		mkdirSync(channel);
		const restore = fakeDocker(
			inspectPayload({
				mounts: [bind(channel, "/workspace/C1")],
				memory: 512 * 1024 * 1024,
				memorySwap: 1024 * 1024 * 1024,
			}),
		);
		try {
			await expect(
				validateChannelSandbox({ type: "docker", container: "lightclaw-chan-C1" }, channel, "C1"),
			).rejects.toThrow("bounded CPU, memory");
		} finally {
			restore();
		}
	});
});

describe("提示中的写入边界", () => {
	const goalStore = { get: () => undefined } as unknown as GoalStore;
	const docker = { type: "docker" as const, container: "lightclaw-chan-C1" };

	function prompt(isolated: boolean): string {
		return buildSystemPrompt(
			"/workspace",
			"C1",
			"",
			docker,
			[],
			[],
			[],
			goalStore,
			"slack",
			undefined,
			undefined,
			false,
			isolated,
		);
	}

	it("隔离模式下只描述频道目录，并声明工作区根不可写", () => {
		const text = prompt(true);
		expect(text).toContain("only mounted directory");
		expect(text).toContain("All file writes must stay under /workspace/C1/");
		expect(text).not.toContain("Global memory (all channels)");
		expect(text).toContain("Global MEMORY.md, skills/ and events/ are NOT mounted");
	});

	it("共享模式保留原有工作区布局，并要求产物落在频道目录", () => {
		const text = prompt(false);
		expect(text).toContain("Global memory (all channels)");
		expect(text).toContain("Channel output belongs under /workspace/C1/");
		expect(text).not.toContain("only mounted directory");
	});

	it("隔离模式下指南不再引导写全局 skills 与 events", () => {
		const isolated = buildWorkspaceGuide("/workspace", "C1", true);
		expect(isolated).toContain("Global skills are not writable here");
		expect(isolated).toContain("/workspace/events/` is not mounted");

		const shared = buildWorkspaceGuide("/workspace", "C1", false);
		expect(shared).toContain("(global)");
		expect(shared).not.toContain("is not mounted");
	});
});

describe("docker.sh create-channel 的实际参数", () => {
	const dockerScript = fileURLToPath(new URL("../docker.sh", import.meta.url));

	function runCreateChannel(withShared: boolean): string {
		const root = tempRoot();
		const logPath = join(root, "docker-args.log");
		if (withShared) mkdirSync(join(root, ".shared"));
		const restore = fakeDocker([], logPath);
		try {
			execFileSync("bash", [dockerScript, "create-channel", root, "C1"], { stdio: "pipe" });
		} finally {
			restore();
		}
		return readFileSync(logPath, "utf8");
	}

	it("只挂频道目录，并带齐最小权限参数", () => {
		const log = runCreateChannel(false);
		expect(log).toContain("--name lightclaw-chan-C1");
		expect(log).toContain("--network none");
		expect(log).toContain("--cap-drop ALL");
		expect(log).toContain("--security-opt no-new-privileges:true");
		expect(log).toContain("--pids-limit 128");
		expect(log).toMatch(/-v \/.*\/C1:\/workspace\/C1\b/);
		// 没有 .shared 时不应凭空多挂一个目录。
		expect(log).not.toContain("/workspace/.shared");
	});

	it("存在 .shared 时以只读方式追加挂载", () => {
		const log = runCreateChannel(true);
		expect(log).toContain("/workspace/.shared:ro");
	});

	it("拒绝含路径分隔符的频道 ID", () => {
		const root = tempRoot();
		const restore = fakeDocker([], join(root, "docker-args.log"));
		try {
			expect(() =>
				execFileSync("bash", [dockerScript, "create-channel", root, "../escape"], { stdio: "pipe" }),
			).toThrow();
		} finally {
			restore();
		}
	});
});

describe("无凭证的隔离报告", () => {
	it("诊断配置不要求平台凭证", () => {
		const config = loadConfigForDiagnostics({});
		expect(config.transport).toBe("feishu");
		expect(config.policyMode).toBe("enforce");
		expect(config.sandboxFallback).toBe("shared");
		expect(config.channelContainers).toEqual({});
	});

	it("真实 CLI 在没有凭证时也能输出隔离报告", () => {
		const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
		const mainScript = fileURLToPath(new URL("../src/main.ts", import.meta.url));
		if (!existsSync(tsx)) return;
		const root = tempRoot();
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const key of Object.keys(env)) {
			if (key.startsWith("LIGHTCLAW_") || key === "OPENAI_API_KEY") delete env[key];
		}
		const stdout = execFileSync(tsx, [mainScript, "--isolation-report", root], { encoding: "utf8", env });
		const report = JSON.parse(stdout);
		expect(report.scope).toBe("single-tenant");
		expect(report.sandbox).toBe("host");
		expect(report.channelIsolation).toBe("host-unconfined");
	});
});

describe("审批后续跑", () => {
	it("批准返回续跑标记与重试提示，拒绝不续跑", () => {
		const root = tempRoot();
		const store = new ApprovalStore({ channelControlDir: root, channelId: "C1" });
		const ticket = store.create({
			signature: "sig",
			toolName: "bash",
			summary: "bash: rm -rf scratch/old",
			reason: "递归删除文件",
			capabilities: ["exec"],
			ownerUserId: "u1",
		});
		const context = {
			approvals: store,
			userId: "u1",
			origin: "platform" as const,
			ownerUserId: "u1",
		};

		const approved = handleApprovalCommand(`/approve ${ticket.id}`, context);
		expect(approved.startRun).toBe(true);
		expect(approved.retryText).toContain("请立即重新执行同一操作");
		expect(approved.retryText).toContain(ticket.id);
		// 批准提示必须和实际行为一致：文案说在重试，就真的会重试。
		expect(approved.response).toContain("正在重试");

		const other = store.create({
			signature: "sig-2",
			toolName: "bash",
			summary: "bash: git push --force",
			reason: "强制推送覆盖远端历史",
			capabilities: ["exec"],
			ownerUserId: "u1",
		});

		const denied = handleApprovalCommand(`/approve deny ${other.id}`, context);
		expect(denied.handled).toBe(true);
		expect(denied.startRun).toBeUndefined();
	});

	it("run 输入优先级：目标 > 审批续跑 > 原始消息", () => {
		const event = {
			origin: "platform" as const,
			type: "mention" as const,
			channel: "C1",
			ts: "1",
			user: "u1",
			text: "/approve abc12345",
		};
		expect(resolveRunText(event, { handled: true, startRun: true, retryText: "retry" })).toBe("retry");
		expect(resolveRunText(event, { handled: false, startRun: false })).toBe("/approve abc12345");
		expect(
			resolveRunText(event, {
				handled: true,
				startRun: true,
				goal: { objective: "整理报告" } as never,
			}),
		).toBe("整理报告");
	});
});

describe("隔离报告中的频道容器", () => {
	it("配置专属容器但未验证时明确报告 unverified", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "C1"));
		mkdirSync(join(root, "C2"));
		const report = await buildIsolationReport({
			workingDir: root,
			sandbox: { type: "docker", container: "shared" },
			controlDir: join(root, "..", "control"),
			config: {
				channelContainers: { C1: "chan-1" },
				sandboxFallback: "deny",
				policyMode: "enforce",
				auditPayloadMode: "digest",
			} as unknown as LightClawConfig,
		});
		expect(report.channelIsolation).toBe("unverified");
		expect(report.configuredChannelIsolation).toBe("per-channel-container");
		expect(report.perChannelContainers).toBe(1);
		expect(report.sandboxFallback).toBe("deny");
		expect(report.findings.join("\n")).toContain("未配置专属容器");
	});
});
