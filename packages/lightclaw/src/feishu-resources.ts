import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { assertChannelId, physicalPath } from "./goals/control.js";
import { assertResourceCapacity, resourceNumber } from "./resource-policy.js";
import type { Attachment } from "./store.js";
import type { ChatEvent } from "./transport.js";

const writer = fileURLToPath(new URL("./attachment-writer.py", import.meta.url));
export async function acceptFeishuResources(
	client: Lark.Client["im"]["v1"]["messageResource"],
	workspace: string,
	event: ChatEvent,
): Promise<Attachment[]> {
	assertChannelId(event.channel);
	const root = physicalPath(workspace),
		directory = join(root, event.channel, "attachments");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (physicalPath(directory) !== directory) throw new Error("Attachment linked directory rejected");
	const attachments: Attachment[] = [];
	for (const item of event.resources ?? []) {
		const maximum = Math.min(
			resourceNumber("ATTACHMENT_FILE_MAX_BYTES", 20 * 1024 * 1024),
			resourceNumber("ATTACHMENT_MAX_BYTES", 256 * 1024 * 1024),
		);
		const hash = createHash("sha256")
			.update(JSON.stringify([event.channel, event.ts, item.kind, item.key]))
			.digest("hex")
			.slice(0, 32);
		const safe =
			basename(item.name.replace(/\\/g, "/"))
				.replace(/[^A-Za-z0-9._-]/g, "_")
				.replace(/^\.+/, "")
				.slice(-100) || "file";
		const name = `${hash}_${safe}`;
		let stream: Readable | undefined,
			timer: ReturnType<typeof setTimeout> | undefined,
			expired = false;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => {
					expired = true;
					stream?.destroy();
					reject(new Error("Attachment download timeout"));
				},
				resourceNumber("DOWNLOAD_TIMEOUT_MS", 30000),
			);
		});
		try {
			const pending = client.get({
				path: { message_id: event.ts, file_key: item.key },
				params: { type: item.kind },
			});
			void pending.then(
				(result) => {
					if (expired) result.getReadableStream().destroy();
				},
				() => {},
			);
			const response = await Promise.race([pending, timeout]);
			if (!response || typeof response.getReadableStream !== "function")
				throw new Error("Attachment resource permission/download failed");
			stream = response.getReadableStream();
			const chunks: Buffer[] = [];
			let bytes = 0;
			const iterator = stream[Symbol.asyncIterator]();
			while (true) {
				const next = await Promise.race([iterator.next(), timeout]);
				if (next.done) break;
				const raw: unknown = next.value;
				if (!(raw instanceof Uint8Array) && typeof raw !== "string")
					throw new Error("Invalid attachment stream chunk");
				const chunk = Buffer.from(raw);
				bytes += chunk.byteLength;
				if (bytes > maximum) throw new Error("Attachment size limit exceeded");
				chunks.push(chunk);
			}
			if (expired || physicalPath(directory) !== directory)
				throw new Error("Attachment path changed or download timed out");
			assertResourceCapacity(directory, bytes, "attachment");
			await new Promise<void>((resolve, reject) => {
				const child = execFile(
					"python3",
					["-I", writer, root, event.channel, name, String(maximum)],
					{ timeout: 10000, maxBuffer: 65536 },
					(error) => (error ? reject(new Error("Attachment safe write failed")) : resolve()),
				);
				child.stdin?.on("error", reject);
				child.stdin?.end(Buffer.concat(chunks, bytes));
			});
			attachments.push({ original: item.name, local: `${event.channel}/attachments/${name}` });
		} finally {
			if (timer) clearTimeout(timer);
			stream?.destroy();
		}
	}
	return attachments;
}
