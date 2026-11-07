import { EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import { expect, it, vi } from "vitest";

it.each([false, true])(
	"actual SDK returns protocol 200 for a toast and 500 for a thrown callback: %s",
	async (throws) => {
		const logger = { debug: vi.fn(), trace: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const dispatcher = new EventDispatcher({ logger, loggerLevel: LoggerLevel.error }).register({
			"card.action.trigger": async () => {
				if (throws) throw new Error("fictional admission failure");
				return { toast: { type: "error", content: "请重新打开表单" } };
			},
		});
		const client = new WSClient({
			appId: "fictional-app",
			appSecret: "fictional-secret",
			logger,
			loggerLevel: LoggerLevel.error,
		});
		const frames: Array<{ payload: Uint8Array }> = [];
		// Exercise the installed SDK's offline frame handler; never start/connect the client.
		Object.assign(client, {
			eventDispatcher: dispatcher,
			sendMessage: (frame: { payload: Uint8Array }) => frames.push(frame),
		});
		const wire = client as unknown as {
			handleEventData(frame: { headers: Array<{ key: string; value: string }>; payload: Uint8Array }): Promise<void>;
		};
		await wire.handleEventData({
			headers: [
				{ key: "message_id", value: "wire-fixture" },
				{ key: "sum", value: "1" },
				{ key: "seq", value: "0" },
				{ key: "type", value: "event" },
			],
			payload: new TextEncoder().encode(
				JSON.stringify({
					schema: "2.0",
					header: { event_type: "card.action.trigger", event_id: "fictional-event" },
					event: {},
				}),
			),
		});
		expect(frames).toHaveLength(1);
		const response = JSON.parse(new TextDecoder().decode(frames[0].payload));
		expect(response.code).toBe(throws ? 500 : 200);
		if (!throws)
			expect(JSON.parse(Buffer.from(response.data, "base64").toString("utf8"))).toEqual({
				toast: { type: "error", content: "请重新打开表单" },
			});
	},
);
