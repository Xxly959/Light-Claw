import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	registerApiProvider,
	registerFauxProvider,
	type SimpleStreamOptions,
	type StreamFunction,
	unregisterApiProviders,
} from "@mariozechner/pi-ai";
import { expect, it } from "vitest";
import { runEvaluation } from "../src/evals/runner.js";

it("puts the paired evaluation seed into the provider payload through the production runner", async () => {
	const root = mkdtempSync(join(tmpdir(), "evaluation-seed-"));
	const faux = registerFauxProvider();
	const model = { ...faux.getModel(), api: "openai-completions" as const };
	let payload: unknown;
	const stream: StreamFunction<"openai-completions", SimpleStreamOptions> = (selected, _context, options) => {
		const events = createAssistantMessageEventStream();
		const message = {
			...fauxAssistantMessage("READY"),
			api: selected.api,
			provider: selected.provider,
			model: selected.id,
		};
		queueMicrotask(async () => {
			payload = await options?.onPayload?.({ model: selected.id }, selected);
			events.push({ type: "done", reason: "stop", message });
			events.end(message);
		});
		return events;
	};
	registerApiProvider({ api: model.api, stream, streamSimple: stream }, "evaluation-seed-probe");
	try {
		const result = await runEvaluation({
			cases: [{ id: "seed", prompt: "reply READY", expect: { responseIncludes: ["READY"] } }],
			config: {
				transport: "slack",
				modelProvider: model.provider,
				modelId: model.id,
				maxGoalCycles: 8,
				maxGoalFailures: 2,
				maxStaleCycles: 2,
			},
			sandbox: { type: "host" },
			workingDir: root,
			promptLabel: "seed",
			evaluationSeed: 104746,
			runnerOverrides: { model, apiKey: "faux", tools: [], quiet: true },
		});
		expect(result.passedCases).toBe(1);
		expect(payload).toMatchObject({ seed: 104746 });
	} finally {
		unregisterApiProviders("evaluation-seed-probe");
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	}
});
