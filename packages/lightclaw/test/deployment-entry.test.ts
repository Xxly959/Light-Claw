import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { acquireControlLock } from "../src/goals/control.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lightclaw-batch4-entry-"));
	roots.push(root);
	const work = join(root, "work"),
		control = join(root, "control"),
		home = join(root, "home");
	for (const path of [work, control, home]) mkdirSync(path);
	return { root, work, control, home };
}
function invoke(args: string[], home: string, extra: Record<string, string> = {}) {
	return spawnSync(
		process.execPath,
		[
			"--import",
			createRequire(import.meta.url).resolve("tsx"),
			fileURLToPath(new URL("../src/main.ts", import.meta.url)),
			...args,
		],
		{
			encoding: "utf8",
			timeout: 10_000,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
				...extra,
			},
		},
	);
}
it("shows source CLI help without credentials, Docker, model calls or workspace creation", () => {
	const f = fixture(),
		r = invoke(["--help"], f.home);
	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain("--health=");
	expect(r.stdout).toContain("--sandbox=");
});
it("reports only local lock state without mistaking it for real platform health", () => {
	const f = fixture();
	const lock = acquireControlLock(f.control);
	try {
		const r = invoke([`--health=${f.work}`, `--control=${f.control}`], f.home);
		expect(r.status, r.stderr).toBe(0);
		expect(JSON.parse(r.stdout)).toMatchObject({ lock: "held", platform: "unverified", model: "unverified" });
	} finally {
		lock.release();
	}
	const r = invoke([`--health=${f.work}`, `--control=${f.control}`], f.home);
	expect(r.status, r.stderr).toBe(0);
	expect(JSON.parse(r.stdout).lock).toBe("free");
});

it("contains startup dependency exceptions instead of dumping raw stderr or SDK error objects", () => {
	const f = fixture(),
		bin = join(f.root, "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "docker"),
		"#!/bin/sh\nprintf 'fictional startup secret=sample-value-never-real\\n' >&2\nexit 1\n",
	);
	chmodSync(join(bin, "docker"), 0o700);
	const r = invoke(["--sandbox=docker:fictional", f.work], f.home, {
		PATH: `${bin}:${process.env.PATH}`,
		LIGHTCLAW_FEISHU_APP_ID: "fictional",
		LIGHTCLAW_FEISHU_APP_SECRET: "fictional",
	});
	expect(r.status).not.toBe(0);
	expect(r.stderr + r.stdout).not.toContain("sample-value-never-real");
	expect(r.stdout).toContain("Agent error");
});
