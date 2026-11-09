"""Prepare external QA dispatches from verified history-only writer corpora."""

import argparse
from collections import Counter
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
from tempfile import NamedTemporaryFile

from external_writer import (
    DATASETS, EXTERNAL, ROOT, RUNNER_LOCK, artifact_path, build_plan, canonical, chunk_history, digest,
    history_segments, merge_corpus, runtime_profile, validate_candidates, write_json,
)
from prepare_runner import BASE_REFS, SOURCE, source_digest
from render_s2 import CHANNEL, render_s2
from run import FEATURES, invoke


VARIANTS = {"N": "S1", "S0": "S0", "S1": "S1", "S2": "S2"}
SCORERS = {
    "longmemeval_s": "longmemeval_official_judge_pending",
    "memoryagentbench_factconsolidation": "memoryagentbench_substring_exact_match_pending",
    "memoryagentbench_eventqa": "memoryagentbench_substring_exact_match_pending",
    "locomo": "locomo_official_qa_scorer_pending",
}
WRITER_ROUTES = {"configured", "deepseek"}
MEMORY_FIELDS = ("text", "fragment", "quote", "supersedes")
MAX_NEW_RUNS = 16


def project_questions(dataset, row):
    """Project query prompts and evaluator records without attaching either to memory."""
    if dataset not in DATASETS:
        raise ValueError("Unsupported external benchmark")
    source_id = row["source_id"]
    record = row["record"]
    if dataset == "longmemeval_s":
        if record["question_id"] != source_id:
            raise ValueError("LongMemEval question ID differs from its prepared source ID")
        date = record["question_date"]
        yield (
            {"prompt": f"Question date: {date}\n\n{record['question']}"},
            {"question_id": source_id, "question_type": record["question_type"], "question_date": date,
             "question": record["question"], "answer": record["answer"], "abstention": source_id.endswith("_abs"),
             "answer_session_ids": record["answer_session_ids"]},
        )
        return

    indices = row["question_indices"]
    if dataset == "locomo":
        if record["sample_id"] != source_id:
            raise ValueError("LoCoMo sample ID differs from its prepared source ID")
        for index in indices:
            qa = record["qa"][index]
            category = qa["category"]
            if category not in range(1, 6) or (category != 5 and "answer" not in qa):
                raise ValueError("Invalid LoCoMo QA reference")
            yield (
                {"prompt": qa["question"]},
                {"sample_id": source_id, "question_index": index, "category": category,
                 "question": qa["question"], "answer": qa.get("answer"), "abstention": category == 5,
                 "evidence": qa.get("evidence", []), "adversarial_answer": qa.get("adversarial_answer")},
            )
        return

    questions, answers, metadata = record["questions"], record["answers"], record["metadata"]
    ids = metadata["qa_pair_ids"]
    if not len(questions) == len(answers) == len(ids):
        raise ValueError("MemoryAgentBench question, answer and ID arrays are misaligned")
    for index in indices:
        question = questions[index]
        prompt = question
        if dataset == "memoryagentbench_factconsolidation":
            prompt = f"If statements conflict, use the later statement.\n\n{question}"
        yield (
            {"prompt": prompt},
            {"qa_pair_id": ids[index], "question_index": index, "source": metadata["source"],
             "question": question, "answers": answers[index]},
        )


def writer_plan_entries(manifest_path, writer_plan_path):
    if not writer_plan_path.exists():
        return {}, None, None
    raw = writer_plan_path.read_bytes()
    plan = json.loads(raw)
    names = tuple(dict.fromkeys(episode["dataset"] for episode in plan["episodes"]))
    if not names or not set(names) <= set(DATASETS):
        raise ValueError("Unknown or empty external writer plan")
    cap = plan["chunk_history_byte_cap"]
    if type(cap) is not int or not 256 <= cap <= 256 * 1024:
        raise ValueError("Invalid external writer chunk cap")
    if plan != build_plan(manifest_path, names, cap):
        raise ValueError("The writer plan differs from the prepared history or writer configuration")
    entries = {(episode["dataset"], episode["source_id"]): episode for episode in plan["episodes"]}
    return entries, cap, hashlib.sha256(raw).hexdigest()


def verified_corpus(state, plan, dataset, record, cap):
    if plan is None:
        return "pending_writer_plan", None, None
    key = plan["corpus_plan_key"]
    path = state / "corpora" / f"{key}.json" if state else None
    if path is None or not path.is_file():
        return "pending_writer_corpus", None, None
    corpus = json.loads(path.read_bytes())
    if corpus.get("synthetic_only") is True:
        return "synthetic_writer_corpus", None, None

    chunks = chunk_history(history_segments(dataset, record), cap)
    receipts = []
    for chunk, expected in zip(chunks, plan["chunks"], strict=True):
        request = expected["request_sha256"]
        receipt_path = state / "receipts" / f"{request}.json"
        if not receipt_path.is_file():
            raise ValueError("Complete writer corpus has a missing receipt")
        receipt = json.loads(receipt_path.read_bytes())
        if receipt.get("status") != "complete" or receipt.get("request_sha256") != request or receipt.get("route") not in WRITER_ROUTES:
            raise ValueError("Invalid external writer receipt")
        source_items = [{field: item[field] for field in MEMORY_FIELDS if field in item} for item in receipt["memories"]]
        if receipt["memories"] != validate_candidates({"memories": source_items}, chunk):
            raise ValueError("Writer receipt differs from source-validated memories")
        receipts.append(receipt)
    routes = {receipt["route"] for receipt in receipts}
    if len(routes) != 1 or corpus != merge_corpus(key, receipts, receipts[0]["route"]):
        raise ValueError("Writer corpus differs from complete validated receipts")
    return "ready", corpus, receipts[0]["route"]


def shared_layout(corpus):
    facts = []
    for order, row in enumerate(corpus["memories"], 1):
        session = row["session"]
        if not re.fullmatch(r"(?:session|document)-\d{3,}", session):
            raise ValueError("Invalid external history session ordinal")
        timestamp = row["timestamp"]
        speaker = " ".join(row["speaker"].split())
        text = " ".join(row["text"].split())
        line = f"{speaker}: {text}"
        if timestamp:
            date = " ".join(timestamp.split())
            line = f"[{date}] {line}"
        facts.append({"id": row["id"], "scope": "channel", "kind": "fact", "order": order,
                      "topic": session, "text": line})

    document = {"facts": facts}
    plain = {f"{CHANNEL}/MEMORY.md": "# Memory\n\n" + "".join(f"- {fact['text']}\n" for fact in facts)}
    baseline, _ = render_s2(document, features=set())
    bounded, _ = render_s2(document)
    return {"N": {}, "S0": plain, "S1": baseline, "S2": bounded}


def addressed_json(output, directory, value):
    checksum = digest(canonical(value) + "\n")
    path = Path(directory) / f"{checksum}.json"
    write_json(output / path, value)
    return {"path": path.as_posix(), "sha256": checksum}


def addressed_jsonl(output, label, values):
    text = "".join(canonical(value) + "\n" for value in values)
    checksum = digest(text)
    path = Path(f"{label}-{checksum}.jsonl")
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=output, delete=False) as stream:
        staged = Path(stream.name)
        try:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
            staged.replace(output / path)
        finally:
            staged.unlink(missing_ok=True)
    return {"path": path.as_posix(), "sha256": checksum, "rows": len(values)}


def prepare_qa(manifest_path, writer_plan_path, writer_state, output, datasets):
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest["schema_version"] != 1:
        raise ValueError("Unsupported prepared manifest version")
    writer_plan, cap, writer_plan_sha = writer_plan_entries(manifest_path, writer_plan_path)
    dispatches = []
    references = []
    episodes = []
    coverage = {}
    writer_routes = set()
    for dataset in dict.fromkeys(datasets):
        entry = manifest["datasets"][dataset]
        if entry["status"] != "prepared":
            raise ValueError(f"Dataset is not prepared: {dataset}")
        raw = artifact_path(manifest_path, entry).read_bytes()
        if hashlib.sha256(raw).hexdigest() != entry["artifact_sha256"]:
            raise ValueError(f"Prepared QA artifact digest differs for {dataset}")
        counts = Counter()
        ready = 0
        total = 0
        seen = set()
        for line in raw.splitlines():
            row = json.loads(line)
            source_id = row["source_id"]
            if not isinstance(source_id, str) or not source_id or source_id in seen:
                raise ValueError(f"Invalid or duplicate prepared QA source ID for {dataset}")
            seen.add(source_id)
            if dataset == "longmemeval_s":
                indices = [0]
            else:
                indices = row["question_indices"]
                if not indices or any(type(index) is not int or index < 0 for index in indices) or indices != sorted(set(indices)):
                    raise ValueError("Prepared QA indices must be sorted, distinct and nonnegative")
            status, corpus, route = verified_corpus(writer_state, writer_plan.get((dataset, source_id)), dataset, row["record"], cap)
            counts[status] += 1
            total += len(indices)
            episode_id = digest(canonical([dataset, source_id]))
            episode = {"dataset": dataset, "episode_id": episode_id, "status": status, "questions": len(indices)}
            episodes.append(episode)
            if corpus is None:
                continue
            writer_routes.add(route)
            if len(writer_routes) != 1:
                raise ValueError("QA plan cannot combine corpora from different writer routes")

            layout = addressed_json(output, "layouts", {"channel": CHANNEL, "files_by_arm": shared_layout(corpus)})
            episode["layout"] = layout
            episode["memory_facts"] = len(corpus["memories"])
            episode["corpus_sha256"] = digest(canonical(corpus) + "\n")
            for index, (dispatch, reference) in zip(indices, project_questions(dataset, row), strict=True):
                case_id = digest(canonical([episode_id, index]))
                dispatches.append({"case_id": case_id, "layout": layout, **dispatch})
                references.append({"case_id": case_id, "dataset": dataset, "scorer": SCORERS[dataset], **reference})
                ready += 1
        if sum(counts.values()) != entry["episodes"] or total != entry["questions"]:
            raise ValueError(f"Prepared QA selection counts differ for {dataset}")
        coverage[dataset] = {"episodes_by_status": dict(counts), "ready_questions": ready, "pending_questions": total - ready}

    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    plan = {
        "schema_version": 1,
        "prepared_manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "writer_plan_sha256": writer_plan_sha,
        "writer_profile": writer_state.name if writer_state else None,
        "writer_route": next(iter(writer_routes), None),
        "variants": VARIANTS,
        "layout_profile": "Chronological source-session notes with no inferred supersession edges",
        "datasets": coverage,
        "episodes": episodes,
        "dispatch": addressed_jsonl(output, "dispatch", dispatches),
        "references": addressed_jsonl(output, "references", references),
    }
    write_json(output / "plan.json", plan)
    return plan


def verified_bytes(output, descriptor, directory):
    root = (output / directory).resolve()
    path = (output / descriptor["path"]).resolve()
    if path.parent != root:
        raise ValueError("QA artifact is outside its designated directory")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != descriptor["sha256"]:
        raise ValueError("QA artifact SHA-256 differs from the plan")
    return data


def dispatch_specs(output, plan):
    if plan.get("schema_version") != 1 or plan.get("variants") != VARIANTS:
        raise ValueError("Unsupported QA dispatch plan")
    if plan["dispatch"]["rows"] and plan.get("writer_route") not in WRITER_ROUTES:
        raise ValueError("QA dispatch requires validated non-faux writer corpora")
    dispatch = verified_bytes(output, plan["dispatch"], ".").splitlines()
    if len(dispatch) != plan["dispatch"]["rows"]:
        raise ValueError("QA dispatch row count differs from the plan")
    seen = set()
    layouts = {}
    for line in dispatch:
        row = json.loads(line)
        if set(row) != {"case_id", "layout", "prompt"} or row["case_id"] in seen:
            raise ValueError("Invalid or duplicate QA dispatch row")
        seen.add(row["case_id"])
        layout_sha = row["layout"]["sha256"]
        if layout_sha not in layouts:
            layout = json.loads(verified_bytes(output, row["layout"], "layouts"))
            if set(layout) != {"channel", "files_by_arm"} or layout["channel"] != CHANNEL or set(layout["files_by_arm"]) != set(VARIANTS):
                raise ValueError("Invalid shared QA layout")
            layouts[layout_sha] = layout
        layout = layouts[layout_sha]
        if not isinstance(row["prompt"], str) or not row["prompt"].strip():
            raise ValueError("QA prompt must be nonempty text")
        for arm, variant in VARIANTS.items():
            identity = {"case_id": row["case_id"], "arm": arm, "layout_sha256": layout_sha,
                        "prompt_sha256": digest(row["prompt"]), "route": "configured"}
            spec = {"variant": variant, "prompt": row["prompt"], "files": layout["files_by_arm"][arm],
                    "channel": CHANNEL, "model": {"route": "configured"}}
            yield identity, spec


def dispatch_batch(output, plan, profile, max_new, runner):
    """Checkpoint a bounded batch. An interrupted request requires manual reconciliation."""
    if type(max_new) is not int or not 1 <= max_new <= MAX_NEW_RUNS or not re.fullmatch(r"[A-Za-z0-9_-]+", profile):
        raise ValueError("Invalid QA dispatch cap or profile")
    scheduled = list(dispatch_specs(output, plan))
    counts = {"dispatched": 0, "reused": 0, "failed": 0}
    for identity, spec in scheduled:
        key = digest(canonical(identity))
        path = output / "responses" / profile / f"{key}.json"
        if path.is_file():
            previous = json.loads(path.read_bytes())
            if previous.get("identity") != identity or previous.get("status") not in {"started", "complete", "failed"}:
                raise ValueError("QA response checkpoint differs from its dispatch")
            if previous["status"] == "started":
                return {**counts, "checkpoint": "unresolved_dispatch"}
            counts["reused"] += 1
            continue
        if counts["dispatched"] >= max_new:
            return {**counts, "checkpoint": "batch_limit"}
        write_json(path, {"identity": identity, "status": "started"})
        trace = runner(spec)
        complete = (trace.get("stopReason") == "stop" and trace.get("fixturesUnchanged") is True
                    and isinstance(trace.get("response"), str) and bool(trace["response"].strip()))
        write_json(path, {
            "identity": identity, "status": "complete" if complete else "failed",
            "hypothesis": trace.get("response") if complete else None,
            "stop_reason": trace.get("stopReason"), "latency_ms": trace.get("latencyMs"),
            "attempts": trace.get("attempts", []), "tool_calls": len(trace.get("tools", [])),
            "usage_incomplete": trace.get("usageIncomplete", True), "judge_status": "not_scored",
        })
        counts["dispatched"] += 1
        if not complete:
            counts["failed"] += 1
            return {**counts, "checkpoint": "runner_failure"}
    return {**counts, "checkpoint": "complete"}


def configured_batch(output, plan, runtime, max_new):
    # Dispatch uses a separate diagnostic scope and the matrix lock. It shares no synthetic result files.
    allowed = {"PATH", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
               "https_proxy", "http_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS"}
    env = {name: value for name, value in os.environ.items() if name in allowed or name.startswith("LIGHTCLAW_EVAL_")}
    rates = env.get("LIGHTCLAW_EVAL_CNY_PER_MILLION", "")
    try:
        parsed_rates = tuple(float(part) for part in rates.split(","))
    except ValueError:
        parsed_rates = ()
    if parsed_rates != (0, 0, 0, 0):
        raise ValueError("External QA dispatch requires four explicit zero configured-route CNY rates")
    if not all(env.get(f"LIGHTCLAW_EVAL_{name}", "").strip() for name in ("API_KEY", "PROVIDER", "MODEL_ID")):
        raise ValueError("External QA dispatch requires a dedicated evaluation credential, provider and model")
    env["TSX_TSCONFIG_PATH"] = str(runtime / "tsconfig.json")
    runtime_id = runtime_profile(runtime, "configured", env, None)
    manifest = json.loads((runtime / "manifest.json").read_bytes())
    if manifest["S0"]["commit"] != BASE_REFS["S0"] or any(
        manifest[arm]["sourceSha256"] != source_digest(runtime / arm / SOURCE) for arm in ("S0", "S2")
    ):
        raise ValueError("External QA runtime sources differ from the manifest")
    limits = json.loads((ROOT / "eval" / "protocol.json").read_bytes())["limits"]
    profile = digest(canonical({"runtime": runtime_id, "writer_profile": plan["writer_profile"],
                                "features": sorted(FEATURES), "limits": limits,
                                "dispatcher": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}))

    def runner(spec):
        runner_env = {**env, "MEMORY_FEATURES": ",".join(sorted(FEATURES)) if spec["variant"] == "S2" else ""}
        return invoke(runtime, {**spec, "limits": limits}, runner_env, limits["runTimeoutMs"] / 1000 + 25)

    RUNNER_LOCK.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with RUNNER_LOCK.open("a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"dispatched": 0, "checkpoint": "matrix_lock_busy"}
        profile_path = output / "responses" / profile / "profile.json"
        write_json(profile_path, {"scope": "bounded_external_qa_diagnostic", "route": "configured",
                                  "provider": env["LIGHTCLAW_EVAL_PROVIDER"], "model": env["LIGHTCLAW_EVAL_MODEL_ID"],
                                  "writer_profile": plan["writer_profile"],
                                  "runtime_id": runtime_id, "runtime_commits": manifest, "limits": limits,
                                  "features": sorted(FEATURES), "declared_cny_per_million": parsed_rates})
        return {"profile": profile, **dispatch_batch(output, plan, profile, max_new, runner)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--plan", action="store_true", help="Only prepare local QA inputs")
    mode.add_argument("--run", action="store_true", help="Dispatch a bounded diagnostic from an existing plan")
    parser.add_argument("--manifest", type=Path, default=EXTERNAL / "manifest.json")
    parser.add_argument("--writer-plan", type=Path, default=EXTERNAL / "writer" / "plan.json")
    parser.add_argument("--writer-state", type=Path, help="One fixed writer profile directory with corpora and receipts")
    parser.add_argument("--output", type=Path, default=EXTERNAL / "qa")
    parser.add_argument("--dataset", choices=DATASETS, action="append")
    parser.add_argument("--runtime", type=Path, help="Existing fixed Runner runtime for dispatch")
    parser.add_argument("--max-new-runs", type=int, help=f"Bound new configured-route dispatches from 1 to {MAX_NEW_RUNS}")
    args = parser.parse_args()
    if args.plan:
        plan = prepare_qa(args.manifest, args.writer_plan, args.writer_state, args.output, args.dataset or DATASETS)
        print(canonical({"plan": str(args.output / "plan.json"), "provider_calls": 0, "datasets": plan["datasets"]}))
        return 0
    if not args.runtime or args.max_new_runs is None or not 1 <= args.max_new_runs <= MAX_NEW_RUNS:
        parser.error("--run requires --runtime and --max-new-runs in the supported range")
    plan = json.loads((args.output / "plan.json").read_bytes())
    if not plan["dispatch"]["rows"]:
        print(canonical({"dispatched": 0, "checkpoint": "no_ready_writer_corpus"}))
        return 2
    try:
        result = configured_batch(args.output, plan, args.runtime.resolve(), args.max_new_runs)
    except (OSError, ValueError, KeyError) as error:
        parser.error(str(error))
    print(canonical(result))
    return 0 if result["checkpoint"] in {"complete", "batch_limit"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
