import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from external_qa import configured_batch, dispatch_batch, prepare_qa, project_questions
from external_writer import build_plan, chunk_history, history_segments, merge_corpus, validate_candidates, write_json


DATASET = "longmemeval_s"


class ExternalQATests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / "writer-state"
        self.manifest = self.root / "manifest.json"
        self.writer_plan = self.root / "writer-plan.json"
        self.output = self.root / "qa"
        self.record = {
            "question_id": "native_abs", "question_type": "knowledge-update", "question_date": "2024/05/02",
            "question": "QUESTION MARKER", "answer": "REFERENCE MARKER", "answer_session_ids": ["gold-session-marker"],
            "haystack_session_ids": ["gold-session-marker"], "haystack_dates": ["2024/05/01"],
            "haystack_sessions": [[{"role": "user", "content": "HISTORY MARKER", "has_answer": True}]],
        }
        artifact = self.root / "prepared" / "fixture.jsonl"
        artifact.parent.mkdir()
        artifact.write_text(json.dumps({"source_id": "native_abs", "record": self.record}) + "\n")
        write_json(self.manifest, {"schema_version": 1, "datasets": {DATASET: {
            "status": "prepared", "artifact": "prepared/fixture.jsonl", "episodes": 1, "questions": 1,
            "artifact_sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
        }}})
        self.plan = build_plan(self.manifest, [DATASET], 256)
        write_json(self.writer_plan, self.plan)

    def save_corpus(self, route="configured", alter=False):
        planned, = self.plan["episodes"]
        chunk, = chunk_history(history_segments(DATASET, self.record), 256)
        request, = planned["chunks"]
        receipt = {
            "request_sha256": request["request_sha256"], "status": "complete", "route": route,
            "memories": validate_candidates({"memories": [{
                "text": "HISTORY MARKER", "quote": "HISTORY MARKER", "fragment": chunk[0]["id"],
            }]}, chunk),
        }
        write_json(self.state / "receipts" / (receipt["request_sha256"] + ".json"), receipt)
        key = planned["corpus_plan_key"]
        corpus = merge_corpus(key, [receipt], route)
        if alter:
            corpus["memories"][0]["text"] = "REFERENCE MARKER"
        write_json(self.state / "corpora" / (key + ".json"), corpus)

    def prepare(self):
        return prepare_qa(self.manifest, self.writer_plan, self.state, self.output, [DATASET])

    def test_missing_corpus_remains_pending(self):
        plan = self.prepare()
        self.assertEqual(plan["datasets"][DATASET]["pending_questions"], 1)
        self.assertEqual(plan["datasets"][DATASET]["ready_questions"], 0)
        self.assertEqual(list(self.output.glob("layouts/*.json")), [])

    def test_faux_corpus_is_not_an_external_qa_input(self):
        self.save_corpus("faux")
        plan = self.prepare()
        self.assertEqual(plan["episodes"][0]["status"], "synthetic_writer_corpus")
        self.assertEqual(plan["datasets"][DATASET]["ready_questions"], 0)

    def test_history_question_and_judge_fields_are_separate(self):
        self.save_corpus()
        plan = self.prepare()
        episode = plan["episodes"][0]
        self.assertEqual(episode["status"], "ready")
        layout = (self.output / episode["layout"]["path"]).read_text()
        arms = json.loads(layout)["files_by_arm"]
        self.assertEqual(set(arms), {"N", "S0", "S1", "S2"})
        self.assertEqual(arms["N"], {})
        for arm in ("S0", "S1", "S2"):
            self.assertIn("HISTORY MARKER", "\n".join(arms[arm].values()))
        self.assertNotIn("QUESTION MARKER", layout)
        self.assertNotIn("REFERENCE MARKER", layout)
        self.assertNotIn("gold-session-marker", layout)
        dispatch = (self.output / plan["dispatch"]["path"]).read_text()
        self.assertIn("QUESTION MARKER", dispatch)
        self.assertIn("2024/05/02", dispatch)
        self.assertNotIn("REFERENCE MARKER", dispatch)
        reference = json.loads((self.output / plan["references"]["path"]).read_text())
        self.assertEqual(reference["scorer"], "longmemeval_official_judge_pending")
        self.assertEqual(reference["answer"], "REFERENCE MARKER")
        self.assertTrue(reference["abstention"])
        self.assertEqual(reference["question_id"], "native_abs")

    def test_corpus_must_match_validated_receipts(self):
        self.save_corpus(alter=True)
        with self.assertRaisesRegex(ValueError, "corpus differs"):
            self.prepare()
        self.assertFalse((self.output / "plan.json").exists())

    def test_mab_uses_native_question_id_and_aliases(self):
        dataset = "memoryagentbench_factconsolidation"
        row = {"source_id": "context", "question_indices": [1], "record": {
            "questions": ["skip", "selected"], "answers": [["skip"], ["Gold", "Alias"]],
            "metadata": {"qa_pair_ids": ["A", "B"], "source": "factconsolidation_sh_6k"},
        }}
        (dispatch, reference), = project_questions(dataset, row)
        self.assertEqual(dispatch["prompt"], "If statements conflict, use the later statement.\n\nselected")
        self.assertEqual(reference["question"], "selected")
        self.assertEqual(reference["qa_pair_id"], "B")
        self.assertEqual(reference["answers"], ["Gold", "Alias"])

    def test_locomo_adversarial_question_without_answer_remains_evaluator_only(self):
        row = {"source_id": "conv-9", "question_indices": [0], "record": {
            "sample_id": "conv-9", "qa": [{"category": 5, "question": "question", "adversarial_answer": "distractor"}],
        }}
        (dispatch, reference), = project_questions("locomo", row)
        self.assertEqual(dispatch["prompt"], "question")
        self.assertEqual(reference["adversarial_answer"], "distractor")
        self.assertIsNone(reference["answer"])
        self.assertTrue(reference["abstention"])

    def test_runner_dispatch_uses_only_question_and_layout_and_resumes(self):
        self.save_corpus()
        plan = self.prepare()
        seen = []

        def runner(spec):
            self.assertNotIn("REFERENCE MARKER", json.dumps(spec))
            self.assertNotIn("native_abs", json.dumps(spec))
            self.assertEqual(spec["model"], {"route": "configured"})
            seen.append(spec)
            return {"stopReason": "stop", "fixturesUnchanged": True, "response": "candidate"}

        first = dispatch_batch(self.output, plan, "profile", 2, runner)
        self.assertEqual(first["dispatched"], 2)
        second = dispatch_batch(self.output, plan, "profile", 2, runner)
        self.assertEqual(second["dispatched"], 2)
        self.assertEqual(second["reused"], 2)
        self.assertEqual([spec["variant"] for spec in seen], ["S1", "S0", "S1", "S2"])
        self.assertEqual(seen[0]["files"], {})
        self.assertEqual(dispatch_batch(self.output, plan, "profile", 2, runner)["dispatched"], 0)

    def test_started_dispatch_is_not_repeated_automatically(self):
        self.save_corpus()
        plan = self.prepare()

        def interrupted(_spec):
            raise RuntimeError("interrupted after send")

        with self.assertRaisesRegex(RuntimeError, "interrupted"):
            dispatch_batch(self.output, plan, "profile", 1, interrupted)
        result = dispatch_batch(self.output, plan, "profile", 1, lambda spec: self.fail(spec))
        self.assertEqual(result["checkpoint"], "unresolved_dispatch")
        self.assertEqual(result["dispatched"], 0)

    def test_nonzero_configured_route_fails_before_inspecting_runtime(self):
        with patch.dict("os.environ", {"LIGHTCLAW_EVAL_CNY_PER_MILLION": "0,0,0,1"}, clear=True):
            with self.assertRaisesRegex(ValueError, "four explicit zero"):
                configured_batch(self.output, {}, self.root / "missing-runtime", 1)


if __name__ == "__main__":
    unittest.main()
