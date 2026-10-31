import hashlib
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parent
OLD = OUT.parent / "2026-10-21-ablation"
ROOT = OUT.parents[2]
manifest = json.loads((OLD / "manifest.json").read_text())
assert all(hashlib.sha256((ROOT / p).read_bytes()).hexdigest() == h for p, h in manifest["sourceHashes"].items())
dataset = {c["id"]: c for c in json.loads((OLD / "prompt-dataset.json").read_text())}
old_checksums = json.loads((OLD / "artifact-hashes.json").read_text())
for p, h in old_checksums.items():
    if p.startswith("raw/"):
        assert hashlib.sha256((OLD / p).read_bytes()).hexdigest() == h, p
total = 0
tools = None
for mode, expected_count in [("diagnostic", 45), ("clarification", 6)]:
    rows = [json.loads(line) for line in (OUT / f"raw/prompt-{mode}-runs.jsonl").read_text().splitlines()]
    requests = json.loads((OUT / f"raw/prompt-{mode}-requests.json").read_text())
    assert len(rows) == expected_count
    for index, r in enumerate(rows):
        assert r["runIndex"] == index
        checks = {c["name"]: c["passed"] for c in r["result"]["checks"]}
        for path, expected in dataset[r["caseId"]]["outputs"].items():
            text = r["artifacts"][path]
            passed = False
            try:
                if "json" in expected:
                    passed = json.loads(text) == expected["json"]
                elif "textExact" in expected:
                    passed = text == expected["textExact"]
                else:
                    passed = text.strip() == expected["textTrimmed"]
            except (ValueError, TypeError):
                pass
            assert passed == checks[f"file_strict:{path}"]
        assert r["success"] == all(checks.values())
        assert r["result"]["score"] == sum(checks.values()) / len(checks)
        assistant = [e["message"] for e in r["session"] if e.get("message", {}).get("role") == "assistant"]
        for k in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]:
            assert r["usage"][k] == sum(m["usage"][k] for m in assistant)
        reqs = [q for q in requests if q["label"].get("runIndex") == index]
        assert len(reqs) == r["requests"]
        for q in reqs:
            payload = q["payload"]
            assert payload["temperature"] == .2 and payload["thinking"] == {"type": "disabled"}
            assert payload["max_tokens"] == 2048
            if tools is None:
                tools = payload["tools"]
            assert tools == payload["tools"], "Tool set changed between diagnostic arms"
            system = next(m["content"] for m in payload["messages"] if m["role"] == "system")
            if mode == "diagnostic":
                arm = r["label"].split("-")[1]
                assert ("## Skills (Custom CLI Tools)" in system) == (arm != "slim")
                assert ("## Actual command availability" in system) == (arm == "capabilities")
                if arm == "cwd":
                    assert system.endswith("Current working directory: /workspace")
                else:
                    assert "/Users/x/hermes-workspace/Light-Claw" in system
                if arm == "slim":
                    assert "non-root" in system and "cannot install system packages" in system
            else:
                text = json.dumps(payload["messages"], ensure_ascii=False)
                assert ("先删除数组中所有小于或等于0的元素" in text) == r["label"].startswith("clarify-clarified-")
    total += len(rows)
probes = json.loads((OUT / "raw/import-probes.json").read_text())
assert len(probes) == 27 and all(p["exitCode"] == 0 for p in probes)
policy = json.loads((OUT / "raw/policy-probes.json").read_text())
assert policy["sameQualityHalfTokenAndLatency"]["accepted"] is False
assert policy["customSystemPromptStillGetsHostCwdAppended"] is True
for p in OUT.glob("*.py"):
    compile(p.read_text(), str(p), "exec")
result = {"passed": True, "realRuns": total, "independentImportProcesses": len(probes), "singleFactorAndToolSetVerified": True,
          "rawArtifactsAndUsageRecomputed": True, "oldRawArtifactsUnchanged": True, "productSourcesUnchanged": len(manifest["sourceHashes"])}
(OUT / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
