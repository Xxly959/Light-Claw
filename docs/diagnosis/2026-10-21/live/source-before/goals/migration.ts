import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assertCount, assertRecord, assertText, assertTextArray } from "../validation.js";
import { readGoalArtifact } from "./artifact.js";
import { acquireControlLock, resolveControlChannelDirectory, resolveControlDirectory } from "./control.js";
import { GoalStore } from "./store.js";
import type { GoalState } from "./types.js";

export interface GoalMigrationResult {
	status: "migrated" | "archived";
	legacySha256: string;
	destination: string;
}
export async function migrateLegacyGoal(options: {
	workspaceDir: string;
	controlDir: string;
	channelId: string;
	ownerUserId: string;
	signal: AbortSignal;
}): Promise<GoalMigrationResult> {
	assertText(options.ownerUserId, "ownerUserId");
	const control = resolveControlDirectory(options.workspaceDir, options.controlDir);
	const target = resolveControlChannelDirectory(control, options.channelId);
	const channel = join(options.workspaceDir, options.channelId);
	const lock = acquireControlLock(control);
	try {
		options.signal.throwIfAborted();
		if (existsSync(target)) throw new Error("目标位置已存在，拒绝覆盖");
		const before = await readGoalArtifact(channel, "goal.json", { signal: options.signal });
		if (before.status !== "snapshot") throw new Error("旧目标不是可读的普通文件");
		const handle = openSync(
			join(channel, "goal.json"),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		let raw: string;
		try {
			const stat = fstatSync(handle);
			if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error("旧状态不是有界普通文件");
			raw = readFileSync(handle, "utf8");
		} finally {
			closeSync(handle);
		}
		const legacySha256 = createHash("sha256").update(raw).digest("hex");
		const after = await readGoalArtifact(channel, "goal.json", { signal: options.signal });
		if (
			after.status !== "snapshot" ||
			before.snapshot.sha256 !== legacySha256 ||
			after.snapshot.sha256 !== legacySha256 ||
			before.snapshot.inode !== after.snapshot.inode ||
			before.snapshot.device !== after.snapshot.device
		)
			throw new Error("旧目标在读取期间变化");
		const value: unknown = JSON.parse(raw);
		assertRecord(value, "legacy");
		if (value.schemaVersion !== 1) throw new Error("只允许迁移 schemaVersion 1");
		assertText(value.id, "id");
		assertText(value.objective, "objective");
		assertTextArray(value.evidence, "evidence");
		for (const field of ["cycle", "consecutiveFailures", "staleCycles", "progressVersion"])
			assertCount(value[field], field);
		for (const field of ["createdAt", "updatedAt"]) {
			assertText(value[field], field);
			if (!Number.isFinite(Date.parse(value[field])) || new Date(value[field]).toISOString() !== value[field])
				throw new Error(`${field} 非法`);
		}
		if (typeof value.status !== "string" || !["active", "paused", "completed", "cancelled"].includes(value.status))
			throw new Error("legacy.status 非法");
		for (const field of ["pauseReason", "lastProgress"])
			if (value[field] !== undefined) assertText(value[field], field);
		if (value.status === "completed") {
			assertText(value.completedAt, "completedAt");
			if (
				!value.evidence.length ||
				!Number.isFinite(Date.parse(value.completedAt)) ||
				new Date(value.completedAt).toISOString() !== value.completedAt
			)
				throw new Error("旧完成状态非法");
		}
		options.signal.throwIfAborted();
		const status = value.status === "active" || value.status === "paused" ? "migrated" : "archived";
		const destination =
			status === "archived" ? join(target, "legacy", `${legacySha256}.json`) : join(target, "goal.json");
		const goal: GoalState | undefined =
			status === "migrated"
				? {
						schemaVersion: 2,
						id: value.id,
						objective: value.objective,
						status: value.status as "active" | "paused",
						cycle: value.cycle as number,
						consecutiveFailures: value.consecutiveFailures as number,
						staleCycles: value.staleCycles as number,
						progressVersion: value.progressVersion as number,
						evidence: value.evidence,
						createdAt: value.createdAt as string,
						updatedAt: value.updatedAt as string,
						...(typeof value.lastProgress === "string" ? { lastProgress: value.lastProgress } : {}),
						...(typeof value.pauseReason === "string" ? { pauseReason: value.pauseReason } : {}),
						ownerUserId: options.ownerUserId,
						revision: 0,
						acceptance: { mode: "manual" },
						baselines: [],
						verificationHistory: [],
					}
				: undefined;
		const stagingRoot = join(control, ".migrations");
		mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
		const staging = join(stagingRoot, randomUUID());
		mkdirSync(staging, { mode: 0o700 });
		try {
			if (status === "archived") mkdirSync(join(staging, "legacy"), { mode: 0o700 });
			const stagedFile =
				status === "archived" ? join(staging, "legacy", `${legacySha256}.json`) : join(staging, "goal.json");
			writeFileSync(stagedFile, goal ? `${JSON.stringify(goal, null, 2)}\n` : raw, { flag: "wx", mode: 0o600 });
			writeFileSync(
				join(staging, "migration.json"),
				`${JSON.stringify({ legacySha256, status, migratedAt: new Date().toISOString() })}\n`,
				{ flag: "wx", mode: 0o600 },
			);
			if (goal)
				new GoalStore({
					channelDir: channel,
					controlChannelDir: staging,
					limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 },
				}).get();
			options.signal.throwIfAborted();
			if (existsSync(target)) throw new Error("迁移目标已存在，拒绝覆盖");
			renameSync(staging, target);
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}

		return { status, legacySha256, destination };
	} finally {
		lock.release();
	}
}
