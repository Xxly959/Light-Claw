#!/usr/bin/env node
// Native preparation/verification only. This script never builds or publishes.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const names = ["tui", "ai", "agent", "coding-agent", "lightclaw"];
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
function walk(root) {
 return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const path = join(root, entry.name); if (lstatSync(path).isSymbolicLink()) throw new Error("NOT VERIFIED: linked artifact");
  return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
 });
}
function plan(root) {
 const packages = names.map(name => { const directory = join(root, "packages", name), metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")); return { name: metadata.name, directory, main: metadata.main, types: metadata.types, bin: metadata.bin, dependencies: metadata.dependencies }; });
 return { status: "installation-not-verified", packages, cli: Object.keys(packages.at(-1).bin),
  command: "After explicitly approved fresh builds: node scripts/verify-install.mjs verify --root FRESH_SOURCE --out NEW_INSTALL --cache APPROVED_OFFLINE_NPM_CACHE",
  constraints: "No build, publish, platform or model calls; offline install needs complete dependency cache; failures retain logs." };
}
function verify(root, out, cache) {
 const material = plan(root);
 if (existsSync(out)) throw new Error("NOT VERIFIED: fresh output required");
 if (!cache) throw new Error("NOT VERIFIED: explicit complete offline dependency cache required");
 const files = [];
 for (const packageInfo of material.packages) {
  const { directory } = packageInfo;
  if (!existsSync(join(directory, "dist"))) throw new Error(`NOT VERIFIED: missing dist: ${directory}`);
  const newestSource = Math.max(...walk(join(directory, "src")).map(path => lstatSync(path).mtimeMs));
  const compiled = walk(join(directory, "dist"));
  if (!compiled.length || compiled.some(path => lstatSync(path).mtimeMs < newestSource)) throw new Error(`NOT VERIFIED: stale dist; clean fresh approved build required: ${directory}`);
  for (const entry of [packageInfo.main, packageInfo.types, ...Object.values(packageInfo.bin ?? {})].filter(Boolean)) {
   if (typeof entry !== "string" || !existsSync(join(directory, entry))) throw new Error(`NOT VERIFIED: missing entry ${entry}`);
  }
  files.push(...compiled.map(path => ({ path, sha256: hash(path) })));
 }
 const lightclaw = material.packages.at(-1).directory;
 for (const helper of ["attachment-reader.py", "attachment-writer.py", "docker-supervisor.py"]) {
  if (!existsSync(join(lightclaw, "dist", helper)) || hash(join(lightclaw, "src", helper)) !== hash(join(lightclaw, "dist", helper))) throw new Error(`NOT VERIFIED: missing/stale helper ${helper}`);
 }
 mkdirSync(out, { recursive: true, mode: 0o700 });
 const archives = join(out, "archives"), install = join(out, "install"), home = join(out, "home");
 for (const path of [archives, install, home]) mkdirSync(path);
 const userConfig = join(home, "user.npmrc"), globalConfig = join(home, "global.npmrc");
 for (const path of [userConfig, globalConfig]) writeFileSync(path, "", { flag: "wx", mode: 0o600 });
 const env = { PATH: process.env.PATH, HOME: home, npm_config_cache: cache, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, NO_PROXY: "*" };
 let index = 0;
 const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120000 });
  writeFileSync(join(out, `${String(index++).padStart(2, "0")}.log`), JSON.stringify({ command, args, cwd, status: result.status }) + "\n" + result.stdout + result.stderr);
  if (result.status !== 0) throw new Error(`NOT VERIFIED: command failed (${command}); see retained logs`);
  return result.stdout;
 };
 const tarballs = material.packages.map(info => {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", archives], info.directory));
  return join(archives, packed[0].filename);
 });
 writeFileSync(join(install, "package.json"), '{"private":true,"type":"module"}\n');
 run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], install);
 run(process.execPath, ["--input-type=module", "-e", "import 'lightclaw'; console.log('library import ok')"], install);
 for (const bin of material.cli) {
  const output = run(join(install, "node_modules", ".bin", bin), ["--help"], install);
  if (output.trim().length < 20 || !output.toLowerCase().includes("lightclaw")) throw new Error(`NOT VERIFIED: missing CLI help output (${bin}); see retained logs`);
 }
 run(join(install, "node_modules", ".bin", "lightclaw-eval"), ["--suite=reliability", "--mode=audit"], install);
 writeFileSync(join(out, "verification.json"), JSON.stringify({ status: "clean-install-cli-verified", platform: process.platform, node: process.version, files, tarballs, limits: "No real platform/model or production workload; Python behavior separately verified by offline backup/attachment regressions." }, null, 2));
 console.log(JSON.stringify({ out, status: "clean-install-cli-verified" }));
}
try {
 const [mode = "plan", ...args] = process.argv.slice(2), options = new Map();
 for (let i = 0; i < args.length; i += 2) { if (!["--root", "--out", "--cache"].includes(args[i]) || !args[i + 1]) throw new Error("NOT VERIFIED: invalid arguments"); options.set(args[i], resolve(args[i + 1])); }
 const root = options.get("--root") ?? defaultRoot;
 if (["plan", "--help"].includes(mode)) console.log(JSON.stringify(plan(root), null, 2));
 else if (mode === "verify" && options.has("--out")) verify(root, options.get("--out"), options.get("--cache"));
 else throw new Error("NOT VERIFIED: use plan or verify --root SOURCE --out NEW --cache CACHE");
} catch (error) { console.error(`NOT VERIFIED: ${error.message}`); process.exitCode = 1; }
