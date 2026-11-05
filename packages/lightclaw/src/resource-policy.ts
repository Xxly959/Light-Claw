import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statfsSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { boundedRedactedText, debugPayloadsEnabled, redactDiagnosticValue } from "./redaction.js";

export type ResourceKind = "audit" | "diagnostic" | "attachment" | "archive" | "history";
const MiB = 1024 * 1024;
const reservations = new Map<string, number>();
export class ResourceLimitError extends Error {}
export function resourceNumber(name: string, fallback: number): number {
	const raw = process.env[`LIGHTCLAW_${name}`];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new ResourceLimitError(`Invalid resource policy LIGHTCLAW_${name}`);
	return value;
}
function limit(kind: ResourceKind): number {
	return resourceNumber(
		`${kind.toUpperCase()}_MAX_BYTES`,
		{ audit: 16 * MiB, diagnostic: MiB, attachment: 256 * MiB, archive: 128 * MiB, history: 128 * MiB }[kind],
	);
}
function managed(name: string, kind: ResourceKind): boolean {
	if (kind === "archive") return /^lightclaw-(?:exec|bash)-[a-zA-Z0-9-]+\.log$/.test(name);
	if (kind === "audit") return /^(?:runs|tool-calls|spans)\.jsonl(?:\.[a-zA-Z0-9-]+)?$/.test(name);
	if (kind === "diagnostic") return name === "last_prompt.jsonl";
	if (kind === "history") return name === "log.jsonl";
	return !name.startsWith(".");
}
function files(
	directory: string,
	kind: ResourceKind,
	payload = false,
): Array<{ path: string; size: number; mtime: number }> {
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.filter((name) => kind === "audit" || managed(name, kind))
		.flatMap((name) => {
			const path = join(directory, name);
			const info = lstatSync(path);
			if (kind === "audit" && info.isSymbolicLink()) throw new ResourceLimitError("audit linked path rejected");
			if (
				kind === "audit" &&
				info.isDirectory() &&
				(name === "payloads" || (payload && /^[a-zA-Z0-9_-]{1,64}$/.test(name)))
			)
				return files(path, kind, true);
			if (kind === "audit" && !managed(name, kind) && !(payload && name.endsWith(".json"))) return [];
			return info.isFile() && !info.isSymbolicLink() ? [{ path, size: info.size, mtime: info.mtimeMs }] : [];
		});
}
export function pruneManagedResources(directory: string, kind: ResourceKind): void {
	if (kind === "history") return;
	const hours = resourceNumber(`${kind.toUpperCase()}_RETENTION_HOURS`, kind === "attachment" ? 168 : 24);
	for (const file of files(directory, kind)) {
		const activeAudit = kind === "audit" && /\/(?:runs|tool-calls|spans)\.jsonl$/.test(file.path);
		if (!activeAudit && !reservations.has(file.path) && Date.now() - file.mtime > hours * 3600_000) rmSync(file.path);
	}
}
function ensureFreeSpace(directory: string, additionalBytes: number): void {
	let ancestor = directory;
	while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
	const info = statfsSync(ancestor);
	const reserve = resourceNumber("MIN_FREE_BYTES", 16 * MiB);
	if (info.bavail * info.bsize - additionalBytes < reserve)
		throw new ResourceLimitError("Resource disk reserve exhausted");
}
export function assertResourceCapacity(directory: string, additionalBytes: number, kind: ResourceKind): void {
	pruneManagedResources(directory, kind);
	const used = files(directory, kind).reduce((total, file) => total + file.size, 0);
	if (used + additionalBytes > limit(kind)) throw new ResourceLimitError(`${kind} quota exceeded`);
	ensureFreeSpace(directory, additionalBytes);
}
/** Counts pending stream buffers as well as committed bytes; same-process single-instance policy. */
export function reserveArchiveBytes(path: string, bytes: number): void {
	const directory = dirname(path);
	pruneManagedResources(directory, "archive");
	const committed = new Map(files(directory, "archive").map((file) => [file.path, file.size]));
	for (const [activePath, reserved] of reservations)
		if (dirname(activePath) === directory)
			committed.set(activePath, Math.max(committed.get(activePath) ?? 0, reserved));
	const previous = committed.get(path) ?? 0;
	const next = Math.max(previous, reservations.get(path) ?? 0) + bytes;
	const used = [...committed.values()].reduce((sum, value) => sum + value, 0) - previous + next;
	if (used > limit("archive")) throw new ResourceLimitError("archive quota exceeded");
	ensureFreeSpace(directory, bytes);
	reservations.set(path, next);
}
export function releaseArchiveReservation(path: string): void {
	reservations.delete(path);
}
export function diagnosticWriteWarning(kind: string, error: unknown): void {
	const code =
		error && typeof error === "object" && "code" in error
			? String(error.code)
			: error instanceof ResourceLimitError
				? "RESOURCE_LIMIT"
				: "WRITE_FAILED";
	console.warn(`[lightclaw] ${kind} diagnostic unavailable (${boundedRedactedText(code, 80)})`);
}
export function appendDiagnostic(path: string, line: string, kind: "audit" | "diagnostic" = "audit"): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		assertResourceCapacity(dirname(path), Buffer.byteLength(line), kind);
		appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
	} catch (error) {
		diagnosticWriteWarning(kind, error);
		if (kind === "audit") throw error;
	}
}
export function appendConversationLine(path: string, line: string): void {
	mkdirSync(dirname(path), { recursive: true });
	assertResourceCapacity(dirname(path), Buffer.byteLength(line), "history");
	appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
}
export function writePromptDiagnostic(directory: string, value: unknown): void {
	try {
		pruneManagedResources(directory, "diagnostic");
		const path = join(directory, "last_prompt.jsonl");
		if (!debugPayloadsEnabled()) {
			rmSync(path, { force: true });
			return;
		}
		const line = `${JSON.stringify(redactDiagnosticValue(value))}\n`;
		// Replacement quota uses the new bounded payload rather than counting the old copy twice.
		if (Buffer.byteLength(line) > limit("diagnostic")) throw new ResourceLimitError("diagnostic quota exceeded");
		ensureFreeSpace(directory, Buffer.byteLength(line));
		const temporary = `${path}.tmp`;
		try {
			writeFileSync(temporary, line, { mode: 0o600 });
			renameSync(temporary, path);
		} finally {
			rmSync(temporary, { force: true });
		}
	} catch (error) {
		diagnosticWriteWarning("prompt", error);
	}
}

/** No cleanup for control state: account every regular sibling file, and retain the old state on rejection. */
export function assertStateCapacity(path: string, nextBytes: number): void {
	const directory = dirname(path);
	const used = existsSync(directory)
		? readdirSync(directory).reduce((sum, name) => {
				const candidate = join(directory, name);
				const info = lstatSync(candidate);
				return sum + (candidate !== path && info.isFile() ? info.size : 0);
			}, 0)
		: 0;
	if (used + nextBytes > resourceNumber("STATE_MAX_BYTES", 128 * MiB))
		throw new ResourceLimitError("state quota exceeded");
	ensureFreeSpace(directory, nextBytes);
}
/** SessionManager owns append semantics. Check before dispatch; one run may grow beyond this admission bound. */
export function assertContextCapacity(directory: string, additionalBytes = 0): void {
	const path = join(directory, "context.jsonl");
	const bytes = existsSync(path) ? lstatSync(path).size : 0;
	if (bytes + additionalBytes > resourceNumber("CONTEXT_MAX_BYTES", 128 * MiB))
		throw new ResourceLimitError("context quota exceeded");
	ensureFreeSpace(directory, additionalBytes);
}
