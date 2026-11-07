import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { acquireControlLock } from "../src/goals/control.js";

const script = fileURLToPath(new URL("../scripts/state-backup.py", import.meta.url));
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "state-backup-"));
	roots.push(root);
	const work = join(root, "work"),
		control = join(root, "control"),
		backup = join(root, "backup");
	mkdirSync(work);
	mkdirSync(control);
	writeFileSync(join(work, "report.txt"), "fictional report");
	writeFileSync(join(control, "goal.json"), '{"state":"unknown"}');
	writeFileSync(join(work, ".env"), "FICTIONAL_SECRET=not-real");
	return { root, work, control, backup };
}
function run(args: string[]) {
	return spawnSync("python3", ["-I", script, ...args], { encoding: "utf8" });
}
it("roundtrips both roots with hashes and excludes credential/ephemeral files", () => {
	const f = fixture();
	const saved = run(["backup", "--workspace", f.work, "--control", f.control, "--out", f.backup]);
	expect(saved.status, saved.stderr).toBe(0);
	expect(existsSync(join(f.backup, "workspace", ".env"))).toBe(false);
	const restored = run([
		"restore",
		"--backup",
		f.backup,
		"--workspace",
		join(f.root, "restored-work"),
		"--control",
		join(f.root, "restored-control"),
	]);
	expect(restored.status, restored.stderr).toBe(0);
	expect(readFileSync(join(f.root, "restored-control", "goal.json"), "utf8")).toContain("unknown");
	expect(readFileSync(join(f.root, "restored-work", "report.txt"), "utf8")).toBe("fictional report");
});
it("cannot bypass a running instance's kernel lock", () => {
	const f = fixture(),
		lock = acquireControlLock(f.control);
	try {
		const result = run(["backup", "--workspace", f.work, "--control", f.control, "--out", f.backup]);
		expect(result.status).not.toBe(0);
		expect(existsSync(f.backup)).toBe(false);
	} finally {
		lock.release();
	}
});
it("rejects a corrupt backup and never overwrites destination state", () => {
	const f = fixture();
	expect(run(["backup", "--workspace", f.work, "--control", f.control, "--out", f.backup]).status).toBe(0);
	writeFileSync(join(f.backup, "control", "goal.json"), "tampered");
	const result = run([
		"restore",
		"--backup",
		f.backup,
		"--workspace",
		join(f.root, "restored-work"),
		"--control",
		join(f.root, "restored-control"),
	]);
	expect(result.status).not.toBe(0);
	expect(existsSync(join(f.root, "restored-work"))).toBe(false);
});

it.each([
	["workspace", "missing"],
	["control", "missing"],
	["workspace", "file"],
	["control", "file"],
] as const)("rejects a %s backup root (%s) before creating output or source state", (category, kind) => {
	const f = fixture();
	const invalid = join(f.root, "invalid-source");
	if (kind === "file") writeFileSync(invalid, "not a source directory");
	const result = run([
		"backup",
		"--workspace",
		category === "workspace" ? invalid : f.work,
		"--control",
		category === "control" ? invalid : f.control,
		"--out",
		f.backup,
	]);
	expect(result.status, result.stdout).not.toBe(0);
	expect(existsSync(f.backup)).toBe(false);
	if (kind === "missing") expect(existsSync(invalid)).toBe(false);
	expect(readFileSync(join(f.work, "report.txt"), "utf8")).toBe("fictional report");
});

it.skipIf(process.getuid?.() === 0)("refuses an unreadable source subtree instead of silently omitting it", () => {
	const f = fixture();
	const blocked = join(f.work, "blocked");
	mkdirSync(blocked);
	writeFileSync(join(blocked, "required.txt"), "must not disappear from a successful backup");
	chmodSync(blocked, 0o000);
	try {
		const result = run(["backup", "--workspace", f.work, "--control", f.control, "--out", f.backup]);
		expect(result.status, result.stdout).not.toBe(0);
		expect(existsSync(f.backup)).toBe(false);
	} finally {
		chmodSync(blocked, 0o700);
	}
});
