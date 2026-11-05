import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertStateCapacity } from "./resource-policy.js";

/** Local single-writer state: an atomic old/new file across process crashes. */
export function writeDurableJson(path: string, value: unknown): void {
	writeDurableFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
export function writeDurableFile(path: string, text: string | Uint8Array): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	assertStateCapacity(path, Buffer.byteLength(text));
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(fd, text);
		fsyncSync(fd);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	const parent = openSync(directory, "r");
	try {
		fsyncSync(parent);
	} finally {
		closeSync(parent);
	}
}

export function stableId(...parts: string[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function requestFingerprint(value: unknown): string {
	const canonical = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(canonical);
		if (item && typeof item === "object")
			return Object.fromEntries(
				Object.entries(item)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, v]) => [key, canonical(v)]),
			);
		return item;
	};
	const text = JSON.stringify(canonical(value));
	if (text === undefined) throw new Error("Request must be JSON serializable");
	return stableId(text);
}
