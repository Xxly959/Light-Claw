import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

describe("LightClaw offline test entry", () => {
	it("defaults the unified evaluation CLI to a credential-free audit and rejects unknown suites", () => {
		const cli = fileURLToPath(new URL("../src/evals/cli.ts", import.meta.url));
		const options = {
			encoding: "utf8" as const,
			timeout: 10_000,
			env: {
				PATH: process.env.PATH,
				HOME: homedir(),
				TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
			},
		};
		const audit = spawnSync(
			process.execPath,
			["--import", createRequire(import.meta.url).resolve("tsx"), cli],
			options,
		);
		expect(audit.status, audit.stderr).toBe(0);
		expect(JSON.parse(audit.stdout).tasks).toBe(36);
		const rejected = spawnSync(
			process.execPath,
			["--import", createRequire(import.meta.url).resolve("tsx"), cli, "--suite=typo"],
			options,
		);
		expect(rejected.status).not.toBe(0);
		expect(rejected.stderr).toContain("Unknown evaluation suite");
	});
	it("is a mandatory workspace test script", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(pkg.scripts.test).toBe("tsx ../../node_modules/vitest/dist/cli.js --run");
	});
	it("blocks accidental network access even after test mock cleanup", async () => {
		vi.restoreAllMocks();
		expect(homedir()).toContain("lightclaw-offline-home-");
		expect(() => new Socket().connect(443, "example.invalid")).toThrow("Network disabled");
		await expect(fetch("https://example.invalid")).rejects.toThrow("Network disabled");
	});
});
