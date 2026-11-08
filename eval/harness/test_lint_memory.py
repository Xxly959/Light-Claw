import unittest
from lint_memory import lint_layout

class LintMemoryTest(unittest.TestCase):
    def test_detects_invalid_links_orphans_and_duplicates(self):
        files = {
            "MEMORY.md": "[Missing](.shared/memory/absent.md)\n[Invalid](../escape.md)",
            "eval-chat-001/MEMORY.md": "# Local\n" + "z" * 4100,
            ".shared/memory/one.md": "- Example\n- Example\n",
        }
        kinds = {item["kind"] for item in lint_layout(files, {"id": ".shared/memory/one.md"})}
        self.assertEqual(kinds, {"dangling", "invalid_link", "orphan", "duplicate_line", "over_budget"})

    def test_follows_catalog_links(self):
        files = {
            "MEMORY.md": "[Catalog](.shared/memory/catalog.md)",
            ".shared/memory/catalog.md": "[Note](note.md)",
            ".shared/memory/note.md": "# A note",
        }
        self.assertEqual(lint_layout(files, {"fact": ".shared/memory/note.md"}), [])
