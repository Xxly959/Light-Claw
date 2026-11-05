import type { SandboxConfig } from "../sandbox.js";
import { assertRecord, assertText } from "../validation.js";
import type { GoalCommandRule, GoalCreateInput, GoalDeliverables, GoalFileRule } from "./types.js";

export function validateArtifactPath(value: unknown): string {
	assertText(value, "path");
	if (
		value !== value.trim() ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.startsWith("/") ||
		/^[A-Za-z]:/.test(value) ||
		value.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("path 必须是频道内规范相对路径");
	return value;
}

export function assertFields(value: Record<string, unknown>, fields: string[]): void {
	for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`未知字段：${key}`);
}

function strings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error(`${field} 必须有1到16项`);
	return value.map((item) => {
		assertText(item, field);
		return item;
	});
}

function rules(value: unknown, maximum: number, field: string): Record<string, unknown>[] {
	if (!Array.isArray(value) || value.length > maximum) throw new Error(`${field} 数量非法`);
	return value.map((item) => {
		assertRecord(item, field);
		return item;
	});
}

export function parseGoalCreateInput(value: unknown, ownerUserId: string, sandbox: SandboxConfig): GoalCreateInput {
	assertRecord(value, "goal");
	assertFields(value, ["objective", "acceptance"]);
	assertText(value.objective, "objective");
	assertText(ownerUserId, "ownerUserId");
	if (value.acceptance === undefined)
		return { objective: value.objective.trim(), ownerUserId, acceptance: { mode: "manual" } };
	assertRecord(value.acceptance, "acceptance");
	assertFields(value.acceptance, ["files", "commands"]);
	const files: GoalFileRule[] = rules(value.acceptance.files ?? [], 16, "files").map((item) => {
		assertFields(item, ["path", "contains", "changed"]);
		if (item.changed !== undefined && typeof item.changed !== "boolean") throw new Error("changed 必须是布尔值");
		return {
			path: validateArtifactPath(item.path),
			changed: item.changed ?? true,
			...(item.contains === undefined ? {} : { contains: strings(item.contains, "contains") }),
		};
	});
	if (new Set(files.map((item) => item.path)).size !== files.length) throw new Error("files 路径重复");
	const commands: GoalCommandRule[] = rules(value.acceptance.commands ?? [], 4, "commands").map((item) => {
		assertFields(item, ["command", "sourcePaths", "stdoutIncludes"]);
		assertText(item.command, "command");
		if (item.command.length > 4096 || item.command.includes("\0")) throw new Error("command 长度非法");
		const sourcePaths = strings(item.sourcePaths, "sourcePaths").map(validateArtifactPath);
		if (new Set(sourcePaths).size !== sourcePaths.length) throw new Error("sourcePaths 重复");
		return {
			command: item.command,
			sourcePaths,
			...(item.stdoutIncludes === undefined
				? {}
				: { stdoutIncludes: strings(item.stdoutIncludes, "stdoutIncludes") }),
		};
	});
	if (!files.length && !commands.length) throw new Error("acceptance 至少包含一项检查");
	if (commands.length && sandbox.type !== "docker") throw new Error("命令验收仅支持 Docker");
	return { objective: value.objective.trim(), ownerUserId, acceptance: { mode: "automatic", files, commands } };
}

/** Evidence is descriptive only. Paths must come from this explicit declaration. */
export function parseGoalDeliverables(value: unknown): GoalDeliverables {
	assertRecord(value, "交付物 deliverables");
	if (value.kind === "none") {
		assertFields(value, ["kind", "reason"]);
		assertText(value.reason, "无文件交付原因");
		return { kind: "none", reason: value.reason.trim() };
	}
	if (value.kind !== "files") throw new Error("必须明确声明文件或无文件交付");
	assertFields(value, ["kind", "paths"]);
	const paths = strings(value.paths, "交付物 paths").map(validateArtifactPath);
	if (new Set(paths).size !== paths.length) throw new Error("交付物路径重复");
	return { kind: "files", paths };
}
