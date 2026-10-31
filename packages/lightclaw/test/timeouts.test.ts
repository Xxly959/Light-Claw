import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationTimeoutError, withTimedChatContext, withTimeout } from "../src/timeouts.js";
import type { ChatContext } from "../src/transport.js";

afterEach(() => {
	vi.useRealTimers();
});

function context(): ChatContext {
	return {
		message: { text: "test", rawText: "test", user: "test", channel: "test", ts: "1", attachments: [] },
		channels: [],
		users: [],
		respond: vi.fn(async () => {}),
		replaceMessage: vi.fn(async () => {}),
		respondInThread: vi.fn(async () => {}),
		setTyping: vi.fn(async () => {}),
		uploadFile: vi.fn(async () => {}),
		setWorking: vi.fn(async () => {}),
		deleteMessage: vi.fn(async () => {}),
	};
}

describe("bounded platform waits", () => {
	it("clears timers on success, rejection and synchronous errors", async () => {
		vi.useFakeTimers();
		expect(await withTimeout(async () => "result", 50, "test")).toBe("result");
		await expect(
			withTimeout(
				async () => {
					throw new Error("failed");
				},
				50,
				"test",
			),
		).rejects.toThrow("failed");
		await expect(
			withTimeout(
				() => {
					throw new Error("sync");
				},
				50,
				"test",
			),
		).rejects.toThrow("sync");
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each([0, -1, 0.5, Infinity, 2_147_483_648])("rejects invalid timer %s before invoking work", async (timeout) => {
		const work = vi.fn(async () => "result");
		await expect(withTimeout(work, timeout, "test")).rejects.toThrow("Node timer range");
		expect(work).not.toHaveBeenCalled();
	});
	it("isolates an expired context and handles a late rejection without new sends", async () => {
		vi.useFakeTimers();
		const original = context();
		let reject!: (error: Error) => void;
		original.respond = vi.fn(
			() =>
				new Promise<void>((_resolve, fail) => {
					reject = fail;
				}),
		);
		const errors: Error[] = [];
		const bounded = withTimedChatContext(original, 50, (error) => errors.push(error));
		const response = expect(bounded.respond("first")).rejects.toBeInstanceOf(OperationTimeoutError);
		await vi.advanceTimersByTimeAsync(50);
		await response;
		await expect(bounded.respondInThread("fallback")).rejects.toThrow("delivery outcome may be unknown");
		await expect(bounded.uploadFile("/tmp/report")).rejects.toThrow("timed out");
		expect(original.respondInThread).not.toHaveBeenCalled();
		expect(original.uploadFile).not.toHaveBeenCalled();
		expect(errors).toHaveLength(1);
		reject(new Error("late SDK rejection"));
		await Promise.resolve();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("keeps transient failures observable while allowing subsequent updates", async () => {
		const original = context();
		original.respond = vi.fn(async () => {
			throw new Error("temporary failure");
		});
		const errors: Error[] = [];
		const bounded = withTimedChatContext(original, 50, (error) => errors.push(error));
		await expect(bounded.respond("first")).rejects.toThrow("temporary failure");
		await bounded.replaceMessage("recovered");
		expect(original.replaceMessage).toHaveBeenCalledWith("recovered");
		expect(errors.map((error) => error.message)).toEqual(["temporary failure"]);
	});
});
