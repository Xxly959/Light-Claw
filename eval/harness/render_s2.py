"""Render evaluation fixtures from fact records without reading questions."""
from collections import defaultdict
from pathlib import PurePosixPath

FEATURES = {"i1"}
CHANNEL = "eval-chat-001"


def _order(fact):
    order = fact.get("order")
    return (1 if order is None else 0, order or 0, fact["id"])


def render_s2(document, *, features=FEATURES, channel=CHANNEL):
    """Return workspace-relative UTF-8 files and a fact-ID-to-file map."""
    enabled = set(features)
    if enabled - FEATURES:
        raise ValueError(f"Unknown features: {sorted(enabled - FEATURES)}")
    facts = document["facts"]
    if len({f["id"] for f in facts}) != len(facts):
        raise ValueError("Duplicate fact IDs")
    files = {}
    mapping = {}
    for scope, index, note_dir in (
        ("global", "MEMORY.md", ".shared/memory"),
        ("channel", f"{channel}/MEMORY.md", f"{channel}/memory"),
    ):
        rows = sorted((f for f in facts if f["scope"] == scope), key=_order)
        rules, inline, groups = [], [], defaultdict(list)
        for row in rows:
            if row["kind"] == "rule" and ("i1" in enabled or row.get("placement") == "inline"):
                rules.append(row)
            elif row.get("hot"):
                inline.append(row)
            else:
                groups[row.get("topic", row["kind"])].append(row)

        lines = ["# Memory index"]
        if rules:
            lines.append("## Standing rules")
        for row in rules + inline:
            lines.append(f"- {row['text']}")
            mapping[row["id"]] = index
        if groups:
            lines.append("## Topic notes")
        for group_number, (topic, members) in enumerate(sorted(groups.items()), 1):
            for offset in range(0, len(members), 24):
                path = f"{note_dir}/note-{group_number:02d}-{offset // 24 + 1:03d}.md"
                page = members[offset:offset + 24]
                files[path] = f"# {topic}\n\n" + "".join(f"- {f['text']}\n" for f in page)
                route = PurePosixPath(path)
                if scope == "channel":
                    route = route.relative_to(channel)
                names = ", ".join(dict.fromkeys(f.get("entity", "") for f in page if f.get("entity")))
                lines.append(f"- [{topic}: {names}]({route})")
                mapping.update((row["id"], path) for row in page)
        files[index] = "\n".join(lines) + "\n"
    if set(mapping) != {f["id"] for f in facts}:
        raise ValueError("Unsupported fact scope")
    return files, mapping
