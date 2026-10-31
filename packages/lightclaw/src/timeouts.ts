import type { ChatContext } from "./transport.js";

export class OperationTimeoutError extends Error {
	constructor(operation: string, timeoutMs: number) {
		super(`${operation} timed out after ${timeoutMs}ms; delivery outcome may be unknown`);
		this.name = "OperationTimeoutError";
	}
}

export async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
		throw new Error("Timeout must be a positive integer within the Node timer range");
	}
	let timer: NodeJS.Timeout | undefined;
	try {
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new OperationTimeoutError(label, timeoutMs)), timeoutMs);
		});
		return await Promise.race([operation(), deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Reject further sends from this context after a delivery becomes uncertain. */
export function withTimedChatContext(
	ctx: ChatContext,
	timeoutMs: number,
	onError?: (error: Error) => void,
): ChatContext {
	let expired: OperationTimeoutError | undefined;
	const call = async (label: string, operation: () => Promise<void>): Promise<void> => {
		if (expired) throw expired;
		try {
			await withTimeout(operation, timeoutMs, label);
		} catch (error) {
			if (error instanceof OperationTimeoutError && !expired) {
				expired = error;
			}
			onError?.(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	};
	return {
		...ctx,
		respond: (text, log) => call("respond", () => ctx.respond(text, log)),
		replaceMessage: (text) => call("replaceMessage", () => ctx.replaceMessage(text)),
		respondInThread: (text) => call("respondInThread", () => ctx.respondInThread(text)),
		setTyping: (typing) => call("setTyping", () => ctx.setTyping(typing)),
		uploadFile: (path, title) => call("uploadFile", () => ctx.uploadFile(path, title)),
		setWorking: (working) => call("setWorking", () => ctx.setWorking(working)),
		deleteMessage: () => call("deleteMessage", () => ctx.deleteMessage()),
	};
}
