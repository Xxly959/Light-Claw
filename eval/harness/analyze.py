"""Summarize memory evaluation checkpoints and test the frozen C6 criteria."""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from math import comb, isfinite
from pathlib import Path
import random
from statistics import mean, median

try:
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from matplotlib.figure import Figure
except ImportError:
    Figure = None


EVAL = Path(__file__).resolve().parents[1]
LIVE_ROUTES = {"configured", "deepseek"}
SIZES = (12, 32, 64, 128)
ITEMS_PER_CATEGORY = {
    "index_hit": 4, "note_needed": 4, "multi_hop": 3, "abstain": 3,
    "update": 4, "position": 3, "irrelevant": 3, "implicit_rule": 5,
}
CONTRASTS = (("S1", "S0"), ("S2", "S1"), ("S2", "S0"))
TOKEN_FIELDS = ("input", "cacheRead", "cacheWrite", "output")


def quantile(sorted_values, fraction):
    position = (len(sorted_values) - 1) * fraction
    lower = int(position)
    return sorted_values[lower] + (sorted_values[min(lower + 1, len(sorted_values) - 1)] - sorted_values[lower]) * (position - lower)


def bootstrap(item_deltas, repeats, seed, alpha):
    """Resample question-level deltas with all observations kept in their question."""
    n = len(item_deltas)
    if not n:
        return {"n_items": 0, "delta": None, "ci": None}
    rng = random.Random(seed)
    draws = sorted(sum(rng.choices(item_deltas, k=n)) / n for _ in range(repeats))
    return {"n_items": n, "delta": mean(item_deltas), "ci": [quantile(draws, alpha / 2), quantile(draws, 1 - alpha / 2)]}


def mcnemar(item_pairs):
    """Two-sided exact binomial McNemar after a strict majority per item and arm."""
    candidate_only = reference_only = 0
    for candidate, reference in item_pairs:
        candidate_pass = sum(candidate) * 2 > len(candidate)
        reference_pass = sum(reference) * 2 > len(reference)
        candidate_only += candidate_pass and not reference_pass
        reference_only += reference_pass and not candidate_pass
    discordant = candidate_only + reference_only
    lower = min(candidate_only, reference_only)
    probability = min(1.0, 2 * sum(comb(discordant, i) for i in range(lower + 1)) / (2**discordant))
    return {"candidate_only": candidate_only, "reference_only": reference_only, "p_exact": probability}


def holm(tests):
    adjusted = 0.0
    for rank, test in enumerate(sorted(tests, key=lambda value: value["p_exact"])):
        adjusted = min(1.0, max(adjusted, (len(tests) - rank) * test["p_exact"]))
        test["p_holm"] = adjusted


def observed_number(value):
    return type(value) in (int, float) and isfinite(value) and value >= 0


def summarize(rows):
    arm = rows[0]["arm"]
    traces = [row.get("trace", {}) for row in rows]
    cost = [row["cost_cny_peak_reference"] for row in rows if observed_number(row.get("cost_cny_peak_reference"))]
    latency = sorted(trace["latencyMs"] for trace in traces if observed_number(trace.get("latencyMs")))
    tool_counts = [len(trace["tools"]) for trace in traces if isinstance(trace.get("tools"), list)]
    read_counts = [sum(tool.get("name") == "read" for tool in trace["tools"])
                   for trace in traces if isinstance(trace.get("tools"), list)]
    rounds = [trace["rounds"] for trace in traces if observed_number(trace.get("rounds"))]
    memory_tokens = [part["estimatedTokens"] for trace in traces for part in trace.get("systemPrompt", {}).get("parts", [])
                     if part.get("name") == "current_memory" and observed_number(part.get("estimatedTokens"))]
    result = {
        "n_runs": len(rows), "n_items": len({row["case_id"] for row in rows}),
        "passes": sum(row["passed"] for row in rows), "accuracy": mean(row["passed"] for row in rows),
        "cost_known": len(cost), "cost_unknown": len(rows) - len(cost), "cost_median_cny_peak_reference": median(cost) if cost else None,
        "latency_known": len(latency), "latency_ms_p50": quantile(latency, 0.5) if latency else None,
        "latency_ms_p95": quantile(latency, 0.95) if latency else None,
        "tool_calls_median": median(tool_counts) if tool_counts else None,
        "read_calls": {"known": len(read_counts), "total": sum(read_counts), "zero": read_counts.count(0)},
        "model_rounds_median": median(rounds) if rounds else None,
        "memory_tokens_estimated": {"known": len(memory_tokens), "median": median(memory_tokens) if memory_tokens else None},
        "stop_reasons": dict(Counter(trace.get("stopReason", "missing") for trace in traces)),
        "tokens": {},
    }
    for field in TOKEN_FIELDS:
        values = []
        for trace in traces:
            attempts = trace.get("attempts", [])
            if attempts and not trace.get("usageIncomplete") and all(observed_number(attempt.get(field)) for attempt in attempts):
                values.append(sum(attempt[field] for attempt in attempts))
        result["tokens"][field] = {"known": len(values), "median": median(values) if values else None,
                                   "total": sum(values) if values else None}
    input_fields = [result["tokens"][field] for field in TOKEN_FIELDS[:-1]]
    have_cache = len(cost) == len(rows) and all(field["known"] == len(rows) for field in input_fields)
    input_total = sum(field["total"] for field in input_fields) if have_cache else 0
    result["input_cache_read_share"] = result["tokens"]["cacheRead"]["total"] / input_total if input_total else None
    for field in ("read_precision", "read_recall"):
        values = [row[field] for row in rows if arm in {"S1", "S2"} and observed_number(row.get(field))]
        result[field] = {"known": len(values), "mean": mean(values) if values else None}
    for field, category in (("stale_hit", "update"), ("abstain_rejected", "abstain")):
        values = [row[field] for row in rows if row["category"] == category and isinstance(row.get(field), bool)]
        result[field] = {"known": len(values), "count": sum(values), "rate": mean(values) if values else None}
    return result


def stratum_keys(row):
    size, category = row["size_kib"], row["category"]
    yield "overall", None
    yield "size", size
    yield "category", category
    yield "size_category", (size, category)
    meta = row.get("meta", {})
    if isinstance(meta.get("s1_index_cut"), bool):
        yield "s1_index_cut", meta["s1_index_cut"]
    if category == "implicit_rule" and isinstance(meta.get("placement"), str):
        yield "implicit_placement", meta["placement"]


def arm_metrics(rows):
    strata = defaultdict(list)
    for row in rows:
        for scope, value in stratum_keys(row):
            strata[row["arm"], scope, value].append(row)
    return [dict(arm=arm, scope=scope, value=value, **summarize(group))
            for (arm, scope, value), group in sorted(strata.items())]


def coverage(rows, conflicts, protocol, phase):
    stage = protocol["phases"].get(phase.split("-ablate-", 1)[0], {})
    expected_items = stage.get("items") or sum(ITEMS_PER_CATEGORY.values()) * len(SIZES)
    expected_repeats = stage.get("repeats")
    expected = expected_items * expected_repeats if expected_repeats else None
    expected_arms = protocol["arm_order"] if "-ablate-" not in phase else ["S2"]
    by_arm = {arm: defaultdict(set) for arm in expected_arms}
    cases = defaultdict(set)
    features = defaultdict(set)
    providers = set()
    for row in rows:
        arm, case = row["arm"], row["case_id"]
        by_arm.setdefault(arm, defaultdict(set))[case].add(row["repeat"])
        cases[case].add(tuple(stratum_keys(row)))
        features[arm].add(tuple(sorted(row["features"])))
        provider = row.get("trace", {}).get("model", {}).get("provider")
        if provider:
            providers.add(provider)

    arm_counts = {}
    repeat_ids = set(range(expected_repeats or 0))
    for arm, items in by_arm.items():
        observed_runs = sum(len(repeats) for repeats in items.values())
        arm_counts[arm] = {
            "observed_items": len(items), "observed_runs": observed_runs,
            "items_with_all_repeats": sum(repeats == repeat_ids for repeats in items.values()),
            "expected_items": expected_items, "expected_runs": expected,
            "missing_run_count_lower_bound": max(0, expected - observed_runs) if expected is not None else None,
        }

    complete = False
    issues = []
    if phase in {"pilot", "formal"}:
        if conflicts:
            issues.append("conflicting_duplicate_units")
        if set(by_arm) != set(expected_arms) or any(
            set(items) != set(cases) or len(items) != expected_items or any(repeats != repeat_ids for repeats in items.values())
            for items in by_arm.values()
        ):
            issues.append("arm_item_repeat_coverage")
        if len(providers) > 1 or any(len(variants) > 1 for variants in features.values()):
            issues.append("mixed_provider_or_features")
        if any(len(strata) != 1 for strata in cases.values()):
            issues.append("inconsistent_item_labels")
        else:
            distribution = Counter(dict(next(iter(strata)))["size_category"] for strata in cases.values())
            expected_distribution = {(size, category): count for size in SIZES for category, count in ITEMS_PER_CATEGORY.items()}
            if distribution != expected_distribution:
                issues.append("unexpected_size_category_distribution")
        complete = not issues
    return {"complete": phase == "formal" and complete, "pilot_complete": phase == "pilot" and complete,
            "expected_repeats": expected_repeats, "arms": arm_counts,
            "conflicting_units": conflicts, "reported_providers": sorted(providers), "issues": issues}


def compare(rows, protocol, *, include_mcnemar=True):
    by_arm = defaultdict(lambda: defaultdict(dict))
    strata = defaultdict(list)
    targets = set(protocol["success"]["s2_target_categories"])
    for row in rows:
        by_arm[row["arm"]][row["case_id"]][row["repeat"]] = row["passed"]
        if row["arm"] == "S0" and row["repeat"] == 0:
            for stratum in stratum_keys(row):
                strata[stratum].append(row["case_id"])
            if row["category"] in targets:
                strata["target_categories", None].append(row["case_id"])

    results = []
    tests = []
    for candidate, reference in CONTRASTS:
        comparison = {"candidate": candidate, "reference": reference, "strata": []}
        for (scope, value), items in sorted(strata.items()):
            pairs = [(list(by_arm[candidate][case].values()), list(by_arm[reference][case].values())) for case in sorted(items)]
            deltas = [mean(a) - mean(b) for a, b in pairs]
            result = dict(scope=scope, value=value, **bootstrap(
                deltas, protocol["bootstrap_repeats"], protocol["bootstrap_seed"], protocol["success"]["alpha"],
            ))
            if include_mcnemar and scope == "category":
                result["mcnemar"] = mcnemar(pairs)
                tests.append(result["mcnemar"])
            comparison["strata"].append(result)
        results.append(comparison)
    holm(tests)
    return results


def evaluate_c6(metrics, comparisons, thresholds):
    metric = {(row["arm"], row["scope"], row["value"]): row for row in metrics if row["scope"] in {"overall", "size"}}
    estimates = {(pair["candidate"], pair["reference"], row["scope"], row["value"]): row["ci"]
                 for pair in comparisons for row in pair["strata"] if row["scope"] != "size_category"}
    margin = thresholds["accuracy_margin"]
    checks = []

    def check(candidate, reference, scope, value, metric_name, observed, threshold, passed):
        checks.append({"candidate": candidate, "reference": reference, "scope": scope, "value": value,
                       "metric": metric_name, "observed": observed, "threshold": threshold, "passed": passed})

    def noninferiority(candidate, reference, scope, value):
        ci = estimates.get((candidate, reference, scope, value))
        check(candidate, reference, scope, value, "ci_lower_strictly_greater_than", ci, margin, ci[0] > margin if ci else None)

    def cost_ratio(candidate, reference, scope, value, threshold):
        a, b = metric[candidate, scope, value], metric[reference, scope, value]
        a_cost, b_cost = a["cost_median_cny_peak_reference"], b["cost_median_cny_peak_reference"]
        known = a["cost_unknown"] == b["cost_unknown"] == 0 and b_cost is not None and b_cost > 0
        check(candidate, reference, scope, value, "median_cost_ratio_at_most", a_cost / b_cost if known else None,
              threshold, a_cost <= threshold * b_cost if known else None)

    large = [size for size in SIZES if size >= thresholds["large_min_kib"]]
    for candidate in ("S1", "S2"):
        for size in large:
            noninferiority(candidate, "S0", "size", size)
            cost_ratio(candidate, "S0", "size", size, thresholds["against_s0_cost_ratio"])
        for size in thresholds["small_sizes_require_ci_includes_zero"]:
            ci = estimates.get((candidate, "S0", "size", size))
            check(candidate, "S0", "size", size, "ci_includes_zero", ci, 0, ci[0] <= 0 <= ci[1] if ci else None)

    overall = estimates.get(("S2", "S1", "overall", None))
    targeted = estimates.get(("S2", "S1", "target_categories", None))
    bound = thresholds["s2_superiority_lower_bound"]
    observed = {"overall": overall, "pooled_target_categories": targeted}
    check("S2", "S1", "overall_or_target_categories", None, "ci_lower_strictly_greater_than", observed, bound,
          any(ci[0] > bound for ci in (overall, targeted) if ci) if overall and targeted else None)
    rest = sorted(ITEMS_PER_CATEGORY.keys() - set(thresholds["s2_target_categories"]))
    for category in rest:
        noninferiority("S2", "S1", "category", category)
    cost_ratio("S2", "S1", "overall", None, thresholds["s2_against_s1_cost_ratio"])

    def status(outcomes):
        if False in outcomes:
            return "failed"
        return "not_proven" if None in outcomes else "passed"

    verdicts = {f"{a}_vs_{b}": status([item["passed"] for item in checks if (item["candidate"], item["reference"]) == (a, b)])
                for a, b in CONTRASTS}
    return {"status": status([item["passed"] for item in checks]), "comparisons": verdicts, "checks": checks}


def analyze(rows, protocol, protocol_sha):
    totals = Counter({key: 0 for key in ("total", "faux", "diagnostic_live", "formal_live", "other_route", "protocol_mismatch", "duplicate_rows")})
    cohorts = defaultdict(dict)
    conflicts = defaultdict(set)
    for row in rows:
        if row.get("event") in {"reserve", "settle"} and "budget_charge_cny" in row:
            continue
        totals["total"] += 1
        if row.get("route") == "faux" or row.get("model") == "faux":
            totals["faux"] += 1
            continue
        if row.get("route") not in LIVE_ROUTES:
            totals["other_route"] += 1
            continue
        if row.get("protocol_sha") != protocol_sha:
            totals["protocol_mismatch"] += 1
            continue
        if not isinstance(row.get("passed"), bool):
            raise ValueError("Live row requires a boolean passed field")
        phase = row["phase"]
        totals["formal_live" if phase == "formal" else "diagnostic_live"] += 1
        cohort = (phase, row["model_slot"], row["model"], row["route"], row["runtime_sha"],
                  row.get("route_id", row["route"]))
        unit = (row["arm"], row["case_id"], row["repeat"])
        if unit in cohorts[cohort]:
            totals["duplicate_rows"] += 1
            if cohorts[cohort][unit] != row:
                conflicts[cohort].add(unit)
        else:
            cohorts[cohort][unit] = row

    results = []
    for key, units in sorted(cohorts.items()):
        phase, slot, model, route, runtime_sha, route_id = key
        eligible = [row for unit, row in units.items() if unit not in conflicts[key]]
        observed = coverage(eligible, len(conflicts[key]), protocol, phase)
        metrics = arm_metrics(eligible)
        contrasts = compare(eligible, protocol) if observed["complete"] else []
        pilot_contrasts = compare(eligible, protocol, include_mcnemar=False) if observed["pilot_complete"] else []
        verdict = evaluate_c6(metrics, contrasts, protocol["success"]) if observed["complete"] else {
            "status": "not_proven", "reason": "Incomplete formal matrix" if phase == "formal" else "Diagnostic phase", "checks": [],
        }
        results.append({"phase": phase, "model_slot": slot, "model": model, "route": route, "runtime_sha": runtime_sha,
                        "route_id": route_id,
                        "coverage": observed, "metrics": metrics, "comparisons": contrasts,
                        "pilot_comparisons": pilot_contrasts, "c6": verdict})
    return {
        "schema_version": 1, "protocol_sha": protocol_sha,
        "methods": {"bootstrap": "Paired differences of per-case pass rates, resampling case IDs",
                    "pilot": "Two-repeat paired development estimates, excluded from C6 and shown in labeled pilot figures",
                    "bootstrap_repeats": protocol["bootstrap_repeats"], "bootstrap_seed": protocol["bootstrap_seed"],
                    "confidence": 1 - protocol["success"]["alpha"],
                    "mcnemar": "Two-sided exact test on one majority (at least 3/5) decision per case and arm",
                    "holm_family": "All contrast-by-category McNemar tests within one complete model cohort",
                    "cost": "Median measured CNY at the recorded reference rates, excluding planning reserves"},
        "coverage": dict(totals), "cohorts": results,
        "c6": {"status": "per_model" if any(result["coverage"]["complete"] for result in results) else "not_proven",
               "reason": "See each complete model cohort" if any(result["coverage"]["complete"] for result in results) else "No complete eligible live formal matrix"},
    }


def figure_axes(title, xlabel, ylabel):
    figure = Figure(figsize=(8, 5), layout="constrained")
    FigureCanvasAgg(figure)
    axes = figure.subplots()
    axes.set(title=title, xlabel=xlabel, ylabel=ylabel)
    return figure, axes


def model_figures(cohort, directory):
    label = f"{cohort['model_slot']} {cohort['model']} ({cohort['route']})"
    identifier = hashlib.sha256((label + "/" + cohort["runtime_sha"] + "/" + cohort.get("route_id", "")).encode()).hexdigest()[:12]
    if cohort["phase"] == "pilot":
        label += " | Development pilot"
        identifier = f"pilot-{identifier}"
    arms = list(cohort["coverage"]["arms"])
    sizes = {arm: sorted((row for row in cohort["metrics"] if row["arm"] == arm and row["scope"] == "size"), key=lambda row: row["value"])
             for arm in arms}
    written = []

    def save(figure, name):
        path = directory / f"{identifier}-{name}.png"
        figure.savefig(path, dpi=150)
        written.append(path.name)

    for field, name, ylabel in (
        ("accuracy", "accuracy-by-size", "Pass rate"),
        ("cost_median_cny_peak_reference", "cost-by-size", "Median measured cost (CNY)"),
        ("latency_ms_p50", "latency-p50-by-size", "Observed p50 latency (ms)"),
        ("latency_ms_p95", "latency-p95-by-size", "Observed p95 latency (ms)"),
    ):
        series = {arm: [None if field == "cost_median_cny_peak_reference" and row["cost_unknown"] else row[field]
                        for row in rows] for arm, rows in sizes.items()}
        if not any(value is not None for values in series.values() for value in values):
            continue
        figure, axes = figure_axes(f"{ylabel} by fixture size | {label}", "Fixture size (KiB)", ylabel)
        for arm, rows in sizes.items():
            axes.plot([row["value"] for row in rows], series[arm], marker="o", label=arm)
        axes.set_xticks(SIZES)
        axes.grid(alpha=0.2)
        axes.legend(ncols=3)
        save(figure, name)

    points = [row for row in cohort["metrics"] if row["scope"] == "overall" and row["cost_unknown"] == 0]
    if len(points) >= 2:
        cost_key = "cost_median_cny_peak_reference"
        frontier = [p for p in points if not any(
            other[cost_key] <= p[cost_key] and other["accuracy"] >= p["accuracy"] and
            (other[cost_key] < p[cost_key] or other["accuracy"] > p["accuracy"])
            for other in points
        )]
        figure, axes = figure_axes(f"Accuracy and cost | {label}", "Median measured cost (CNY)", "Pass rate")
        coords = sorted({(p[cost_key], p["accuracy"]) for p in frontier})
        axes.plot(*zip(*coords), color="#16705f", marker="o", label="Non-dominated")
        for p in points:
            axes.scatter(p[cost_key], p["accuracy"], color="#293b65", s=20)
            axes.annotate(p["arm"], (p[cost_key], p["accuracy"]), xytext=(4, 4), textcoords="offset points")
        axes.legend()
        save(figure, "cost-accuracy-pareto")

    cells = {(row["arm"], row["value"]): row["accuracy"] for row in cohort["metrics"] if row["scope"] == "category"}
    categories = sorted({category for _, category in cells})
    figure, axes = figure_axes(f"Pass rate by question category | {label}", "Question category", "Arm")
    image = axes.imshow([[cells[arm, category] for category in categories] for arm in arms], aspect="auto", vmin=0, vmax=1, cmap="viridis")
    axes.set_xticks(range(len(categories)), categories, rotation=35, ha="right")
    axes.set_yticks(range(len(arms)), arms)
    figure.colorbar(image, ax=axes, label="Pass rate")
    save(figure, "category-heatmap")
    return {"phase": cohort["phase"], "model_slot": cohort["model_slot"], "model": cohort["model"], "route": cohort["route"],
            "runtime_sha": cohort["runtime_sha"], "files": written}


def write_figures(report, directory):
    directory.mkdir(parents=True, exist_ok=True)
    formal = [cohort for cohort in report["cohorts"] if cohort["coverage"]["complete"]]
    pilot = [cohort for cohort in report["cohorts"] if cohort["coverage"]["pilot_complete"]]
    eligible = formal + pilot
    if eligible and Figure is not None:
        manifest = {"status": "written" if formal else "diagnostic_only",
                    "cohorts": [model_figures(cohort, directory) for cohort in eligible]}
    else:
        reason = "No complete eligible live matrix" if not eligible else "Matplotlib is required for figures"
        manifest = {"status": "skipped", "reason": reason, "cohorts": []}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def read_rows(paths):
    for path in paths:
        with path.open(encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, 1):
                if line.strip():
                    try:
                        yield json.loads(line)
                    except ValueError as error:
                        raise ValueError(f"Invalid JSONL at {path}:{line_number}") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", nargs="*", type=Path, help="Defaults to eval/results/*.jsonl")
    parser.add_argument("--protocol", type=Path, default=EVAL / "protocol.json")
    parser.add_argument("--output", type=Path, default=EVAL / "results" / "analysis.json")
    parser.add_argument("--figures", type=Path, help="Write PNGs and a figure manifest when eligible data exists")
    args = parser.parse_args()
    sources = (sorted(path for path in (EVAL / "results").glob("*.jsonl") if not path.name.endswith(".private.jsonl"))
               if args.results is None else args.results)
    protocol_bytes = args.protocol.read_bytes()
    report = analyze(read_rows(sources), json.loads(protocol_bytes), hashlib.sha256(protocol_bytes).hexdigest())
    if args.figures:
        report["figures"] = write_figures(report, args.figures)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    print(f"{args.output} | C6 {report['c6']['status']} | {len(report['cohorts'])} live cohorts")


if __name__ == "__main__":
    main()
