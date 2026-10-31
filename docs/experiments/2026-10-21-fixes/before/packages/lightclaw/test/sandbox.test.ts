import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutor } from "../src/sandbox.js";

const archives: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(archives.splice(0).map((path) => rm(path, { force: true })));
});

function nodeCommand(script: string): string {
	const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
	return `${quote(process.execPath)} -e ${quote(script)}`;
}

describe("宿主执行器错误与输出", () => {
	it("rejects explicit timer overflow before spawning a command", async () => {
		const marker = join(tmpdir(), `lightclaw-invalid-timeout-${process.pid}`);
		archives.push(marker);
		await rm(marker, { force: true });
		await expect(
			createExecutor({ type: "host" }).exec(
				nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`),
				{ timeout: 2147484 },
			),
		).rejects.toThrow("timer");
		expect(existsSync(marker)).toBe(false);
	});
	it("archives UTF-8 stderr fully and preserves a valid tail with private file permissions", async () => {
		const result = await createExecutor({ type: "host" }).exec(
			nodeCommand("process.stderr.write('界'.repeat(4 * 1024 * 1024) + 'UTF8-END')"),
		);
		if (!result.fullOutputPath) throw new Error("missing stderr archive");
		archives.push(result.fullOutputPath);
		expect(result.stderr.endsWith("UTF8-END")).toBe(true);
		expect(result.stderr).not.toContain("\uFFFD");
		const full = await readFile(result.fullOutputPath, "utf8");
		const hash = (text: string) => createHash("sha256").update(text).digest("hex");
		expect(hash(full)).toBe(hash(`${"界".repeat(4 * 1024 * 1024)}UTF8-END`));
		expect((await stat(result.fullOutputPath)).mode & 0o777).toBe(0o600);
	});

	it("rejects host archive failures and permits the next command", async () => {
		vi.stubEnv("TMPDIR", join(tmpdir(), `lightclaw-missing-archive-${process.pid}`, "missing"));
		const executor = createExecutor({ type: "host" });
		await expect(executor.exec(nodeCommand("process.stdout.write('x'.repeat(12 * 1024 * 1024))"))).rejects.toThrow(
			"Command output archive failed",
		);
		expect((await executor.exec("printf recovered")).stdout).toBe("recovered");
	});

	it("finishes a large-output archive before rejecting cancellation", async () => {
		const marker = join(tmpdir(), `lightclaw-archive-flushed-${process.pid}`);
		archives.push(marker);
		await rm(marker, { force: true });
		const controller = new AbortController();
		const script = `process.stdout.write('x'.repeat(12 * 1024 * 1024) + 'CANCEL-END', () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready')); setInterval(()=>{},1000);`;
		const pending = createExecutor({ type: "host" })
			.exec(nodeCommand(script), { signal: controller.signal })
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		try {
			await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 5000, interval: 10 });
		} finally {
			controller.abort();
		}
		const error = await pending;
		if (!(error instanceof Error)) throw new Error("expected aborted command");
		expect(error.message.endsWith("Command aborted")).toBe(true);
		const archive = /Full output: ([^\n]+)/.exec(error.message)?.[1];
		if (!archive) throw new Error("missing cancellation archive");
		archives.push(archive);
		const full = await readFile(archive, "utf8");
		expect(full.length).toBe(12 * 1024 * 1024 + "CANCEL-END".length);
		expect(full.endsWith("CANCEL-END")).toBe(true);
	});
	it("超出捕获上限时归档完整输出并保留末尾", async () => {
		const result = await createExecutor({ type: "host" }).exec(
			nodeCommand("process.stdout.write('x'.repeat(12 * 1024 * 1024) + 'FINAL-SENTINEL')"),
		);
		const archive = (result as typeof result & { fullOutputPath?: string }).fullOutputPath;
		if (archive) archives.push(archive);
		expect(result.stdout.endsWith("FINAL-SENTINEL")).toBe(true);
		expect(archive).toBeTypeOf("string");
		if (!archive) throw new Error("missing archive");
		const full = await readFile(archive, "utf8");
		expect(full.length).toBe(12582926);
		expect(full.endsWith("FINAL-SENTINEL")).toBe(true);
	});

	it("异步 spawn 错误被调用者捕获，进程继续运行", async () => {
		const modulePath = new URL("../src/sandbox.ts", import.meta.url).href;
		const script = `import {createExecutor} from ${JSON.stringify(modulePath)}; try { await createExecutor({type:'host'}).exec('true'); process.exitCode=2; } catch (error) { if (error.code !== 'ENOENT') throw error; console.log('caught ENOENT'); }`;
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				env: { ...process.env, PATH: "/lightclaw-no-shell" },
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on("error", reject);
			child.on("close", (code) => resolve({ code, stdout, stderr }));
		});
		expect(result).toEqual({ code: 0, stdout: "caught ENOENT\n", stderr: "" });
	});

	it("预先取消的命令没有副作用", async () => {
		const path = `/tmp/lightclaw-preabort-${process.pid}`;
		await rm(path, { force: true });
		await expect(
			createExecutor({ type: "host" }).exec(nodeCommand(`require('fs').writeFileSync('${path}', 'x')`), {
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow(/abort/i);
		expect(existsSync(path)).toBe(false);
	});

	it("超时和取消后仍可运行后续命令", async () => {
		const executor = createExecutor({ type: "host" });
		await expect(executor.exec(nodeCommand("setInterval(()=>{},1000)"), { timeout: 0.05 })).rejects.toThrow(
			/timed out/,
		);
		await expect(
			executor.exec(nodeCommand("setInterval(()=>{},1000)"), { signal: AbortSignal.timeout(50) }),
		).rejects.toThrow(/abort/i);
		expect((await executor.exec("printf recovered")).stdout).toBe("recovered");
	});
});

import { createHash } from "node:crypto";
