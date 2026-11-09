import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from external_qa import VARIANTS, addressed_json, addressed_jsonl, dispatch_batch
from external_score import mab_match, score_qa
from external_writer import write_json
from render_s2 import CHANNEL


FACT = "memoryagentbench_factconsolidation"
EVENT = "memoryagentbench_eventqa"
LONGMEM = "longmemeval_s"


class ExternalScoreTests(unittest.TestCase):
    def test_official_aliases_normalization_and_substring(self):
        self.assertTrue(mab_match(FACT, "The New-Yorkshire!", [["wrong"], ["newyork"]]))
        self.assertFalse(mab_match(FACT, "New—York", ["new york"]))
        self.assertTrue(mab_match(FACT, "The answer was\tGold.", "an gold"))

    def test_eventqa_scores_the_parsed_line_but_fact_uses_full_text_too(self):
        response = "Gold appeared earlier.\nAnswer: Wrong."
        self.assertFalse(mab_match(EVENT, response, ["gold"]))
        self.assertTrue(mab_match(FACT, response, ["gold"]))
        self.assertTrue(mab_match(EVENT, "Analysis.\nanswer: Answer: Gold!", ["gold"]))
        self.assertFalse(mab_match(EVENT, "Wrong.\nGold.", ["gold"]))

    def make_qa(self, root):
        root.mkdir()
        layout = addressed_json(root, "layouts", {"channel": CHANNEL, "files_by_arm": {arm: {} for arm in VARIANTS}})
        dispatch = [{"case_id": case, "layout": layout, "prompt": case} for case in ("mab", "lme")]
        references = [
            {"case_id": "mab", "dataset": FACT, "qa_pair_id": "qa-1", "source": "factconsolidation_sh_6k", "answers": ["gold"]},
            {"case_id": "lme", "dataset": LONGMEM, "question_id": "native_abs", "question_type": "knowledge-update",
             "question": "What is missing?", "answer": "PRIVATE RUBRIC", "abstention": True},
        ]
        plan = {"schema_version": 1, "variants": VARIANTS, "writer_route": "configured", "datasets": {
            FACT: {"ready_questions": 1, "pending_questions": 1}, LONGMEM: {"ready_questions": 1, "pending_questions": 0},
        }, "dispatch": addressed_jsonl(root, "dispatch", dispatch), "references": addressed_jsonl(root, "references", references)}
        write_json(root / "plan.json", plan)
        return plan

    def test_partial_scores_and_longmemeval_exports_stay_separate_by_arm(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "qa"
            plan = self.make_qa(root)

            def local_fixture(spec):
                response = "The gold." if spec["prompt"] == "mab" else "It is unknown."
                return {"stopReason": "stop", "fixturesUnchanged": True, "response": response}

            dispatch_batch(root, plan, "fixture", 5, local_fixture)
            output = root / "scored"
            report = score_qa(root, "fixture", output)
            self.assertEqual(report["provider_calls"], 0)
            m = report["datasets"][FACT]["arms"]["N"]
            self.assertEqual((m["selected"], m["scored"], m["correct"], m["status"]), (2, 1, 1, "partial_score"))
            self.assertEqual(report["datasets"][LONGMEM]["arms"]["N"]["scored"], 0)
            self.assertEqual(report["datasets"][LONGMEM]["arms"]["S0"]["unattempted"], 1)
            exports = report["longmemeval_exports"]
            self.assertEqual(set(exports), {"N"})
            hypothesis = json.loads((output / exports["N"]["hypotheses"]["path"]).read_text())
            reference = json.loads((output / exports["N"]["references"]["path"]).read_text())
            self.assertEqual(hypothesis, {"question_id": "native_abs", "hypothesis": "It is unknown."})
            self.assertEqual(reference["answer"], "PRIVATE RUBRIC")
            self.assertEqual(set(reference), {"question_id", "question_type", "question", "answer"})

    def test_unresolved_and_failed_responses_are_not_scored(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "qa"
            plan = self.make_qa(root)
            dispatch_batch(root, plan, "fixture", 1, lambda _spec: {"stopReason": "error", "response": "gold"})

            def interrupted(_spec):
                raise RuntimeError("interrupted")

            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                dispatch_batch(root, plan, "fixture", 1, interrupted)
            report = score_qa(root, "fixture", root / "scored")
            self.assertEqual(report["datasets"][FACT]["arms"]["N"]["failed"], 1)
            self.assertEqual(report["datasets"][FACT]["arms"]["S0"]["unresolved"], 1)
            self.assertIsNone(report["datasets"][FACT]["arms"]["N"]["accuracy_on_scored"])
            self.assertEqual(report["longmemeval_exports"], {})


if __name__ == "__main__":
    unittest.main()
