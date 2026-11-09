"""Reproduce the offline scorer, diagnosis, fixtures and Runner smoke."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
KIT = ROOT / "eval/memory_eval_kit"


def run(*args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, check=True)


def main():
    run(sys.executable, "scorer.py", "--selftest", "testset/cases.jsonl", cwd=KIT)
    run("node", "--disable-warning=ExperimentalWarning", "eval/harness/diagnose_offline.mjs")
    run(sys.executable, "-m", "unittest", "discover", "-s", "eval/harness", "-p", "test_*.py")
    run(sys.executable, "eval/harness/layout_summary.py")
    run(sys.executable, "eval/harness/run.py")
    run(sys.executable, "eval/harness/analyze.py", "--output", "eval/results/analysis.json", "--figures", "eval/figures")


if __name__ == "__main__":
    main()
