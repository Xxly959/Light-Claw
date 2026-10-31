import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readReport, runFrozen } from "./controller.js";
import { auditData, loadTasks } from "./data.js";
import { makeFreeze } from "./protocol.js";
import type { Freeze, Split } from "./types.js";
export async function reliabilityCli(args: string[]): Promise<void> {
	const allowed = ["suite", "mode", "out", "axis", "splits", "repetitions", "candidate"];
	const options = new Map(
		args.map((arg) => {
			const match = /^--([a-z]+)=(.+)$/.exec(arg);
			if (!match || !allowed.includes(match[1])) throw new Error(`Unsupported offline argument: ${arg}`);
			return [match[1], match[2]];
		}),
	);
	const tasks = loadTasks(),
		mode = options.get("mode") ?? "audit";
	if (mode === "audit") {
		console.log(JSON.stringify(auditData(tasks), null, 2));
		return;
	}
	const out = options.get("out");
	if (!out) throw new Error("--out is required");
	if (mode === "analyze") {
		const freeze = JSON.parse(readFileSync(resolve(out, "freeze.json"), "utf8")) as Freeze;
		const report = readReport(freeze, resolve(out));
		writeFileSync(resolve(out, "report.reanalyzed.json"), JSON.stringify(report, null, 2));
		console.log(JSON.stringify(report.overall, null, 2));
		return;
	}
	if (mode !== "offline")
		throw new Error(
			"Only audit/offline/analyze are enabled; real models require separate approval and sandbox implementation",
		);
	const axis = options.get("axis") ?? "A";
	if (axis !== "A" && axis !== "B") throw new Error("axis must be A or B");
	const splits = (options.get("splits") ?? "development,selection").split(",") as Split[];
	if (splits.some((s) => !["development", "selection"].includes(s)))
		throw new Error("Only development,selection can enter offline runs");
	const freeze = makeFreeze(tasks, axis, splits, Number(options.get("repetitions") ?? 2), options.get("candidate"));
	const report = await runFrozen(freeze, out);
	console.log(JSON.stringify({ out: resolve(out), overall: report.overall, paired: report.paired }, null, 2));
}
