import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PersistentModelBudget, parseBudgetLimits } from "./budget-ledger.js";
import { readReport, resumeFrozen, runFrozen } from "./controller.js";
import { auditData, loadTasks } from "./data.js";
import { makeFreeze } from "./protocol.js";
import type { Freeze, Split } from "./types.js";
export async function reliabilityCli(args: string[]): Promise<void> {
	const allowed = ["suite", "mode", "out", "axis", "splits", "repetitions", "candidate", "budget", "limits"];
	const options = new Map(
		args.map((arg) => {
			const match = /^--([a-z]+)=(.+)$/.exec(arg);
			if (!match || !allowed.includes(match[1])) throw new Error(`Unsupported offline argument: ${arg}`);
			return [match[1], match[2]];
		}),
	);
	const tasks = loadTasks(),
		mode = options.get("mode") ?? "audit";

	if (options.has("limits") && mode !== "offline" && mode !== "budget")
		throw new Error("--limits may only initialize a new frozen campaign/budget");
	if (mode === "budget") {
		const path = options.get("budget"),
			limits = options.get("limits");
		if (!path || !limits) throw new Error("budget mode requires --budget and --limits");
		if (existsSync(resolve(path))) throw new Error("Budget already exists; never overwrite spent allowances");
		const ledger = new PersistentModelBudget(
			resolve(path),
			parseBudgetLimits(JSON.parse(readFileSync(resolve(limits), "utf8"))),
		);
		console.log(
			JSON.stringify(
				{ status: "initialized-faux-budget-only", budget: resolve(path), snapshot: ledger.snapshot() },
				null,
				2,
			),
		);
		return;
	}
	if (mode === "audit") {
		console.log(JSON.stringify(auditData(tasks), null, 2));
		return;
	}
	const out = options.get("out");
	if (!out) throw new Error("--out is required");
	if (mode === "resume") {
		const freeze = JSON.parse(readFileSync(resolve(out, "freeze.json"), "utf8")) as Freeze;
		const report = await resumeFrozen(freeze, out, { budgetPath: options.get("budget") });
		console.log(JSON.stringify({ out: resolve(out), overall: report.overall }, null, 2));
		return;
	}
	if (mode === "analyze") {
		const freeze = JSON.parse(readFileSync(resolve(out, "freeze.json"), "utf8")) as Freeze;
		const report = readReport(freeze, resolve(out));
		writeFileSync(resolve(out, "report.reanalyzed.json"), JSON.stringify(report, null, 2));
		console.log(JSON.stringify(report.overall, null, 2));
		return;
	}
	if (mode !== "offline")
		throw new Error(
			"Only audit/offline/resume/analyze are enabled; real models require separate approval and sandbox implementation",
		);
	const axis = options.get("axis") ?? "A";
	if (axis !== "A" && axis !== "B") throw new Error("axis must be A or B");
	const splits = (options.get("splits") ?? "development,selection").split(",") as Split[];
	if (splits.some((s) => !["development", "selection"].includes(s)))
		throw new Error("Only development,selection can enter offline runs");
	const freeze = makeFreeze(
		tasks,
		axis,
		splits,
		Number(options.get("repetitions") ?? 2),
		options.get("candidate"),
		options.has("limits")
			? parseBudgetLimits(JSON.parse(readFileSync(resolve(options.get("limits")!), "utf8")))
			: undefined,
	);
	const report = await runFrozen(freeze, out, { budgetPath: options.get("budget") });
	console.log(JSON.stringify({ out: resolve(out), overall: report.overall, paired: report.paired }, null, 2));
}
