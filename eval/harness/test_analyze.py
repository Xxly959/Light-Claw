import copy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from analyze import Figure, analyze, bootstrap, evaluate_c6, mcnemar, write_figures


PROTOCOL = json.loads((Path(__file__).resolve().parents[1] / "protocol.json").read_text())
SHA = "test-protocol"
CASE_TYPES = ["index_hit"] * 4 + ["note_needed"] * 4 + ["multi_hop"] * 3 + ["abstain"] * 3 + ["update"] * 4 + ["position"] * 3 + ["irrelevant"] * 3 + ["implicit_rule"] * 5


def row(arm, size, index, repeat, *, model="real-id", slot="M1", phase="formal", route="configured"):
    category = CASE_TYPES[index]
    target = category in {"update", "implicit_rule", "position"}
    return {
        "protocol_sha": SHA, "runtime_sha": "runtime", "phase": phase,
        "model_slot": slot, "model": model, "route": route,
        "case_id": f"{size}-{index}", "arm": arm, "repeat": repeat,
        "category": category, "size_kib": size,
        "meta": {"s1_index_cut": index % 2 == 0},
        "features": ["i4"] if arm == "S2" else [],
        "trace": {"latencyMs": 10 + repeat, "tools": [], "rounds": 1, "stopReason": "stop"},
        "passed": not (target and size >= 64 and arm != "S2"),
        "stale_hit": category == "update" and arm == "S1",
        "abstain_rejected": False,
        "cost_cny_peak_reference": {"S1": 0.7, "S2": 0.77}.get(arm, 1.0),
        "read_precision": 1.0, "read_recall": 0.5,
    }


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.protocol = copy.deepcopy(PROTOCOL)
        self.protocol["bootstrap_repeats"] = 1000

    def matrix(self):
        return [row(arm, size, index, repeat) for arm in PROTOCOL["arm_order"]
                for size in (12, 32, 64, 128) for index in range(29) for repeat in range(5)]

    def test_paired_bootstrap_uses_item_clusters(self):
        result = bootstrap([1, -1], repeats=10000, seed=900, alpha=0.05)
        self.assertEqual(result, {"n_items": 2, "delta": 0, "ci": [-1, 1]})

    def test_mcnemar_takes_one_majority_decision_per_item(self):
        wins = ([True, True, True, False, False], [False, False, False, True, True])
        ties = ([False] * 5, [False] * 5)
        result = mcnemar([wins] * 6 + [ties])
        self.assertEqual(result, {"candidate_only": 6, "reference_only": 0, "p_exact": 0.03125})

    def test_budget_ledger_events_are_not_evaluation_rows(self):
        rows = [row("S0", 12, 0, 0, phase="smoke"),
                {"route": "deepseek", "event": "reserve", "budget_charge_cny": 1},
                {"route": "deepseek", "event": "settle", "budget_charge_cny": -0.9}]
        counts = analyze(rows, self.protocol, SHA)["coverage"]
        self.assertEqual(counts["total"], 1)
        self.assertEqual(counts["protocol_mismatch"], 0)

    def test_partial_live_models_do_not_pool_or_produce_figures(self):
        rows = [row("S0", 12, 0, 0), row("S1", 12, 0, 0, model="different-id", slot="M2"),
                row("S2", 12, 0, 0, model="faux", route="faux"), row("S2", 12, 0, 0, phase="smoke")]
        report = analyze(rows, self.protocol, SHA)
        self.assertEqual(report["coverage"]["faux"], 1)
        self.assertEqual(report["coverage"]["diagnostic_live"], 1)
        formal = [cohort for cohort in report["cohorts"] if cohort["phase"] == "formal"]
        self.assertEqual(len(formal), 2)
        for cohort in formal:
            self.assertEqual(cohort["c6"]["status"], "not_proven")
            self.assertEqual(cohort["comparisons"], [])
            self.assertEqual(sum(arm["observed_runs"] for arm in cohort["coverage"]["arms"].values()), 1)
        with TemporaryDirectory() as directory:
            figures = write_figures(report, Path(directory))
            self.assertEqual(figures["status"], "skipped")
            self.assertEqual(list(Path(directory).glob("*.png")), [])

    def test_complete_matrix_estimates_and_passes_c6(self):
        cohort, = analyze(self.matrix(), self.protocol, SHA)["cohorts"]
        self.assertTrue(cohort["coverage"]["complete"])
        self.assertEqual(cohort["c6"]["status"], "passed")
        comparisons = {(item["candidate"], item["reference"]): item["strata"] for item in cohort["comparisons"]}
        self.assertEqual(set(comparisons), {("S1", "S0"), ("S2", "S1"), ("S2", "S0")})
        strata = {(item["scope"], item["value"]): item for item in comparisons["S2", "S1"]}
        self.assertAlmostEqual(strata["overall", None]["delta"], 24 / 116)
        self.assertEqual(strata["size", 12]["ci"], [0, 0])
        self.assertEqual(strata["category", "update"]["mcnemar"]["candidate_only"], 8)
        self.assertGreater(strata["category", "update"]["mcnemar"]["p_holm"], strata["category", "update"]["mcnemar"]["p_exact"])

    def test_missing_measured_cost_cannot_pass_cost_gate(self):
        rows = self.matrix()
        rows[1740]["cost_cny_peak_reference"] = None
        cohort, = analyze(rows, self.protocol, SHA)["cohorts"]
        self.assertTrue(cohort["coverage"]["complete"])
        self.assertEqual(cohort["c6"]["status"], "not_proven")

    def test_conflicting_duplicate_cannot_complete_matrix(self):
        rows = self.matrix()
        rows.append({**rows[0], "passed": not rows[0]["passed"]})
        cohort, = analyze(rows, self.protocol, SHA)["cohorts"]
        self.assertFalse(cohort["coverage"]["complete"])
        self.assertEqual(cohort["coverage"]["conflicting_units"], 1)
        self.assertEqual(cohort["c6"]["status"], "not_proven")

    def test_same_item_count_with_wrong_category_mix_is_incomplete(self):
        rows = self.matrix()
        for item in rows:
            if item["case_id"] == "12-0":
                item["category"] = "position"
        cohort, = analyze(rows, self.protocol, SHA)["cohorts"]
        self.assertFalse(cohort["coverage"]["complete"])
        self.assertIn("unexpected_size_category_distribution", cohort["coverage"]["issues"])

    def test_c6_rejects_noninferiority_exactly_on_margin(self):
        cohort, = analyze(self.matrix(), self.protocol, SHA)["cohorts"]
        comparison = next(item for item in cohort["comparisons"] if item["candidate"] == "S1")
        next(item for item in comparison["strata"] if item["scope"] == "overall")["ci"] = [-0.03, 0.02]
        verdict = evaluate_c6(cohort["metrics"], cohort["comparisons"], self.protocol["success"])
        self.assertEqual(verdict["status"], "failed")

    @unittest.skipIf(Figure is None, "Optional Matplotlib dependency is unavailable")
    def test_complete_test_fixture_exercises_all_figure_paths(self):
        report = analyze(self.matrix(), self.protocol, SHA)
        with TemporaryDirectory() as directory:
            manifest = write_figures(report, Path(directory))
            self.assertEqual(manifest["status"], "written")
            self.assertEqual(len(manifest["cohorts"][0]["files"]), 6)
            for filename in manifest["cohorts"][0]["files"]:
                self.assertEqual((Path(directory) / filename).read_bytes()[:8], b"\x89PNG\r\n\x1a\n")


if __name__ == "__main__":
    unittest.main()
