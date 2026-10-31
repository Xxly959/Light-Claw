import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const readerPath = fileURLToPath(new URL("../src/attachment-reader.py", import.meta.url));

function validateRelativePath(path: string): string {
	if (!path || isAbsolute(path) || /[\\\0]/.test(path) || path.split("/").some((p) => !p || p === "." || p === "..")) {
		throw new Error("Attachment requires a channel-relative path without traversal");
	}
	return path;
}

/** Convert only this runner's own namespace. The transport independently authorizes reads. */
export function attachmentPathForChannel(
	path: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
): string {
	const prefix = workspacePath === "/workspace" ? `/workspace/${channelId}/` : `${resolve(channelDir)}/`;
	return validateRelativePath(path.startsWith(prefix) ? path.slice(prefix.length) : path);
}

/** Host boundary: SDKs receive bytes, never an unchecked path or a lazy path stream. */
export async function readChannelAttachment(workingDir: string, channel: string, path: string): Promise<Buffer> {
	validateRelativePath(path);
	if (!/^[A-Za-z0-9_-]+$/.test(channel)) throw new Error("Invalid attachment channel");
	const root = realpathSync(workingDir);
	return new Promise((resolveRead, reject) => {
		execFile(
			"python3",
			["-I", readerPath, root, channel, path, String(MAX_ATTACHMENT_BYTES)],
			{ encoding: "buffer", maxBuffer: MAX_ATTACHMENT_BYTES + 1, timeout: 10_000, killSignal: "SIGKILL" },
			(error, stdout) => {
				if (error)
					reject(
						new Error(
							"Attachment rejected: safe read failed (requires host Python 3, a channel-local regular file, and at most 20 MiB)",
						),
					);
				else resolveRead(stdout);
			},
		);
	});
}
