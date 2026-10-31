"""Offline, versioned accounting of frozen attempts; never runs workers or models."""
import argparse
import collections
import hashlib
import json
import math
import pathlib
import statistics

STATES = ("success", "task_failure", "external_timeout", "worker_error", "missing_record",
          "invalid_record", "missing_controller", "controller_conflict", "not_started", "start_unknown")


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def valid_record(row, identity):
    if not isinstance(row, dict) or row.get("id") != identity or not isinstance(row.get("success"), bool):
        return False
    result = row.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("run"), dict):
        return False
    checks = result.get("checks")
    return (isinstance(checks, list) and bool(checks)
            and all(isinstance(c, dict) and isinstance(c.get("passed"), bool) for c in checks)
            and row["success"] == all(c["passed"] for c in checks))


def aggregate(attempts):
    started = [a for a in attempts if a["started_evidenced"]]
    terminal = dict.fromkeys(STATES, 0)
    for attempt in attempts:
        terminal[attempt["terminal_state"]] += 1
    resources = {}
    for key in ("input", "output", "cacheRead", "cacheWrite", "totalTokens", "modelRequests", "cycles", "durationMs"):
        values = [a["resources"][key] for a in started if a["resources"][key] is not None]
        resources[key] = {"known_attempts": len(values), "missing_attempts": len(started) - len(values),
                          "observed_total": sum(values) if values else None,
                          "mean_of_known": statistics.mean(values) if values else None,
                          "total_if_complete": sum(values) if len(values) == len(started) else None}
    counts = {"planned": len(attempts), "started_evidenced": len(started),
              "controller_results": sum(a["controller_available"] for a in attempts),
              "record_files": sum(a["record_available"] for a in attempts),
              "complete_records": sum(a["record_complete"] for a in attempts),
              "not_started": terminal["not_started"], "start_unknown": terminal["start_unknown"],
              "missing_records_started": sum(not a["record_available"] for a in started),
              "invalid_records": sum(a["record_available"] and not a["record_complete"] for a in attempts)}
    return {"counts": counts, "terminal_states": terminal,
            "success_rate_started": terminal["success"] / len(started) if started else None,
            "success_rate_planned": terminal["success"] / len(attempts) if attempts else None,
            "resources": resources, "cost": None, "prices_known": False,
            "unknown_cost_attempts": len(started)}


def analyze(live):
    inputs, jobs, phases, outcomes = {}, {}, {}, collections.defaultdict(list)
    conflicts, attempts = [], []

    def track(path):
        inputs[path.relative_to(live).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()

    def load(path):
        track(path)
        return json.loads(path.read_text())

    for path in sorted(live.glob("*-freeze.json")):
        phase = path.name.removesuffix("-freeze.json")
        frozen = load(path)
        complete_path = live / f"{phase}-complete.json"
        complete = load(complete_path) if complete_path.exists() else None
        phases[phase] = {"completion_file": complete is not None,
                         "controller_finished": complete.get("finished") if complete else None,
                         "controller_reserved_requests": complete.get("reserved") if complete else None,
                         "controller_reported_tokens": complete.get("reportedTokens") if complete else None,
                         "budget_limited": complete.get("budgetLimited") if complete else None}
        for job in frozen["jobs"]:
            identity = job["id"]
            if identity in jobs or not identity or "/" in identity or "\\" in identity or identity in (".", ".."):
                raise ValueError(f"Duplicate or unsafe frozen identity: {identity}")
            jobs[identity] = {**job, "phase": phase}
        if complete:
            for outcome in complete["results"]:
                outcomes[outcome["id"]].append({"source": complete_path.name, "value": outcome})
        progress = live / f"{phase}-progress.jsonl"
        if progress.exists():
            track(progress)
            for line in progress.read_text().splitlines():
                if line.strip():
                    outcome = json.loads(line)
                    outcomes[outcome["id"]].append({"source": progress.name, "value": outcome})
    if not jobs:
        raise ValueError("No frozen jobs found")
    if set(outcomes) - set(jobs):
        raise ValueError("Controller results contain unplanned identities")

    for identity, job in sorted(jobs.items()):
        raw = live / "raw" / identity
        files = sorted(p for p in raw.glob("*") if p.is_file())
        for path in files:
            track(path)
        run_path = raw / "run.json"
        row = None
        if run_path.exists():
            try:
                row = json.loads(run_path.read_text())
            except (ValueError, UnicodeError):
                pass
        complete = valid_record(row, identity)
        evidence = list(outcomes[identity])
        harness = raw / "harness-error.json"
        if harness.exists():
            outcome = load(harness)
            if outcome.get("id") != identity:
                raise ValueError("Harness outcome identity mismatch")
            evidence.append({"source": f"raw/{identity}/harness-error.json", "value": outcome})
        controller = [e["value"] for e in evidence]
        # jobs/*.json is written before dispatch and is deliberately NOT start evidence.
        # Empty raw directories are created before fork, so they establish dispatch only.
        started = bool(controller) or any(p.name in {"run.json", "requests.json", "stdout.log", "stderr.log", "crashed-session.jsonl"} for p in files)
        timeout = any(o.get("timeout") is True for o in controller)
        worker_error = any((o.get("code") is not None and o.get("code") != 0) or o.get("signal") for o in controller)
        signatures = {json.dumps({k: o.get(k) for k in ("code", "signal", "timeout")}, sort_keys=True) for o in controller}
        if len(signatures) > 1:
            conflicts.append({"id": identity, "kind": "controller_disagreement", "evidence": evidence})
        if timeout and complete and row["success"]:
            conflicts.append({"id": identity, "kind": "timeout_with_success_record"})
        if timeout and any(o.get("code") == 0 for o in controller):
            conflicts.append({"id": identity, "kind": "timeout_with_zero_exit"})
        if not started:
            state = "not_started" if phases[job["phase"]]["completion_file"] and not raw.exists() else "start_unknown"
        elif timeout:
            state = "external_timeout"
        elif worker_error:
            state = "worker_error"
        elif not controller:
            state = "missing_controller"
        elif len(signatures) > 1 or any(o.get("code") != 0 or not isinstance(o.get("timeout"), bool) for o in controller):
            state = "controller_conflict"
        elif not run_path.exists():
            state = "missing_record"
        elif not complete:
            state = "invalid_record"
        else:
            state = "success" if row["success"] else "task_failure"
        usage = (row.get("usage") or {}) if complete else {}
        usage = usage if isinstance(usage, dict) else {}
        resources = {k: usage.get(k) if number(usage.get(k)) else None for k in ("input", "output", "cacheRead", "cacheWrite", "totalTokens")}
        for key in ("modelRequests", "cycles"):
            value = row.get(key) if complete else None
            resources[key] = value if number(value) else None
        duration = row["result"]["run"].get("durationMs") if complete else None
        resources["durationMs"] = duration if number(duration) else None
        attempts.append({"id": identity, "phase": job["phase"], "arm": job.get("arm", "unknown"),
                         "caseId": job.get("caseId"), "repetition": job.get("repetition"),
                         "terminal_state": state, "started_evidenced": started,
                         "dispatch_directory": raw.exists(), "controller_available": bool(controller),
                         "record_available": run_path.exists(), "record_complete": complete,
                         "record_success": row["success"] if complete else None,
                         "controller_evidence": evidence, "resources": resources, "cost": None})

    formal = [a for a in attempts if not a["phase"].startswith("pilot")]
    for phase, details in list(phases.items()):
        selected = [a for a in attempts if a["phase"] == phase]
        phases[phase] = {**details, **aggregate(selected),
                         "arms": {arm: aggregate([a for a in selected if a["arm"] == arm]) for arm in sorted({a["arm"] for a in selected})}}
    snapshot_checks = {}
    for manifest in sorted(live.glob("source-*.json")):
        hashes = load(manifest)
        folder = live / manifest.stem
        checks = []
        for name, digest in hashes.items():
            path = folder / name
            if path.exists():
                track(path)
            checks.append(path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == digest)
        snapshot_checks[manifest.stem] = all(checks)
    summary = {"schema_version": 2, "kind": "historical_reanalysis_no_new_experiment",
               "policy": {"terminal_states": list(STATES),
                          "classification": "no start evidence; timeout; worker error; missing controller; controller conflict; missing/invalid record; task result",
                          "start_evidence": "controller close result or worker-created record/log; no independent PID start ledger exists",
                          "missing_usage": "unknown, never zero; totals only complete when every started attempt has usage",
                          "cost": "unknown for all attempts; historical zero cost is a placeholder",
                          "denominator": "all evidenced starts including failures/timeouts; planned and unknown-start counts also retained"},
               "formal": aggregate(formal), "pilots": aggregate([a for a in attempts if a not in formal]),
               "phases": phases, "arms": {arm: aggregate([a for a in formal if a["arm"] == arm]) for arm in sorted({a["arm"] for a in formal})},
               "conflicts": conflicts, "source_snapshots_intact": snapshot_checks,
               "orphan_raw_directories": sorted(p.name for p in (live / "raw").glob("*") if p.is_dir() and p.name not in jobs)}
    return summary, attempts, inputs


def render_report(summary):
    counts = summary["formal"]["counts"]
    lines = ["# 历史实验重新统计 v2（2026-10-29）", "",
             "本报告仅离线重算 2026-10-21 冻结实验及其后续完整重复；没有启动 worker、调用模型或新增实验。旧脚本、原始记录和历史报告保持不变。", "",
             "互斥终态按以下优先级归类：没有启动证据时为未启动/启动未知；已有证据时依次判定外部超时、worker 错误、控制器缺失/冲突、记录缺失/无效、任务成功/任务失败。timeout=true 优先于 code=0 和 run.success=true。每个计划身份恰好一个终态。", "",
             "启动数是已有控制器 close 结果或 worker 文件证据的数量，历史控制器没有独立 PID 启动日志，因此不能声称精确恢复进程启动时间。预先生成的 jobs 文件不算启动；空 raw 目录仅算派发证据，不能判为未启动。阶段结束且无派发/worker 证据的计划项记未启动；未结束阶段无证据项记启动未知。", "",
             f"正式计划 {counts['planned']}；有启动证据 {counts['started_evidenced']}；控制器结果 {counts['controller_results']}；run.json 文件 {counts['record_files']}；结构完整且检查与 success 一致的记录 {counts['complete_records']}；已启动缺失记录 {counts['missing_records_started']}。pilot 单列，不并入正式分母。", "",
             "| 阶段 | 计划 | 启动证据 | 控制器 | 完整记录 | 成功 | 任务失败 | 超时 | worker错误 | 其他终态 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for phase, data in summary["phases"].items():
        c, s = data["counts"], data["terminal_states"]
        other = sum(s[k] for k in STATES if k not in {"success", "task_failure", "external_timeout", "worker_error"})
        lines.append(f"| {phase} | {c['planned']} | {c['started_evidenced']} | {c['controller_results']} | {c['complete_records']} | {s['success']} | {s['task_failure']} | {s['external_timeout']} | {s['worker_error']} | {other} |")
    lines += ["", "成功率使用全部有启动证据的尝试作分母，包括失败和超时；另保留计划成功率。缺失控制器或无效记录不会默认成功。多来源控制器冲突逐条保留，优先使用更保守终态。", "",
              "Token、请求数、轮数和耗时分别报告已知样本数、缺失数、已观测合计、已知样本均值。只要任一尝试缺失该项，全批总量即为 null。均值不能解释为全批平均，已观测合计不能解释为完整成本。控制器 reserved 请求和 reportedTokens 单独列出，不能均摊到缺失尝试。货币费用全部为未知；历史 cost=0 不代表免费。", "",
              "| 条件（正式阶段合并） | 启动证据 | 成功 | 超时 | Token已知/缺失 | Token观测合计 | 已知均值 |", "|---|---:|---:|---:|---:|---:|---:|"]
    for arm, data in summary["arms"].items():
        t = data["resources"]["totalTokens"]
        mean = f"{t['mean_of_known']:.2f}" if t["mean_of_known"] is not None else "未知"
        lines.append(f"| {arm} | {data['counts']['started_evidenced']} | {data['terminal_states']['success']} | {data['terminal_states']['external_timeout']} | {t['known_attempts']}/{t['missing_attempts']} | {t['observed_total']} | {mean} |")
    lines += ["", "冲突记录："]
    lines += [f"- `{c['id']}`：{c['kind']}" for c in summary["conflicts"]] or ["- 无"]
    lines += ["", "`live-attempts.v2.jsonl` 给出每个计划项及控制器证据；`live-summary.v2.json` 包含阶段、条件和逐项资源分母；`live-inputs.v2.json` 固定本次所读原始文件和分析器的 SHA-256。", "",
              "本版验证记录结构、检查布尔值与 success 一致性、冻结源码哈希，并未重新执行任务或重新评判产物语义；历史评分和产物正确性结论仍受原评分器限制。没有重新估计因果效应、置信区间或推广旧性能结论；ordinary 和 ordinary-replication 的阶段结果分别保留，条件合并只用于描述总失败分母。宿主附件修复与这些旧实验的收益无关。", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live-dir", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent / "live")
    parser.add_argument("--output-dir", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent)
    parser.add_argument("--check", action="store_true", help="Verify existing v2 outputs without rewriting")
    args = parser.parse_args()
    summary, attempts, inputs = analyze(args.live_dir)
    manifest = {"schema_version": 2, "analyzer_sha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(), "inputs": inputs}
    json_text = lambda value: json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    outputs = {"live-summary.v2.json": json_text(summary),
               "live-attempts.v2.jsonl": "".join(json.dumps(a, ensure_ascii=False, sort_keys=True) + "\n" for a in attempts),
               "live-inputs.v2.json": json_text(manifest), "report.v2.zh-CN.md": render_report(summary)}
    if args.check:
        for name, content in outputs.items():
            if (args.output_dir / name).read_text() != content:
                raise ValueError(f"Versioned output differs: {name}")
        print("v2 outputs verified against frozen inputs")
        return
    args.output_dir.mkdir(parents=True, exist_ok=True)
    if any((args.output_dir / name).exists() for name in outputs):
        raise ValueError("Refusing to overwrite versioned output; use --check or a new output directory")
    for name, content in outputs.items():
        with (args.output_dir / name).open("x") as output:
            output.write(content)
    print(json.dumps(summary["formal"]["counts"], ensure_ascii=False))


if __name__ == "__main__":
    main()
