import { describe, expect, it } from "vitest";
import { parseGoalCreateInput } from "../src/goals/acceptance.js";

const docker = { type: "docker", container: "test" } as const;
const valid = { objective: "create report", acceptance: { files: [{ path: "scratch/report.txt" }] } };
describe("user-defined goal acceptance", () => {
	it("pins the owner and defaults to changed content", () => {
		expect(parseGoalCreateInput(valid, "owner", docker)).toEqual({
			objective: "create report",
			ownerUserId: "owner",
			acceptance: { mode: "automatic", files: [{ path: "scratch/report.txt", changed: true }], commands: [] },
		});
	});
	it("keeps unspecified acceptance manual", () => {
		expect(parseGoalCreateInput({ objective: "research" }, "owner", docker).acceptance).toEqual({ mode: "manual" });
	});
	it.each([
		{},
		{ files: [] },
		{ unknown: true },
		{ files: [{ path: "../other/file" }] },
		{ files: [{ path: "/tmp/file" }] },
		{ files: [{ path: "scratch\\file" }] },
		{ files: [{ path: "file", contains: [] }] },
		{ files: [{ path: "file", changed: "yes" }] },
		{ files: [{ path: "file" }, { path: "file" }] },
		{ files: Array.from({ length: 17 }, (_, index) => ({ path: `file-${index}` })) },
		{ commands: [{ command: "true", sourcePaths: [] }] },
		{ commands: [{ command: "x".repeat(4097), sourcePaths: ["file"] }] },
		{ commands: [{ command: "true", sourcePaths: Array.from({ length: 17 }, (_, index) => `file-${index}`) }] },
		{ commands: Array.from({ length: 5 }, () => ({ command: "true", sourcePaths: ["file"] })) },
	])("rejects ineffective or unsafe contracts %#", (acceptance) => {
		expect(() => parseGoalCreateInput({ objective: "goal", acceptance }, "owner", docker)).toThrow();
	});
	it("rejects host commands and user-supplied pass flags", () => {
		expect(() =>
			parseGoalCreateInput(
				{ objective: "goal", acceptance: { commands: [{ command: "true", sourcePaths: ["file"] }] } },
				"owner",
				{ type: "host" },
			),
		).toThrow();
		expect(() => parseGoalCreateInput({ ...valid, passed: true }, "owner", docker)).toThrow();
	});
});
