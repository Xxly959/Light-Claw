import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GoalLimits, GoalState } from "./types.js";

export class GoalStore {
	private readonly path: string;

	constructor(
		channelDir: string,
		private readonly limits: GoalLimits,
	) {
		this.path = join(channelDir, "goal.json");
	}

	get(): GoalState | undefined {
		if (!existsSync(this.path)) return undefined;
		try {
			return JSON.parse(readFileSync(this.path, "utf8")) as GoalState;
		} catch {
			throw new Error(`目标状态文件损坏：${this.path}`);
		}
	}

	create(objective: string): GoalState {
		const now = new Date().toISOString();
		const goal: GoalState = {
			id: randomUUID(),
			objective: objective.trim(),
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
		return this.update((goal) => ({
			...goal,
			lastProgress: summary.trim(),
			evidence: [...goal.evidence, ...evidence.map((item) => item.trim()).filter(Boolean)].slice(-20),
			progressVersion: goal.progressVersion + 1,
			staleCycles: 0,
		}));
	}

	complete(summary: string, evidence: string[]): GoalState {
		this.requireStatus("active");
		if (evidence.length === 0) throw new Error("完成目标前至少需要一条可验证证据");
		const now = new Date().toISOString();
		return this.update((goal) => ({
			...goal,
			status: "completed",
			cycle: goal.cycle + 1,
			lastProgress: summary.trim(),
			evidence: [...goal.evidence, ...evidence.map((item) => item.trim()).filter(Boolean)].slice(-20),
			completedAt: now,
		}));
	}

	pause(reason = "用户暂停"): GoalState {
		this.requireStatus("active");
		return this.update((goal) => ({ ...goal, status: "paused", pauseReason: reason }));
	}

	resume(): GoalState {
		this.requireStatus("paused");
		return this.update((goal) => ({
			...goal,
			status: "active",
			cycle: 0,
			consecutiveFailures: 0,
			staleCycles: 0,
			pauseReason: undefined,
		}));
	}

	cancel(): GoalState {
		const status = this.get()?.status;
		if (status !== "active" && status !== "paused") throw new Error("只有进行中或暂停的目标可以取消");
		return this.update((goal) => ({ ...goal, status: "cancelled" }));
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
		const next = { ...transform(goal), updatedAt: new Date().toISOString() };
		this.save(next);
		return next;
	}

	private requireStatus(expected: GoalState["status"]): void {
		const actual = this.get()?.status;
		if (actual !== expected) throw new Error(`目标状态必须是 ${expected}，当前为 ${actual ?? "不存在"}`);
	}

	private save(goal: GoalState): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const temporaryPath = `${this.path}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(goal, null, 2)}\n`, "utf8");
		renameSync(temporaryPath, this.path);
	}
}
