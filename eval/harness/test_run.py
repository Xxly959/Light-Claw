import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from run import budget_state, cost, parallel_results


class MatrixBudgetTest(unittest.TestCase):
    def test_parallel_failure_drains_started_jobs_without_starting_more(self):
        started = []

        def launch(item):
            started.append(item)
            return {"item": item, "healthy": False}

        received = list(parallel_results(range(8), launch, lambda result: result["healthy"], 2))
        self.assertEqual(sorted(started), [0, 1])
        self.assertEqual(sorted(row["item"] for row in received), [0, 1])

    def test_reservations_survive_restart_and_share_other_phase_spend(self):
        with TemporaryDirectory() as directory:
            ledger = Path(directory) / "matrix.jsonl"
            writer = Path(directory) / "writer.jsonl"
            ledger.write_text("\n".join(json.dumps(row) for row in [
                {"route": "deepseek", "event": "reserve", "unit": "finished", "budget_charge_cny": 2},
                {"route": "deepseek", "event": "settle", "unit": "finished", "budget_charge_cny": -1.8},
                {"route": "deepseek", "event": "reserve", "unit": "interrupted", "budget_charge_cny": 3},
            ]))
            writer.write_text(json.dumps({"route": "configured", "budget_charge_cny": 1.5}))
            spent, pending = budget_state({ledger, writer}, ledger)
            self.assertAlmostEqual(spent, 4.7)
            self.assertEqual(pending, {"interrupted"})

    def test_missing_cache_telemetry_is_not_assumed_zero(self):
        trace = {"attempts": [{"input": 12, "cacheRead": None, "cacheWrite": 0, "output": 1}]}
        self.assertIsNone(cost(trace, (2, .04, 2, 8)))
