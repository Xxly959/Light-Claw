import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "../src/sandbox.js";
import { createBashTool } from "../src/tools/bash.js";
import { createWriteTool } from "../src/tools/write.js";

const archives: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await Promise.all(archives.splice(0).map((path) => rm(path, { force: true })));
});

function executor(output: string, code = 0): Executor {
	return { exec: async () => ({ stdout: output, stderr: "", code }), getWorkspacePath: (path) => path };
}

describe("工具输出归档", () => {
	it.each(["x\n".repeat(2010), "界".repeat(18000), "x".repeat(51300)])(
		"截断分支返回时完整文件已经可读 %#",
		async (output) => {
			const result = await createBashTool(executor(output)).execute("test", { label: "test", command: "unused" });
			const path = result.details?.fullOutputPath;
			if (path) archives.push(path);
			expect(path).toBeTypeOf("string");
			if (!path) throw new Error("missing archive");
			expect(await readFile(path, "utf8")).toBe(output);
		},
	);

	it("归档写盘失败作为工具失败返回", async () => {
		vi.stubEnv("TMPDIR", join(tmpdir(), "lightclaw-missing-output-dir", "missing"));
		await expect(
			createBashTool(executor("x\n".repeat(2010))).execute("test", { label: "test", command: "unused" }),
		).rejects.toThrow("ENOENT");
	});

	it("完整归档超过配额时工具失败，不交付不完整归档", async () => {
		vi.stubEnv("LIGHTCLAW_ARCHIVE_MAX_BYTES", "1");
		await expect(
			createBashTool(executor("x\n".repeat(2010))).execute("test", { label: "test", command: "unused" }),
		).rejects.toThrow(/quota/);
	});

	it("UTF-8 写入提示报告字节数", async () => {
		const tool = createWriteTool(executor(""));
		const result = await tool.execute("test", { label: "test", path: "unused", content: "中文😀" });
		expect(result.content).toEqual([{ type: "text", text: "Successfully wrote 10 bytes to unused" }]);
	});
});
