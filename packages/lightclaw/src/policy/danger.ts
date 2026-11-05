/**
 * 危险动作识别与调用摘要。
 *
 * 只做保守的规则匹配：命中即要求人工确认，不命中不等于安全。
 * 规则表可以扩展，但任何新增规则都不应把已确认的动作改回自动放行。
 */

export interface DangerAssessment {
	dangerous: boolean;
	reasons: string[];
	summary: string;
}

interface Rule {
	id: string;
	pattern: RegExp;
	reason: string;
}

/** 命令级规则。注意：这里只识别"高破坏力"形态，普通读写不进审批。 */
const BASH_RULES: readonly Rule[] = [
	{ id: "recursive-delete", pattern: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, reason: "递归删除文件" },
	{ id: "wildcard-delete", pattern: /\brm\s+[^\n]*[*?]/, reason: "通配符删除" },
	{
		id: "force-push",
		pattern: /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?\b|(?<![\w-])-f\b)/,
		reason: "强制推送覆盖远端历史",
	},
	{
		id: "history-destroy",
		pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*[fd])/,
		reason: "丢弃本地提交或未跟踪文件",
	},
	{ id: "disk-write", pattern: /\bdd\b[^\n]*\bof=|>\s*\/dev\/[sh]d[a-z]/, reason: "直接写入块设备" },
	{ id: "format", pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/, reason: "格式化文件系统" },
	{
		id: "remote-code",
		pattern: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/,
		reason: "下载内容直接交给 shell 执行",
	},
	{ id: "privilege", pattern: /\bsudo\b|\bchmod\s+777\b|\bchown\s+-R\s+root\b/, reason: "提权或放宽权限" },
	{
		id: "host-control",
		pattern: /\b(?:shutdown|reboot|halt|poweroff)\b|\bkill\s+-9\s+1\b/,
		reason: "影响宿主运行状态",
	},
	{ id: "container-destroy", pattern: /\bdocker\s+(?:rm|rmi|kill|system\s+prune)\b/, reason: "删除容器或镜像" },
	{ id: "cluster-destroy", pattern: /\bkubectl\s+delete\b|\bhelm\s+uninstall\b/, reason: "删除集群资源" },
	{ id: "sql-destroy", pattern: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i, reason: "删除数据库对象" },
	{ id: "egress", pattern: /\b(?:curl|wget|nc|ncat|ssh|scp|rsync|ftp|telnet)\b/, reason: "可能向外部地址传输数据" },
];

const SENSITIVE_PATH =
	/(?:^|[\\/])(?:\.env(?:\.[\w.-]+)?|\.npmrc|\.pypirc|auth\.json|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)|\.git[\\/]config|\.ssh(?:[\\/]|$))/i;
const SENSITIVE_EXTENSION = /\.(?:pem|p12|pfx|key|keystore)$/i;
const SENSITIVE_SYSTEM = /^[\\/]?(?:etc[\\/](?:shadow|sudoers)|root[\\/]\.ssh)/i;

function stringField(args: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = args?.[key];
	return typeof value === "string" ? value : undefined;
}

function singleLine(text: string, limit: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

export function isSensitivePath(path: string | undefined): boolean {
	if (!path) return false;
	return SENSITIVE_PATH.test(path) || SENSITIVE_EXTENSION.test(path) || SENSITIVE_SYSTEM.test(path);
}

/**
 * 生成人类可读、可审计的调用摘要。摘要只描述动作与目标，不复制参数全文。
 */
export function summarizeToolCall(toolName: string, args: Record<string, unknown> | undefined): string {
	if (toolName === "bash") {
		const command = stringField(args, "command");
		return command ? `bash: ${singleLine(command, 200)}` : "bash: (无命令)";
	}
	const pathTarget = stringField(args, "path") ?? stringField(args, "file_path");
	if (pathTarget) return `${toolName}: ${singleLine(pathTarget, 200)}`;
	return toolName;
}

export function assessDanger(toolName: string, args: Record<string, unknown> | undefined): DangerAssessment {
	const summary = summarizeToolCall(toolName, args);
	const reasons: string[] = [];

	if (toolName === "bash") {
		const command = stringField(args, "command") ?? "";
		for (const rule of BASH_RULES) {
			if (rule.pattern.test(command) && !reasons.includes(rule.reason)) reasons.push(rule.reason);
		}
	} else if (toolName === "read" || toolName === "attach" || toolName === "write" || toolName === "edit") {
		const path = stringField(args, "path") ?? stringField(args, "file_path");
		if (isSensitivePath(path)) reasons.push("访问凭据或密钥类文件");
	}

	return { dangerous: reasons.length > 0, reasons, summary };
}
