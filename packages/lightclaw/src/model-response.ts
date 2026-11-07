import type { AssistantMessage } from "@mariozechner/pi-ai";

export const EMPTY_MODEL_RESPONSE_ERROR = "Model returned no usable content";

/** Thinking alone cannot finish a user task; tool calls remain valid actionable output. */
export function hasActionableModelContent(message: AssistantMessage): boolean {
	return message.content.some(
		(part) => part.type === "toolCall" || (part.type === "text" && part.text.trim().length > 0),
	);
}
