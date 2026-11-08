"""Render evaluation fixtures from fact records without reading questions."""
from collections import defaultdict
from hashlib import sha256
from pathlib import PurePosixPath

FEATURES = {"i1", "i2", "i3", "i9"}
CHANNEL = "eval-chat-001"
INDEX_CHAR_BUDGET = 1800
INDEX_BYTE_BUDGET = 4096
FOOTER_RESERVE = 256


def _order(fact):
    order = fact.get("order")
    return (1 if order is None else 0, order or 0, fact["id"])


def _fits(lines, line):
    text = "\n".join([*lines, line]) + "\n"
    return len(text) <= INDEX_CHAR_BUDGET - FOOTER_RESERVE and len(text.encode()) <= INDEX_BYTE_BUDGET - FOOTER_RESERVE


def _canonical(facts):
    by_id = {f["id"]: f for f in facts}
    successor = {}
    key = ("scope", "entity", "attr")
    for row in facts:
        if row["kind"] != "correction":
            continue
        previous = row.get("supersedes")
        target = by_id.get(previous)
        if (
            target is None or previous in successor or target["kind"] not in {"fact", "correction"}
            or any(row.get(k) != target.get(k) for k in key)
        ):
            raise ValueError(f"Invalid correction target for {row['id']}")
        successor[previous] = row["id"]

    aliases = {}
    for previous in successor:
        tip = previous
        visited = set()
        while tip in successor:
            if tip in visited:
                raise ValueError(f"Cycle in correction chain at {tip}")
            visited.add(tip)
            tip = successor[tip]
        aliases[previous] = tip

    current = []
    for row in facts:
        if row["id"] in aliases:
            continue
        if row["kind"] == "correction":
            text = f"{row['entity']} / {row['attr']}: {row['value']}"
            if row.get("date"):
                text += f" (updated {row['date']})"
            row = {**row, "text": text}
        current.append(row)
    return current, aliases


def _group(row, enabled):
    topic = row.get("topic", row["kind"])
    return (topic, row.get("entity", "") if "i9" in enabled else "")


def render_s2(document, *, features=FEATURES, channel=CHANNEL):
    """Return workspace-relative UTF-8 files and a fact-ID-to-file map."""
    enabled = set(features)
    if enabled - FEATURES:
        raise ValueError(f"Unknown features: {sorted(enabled - FEATURES)}")
    original = document["facts"]
    if len({f["id"] for f in original}) != len(original):
        raise ValueError("Duplicate fact IDs")
    facts, aliases = _canonical(original) if "i3" in enabled else (original, {})
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
            elif row.get("hot") or ("i2" in enabled and row["kind"] == "correction"):
                inline.append(row)
            else:
                groups[_group(row, enabled)].append(row)

        lines = ["# Memory index"]
        if rules:
            lines.append("## Standing rules")
        if "i2" in enabled:
            inline.sort(key=lambda row: (row["kind"] != "correction", _order(row)))
        overflow = 0
        for row in rules + inline:
            entry = f"- {row['text']}"
            if "i2" in enabled and not _fits(lines, entry):
                if row in rules:
                    raise ValueError("Standing rules exceed the index budget")
                groups[_group(row, enabled)].append(row)
                overflow += 1
                continue
            lines.append(entry)
            mapping[row["id"]] = index
        if groups:
            lines.append("## Topic notes")
        catalog = []
        omitted_routes = 0
        for group_number, ((topic, entity), members) in enumerate(sorted(groups.items()), 1):
            heading = f"{entity} ({topic})" if entity else topic
            prefix = f"note-{group_number:02d}"
            if entity:
                label = "".join(c if c.isalnum() or c in "-_" else "-" for c in entity[:48])
                digest = sha256(f"{topic}\0{entity}".encode()).hexdigest()[:12]
                prefix = f"{label}-{digest}"
            for offset in range(0, len(members), 24):
                path = f"{note_dir}/{prefix}-{offset // 24 + 1:03d}.md"
                page = members[offset:offset + 24]
                files[path] = f"# {heading}\n\n" + "".join(f"- {f['text']}\n" for f in page)
                route = PurePosixPath(path)
                if scope == "channel":
                    route = route.relative_to(channel)
                names = ", ".join(dict.fromkeys(f.get("entity", "") for f in page if f.get("entity")))
                label = f"{topic}: {names}" if names else topic
                entry = f"- [{label}]({route})"
                if "i2" in enabled and not _fits(lines, entry):
                    omitted_routes += 1
                else:
                    lines.append(entry)
                catalog.append(f"- [{label}]({route.name})")
                mapping.update((row["id"], path) for row in page)
        if omitted_routes or overflow:
            catalog_path = f"{note_dir}/catalog.md"
            files[catalog_path] = "# Topic catalog\n\n" + "\n".join(catalog) + "\n"
            route = PurePosixPath(catalog_path)
            if scope == "channel":
                route = route.relative_to(channel)
            lines.append(f"- Omitted from inline: {overflow} facts and {omitted_routes} routes. [Full topic catalog]({route}).")
        files[index] = "\n".join(lines) + "\n"
    if set(mapping) != {f["id"] for f in facts}:
        raise ValueError("Unsupported fact scope")
    mapping.update((previous, mapping[tip]) for previous, tip in aliases.items())
    return files, mapping
