import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/verify-install.mjs", import.meta.url));
it("offers a native install verification plan without building or connecting services", () => {
	const result = spawnSync(process.execPath, [script, "plan"], { encoding: "utf8" });
	expect(result.status, result.stderr).toBe(0);
	const plan = JSON.parse(result.stdout);
	expect(plan.status).toBe("installation-not-verified");
	expect(plan.packages).toHaveLength(5);
	expect(plan.cli).toContain("lightclaw-audit");
});
it("fails closed before installation when fresh compiled artifacts are missing", () => {
	const root = mkdtempSync(join(tmpdir(), "install-preflight-"));
	try {
		const result = spawnSync(
			process.execPath,
			[script, "verify", "--root", root, "--out", join(root, "fresh-install")],
			{ encoding: "utf8" },
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("NOT VERIFIED");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("isolates npm into distinct empty config files without reading user configuration", () => {
	const root = mkdtempSync(join(tmpdir(), "install-config-"));
	try {
		const source = join(root, "source"),
			out = join(root, "output"),
			bin = join(root, "bin");
		mkdirSync(bin);
		for (const name of ["tui", "ai", "agent", "coding-agent", "lightclaw"]) {
			const dir = join(source, "packages", name);
			mkdirSync(join(dir, "src"), { recursive: true });
			mkdirSync(join(dir, "dist"));
			writeFileSync(join(dir, "src", "input.txt"), "fictional source");
			writeFileSync(join(dir, "dist", "index.js"), "// fictional preflight fixture, never installed");
			writeFileSync(join(dir, "dist", "index.d.ts"), "// fictional declaration");
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name, version: "1.0.0", main: "dist/index.js", types: "dist/index.d.ts", bin: {} }),
			);
		}
		for (const name of ["attachment-reader.py", "attachment-writer.py", "docker-supervisor.py"]) {
			writeFileSync(join(source, "packages", "lightclaw", "src", name), "# fictional fixture");
			writeFileSync(join(source, "packages", "lightclaw", "dist", name), "# fictional fixture");
		}
		for (const name of ["tui", "ai", "agent", "coding-agent", "lightclaw"])
			utimesSync(join(source, "packages", name, "src", "input.txt"), 0, 0);
		for (const name of ["attachment-reader.py", "attachment-writer.py", "docker-supervisor.py"])
			utimesSync(join(source, "packages", "lightclaw", "src", name), 0, 0);
		const shim = join(bin, "npm");
		writeFileSync(
			shim,
			`#!/usr/bin/env node
 const fs=require('node:fs'),path=require('node:path');
 const a=process.env.npm_config_userconfig,b=process.env.npm_config_globalconfig,home=process.env.HOME;
 if(a===b||!a.startsWith(home+path.sep)||!b.startsWith(home+path.sep)){console.error('invalid-config-isolation');process.exit(9);}
 if(fs.readFileSync(a,'utf8')!==''||fs.readFileSync(b,'utf8')!=='')throw new Error('config not empty');
 console.error('isolated-configs-verified');process.exit(9);
 `,
		);
		chmodSync(shim, 0o700);
		const result = spawnSync(
			process.execPath,
			[script, "verify", "--root", source, "--out", out, "--cache", join(root, "cache")],
			{ encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}` } },
		);
		expect(result.status).not.toBe(0);
		expect(readFileSync(join(out, "00.log"), "utf8")).toContain("isolated-configs-verified");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
