"""Resume the original sequential M1 pilot after a verified local cap checkpoint."""

import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import runpy
import sys
from tempfile import NamedTemporaryFile

from prepare_runner import git
from run import (
    EVAL, HERE, PRICES, SPEND, append_row, budget_event, cost,
    normalize_local_round_cap, rows_for, trace_complete, unit_key,
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix-ref", required=True)
    parser.add_argument("--result", required=True, type=Path)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--budget-cny", required=True, type=float)
    args = parser.parse_args()
    result = args.result.resolve()
    if result.parent != EVAL / "results" or not result.is_file():
        parser.error("Select an existing pilot checkpoint under eval/results")

    source = git("show", f"{args.matrix_ref}:eval/harness/run.py")
    source_hash = hashlib.sha256(source).hexdigest()
    with (EVAL / ".runtime/matrix.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        history = rows_for(result)
        last = rows_for(EVAL / ".runtime/failed-attempts.jsonl")[-1]
        if any(row["phase"] != "pilot" or row["runtime_sha"] != last["runtime_sha"]
               or row["dependencies"]["matrix_sha256"] != source_hash for row in [*history, last]):
            parser.error("The failed row and results do not share the requested pinned pilot")
        if last["model_slot"] != "M1" or last["route"] != "deepseek" or last["model"] not in PRICES or last["passed"] is not False:
            parser.error("The recovery requires a failed official DeepSeek M1 row")
        trace = normalize_local_round_cap(last["trace"])
        corrected = {**last, "trace": trace, "cost_cny_peak_reference": cost(trace, PRICES[last["model"]])}
        if trace is last["trace"] or not trace_complete(corrected):
            parser.error("The trace does not establish a local-only cap and complete provider usage")

        unit = unit_key(last)
        key = hashlib.sha256(json.dumps(unit).encode()).hexdigest()
        ledger = [row for row in rows_for(SPEND) if row["unit"] == key]
        if not ledger or ledger[0]["event"] != "reserve":
            parser.error("The failed paid row has no matching reservation")
        if all(unit_key(row) != unit for row in history):
            with result.open("a", encoding="utf-8") as output:
                append_row(output, corrected)
        if ledger[-1]["event"] == "reserve":
            charge = corrected["cost_cny_peak_reference"] - ledger[-1]["budget_charge_cny"]
            budget_event(last["route"], "settle", key, charge)
        print(f"checkpoint retained: {last['case_id']}/{last['arm']} stopped at the local round cap", flush=True)

    # Execute the original bytes so the schedule, limits and resume identity stay pinned.
    # Only the returned audit representation of a local rejection is normalized.
    with NamedTemporaryFile(dir=HERE, prefix=".pinned-matrix-", suffix=".py") as script:
        script.write(source)
        script.flush()
        pinned = runpy.run_path(script.name)["main"]
        namespace = pinned.__globals__
        invoke = namespace["invoke"]
        namespace["invoke"] = lambda *values: normalize_local_round_cap(invoke(*values))
        sys.argv = [script.name, "--phase", "pilot", "--route", "deepseek", "--result", str(result),
                    "--runtime", str(args.runtime), "--budget-cny", str(args.budget_cny)]
        return pinned()


if __name__ == "__main__":
    raise SystemExit(main())
