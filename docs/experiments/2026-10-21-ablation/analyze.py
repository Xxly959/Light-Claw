import hashlib
import json
import math
import pathlib
import random
import statistics
from collections import defaultdict

OUT = pathlib.Path(__file__).resolve().parent
RAW = OUT / "raw"

def quantile(values, q):
    return sorted(values)[max(0, math.ceil(len(values) * q) - 1)] if values else None

def distribution(values):
    return {"mean": statistics.mean(values), "median": statistics.median(values),
            "p95": quantile(values, .95), "p99": quantile(values, .99), "min": min(values), "max": max(values)} if values else None

queue = json.loads((RAW / "queue.json").read_text())
queue_summary = []
for scenario in ["normal", "burst"]:
    baseline = {(t["repetition"], t["channel"], t["index"]): t for t in queue["tasks"]
                if t["scenario"] == scenario and t["arm"] == "disabled" and t["repetition"] >= 0 and t["status"] == "completed"}
    for arm in queue["arms"]:
        tasks = [t for t in queue["tasks"] if t["scenario"] == scenario and t["arm"] == arm and t["repetition"] >= 0]
        completed = [t for t in tasks if t["status"] == "completed"]
        rounds = [r for r in queue["rounds"] if r["scenario"] == scenario and r["arm"] == arm and r["repetition"] >= 0]
        assert len(rounds) == 12
        assert sum(r["submitted"] for r in rounds) == len(tasks)
        assert sum(r["completed"] + r["expired"] + r["rejected"] for r in rounds) == len(tasks)
        per_round_differences = defaultdict(list)
        for t in completed:
            peer = baseline.get((t["repetition"], t["channel"], t["index"]))
            if peer:
                per_round_differences[t["repetition"]].append((t["startedMs"] - t["submittedMs"]) - (peer["startedMs"] - peer["submittedMs"]))
        queue_summary.append({"scenario": scenario, "arm": arm, "submitted": len(tasks), "completed": len(completed),
                              "completionFraction": len(completed) / len(tasks),
                              "rejected": sum(t["status"] == "rejected" for t in tasks),
                              "expired": sum(t["status"] == "expired" for t in tasks),
                              "maxPending": max(r["peakPending"] for r in rounds),
                              "completedQueueWaitMs": distribution([t["startedMs"] - t["submittedMs"] for t in completed]),
                              "completedServiceMs": distribution([t["finishedMs"] - t["startedMs"] for t in completed]),
                              "allSubmissionOutcomeMs": distribution([t["finishedMs"] - t["submittedMs"] for t in tasks]),
                              "roundWallMs": distribution([r["wallMs"] for r in rounds]),
                              "commonCompletedPerRoundMeanWaitDifferenceMs": distribution([statistics.mean(v) for v in per_round_differences.values()]),
                              "realModelTokens": None})

cache_summary = []
for arm in ["disabled", "capacity", "ttl", "combined"]:
    runs = [json.loads((RAW / f"cache-{i}-{arm}.json").read_text()) for i in range(3)]
    assert all(len(r["tasks"]) == 704 and r["created"] == r["released"] for r in runs)
    assert all(t["messageCount"] == t["turn"] * 2 + 1 for r in runs for t in r["tasks"])
    for index, r in enumerate(runs):
        baseline = json.loads((RAW / f"cache-{index}-disabled.json").read_text())
        assert [(t["id"], t["turn"], t["contextChars"]) for t in r["tasks"]] == [(t["id"], t["turn"], t["contextChars"]) for t in baseline["tasks"]]
    revisit = [t for r in runs for t in r["tasks"] if t["stage"] == "revisit"]
    phases = {}
    for phase in ["baseline-natural", "baseline-gc", "filled-natural", "filled-gc", "idle-natural", "idle-gc", "revisited-gc", "closed-gc"]:
        rows = [next(p for p in r["phases"] if p["phase"] == phase) for r in runs]
        phases[phase] = {metric: distribution([p[metric] for p in rows]) for metric in ["heapUsed", "rss", "retained"]}
    cache_summary.append({"arm": arm, "independentProcesses": 3, "retainedAfterIdle": [r["retainedAfterIdle"] for r in runs],
                          "phases": phases, "revisitCount": len(revisit), "revisitHits": sum(t["hit"] for t in revisit),
                          "revisitCreateMs": distribution([t["createMs"] for t in revisit]),
                          "revisitCreateAndRunMs": distribution([t["createMs"] + t["runMs"] for t in revisit]),
                          "coldCreateMs": distribution([t["createMs"] for t in revisit if not t["hit"]]),
                          "hotCreateMs": distribution([t["createMs"] for t in revisit if t["hit"]]),
                          "allRevisitHistoriesPreserved": True, "identicalContextCharactersAcrossArms": True,
                          "realModelTokens": None})

result = {"schemaVersion": 1, "queue": queue_summary, "cache": cache_summary, "prompt": {"status": "pending"}}
prompt_file = RAW / "prompt-formal-runs.jsonl"
if prompt_file.exists():
    prompt = [json.loads(line) for line in prompt_file.read_text().splitlines()]
    final = [r for r in prompt if r["phase"] == "final"]
    result["prompt"] = {"status": "complete" if (RAW / "prompt-complete.json").exists() else "running",
                        "recordedRuns": len(prompt), "finalRuns": len(final), "allRunReportedTokens": sum(r["usage"]["totalTokens"] for r in prompt)}
    groups = {}
    for arm in ["baseline", "candidate"]:
        rows = [r for r in final if r["label"].startswith(f"final-{arm}-")]
        if rows:
            artifact_success = lambda r: all(c["passed"] for c in r["result"]["checks"] if c["name"].startswith("file_"))
            groups[arm] = {"runs": len(rows), "strictPassed": sum(r["success"] for r in rows),
                           "strictSuccessRate": statistics.mean(r["success"] for r in rows),
                           "artifactPassed": sum(artifact_success(r) for r in rows),
                           "artifactSuccessRate": statistics.mean(artifact_success(r) for r in rows),
                           "meanCheckScore": statistics.mean(r["result"]["score"] for r in rows),
                           "toolErrors": sum(r["result"]["run"]["toolErrors"] for r in rows),
                           "toolCalls": distribution([r["result"]["run"]["toolCalls"] for r in rows]),
                           "durationMs": distribution([r["result"]["run"]["durationMs"] for r in rows]),
                           "responseChars": distribution([r["responseChars"] for r in rows]),
                           "usage": {key: {"sum": sum(r["usage"][key] for r in rows), "mean": statistics.mean(r["usage"][key] for r in rows)}
                                     for key in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]},
                           "totalInputTokensIncludingCache": sum(r["usage"]["input"] + r["usage"]["cacheRead"] + r["usage"]["cacheWrite"] for r in rows)}
    result["prompt"]["groups"] = groups
    tool_error_roots = defaultdict(int)
    for r in final:
        for entry in r["session"]:
            message = entry.get("message", {})
            if message.get("role") == "toolResult" and message.get("isError"):
                text = json.dumps(message.get("content", []), ensure_ascii=False)
                reason = "missing_file_command" if "file: not found" in text else "host_cwd_in_docker" if "can't cd to /Users/x/hermes-workspace/Light-Claw" in text else "other"
                tool_error_roots[reason] += 1
    result["prompt"]["toolErrorRoots"] = dict(tool_error_roots)
    if (RAW / "prompt-selection.json").exists():
        selection = json.loads((RAW / "prompt-selection.json").read_text())
        result["prompt"]["selection"] = {"promoted": selection["promoted"], "reasons": selection["candidates"][0]["decision"]["reasons"],
                                         "baseline": {split: [r["score"] for r in selection["baseline"][split]] for split in ["training", "holdout"]},
                                         "candidate": {split: [r["score"] for r in selection["candidates"][0]["evaluation"][split]] for split in ["training", "holdout"]}}
    if result["prompt"]["status"] == "complete":
        assert len(prompt) == 132 and len(final) == 72
        cases = sorted({r["caseId"] for r in final})
        pairs = []
        deltas = []
        for case in cases:
            by_arm = {arm: [r for r in final if r["caseId"] == case and r["label"].startswith(f"final-{arm}-")] for arm in ["baseline", "candidate"]}
            assert all(len(v) == 3 for v in by_arm.values())
            delta = statistics.mean(r["success"] for r in by_arm["candidate"]) - statistics.mean(r["success"] for r in by_arm["baseline"])
            deltas.append(delta)
            pairs.append({"caseId": case, "baselinePassed": sum(r["success"] for r in by_arm["baseline"]),
                          "candidatePassed": sum(r["success"] for r in by_arm["candidate"]),
                          "baselineMeanTokens": statistics.mean(r["usage"]["totalTokens"] for r in by_arm["baseline"]),
                          "candidateMeanTokens": statistics.mean(r["usage"]["totalTokens"] for r in by_arm["candidate"]),
                          "failures": [{"label": r["label"], "checks": [c["name"] for c in r["result"]["checks"] if not c["passed"]]} for v in by_arm.values() for r in v if not r["success"]]})
        rng = random.Random(20261021)
        bootstrap = sorted(statistics.mean(rng.choices(deltas, k=len(deltas))) for _ in range(10000))
        result["prompt"]["pairedCases"] = pairs
        result["prompt"]["strictSuccessDifference"] = {"candidateMinusBaseline": statistics.mean(deltas),
                                                        "taskClusterBootstrap95Percentile": [quantile(bootstrap, .025), quantile(bootstrap, .975)],
                                                        "taskClusters": len(cases), "resamples": 10000, "seed": 20261021}
        total = json.loads((RAW / "prompt-complete.json").read_text())
        pilot = [json.loads(line) for line in (RAW / "prompt-pilot-runs.jsonl").read_text().splitlines()]
        result["prompt"]["costAccounting"] = {"formalReportedTokensIncludingGeneration": total["reportedTokens"],
                                               "formalRequestsIncludingGeneration": total["requestCount"],
                                               "generationReportedTokens": total["reportedTokens"] - sum(r["usage"]["totalTokens"] for r in prompt),
                                               "selectionTaskTokens": sum(r["usage"]["totalTokens"] for r in prompt if r["phase"] != "final"),
                                               "pilotTokensExcludedFromComparison": sum(r["usage"]["totalTokens"] for r in pilot),
                                               "allExperimentReportedTokens": total["reportedTokens"] + sum(r["usage"]["totalTokens"] for r in pilot),
                                               "monetaryCost": None}

(OUT / "summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"queueGroups": len(queue_summary), "cacheGroups": len(cache_summary), "prompt": {k: v for k, v in result["prompt"].items() if k in ["status", "recordedRuns", "finalRuns", "allRunReportedTokens"]}}, ensure_ascii=False))

lines = ["# 消融实验报告（2026-10-21）", "", "所有数值由 analyze.py 从 raw/ 重算；状态以本页提示词栏为准。", "",
         "## 队列：减少积压的代价", "", "20频道；固定20ms服务；每组12轮。普通负载每频道2项，突发每频道40项。deadline=65ms为加速配置。", "",
         "| 负载 | 组 | 提交 | 完成 | 拒绝 | 过期 | 完成任务等待P95 ms | 最大pending | 共同完成任务配对等待差中位数 ms |",
         "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
for r in queue_summary:
    lines.append(f"| {r['scenario']} | {r['arm']} | {r['submitted']} | {r['completed']} | {r['rejected']} | {r['expired']} | {r['completedQueueWaitMs']['p95']:.3f} | {r['maxPending']} | {r['commonCompletedPerRoundMeanWaitDifferenceMs']['median']:.3f} |")
lines += ["", "共同任务差以同一生产队列、容量与期限均关闭的disabled组为参照；正值更慢。拒绝/过期不是完成，不将等待P95下降等同同工作量提速。队列实验没有模型调用，不存在实测Token节省。", "",
          "## 缓存：堆内存、RSS与重建代价", "", "320真实Runner各2轮；faux模型；每组3独立进程。容量128为默认，TTL1000ms为加速配置。下表内存为相同强制GC协议后的进程中位数，非长期生产RSS。", "",
          "| 组 | 空闲后保留 | 加载后heap MiB | 空闲后heap MiB | 空闲后RSS MiB | 再访命中/192 | 再访取得Runner中位数 ms | 再访创建+执行P95 ms |",
          "|---|---:|---:|---:|---:|---:|---:|---:|"]
for r in cache_summary:
    lines.append(f"| {r['arm']} | {r['retainedAfterIdle'][0]} | {r['phases']['filled-gc']['heapUsed']['median']/2**20:.3f} | {r['phases']['idle-gc']['heapUsed']['median']/2**20:.3f} | {r['phases']['idle-gc']['rss']['median']/2**20:.3f} | {r['revisitHits']}/192 | {r['revisitCreateMs']['median']:.4f} | {r['revisitCreateAndRunMs']['p95']:.4f} |")
lines += ["", "所有组再访历史消息数与传给模型的消息文本字符数完全一致。缓存回收没有压缩上下文；这不支持Token下降。进程RSS与heap不是同一指标。", "", "## 提示词真实模型对照", "", f"状态：{result['prompt']['status']}。模型deepseek-flash、thinking关闭、任务temperature=0.2；工具在禁网Docker。最终12任务各重复3次，AB/BA配对。"]
if "groups" in result["prompt"]:
    lines += ["", "| 组 | 已完成运行 | 严格通过 | 产物正确且输入未变 | 工具错误 | 平均总Token（含缓存） | 平均输出Token | 平均耗时秒 |",
              "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for arm, r in result["prompt"]["groups"].items():
        lines.append(f"| {arm} | {r['runs']} | {r['strictPassed']}/{r['runs']} | {r['artifactPassed']}/{r['runs']} | {r['toolErrors']} | {r['usage']['totalTokens']['mean']:.1f} | {r['usage']['output']['mean']:.1f} | {r['durationMs']['mean']/1000:.3f} |")
if "selection" in result["prompt"]:
    s = result["prompt"]["selection"]
    lines += ["", f"选型门禁晋升：{s['promoted']}。拒绝原因：{'; '.join(s['reasons']) or '无'}。", "", "冻结候选即使被拒绝也继续盲测，以观察效果；没有用最终测试集选候选。"]
if result["prompt"]["status"] == "complete":
    ci = result["prompt"]["strictSuccessDifference"]
    lines += ["", f"严格通过率差（候选-基线）：{ci['candidateMinusBaseline']*100:.2f}个百分点；按12任务聚类的bootstrap 95%区间：[{ci['taskClusterBootstrap95Percentile'][0]*100:.2f}, {ci['taskClusterBootstrap95Percentile'][1]*100:.2f}]个百分点。小集且任务类型有限，不证明生产泛化。",
              "", "### 逐任务结果", "", "| 任务 | 基线通过/3 | 候选通过/3 | 基线平均Token | 候选平均Token |", "|---|---:|---:|---:|---:|"]
    for p in result["prompt"]["pairedCases"]:
        lines.append(f"| {p['caseId']} | {p['baselinePassed']} | {p['candidatePassed']} | {p['baselineMeanTokens']:.1f} | {p['candidateMeanTokens']:.1f} |")
    a = result["prompt"]["groups"]["baseline"]
    b = result["prompt"]["groups"]["candidate"]
    cost = result["prompt"]["costAccounting"]
    lines += ["", "### 本轮结论与失败定位", "",
              f"两组产物均36/36正确，候选没有改善本组任务产物质量。严格通过率为{a['strictSuccessRate']*100:.1f}%→{b['strictSuccessRate']*100:.1f}%，差异区间跨0，不能声称稳定退化或提升。候选平均总Token增加{(b['usage']['totalTokens']['mean']/a['usage']['totalTokens']['mean']-1)*100:.2f}%，输出Token变化{(b['usage']['output']['mean']/a['usage']['output']['mean']-1)*100:.2f}%；平均耗时基本相同，P95为{a['durationMs']['p95']/1000:.3f}→{b['durationMs']['p95']/1000:.3f}秒。输出更短没有带来总Token节省。",
              f"最终工具错误根因计数：{json.dumps(result['prompt']['toolErrorRoots'], ensure_ascii=False)}。容器未安装file命令，部分编码自检因此返回127；另有一次模型尝试进入宿主路径，系统提示词agent.ts的Bash working directory实际使用process.cwd()，与Docker内路径不一致。这是当前实现与固定镜像上的效果，不是纯模型推理能力的比较。未在两组中途安装工具或修提示词，以免改变对照条件。",
              f"正式实验含生成共{cost['formalRequestsIncludingGeneration']}次请求、{cost['formalReportedTokensIncludingGeneration']}个实际usage Token；其中选型任务{cost['selectionTaskTokens']}、候选生成{cost['generationReportedTokens']}。排除在对照外的pilot另用{cost['pilotTokensExcludedFromComparison']}Token，全部投入{cost['allExperimentReportedTokens']}Token。没有从占位价格推算费用。",
              "", "单候选实验不代表所有提示词优化都无效；本次候选未通过门禁且没有质量收益，不能写成已经通过自动提示词优化提升成功率。"]
lines += ["", "## 复现与边界", "", "运行协议见 protocol.zh-CN.md；源码快照与启动状态见 manifest.json/source-snapshot；缓存精确执行命令见 raw/cache-commands.json；提示词原始请求与session见raw/prompt-formal-*。模型cost占位0不代表免费，Token取实际usage且包含缓存。候选生成和选型成本属于额外投入，不能只报告使用阶段节省。没有模型训练、生产IM投递验证、长时间内存稳定性验证或跨机器性能结论。", ""]
(OUT / "report.zh-CN.md").write_text("\n".join(lines))

manifest = {str(p.relative_to(OUT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.rglob("*") if p.is_file() and "source-snapshot" not in p.parts and p.name != "artifact-hashes.json"}
(OUT / "artifact-hashes.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
