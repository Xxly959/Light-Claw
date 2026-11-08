"""Check rendered memory files without a model."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
from urllib.parse import unquote

LINK = re.compile(r"\[[^\]\n]+\]\(([^()\n]+)\)")


def lint_layout(files, mapping):
    findings = []
    graph = defaultdict(set)
    roots = {name for name in files if PurePosixPath(name).name == "MEMORY.md"}

    def report(kind, path, detail=None):
        findings.append({"kind": kind, "path": path, "detail": detail})

    for path, body in sorted(files.items()):
        if path in roots and len(body.encode()) > 4096:
            report("over_budget", path, len(body.encode()))
        bullets = Counter(line.strip() for line in body.splitlines() if line.startswith("- ") and not LINK.search(line))
        if any(count > 1 for count in bullets.values()):
            report("duplicate_line", path, sum(count - 1 for count in bullets.values() if count > 1))
        if re.search(r"^(?:<{7}|={7}|>{7})(?:\s|$)", body, re.M):
            report("conflict_marker", path)
        for match in LINK.finditer(body):
            target = unquote(match.group(1).split("#", 1)[0])
            if not target or "://" in target or not target.lower().endswith(".md"):
                continue
            joined = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
            if target.startswith("/") or joined == ".." or joined.startswith("../") or "\\" in target:
                report("invalid_link", path, target)
            elif joined not in files:
                report("dangling", path, joined)
            else:
                graph[path].add(joined)
    reachable = set()
    stack = list(roots)
    while stack:
        path = stack.pop()
        if path not in reachable:
            reachable.add(path)
            stack.extend(graph[path] - reachable)
    for path in sorted(set(files) - reachable):
        report("orphan", path)
    for fact, path in sorted(mapping.items()):
        if path not in files:
            report("missing_fact_file", path, fact)
    return findings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace", type=Path)
    parser.add_argument("--map", type=Path)
    args = parser.parse_args()
    files = {
        path.relative_to(args.workspace).as_posix(): path.read_text(encoding="utf-8")
        for path in args.workspace.rglob("*.md")
        if path.is_file() and not path.is_symlink()
        and (path.name == "MEMORY.md" or "memory" in path.relative_to(args.workspace).parts[:-1])
    }
    mapping = json.loads(args.map.read_text(encoding="utf-8")) if args.map else {}
    findings = lint_layout(files, mapping)
    print(json.dumps(findings, ensure_ascii=False))
    return bool(findings)


if __name__ == "__main__":
    raise SystemExit(main())
