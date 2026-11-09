"""Run paired synthetic memory evaluations with durable per-run checkpoints."""
import argparse
from collections import defaultdict
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, time as wall_time, timedelta
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import random
import re
import subprocess
import sys
import time
from zoneinfo import ZoneInfo

from lint_memory import lint_layout
from prepare_runner import git, prepare, source_digest
from render_s2 import CHANNEL, FEATURES as LAYOUT_FEATURES, render_s2

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EVAL = ROOT / "eval"
KIT = EVAL / "memory_eval_kit"
sys.path.insert(0, str(KIT))
from scorer import score

FEATURES = frozenset(LAYOUT_FEATURES | {"i4", "i6", "i7"})
RUNTIME = {"N": "S1", "S0": "S0", "S1": "S1", "S2": "S2", "T": "T", "O": "S0"}
FLASH_PRICE = (2.0, 0.04, 2.0, 8.0)
PRICES = {"deepseek-flash": FLASH_PRICE, "deepseek-v4-flash": FLASH_PRICE,
          "deepseek-v4-pro": (9.0, 0.30, 9.0, 27.0)}
PRICE_NAMES = ("input", "cacheRead", "cacheWrite", "output")
SPEND = EVAL / "results/matrix-spend.private.jsonl"
SHANGHAI = ZoneInfo("Asia/Shanghai")


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mapped(path):
    return f"{CHANNEL}/{path.removeprefix('channel/')}" if path.startswith("channel/") else path


def fixture_files(source):
    return {
        mapped(path.relative_to(source).as_posix()): path.read_text(encoding="utf-8")
        for path in sorted(source.rglob("*.md"))
    }


def oracle(document, ids):
    grouped = defaultdict(list)
    for fact in document["facts"]:
        if fact["id"] in ids:
            file = "MEMORY.md" if fact["scope"] == "global" else f"{CHANNEL}/MEMORY.md"
            grouped[file].append(f"- {fact['text']}")
    return {path: "\n".join(lines) + "\n" for path, lines in grouped.items()}


def unit_key(row):
    return (row["protocol_sha"], row["phase"], row["model_slot"], row["model"], row["case_id"],
            row["arm"], row["repeat"], row["runtime_sha"], row["route_id"], tuple(row["features"]))


def observed_reads(trace):
    return {
        PurePosixPath(tool["args"]["path"]).stem
        for tool in trace.get("tools", [])
        if tool["name"] == "read" and tool.get("status") in ("ok", "success")
        and isinstance(tool.get("args"), dict) and isinstance(tool["args"].get("path"), str)
    }


def gold_reads(case, arm, mapping):
    if arm == "S1":
        return {PurePosixPath(path).stem for path in case["meta"].get("gold_reads_s1", [])}
    if arm == "S2":
        return {PurePosixPath(mapping[fact]).stem for fact in case["facts"]
                if fact in mapping and PurePosixPath(mapping[fact]).name != "MEMORY.md"}
    return set()


def stale_values(case, document):
    if case["category"] != "update":
        return []
    by_id = {f["id"]: f for f in document["facts"]}
    return [str(by_id[f["supersedes"]]["value"]) for f in document["facts"]
            if f["id"] in case["facts"] and f.get("supersedes") in by_id]


def cost(trace, prices):
    if trace.get("usageIncomplete") or not trace.get("attempts"):
        return None
    if any(attempt.get(key) is None for attempt in trace["attempts"] for key in PRICE_NAMES):
        return None
    return sum(sum((attempt.get(key) or 0) * price for key, price in zip(PRICE_NAMES, prices))
               for attempt in trace["attempts"]) / 1_000_000


def normalize_local_round_cap(trace):
    """Separate the locally rejected dispatch from calls sent to the provider."""
    attempts = trace.get("attempts", [])
    rounds = trace.get("rounds", 0)
    if (trace.get("budgetReason") != "Evaluation model round budget exhausted"
            or trace.get("stopReason") != "aborted" or not trace.get("usageIncomplete")
            or rounds < 1 or len(attempts) != rounds + 1):
        return trace
    dispatched, local = attempts[:-1], attempts[-1]
    if (local.get("status") != "aborted" or local.get("stopReason") != "aborted"
            or any(local.get(key) is not None for key in PRICE_NAMES)
            or any(attempt.get(key) is None for attempt in dispatched for key in PRICE_NAMES)):
        return trace
    return {**trace, "attempts": dispatched, "localRoundCapAudit": local, "usageIncomplete": False}


def deepseek_budget_factor(start, window_seconds):
    local_start = start.astimezone(SHANGHAI)
    end = local_start + timedelta(seconds=window_seconds)
    for offset in range((end.date() - local_start.date()).days + 1):
        day = local_start.date() + timedelta(days=offset)
        if day.weekday() >= 5:
            continue
        # Treat weekday holidays as peak when their schedule is unavailable.
        for first, last in ((9, 12), (14, 18)):
            peak_start = datetime.combine(day, wall_time(first), SHANGHAI)
            peak_end = datetime.combine(day, wall_time(last), SHANGHAI)
            if local_start < peak_end and end >= peak_start:
                return 1
    return 0.5


def reserve(files, prices, limits):
    """Planning estimate, not a provider token bound. Use uncached peak rates."""
    initial = 8192 + sum(len(text.encode()) for path, text in files.items() if path.endswith("/MEMORY.md") or path == "MEMORY.md")
    # Budget for repeated prompt plus at most one large file result per tool round.
    largest = min(50 * 1024, max((len(body.encode()) for body in files.values()), default=0))
    turns = limits["maxToolCalls"] + 1
    tokens = initial * turns + (largest + 4 * limits["maxOutputTokens"]) * turns * (turns - 1) // 2
    return (tokens * max(prices[:3]) +
            turns * limits["maxOutputTokens"] * prices[3]) / 1_000_000


def rows_for(path):
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def append_row(handle, row):
    handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    handle.flush()
    os.fsync(handle.fileno())


def budget_state(paths, ledger=SPEND):
    spent = 0.0
    pending = set()
    for path in paths:
        for row in rows_for(path):
            if row.get("route") != "faux":
                spent += row.get("budget_charge_cny") or 0
            if path == ledger and row.get("event") == "reserve":
                pending.add(row["unit"])
            if path == ledger and row.get("event") == "settle":
                pending.discard(row["unit"])
    if not math.isfinite(spent) or spent < 0:
        raise ValueError("Invalid evaluation budget ledger")
    return spent, pending


def budget_event(route, event, key, charge):
    fd = os.open(SPEND, os.O_APPEND | os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as handle:
        append_row(handle, {"route": route, "event": event, "unit": key, "budget_charge_cny": charge})


def invoke(runtime, spec, env, seconds):
    command = ["node", "--import", "tsx", str(runtime / "runner.ts")]
    try:
        proc = subprocess.run(command, cwd=ROOT, input=json.dumps(spec, ensure_ascii=False), env=env,
                              text=True, capture_output=True, timeout=seconds, check=False)
    except subprocess.TimeoutExpired:
        return {"stopReason": "harness_timeout", "usageIncomplete": True, "attempts": [], "response": ""}
    try:
        result = json.loads(proc.stdout)
    except ValueError:
        result = {}
    if proc.returncode or not isinstance(result, dict) or "stopReason" not in result:
        return {"stopReason": "adapter_error", "usageIncomplete": True, "attempts": [], "response": ""}
    return normalize_local_round_cap(result)


def parallel_results(items, launch, healthy, workers, *, admit=None):
    """Defer work that cannot reserve budget until outstanding jobs settle."""
    remaining = iter(items)
    item = next(remaining, None)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = set()
        stopped = False
        while True:
            while item is not None and not stopped and len(pending) < workers:
                if admit is not None and not admit(item):
                    break
                pending.add(pool.submit(launch, item))
                item = next(remaining, None)
            if not pending:
                return
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            completed = [future.result() for future in done]
            stopped = stopped or any(not healthy(result) for result in completed)
            yield from completed


def trace_complete(row):
    """An answered run can be scored even if an earlier retry has unreported usage."""
    trace = row["trace"]
    attempts = trace.get("attempts")
    if trace.get("fixturesUnchanged") is not True or not attempts:
        return False
    if not trace.get("usageIncomplete"):
        return True
    last = attempts[-1]
    return (trace.get("stopReason") == last.get("stopReason") == "stop" and last.get("status") == "success"
            and all(last.get(key) is not None for key in PRICE_NAMES))


def choose_cases(cases, n, seed, categories=()):
    if n is None:
        return cases
    shuffled = list(cases)
    random.Random(seed).shuffle(shuffled)
    selected = [next(case for case in shuffled if case["category"] == category) for category in categories]
    return (selected + [c for c in shuffled if c not in selected])[:n]


def prior_stage_complete(stage, slot, model, route_id, protocol_sha, protocol, s2_source):
    required = protocol["phases"][stage]
    expected = (required["items"] or 116) * required["repeats"] * len(protocol["arm_order"])
    groups = defaultdict(set)
    for path in (EVAL / "results").glob("*.jsonl"):
        for row in rows_for(path):
            if (
                (row.get("phase"), row.get("model_slot"), row.get("model"), row.get("route_id")) == (stage, slot, model, route_id)
                and row.get("protocol_sha") == protocol_sha and row.get("arm") in protocol["arm_order"]
                and row.get("commits", {}).get("S2", {}).get("sourceSha256") == s2_source
                and trace_complete(row)
            ):
                groups[row["runtime_sha"]].add((row["case_id"], row["arm"], row["repeat"]))
    return any(len(keys) == expected for keys in groups.values())


def effective_limits(defaults, phase, smoke_timeout_seconds):
    if smoke_timeout_seconds is None:
        return dict(defaults)
    timeout = smoke_timeout_seconds * 1000
    if phase != "smoke" or not defaults["runTimeoutMs"] <= timeout <= 600_000:
        raise ValueError("The smoke timeout override applies only to smoke and must be between the default and 600 seconds")
    return {**defaults, "runTimeoutMs": timeout}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("smoke", "pilot", "formal"), default="smoke")
    parser.add_argument("--model-slot", choices=("M1", "M2"), default="M1")
    parser.add_argument("--route", choices=("faux", "deepseek", "configured"), default="faux")
    parser.add_argument("--budget-cny", type=float)
    parser.add_argument("--ablate", choices=sorted(FEATURES))
    parser.add_argument("--runtime", type=Path, default=EVAL / ".runtime")
    parser.add_argument("--result", type=Path)
    parser.add_argument("--jobs", type=int, default=1, help="Maximum in-flight runs on DeepSeek or a zero-priced configured route")
    parser.add_argument("--smoke-run-timeout-s", type=int, help="Extend only the total per-run smoke deadline")
    parser.add_argument("--deepseek-offpeak-budget", action="store_true",
                        help="Use the documented half rate only when an entire official-route run fits off-peak")
    args = parser.parse_args()
    if not 1 <= args.jobs <= 8:
        parser.error("--jobs must be between 1 and 8")
    if args.ablate and args.phase != "pilot":
        parser.error("Ablations are dev-pilot only")
    if args.deepseek_offpeak_budget and args.route != "deepseek":
        parser.error("Off-peak budgeting applies only to the official DeepSeek route")
    if args.route == "faux" and args.phase != "smoke":
        parser.error("Faux can verify plumbing on smoke only")
    live = args.route != "faux"
    if live and (args.budget_cny is None or not 0 < args.budget_cny < float("inf")):
        parser.error("A finite authorized --budget-cny is required for live calls")
    if args.route == "deepseek" and not (os.getenv("LIGHTCLAW_EVAL_API_KEY") or os.getenv("LIGHTCLAW_EVAL_DEEPSEEK_API_KEY")):
        parser.error("Configure a dedicated evaluation credential in the environment")
    if args.route == "configured" and not (os.getenv("LIGHTCLAW_EVAL_API_KEY") and os.getenv("LIGHTCLAW_EVAL_PROVIDER")):
        parser.error("Configured routes require the dedicated generic key and provider")
    model = os.getenv("LIGHTCLAW_EVAL_MODEL_ID") if live else "faux"
    if not model:
        parser.error("Set LIGHTCLAW_EVAL_MODEL_ID for live")
    prices = PRICES.get(model)
    if live and args.route == "configured":
        raw = os.getenv("LIGHTCLAW_EVAL_CNY_PER_MILLION")
        if not raw:
            parser.error("Configured routes require explicit pricing via LIGHTCLAW_EVAL_CNY_PER_MILLION")
        try:
            prices = tuple(float(x) for x in raw.split(","))
        except ValueError:
            parser.error("Invalid CNY prices")
        if len(prices) != 4 or any(not 0 <= p < float("inf") for p in prices):
            parser.error("Provide four finite nonnegative prices: input,cacheRead,cacheWrite,output")
    if live and not prices:
        parser.error("Missing CNY rates for the selected model")
    if args.jobs > 1 and not (args.route == "deepseek" or args.route == "configured" and not any(prices)):
        parser.error("Parallel execution requires the official DeepSeek route or four explicit zero rates")

    protocol_path = EVAL / "protocol.json"
    protocol = load(protocol_path)
    protocol_sha = digest(protocol_path)
    stage = protocol["phases"][args.phase]
    try:
        limits = effective_limits(protocol["limits"], args.phase, args.smoke_run_timeout_s)
    except ValueError as error:
        parser.error(str(error))
    cases_path = KIT / "testset/cases.jsonl"
    if digest(cases_path) != protocol["cases_sha256"] or digest(KIT / "scorer.py") != protocol["scorer_sha256"]:
        parser.error("Frozen kit or scorer hash mismatch")
    runtime = args.runtime.resolve() / ("frozen" if args.phase == "formal" else "dev")
    ref = protocol["s2_ref"] if args.phase == "formal" else None
    if ref:
        frozen_sha = git("rev-parse", "--verify", f"{ref}^{{commit}}").decode().strip()
        for path in ("eval/protocol.json", "eval/harness/render_s2.py", "eval/harness/run.py",
                     "eval/harness/prepare_runner.py", "eval/harness/runner.ts"):
            if (ROOT / path).read_bytes() != git("show", f"{frozen_sha}:{path}"):
                parser.error(f"Frozen protocol or harness differs: {path}")
    if not (runtime / "manifest.json").exists():
        prepare(runtime, ref)
    manifest = load(runtime / "manifest.json")
    if ref and manifest["S2"]["commit"] != frozen_sha:
        parser.error("Frozen runtime manifest does not match s2-frozen")
    if not ref and manifest["S2"]["sourceSha256"] != source_digest(ROOT / "packages/lightclaw/src"):
        parser.error("S2 runtime is stale. Choose a fresh --runtime directory.")
    if any(row.get("adapterSha256") != digest(HERE / "runner.ts") for row in manifest.values()):
        parser.error("Stale Runner adapter. Choose a fresh --runtime directory.")
    versions = {
        "node": subprocess.check_output(["node", "--version"], cwd=ROOT, text=True).strip(),
        "python": sys.version.split()[0],
        "package_lock_sha256": digest(ROOT / "package-lock.json"),
        "layout_sha256": digest(HERE / "render_s2.py"),
        "matrix_sha256": digest(Path(__file__)),
        "parallelism": args.jobs,
        "limits": limits,
        "offpeak_budget": args.deepseek_offpeak_budget,
    }
    sources = {key: [row["sourceSha256"], row["adapterSha256"]] for key, row in manifest.items()}
    runtime_sha = hashlib.sha256(json.dumps([sources, versions], sort_keys=True).encode()).hexdigest()
    cases = [case for case in rows_for(cases_path) if case["split"] == stage["split"]]
    cases = choose_cases(cases, stage["items"], protocol["seed"], stage.get("categories", []))
    arms = ["S2"] if args.ablate else protocol["arm_order"]
    plan = [(case, arm, repeat) for repeat in range(stage["repeats"]) for case in cases for arm in arms]
    random.Random(protocol["seed"]).shuffle(plan)
    features = FEATURES - ({args.ablate} if args.ablate else set())
    phase = f"{args.phase}-ablate-{args.ablate}" if args.ablate else args.phase
    model_filename = re.sub(r"[^A-Za-z0-9._-]", "_", model)
    filename = (args.result or EVAL / "results" / f"{phase}-{args.model_slot}-{model_filename}.jsonl").resolve()
    if live and (filename.parent != EVAL / "results" or filename.suffix != ".jsonl" or filename.name.endswith(".private.jsonl")):
        parser.error("Paid traces must use eval/results/*.jsonl so all phases share one budget")
    filename.parent.mkdir(parents=True, exist_ok=True)
    inherited = {"PATH", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT"}
    if live:
        inherited |= {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
                      "http_proxy", "https_proxy", "all_proxy", "no_proxy"}
    env = {name: value for name, value in os.environ.items()
           if name in inherited or (live and name.startswith("LIGHTCLAW_EVAL_"))}
    env["TSX_TSCONFIG_PATH"] = str(runtime / "tsconfig.json")
    route_id = "faux"
    if live:
        probe = subprocess.run(["node", "--import", "tsx", str(runtime / "runner.ts"), "--preflight", args.route],
                               cwd=ROOT, env=env, text=True, capture_output=True, timeout=20, check=False)
        if probe.returncode:
            parser.error("Model preflight failed. Check the dedicated route, model ID, and explicit models file.")
        identity = json.loads(probe.stdout)
        models_file = env.get("LIGHTCLAW_EVAL_MODELS_FILE")
        route_id = hashlib.sha256(json.dumps([
            args.route, identity, env.get("LIGHTCLAW_EVAL_BASE_URL"), digest(Path(models_file)) if models_file else None
        ], sort_keys=True).encode()).hexdigest()
        if args.phase != "smoke":
            prior = "pilot" if args.phase == "formal" else "smoke"
            if not prior_stage_complete(prior, args.model_slot, model, route_id, protocol_sha, protocol,
                                        manifest["S2"]["sourceSha256"]):
                parser.error(f"Complete the live {prior} phase for this model slot before proceeding")
    # All paid phases share one lock and budget ledger, including separate model slots.
    lock = EVAL / ".runtime" / "matrix.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a") as mutex:
        fcntl.flock(mutex, fcntl.LOCK_EX | fcntl.LOCK_NB)
        recorded = rows_for(filename)
        done = {unit_key(row) for row in recorded}
        data = {}
        scheduled = []
        for case, arm, repeat in plan:
            fid = case["fixture"]
            if fid not in data:
                root = KIT / "testset/fixtures" / fid
                document = load(root / "facts.json")
                generated, mapping = render_s2(document, features=features & LAYOUT_FEATURES)
                maps = runtime / "fact-maps" / ("-".join(sorted(features)) or "off")
                maps.mkdir(parents=True, exist_ok=True)
                (maps / f"{fid}.json").write_text(json.dumps(mapping, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
                data[fid] = (document, fixture_files(root / "monolith"), fixture_files(root / "index_notes"), generated, mapping)
            document, mono, split, s2, mapping = data[fid]
            files = {"N": {}, "S0": mono, "S1": split, "S2": s2, "T": mono}.get(arm)
            if arm == "O":
                files = oracle(document, set(case["facts"]))
            row = {
                "protocol_sha": protocol_sha, "runtime_sha": runtime_sha, "commits": manifest,
                "phase": phase, "model_slot": args.model_slot, "model": model, "route": args.route,
                "route_id": route_id,
                "schedule_seed": protocol["seed"], "dependencies": versions,
                "case_id": case["id"], "arm": arm, "repeat": repeat, "size_kib": case["size_kib"],
                "category": case["category"], "meta": case["meta"], "features": sorted(features) if arm == "S2" else [],
            }
            if unit_key(row) not in done:
                scheduled.append((case, row, document, files, mapping))

        spent, pending = 0.0, set()
        if live:
            existing = set((EVAL / "results").glob("*.jsonl")) | {filename}
            spent, pending = budget_state(existing)
            estimate = sum(reserve(files, prices, limits) for _, _, _, files, _ in scheduled)
            with (EVAL / "cost_log.md").open("a", encoding="utf-8") as costs:
                costs.write(f"\n- {phase}/{args.model_slot}/{model}。待跑 {len(scheduled)} 项。未缓存峰价规划估计 {estimate:.2f} 元，"
                            f"累计预算计量 {spent:.4f} 元，80% 暂停线 {args.budget_cny * .8:.2f} 元。\n")
                if args.deepseek_offpeak_budget:
                    costs.write("  只有整个请求窗口都在官方空闲时段才按半价计预算，组间比较仍用统一峰值参考价。\n")
        def evaluate(item):
            case, row, document, files, mapping = item
            arm = row["arm"]
            gold = gold_reads(case, arm, mapping)
            should_lint = arm == "S2" and "i6" in features
            lint = lint_layout(files, mapping) if should_lint else []
            spec = {"variant": RUNTIME[arm], "prompt": case["question"], "files": files,
                    "channel": CHANNEL, "model": {"route": args.route}, "limits": limits}
            if not live:
                expected_good = case["id"] != cases[-1]["id"]
                turns = []
                note = next((path for path in sorted(files) if PurePosixPath(path).stem in gold), None)
                if note:
                    turns.append({"read": {"path": f"/workspace/{note}"}})
                turns.append({"text": case["golden"] if expected_good else case["bad"]})
                spec["model"]["turns"] = turns
            run_env = {**env, "MEMORY_FEATURES": ",".join(row["features"])}
            trace = invoke(runtime, spec, run_env, limits["runTimeoutMs"] / 1000 + 25)
            response = trace.get("response", "")
            reads = observed_reads(trace)
            passed = trace.get("stopReason") == "stop" and score(case["check"], response)
            cache_supported = args.route == "deepseek" or os.getenv("LIGHTCLAW_EVAL_CACHE_TELEMETRY") == "1"
            measured = cost(trace, prices) if live and cache_supported else None
            row.update({
                "trace": trace, "passed": passed, "cost_cny_peak_reference": measured, "budget_charge_cny": 0,
                "gold_reads": sorted(gold), "observed_reads": sorted(reads),
                "read_precision": len(gold & reads) / len(reads) if reads else None,
                "read_recall": len(gold & reads) / len(gold) if gold else None,
                "stale_hit": any(re.search(r"(?<!\w)" + re.escape(value) + r"(?!\w)", response) for value in stale_values(case, document)),
                "abstain_rejected": case["category"] == "abstain" and not passed,
                "lint_before": lint, "lint_after": lint_layout(files, mapping) if should_lint else [],
                "completed_unix": time.time(),
            })
            if not live and (passed != expected_good or not trace_complete(row)):
                raise RuntimeError(f"Faux smoke failed at {row['case_id']}/{arm}: stop={trace.get('stopReason')}, "
                                   f"score={passed}/{expected_good}, unchanged={trace.get('fixturesUnchanged')}")
            return row

        def save_result(output, i, row):
            trace = row["trace"]
            if not trace_complete(row):
                with (EVAL / ".runtime/failed-attempts.jsonl").open("a", encoding="utf-8") as errors:
                    append_row(errors, row)
                print(f"infrastructure checkpoint: {row['case_id']}/{row['arm']} not marked complete", flush=True)
                return False
            append_row(output, row)
            print(f"{i}/{len(scheduled)} {row['case_id']} {row['arm']} {trace.get('stopReason')} pass={row['passed']}", flush=True)
            return True

        def reservation_key(row):
            return hashlib.sha256(json.dumps(unit_key(row)).encode()).hexdigest()

        reservations = {}
        budget_block = None

        def admit(item):
            nonlocal spent, budget_block
            _, row, _, files, _ = item
            factor = 1
            if args.deepseek_offpeak_budget:
                factor = deepseek_budget_factor(datetime.now(SHANGHAI), limits["runTimeoutMs"] / 1000 + 30)
            guard = reserve(files, prices, limits) * factor
            key = reservation_key(row)
            if key in pending:
                budget_block = f"reconcile interrupted reservation {key} before retry"
                return False
            if spent + guard > args.budget_cny * .8:
                budget_block = "next reservation would cross the pause threshold"
                return False
            budget_event(args.route, "reserve", key, guard)
            spent += guard
            reservations[key] = guard
            row["budget_rate_factor"] = factor
            budget_block = None
            return True

        with filename.open("a", encoding="utf-8") as output:
            failed = False
            admission = admit if live and any(prices) else None
            results = parallel_results(scheduled, evaluate, trace_complete, args.jobs, admit=admission)
            for i, row in enumerate(results, 1):
                if not save_result(output, i, row):
                    failed = True
                    continue
                measured = row["cost_cny_peak_reference"]
                if admission is not None and measured is not None:
                    key = reservation_key(row)
                    charge = measured * row["budget_rate_factor"] - reservations.pop(key)
                    budget_event(args.route, "settle", key, charge)
                    spent += charge
            if failed:
                return 3
            if budget_block:
                print(f"budget checkpoint: {budget_block}. {spent:.4f} CNY accounted")
                return 2
    print(f"complete: {len(scheduled)} new rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
