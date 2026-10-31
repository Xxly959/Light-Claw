import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEvalCases, runEvaluation } from "../src/evals/runner.js";

describe("评测集输入契约", () => {
	let directory: string;
	let path: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "lightclaw-eval-schema-"));
		path = join(directory, "cases.json");
	});
	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	it.each([
		[{ id: 17, prompt: "task", expect: {} }, "id"],
		[{ id: "one", prompt: null, expect: {} }, "prompt"],
		[{ id: "one", prompt: "task", expect: false }, "expect"],
		[{ id: "one", prompt: "task", expect: { responseIncludes: [17] } }, "responseIncludes"],
		[{ id: "one", prompt: "task", expect: { filesExist: "x" } }, "filesExist"],
		[{ id: "one", prompt: "task", expect: { filesContain: [{ path: "x", text: null }] } }, "text"],
		[{ id: "one", prompt: "task", expect: { maxToolErrors: -1 } }, "maxToolErrors"],
		[{ id: "one", prompt: "task", expect: { maxToolErrors: 0.5 } }, "maxToolErrors"],
		[{ id: "one", prompt: "task", expect: { maxDurationMs: "100" } }, "maxDurationMs"],
		[{ id: "one", prompt: "task", expect: { responseInclude: ["ok"] } }, "responseInclude"],
		[{ id: "one", prompt: "task", expect: {} }, "expect"],
		[{ id: "one", prompt: "task", expect: { filesExist: ["../secret"] } }, "filesExist"],
		[{ id: "one", prompt: "task", expect: { filesExist: ["/tmp/secret"] } }, "filesExist"],
		[{ id: "one", prompt: "task", expect: { filesExist: ["C:\\secret"] } }, "filesExist"],
		[{ id: "one", prompt: "task", expect: { responseIncludes: [] } }, "responseIncludes"],
	])("拒绝非法字段 %#", async (value, field) => {
		writeFileSync(path, JSON.stringify([value]));
		await expect(loadEvalCases(path)).rejects.toThrow(String(field));
	});

	it("validates programmatic cases before creating a runner or touching workspace outputs", async () => {
		await expect(
			runEvaluation({
				cases: [{ id: "one", prompt: "task", expect: {} }],
				config: {
					transport: "feishu",
					modelProvider: "unused",
					modelId: "unused",
					maxGoalCycles: 1,
					maxGoalFailures: 1,
					maxStaleCycles: 1,
				},
				sandbox: { type: "host" },
				workingDir: directory,
				promptLabel: "invalid",
			}),
		).rejects.toThrow("expect");
	});

	it("拒绝重复 id 并允许合法的零错误预算", async () => {
		const item = { id: "one", prompt: "task", expect: { maxToolErrors: 0 } };
		writeFileSync(path, JSON.stringify([item, item]));
		await expect(loadEvalCases(path)).rejects.toThrow("重复");
		writeFileSync(path, JSON.stringify([item]));
		expect(await loadEvalCases(path)).toEqual([item]);
	});
});
