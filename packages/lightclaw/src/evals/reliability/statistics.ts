import type { Attempt, Freeze, Job, Observation, Score } from "./types.js";
export function resolveTerminal(
	controller: Attempt["controller"],
	observation: Observation | null,
): Attempt["terminal"] {
	if (controller.timeout) return "external_timeout";
	if (controller.code !== 0 || controller.signal) return "worker_error";
	if (controller.recordError) return "worker_error";
	if (!observation) return "missing_record";
	if (observation.systemFailure || observation.productTimeout || observation.unresolved > 0 || !observation.consumed)
		return "task_failed";
	return "completed";
}
export function joinAttempts(
	freeze: Freeze,
	records: Attempt[],
	startedIds: ReadonlySet<string> = new Set(),
): Attempt[] {
	const known = new Map(freeze.jobs.map((j) => [j.id, j]));
	const byId = new Map<string, Attempt>();
	for (const row of records) {
		if (!known.has(row.job.id) || byId.has(row.job.id)) throw new Error("Unplanned or duplicate attempt");
		if (JSON.stringify(known.get(row.job.id)) !== JSON.stringify(row.job))
			throw new Error("Attempt differs from frozen plan");
		byId.set(row.job.id, {
			...row,
			terminal: row.controller.timeout
				? "external_timeout"
				: row.observation && !row.score
					? "worker_error"
					: resolveTerminal(row.controller, row.observation),
		});
	}
	return freeze.jobs.map(
		(job) =>
			byId.get(job.id) ?? {
				job,
				terminal: startedIds.has(job.id) ? "missing_record" : "not_started",
				controller: { code: null, signal: null, timeout: false, boots: 0 },
				observation: null,
				score: null,
				cost: null,
			},
	);
}
function rate(values: Array<boolean | null>) {
	const known = values.filter((v) => v !== null);
	const numerator = known.filter(Boolean).length;
	const n = values.length;
	return {
		numerator,
		denominator: n,
		known: known.length,
		unknown: n - known.length,
		value: n && n === known.length ? numerator / n : null,
		knownOnlyFraction: known.length ? numerator / known.length : null,
		lowerBound: n ? numerator / n : null,
		upperBound: n ? (numerator + n - known.length) / n : null,
	};
}
function resource(values: Array<number | null>) {
	const known = values.filter((v): v is number => v !== null);
	return {
		known: known.length,
		unknown: values.length - known.length,
		observedTotal: known.length ? known.reduce((a, b) => a + b, 0) : null,
		fullTotal: known.length === values.length ? known.reduce((a, b) => a + b, 0) : null,
		meanOfKnown: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null,
	};
}
export function summarize(rows: Attempt[]) {
	const started = rows.filter((r) => r.terminal !== "not_started");
	const score = (key: keyof Score) =>
		started
			.filter(
				(r) =>
					!["artifactCorrect", "businessValid", "falseRefusal", "artifactRightSystemFailure"].includes(key) ||
					r.job.artifactEligible,
			)
			.map((r) => r.score?.[key] ?? null);
	const status = Object.fromEntries(
		["completed", "task_failed", "external_timeout", "worker_error", "missing_record", "not_started"].map((s) => [
			s,
			rows.filter((r) => r.terminal === s).length,
		]),
	);
	const resourceKeys = ["input", "output", "cacheRead", "cacheWrite", "modelRequests"] as const;
	const usageResources = Object.fromEntries(
		resourceKeys.map((key) => [key, resource(started.map((r) => r.observation?.usage[key] ?? null))]),
	) as Record<(typeof resourceKeys)[number], ReturnType<typeof resource>>;
	return {
		planned: rows.length,
		started: started.length,
		records: started.filter((r) => r.observation).length,
		terminal: status,
		metrics: {
			artifactNotApplicable: started.filter((r) => !r.job.artifactEligible).length,
			artifactExact: rate(score("artifactCorrect")),
			inputPreserved: rate(score("inputPreserved")),
			businessValid: rate(score("businessValid")),
			handlingCorrect: rate(score("handlingCorrect")),
			systemCompletion: rate(started.map((r) => r.observation?.systemCompleted ?? null)),
			falseCompletionAmongKnownSystemClaims: rate(
				started.filter((r) => r.observation?.systemCompleted).map((r) => r.score?.falseCompletion ?? null),
			),
			modelFalseCompletion: rate(score("modelFalseCompletion")),
			falseRefusal: rate(score("falseRefusal")),
			artifactRightSystemFailure: rate(score("artifactRightSystemFailure")),
			humanRequired: rate(started.map((r) => r.observation?.humanRequired ?? null)),
			productTimeout: rate(started.map((r) => r.observation?.productTimeout ?? null)),
			taskLoss: rate(started.filter((r) => r.observation?.accepted).map((r) => r.observation?.taskLost ?? null)),
			duplicateEffects: resource(
				started.filter((r) => r.job.effectEligible).map((r) => r.observation?.duplicateEffects ?? null),
			),
			duplicateEffectsNotApplicable: started.filter((r) => !r.job.effectEligible).length,
			humanInterventions: resource(started.map((r) => r.observation?.humanInterventions ?? null)),
			toolErrors: resource(started.map((r) => r.observation?.toolErrors ?? null)),
			unknownEligibilityRecords: started.filter((r) => !r.observation).length,
		},
		resources: {
			...usageResources,
			durationMs: resource(started.map((r) => r.controller.elapsedMs ?? r.observation?.durationMs ?? null)),
		},
		cost: null,
		pricesKnown: false,
		usageSource: "synthetic-faux-estimate; not billed model tokens",
		evidence: "faux-wiring-only",
	};
}
function verified(row: Attempt): number {
	return Number(
		row.terminal === "completed" &&
			row.score?.inputPreserved === true &&
			row.score.checkerIntegrity &&
			row.score.handlingCorrect === true &&
			(!row.job.artifactEligible || row.observation?.systemCompleted === true) &&
			(row.score.artifactCorrect === null || row.score.artifactCorrect === true) &&
			(row.score.businessValid === null || row.score.businessValid),
	);
}
export function pairedTaskEffect(rows: Attempt[], left: Job["arm"], right: Job["arm"], draws = 2000) {
	const ids = [...new Set(rows.map((r) => r.job.caseId))].sort();
	const differences: number[] = [];
	for (const id of ids) {
		const a = rows.filter((r) => r.job.caseId === id && r.job.arm === left),
			b = rows.filter((r) => r.job.caseId === id && r.job.arm === right);
		if (
			!a.length ||
			a.length !== b.length ||
			a
				.map((r) => r.job.repetition)
				.sort()
				.join() !==
				b
					.map((r) => r.job.repetition)
					.sort()
					.join()
		)
			throw new Error("Unbalanced paired plan");
		differences.push(
			b.reduce((n, r) => n + verified(r), 0) / b.length - a.reduce((n, r) => n + verified(r), 0) / a.length,
		);
	}
	if (!differences.length) return null;
	let seed = 20261030;
	const random = () => {
		seed = (1664525 * seed + 1013904223) >>> 0;
		return seed / 2 ** 32;
	};
	const mean = (a: number[]) => a.reduce((n, x) => n + x, 0) / a.length;
	const boot = Array.from({ length: draws }, () =>
		mean(differences.map(() => differences[Math.floor(random() * differences.length)])),
	).sort((a, b) => a - b);
	return {
		unit: "distinct task, after averaging paired repetitions",
		tasks: ids.length,
		attempts: rows.length,
		endpoint:
			"observed verified workflow completion over all planned repetitions; missing/not-started are not verified, not zero cost",
		difference: mean(differences),
		taskBootstrap95: [boot[Math.floor(draws * 0.025)], boot[Math.floor(draws * 0.975)]],
		evidence: "faux wiring only; no semantic benefit inference",
	};
}
