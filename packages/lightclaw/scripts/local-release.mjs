#!/usr/bin/env node
// Native Node tooling only: no compilation, lifecycle scripts, credentials, or network.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestName = "source-manifest.json";
const packages = new Set(["lightclaw", "ai", "agent", "coding-agent", "tui"]);

function allowed(path) {
	if (["package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json", "LICENSE"].includes(path)) return true;
	const parts = path.split("/");
	if (parts.some((part) => part.startsWith(".") || ["node_modules", "dist"].includes(part))) return false;
	if (parts[0] !== "packages" || !packages.has(parts[1])) return false;
	return parts.length === 3
		? /^(package\.json|tsconfig[^/]*\.json|README[^/]*|CHANGELOG\.md|Dockerfile|docker\.sh|vitest\.config\.ts)$/.test(parts[2])
		: ["src", "scripts", "docs", "evals", "test"].includes(parts[2]);
}

function safePath(root, path) {
	if (typeof path !== "string" || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new Error(`unsafe path: ${String(path)}`);
	}
	let current = root;
	for (const component of path.split("/")) {
		current = join(current, component);
		if (lstatSync(current).isSymbolicLink()) throw new Error(`symlink refused: ${path}`);
	}
	return current;
}

function hash(content) {
	return createHash("sha256").update(content).digest("hex");
}

function prepare(root, output) {
	if (existsSync(output)) throw new Error("output must not exist; choose a fresh directory");
	const location = relative(root, output);
	if (!location.startsWith(`..${sep}`) && location !== ".." && !isAbsolute(location)) throw new Error("output must be outside source root");
	const scope = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json", "LICENSE", ...[...packages].map(name => `packages/${name}`)];
 const gitFiles = (args) => execFileSync("git", ["-C", root, "ls-files", "-z", ...args, "--", ...scope], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean);
	const tracked = new Set(gitFiles(["--cached"]));
	const candidates = [...new Set([...tracked, ...gitFiles(["--others", "--exclude-standard"])])].filter(allowed).sort();
	// Validate all inputs first, including ancestor symlinks. Never follow workspace links.
	const present = candidates.filter((path) => {
		try {
			lstatSync(join(root, path));
			return true;
		} catch (error) {
			if (error.code === "ENOENT" && tracked.has(path)) return false;
			throw error;
		}
	});
	const files = present.map((path) => {
		const source = safePath(root, path);
		if (!lstatSync(source).isFile()) throw new Error(`not a regular source file: ${path}`);
		const content = readFileSync(source);
		return { path, git: tracked.has(path) ? "tracked" : "untracked", bytes: content.length, sha256: hash(content), content };
	});
	if (!files.some((file) => file.path === "packages/lightclaw/package.json")) throw new Error("lightclaw package metadata missing");
	for (const file of files) {
		const destination = join(output, file.path);
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, file.content);
	}
	const manifest = {
		format: 1,
		kind: "local-source-review-material",
		compiledRuntime: "NOT VERIFIED: no build or dependency installation performed",
		createdAt: new Date().toISOString(),
		evaluatorBoundary: "evals and tests remain in their package trees; never copy blind evaluator assets into an Agent working directory",
		files: files.map(({ content: _content, ...file }) => file),
	};
	writeFileSync(join(output, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(JSON.stringify({ kind: manifest.kind, files: files.length, output }));
}

function walk(root, prefix = "") {
	const result = [];
	for (const name of readdirSync(join(root, prefix))) {
		const path = prefix ? `${prefix}/${name}` : name;
		const stat = lstatSync(join(root, path));
		if (stat.isSymbolicLink()) throw new Error(`symlink refused: ${path}`);
		if (stat.isDirectory()) result.push(...walk(root, path));
		else if (stat.isFile()) result.push(path);
		else throw new Error(`not a regular file: ${path}`);
	}
	return result;
}

function verify(root) {
	const manifestPath = safePath(root, manifestName);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.format !== 1 || manifest.kind !== "local-source-review-material" || !Array.isArray(manifest.files)) throw new Error("unsupported source manifest");
	const expected = new Set([manifestName]);
	for (const file of manifest.files) {
		if (expected.has(file.path) || !allowed(file.path)) throw new Error(`invalid manifest file: ${file.path}`);
		expected.add(file.path);
		const source = safePath(root, file.path);
		if (!lstatSync(source).isFile()) throw new Error(`not a regular file: ${file.path}`);
		const content = readFileSync(source);
		if (hash(content) !== file.sha256 || content.length !== file.bytes) throw new Error(`hash mismatch: ${file.path}`);
	}
	for (const path of walk(root)) if (!expected.has(path)) throw new Error(`unlisted release file: ${path}`);
	console.log(JSON.stringify({ verified: "source material only", files: manifest.files.length }));
}

function verifyDist(root) {
	const metadata = JSON.parse(readFileSync(safePath(root, "package.json"), "utf8"));
	const entries = [metadata.main, metadata.types, ...Object.values(metadata.bin ?? {})];
	if (entries.length < 3 || entries.some((entry) => typeof entry !== "string")) throw new Error("NOT VERIFIED: main/types/bin declarations missing");
	const missing = [];
	for (const entry of entries) {
		const path = entry.replace(/^\.\//, "");
		try {
			if (!path.startsWith("dist/") || !lstatSync(safePath(root, path)).isFile()) missing.push(path);
		} catch (error) {
			missing.push(`${path} (${error.message})`);
		}
	}
	if (missing.length) throw new Error(`NOT VERIFIED: compiled entry files missing or invalid: ${missing.join(", ")}`);
	console.log("Declared dist entry files exist; compilation freshness, dependency closure and runnable installation NOT VERIFIED");
}

try {
	const [command, ...args] = process.argv.slice(2);
	if (command === "--help" || command === "-h") {
		console.log("Local source material tooling (no build, install, network, credentials):\n  prepare [--root REPOSITORY] --output FRESH_DIRECTORY\n  verify SOURCE_DIRECTORY\n  verify-dist PACKAGE_DIRECTORY\nReview the explicit manifest before sharing. This is not a compiled runtime release.");
	} else if (command === "prepare") {
		let root = scriptRoot;
		let output;
		for (let index = 0; index < args.length; index += 2) {
			if (!args[index + 1]) throw new Error("option value missing");
			if (args[index] === "--root") root = resolve(args[index + 1]);
			else if (args[index] === "--output") output = resolve(args[index + 1]);
			else throw new Error(`unknown option: ${args[index]}`);
		}
		if (!output) throw new Error("--output is required");
		prepare(root, output);
	} else if ((command === "verify" || command === "verify-dist") && args.length === 1) {
		if (command === "verify") verify(resolve(args[0]));
		else verifyDist(resolve(args[0]));
	} else throw new Error("Use --help for local release commands");
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
