import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { AgentSession } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultReportPath, runEvaluation } from "../src/evals/runner.js";

afterEach(() => vi.restoreAllMocks());

describe("faux evaluation pipeline", () => {
	it("scores a real write-tool artifact and releases each evaluation session", async () => {
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
			expect(report).toMatchObject({ score: 1, passedCases: 2, totalCases: 2 });
			expect(report.results[1].run.toolCalls).toBe(1);
			expect(dispose).toHaveBeenCalledTimes(2);
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
