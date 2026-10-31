import { execFileSync } from "node:child_process";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FeishuBot } from "../src/feishu.js";
import { SlackBot } from "../src/slack.js";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(platform: "feishu" | "slack"): {
	root: string;
	workingDir: string;
	uploads: Buffer[];
	bot: Pick<FeishuBot, "uploadFile">;
} {
	const root = mkdtempSync(join(tmpdir(), "lightclaw-attachment-"));
	directories.push(root);
	const workingDir = join(root, "workspace");
	mkdirSync(join(workingDir, "current", "nested"), { recursive: true });
	mkdirSync(join(workingDir, "other"));
	writeFileSync(join(workingDir, "current", "nested", "report.txt"), "authorized report");
	writeFileSync(join(workingDir, "other", "private.txt"), "fictional other channel");
	writeFileSync(join(root, "outside.txt"), "fictional outside file");
	const uploads: Buffer[] = [];
	const bot =
		platform === "feishu"
			? Object.assign(Object.create(FeishuBot.prototype) as FeishuBot, {
					workingDir,
					client: {
						im: {
							v1: {
								file: {
									create: async ({ data }: { data: { file: Buffer } }) => {
										uploads.push(data.file);
										return { file_key: "mock-key" };
									},
								},
								message: { create: async () => ({ code: 0 }) },
							},
						},
					},
				})
			: Object.assign(Object.create(SlackBot.prototype) as SlackBot, {
					workingDir,
					webClient: {
						files: {
							uploadV2: async ({ file }: { file: Buffer }) => {
								uploads.push(file);
							},
						},
					},
				});
	return { root, workingDir, uploads, bot };
}

describe.each(["feishu", "slack"] as const)("%s attachment filesystem boundary", (platform) => {
	it("rejects an outside absolute path before SDK upload", async () => {
		const f = fixture(platform);
		await expect(f.bot.uploadFile("current", join(f.root, "outside.txt"))).rejects.toThrow();
		expect(f.uploads).toEqual([]);
	});
	it("uploads current-channel relative bytes", async () => {
		const f = fixture(platform);
		await f.bot.uploadFile("current", "nested/report.txt", "Report");
		expect(f.uploads.map((b) => b.toString())).toEqual(["authorized report"]);
	});
	it.each([
		"../other/private.txt",
		"nested/../../other/private.txt",
		"/workspace/other/private.txt",
		"nested/../nested/report.txt",
		"nested\\report.txt",
	])("rejects ambiguous or escaping path %s", async (path) => {
		const f = fixture(platform);
		await expect(f.bot.uploadFile("current", path)).rejects.toThrow();
		expect(f.uploads).toEqual([]);
	});
	it.each(["../other", "/other", ".", "current/../other"])("rejects unsafe channel %s", async (channel) => {
		const f = fixture(platform);
		await expect(f.bot.uploadFile(channel, "private.txt")).rejects.toThrow();
		expect(f.uploads).toEqual([]);
	});
	it.each(["leaf", "directory", "channel", "hardlink", "fifo", "folder", "large"])(
		"rejects %s at the read boundary",
		async (kind) => {
			const f = fixture(platform);
			const channel = join(f.workingDir, "current");
			let path = "blocked";
			if (kind === "leaf") symlinkSync(join(f.root, "outside.txt"), join(channel, path));
			if (kind === "directory") {
				symlinkSync(join(f.workingDir, "other"), join(channel, path));
				path += "/private.txt";
			}
			if (kind === "channel") {
				rmSync(channel, { recursive: true });
				symlinkSync(join(f.workingDir, "other"), channel);
				path = "private.txt";
			}
			if (kind === "hardlink") linkSync(join(f.root, "outside.txt"), join(channel, path));
			if (kind === "fifo") execFileSync("mkfifo", [join(channel, path)]);
			if (kind === "folder") mkdirSync(join(channel, path));
			if (kind === "large") {
				writeFileSync(join(channel, path), "");
				truncateSync(join(channel, path), 20 * 1024 * 1024 + 1);
			}
			await expect(f.bot.uploadFile("current", path)).rejects.toThrow();
			expect(f.uploads).toEqual([]);
		},
	);
});

const reader = fileURLToPath(new URL("../src/attachment-reader.py", import.meta.url));
it.each(["directory-before", "directory-after", "leaf-before", "leaf-after", "growth", "rewrite"])(
	"pins descriptors under deterministic %s race",
	(race) => {
		const f = fixture("slack");
		const code = `
import os, runpy, sys
from unittest.mock import patch
reader, root, race = sys.argv[1:]
read_attachment = runpy.run_path(reader)["read_attachment"]
original_open, original_read = os.open, os.read
swapped = False
def swap():
    base = os.path.join(root, "current")
    target = os.path.join(base, "nested" if race.startswith("directory") else "nested/report.txt")
    os.rename(target, target + ".saved")
    os.symlink(os.path.join(root, "other") if race.startswith("directory") else os.path.join(root, "other/private.txt"), target)
def opening(path, flags, *args, **kwargs):
    global swapped
    target = "nested" if race.startswith("directory") else "report.txt"
    active = path == target and not swapped and race not in ("growth", "rewrite")
    if active:
        swapped = True
        if race.endswith("before"): swap()
    fd = original_open(path, flags, *args, **kwargs)
    if active and race.endswith("after"): swap()
    return fd
def reading(fd, size):
    global swapped
    result = original_read(fd, size)
    if not swapped and race in ("growth", "rewrite"):
        swapped = True
        with open(os.path.join(root, "current/nested/report.txt"), "r+b") as out:
            if race == "growth": out.truncate(33)
            else: out.write(b"X")
    return result
with patch("os.open", opening), patch("os.read", reading):
    try:
        result = read_attachment(root, "current", "nested/report.txt", 32)
        sys.stdout.buffer.write(result)
    except (OSError, ValueError):
        sys.stdout.write("REJECTED")
`;
		const bytes = execFileSync("python3", ["-I", "-c", code, reader, realpathSync(f.workingDir), race], {
			encoding: "utf8",
		});
		if (race.endsWith("after")) expect(bytes).toBe("authorized report");
		else expect(bytes).toBe("REJECTED");
	},
);
