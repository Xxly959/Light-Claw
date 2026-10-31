import { createHash } from "node:crypto";
import type * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireControlLock } from "../src/goals/control.js";
import { migrateLegacyGoal } from "../src/goals/migration.js";
import { GoalStore } from "../src/goals/store.js";

const injected = vi.hoisted(() => ({
	fn: vi.fn<typeof fs.writeFileSync>(),
	original: undefined as typeof fs.writeFileSync | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	injected.original = original.writeFileSync;
	injected.fn.mockImplementation(original.writeFileSync);
	return { ...original, writeFileSync: injected.fn };
});

let root: string;
const signal = new AbortController().signal;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "goal-migration-"));
	mkdirSync(join(root, "work", "channel"), { recursive: true });
});
afterEach(() => {
	vi.restoreAllMocks();
	injected.fn.mockReset();
	if (injected.original) injected.fn.mockImplementation(injected.original);
	rmSync(root, { recursive: true, force: true });
});
function options() {
	return {
		workspaceDir: join(root, "work"),
		controlDir: join(root, "control"),
		channelId: "channel",
		ownerUserId: "owner",
		signal,
	};
}
function legacy(status: string) {
	const now = new Date().toISOString();
	const value = {
		schemaVersion: 1,
		id: "old-goal",
		objective: "old objective",
		status,
		cycle: 3,
		consecutiveFailures: 1,
		staleCycles: 2,
		progressVersion: 4,
		evidence: ["old proof"],
		createdAt: now,
		updatedAt: now,
		...(status === "completed" ? { completedAt: now } : {}),
	};
	const text = JSON.stringify(value);
	writeFileSync(join(root, "work", "channel", "goal.json"), text);
	return text;
}
describe("explicit offline goal migration", () => {
	it.each(["active", "paused"])("preserves %s counters with manual acceptance", async (status) => {
		const text = legacy(status);
		const result = await migrateLegacyGoal(options());
		expect(result).toMatchObject({
			status: "migrated",
			legacySha256: createHash("sha256").update(text).digest("hex"),
		});
		expect(JSON.parse(readFileSync(result.destination, "utf8"))).toMatchObject({
			schemaVersion: 2,
			status,
			cycle: 3,
			progressVersion: 4,
			acceptance: { mode: "manual" },
			ownerUserId: "owner",
		});
		expect(readFileSync(join(root, "work", "channel", "goal.json"), "utf8")).toBe(text);
		await expect(migrateLegacyGoal(options())).rejects.toThrow();
	});
	it.each(["completed", "cancelled"])("only archives %s", async (status) => {
		const text = legacy(status);
		const result = await migrateLegacyGoal(options());
		expect(result.status).toBe("archived");
		expect(readFileSync(result.destination, "utf8")).toBe(text);
		expect(existsSync(join(root, "control", "channel", "goal.json"))).toBe(false);
	});
	it("rejects corrupt state, missing owner and a held bot lock", async () => {
		legacy("active");
		await expect(migrateLegacyGoal({ ...options(), ownerUserId: "" })).rejects.toThrow();
		const lock = acquireControlLock(options().controlDir);
		try {
			await expect(migrateLegacyGoal(options())).rejects.toThrow();
		} finally {
			lock.release();
		}
		writeFileSync(join(root, "work", "channel", "goal.json"), "{}");
		await expect(migrateLegacyGoal(options())).rejects.toThrow();
	});
});

it("allows a new goal after archiving a terminal legacy goal", async () => {
	legacy("completed");
	await migrateLegacyGoal(options());
	const store = new GoalStore({
		channelDir: join(root, "work", "channel"),
		controlChannelDir: join(root, "control", "channel"),
		limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
	});
	expect(store.get()).toBeUndefined();
	await store.create({ objective: "new", ownerUserId: "owner", acceptance: { mode: "manual" } }, signal);
	expect(store.get()?.objective).toBe("new");
});

it("refuses an existing migration record before creating state", async () => {
	legacy("active");
	const target = join(root, "control", "channel");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "migration.json"), "existing");
	await expect(migrateLegacyGoal(options())).rejects.toThrow();
	expect(existsSync(join(target, "goal.json"))).toBe(false);
	expect(readFileSync(join(target, "migration.json"), "utf8")).toBe("existing");
});

it.each(["goal.json", "migration.json"])("never publishes partial state when %s staging write fails", async (file) => {
	legacy("active");
	const write = injected.original!;
	const spy = injected.fn.mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
		if (String(args[0]).includes(".migrations") && String(args[0]).endsWith(`/${file}`)) {
			write(args[0], "partial", args[2]);
			throw new Error("disk full");
		}
		write(...args);
	});
	try {
		await expect(migrateLegacyGoal(options())).rejects.toThrow("disk full");
		expect(existsSync(join(root, "control", "channel"))).toBe(false);
	} finally {
		spy.mockImplementation(write);
	}
	expect((await migrateLegacyGoal(options())).status).toBe("migrated");
});
