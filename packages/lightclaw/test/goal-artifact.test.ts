import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type * as promises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertGoalSnapshots, readGoalArtifact } from "../src/goals/artifact.js";

const injected = vi.hoisted(() => ({
	fn: vi.fn<typeof promises.open>(),
	original: undefined as typeof promises.open | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof promises>();
	injected.original = original.open;
	injected.fn.mockImplementation(original.open);
	return { ...original, open: injected.fn };
});

let directory: string;
const signal = () => new AbortController().signal;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "goal-artifact-"));
});
afterEach(() => {
	vi.restoreAllMocks();
	injected.fn.mockReset();
	if (injected.original) injected.fn.mockImplementation(injected.original);
	rmSync(directory, { recursive: true, force: true });
});
describe("bounded goal artifacts", () => {
	it("reads actual bytes and checks contents", async () => {
		writeFileSync(join(directory, "file"), "abc");
		expect(await readGoalArtifact(directory, "file", { signal: signal(), contains: ["abc"] })).toMatchObject({
			status: "snapshot",
			contentsMatch: true,
			snapshot: { bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
		});
		expect(await readGoalArtifact(directory, "file", { signal: signal(), contains: ["absent"] })).toMatchObject({
			contentsMatch: false,
		});
	});
	it("rejects ancestor links, directories and path escapes", async () => {
		mkdirSync(join(directory, "dir"));
		symlinkSync(directory, join(directory, "link"));
		writeFileSync(join(directory, "file"), "abc");
		for (const path of ["../file", "dir", "link/file"])
			expect(await readGoalArtifact(directory, path, { signal: signal() })).toMatchObject({
				status: "inconclusive",
			});
	});
	it("detects replacement even when the bytes are identical", async () => {
		writeFileSync(join(directory, "file"), "abc");
		const read = await readGoalArtifact(directory, "file", { signal: signal() });
		if (read.status !== "snapshot") throw new Error("expected snapshot");
		writeFileSync(join(directory, "replacement"), "abc");
		renameSync(join(directory, "replacement"), join(directory, "file"));
		await expect(assertGoalSnapshots(directory, [read.snapshot], signal())).rejects.toThrow();
	});
	it("bounds body and total file size", async () => {
		writeFileSync(join(directory, "file"), Buffer.alloc(1024 * 1024 + 1));
		expect(await readGoalArtifact(directory, "file", { signal: signal(), contains: ["text"] })).toMatchObject({
			status: "inconclusive",
		});
		writeFileSync(join(directory, "file"), Buffer.alloc(10 * 1024 * 1024 + 1));
		expect(await readGoalArtifact(directory, "file", { signal: signal() })).toMatchObject({ status: "inconclusive" });
	});
	it.skipIf(process.platform === "win32")("rejects FIFO without blocking", async () => {
		execFileSync("mkfifo", [join(directory, "fifo")]);
		expect(await readGoalArtifact(directory, "fifo", { signal: signal() })).toMatchObject({ status: "inconclusive" });
	});
	it("aborts before reading", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(readGoalArtifact(directory, "file", { signal: controller.signal })).rejects.toThrow();
	});
});

it("detects identical-byte replacement while the file handle is being read", async () => {
	writeFileSync(join(directory, "file"), "abc");
	const open = injected.original!;
	injected.fn.mockImplementation(async (...args: Parameters<typeof promises.open>) => {
		const handle = await open(...args);
		const read = handle.read.bind(handle);
		let swapped = false;
		vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
			const result = await read(...readArgs);
			if (!swapped) {
				swapped = true;
				writeFileSync(join(directory, "replacement"), "abc");
				renameSync(join(directory, "replacement"), join(directory, "file"));
			}
			return result;
		});
		return handle;
	});
	expect((await readGoalArtifact(directory, "file", { signal: signal() })).status).toBe("inconclusive");
});
