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
