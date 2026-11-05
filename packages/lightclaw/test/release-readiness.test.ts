import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const loader = createRequire(import.meta.url).resolve("tsx");
it.each(["main", "benchmark/cli", "evals/cli", "evals/optimize-cli", "goals/migrate-cli", "audit/cli"])(
	"provides credential-free help for %s",
	(entry) => {
		const result = spawnSync(
			process.execPath,
			["--import", loader, fileURLToPath(new URL(`../src/${entry}.ts`, import.meta.url)), "--help"],
			{
				encoding: "utf8",
				timeout: 15000,
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
				},
			},
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.length).toBeGreaterThan(20);
	},
);
it("ships Python helpers beside compiled code and declares no runtime tsx dependency", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	for (const name of ["attachment-reader.py", "attachment-writer.py", "docker-supervisor.py"])
		expect(pkg.scripts.build).toContain(name);
	for (const name of ["attachments.ts", "feishu-resources.ts", "sandbox.ts"])
		expect(readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")).not.toContain("../src/");
	expect(pkg.dependencies.tsx).toBeUndefined();
});

it("retains checked-in provider definitions when catalog refresh omits a known provider", () => {
	const root = mkdtempSync(join(tmpdir(), "model-catalog-fallback-"));
	try {
		const ai = resolve(import.meta.dirname, "../../ai");
		cpSync(join(ai, "src"), join(root, "src"), { recursive: true });
		mkdirSync(join(root, "scripts"));
		cpSync(join(ai, "scripts/generate-models.ts"), join(root, "scripts/generate-models.ts"));
		symlinkSync(resolve(ai, "../../node_modules"), join(root, "node_modules"), "dir");
		const bootstrap = join(root, "offline.mjs");
		writeFileSync(
			bootstrap,
			`globalThis.fetch=async(url)=>new Response(JSON.stringify(String(url).includes('models.dev')?{}:{data:[]}),{status:200,headers:{'Content-Type':'application/json'}});`,
		);
		const result = spawnSync(
			process.execPath,
			["--import", bootstrap, "--import", loader, join(root, "scripts/generate-models.ts")],
			{
				cwd: root,
				encoding: "utf8",
				timeout: 30000,
				env: {
					PATH: process.env.PATH,
					HOME: join(root, "home"),
					TSX_TSCONFIG_PATH: resolve(ai, "../../tsconfig.json"),
				},
			},
		);
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(join(root, "src/models.generated.ts"), "utf8")).toContain('"kimi-coding"');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("freezes installed ESM-only dependencies using import exports rather than CommonJS resolution", () => {
	const root = mkdtempSync(join(tmpdir(), "esm-freeze-"));
	try {
		const pkg = join(root, "node_modules", "lightclaw");
		cpSync(resolve(import.meta.dirname, "../src"), join(pkg, "dist"), { recursive: true });
		cpSync(resolve(import.meta.dirname, "../evals"), join(pkg, "evals"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), '{"name":"lightclaw","type":"module"}');
		for (const name of ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"]) {
			const dir = join(root, "node_modules", "@mariozechner", name);
			mkdirSync(join(dir, "dist"), { recursive: true });
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({
					name: `@mariozechner/${name}`,
					type: "module",
					exports: { ".": { import: "./dist/index.js" } },
				}),
			);
			writeFileSync(join(dir, "dist", "index.js"), "export const fixture = true;");
		}
		const config = join(root, "tsconfig.json");
		writeFileSync(
			config,
			'{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022"}}',
		);
		const entry = join(root, "probe.mts");
		writeFileSync(
			entry,
			`import {frozenHashes} from './node_modules/lightclaw/dist/evals/reliability/protocol.ts'; const hashes=frozenHashes(); if(!hashes['dependency/pi-ai/index.js'])throw new Error('missing dependency'); console.log('installed ESM freeze verified');`,
		);
		const result = spawnSync(process.execPath, ["--import", loader, entry], {
			cwd: root,
			encoding: "utf8",
			timeout: 15000,
			env: { PATH: process.env.PATH, HOME: join(root, "home"), TSX_TSCONFIG_PATH: config },
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("installed ESM freeze verified");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("executes benchmark help through an installed-style bin symlink", () => {
	const root = mkdtempSync(join(tmpdir(), "benchmark-bin-"));
	try {
		const bin = join(root, "lightclaw-benchmark");
		symlinkSync(fileURLToPath(new URL("../src/benchmark/cli.ts", import.meta.url)), bin);
		const result = spawnSync(process.execPath, ["--import", loader, bin, "--help"], {
			encoding: "utf8",
			timeout: 15000,
			env: {
				PATH: process.env.PATH,
				HOME: root,
				TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
			},
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("lightclaw-benchmark --channels=");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("runs benchmark tasks with an aliased system temporary directory and cleans owned control state", () => {
	const root = mkdtempSync(join(tmpdir(), "benchmark-temp-"));
	try {
		const canonical = join(root, "canonical");
		mkdirSync(canonical);
		const alias = join(root, "alias");
		symlinkSync(canonical, alias, "dir");
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				loader,
				fileURLToPath(new URL("../src/benchmark/cli.ts", import.meta.url)),
				"--channels=1",
				"--warmup-rounds=1",
				"--measurement-rounds=2",
				"--tasks-per-channel=1",
				"--model-delay-ms=0",
				"--tool-delay-ms=0",
				`--output=${join(root, "output")}`,
			],
			{
				encoding: "utf8",
				timeout: 30000,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					TMPDIR: alias,
					TMP: alias,
					TEMP: alias,
					TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
				},
			},
		);
		expect(result.status, result.stderr).toBe(0);
		const artifacts = JSON.parse(result.stdout);
		const tasks = readFileSync(artifacts.tasksPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(tasks).toHaveLength(3);
		expect(tasks.every((task) => task.status === "completed")).toBe(true);
		expect(readdirSync(canonical).filter((name) => name.startsWith("lightclaw-benchmark-"))).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
