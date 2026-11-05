import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLightClawRuntime, featureEnabled, loadConfig } from "../src/index.js";

const packageDir = resolve(import.meta.dirname, "..");
const script = join(packageDir, "scripts/local-release.mjs");
const temporary: string[] = [];
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "lightclaw-packaging-"));
	temporary.push(directory);
	const root = join(directory, "repo");
	mkdirSync(join(root, "packages/lightclaw/src"), { recursive: true });
	writeFileSync(join(root, "package.json"), '{"private":true}');
	writeFileSync(join(root, "packages/lightclaw/package.json"), '{"name":"lightclaw"}');
	writeFileSync(join(root, "packages/lightclaw/src/main.ts"), "export const fixture = true;");
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-C", root, "add", "package.json", "packages/lightclaw/package.json"]);
	return { root, output: join(directory, "release") };
}
function run(args: string[]) {
	return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}
afterEach(() => {
	for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local source release contract", () => {
	it("maps the declared library entry to a real source API without starting a platform", () => {
		const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
			main: string;
			types: string;
		};
		expect(metadata.main).toBe("./dist/index.js");
		expect(metadata.types).toBe("./dist/index.d.ts");
		expect(existsSync(join(packageDir, "src/index.ts"))).toBe(true);
		expect(typeof createLightClawRuntime).toBe("function");
		expect(typeof loadConfig).toBe("function");
		expect(typeof featureEnabled).toBe("function");
	});
	it("has a credential-free native help command", () => {
		const result = run(["--help"]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("source material");
	});
	it("captures tracked and untracked source with hashes and verifies independently of git", () => {
		const { root, output } = fixture();
		writeFileSync(join(root, ".env"), "FICTIONAL_SECRET=not-a-real-key");
		const prepared = run(["prepare", "--root", root, "--output", output]);
		expect(prepared.status, prepared.stderr).toBe(0);
		const manifest = JSON.parse(readFileSync(join(output, "source-manifest.json"), "utf8")) as {
			files: { path: string; git: string; sha256: string }[];
		};
		expect(manifest.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "package.json", git: "tracked" }),
				expect.objectContaining({ path: "packages/lightclaw/src/main.ts", git: "untracked" }),
			]),
		);
		expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
		expect(existsSync(join(output, ".env"))).toBe(false);
		rmSync(root, { recursive: true });
		expect(run(["verify", output]).status).toBe(0);
		writeFileSync(join(output, "packages/lightclaw/src/main.ts"), "tampered");
		const tampered = run(["verify", output]);
		expect(tampered.status).toBe(1);
		expect(tampered.stderr).toContain("hash mismatch");
	});

	it("prepares only release scope even when unrelated untracked names exceed the subprocess buffer", () => {
		const { root, output } = fixture();
		const dir = join(root, "docs", "diagnosis");
		mkdirSync(dir, { recursive: true });
		for (let n = 0; n < 5200; n++)
			writeFileSync(join(dir, `${String(n).padStart(5, "0")}-${"x".repeat(210)}.txt`), "fictional");
		const result = run(["prepare", "--root", root, "--output", output]);
		expect(result.status, result.stderr).toBe(0);
		const manifest = JSON.parse(readFileSync(join(output, "source-manifest.json"), "utf8"));
		expect(manifest.files.some((entry: { path: string }) => entry.path.startsWith("docs/diagnosis"))).toBe(false);
		expect(existsSync(join(output, "packages/lightclaw/src/main.ts"))).toBe(true);
	});
	it("rejects symlink sources instead of hiding workspace dependencies", () => {
		const { root, output } = fixture();
		symlinkSync(join(root, "package.json"), join(root, "packages/lightclaw/src/link.ts"));
		const result = run(["prepare", "--root", root, "--output", output]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("symlink");
		expect(existsSync(output)).toBe(false);
	});
	it("rejects dangling source symlinks rather than silently excluding them", () => {
		const { root, output } = fixture();
		symlinkSync("missing.ts", join(root, "packages/lightclaw/src/link.ts"));
		const result = run(["prepare", "--root", root, "--output", output]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("symlink");
	});
	it("rejects unlisted files and symlinks added to release material", () => {
		const { root, output } = fixture();
		expect(run(["prepare", "--root", root, "--output", output]).status).toBe(0);
		const extra = join(output, "extra");
		writeFileSync(extra, "unexpected");
		expect(run(["verify", output]).stderr).toContain("unlisted");
		rmSync(extra);
		symlinkSync(join(output, "package.json"), extra);
		expect(run(["verify", output]).stderr).toContain("symlink");
	});
	it("fails compiled release verification when declared dist entries are absent", () => {
		const { root } = fixture();
		const packageRoot = join(root, "packages/lightclaw");
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({
				main: "./dist/index.js",
				types: "./dist/index.d.ts",
				bin: { lightclaw: "dist/main.js" },
			}),
		);
		const result = run(["verify-dist", packageRoot]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("NOT VERIFIED");
		expect(result.stderr).toContain("dist/index.js");
		expect(existsSync(join(packageRoot, "dist"))).toBe(false);
	});
});
