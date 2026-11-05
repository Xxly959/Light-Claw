import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDurableJson } from "../../durable-state.js";
import { acquireControlLock, isWithin, physicalPath } from "../../goals/control.js";
import { budgetOperation, type CampaignBudgetSpec, PersistentModelBudget } from "./budget-ledger.js";
import { loadOracles, loadTasks, sha256 } from "./data.js";
import { assertFrozen, repository } from "./protocol.js";
import { loadAttemptRecords, observationRecord } from "./records.js";
import { judge } from "./scoring.js";
import { joinAttempts, pairedTaskEffect, resolveTerminal, summarize } from "./statistics.js";
import type { Attempt, Freeze, Job, Observation, Oracle, ReliabilityTask } from "./types.js";

const sourceEntry = import.meta.url.endsWith(".ts");
const worker = fileURLToPath(new URL(sourceEntry ? "./worker.ts" : "./worker.js", import.meta.url));
interface Exit {
	code: number | null;
	signal: string | null;
	timeout: boolean;
	injectedCrash: boolean;
}
function boot(root: string, payload: string, recover: boolean, timeoutMs: number, injectCrash: boolean): Promise<Exit> {
	return new Promise((resolveExit) => {
		const loaderArgs = sourceEntry ? ["--import", createRequire(import.meta.url).resolve("tsx")] : [];
		const child = spawn(process.execPath, [...loaderArgs, worker, payload, recover ? "recover" : "initial"], {
			cwd: root,
			env: {
				PATH: process.env.PATH,
				HOME: join(root, "home"),
				TMPDIR: join(root, "tmp"),
				NO_PROXY: "*",
				NODE_ENV: "test",
				TSX_TSCONFIG_PATH: join(repository, "tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.once("spawn", () =>
			appendFileSync(
				join(root, "launched.jsonl"),
				`${JSON.stringify({ pid: child.pid, at: Date.now(), recover })}\n`,
			),
		);
		let timeout = false,
			injectedCrash = false,
			pending = "";
		const timer = setTimeout(() => {
			timeout = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			appendFileSync(join(root, "stdout.log"), chunk);
			pending = (pending + chunk.toString()).slice(-4096);
			if (injectCrash && !injectedCrash && pending.includes("RELIABILITY_CRASH_POINT")) {
				injectedCrash = true;
				child.kill("SIGKILL");
			}
		});
		child.stderr.on("data", (chunk: Buffer) => appendFileSync(join(root, "stderr.log"), chunk));
		child.once("error", (error) => {
			appendFileSync(join(root, "stderr.log"), String(error));
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolveExit({ code, signal, timeout, injectedCrash });
		});
	});
}
export async function runJob(
	freeze: Freeze,
	job: Job,
	task: ReliabilityTask,
	oracle: Oracle,
	root: string,
	campaign?: CampaignBudgetSpec,
): Promise<Attempt> {
	if (task.split === "blind" || job.caseId !== task.id) throw new Error("Blind/unmatched worker input");
	mkdirSync(root, { recursive: false });
	for (const dir of ["home", "tmp"]) mkdirSync(join(root, dir));
	const prompt = job.arm === "candidate" ? freeze.prompts.candidate : freeze.prompts.baseline;
	const payload = join(root, "payload.json");
	writeFileSync(payload, JSON.stringify({ task, oracle, job, root, prompt, campaign }));
	const campaignReader = campaign
		? await budgetOperation(() => new PersistentModelBudget(campaign.path, campaign.limits, Date.now, true))
		: undefined;
	const remaining = () =>
		Math.max(
			1,
			Math.min(
				freeze.budget.externalTimeoutMs,
				campaignReader?.snapshot().remainingWallMs ?? freeze.budget.externalTimeoutMs,
			),
		);
	const started = Date.now();
	const exits: Exit[] = [];
	exits.push(await boot(root, payload, false, remaining(), task.scenario === "process-crash"));
	if (exits[0].injectedCrash && !exits[0].timeout)
		exits.push(
			await boot(
				root,
				payload,
				true,
				Math.max(1, Math.min(remaining(), freeze.budget.externalTimeoutMs - (Date.now() - started))),
				false,
			),
		);
	const last = exits.at(-1)!;
	const controller: Attempt["controller"] = {
		code: last.code,
		signal: last.signal,
		timeout: exits.some((e) => e.timeout),
		boots: exits.length,
		elapsedMs: Date.now() - started,
	};
	writeDurableJson(join(root, "controller.json"), { exits, controller });
	let observation: Observation | null = null;
	let recordError = false;
	if (existsSync(join(root, "observation.json")))
		try {
			observation = observationRecord(JSON.parse(readFileSync(join(root, "observation.json"), "utf8")) as unknown);
		} catch (error) {
			recordError = true;
			controller.recordError = true;
			writeFileSync(join(root, "record-error.txt"), String(error));
		}
	let score: Attempt["score"] = null;
	if (observation) {
		try {
			score = judge(
				task,
				oracle,
				observation,
				realpathSync(join(root, "work")),
				"evaluation",
				Object.fromEntries(Object.entries(task.inputs).map(([name, value]) => [name, sha256(value)])),
				freeze.hashes["packages/lightclaw/evals/reliability/protected/check-artifacts.py"] ??
					freeze.hashes["package/evals/reliability/protected/check-artifacts.py"],
			);
		} catch (error) {
			writeFileSync(join(root, "scoring-error.txt"), String(error));
		}
	}
	const terminal = controller.timeout
		? "external_timeout"
		: recordError
			? "worker_error"
			: score || !observation
				? resolveTerminal(controller, observation)
				: "worker_error";
	const row: Attempt = { job, terminal, controller, observation, score, cost: null };
	writeDurableJson(join(root, "attempt.json"), row);
	return row;
}
export function readReport(freeze: Freeze, out: string) {
	assertFrozen(freeze);
	const { records, diagnostics } = loadAttemptRecords(freeze, out);
	const started = new Set(
		freeze.jobs.filter((job) => existsSync(join(out, "runs", job.id, "launched.jsonl"))).map((j) => j.id),
	);
	const rows = joinAttempts(freeze, records, started);
	const tasks = loadTasks();
	return {
		schema: 1,
		evidence: "faux-wiring-only",
		warning: "Fixed answers verify wiring/scoring only; no model quality, candidate benefit or real platform claim.",
		axis: freeze.axis,
		recordDiagnostics: diagnostics,
		accounting: {
			campaign: existsSync(join(out, "campaign.json"))
				? (() => {
						const spec = JSON.parse(readFileSync(join(out, "campaign.json"), "utf8")) as CampaignBudgetSpec;
						if (!existsSync(spec.path)) return { status: "missing", spec, snapshot: null };
						try {
							return {
								status: "available",
								spec,
								snapshot: new PersistentModelBudget(spec.path, spec.limits, Date.now, true).snapshot(),
							};
						} catch {
							return { status: "unavailable", spec, snapshot: null };
						}
					})()
				: null,

			budgets: freeze.jobs.map((job) => {
				const path = join(out, "runs", job.id, "model-budget.json");
				return {
					jobId: job.id,
					ledger: existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : null,
				};
			}),
			planned: freeze.jobs.length,
			dispatched: freeze.jobs.filter((j) => existsSync(join(out, "runs", j.id, "payload.json"))).length,
			osLaunched: started.size,
			workerEntered: freeze.jobs.filter((j) => existsSync(join(out, "runs", j.id, "started.json"))).length,
			controllerRecords: records.length,
			completeObservations: records.filter((r) => r.observation).length,
		},
		overall: summarize(rows),
		arms: Object.fromEntries(
			[...new Set(rows.map((r) => r.job.arm))].map((arm) => [arm, summarize(rows.filter((r) => r.job.arm === arm))]),
		),
		scenarios: Object.fromEntries(
			[...new Set(tasks.map((t) => t.scenario))].map((scenario) => [
				scenario,
				summarize(rows.filter((r) => tasks.find((t) => t.id === r.job.caseId)?.scenario === scenario)),
			]),
		),
		paired: pairedTaskEffect(
			rows,
			freeze.axis === "A" ? "baseline" : "governed",
			freeze.axis === "A" ? "governed" : "candidate",
		),
		attempts: rows.map((r) => ({ id: r.job.id, terminal: r.terminal, score: r.score, observation: r.observation })),
	};
}

export interface CampaignOptions {
	budgetPath?: string;
}
export async function runFrozen(freeze: Freeze, destination: string, options: CampaignOptions = {}) {
	return runCampaign(freeze, destination, false, options);
}
export async function resumeFrozen(freeze: Freeze, destination: string, options: CampaignOptions = {}) {
	return runCampaign(freeze, destination, true, options);
}
async function runCampaign(freeze: Freeze, destination: string, resume: boolean, options: CampaignOptions) {
	assertFrozen(freeze);
	const out = resolve(destination);
	if (!resume) {
		mkdirSync(out, { recursive: false });
		mkdirSync(join(out, "runs"));
		writeDurableJson(join(out, "freeze.json"), freeze);
	} else if (JSON.stringify(JSON.parse(readFileSync(join(out, "freeze.json"), "utf8"))) !== JSON.stringify(freeze))
		throw new Error("Frozen campaign manifest changed");
	const lock = acquireControlLock(join(out, ".controller"));
	try {
		if (!freeze.budget.campaign) throw new Error("Frozen campaign budget is required; create a new manifest");
		const path = physicalPath(
			options.budgetPath ??
				(resume
					? (JSON.parse(readFileSync(join(out, "campaign.json"), "utf8")) as CampaignBudgetSpec).path
					: join(out, "campaign-budget.json")),
		);
		if (isWithin(physicalPath(join(out, "runs")), path))
			throw new Error("Campaign budget cannot enter task/worker directories");
		const spec: CampaignBudgetSpec = { path, limits: freeze.budget.campaign };
		if (
			resume &&
			JSON.stringify(JSON.parse(readFileSync(join(out, "campaign.json"), "utf8"))) !== JSON.stringify(spec)
		)
			throw new Error("Frozen shared budget specification changed");
		const budget = await budgetOperation(
			() => new PersistentModelBudget(path, spec.limits, Date.now, resume || options.budgetPath !== undefined),
		);
		if (!resume) writeDurableJson(join(out, "campaign.json"), spec);
		appendFileSync(
			join(out, "controller-events.jsonl"),
			`${JSON.stringify({ at: Date.now(), type: resume ? "resumed" : "started", budget: budget.snapshot() })}\n`,
		);
		const tasks = loadTasks(),
			oracles = loadOracles();
		let cursor = 0;
		const lane = async () => {
			while (cursor < freeze.jobs.length) {
				const snapshot = budget.snapshot();
				if (snapshot.stopReason) {
					writeDurableJson(join(out, "budget-stop.json"), snapshot);
					break;
				}
				const job = freeze.jobs[cursor++],
					root = join(out, "runs", job.id);
				// A controller crash may have launched work: never replay an existing directory automatically.
				if (existsSync(root)) continue;
				const task = tasks.find((t) => t.id === job.caseId);
				if (!task || !oracles[task.id]) throw new Error("Missing task/oracle");
				const row = await runJob(freeze, job, task, oracles[task.id], root, spec);
				appendFileSync(join(out, "attempts.jsonl"), `${JSON.stringify(row)}\n`);
			}
		};
		await Promise.all(Array.from({ length: freeze.budget.maxConcurrent }, lane));
		const report = readReport(freeze, out);
		writeDurableJson(join(out, "report.json"), report);
		return report;
	} finally {
		lock.release();
	}
}
