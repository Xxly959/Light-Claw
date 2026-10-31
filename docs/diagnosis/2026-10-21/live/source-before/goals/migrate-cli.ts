#!/usr/bin/env node
import { resolveControlDirectory } from "./control.js";
import { migrateLegacyGoal } from "./migration.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
	console.log(
		"停机后运行：lightclaw-goal-migrate --workspace <目录> [--control-dir <目录>] --channel <频道ID> --owner <平台用户ID>\n迁移与 Bot 共用互斥锁；不会删除旧文件或覆盖新状态。",
	);
} else {
	try {
		const values = new Map<string, string>();
		for (let index = 0; index < args.length; index += 2) {
			const name = args[index];
			const value = args[index + 1];
			if (!["--workspace", "--control-dir", "--channel", "--owner"].includes(name) || !value || values.has(name))
				throw new Error("参数非法，请运行 --help");
			values.set(name, value);
		}
		const workspaceDir = values.get("--workspace");
		const channelId = values.get("--channel");
		const ownerUserId = values.get("--owner");
		if (!workspaceDir || !channelId || !ownerUserId) throw new Error("需要 --workspace、--channel 和 --owner");
		const result = await migrateLegacyGoal({
			workspaceDir,
			controlDir: resolveControlDirectory(workspaceDir, values.get("--control-dir")),
			channelId,
			ownerUserId,
			signal: AbortSignal.timeout(300_000),
		});
		console.log(JSON.stringify(result));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
