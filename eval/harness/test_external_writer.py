import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from external_writer import (
    BudgetPaused,
    WriterBudget,
    chunk_history,
    history_segments,
    make_writer_request,
    merge_corpus,
    run_chunk,
    validate_candidates,
    valid_rates,
)


class WriterTest(unittest.TestCase):
    def test_all_zero_rates_require_explicit_configured_route(self):
        self.assertTrue(valid_rates((0, 0, 0, 0), "configured"))
        self.assertFalse(valid_rates((0, 0, 0, 0), "deepseek"))
        self.assertFalse(valid_rates((0, 0, 0, -1), "configured"))

    def test_longmem_gold_and_answer_bearing_identifiers_do_not_reach_writer(self):
        record = {
            "question": "GOLD_QUESTION",
            "answer": "GOLD_ANSWER",
            "answer_session_ids": ["gold-session"],
            "haystack_session_ids": ["gold-session"],
            "haystack_dates": ["2024/02/04"],
            "haystack_sessions": [[
                {"role": "user", "content": "HISTORY", "has_answer": "GOLD_TURN_FLAG"},
                {"role": "assistant", "content": "ACK"},
            ]],
        }
        history = history_segments("longmemeval_s", record)
        request = make_writer_request(chunk_history(history, 600)[0])
        self.assertIn("2024/02/04", request)
        self.assertLess(request.index("HISTORY"), request.index("ACK"))
        for sentinel in ("GOLD_QUESTION", "GOLD_ANSWER", "gold-session", "GOLD_TURN_FLAG"):
            self.assertNotIn(sentinel, request)

    def test_locomo_native_session_order_preserves_text_only(self):
        record = {
            "qa": [{"question": "GOLD_QUESTION"}],
            "event_summary": "GOLD_SUMMARY",
            "conversation": {
                "session_10": [{"speaker": "A", "text": "later", "blip_caption": "IMAGE_CAPTION"}],
                "session_10_date_time": "TIME_LATER",
                "session_2": [{"speaker": "B", "text": "earlier", "query": "GOLD_QUERY"}],
                "session_2_date_time": "TIME_EARLIER",
            },
        }
        request = make_writer_request(chunk_history(history_segments("locomo", record), 900)[0])
        self.assertLess(request.index("earlier"), request.index("later"))
        self.assertIn("TIME_EARLIER", request)
        self.assertIn("TIME_LATER", request)
        for sentinel in ("GOLD_QUESTION", "GOLD_SUMMARY", "GOLD_QUERY", "IMAGE_CAPTION"):
            self.assertNotIn(sentinel, request)

    def test_context_payload_with_escaped_unicode_splits_without_data_loss(self):
        context = '记🙂"\n\\' * 260
        record = {"context": context, "questions": ["Q_SENTINEL"], "answers": ["A_SENTINEL"]}
        chunks = chunk_history(history_segments("memoryagentbench_eventqa", record), 500)
        self.assertGreater(len(chunks), 1)
        self.assertEqual("".join(fragment["text"] for chunk in chunks for fragment in chunk), context)
        for chunk in chunks:
            request = make_writer_request(chunk)
            self.assertLessEqual(len(request.split("\n\nHISTORY_JSON\n")[1].encode()), 500)
            self.assertNotIn("Q_SENTINEL", request)
            self.assertNotIn("A_SENTINEL", request)

    def test_writer_candidate_requires_literal_provenance_and_explicit_correction(self):
        context = "Correction: use Blue, not Red."
        chunk = chunk_history(history_segments("memoryagentbench_factconsolidation", {"context": context}), 500)[0]
        fragment = chunk[0]["id"]
        row = {"text": "Use Blue", "fragment": fragment, "quote": context, "supersedes": "Red"}
        self.assertEqual(validate_candidates({"memories": [row]}, chunk)[0]["supersedes"], "Red")
        with self.assertRaises(ValueError):
            validate_candidates({"memories": [{**row, "quote": "unsupported"}]}, chunk)
        with self.assertRaises(ValueError):
            validate_candidates({"memories": [{**row, "quote": "Blue, not Red"}]}, chunk)

    def test_memo_receipt_prevents_replay_and_corpus_keeps_chronological_order(self):
        history = history_segments("memoryagentbench_eventqa", {"context": "source sentence " * 70})
        chunks = chunk_history(history, 600)[:2]
        with TemporaryDirectory() as directory:
            state = Path(directory)
            for chunk in reversed(chunks):
                def fake_runner(_runtime, spec, _env, _seconds):
                    self.assertEqual(spec["files"], {})
                    self.assertEqual(spec["variant"], "S1")
                    self.assertEqual(spec["model"]["route"], "faux")
                    self.assertEqual(spec["prompt"], make_writer_request(chunk))
                    return {"stopReason": "stop", "fixturesUnchanged": True, "response": spec["model"]["turns"][0]["text"]}

                with patch("run.invoke", side_effect=fake_runner):
                    receipt, called = run_chunk(state, "faux", chunk, state, {}, 0, None)
                self.assertTrue(called)
                self.assertEqual(receipt["status"], "complete")
                with patch("run.invoke", side_effect=AssertionError("unexpected repeat dispatch")):
                    repeated, called = run_chunk(state, "faux", chunk, state, {}, 0, None)
                self.assertFalse(called)
                self.assertEqual(repeated, receipt)
            corpus = merge_corpus("episode", [run_chunk(state, "faux", c, state, {}, 0, None)[0] for c in chunks], "faux")
            self.assertEqual([item["part"] for item in corpus["memories"]], [1, 2])
            self.assertTrue(corpus["synthetic_only"])

    def test_budget_reservation_blocks_dispatch_and_survives_restart(self):
        rates = (2, 1, 2, 8)
        with TemporaryDirectory() as directory:
            ledger = Path(directory) / "spend.jsonl"
            with patch("external_writer.WRITER_LEDGER", ledger):
                insufficient = WriterBudget("configured", 0.1, 8192, rates)
                with self.assertRaises(BudgetPaused):
                    insufficient.begin("insufficient")
                self.assertFalse(ledger.exists())

                sufficient = WriterBudget("configured", 0.2, 8192, rates)
                sufficient.begin("in-flight")
                self.assertAlmostEqual(sufficient.spent, 0.098304)
                recovered = WriterBudget("configured", 0.2, 8192, rates)
                with self.assertRaises(BudgetPaused):
                    recovered.begin("in-flight")
                recovered.finish("in-flight", 0.01)
                self.assertAlmostEqual(WriterBudget("configured", 0.2, 8192, rates).spent, 0.01)


if __name__ == "__main__":
    unittest.main()
