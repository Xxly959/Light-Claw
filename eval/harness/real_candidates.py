"""Find pending-review memory cases in private copies of local runtime logs."""

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "eval" / "real"
MAX_SOURCE_BYTES = 16 * 1024 * 1024
EXCLUDED = re.compile(r"(?:^|[._-])(?:eval|test|fixture|synthetic|acceptance|bench)(?:[._-]|$)", re.I)
PLATFORM_CHANNEL = re.compile(r"oc_[A-Za-z0-9]+|[CGD][A-Z0-9]{8,}")
NON_NATURAL = re.compile(
    r"验收|联调|冒烟|合成样本|只回复\s*[A-Z0-9_-]{2,}|"
    r"\b(?:faux|fixture|synthetic|smoke[- ]test|acceptance[- ]test)\b|\bLC_[A-Z0-9_]+\b",
    re.I,
)
INTENTS = {
    "recall": re.compile(
        r"^(?:(?:你)?(?:还)?记得|我之前(?:说过|让你记住|告诉过你)|"
        r"(?:之前|先前)(?:记住|记录)的|do you (?:still )?remember|what did i (?:say|tell you))\s*[：:,，]?\s*",
        re.I,
    ),
    "correction": re.compile(r"^(?:更正|纠正|更新记忆|correction|update (?:the )?memory)\s*[：:,，]?\s*", re.I),
    "remember": re.compile(
        r"^(?:请\s*)?(?:帮我\s*)?(?:记住|记下|记一下|remember(?: that)?|please remember(?: that)?)"
        r"\s*[：:,，]?\s*",
        re.I,
    ),
}
STOP_WORDS = {
    "about", "again", "could", "from", "have", "memory", "need", "please", "remember", "should",
    "that", "this", "what", "when", "where", "which", "with", "would", "your",
}


def live_workspaces():
    search = subprocess.run(
        ["pgrep", "-f", r"packages/lightclaw/(src/main\.ts|dist/main\.js)"],
        check=False, capture_output=True, text=True,
    )
    if search.returncode == 1:
        return []
    search.check_returncode()
    pids = [pid for pid in search.stdout.split() if pid.isascii() and pid.isdigit()]
    if not pids:
        return []
    result = subprocess.run(
        ["ps", "-p", ",".join(pids), "-o", "command="], check=False, capture_output=True, text=True,
    )
    if result.returncode != 0 and not result.stdout:
        return []
    roots = set()
    for line in result.stdout.splitlines():
        if "lightclaw" not in line.lower():
            continue
        try:
            args = shlex.split(line)
        except ValueError:
            continue
        if not args or not Path(args[0]).name.startswith("node"):
            continue
        entry = next((
            index for index, arg in enumerate(args[1:], 1)
            if arg.endswith(("packages/lightclaw/src/main.ts", "packages/lightclaw/dist/main.js"))
        ), None)
        if entry is None:
            continue
        for arg in args[entry + 1:]:
            path = Path(arg)
            if path.is_absolute() and path.is_dir() and path.resolve().is_relative_to(ROOT):
                roots.add(path)
    return sorted(roots)


def sources(workspaces, counts):
    selected = []
    for path in workspaces:
        if path.is_symlink() or any(EXCLUDED.search(part) for part in path.parts):
            counts["excluded_workspace"] += 1
            continue
        if not path.is_dir():
            counts["workspace_unavailable"] += 1
            continue
        for directory in sorted(path.iterdir()):
            if not PLATFORM_CHANNEL.fullmatch(directory.name) or directory.is_symlink() or not directory.is_dir():
                continue
            source = directory / "log.jsonl"
            if source.is_symlink() or not source.is_file():
                counts["nonregular_or_missing_log"] += 1
                continue
            if source.stat().st_size > MAX_SOURCE_BYTES:
                counts["source_too_large"] += 1
                continue
            selected.append(source)
    return selected


def private_directory(path):
    path.mkdir(mode=0o700, exist_ok=True)
    mode = path.lstat()
    if not stat.S_ISDIR(mode.st_mode) or mode.st_uid != os.getuid() or mode.st_mode & 0o077:
        raise SystemExit("Private output directory is unavailable or has broader permissions.")


def private_copy(source, target):
    # Snapshot only the bytes that existed when the source descriptor was opened.
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as reader:
        info = os.fstat(reader.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SOURCE_BYTES:
            return None
        remaining = info.st_size
        with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as writer:
            while remaining:
                block = reader.read(min(remaining, 64 * 1024))
                if not block:
                    break
                writer.write(block)
                remaining -= len(block)
        return info.st_size - remaining


def evidence_terms(text):
    words = set(re.findall(r"[a-z][a-z0-9_-]{2,}", text.lower())) - STOP_WORDS
    grams = {
        run[index:index + 3]
        for run in re.findall(r"[\u3400-\u9fff]+", text)
        for index in range(len(run) - 2)
    }
    return words | grams


def scan(snapshot, alias, counts):
    candidates = []
    earlier = {}
    seen_messages = set()
    with snapshot.open("rb") as reader:
        for line_no, raw in enumerate(reader, 1):
            counts["rows"] += 1
            if not raw.endswith(b"\n"):
                counts["incomplete_row"] += 1
                continue
            try:
                entry = json.loads(raw)
            except (ValueError, UnicodeError):
                counts["invalid_row"] += 1
                continue
            if not isinstance(entry, dict) or not isinstance(entry.get("isBot"), bool):
                counts["invalid_row"] += 1
                continue
            if entry["isBot"]:
                counts["bot_rows"] += 1
                continue
            counts["user_rows"] += 1
            sender, message, text = (entry.get(key) for key in ("user", "ts", "text"))
            if not all(isinstance(value, str) and value.strip() for value in (sender, message, text)):
                counts["missing_identity_or_text"] += 1
                continue
            if message in seen_messages:
                counts["duplicate_message"] += 1
                continue
            seen_messages.add(message)
            text = text.strip()
            if NON_NATURAL.search(text):
                counts["evaluation_markers"] += 1
                continue
            if len(text) > 1000 or "\n" in text:
                counts["long_or_multiline"] += 1
                continue
            matches = [(kind, pattern.match(text)) for kind, pattern in INTENTS.items()]
            matches = [(kind, match) for kind, match in matches if match]
            if len(matches) != 1:
                counts["ambiguous_intent" if matches else "no_explicit_intent"] += 1
                continue
            kind, match = matches[0]
            terms = evidence_terms(text[match.end():])
            if len(terms) < 2:
                counts["insufficient_distinctive_terms"] += 1
                continue
            counts[f"{kind}_signals"] += 1
            if kind == "remember":
                earlier.setdefault(sender, []).append((line_no, terms))
                continue
            matched = [
                evidence_line for evidence_line, evidence in earlier.get(sender, [])
                if len(evidence & terms) >= 2
            ]
            if len(matched) != 1:
                counts["ambiguous_prior_evidence" if matched else "no_same_sender_prior_evidence"] += 1
                continue
            candidates.append({
                "source": alias,
                "evidence_line": matched[0],
                "later_line": line_no,
                "signal": kind,
                "status": "pending_user_review",
            })
    return candidates


def publish(path, content):
    fd, name = tempfile.mkstemp(prefix=".candidate-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, action="append", help="An explicitly selected runtime workspace")
    args = parser.parse_args()
    workspaces = args.workspace if args.workspace else live_workspaces()

    ignored = subprocess.run(
        ["git", "check-ignore", "-q", str(OUTPUT / "candidates.jsonl")], cwd=ROOT, check=False,
    )
    if ignored.returncode != 0:
        raise SystemExit("The private output path must be ignored by Git.")
    private_directory(OUTPUT)
    snapshot_dir = Path(tempfile.mkdtemp(prefix="sources-", dir=OUTPUT))
    counts = Counter()
    selected = sources(workspaces, counts)
    snapshots = []
    for index, source in enumerate(selected, 1):
        alias = f"channel-{index:02d}.jsonl"
        target = snapshot_dir / alias
        try:
            size = private_copy(source, target)
        except OSError:
            size = None
        if size is None:
            target.unlink(missing_ok=True)
            counts["source_copy_skipped"] += 1
            continue
        snapshots.append((alias, target, size))

    candidates = []
    per_source = []
    for alias, target, size in snapshots:
        source_counts = Counter()
        found = scan(target, alias, source_counts)
        counts.update(source_counts)
        per_source.append({"source": alias, "bytes": size, "pairs": len(found), **source_counts})
        candidates.extend(found)
    # The minimum pool prevents incomplete sets being mistaken for a review batch.
    published = candidates[:100] if len(candidates) >= 50 else []
    for item in published:
        item["snapshot"] = snapshot_dir.name
    publish(OUTPUT / "candidates.jsonl", "".join(json.dumps(item) + "\n" for item in published))
    summary = {
        "workspace_count": len(workspaces),
        "selected_log_count": len(selected),
        "copied_log_count": len(snapshots),
        "snapshot": snapshot_dir.name,
        "counts": counts,
        "by_source": per_source,
        "unreviewed_signal_pairs": len(candidates),
        "published_pending_review": len(published),
        "publication_reason": "minimum_pool_met" if published else "fewer_than_50_unambiguous_pairs",
    }
    serialized = json.dumps(summary, indent=2, sort_keys=True) + "\n"
    publish(OUTPUT / "source-counts.json", serialized)
    print(serialized, end="")


if __name__ == "__main__":
    main()
