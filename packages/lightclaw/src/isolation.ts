/**
 * 隔离等级报告。
 *
 * LightClaw 是单实例、同信任域的部署形态；这里把"到底隔离到什么程度"变成可检查的输出，
 * 而不是只在文档里声明。报告不阻断启动，但每条 finding 都对应一个实际风险。
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LightClawConfig } from "./config.js";
import { isWithin, physicalPath } from "./goals/control.js";
import { type SandboxConfig, validateChannelSandbox, validateSandbox } from "./sandbox.js";

export type ChannelIsolation = "shared-workspace" | "per-channel-container" | "host-unconfined" | "unverified";

export interface ContainerVerification {
	container: string;
	channelId?: string;
	status: "verified" | "missing" | "stopped" | "inspection_failed" | "contract_mismatch";
	checkedAt: string;
	networkMode?: string;
	detail?: string;
}
export interface IsolationReport {
	configuredChannelIsolation: ChannelIsolation;
	verifiedChannelContainers: number;
	containers: ContainerVerification[];
	scope: "single-tenant";
	sandbox: "host" | "docker";
	channelIsolation: ChannelIsolation;
	channelCount: number;
	perChannelContainers: number;
	sandboxFallback: "shared" | "deny";
	controlDirOutsideWorkspace: boolean;
	networkMode?: string;
	trustedUserIdsConfigured: boolean;
	policyMode: "enforce" | "off";
	auditPayloadMode: "off" | "digest" | "full";
	findings: string[];
}

function countChannelDirs(workingDir: string): number {
	try {
		return readdirSync(workingDir, { withFileTypes: true }).filter((entry) => {
			if (!entry.isDirectory()) return false;
			try {
				return statSync(join(workingDir, entry.name)).isDirectory();
			} catch {
				return false;
			}
		}).length;
	} catch {
		return 0;
	}
}

async function inspectContainer(
	container: string,
	validate: () => Promise<void>,
	channelId?: string,
): Promise<ContainerVerification> {
	const result: ContainerVerification = {
		container,
		channelId,
		status: "inspection_failed",
		checkedAt: new Date().toISOString(),
	};
	try {
		const raw: unknown = JSON.parse(
			execFileSync("docker", ["inspect", container], {
				encoding: "utf8",
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
		if (!Array.isArray(raw) || raw.length !== 1 || !raw[0] || typeof raw[0] !== "object")
			throw new Error("invalid inspect shape");
		const details = raw[0] as { State?: { Running?: unknown }; HostConfig?: { NetworkMode?: unknown } };
		if (typeof details.State?.Running !== "boolean") throw new Error("inspect missing running state");
		if (typeof details.HostConfig?.NetworkMode === "string") result.networkMode = details.HostConfig.NetworkMode;
		if (!details.State.Running) {
			result.status = "stopped";
			return result;
		}
	} catch (error) {
		result.detail = error instanceof Error ? error.message : String(error);
		if (/no such (object|container)/i.test(result.detail)) result.status = "missing";
		return result;
	}
	try {
		await validate();
		result.status = "verified";
	} catch (error) {
		result.status = "contract_mismatch";
		result.detail = error instanceof Error ? error.message : String(error);
	}
	return result;
}

export async function buildIsolationReport(options: {
	workingDir: string;
	sandbox: SandboxConfig;
	controlDir: string;
	config: LightClawConfig;
}): Promise<IsolationReport> {
	const findings: string[] = [];
	const channelCount = countChannelDirs(options.workingDir);
	const sandbox = options.sandbox;
	const docker = sandbox.type === "docker";
	const containers: ContainerVerification[] = [];
	if (sandbox.type === "docker") {
		containers.push(
			await inspectContainer(sandbox.container, () => validateSandbox(sandbox, options.workingDir, true)),
		);
		for (const [channelId, container] of Object.entries(options.config.channelContainers ?? {})) {
			containers.push(
				await inspectContainer(
					container,
					() =>
						validateChannelSandbox(
							{ type: "docker", container },
							join(options.workingDir, channelId),
							channelId,
							true,
						),
					channelId,
				),
			);
		}
	}
	const networkMode = containers.find((item) => !item.channelId)?.networkMode;
	const verifiedChannelContainers = containers.filter((item) => item.channelId && item.status === "verified").length;

	let channelIsolation: ChannelIsolation = docker ? "shared-workspace" : "host-unconfined";
	const perChannelContainers = Object.keys(options.config.channelContainers ?? {}).length;
	if (!docker) findings.push("host 模式无沙箱隔离：任何 bash 都能读写当前用户可见的全部文件，仅应用于开发环境");
	else if (perChannelContainers > 0) {
		channelIsolation = verifiedChannelContainers === perChannelContainers ? "per-channel-container" : "unverified";
		findings.push(
			`配置 ${perChannelContainers} 个频道专属容器，实际契约验证通过 ${verifiedChannelContainers} 个；配置不等于验证`,
		);
		if (perChannelContainers < channelCount)
			findings.push(
				`仍有 ${channelCount - perChannelContainers} 个工作区目录未配置专属容器，按 LIGHTCLAW_SANDBOX_FALLBACK=${
					options.config.sandboxFallback ?? "shared"
				} 处理`,
			);
		findings.push("频道容器内看不到工作区根的全局 MEMORY.md、skills 与 events；需要共享资源时挂载只读 .shared");
	} else {
		findings.push("所有频道共享同一个 /workspace 挂载：任一频道的 bash 可读取其他频道的产物");
		if (channelCount > 1) findings.push(`工作区含 ${channelCount} 个频道目录，跨频道读取在当前实现中未被阻断`);
	}

	for (const item of containers) {
		findings.push(
			`${item.channelId ?? "shared"}/${item.container}: ${item.status}，network=${item.networkMode ?? "unknown"}${item.detail ? ` (${item.detail})` : ""}`,
		);
	}
	if (docker && perChannelContainers === 0 && containers[0]?.status !== "verified") channelIsolation = "unverified";
	const controlOutside = !isWithin(physicalPath(options.workingDir), physicalPath(options.controlDir));
	if (!controlOutside) findings.push("控制目录位于工作区内：Agent 可通过文件工具读取目标状态与审批票据");

	if (!docker && networkMode === undefined) {
		// host 模式没有网络边界，这里只在 docker 分支判断。
	} else if (networkMode && networkMode !== "none") {
		findings.push(`沙箱网络模式为 ${networkMode}：Agent 可出网，attach 与 curl 都构成外发通道`);
	}

	const trustedConfigured = (options.config.trustedUserIds ?? []).length > 0;
	if (!trustedConfigured)
		findings.push("未配置 LIGHTCLAW_TRUSTED_USER_IDS：所有平台来源都按可信处理，不触发信任降级审批");

	if (options.config.policyMode === "off") findings.push("LIGHTCLAW_POLICY_MODE=off：能力裁决与审批闸门已关闭");

	const payloadMode = options.config.auditPayloadMode ?? "digest";
	if (payloadMode !== "full")
		findings.push(
			`审计原文模式为 ${payloadMode}：只有参数摘要可查；需要复盘原文时显式设置 LIGHTCLAW_AUDIT_PAYLOAD_MODE=full`,
		);

	return {
		scope: "single-tenant",
		configuredChannelIsolation: !docker
			? "host-unconfined"
			: perChannelContainers
				? "per-channel-container"
				: "shared-workspace",
		verifiedChannelContainers,
		containers,
		sandbox: docker ? "docker" : "host",
		channelIsolation,
		channelCount,
		perChannelContainers,
		sandboxFallback: options.config.sandboxFallback ?? "shared",
		controlDirOutsideWorkspace: controlOutside,
		networkMode,
		trustedUserIdsConfigured: trustedConfigured,
		policyMode: options.config.policyMode ?? "enforce",
		auditPayloadMode: payloadMode,
		findings,
	};
}
