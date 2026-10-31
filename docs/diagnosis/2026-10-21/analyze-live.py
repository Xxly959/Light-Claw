import collections
import hashlib
import json
import math
import pathlib
import random
import re
import statistics

OUT = pathlib.Path(__file__).resolve().parent
LIVE = OUT / "live"
ROOT = OUT.parents[2]
rows = [json.loads(path.read_text()) for path in sorted((LIVE / "raw").glob("*/run.json"))]
formal = [r for r in rows if not r["id"].startswith("pilot")]
row_by_id = {r["id"]: r for r in rows}
job_by_id = {}
exit_by_id = {}
phase_by_id = {}
for freeze_path in sorted(LIVE.glob("*-freeze.json")):
    phase_name = freeze_path.name.removesuffix("-freeze.json")
    frozen = json.loads(freeze_path.read_text())
    for job in frozen["jobs"]:
        job_by_id[job["id"]] = job
        phase_by_id[job["id"]] = phase_name
    completed = LIVE / f"{phase_name}-complete.json"
    if completed.exists():
        for outcome in json.loads(completed.read_text())["results"]:
            exit_by_id[outcome["id"]] = outcome
# Include every attempted outcome, including killed workers without run.json.
formal_ids = sorted(i for i in exit_by_id if not i.startswith("pilot"))
formal_jobs = [job_by_id[i] for i in formal_ids]
formal = [r for r in formal if r["id"] in exit_by_id]

expected_scorer = hashlib.sha256((ROOT / "packages/lightclaw/src/evals/scoring.ts").read_bytes()).hexdigest()


def stats(values):
    return {"values": values, "mean": statistics.mean(values), "sample_variance": statistics.variance(values) if len(values) > 1 else None,
            "sample_sd": statistics.stdev(values) if len(values) > 1 else None, "range": max(values) - min(values)}


def artifact_ok(r):
    return all(check["passed"] for check in r["result"]["checks"] if check["name"].startswith("file_"))


def wilson(k, n):
    if not n:
        return None
    z = 1.96
    center = (k / n + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt((k / n) * (1 - k / n) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return [center - half, center + half]


def metrics(jobs):
    known = [row_by_id[j["id"]] for j in jobs if j["id"] in row_by_id]
    n = len(jobs)
    successes = sum(r["success"] and exit_by_id[r["id"]]["code"] == 0 for r in known)
    def mean(getter):
        return statistics.mean(getter(r) for r in known) if known else None
    return {"n": n, "records": len(known), "successes": successes, "success_wilson_95_descriptive": wilson(successes, n),
            "artifacts_correct": sum(artifact_ok(r) for r in known), "artifacts_unknown": n - len(known),
            "mean_cycles": mean(lambda r: r["cycles"]),
            "mean_model_requests": mean(lambda r: r["modelRequests"]),
            "mean_tokens": mean(lambda r: r["usage"]["totalTokens"]),
            "mean_duration_ms": mean(lambda r: r["result"]["run"]["durationMs"]),
            "means_denominator": len(known), "resource_means_exclude_missing_records": True,
            "tool_errors": sum(r["result"]["run"]["toolErrors"] for r in known),
            "external_timeouts": sum(exit_by_id[j["id"]].get("timeout", False) for j in jobs),
            "nonzero_exits": sum(exit_by_id[j["id"]]["code"] != 0 for j in jobs),
            "external_cycle_limit": sum(r["externalCycleLimit"] for r in known),
            "cost": None, "prices_known": False}


def tool_errors(r):
    return ["\n".join(block.get("text", "") for block in entry["message"]["content"])
            for entry in r["session"] if entry.get("type") == "message" and entry["message"].get("role") == "toolResult" and entry["message"].get("isError")]


def category(r):
    outcome = exit_by_id.get(r["id"], {})
    if outcome.get("timeout"):
        return "external_experiment_timeout"
    if outcome.get("code", 0) != 0:
        return "external_worker_error"
    if r["success"]:
        return "success"
    if r["result"]["run"]["stopReason"] == "toolUse" and (r.get("goal") or {}).get("status") in ["completed", "awaiting_confirmation"]:
        return "terminal_goal_run_and_delivery_contract"
    if r["externalCycleLimit"]:
        return "external_experiment_cycle_limit"
    if any(cycle.get("budgetReason") for cycle in r["cycleResults"]):
        return "product_run_budget"
    errors = tool_errors(r)
    if any("file: not found" in text for text in errors):
        return "sandbox_tool_missing_file"
    if any("can't cd" in text or "No such file or directory" in text for text in errors):
        return "path_or_missing_file_tool_error"
    if errors:
        return "other_tool_error"
    if not artifact_ok(r):
        return "artifact_wrong"
    return "unknown"


groups = {arm: [r for r in formal if r["arm"] == arm] for arm in sorted({r["arm"] for r in formal})}
job_groups = {arm: [j for j in formal_jobs if j["arm"] == arm] for arm in sorted({j["arm"] for j in formal_jobs})}
summary = {name: metrics(group) for name, group in job_groups.items()}
phase_groups = {}
for phase in sorted(set(phase_by_id[i] for i in formal_ids)):
    js = [j for j in formal_jobs if phase_by_id[j["id"]] == phase]
    phase_groups[phase] = {arm: metrics([j for j in js if j["arm"] == arm]) for arm in sorted({j["arm"] for j in js})}
# Balanced three repeats per condition. Reuse predeclared all-off and all-on runs.
ablation = {}
for arm in ["all-off"] + ["only-" + n for n in ["goals", "acceptance", "feishu", "controls", "scheduling", "optimization", "infrastructure"]] + ["all-on"] + ["without-" + n for n in ["goals", "acceptance", "feishu", "controls", "scheduling", "optimization", "infrastructure"]]:
    source_arm = "before-terminal-fix" if arm == "all-on" else arm
    js = [j for j in job_groups.get(source_arm, []) if j["repetition"] < 3]
    if js:
        ablation[arm] = metrics(js)
noise = {}
for arm in ["all-off", "upstream", "upstream-host"]:
    group = groups.get(arm, [])
    if not group:
        continue
    repetitions = sorted({r["repetition"] for r in group})
    noise[arm] = {key: stats([getter([r for r in group if r["repetition"] == rep]) for rep in repetitions]) for key, getter in {
        "success_rate": lambda rs: sum(r["success"] for r in rs) / len(rs),
        "tokens_per_task": lambda rs: statistics.mean(r["usage"]["totalTokens"] for r in rs),
        "duration_ms_per_task": lambda rs: statistics.mean(r["result"]["run"]["durationMs"] for r in rs),
    }.items()}

def job_category(job):
    outcome = exit_by_id[job["id"]]
    if outcome.get("timeout"):
        return "external_experiment_timeout"
    if outcome["code"] != 0:
        return "external_worker_error"
    record = row_by_id.get(job["id"])
    return category(record) if record else "missing_evaluation_record"


taxonomy = {name: dict(collections.Counter(job_category(j) for j in group)) for name, group in job_groups.items()}
annotations = []
for j in formal_jobs:
    label = job_category(j)
    if label == "success":
        continue
    r = row_by_id.get(j["id"])
    annotations.append({"id": j["id"], "caseId": j["caseId"], "arm": j["arm"], "phase": phase_by_id[j["id"]],
                        "category": label, "exit": exit_by_id[j["id"]], "record_available": r is not None,
                        "failed_checks": [c for c in r["result"]["checks"] if not c["passed"]] if r else None,
                        "tool_error_excerpts": tool_errors(r) if r else None})
(OUT / "live-failure-annotations.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in annotations))

# Independently recalculate model usage, checks, frozen payload settings and run denominators.
verified = 0
frozen_dataset = json.loads((ROOT / "docs/experiments/2026-10-21-ablation/prompt-dataset.json").read_text())
cases = {item["id"]: item for item in frozen_dataset}
for r in rows:
    assert r["scorerSha256"] == expected_scorer
    checks = r["result"]["checks"]
    for path, expectation in cases[r["caseId"]]["outputs"].items():
        content = r["artifacts"][path]
        try:
            if "json" in expectation:
                # JSON bool is not a numeric artifact. Compare normalized JSON trees.
                actual = json.loads(content)
                def normalized(value):
                    if isinstance(value, dict):
                        return ("object", sorted((key, normalized(v)) for key, v in value.items()))
                    if isinstance(value, list):
                        return ("array", [normalized(v) for v in value])
                    if isinstance(value, bool):
                        return ("boolean", value)
                    if isinstance(value, (int, float)):
                        return ("number", value)
                    return (type(value).__name__, value)
                passed = normalized(actual) == normalized(expectation["json"])
            elif "textExact" in expectation:
                passed = content == expectation["textExact"]
            else:
                passed = content.strip() == expectation["textTrimmed"]
        except (TypeError, ValueError, AttributeError):
            passed = False
        assert next(c["passed"] for c in checks if c["name"] == "file_strict:" + path) == passed
    assert r["success"] == all(c["passed"] for c in checks)
    assert r["result"]["score"] == sum(c["passed"] for c in checks) / len(checks)
    assistants = [e["message"] for e in r["session"] if e.get("type") == "message" and e["message"].get("role") == "assistant"]
    for key, value in r["usage"].items():
        assert value == sum(m.get("usage", {}).get(key, 0) for m in assistants)
    assert r["reportedDuringStreaming"] == r["usage"]["totalTokens"]
    requests = json.loads((LIVE / "raw" / r["id"] / "requests.json").read_text())
    assert len(requests) == r["modelRequests"]
    for q in requests:
        p = q["payload"]
        assert p["temperature"] == 0.2 and p["max_tokens"] == 2048 and p["thinking"] == {"type": "disabled"} and p["seed"] == r["seed"]
    verified += 1

phases = {}
for p in sorted(LIVE.glob("*-freeze.json")):
    mode = p.name.removesuffix("-freeze.json")
    freeze = json.loads(p.read_text())
    complete_path = LIVE / f"{mode}-complete.json"
    complete = json.loads(complete_path.read_text()) if complete_path.exists() else None
    phases[mode] = {"planned": len(freeze["jobs"]), "complete": complete is not None and not complete["budgetLimited"],
                    "all_workers_exit_zero": all(r["code"] == 0 for r in complete["results"]) if complete else None,
                    "finished": complete["finished"] if complete else sum((LIVE / "raw" / j["id"] / "run.json").exists() for j in freeze["jobs"]),
                    "requests": complete["reserved"] if complete else None, "reported_tokens": complete["reportedTokens"] if complete else None,
                    "harness_errors": sum(r["code"] != 0 for r in complete["results"]) if complete else None}

source_checks = {}
for version in ["before", "after", "lean"]:
    manifest = json.loads((LIVE / f"source-{version}.json").read_text())
    source_checks[version] = all(hashlib.sha256((LIVE / f"source-{version}" / path).read_bytes()).hexdigest() == sha for path, sha in manifest.items())

before = groups.get("before-terminal-fix", [])
after = groups.get("fixed-all-on", [])
effects = {}
if len(before) == len(after) == 36:
    ids = sorted({r["caseId"] for r in before})
    rng = random.Random(20261021)
    for name, getter, relative in [("strict_success_difference", lambda r: int(r["success"]), False),
                                    ("relative_token_change", lambda r: r["usage"]["totalTokens"], True),
                                    ("relative_duration_change", lambda r: r["result"]["run"]["durationMs"], True)]:
        a = {i: statistics.mean(getter(r) for r in before if r["caseId"] == i) for i in ids}
        b = {i: statistics.mean(getter(r) for r in after if r["caseId"] == i) for i in ids}
        def effect(sample):
            left, right = statistics.mean(a[i] for i in sample), statistics.mean(b[i] for i in sample)
            return right / left - 1 if relative else right - left
        draws = sorted(effect(rng.choices(ids, k=len(ids))) for _ in range(10000))
        effects[name] = {"effect": effect(ids), "task_cluster_bootstrap_95": [draws[249], draws[9749]]}

def paired_effects(left, right):
    if len(left) != 36 or len(right) != 36:
        return None
    ids = sorted({r["caseId"] for r in left})
    output = {}
    for name, getter, relative in [("strict_success_difference", lambda r: int(r["success"]), False),
                                    ("relative_token_change", lambda r: r["usage"]["totalTokens"], True),
                                    ("relative_duration_change", lambda r: r["result"]["run"]["durationMs"], True)]:
        a = {i: statistics.mean(getter(r) for r in left if r["caseId"] == i) for i in ids}
        b = {i: statistics.mean(getter(r) for r in right if r["caseId"] == i) for i in ids}
        def effect(sample):
            x, y = statistics.mean(a[i] for i in sample), statistics.mean(b[i] for i in sample)
            return y / x - 1 if relative else y - x
        rng = random.Random(20261022)
        draws = sorted(effect(rng.choices(ids, k=len(ids))) for _ in range(10000))
        output[name] = {"effect": effect(ids), "task_cluster_bootstrap_95": [draws[249], draws[9749]]}
    return output


replication = [r for r in formal if phase_by_id[r["id"]] == "ordinary-replication"]
ordinary_effects = paired_effects([r for r in replication if r["arm"] == "ordinary-before"],
                                  [r for r in replication if r["arm"] == "ordinary-lean"])
composition = []
for r in formal:
    request_path = LIVE / "raw" / r["id"] / "requests.json"
    for q in json.loads(request_path.read_text()):
        payload = q["payload"]
        def text_content(content):
            if isinstance(content, str):
                return content
            return "\n".join(block.get("text", "") for block in (content or []) if isinstance(block, dict))
        system = "\n".join(text_content(m.get("content")) for m in payload["messages"] if m["role"] == "system")
        sections = []
        for section in re.split(r"(?m)(?=^## )", system):
            if section:
                sections.append({"heading": section.splitlines()[0], "characters": len(section), "utf8_bytes": len(section.encode()), "tokens": None})
        users = [text_content(m.get("content")) for m in payload["messages"] if m["role"] == "user"]
        continuation = [t for t in users if "[LightClaw 自动续跑]" in t]
        composition.append({"id": r["id"], "arm": r["arm"], "request_index": q["index"], "cycles": r["cycles"],
                            "system_characters": len(system), "system_utf8_bytes": len(system.encode()), "sections": sections,
                            "tool_names": [t["function"]["name"] for t in payload.get("tools", [])],
                            "tool_schema_characters": len(json.dumps(payload.get("tools", []), ensure_ascii=False)),
                            "continuation_messages": len(continuation), "continuation_characters": sum(map(len, continuation)),
                            "messages": len(payload["messages"]), "message_characters": len(json.dumps(payload["messages"], ensure_ascii=False)),
                            "section_tokens": None, "token_method": "provider total usage is exact; official per-section tokenizer unavailable"})
(OUT / "live-prompt-composition.jsonl").write_text("".join(json.dumps(c, ensure_ascii=False) + "\n" for c in composition))
prompt_summary = {}
for arm in sorted({c["arm"] for c in composition}):
    cs = [c for c in composition if c["arm"] == arm]
    prompt_summary[arm] = {key: {"mean": statistics.mean(c[key] for c in cs), "min": min(c[key] for c in cs), "max": max(c[key] for c in cs)}
                           for key in ["system_characters", "tool_schema_characters", "message_characters", "continuation_messages"]}
context_growth = {}
for count in sorted({c["continuation_messages"] for c in composition}):
    cs = [c for c in composition if c["continuation_messages"] == count]
    context_growth[str(count)] = {"requests": len(cs), "mean_message_characters": statistics.mean(c["message_characters"] for c in cs),
                                 "max_message_characters": max(c["message_characters"] for c in cs)}

result = {"formal_runs": len(formal_ids), "formal_records": len(formal), "formal_missing_records": len(formal_ids) - len(formal), "pilot_runs_with_records": len(rows) - len(formal), "groups": summary, "phase_groups": phase_groups, "ablation": ablation, "noise": noise,
          "taxonomy": taxonomy, "phases": phases, "paired_terminal_fix_effects": effects, "ordinary_replication_effects": ordinary_effects,
          "prompt_requests_decomposed": len(composition), "prompt_summary": prompt_summary, "context_growth_by_continuations": context_growth,
          "verification": {"runs_verified": verified, "scorer_unchanged_sha256": expected_scorer, "source_snapshots_intact": source_checks},
          "host_phases_require_explicit_authorization": "upstream-host" not in groups,
          "all_recorded_formal_artifacts_correct": all(artifact_ok(r) for r in formal), "unknown_artifact_outcomes": len(formal_ids) - len(formal)}
(OUT / "live-summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
def table_for(items):
    table = ["| 条件 | N | 严格成功 | 产物正确/已知 | 未知产物 | 目标轮/任务 | 请求/任务 | Token/任务 | ms/任务 | 120秒超时 | 费用 |",
             "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|"]
    for name, m in items.items():
        def fmt(key):
            return f"{m[key]:.2f}" if m[key] is not None else "未知"
        table.append(f"| {name} | {m['n']} | {m['successes']}/{m['n']} | {m['artifacts_correct']}/{m['records']} | {m['artifacts_unknown']} | {fmt('mean_cycles')} | {fmt('mean_model_requests')} | {fmt('mean_tokens')} | {fmt('mean_duration_ms')} | {m['external_timeouts']} | 未知 |")
    return "\n".join(table) + "\n\n资源均值仅计算有完整记录者；超时仍计入成功率分母，其Token/轮数/耗时缺失，不能将均值视作全批真实开销。费用未知。\n"

(OUT / "live-table.md").write_text(table_for(summary))
(OUT / "live-ablation-table.md").write_text(table_for(ablation))
(OUT / "live-phase-tables.md").write_text("\n".join("## " + phase + "\n\n" + table_for(items) for phase, items in phase_groups.items()))
print(json.dumps({"formal_runs": len(formal_ids), "records": len(formal), "phases": phases,
                  "verification": result["verification"]}, ensure_ascii=False, indent=2))
