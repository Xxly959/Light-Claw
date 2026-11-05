import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { validateArtifactPath } from "./acceptance.js";
import type { GoalAcceptance, GoalArtifactRead, GoalArtifactSnapshot, GoalBaseline } from "./types.js";

export async function readGoalArtifact(
	channelDir: string,
	path: string,
	options: { signal: AbortSignal; contains?: string[] },
): Promise<GoalArtifactRead> {
	options.signal.throwIfAborted();
	try {
		validateArtifactPath(path);
		if ((await lstat(channelDir)).isSymbolicLink()) return { status: "inconclusive", reasonCode: "linked_root" };
		const root = await realpath(channelDir);
		const identities: Array<{ path: string; device: bigint; inode: bigint }> = [];
		let target = root;
		for (const part of ["", ...path.split("/")]) {
			options.signal.throwIfAborted();
			target = join(target, part);
			const stat = await lstat(target, { bigint: true });
			if (stat.isSymbolicLink()) return { status: "inconclusive", reasonCode: "linked_path" };
			identities.push({ path: target, device: stat.dev, inode: stat.ino });
		}
		const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const before = await handle.stat({ bigint: true });
			if (!before.isFile()) return { status: "inconclusive", reasonCode: "not_regular" };
			const maximum = options.contains ? 1024 * 1024 : 10 * 1024 * 1024;
			if (before.size > BigInt(maximum)) return { status: "inconclusive", reasonCode: "too_large" };
			const hash = createHash("sha256");
			const chunks: Buffer[] = [];
			let bytes = 0;
			const buffer = Buffer.alloc(65536);
			while (true) {
				options.signal.throwIfAborted();
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
				if (!bytesRead) break;
				bytes += bytesRead;
				if (bytes > maximum) return { status: "inconclusive", reasonCode: "too_large" };
				hash.update(buffer.subarray(0, bytesRead));
				if (options.contains) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
			}
			const after = await handle.stat({ bigint: true });
			if (
				before.size !== after.size ||
				before.mtimeNs !== after.mtimeNs ||
				before.ctimeNs !== after.ctimeNs ||
				bytes !== Number(after.size)
			)
				return { status: "inconclusive", reasonCode: "changed_during_read" };
			for (const expected of identities) {
				const stat = await lstat(expected.path, { bigint: true });
				if (stat.isSymbolicLink() || stat.dev !== expected.device || stat.ino !== expected.inode)
					return { status: "inconclusive", reasonCode: "path_replaced" };
			}
			const last = identities.at(-1);
			if (last?.device !== after.dev || last.inode !== after.ino || (await realpath(channelDir)) !== root)
				return { status: "inconclusive", reasonCode: "path_replaced" };
			options.signal.throwIfAborted();
			const content = options.contains ? Buffer.concat(chunks).toString("utf8") : "";
			return {
				status: "snapshot",
				contentsMatch: options.contains?.every((text) => content.includes(text)) ?? true,
				snapshot: {
					path,
					sha256: hash.digest("hex"),
					bytes,
					device: after.dev.toString(),
					inode: after.ino.toString(),
					mtimeNs: after.mtimeNs.toString(),
					ctimeNs: after.ctimeNs.toString(),
				},
			};
		} finally {
			await handle.close();
		}
	} catch (error) {
		options.signal.throwIfAborted();
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { status: "missing" };
		return { status: "inconclusive", reasonCode: "read_error" };
	}
}

export async function captureGoalBaselines(
	channelDir: string,
	acceptance: GoalAcceptance,
	signal: AbortSignal,
): Promise<GoalBaseline[]> {
	if (acceptance.mode === "manual") return [];
	const result: GoalBaseline[] = [];
	for (const rule of acceptance.files) {
		const read = await readGoalArtifact(channelDir, rule.path, { signal });
		if (read.status === "inconclusive") throw new Error(`无法保存创建基线：${rule.path} (${read.reasonCode})`);
		result.push({ path: rule.path, sha256: read.status === "missing" ? null : read.snapshot.sha256 });
	}
	return result;
}

export async function assertGoalSnapshots(
	channelDir: string,
	snapshots: GoalArtifactSnapshot[],
	signal: AbortSignal,
): Promise<void> {
	for (const expected of snapshots) {
		const read = await readGoalArtifact(channelDir, expected.path, { signal });
		if (
			read.status !== "snapshot" ||
			read.snapshot.sha256 !== expected.sha256 ||
			read.snapshot.device !== expected.device ||
			read.snapshot.inode !== expected.inode ||
			read.snapshot.bytes !== expected.bytes ||
			(expected.mtimeNs !== undefined && read.snapshot.mtimeNs !== expected.mtimeNs) ||
			(expected.ctimeNs !== undefined && read.snapshot.ctimeNs !== expected.ctimeNs)
		)
			throw new Error(`产物已变化：${expected.path}`);
	}
}
