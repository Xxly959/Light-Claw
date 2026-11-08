import unittest
from render_s2 import render_s2

RULE = dict(id="r", scope="global", kind="rule", text="Use blue for draft labels.", placement="link")
FACT = dict(id="f", scope="channel", kind="fact", text="The Lantern workspace is on port 7182.",
            entity="Lantern", attr="port", value=7182, hot=False, order=0.2)

class RenderTest(unittest.TestCase):
    def test_inline_rule_only_when_enabled(self):
        for features in (set(), {"i1"}):
            with self.subTest(features=features):
                files, mapping = render_s2({"facts": [FACT, RULE]}, features=features)
                self.assertEqual("MEMORY.md" in mapping["r"], bool(features))
                self.assertIn(RULE["text"], files[mapping["r"]])
                self.assertIn(FACT["text"], files[mapping["f"]])
                self.assertEqual(set(mapping), {"f", "r"})

    def test_priority_budget_preserves_facts_via_notes(self):
        facts = [RULE] + [
            {**FACT, "id": str(i), "hot": True, "text": f"Record {i} " + "档" * 180}
            for i in range(20)
        ]
        files, mapping = render_s2({"facts": facts}, features={"i1", "i2"})
        for index in ("MEMORY.md", "eval-chat-001/MEMORY.md"):
            self.assertLessEqual(len(files[index]), 1800)
            self.assertLessEqual(len(files[index].encode()), 4096)
        self.assertIn("Omitted from inline", files["eval-chat-001/MEMORY.md"])
        self.assertEqual(set(mapping), {f["id"] for f in facts})
        for fact in facts:
            self.assertIn(fact["text"], files[mapping[fact["id"]]])

    def test_correction_chain_has_only_current_value(self):
        newer = {**FACT, "id": "c1", "kind": "correction", "value": 8122,
                 "text": "Port changed to 8122 from 7182.", "supersedes": "f"}
        latest = {**newer, "id": "c2", "value": 9101, "date": "2026-10-22",
                  "text": "Port changed to 9101 from 8122.", "supersedes": "c1"}
        files, mapping = render_s2({"facts": [latest, FACT, newer]}, features={"i2", "i3"})
        contents = "\n".join(files.values())
        self.assertIn("9101", contents)
        self.assertNotIn("7182", contents)
        self.assertNotIn("8122", contents)
        self.assertEqual(mapping["f"], mapping["c1"])
        self.assertEqual(mapping["f"], mapping["c2"])

    def test_correction_cannot_cross_fact_keys(self):
        bad = {**FACT, "id": "c", "kind": "correction", "attr": "owner", "supersedes": "f"}
        with self.assertRaisesRegex(ValueError, "correction target"):
            render_s2({"facts": [FACT, bad]}, features={"i3"})

    def test_entity_notes_do_not_return_unrelated_records(self):
        other = {**FACT, "id": "other", "entity": "Harbor", "text": "The Harbor contact is Iris."}
        files, mapping = render_s2({"facts": [FACT, other]}, features={"i9"})
        self.assertNotEqual(mapping["f"], mapping["other"])
        self.assertIn("Lantern", files[mapping["f"]].splitlines()[0])
        self.assertNotIn(other["text"], files[mapping["f"]])
        self.assertIn(other["text"], files[mapping["other"]])
