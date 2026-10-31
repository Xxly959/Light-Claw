import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquireControlLock,
	assertControlIsolation,
	resolveControlChannelDirectory,
	resolveControlDirectory,
} from "../src/goals/control.js";

const inspect = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: inspect }));
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("goal control paths", () => {
	it("rejects workspace-local state and channel escapes", () => {
		const root = mkdtempSync(join(tmpdir(), "goal-control-"));
		roots.push(root);
		expect(() => resolveControlDirectory(root, join(root, "control"))).toThrow();
		for (const channel of ["", ".", "..", "../other", "a/b", "a\\b"])
			expect(() => resolveControlChannelDirectory(root, channel)).toThrow();
		expect(resolveControlChannelDirectory(root, "channel")).toBe(join(root, "channel"));
	});
	it("rejects a linked control directory", () => {
		const root = mkdtempSync(join(tmpdir(), "goal-control-"));
		roots.push(root);
		symlinkSync(root, join(root, "linked"));
		expect(() => resolveControlDirectory(join(root, "workspace"), join(root, "linked"))).toThrow();
	});
});

describe("control isolation and mutual exclusion", () => {
	it("rejects mount coverage and malformed inspect results", async () => {
		const root = mkdtempSync(join(tmpdir(), "control-isolation-"));
		roots.push(root);
		const workspace = join(root, "work");
		const control = join(root, "control");
		mkdirSync(workspace);
		mkdirSync(control);
		inspect.mockReturnValue(JSON.stringify([{ Mounts: [{ Source: workspace, Destination: "/workspace" }] }]));
		await expect(
			assertControlIsolation(workspace, control, { type: "docker", container: "mock" }),
		).resolves.toBeUndefined();
		for (const source of [root, control]) {
			inspect.mockReturnValue(JSON.stringify([{ Mounts: [{ Source: source }] }]));
			await expect(
				assertControlIsolation(workspace, control, { type: "docker", container: "mock" }),
			).rejects.toThrow();
		}
		inspect.mockReturnValue("{}");
		await expect(assertControlIsolation(workspace, control, { type: "docker", container: "mock" })).rejects.toThrow();
		inspect.mockImplementation(() => {
			throw new Error("unavailable");
		});
		await expect(assertControlIsolation(workspace, control, { type: "docker", container: "mock" })).rejects.toThrow();
	});
	it("holds one owner token and never releases a replacement lock", () => {
		const root = mkdtempSync(join(tmpdir(), "control-lock-"));
		roots.push(root);
		const lock = acquireControlLock(root);
		expect(() => acquireControlLock(root)).toThrow();
		writeFileSync(join(root, "instance.lock"), "replacement");
		lock.release();
		expect(() => acquireControlLock(root)).toThrow();
	});
	it("releases its own lock", () => {
		const root = mkdtempSync(join(tmpdir(), "control-lock-"));
		roots.push(root);
		acquireControlLock(root).release();
		acquireControlLock(root).release();
	});
});

it("rejects a filesystem-root control directory and root mount coverage", async () => {
	const root = mkdtempSync(join(tmpdir(), "root-coverage-"));
	roots.push(root);
	const workspace = join(root, "work");
	const control = join(root, "control");
	mkdirSync(workspace);
	mkdirSync(control);
	expect(() => resolveControlDirectory(workspace, "/")).toThrow();
	inspect.mockReturnValue(JSON.stringify([{ Mounts: [{ Source: "/" }] }]));
	await expect(assertControlIsolation(workspace, control, { type: "docker", container: "mock" })).rejects.toThrow();
});

it("rejects protected subtree exposure, wrong workspace and nested Docker mounts", async () => {
	const root = mkdtempSync(join(tmpdir(), "mount-mapping-"));
	roots.push(root);
	const workspace = join(root, "work");
	const control = join(root, "control");
	const other = join(root, "other");
	mkdirSync(workspace);
	mkdirSync(control);
	mkdirSync(other);
	mkdirSync(join(control, "channel"));
	writeFileSync(join(control, "channel", "goal.json"), "{}");
	for (const source of [join(control, "channel"), join(control, "channel", "goal.json")]) {
		inspect.mockReturnValue(
			JSON.stringify([
				{
					Mounts: [
						{ Source: workspace, Destination: "/workspace" },
						{ Source: source, Destination: "/exposed" },
					],
				},
			]),
		);
		await expect(assertControlIsolation(workspace, control, { type: "docker", container: "mock" })).rejects.toThrow();
	}
	for (const mounts of [
		[{ Source: other, Destination: "/workspace" }],
		[
			{ Source: workspace, Destination: "/workspace" },
			{ Source: other, Destination: "/workspace/channel" },
		],
		[{ Source: workspace, Destination: "/wrong" }],
	]) {
		inspect.mockReturnValue(JSON.stringify([{ Mounts: mounts }]));
		await expect(assertControlIsolation(workspace, control, { type: "docker", container: "mock" })).rejects.toThrow();
	}
});
