"""Read-only reanalysis of frozen experiments; never changes tasks or scorers."""
import collections
import hashlib
import json
import pathlib
import random
import re
import statistics

OUT = pathlib.Path(__file__).resolve().parent
ROOT = OUT.parents[2]
EXP = ROOT / "docs/experiments"


def load(folder, filename):
    path = EXP / folder / "raw" / filename
    return [json.loads(line) for line in path.read_text().splitlines()]


def variation(values):
    return {"n": len(values), "values": values, "mean": statistics.mean(values),
            "sample_variance": statistics.variance(values) if len(values) > 1 else None,
            "sample_sd": statistics.stdev(values) if len(values) > 1 else None,
            "range": max(values) - min(values)}


ablation = load("2026-10-21-ablation", "prompt-formal-runs.jsonl")
paired = load("2026-10-21-fixes", "prompt-paired-runs.jsonl")
followup = load("2026-10-21-fixes", "prompt-followup-runs.jsonl")
groups = {
    "historical-original": [r for r in ablation if r["phase"] == "final" and "baseline" in r["label"]],
    "historical-candidate": [r for r in ablation if r["phase"] == "final" and "candidate" in r["label"]],
    "historical-before": [r for r in paired if "before" in r["label"]],
    "historical-fixed-v1": [r for r in paired if "fixed" in r["label"]],
    "historical-fixed-v2-targeted": [r for r in followup if "fixed" in r["label"]],
}


def metrics(runs):
    artifact_ok = lambda r: all(c["passed"] for c in r["result"]["checks"] if c["name"].startswith("file_"))
    return {"n": len(runs), "successes": sum(r["success"] for r in runs),
            "artifact_correct": sum(artifact_ok(r) for r in runs),
            "mean_model_requests": statistics.mean(r["requests"] for r in runs),
            "mean_tool_calls": statistics.mean(r["result"]["run"]["toolCalls"] for r in runs),
            "mean_tokens": statistics.mean(r["usage"]["totalTokens"] for r in runs),
            "mean_duration_ms": statistics.mean(r["result"]["run"]["durationMs"] for r in runs),
            "tool_errors": sum(r["result"]["run"]["toolErrors"] for r in runs),
            "timeouts": sum("duration budget" in str(r["result"]["run"]).lower() or "timed out" in str(r["result"]["run"]).lower() for r in runs),
            "cost": None, "cost_reason": "historical prices are zero placeholders, not billing evidence"}


# Same agent source and final task contracts; two time blocks remain separate.
old_source = EXP / "2026-10-21-ablation/source-snapshot/packages/lightclaw/src/agent.ts"
before_source = EXP / "2026-10-21-fixes/before/packages/lightclaw/src/agent.ts"
assert old_source.read_bytes() == before_source.read_bytes()
datasets = [json.loads((EXP / name / "prompt-dataset.json").read_text()) for name in ["2026-10-21-ablation", "2026-10-21-fixes"]]
assert [r for r in datasets[0] if r["split"] == "final"] == [r for r in datasets[1] if r["split"] == "final"]
noise_runs = groups["historical-original"] + groups["historical-before"]
blocks = collections.defaultdict(list)
for cohort in ["historical-original", "historical-before"]:
    for r in groups[cohort]:
        blocks[(cohort, r["label"])].append(r)
assert len(blocks) == 6 and all(len(block) == 12 for block in blocks.values())
noise = {key: variation([getter(rows) for rows in blocks.values()]) for key, getter in {
    "strict_success_rate": lambda rows: sum(r["success"] for r in rows) / len(rows),
    "tokens_per_task": lambda rows: statistics.mean(r["usage"]["totalTokens"] for r in rows),
    "duration_ms_per_task": lambda rows: statistics.mean(r["result"]["run"]["durationMs"] for r in rows),
    "requests_per_task": lambda rows: statistics.mean(r["requests"] for r in rows),
}.items()}


def classify(run):
    if run["success"]:
        return "success", []
    failed = [c["name"] for c in run["result"]["checks"] if not c["passed"]]
    errors = [entry["message"] for entry in run["session"] if entry.get("type") == "message" and entry["message"].get("role") == "toolResult" and entry["message"].get("isError")]
    excerpts = ["\n".join(block.get("text", "") for block in msg["content"]) for msg in errors]
    if run["caseId"] == "select-space-path" and any(name.startswith("file_strict:") for name in failed):
        return "checker_contract_ambiguity", excerpts
    if any("sh: file: not found" in text for text in excerpts):
        return "sandbox_tool_missing_file_command", excerpts
    if any("can't cd to /Users/" in text for text in excerpts):
        return "prompt_host_container_path_conflict", excerpts
    if errors:
        return "other_tool_error", excerpts
    if any(name.startswith("file_strict:") for name in failed):
        return "artifact_answer_wrong_or_contract_unknown", excerpts
    return "unknown", excerpts


annotations = []
taxonomy = {}
for cohort, runs in [("ablation-all", ablation), ("paired-all", paired), ("followup-all", followup)]:
    counts = collections.Counter()
    for r in runs:
        category, excerpts = classify(r)
        counts[category] += 1
        if category != "success":
            annotations.append({"cohort": cohort, "runIndex": r["runIndex"], "caseId": r["caseId"],
                                "label": r["label"], "category": category, "excerpts": excerpts,
                                "checks": r["result"]["checks"]})
    taxonomy[cohort] = dict(counts)
(OUT / "failure-annotations.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in annotations))

# Cluster by task, preserving within-task repeated observations.
def paired_interval(left, right, getter, relative=False):
    ids = sorted({r["caseId"] for r in left})
    assert set(ids) == {r["caseId"] for r in right}
    before = {i: statistics.mean(getter(r) for r in left if r["caseId"] == i) for i in ids}
    after = {i: statistics.mean(getter(r) for r in right if r["caseId"] == i) for i in ids}
    def effect(sample):
        a, b = statistics.mean(before[i] for i in sample), statistics.mean(after[i] for i in sample)
        return (b / a - 1) if relative else b - a
    rng = random.Random(20261021)
    draws = sorted(effect(rng.choices(ids, k=len(ids))) for _ in range(10000))
    return {"effect": effect(ids), "task_cluster_bootstrap_95": [draws[249], draws[9749]], "task_clusters": len(ids)}


effects = {}
for name, before, after in [("candidate", groups["historical-original"], groups["historical-candidate"]),
                            ("fixed-v1", groups["historical-before"], groups["historical-fixed-v1"])]:
    effects[name] = {
        "success_rate_difference": paired_interval(before, after, lambda r: int(r["success"])),
        "relative_token_change": paired_interval(before, after, lambda r: r["usage"]["totalTokens"], True),
    }

hash_check = {}
for folder in ["2026-10-21-ablation", "2026-10-21-diagnosis", "2026-10-21-fixes"]:
    manifest = json.loads((EXP / folder / "artifact-hashes.json").read_text())
    mismatches = [path for path, sha in manifest.items() if not (EXP / folder / path).exists() or hashlib.sha256((EXP / folder / path).read_bytes()).hexdigest() != sha]
    hash_check[folder] = {"files": len(manifest), "mismatches": mismatches}

# Request-byte decomposition is exact; section token allocation is unavailable.
composition = []
for folder, filename in [("2026-10-21-ablation", "prompt-formal-requests.json"), ("2026-10-21-fixes", "prompt-paired-requests.json")]:
    requests = json.loads((EXP / folder / "raw" / filename).read_text())
    for q in requests:
        if q["label"].get("phase") != "final":
            continue
        payload = q["payload"]
        system = "\n".join(m.get("content", "") for m in payload["messages"] if m["role"] in ["system", "developer"])
        parts = re.split(r"(?=^## )", system, flags=re.MULTILINE)
        sections = [{"name": part.splitlines()[0][:100], "characters": len(part), "utf8_bytes": len(part.encode()), "tokens": None} for part in parts if part]
        composition.append({"cohort": folder, **q["label"], "requestIndex": q["index"],
                            "system_characters": len(system), "system_utf8_bytes": len(system.encode()),
                            "message_count": len(payload["messages"]), "message_characters": len(json.dumps(payload["messages"], ensure_ascii=False)),
                            "tool_schema_characters": len(json.dumps(payload.get("tools", []), ensure_ascii=False)),
                            "sections": sections, "section_token_method": "unavailable; provider usage does not split sections"})
(OUT / "prompt-composition.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in composition))

result = {"historical_artifact_hashes": hash_check, "groups": {k: metrics(v) for k, v in groups.items()},
          "baseline_noise_six_time_block_repetitions": noise,
          "within_cohort_noise": {cohort: {key: variation([getter(rows) for (block_cohort, _), rows in blocks.items() if block_cohort == cohort]) for key, getter in {
              "success_rate": lambda rows: sum(r["success"] for r in rows) / len(rows),
              "tokens_per_task": lambda rows: statistics.mean(r["usage"]["totalTokens"] for r in rows),
          }.items()} for cohort in ["historical-original", "historical-before"]},
          "noise_caveat": "same agent source and final tasks, but different Node runtimes and 2 time blocks; six pooled observations are exploratory, NOT five repetitions of one fully fixed configuration; each valid historical cohort has only three repetitions",
          "taxonomy": taxonomy, "effects": effects, "prompt_requests_decomposed": len(composition),
          "current_product_real_model_runs": 0, "upstream_mom_real_model_runs": 0}
(OUT / "summary.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
print(json.dumps(result, indent=2, ensure_ascii=False))
