import json
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from zoneinfo import ZoneInfo

from run import budget_state, cost, deepseek_budget_factor, effective_limits, parallel_results


class MatrixBudgetTest(unittest.TestCase):
    def test_deepseek_half_rate_requires_entire_window_off_peak(self):
        zone = ZoneInfo("Asia/Shanghai")
        self.assertEqual(deepseek_budget_factor(datetime(2026, 11, 9, 18, 0, tzinfo=zone), 325), 0.5)
        self.assertEqual(deepseek_budget_factor(datetime(2026, 11, 9, 17, 59, tzinfo=zone), 325), 1)
        self.assertEqual(deepseek_budget_factor(datetime(2026, 11, 9, 8, 58, tzinfo=zone), 325), 1)
        self.assertEqual(deepseek_budget_factor(datetime(2026, 11, 8, 11, 59, tzinfo=zone), 325), 0.5)

    def test_smoke_can_extend_run_limit_without_changing_attempt_or_formal_limits(self):
        defaults = {"runTimeoutMs": 220000, "attemptTimeoutMs": 90000}
        self.assertEqual(effective_limits(defaults, "smoke", 300),
                         {"runTimeoutMs": 300000, "attemptTimeoutMs": 90000})
        self.assertEqual(effective_limits(defaults, "formal", None), defaults)
        self.assertEqual(defaults["runTimeoutMs"], 220000)
        with self.assertRaisesRegex(ValueError, "smoke"):
            effective_limits(defaults, "formal", 300)

    def test_parallel_failure_drains_started_jobs_without_starting_more(self):
        started = []

        def launch(item):
            started.append(item)
            return {"item": item, "healthy": False}

        received = list(parallel_results(range(8), launch, lambda result: result["healthy"], 2))
        self.assertEqual(sorted(started), [0, 1])
        self.assertEqual(sorted(row["item"] for row in received), [0, 1])

    def test_parallel_admission_retries_same_item_after_settlement(self):
        reserved = set()
        completed = []

        def admit(item):
            if reserved or item == 3:
                return False
            reserved.add(item)
            return True

        def launch(item):
            self.assertIn(item, reserved)
            return item

        for item in parallel_results(range(5), launch, lambda _: True, 4, admit=admit):
            reserved.remove(item)
            completed.append(item)
        self.assertEqual(completed, [0, 1, 2])


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
