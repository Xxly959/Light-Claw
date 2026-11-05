import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assertCount, assertRecord, assertText, assertTextArray } from "../validation.js";
import { assertFields, parseGoalCreateInput, parseGoalDeliverables, validateArtifactPath } from "./acceptance.js";
import { assertGoalSnapshots, captureGoalBaselines } from "./artifact.js";
import { isWithin, physicalPath } from "./control.js";
import type {
	GoalAcceptance,
	GoalArtifactSnapshot,
	GoalCheckResult,
	GoalCompletionOutcome,
	GoalCompletionRequest,
	GoalCreateInput,
	GoalLimits,
	GoalState,
	GoalVerificationReport,
	GoalVerificationRuntime,
} from "./types.js";
import { verifyGoalCompletion } from "./verifier.js";

function assertDate(value: unknown, field: string): void {
	assertText(value, field);
	if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
		throw new Error(`${field} 必须是有效的 ISO 时间`);
	}
}

function assertSnapshot(value: unknown): asserts value is GoalArtifactSnapshot {
	assertRecord(value, "snapshot");
	assertFields(value, ["path", "sha256", "bytes", "device", "inode", "mtimeNs", "ctimeNs"]);
	for (const field of ["mtimeNs", "ctimeNs"])
		if (value[field] !== undefined && (typeof value[field] !== "string" || !/^-?\d+$/.test(value[field])))
			throw new Error("snapshot timestamp 非法");
	validateArtifactPath(value.path);
	assertCount(value.bytes, "bytes");
	if (
		typeof value.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.sha256) ||
		typeof value.device !== "string" ||
		!/^\d+$/.test(value.device) ||
		typeof value.inode !== "string" ||
		!/^\d+$/.test(value.inode)
	)
		throw new Error("snapshot 非法");
}
function assertCheck(value: unknown): asserts value is GoalCheckResult {
	assertRecord(value, "check");
	assertText(value.checkId, "checkId");
	assertText(value.reasonCode, "reasonCode");
	assertDate(value.checkedAt, "checkedAt");
	if (
		!["passed", "failed", "inconclusive"].includes(String(value.status)) ||
		typeof value.durationMs !== "number" ||
		!Number.isFinite(value.durationMs) ||
		value.durationMs < 0
	)
		throw new Error("check 非法");
	const common = ["checkId", "kind", "status", "reasonCode", "durationMs", "checkedAt"];
	if (value.kind === "file") {
		assertFields(value, [...common, "snapshot"]);
		if (value.snapshot !== undefined) assertSnapshot(value.snapshot);
		if (value.status === "passed" && value.snapshot === undefined) throw new Error("通过的文件检查缺少快照");
	} else if (value.kind === "command") {
		assertFields(value, [...common, "exitCode", "outputTruncated", "stdoutPreviewSha256", "stderrPreviewSha256"]);
		if (value.exitCode !== undefined && (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode)))
			throw new Error("exitCode 非法");
		if (value.outputTruncated !== undefined && typeof value.outputTruncated !== "boolean")
			throw new Error("outputTruncated 非法");
		for (const field of ["stdoutPreviewSha256", "stderrPreviewSha256"])
			if (value[field] !== undefined && (typeof value[field] !== "string" || !/^[a-f0-9]{64}$/.test(value[field])))
				throw new Error(`${field} 非法`);
		if (
			value.status === "passed" &&
			(value.exitCode !== 0 ||
				typeof value.outputTruncated !== "boolean" ||
				!value.stdoutPreviewSha256 ||
				!value.stderrPreviewSha256)
		)
			throw new Error("通过的命令检查缺少实际结果");
	} else throw new Error("check.kind 非法");
}

function assertGoal(value: unknown): asserts value is GoalState {
	assertRecord(value, "goal");
	if (value.schemaVersion !== 2) throw new Error("schemaVersion 必须为2；旧目标需显式迁移");
	assertText(value.ownerUserId, "ownerUserId");
	assertCount(value.revision, "revision");
	if (value.verificationVersion !== undefined) assertCount(value.verificationVersion, "verificationVersion");
	assertRecord(value.acceptance, "acceptance");
	let acceptance: GoalAcceptance = { mode: "manual" };
	if (value.acceptance.mode === "manual") assertFields(value.acceptance, ["mode"]);
	else if (value.acceptance.mode === "automatic") {
		assertFields(value.acceptance, ["mode", "files", "commands"]);
		acceptance = parseGoalCreateInput(
			{
				objective: value.objective,
				acceptance: { files: value.acceptance.files, commands: value.acceptance.commands },
			},
			value.ownerUserId,
			{ type: "docker", container: "validation" },
		).acceptance;
	} else throw new Error("acceptance.mode 非法");
	if (!Array.isArray(value.baselines) || value.baselines.length > 16) throw new Error("baselines 非法");
	for (const item of value.baselines) {
		assertRecord(item, "baselines");
		validateArtifactPath(item.path);
		if (item.sha256 !== null && (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)))
			throw new Error("baselines.sha256 非法");
	}
	if (!Array.isArray(value.verificationHistory) || value.verificationHistory.length > 20)
		throw new Error("verificationHistory 非法");
	for (const report of value.verificationHistory) {
		assertRecord(report, "verificationHistory");
		assertText(report.attemptId, "verificationHistory.attemptId");
		if (report.goalId !== value.id) throw new Error("verificationHistory.goalId 非法");
		assertCount(report.revision, "verificationHistory.revision");
		if (!["passed", "failed", "inconclusive", "aborted"].includes(String(report.status)))
			throw new Error("verificationHistory.status 非法");
		assertDate(report.startedAt, "verificationHistory.startedAt");
		assertDate(report.finishedAt, "verificationHistory.finishedAt");
		if (report.expiresAt !== undefined) assertDate(report.expiresAt, "verificationHistory.expiresAt");
		if (report.deliverables !== undefined) parseGoalDeliverables(report.deliverables);
		assertText(report.summary, "verificationHistory.summary");
		assertTextArray(report.evidence, "verificationHistory.evidence");
		if (
			!Array.isArray(report.checks) ||
			report.checks.length > 20 ||
			!Array.isArray(report.snapshots) ||
			report.snapshots.length > 80
		)
			throw new Error("verificationHistory 数量非法");
		const snapshots: GoalArtifactSnapshot[] = [];
		const checks: GoalCheckResult[] = [];
		for (const snapshot of report.snapshots) {
			assertSnapshot(snapshot);
			snapshots.push(snapshot);
		}
		for (const check of report.checks) {
			assertCheck(check);
			checks.push(check);
		}
		if (
			new Set(snapshots.map((item) => item.path)).size !== snapshots.length ||
			new Set(checks.map((item) => item.checkId)).size !== checks.length ||
			report.revision > value.revision
		)
			throw new Error("验证记录身份非法");
		if (report.status === "passed") {
			if (
				acceptance.mode !== "automatic" ||
				checks.length !== acceptance.files.length + acceptance.commands.length ||
				checks.some((check) => check.status !== "passed")
			)
				throw new Error("通过记录不覆盖自动验收契约");
			for (const [index, rule] of acceptance.files.entries()) {
				const check = checks.find((item) => item.checkId === `file-${index}`);
				const snapshot = snapshots.find((item) => item.path === rule.path);
				if (check?.kind !== "file" || !snapshot || JSON.stringify(check.snapshot) !== JSON.stringify(snapshot))
					throw new Error("文件验收快照不一致");
			}
			for (const [index, rule] of acceptance.commands.entries()) {
				const check = checks.find((item) => item.checkId === `command-${index}`);
				if (
					check?.kind !== "command" ||
					rule.sourcePaths.some((path) => !snapshots.some((item) => item.path === path)) ||
					(rule.stdoutIncludes && check.outputTruncated)
				)
					throw new Error("命令验收快照不一致");
			}
		}
	}
	assertText(value.id, "id");
	assertText(value.objective, "objective");
	if (
		typeof value.status !== "string" ||
		!["active", "paused", "completed", "cancelled", "awaiting_confirmation"].includes(value.status)
	) {
		throw new Error("status 必须是 active、paused、completed 或 cancelled");
	}
	for (const field of ["cycle", "consecutiveFailures", "staleCycles", "progressVersion"]) {
		assertCount(value[field], field);
	}
	assertTextArray(value.evidence, "evidence");
	assertDate(value.createdAt, "createdAt");
	assertDate(value.updatedAt, "updatedAt");
	if (value.status === "awaiting_confirmation" && value.verificationHistory.at(-1)?.status !== "inconclusive")
		throw new Error("待确认状态缺少当前申请");
	if (value.status === "completed") {
		assertDate(value.completedAt, "completedAt");
		if (value.evidence.length === 0) throw new Error("completed 目标的 evidence 不能为空");
		assertRecord(value.completion, "completion");
		const completion = value.completion;
		const report = value.verificationHistory.at(-1);
		if (report?.attemptId !== completion.attemptId) throw new Error("completion 必须对应最新申请");
		if (completion.method === "automatic" && value.acceptance.mode !== "automatic")
			throw new Error("manual 不能自动完成");
		if (
			!report ||
			(value.completion.method === "automatic"
				? report.status !== "passed"
				: !["human", "self_reported"].includes(String(value.completion.method)) || report.status !== "inconclusive")
		)
			throw new Error("completion 缺少匹配验证记录");
		if (value.completion.method === "human") {
			if (value.completion.confirmedBy !== value.ownerUserId) throw new Error("completion.confirmedBy 非法");
			assertDate(value.completion.confirmedAt, "completion.confirmedAt");
		}
	}
	for (const field of ["lastProgress", "pauseReason"]) {
		if (value[field] !== undefined) assertText(value[field], field);
	}
	if (value.completedAt !== undefined) assertDate(value.completedAt, "completedAt");
}

export class GoalStore {
	private readonly path: string;

	private readonly channelDir: string;
	private readonly limits: GoalLimits;
	private readonly acceptanceEnabled: boolean;
	private readonly controlsEnabled: boolean;
	private readonly enabled: boolean;
	private readonly confirmationTtlMs: number;
	constructor(options: {
		channelDir: string;
		controlChannelDir: string;
		limits: GoalLimits;
		enabled?: boolean;
		confirmationTtlMs?: number;
		acceptanceEnabled?: boolean;
		controlsEnabled?: boolean;
	}) {
		this.confirmationTtlMs = options.confirmationTtlMs ?? 1_800_000;
		if (!Number.isSafeInteger(this.confirmationTtlMs) || this.confirmationTtlMs < 1)
			throw new Error("confirmationTtlMs 非法");
		this.enabled = options.enabled !== false;
		this.acceptanceEnabled = options.acceptanceEnabled !== false;
		this.controlsEnabled = options.controlsEnabled !== false;
		this.channelDir = options.channelDir;
		this.limits = options.limits;
		const channel = physicalPath(options.channelDir);
		const control = physicalPath(options.controlChannelDir);
		if (isWithin(channel, control) || isWithin(control, channel)) throw new Error("控制目录必须在频道工作区外");
		this.path = join(control, "goal.json");
	}

	get(): GoalState | undefined {
		if (!this.enabled) return undefined;
		if (!existsSync(this.path)) {
			if (existsSync(join(this.channelDir, "goal.json")) && !this.hasArchivedLegacy())
				throw new Error(
					`旧目标需显式迁移：${join(this.channelDir, "goal.json")}；请停机运行 lightclaw-goal-migrate`,
				);
			return undefined;
		}
		try {
			this.assertProtectedDirectory();
			const handle = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			let raw: string;
			try {
				const stat = fstatSync(handle);
				if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("控制状态必须是有界普通文件");
				raw = readFileSync(handle, "utf8");
				const current = lstatSync(this.path);
				if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino)
					throw new Error("控制文件已替换");
			} finally {
				closeSync(handle);
			}
			const value: unknown = JSON.parse(raw);
			assertGoal(value);
			return value;
		} catch (error) {
			throw new Error(`目标状态文件损坏：${this.path}；${error instanceof Error ? error.message : String(error)}`, {
				cause: error,
			});
		}
	}

	async create(input: GoalCreateInput, signal: AbortSignal): Promise<GoalState> {
		if (!this.enabled) throw new Error("目标功能已关闭");
		assertText(input.objective, "objective");
		assertText(input.ownerUserId, "ownerUserId");
		const current = this.get();
		if (current && ["active", "paused", "awaiting_confirmation"].includes(current.status))
			throw new Error("已有未结束目标");
		mkdirSync(this.channelDir, { recursive: true });
		const baselines = await captureGoalBaselines(this.channelDir, input.acceptance, signal);
		signal.throwIfAborted();
		if (this.get()?.revision !== current?.revision || this.get()?.id !== current?.id)
			throw new Error("创建期间目标已变化");
		const now = new Date().toISOString();
		const goal: GoalState = {
			schemaVersion: 2,
			ownerUserId: input.ownerUserId,
			revision: 0,
			verificationVersion: 0,
			acceptance: input.acceptance,
			baselines,
			verificationHistory: [],
			id: randomUUID(),
			objective: input.objective.trim(),
			status: "active",
			cycle: 0,
			consecutiveFailures: 0,
			staleCycles: 0,
			progressVersion: 0,
			evidence: [],
			createdAt: now,
			updatedAt: now,
		};
		this.save(goal);
		return goal;
	}

	updateProgress(summary: string, evidence: string[] = []): GoalState {
		this.requireStatus("active");
		assertText(summary, "summary");
		const current = this.get()!;
		const cleanEvidence = evidence.map((item) => item.trim()).filter(Boolean);
		if (current.lastProgress === summary.trim() && cleanEvidence.every((item) => current.evidence.includes(item)))
			return current;
		return this.update((goal) => ({
			...goal,
			lastProgress: summary.trim(),
			evidence: [...goal.evidence, ...evidence.map((item) => item.trim()).filter(Boolean)].slice(-20),
			progressVersion: goal.progressVersion + 1,
			staleCycles: 0,
		}));
	}

	async requestCompletion(
		request: GoalCompletionRequest,
		runtime: GoalVerificationRuntime,
	): Promise<GoalCompletionOutcome> {
		const initial = this.get();
		if (!initial || !["active", "awaiting_confirmation"].includes(initial.status))
			throw new Error("当前目标不能申请验收");
		const deliverables =
			request.deliverables === undefined
				? initial.acceptance.mode === "manual"
					? parseGoalDeliverables(undefined)
					: undefined
				: parseGoalDeliverables(request.deliverables);
		assertText(request.summary, "summary");
		const evidence = request.evidence.map((item) => item.trim()).filter(Boolean);
		if (!evidence.length) throw new Error("完成申请至少需要一条证据");
		const before = this.get()!;
		const guarded: GoalVerificationRuntime = {
			...runtime,
			assertActive: () => {
				runtime.assertActive();
				const current = this.get();
				if (
					current?.id !== before.id ||
					(current.verificationVersion ?? current.revision) !== (before.verificationVersion ?? before.revision) ||
					current.status !== before.status
				)
					throw new Error("验证申请已过期");
			},
		};
		const report: GoalVerificationReport = this.acceptanceEnabled
			? await verifyGoalCompletion(before, { summary: request.summary.trim(), evidence, deliverables }, guarded)
			: {
					attemptId: randomUUID(),
					goalId: before.id,
					revision: before.revision,
					status: "inconclusive",
					startedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
					summary: request.summary.trim(),
					evidence,
					checks: [],
					snapshots: [],
				};
		report.expiresAt = new Date(Date.parse(report.finishedAt) + this.confirmationTtlMs).toISOString();
		let current = this.get();
		if (report.status !== "aborted") {
			try {
				guarded.assertActive();
				runtime.signal.throwIfAborted();
				await assertGoalSnapshots(this.channelDir, report.snapshots, runtime.signal);
				guarded.assertActive();
			} catch {
				try {
					guarded.assertActive();
					runtime.signal.throwIfAborted();
					report.status = "inconclusive";
				} catch {
					report.status = "aborted";
				}
			}
		}
		current = this.get();
		if (!current || current.id !== before.id) return { goal: current, report, committed: false };
		const eligible =
			report.status !== "aborted" &&
			current.status === before.status &&
			(current.verificationVersion ?? current.revision) === (before.verificationVersion ?? before.revision) &&
			!runtime.signal.aborted;
		const next = this.update((goal) => ({
			...goal,
			verificationHistory: [...goal.verificationHistory, report].slice(-20),
			...(eligible
				? {
						verificationVersion: (goal.verificationVersion ?? goal.revision) + 1,
						lastProgress: request.summary.trim(),
						evidence: [...goal.evidence, ...evidence].slice(-20),
						status:
							report.status === "passed" || !this.acceptanceEnabled
								? "completed"
								: report.status === "inconclusive"
									? "awaiting_confirmation"
									: "active",
						...(report.status === "passed" || !this.acceptanceEnabled
							? {
									cycle: goal.cycle + 1,
									completedAt: new Date().toISOString(),
									completion: {
										method: this.acceptanceEnabled ? ("automatic" as const) : ("self_reported" as const),
										attemptId: report.attemptId,
									},
								}
							: {}),
					}
				: {}),
		}));
		return { goal: next, report, committed: eligible };
	}

	async confirm(goalId: string, attemptId: string, userId: string, signal: AbortSignal): Promise<GoalState> {
		this.requireStatus("awaiting_confirmation");
		const before = this.get()!;
		const report = before.verificationHistory.at(-1);
		if (
			before.id !== goalId ||
			before.ownerUserId !== userId ||
			report?.attemptId !== attemptId ||
			report.status !== "inconclusive"
		)
			throw new Error("确认身份或申请已过期");
		if (!report.expiresAt || Date.parse(report.expiresAt) <= Date.now())
			throw new Error("确认申请已过期，请重新申请");
		if (before.acceptance.mode === "manual") {
			const declaration = parseGoalDeliverables(report.deliverables);
			if (
				declaration.kind === "files" &&
				declaration.paths.some((path) => !report.snapshots.some((snapshot) => snapshot.path === path))
			)
				throw new Error("交付物未采集，请重新申请");
		}
		await assertGoalSnapshots(this.channelDir, report.snapshots, signal);
		signal.throwIfAborted();
		const current = this.get();
		if (
			current?.id !== before.id ||
			current.revision !== before.revision ||
			current.status !== "awaiting_confirmation" ||
			Date.parse(report.expiresAt) <= Date.now()
		)
			throw new Error("确认申请已过期");
		return this.update((goal) => ({
			...goal,
			status: "completed",
			cycle: goal.cycle + 1,
			completedAt: new Date().toISOString(),
			completion: { method: "human", attemptId, confirmedBy: userId, confirmedAt: new Date().toISOString() },
		}));
	}

	recordDispute(attemptId: string, userId: string, reason: string): void {
		const goal = this.get();
		assertText(reason, "reason");
		if (reason.length > 2000) throw new Error("复核原因不能超过2000字符");
		if (
			!goal ||
			goal.ownerUserId !== userId ||
			!goal.verificationHistory.some((report) => report.attemptId === attemptId)
		)
			throw new Error("只有目标创建者能对已有验收申请记录复核");
		this.assertProtectedDirectory();
		const handle = openSync(
			join(dirname(this.path), "verification-disputes.jsonl"),
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			appendFileSync(
				handle,
				`${JSON.stringify({
					goalId: goal.id,
					attemptId,
					userId,
					reason: reason
						.trim()
						.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
						.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]"),
					timestamp: new Date().toISOString(),
					status: "unreviewed",
				})}\n`,
			);
		} finally {
			closeSync(handle);
		}
	}

	pause(reason = "用户暂停"): GoalState {
		if (!["active", "awaiting_confirmation"].includes(this.get()?.status ?? ""))
			throw new Error("只有进行中或待确认的目标可以暂停");
		return this.update((goal) => ({
			...goal,
			status: "paused",
			verificationVersion: (goal.verificationVersion ?? goal.revision) + 1,
			pauseReason: reason,
		}));
	}

	resume(): GoalState {
		if (!["paused", "awaiting_confirmation"].includes(this.get()?.status ?? ""))
			throw new Error("目标状态必须是 paused 或 awaiting_confirmation");
		return this.update((goal) => ({
			...goal,
			status: "active",
			verificationVersion: (goal.verificationVersion ?? goal.revision) + 1,
			cycle: 0,
			consecutiveFailures: 0,
			staleCycles: 0,
			pauseReason: undefined,
		}));
	}

	cancel(): GoalState {
		const status = this.get()?.status;
		if (status !== "active" && status !== "paused" && status !== "awaiting_confirmation")
			throw new Error("只有进行中或暂停的目标可以取消");
		return this.update((goal) => ({
			...goal,
			status: "cancelled",
			verificationVersion: (goal.verificationVersion ?? goal.revision) + 1,
		}));
	}

	recordCycle(failed: boolean, madeProgress: boolean): GoalState {
		this.requireStatus("active");
		return this.update((goal) => {
			const next = {
				...goal,
				cycle: goal.cycle + 1,
				consecutiveFailures: failed ? goal.consecutiveFailures + 1 : 0,
				staleCycles: madeProgress ? 0 : goal.staleCycles + 1,
			};
			if (!this.controlsEnabled) return next;
			if (next.cycle >= this.limits.maxCycles) return { ...next, status: "paused", pauseReason: "达到最大轮次" };
			if (next.consecutiveFailures >= this.limits.maxFailures) {
				return { ...next, status: "paused", pauseReason: "连续执行失败" };
			}
			if (next.staleCycles >= this.limits.maxStaleCycles) {
				return { ...next, status: "paused", pauseReason: "连续多轮没有进展" };
			}
			return next;
		});
	}

	private update(transform: (goal: GoalState) => GoalState): GoalState {
		const goal = this.get();
		if (!goal) throw new Error("当前没有目标，请先发送 /goal <目标>");
		const next = {
			verificationVersion: goal.verificationVersion ?? goal.revision,
			...transform(goal),
			revision: goal.revision + 1,
			updatedAt: new Date().toISOString(),
		};
		this.save(next);
		return next;
	}

	private requireStatus(expected: GoalState["status"]): void {
		const actual = this.get()?.status;
		if (actual !== expected) throw new Error(`目标状态必须是 ${expected}，当前为 ${actual ?? "不存在"}`);
	}

	private hasArchivedLegacy(): boolean {
		const receiptPath = join(dirname(this.path), "migration.json");
		if (!existsSync(receiptPath)) return false;
		this.assertProtectedDirectory();
		if (!lstatSync(receiptPath).isFile() || lstatSync(receiptPath).isSymbolicLink())
			throw new Error("迁移记录必须是普通文件");
		const receipt: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
		assertRecord(receipt, "migration");
		if (
			receipt.status !== "archived" ||
			typeof receipt.legacySha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(receipt.legacySha256)
		)
			return false;
		const archive = join(dirname(this.path), "legacy", `${receipt.legacySha256}.json`);
		if (!existsSync(archive) || !lstatSync(archive).isFile() || lstatSync(archive).isSymbolicLink())
			throw new Error("迁移归档缺失或非法");
		if (physicalPath(dirname(archive)) !== dirname(archive) || lstatSync(archive).size > 10 * 1024 * 1024)
			throw new Error("迁移归档路径或大小非法");
		const raw = readFileSync(archive, "utf8");
		if (createHash("sha256").update(raw).digest("hex") !== receipt.legacySha256)
			throw new Error("迁移归档哈希不匹配");
		const legacy: unknown = JSON.parse(raw);
		assertRecord(legacy, "legacy archive");
		if (legacy.schemaVersion !== 1 || !["completed", "cancelled"].includes(String(legacy.status)))
			throw new Error("迁移归档不是旧终态");
		return true;
	}

	private assertProtectedDirectory(): void {
		if (physicalPath(dirname(this.path)) !== dirname(this.path)) throw new Error("控制目录路径已替换");
	}
	private save(goal: GoalState): void {
		assertGoal(goal);
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		this.assertProtectedDirectory();
		const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(goal, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporaryPath, this.path);
	}
}
