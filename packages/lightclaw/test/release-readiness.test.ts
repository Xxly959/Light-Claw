import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const loader = createRequire(import.meta.url).resolve("tsx");
it.each(["main", "goals/migrate-cli", "audit/cli"])("provides credential-free help for %s", (entry) => {
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
});
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

it("builds pi-ai from its pinned catalog without network or source mutation", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-offline-build-"));
	try {
		const ai = resolve(import.meta.dirname, "../../ai");
		const pkg = join(root, "packages", "ai");
		mkdirSync(pkg, { recursive: true });
		for (const name of ["src", "scripts"]) cpSync(join(ai, name), join(pkg, name), { recursive: true });
		for (const name of ["package.json", "tsconfig.build.json"]) cpSync(join(ai, name), join(pkg, name));
		cpSync(resolve(ai, "../../tsconfig.base.json"), join(root, "tsconfig.base.json"));
		writeFileSync(join(root, "package.json"), '{"private":true,"type":"module","workspaces":["packages/*"]}');
		symlinkSync(resolve(ai, "../../node_modules"), join(root, "node_modules"), "dir");
		const home = join(root, "home");
		mkdirSync(home);
		const userConfig = join(home, "user.npmrc"),
			globalConfig = join(home, "global.npmrc");
		for (const path of [userConfig, globalConfig]) writeFileSync(path, "");
		const touched = join(root, "network-attempted");
		const bootstrap = join(root, "deny-network.mjs");
		writeFileSync(
			bootstrap,
			`import {writeFileSync} from 'node:fs'; import net from 'node:net'; const deny=()=>{writeFileSync(${JSON.stringify(touched)},new Error('network attempted').stack);throw new Error('offline build must not access the network')}; globalThis.fetch=deny; net.Socket.prototype.connect=deny;`,
		);
		const catalog = join(pkg, "src/models.generated.ts");
		const before = readFileSync(catalog, "utf8");
		const result = spawnSync("npm", ["run", "build", "--workspace=@mariozechner/pi-ai"], {
			cwd: root,
			encoding: "utf8",
			timeout: 60000,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				NODE_OPTIONS: `--import=${bootstrap}`,
				npm_config_userconfig: userConfig,
				npm_config_globalconfig: globalConfig,
				npm_config_cache: join(root, "cache"),
				npm_config_offline: "true",
				npm_config_update_notifier: "false",
				npm_config_audit: "false",
				npm_config_fund: "false",
			},
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(existsSync(touched), existsSync(touched) ? readFileSync(touched, "utf8") : "no network attempts").toBe(
			false,
		);
		expect(readFileSync(catalog, "utf8")).toBe(before);
		expect(readFileSync(join(pkg, "dist/models.generated.js"), "utf8")).toContain('"gpt-5-mini"');
		expect(readFileSync(join(pkg, "dist/index.d.ts"), "utf8")).toContain('"./models.js"');
		expect(readFileSync(join(pkg, "dist/models.d.ts"), "utf8")).toContain("getModel");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 70000);
