"""Score external QA checkpoints locally and export LongMemEval judge inputs.

MemoryAgentBench upstream post-processing and normalization
https://github.com/HUST-AI-HYZ/MemoryAgentBench/blob/538026089d1a8a8eff05121d0db89b388f360eba/utils/eval_other_utils.py

LongMemEval upstream judge input contract
https://github.com/xiaowu0162/LongMemEval/blob/d6dc8b50a2d9ac0c99485ea28fa5755c62414c34/src/evaluation/evaluate_qa.py
"""

import argparse
from collections import Counter, defaultdict
import hashlib
from itertools import chain
import json
from pathlib import Path
import re
import string

from external_qa import VARIANTS, addressed_jsonl, dispatch_specs, verified_bytes
from external_writer import DATASETS, EXTERNAL, canonical, digest, write_json


MAB_REVISION = "538026089d1a8a8eff05121d0db89b388f360eba"
LME_JUDGE_REVISION = "d6dc8b50a2d9ac0c99485ea28fa5755c62414c34"
FACT = "memoryagentbench_factconsolidation"
EVENT = "memoryagentbench_eventqa"
LONGMEM = "longmemeval_s"
MAB = {FACT, EVENT}
ASCII_PUNCTUATION = str.maketrans("", "", string.punctuation)
ANSWER_LINE = re.compile(r"Answer:(.*)(?:\n|$)", re.IGNORECASE)
REPEATED_PREFIX = re.compile(r"^Answer:", re.IGNORECASE)


def normalize(text):
    without_punctuation = text.lower().translate(ASCII_PUNCTUATION)
    without_articles = re.sub(r"\b(?:a|an|the)\b", " ", without_punctuation)
    return " ".join(without_articles.split())


def mab_match(dataset, hypothesis, answers):
    if dataset not in MAB:
        raise ValueError("Unsupported MemoryAgentBench source")
    if isinstance(answers, str):
        aliases = [answers]
    elif isinstance(answers, list) and answers and all(isinstance(group, list) for group in answers):
        aliases = list(chain.from_iterable(answers))
    else:
        aliases = answers
    if not isinstance(aliases, list) or not aliases or any(not isinstance(alias, str) for alias in aliases):
        raise ValueError("MemoryAgentBench requires a nonempty set of string aliases")

    answer_line = ANSWER_LINE.search(hypothesis)
    extracted = answer_line[1] if answer_line else hypothesis.partition("\n")[0]
    parsed = normalize(REPEATED_PREFIX.sub("", extracted.strip()))
    # EventQA uses only the parsed answer for SubEM. FactConsolidation uses the better of raw and parsed.
    predictions = (parsed,) if dataset == EVENT else (normalize(hypothesis), parsed)
    return any(normalize(alias) in prediction for alias in aliases for prediction in predictions)


def reference_rows(root, plan):
    descriptor = plan["references"]
    lines = verified_bytes(root, descriptor, ".").splitlines()
    if len(lines) != descriptor["rows"]:
        raise ValueError("QA reference row count differs from the plan")
    references = {}
    by_dataset = Counter()
    for line in lines:
        row = json.loads(line)
        case = row["case_id"]
        if case in references or row["dataset"] not in DATASETS or row["dataset"] not in plan["datasets"]:
            raise ValueError("Duplicate or unknown evaluator reference")
        references[case] = row
        by_dataset[row["dataset"]] += 1
    if any(by_dataset[name] != entry["ready_questions"] for name, entry in plan["datasets"].items()):
        raise ValueError("QA reference dataset coverage differs from the plan")
    return references


def response_for(profile_dir, identity):
    if profile_dir is None:
        return "unattempted", None
    path = profile_dir / (digest(canonical(identity)) + ".json")
    if not path.is_file():
        return "unattempted", None
    if path.is_symlink():
        raise ValueError("QA response checkpoint cannot be a symlink")
    response = json.loads(path.read_bytes())
    if response.get("identity") != identity or response.get("status") not in {"started", "complete", "failed"}:
        raise ValueError("QA response checkpoint differs from its dispatch")
    status = response["status"]
    if status != "complete":
        return "unresolved" if status == "started" else status, None
    hypothesis = response.get("hypothesis")
    if response.get("stop_reason") != "stop" or not isinstance(hypothesis, str) or not hypothesis.strip():
        raise ValueError("Complete QA response has no valid stopped hypothesis")
    return status, hypothesis


def summarize_arm(dataset, selection, counts):
    ready, pending = selection["ready_questions"], selection["pending_questions"]
    total = ready + pending
    complete = counts["complete"]
    scored = counts["scored"]
    if not complete:
        status = "pending_writer" if not ready and pending else "no_completed_responses"
    elif dataset in MAB:
        status = "sample_scored" if scored == total else "partial_score"
    elif dataset == LONGMEM:
        status = "judge_input_ready" if complete == total else "judge_input_partial"
    else:
        status = "scorer_pending"
    return {
        "status": status, "selected": total, "ready": ready, "pending_writer": pending,
        "completed": complete, "failed": counts["failed"], "unresolved": counts["unresolved"],
        "unattempted": counts["unattempted"], "scored": scored, "correct": counts["correct"],
        "accuracy_on_scored": counts["correct"] / scored if scored else None,
    }


def score_qa(root, profile, output):
    profile_dir = None
    if profile is not None:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", profile):
            raise ValueError("Invalid external QA response profile")
        profile_dir = root / "responses" / profile
        if not profile_dir.is_dir() or profile_dir.is_symlink():
            raise ValueError("External QA response profile does not exist")
    raw_plan = (root / "plan.json").read_bytes()
    plan = json.loads(raw_plan)
    references = reference_rows(root, plan)
    seen = set()
    stats = defaultdict(Counter)
    mab_scores = []
    judge_rows = defaultdict(dict)
    for identity, _ in dispatch_specs(root, plan):
        case, arm = identity["case_id"], identity["arm"]
        if case not in references:
            raise ValueError("A QA dispatch has no matching evaluator reference")
        seen.add(case)
        reference = references[case]
        dataset = reference["dataset"]
        status, hypothesis = response_for(profile_dir, identity)
        counts = stats[dataset, arm]
        counts[status] += 1
        if status != "complete":
            continue
        if dataset in MAB:
            correct = mab_match(dataset, hypothesis, reference["answers"])
            counts["scored"] += 1
            counts["correct"] += correct
            mab_scores.append({"case_id": case, "arm": arm, "dataset": dataset, "source": reference["source"],
                               "qa_pair_id": reference["qa_pair_id"], "substring_exact_match": correct})
        elif dataset == LONGMEM:
            qid = reference["question_id"]
            if qid in judge_rows[arm]:
                raise ValueError("Duplicate LongMemEval question ID in one arm")
            judge_reference = {key: reference[key] for key in ("question_id", "question_type", "question", "answer")}
            judge_rows[arm][qid] = ({"question_id": qid, "hypothesis": hypothesis}, judge_reference)
    if seen != references.keys():
        raise ValueError("An evaluator reference has no matching QA dispatch")

    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    judge_exports = {}
    for arm, rows in judge_rows.items():
        hypotheses, judge_references = zip(*rows.values(), strict=True)
        judge_exports[arm] = {
            "status": "awaiting_official_judge",
            "hypotheses": addressed_jsonl(output, f"longmemeval-{arm}-hypotheses", hypotheses),
            "references": addressed_jsonl(output, f"longmemeval-{arm}-references", judge_references),
        }
    report = {
        "schema_version": 1, "qa_plan_sha256": hashlib.sha256(raw_plan).hexdigest(), "response_profile": profile,
        "provider_calls": 0, "mab_scorer_revision": MAB_REVISION, "longmemeval_judge_revision": LME_JUDGE_REVISION,
        "datasets": {dataset: {"arms": {arm: summarize_arm(dataset, selection, stats[dataset, arm]) for arm in VARIANTS}}
                     for dataset, selection in plan["datasets"].items()},
        "mab_scores": mab_scores, "longmemeval_exports": judge_exports,
    }
    write_json(output / "report.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qa-root", type=Path, default=EXTERNAL / "qa")
    parser.add_argument("--profile", help="One explicit QA response profile to score")
    parser.add_argument("--output", type=Path, help="Private output directory for report and judge exports")
    args = parser.parse_args()
    if args.profile and not re.fullmatch(r"[A-Za-z0-9_-]+", args.profile):
        parser.error("Invalid external QA response profile")
    output = args.output or args.qa_root / "scored" / (args.profile or "no-profile")
    try:
        report = score_qa(args.qa_root, args.profile, output)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))
    print(canonical({"report": str(output / "report.json"), "provider_calls": 0,
                     "mab_responses_scored": len(report["mab_scores"]),
                     "longmemeval_arms_exported": list(report["longmemeval_exports"])}))


if __name__ == "__main__":
    main()
