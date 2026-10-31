import hashlib
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parent
ROOT = OUT.parents[2]
RAW = OUT / "raw"

def strict_equal(left, right):
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(strict_equal(left[k], right[k]) for k in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(strict_equal(a, b) for a, b in zip(left, right))
    return left == right

manifest = json.loads((OUT / "manifest.json").read_text())
assert all(hashlib.sha256((ROOT / p).read_bytes()).hexdigest() == h for p, h in manifest["sourceHashes"].items()), "Product source changed during experiment"
cases = json.loads((OUT / "prompt-dataset.json").read_text())
by_id = {case["id"]: case for case in cases}
assert len(by_id) == 22
assert {split: sum(c["split"] == split for c in cases) for split in ["training", "selection", "final"]} == {"training": 6, "selection": 4, "final": 12}
queue = json.loads((RAW / "queue.json").read_text())
assert len(queue["rounds"]) == 130 and len(queue["tasks"]) == 54600
for r in queue["rounds"]:
    tasks = [t for t in queue["tasks"] if all(t[k] == r[k] for k in ["arm", "scenario", "repetition"])]
    assert len(tasks) == r["submitted"]
    assert sum(t["status"] == "completed" for t in tasks) == r["completed"]
    assert sum(t["status"] == "expired" for t in tasks) == r["expired"]
    assert sum(t["status"] == "rejected" for t in tasks) == r["rejected"]
    assert r["completed"] + r["expired"] + r["rejected"] == r["submitted"]
    for channel in range(20):
        done = [t for t in tasks if t["channel"] == channel and t["status"] == "completed"]
        assert all(a["finishedMs"] <= b["startedMs"] and a["index"] < b["index"] for a, b in zip(done, done[1:]))

for repetition in range(3):
    baseline = json.loads((RAW / f"cache-{repetition}-disabled.json").read_text())
    for arm in ["disabled", "capacity", "ttl", "combined"]:
        run = json.loads((RAW / f"cache-{repetition}-{arm}.json").read_text())
        assert run["created"] == run["released"]
        assert len(run["tasks"]) == 704
        assert run["retainedAfterIdle"] == {"disabled": 320, "capacity": 128, "ttl": 0, "combined": 0}[arm]
        assert [(t["id"], t["turn"], t["messageCount"], t["contextChars"]) for t in run["tasks"]] == [(t["id"], t["turn"], t["messageCount"], t["contextChars"]) for t in baseline["tasks"]]

prompt = [json.loads(line) for line in (RAW / "prompt-formal-runs.jsonl").read_text().splitlines()]
requests = json.loads((RAW / "prompt-formal-requests.json").read_text())
for index, r in enumerate(prompt):
    assert r["runIndex"] == index
    item = by_id[r["caseId"]]
    checks = {c["name"]: c["passed"] for c in r["result"]["checks"]}
    for path, expected in item["outputs"].items():
        text = r["artifacts"][path]
        passed = False
        try:
            if text is not None:
                if "json" in expected:
                    passed = strict_equal(json.loads(text), expected["json"])
                elif "textExact" in expected:
                    passed = text == expected["textExact"]
                else:
                    passed = text.strip() == expected["textTrimmed"]
        except (ValueError, TypeError):
            pass
        assert passed == checks[f"file_strict:{path}"]
    assert r["success"] == all(checks.values())
    assert r["result"]["score"] == sum(checks.values()) / len(checks)
    assistant = [e["message"] for e in r["session"] if e["type"] == "message" and e.get("message", {}).get("role") == "assistant"]
    for key in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]:
        assert r["usage"][key] == sum(m.get("usage", {}).get(key, 0) for m in assistant)
    assert r["usage"]["totalTokens"] == sum(r["usage"][key] for key in ["input", "output", "cacheRead", "cacheWrite"])
    actual_requests = [q for q in requests if q["label"].get("runIndex") == index]
    assert len(actual_requests) == r["requests"]
    assert all(q["payload"]["thinking"] == {"type": "disabled"} and q["payload"]["temperature"] == .2 and q["payload"]["max_tokens"] == 2048 for q in actual_requests)

complete = (RAW / "prompt-complete.json").exists()
if complete:
    assert len(prompt) == 132
    assert sum(r["phase"] == "final" for r in prompt) == 72
    freeze = json.loads((RAW / "prompt-final-freeze.json").read_text())
    assert hashlib.sha256((OUT / "prompt-dataset.json").read_bytes()).hexdigest() == freeze["datasetHash"]
    for r in prompt:
        if r["phase"] == "final":
            expected_hash = hashlib.sha256(b"").hexdigest() if r["label"].startswith("final-baseline-") else freeze["candidateSha256"]
            assert r["promptSha256"] == expected_hash
    generation = [q for q in requests if q["label"]["phase"] == "generation"]
    assert len(generation) == 1
    assert all(case["id"] not in json.dumps(generation, ensure_ascii=False) for case in cases if case["split"] != "training"), "Selection/final leaked into candidate generation"
    assert generation[0]["createdAt"] < freeze["createdAt"] < min(r["createdAt"] for r in prompt if r["phase"] == "final")

result = {"passed": True, "sourceFilesUnchanged": len(manifest["sourceHashes"]), "queueRounds": len(queue["rounds"]),
          "queueTasksIncludingWarmup": len(queue["tasks"]), "cacheProcesses": 12, "cacheRuns": 8448,
          "promptRunsVerified": len(prompt), "promptComplete": complete, "independentArtifactAndUsageRecomputation": True}
(OUT / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
