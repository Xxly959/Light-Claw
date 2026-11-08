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
