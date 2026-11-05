import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, expect, it } from "vitest";
import { createAgentRunner } from "../src/agent.js";
import { loadConfigForDiagnostics } from "../src/config.js";
import { SimulatedPlatform } from "../src/evals/reliability/simulated-platform.js";
import { makeTaskSandboxPlan, startTaskSandbox } from "../src/evals/reliability/task-sandbox.js";
import { createLightClawRuntime } from "../src/runtime.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "reliability-docker-"));
	roots.push(root);
	const work = join(root, "task"),
		secret = join(root, "protected");
	mkdirSync(work);
	mkdirSync(secret);
	return { root, work, secret };
}
it("mounts only task bytes, forbids evaluator/control/source paths and socket exposure", () => {
	const f = fixture();
	const plan = makeTaskSandboxPlan({ taskDir: f.work, protectedDirs: [f.secret], image: `sha256:${"a".repeat(64)}` });
	expect(plan.args).toContain("--network=none");
	expect(plan.args).toContain("--pull=never");
	expect(plan.args.filter((arg) => arg.startsWith("type=bind,"))).toHaveLength(1);
	expect(JSON.stringify(plan.args)).not.toContain(f.secret);
	expect(() =>
		makeTaskSandboxPlan({ taskDir: f.secret, protectedDirs: [f.secret], image: `sha256:${"a".repeat(64)}` }),
	).toThrow();
	expect(() => makeTaskSandboxPlan({ taskDir: f.work, protectedDirs: [f.secret], image: "unfrozen:latest" })).toThrow(
		/digest/,
	);
});
it.skipIf(process.env.LIGHTCLAW_DOCKER_EVAL_TESTS !== "1")(
	"verifies actual Docker mounts and runs faux Agent without exposing hidden assets",
	async () => {
		const f = fixture();
		mkdirSync(join(f.work, "evaluation"));
		writeFileSync(join(f.work, "evaluation", "input.txt"), "fictional input");
		writeFileSync(join(f.secret, "oracle.txt"), "hidden answer/controller/source");
		const image = execFileSync("docker", ["image", "inspect", "lightclaw-sandbox:local", "--format", "{{.Id}}"], {
			encoding: "utf8",
		}).trim();
		const box = await startTaskSandbox({
			taskDir: f.work,
			protectedDirs: [f.secret, join(f.root, "control"), process.cwd()],
			image,
		});
		const provider = registerFauxProvider();
		let observed = false;
		provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall("read", { label: "read task input", path: "/workspace/evaluation/input.txt" }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("fictional input");
				expect(JSON.stringify(context.messages)).not.toContain("hidden answer");
				observed = true;
				return fauxAssistantMessage(
					fauxToolCall("write", {
						label: "write result",
						path: "/workspace/evaluation/result.txt",
						content: "processed fictional input",
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("complete"),
		]);
		let platform!: SimulatedPlatform;
		const runtime = await createLightClawRuntime({
			config: { ...loadConfigForDiagnostics({}), controlDir: join(f.root, "control") },
			workingDir: f.work,
			sandbox: box.config,
			createTransport: (handler, inbox) => {
				platform = new SimulatedPlatform(handler, inbox, 30000);
				return platform;
			},
			createRunner: (sandbox, id, dir, config, goals, overrides) =>
				createAgentRunner(sandbox, id, dir, config, goals, {
					...overrides,
					model: provider.getModel(),
					inMemoryState: true,
					apiKey: "fictional-faux",
					quiet: true,
				}),
		});
		try {
			await runtime.start();
			platform.receive({
				origin: "platform",
				type: "dm",
				channel: "evaluation",
				user: "owner",
				ts: "1",
				text: "process the input file",
			});
			await runtime.idle();
			expect(observed).toBe(true);
			expect(readFileSync(join(f.work, "evaluation", "result.txt"), "utf8")).toBe("processed fictional input");
			const probe = execFileSync(
				"docker",
				[
					"exec",
					box.config.container,
					"sh",
					"-c",
					"test ! -e /var/run/docker.sock && test ! -e /protected && test ! -e /workspace/control && test ! -e /workspace/oracle.txt && test ! -e /workspace/packages",
				],
				{ encoding: "utf8" },
			);
			expect(probe).toBe("");
		} finally {
			await runtime.shutdown();
			provider.unregister();
			await box.dispose();
		}
	},
	30000,
);
