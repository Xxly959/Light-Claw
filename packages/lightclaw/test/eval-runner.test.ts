import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	registerApiProvider,
	registerFauxProvider,
	unregisterApiProviders,
} from "@mariozechner/pi-ai";
import { AgentSession } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultReportPath, runEvaluation } from "../src/evals/runner.js";
import * as sandboxModule from "../src/sandbox.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("faux evaluation pipeline", () => {
	it("tells the model which optional commands were confirmed missing in its sandbox", async () => {
		const directory = mkdtempSync(join(tmpdir(), "lightclaw-eval-capabilities-"));
		const provider = registerFauxProvider();
		let systemPrompt = "";
		provider.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("READY");
			},
		]);
		vi.spyOn(sandboxModule, "createExecutor").mockReturnValue({
			getWorkspacePath: () => "/workspace",
			exec: async () => ({ code: 0, stdout: "bash\npython3\n", stderr: "" }),
		});
		try {
			await runEvaluation({
				cases: [{ id: "capabilities", prompt: "reply READY", expect: { responseIncludes: ["READY"] } }],
				config: {
					transport: "slack",
					modelProvider: provider.getModel().provider,
					modelId: provider.getModel().id,
					maxGoalCycles: 1,
					maxGoalFailures: 1,
					maxStaleCycles: 1,
				},
				sandbox: { type: "docker", container: "mock" },
				workingDir: directory,
				promptLabel: "capabilities",
				runnerOverrides: { model: provider.getModel(), apiKey: "faux", quiet: true },
			});
			expect(systemPrompt).toContain("Unavailable optional commands (checked): curl, git, jq, file");
		} finally {
			provider.unregister();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("still scores a missing response when no session diagnostics were written", async () => {
		const directory = mkdtempSync(join(tmpdir(), "lightclaw-eval-preflight-"));
		const provider = registerFauxProvider();
		vi.spyOn(AgentSession.prototype, "prompt").mockResolvedValueOnce(undefined);
		try {
			const result = await runEvaluation({
				cases: [{ id: "failure", prompt: "reply READY", expect: { responseIncludes: ["READY"] } }],
				config: {
					transport: "slack",
					modelProvider: provider.getModel().provider,
					modelId: provider.getModel().id,
					maxGoalCycles: 1,
					maxGoalFailures: 1,
					maxStaleCycles: 1,
				},
				sandbox: { type: "host" },
				workingDir: directory,
				promptLabel: "preflight",
				runnerOverrides: { model: provider.getModel(), apiKey: "faux", quiet: true },
			});
			expect(result.passedCases).toBe(0);
		} finally {
			provider.unregister();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("includes provider-reported cached input in run and evaluation totals", async () => {
		const directory = mkdtempSync(join(tmpdir(), "lightclaw-eval-cache-"));
		const provider = registerFauxProvider();
		const model = { ...provider.getModel(), api: "usage-regression" };
		const stream = () => {
			const events = createAssistantMessageEventStream();
			const message = {
				...fauxAssistantMessage("ok"),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 10,
					output: 5,
					cacheRead: 20,
					cacheWrite: 3,
					totalTokens: 38,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			queueMicrotask(() => {
				events.push({ type: "done", reason: "stop", message });
				events.end(message);
			});
			return events;
		};
		registerApiProvider({ api: model.api, stream, streamSimple: stream }, "usage-regression");
		try {
			const result = await runEvaluation({
				cases: [{ id: "cache", prompt: "reply ok", expect: { responseIncludes: ["ok"] } }],
				config: {
					transport: "slack",
					modelProvider: model.provider,
					modelId: model.id,
					maxGoalCycles: 1,
					maxGoalFailures: 1,
					maxStaleCycles: 1,
				},
				sandbox: { type: "host" },
				workingDir: directory,
				promptLabel: "cache",
				runnerOverrides: { model, apiKey: "faux", quiet: true },
			});
			expect(result.results[0].run.inputTokens).toBe(33);
			expect(result.totalTokens).toBe(38);
		} finally {
			unregisterApiProviders("usage-regression");
			provider.unregister();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("preserves artifacts and explicitly opted-in tool failure diagnostics across isolated evaluation sessions", async () => {
		vi.stubEnv("LIGHTCLAW_DEBUG_PAYLOADS", "1");
		const directory = mkdtempSync(join(tmpdir(), "lightclaw-eval-faux-"));
		const provider = registerFauxProvider({ api: "faux-eval-pipeline", provider: "faux-eval-pipeline" });
		const dispose = vi.spyOn(AgentSession.prototype, "dispose");
		provider.setResponses([
			fauxAssistantMessage("READY"),
			() => {
				const channel = readdirSync(directory).find((name) => name.endsWith("-artifact"));
				if (!channel) throw new Error("missing artifact channel");
				return fauxAssistantMessage(
					fauxToolCall("write", {
						label: "proof",
						path: join(directory, channel, "scratch/proof.txt"),
						content: "proof-ready",
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("written"),
			fauxAssistantMessage(
				fauxToolCall("bash", { label: "failure", command: "printf 'missing-command-diagnostic' >&2; exit 127" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("recovered"),
		]);
		try {
			const report = await runEvaluation({
				cases: [
					{ id: "reply", prompt: "reply READY", expect: { responseIncludes: ["READY"] } },
					{
						id: "artifact",
						prompt: "write proof",
						expect: {
							filesExist: ["scratch/proof.txt"],
							filesContain: [{ path: "scratch/proof.txt", text: "proof-ready" }],
						},
					},
					{ id: "failure", prompt: "exercise failure", expect: { maxToolErrors: 0 } },
				],
				config: {
					transport: "feishu",
					modelProvider: provider.getModel().provider,
					modelId: provider.getModel().id,
					maxGoalCycles: 1,
					maxGoalFailures: 1,
					maxStaleCycles: 1,
				},
				sandbox: { type: "host" },
				workingDir: directory,
				promptLabel: "faux",
				runnerOverrides: { model: provider.getModel(), apiKey: "faux-key", quiet: true },
			});
			expect(report).toMatchObject({ passedCases: 2, totalCases: 3 });
			expect(report.results[0].score).toBe(1);
			expect(report.results[1].score).toBe(1);
			expect(report.results[1].run.toolCalls).toBe(1);
			expect(dispose).toHaveBeenCalledTimes(3);
			expect(report.results[2].diagnostics?.toolFailures).toContain(
				"missing-command-diagnostic\n\nCommand exited with code 127",
			);
			expect(report.results[2].diagnostics?.systemPrompt).toContain("Current working directory:");
			let allTokens = 0;
			for (const channel of readdirSync(directory).filter((name) => name.startsWith("eval-"))) {
				for (const line of readFileSync(join(directory, channel, "context.jsonl"), "utf8")
					.trim()
					.split("\n")) {
					const entry = JSON.parse(line);
					if (entry.type === "message" && entry.message.role === "assistant") {
						const usage = entry.message.usage;
						allTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
					}
				}
			}
			expect(report.totalTokens).toBe(allTokens);
		} finally {
			provider.unregister();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("uses distinct report paths even within the same millisecond", () => {
		vi.spyOn(Date, "now").mockReturnValue(1);
		expect(defaultReportPath("/tmp/eval")).not.toBe(defaultReportPath("/tmp/eval"));
	});
});
