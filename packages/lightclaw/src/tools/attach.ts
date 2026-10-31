import type { AgentTool } from "@mariozechner/pi-agent-core";
import { basename } from "path";
import { Type } from "typebox";

export type UploadFunction = (filePath: string, title?: string) => Promise<void>;

const attachSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're sharing (shown to user)" }),
	path: Type.String({ description: "Path to the file to attach" }),
	title: Type.Optional(Type.String({ description: "Title for the file (defaults to filename)" })),
});

export function createAttachTool(upload: UploadFunction): AgentTool<typeof attachSchema> {
	return {
		name: "attach",
		label: "attach",
		description:
			"Attach a file to your response. Use this to share files, images, or documents with the user. Only regular files in the current channel directory can be attached (maximum 20 MiB). Use a channel-relative path or the current channel absolute path; shared and other-channel files are not allowed.",
		parameters: attachSchema,
		execute: async (
			_toolCallId: string,
			{ path, title }: { label: string; path: string; title?: string },
			signal?: AbortSignal,
		) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const fileName = title || basename(path);

			await upload(path, fileName);

			return {
				content: [{ type: "text" as const, text: `Attached file: ${fileName}` }],
				details: undefined,
			};
		},
	};
}
