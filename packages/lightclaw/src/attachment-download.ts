import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertResourceCapacity, resourceNumber } from "./resource-policy.js";

/** Read bounded chunks before allocating the final buffer; failed transfers never publish a partial file. */
export async function downloadAttachment(path: string, url: string, token: string): Promise<void> {
	const maxBytes = Math.min(
		resourceNumber("ATTACHMENT_FILE_MAX_BYTES", 20 * 1024 * 1024),
		resourceNumber("ATTACHMENT_MAX_BYTES", 256 * 1024 * 1024),
	);
	const timeoutMs = resourceNumber("DOWNLOAD_TIMEOUT_MS", 30_000);
	const controller = new AbortController();
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(new Error("Attachment download timeout"));
			controller.abort();
			void reader?.cancel().catch(() => {});
		}, timeoutMs);
	});
	try {
		const response = await Promise.race([
			fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, redirect: "error" }),
			timeout,
		]);
		if (!response.ok) throw new Error(`Attachment download HTTP ${response.status}`);
		if (Number(response.headers.get("content-length")) > maxBytes) {
			await response.body?.cancel();
			throw new Error("Attachment download size limit exceeded");
		}
		if (!response.body) throw new Error("Attachment download missing body");
		reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		while (true) {
			const result = await Promise.race([reader.read(), timeout]);
			if (controller.signal.aborted) throw new Error("Attachment download timeout");
			if (result.done) break;
			bytes += result.value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel();
				throw new Error("Attachment download size limit exceeded");
			}
			chunks.push(result.value);
		}
		mkdirSync(dirname(path), { recursive: true });
		assertResourceCapacity(dirname(path), bytes, "attachment");
		const temporary = `${path}.${randomUUID()}.partial`;
		try {
			writeFileSync(temporary, Buffer.concat(chunks, bytes), { flag: "wx", mode: 0o600 });
			renameSync(temporary, path);
		} finally {
			rmSync(temporary, { force: true });
		}
	} finally {
		if (timer) clearTimeout(timer);
		controller.abort();
		reader?.releaseLock();
	}
}
