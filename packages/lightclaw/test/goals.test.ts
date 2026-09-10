import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleGoalCommand } from "../src/goals/commands.js";
import { GoalStore } from "../src/goals/store.js";
import { createGoalTools } from "../src/tools/goal.js";

describe("长期目标状态机", () => {
	let directory: string;
	let store: GoalStore;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "lightclaw-goal-"));
		store = new GoalStore(directory, { maxCycles: 3, maxFailures: 2, maxStaleCycles: 2 });
	});

	afterEach(() => {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	});

	it("创建目标并从磁盘恢复", () => {
		const result = handleGoalCommand("/goal 完成项目收尾", store);
		expect(result.startRun).toBe(true);
		const restored = new GoalStore(directory, { maxCycles: 3, maxFailures: 2, maxStaleCycles: 2 }).get();
		expect(restored?.objective).toBe("完成项目收尾");
		expect(restored?.status).toBe("active");
	});

	it("没有证据时不能完成目标", () => {
		store.create("目标");
		expect(() => store.complete("完成", [])).toThrow("可验证证据");
		const goal = store.complete("完成", ["测试通过"]);
		expect(goal.status).toBe("completed");
		expect(goal.cycle).toBe(1);
	});

	it("连续失败和无进展都会自动暂停", () => {
		store.create("失败目标");
		store.recordCycle(true, false);
		expect(store.recordCycle(true, false).pauseReason).toBe("连续执行失败");

		store.cancel();
		store.create("停滞目标");
		store.recordCycle(false, false);
		expect(store.recordCycle(false, false).pauseReason).toBe("连续多轮没有进展");
	});

	it("拒绝覆盖未结束目标", () => {
		store.create("第一个目标");
		const result = handleGoalCommand("/goal 第二个目标", store);
		expect(result.startRun).toBe(false);
		expect(result.response).toContain("已有未结束目标");
	});

	it("拒绝非法状态转换", () => {
		store.create("目标");
		expect(() => store.resume()).toThrow("状态必须是 paused");
		store.pause();
		expect(() => store.updateProgress("不应写入")).toThrow("状态必须是 active");
	});

	it("恢复目标时重置本轮执行预算", () => {
		store.create("目标");
		store.recordCycle(true, false);
		const paused = store.recordCycle(true, false);
		expect(paused.status).toBe("paused");
		const resumed = store.resume();
		expect(resumed).toMatchObject({
			status: "active",
			cycle: 0,
			consecutiveFailures: 0,
			staleCycles: 0,
		});
	});

	it("目标工具明确禁止普通任务误调用", () => {
		const descriptions = createGoalTools(store).map((tool) => tool.description);
		expect(descriptions.every((description) => description.includes("普通单轮任务不要调用"))).toBe(true);
	});
});
