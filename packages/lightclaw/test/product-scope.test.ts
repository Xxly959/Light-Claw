import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as publicApi from "../src/index.js";

it("ships the personal Agent without research evaluator or benchmark entry points", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const lock = JSON.parse(readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8"));
	expect(Object.keys(pkg.bin).sort()).toEqual(["lightclaw", "lightclaw-audit", "lightclaw-goal-migrate"]);
	expect(lock.packages["packages/lightclaw"].bin).toEqual(pkg.bin);
	expect(Object.keys(publicApi)).not.toContain("resolvePromptInput");
	expect(pkg.files).not.toContain("evals");
	expect(pkg.scripts.build).not.toMatch(/benchmark|evals/);
	for (const path of ["../src/evals", "../src/benchmark", "../evals"])
		expect(existsSync(new URL(path, import.meta.url))).toBe(false);
});
it("prepares a platform checklist without depending on deleted research assets", () => {
	const script = fileURLToPath(new URL("../scripts/acceptance-plan.mjs", import.meta.url));
	const options = { encoding: "utf8" as const, timeout: 10000 };
	const result = spawnSync(process.execPath, [script, "platform"], options);
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout).cases.join(" ")).toContain("preview");
	const rejected = spawnSync(process.execPath, [script, "model"], options);
	expect(rejected.status).not.toBe(0);
	expect(rejected.stderr).toContain("platform");
});
it("offers a credential-free configuration template referenced by the starter", () => {
	const template = readFileSync(new URL("../config.env.example", import.meta.url), "utf8");
	expect(template).toContain("LIGHTCLAW_FEISHU_APP_SECRET=");
	expect(template).toContain("LIGHTCLAW_WORK_DIR=");
	expect(template).toContain("LIGHTCLAW_MODELS_FILE");
	const starter = readFileSync(new URL("../../../scripts/start-lightclaw.sh", import.meta.url), "utf8");
	expect(starter).toContain("packages/lightclaw/config.env.example");
	expect(starter).not.toContain("cp .env.example");
});
