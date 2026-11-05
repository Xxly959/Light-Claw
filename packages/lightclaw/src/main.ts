#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { loadConfig, loadConfigForDiagnostics } from "./config.js";
import { downloadChannel } from "./download.js";
import { featureEnabled } from "./features.js";
import { FeishuBot } from "./feishu.js";
import { resolveControlDirectory } from "./goals/control.js";
import { inspectLocalHealth } from "./health.js";
import { buildIsolationReport } from "./isolation.js";
import * as log from "./log.js";
import { createLightClawRuntime } from "./runtime.js";
import { parseSandboxArg, type SandboxConfig, validateChannelSandbox, validateSandbox } from "./sandbox.js";
import { SlackBot } from "./slack.js";
import { ChannelStore } from "./store.js";

async function startupStep<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		log.logAgentError("system", error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

const earlyArgs = process.argv.slice(2);
if (earlyArgs.includes("--help") || earlyArgs.includes("-h")) {
	console.log(
		"用法：lightclaw [--sandbox=host|docker:<名称>] <工作目录>\n本地探测：lightclaw --health=<工作目录> [--control=<控制目录>]\n隔离报告：lightclaw --isolation-report <工作目录> [--sandbox=...]（无需平台凭证）\nNode Agent在宿主运行；Docker仅执行工具。健康探测不验证真实平台或模型。",
	);
	process.exit(0);
}
const healthArg = earlyArgs.find((arg) => arg.startsWith("--health="));
if (healthArg) {
	const health = inspectLocalHealth(
		resolve(healthArg.slice(9)),
		earlyArgs.find((arg) => arg.startsWith("--control="))?.slice(10) ?? process.env.LIGHTCLAW_CONTROL_DIR,
	);
	console.log(JSON.stringify(health));
	process.exit(health.lock === "unavailable" ? 1 : 0);
}
setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));
interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
}

function parseArgs(args = process.argv.slice(2)): ParsedArgs {
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannel: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument.startsWith("--sandbox=")) sandbox = parseSandboxArg(argument.slice(10));
		else if (argument === "--sandbox") sandbox = parseSandboxArg(args[++index] || "");
		else if (argument.startsWith("--download=")) downloadChannel = argument.slice(11);
		else if (argument === "--download") downloadChannel = args[++index];
		else if (!argument.startsWith("-")) workingDir = argument;
	}
	return { workingDir: workingDir ? resolve(workingDir) : undefined, sandbox, downloadChannel };
}

const parsedArgs = parseArgs();
const wantsIsolationReport = earlyArgs.some((arg) => arg.startsWith("--isolation-report"));
let config: ReturnType<typeof loadConfig>;
try {
	config = loadConfig();
} catch (error) {
	// 隔离报告是评审入口，通常在没有平台凭证的机器上执行；只有它允许降级到无凭证配置。
	if (!wantsIsolationReport) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
	config = loadConfigForDiagnostics();
}

if (parsedArgs.downloadChannel) {
	if (config.transport !== "slack" || !config.slack) {
		console.error("--download 仅支持 Slack 模式");
		process.exit(1);
	}
	await startupStep(() => downloadChannel(parsedArgs.downloadChannel!, config.slack!.botToken));
	process.exit(0);
}
if (!parsedArgs.workingDir) {
	console.error("用法：lightclaw [--sandbox=host|docker:<名称>] <工作目录>");
	process.exit(1);
}

const { workingDir, sandbox } = {
	workingDir: parsedArgs.workingDir,
	sandbox: featureEnabled(config, "infrastructure") ? parsedArgs.sandbox : { type: "host" as const },
};

const isolationArg = earlyArgs.find((arg) => arg.startsWith("--isolation-report"));
if (isolationArg) {
	let controlDir: string;
	try {
		controlDir = resolveControlDirectory(workingDir, config.controlDir);
	} catch {
		controlDir = config.controlDir ?? join(workingDir, ".control");
	}
	console.log(JSON.stringify(await buildIsolationReport({ workingDir, sandbox, controlDir, config }), null, 2));
	process.exit(0);
}

await startupStep(() => validateSandbox(sandbox, workingDir));
// 显式配置的频道容器在启动时全部校验，避免运行到一半才发现挂载不符合隔离契约。
for (const [channelId, container] of Object.entries(config.channelContainers ?? {})) {
	await startupStep(async () => {
		const channelDir = join(workingDir, channelId);
		await mkdir(channelDir, { recursive: true });
		await validateChannelSandbox({ type: "docker", container }, channelDir, channelId);
	});
}

const sharedStore = new ChannelStore({ workingDir, botToken: config.slack?.botToken });
const runtime = await startupStep(() =>
	createLightClawRuntime({
		config,
		workingDir,
		sandbox,
		createTransport: (handler, inbox) => {
			return config.transport === "slack" && config.slack
				? new SlackBot(handler, {
						...config.slack,
						workingDir,
						inbox,
						store: sharedStore,
						platformTimeoutMs: config.platformTimeoutMs,
						schedulingEnabled: featureEnabled(config, "scheduling"),
						queueMaxPending: config.queueMaxPending,
						queueMaxWaitMs: config.queueMaxWaitMs,
						channelCacheMaxEntries: config.channelCacheMaxEntries,
						channelCacheIdleTtlMs: config.channelCacheIdleTtlMs,
					})
				: new FeishuBot(handler, {
						...config.feishu!,
						workingDir,
						inbox,
						store: sharedStore,
						platformTimeoutMs: config.platformTimeoutMs,
						schedulingEnabled: featureEnabled(config, "scheduling"),
						queueMaxPending: config.queueMaxPending,
						queueMaxWaitMs: config.queueMaxWaitMs,
						channelCacheMaxEntries: config.channelCacheMaxEntries,
						channelCacheIdleTtlMs: config.channelCacheIdleTtlMs,
					});
		},
	}),
);
export const shutdown = () => runtime.shutdown();
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		log.logInfo("LightClaw 正在停止接纳并收敛在途任务...");
		void shutdown().then(
			() => process.exit(0),
			(error) => {
				log.logAgentError(
					"system",
					`关闭未确认；保留实例锁，需人工检查：${error instanceof Error ? error.message : String(error)}`,
				);
				process.exitCode = 1;
				setInterval(() => {}, 60_000);
			},
		);
	});
log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);
await startupStep(() => runtime.start());
