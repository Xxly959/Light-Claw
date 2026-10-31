import collections
import datetime
import hashlib
import json
import pathlib
import statistics

OUT = pathlib.Path(__file__).resolve().parent
OLD = OUT.parent / "2026-10-21-ablation"
RAW = OUT / "raw"

def load_runs(path):
    return [json.loads(line) for line in path.read_text().splitlines()]

def epoch_ms(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000

old_runs = load_runs(OLD / "raw/prompt-formal-runs.jsonl")
old_requests = json.loads((OLD / "raw/prompt-formal-requests.json").read_text())
decomposition = {}
for arm in ["baseline", "candidate"]:
    runs = [r for r in old_runs if r["phase"] == "final" and r["label"].startswith(f"final-{arm}-")]
    request_path_ms = 0
    tool_path_ms = 0
    first_input = []
    for run in runs:
        requests = [q for q in old_requests if q["label"].get("runIndex") == run["runIndex"]]
        assistant = [e for e in run["session"] if e.get("message", {}).get("role") == "assistant"]
        assert len(requests) == len(assistant)
        request_path_ms += sum(epoch_ms(e["timestamp"]) - epoch_ms(q["createdAt"]) for q, e in zip(requests, assistant))
        entries = [e for e in run["session"] if e["type"] == "message"]
        tool_path_ms += sum(epoch_ms(e["timestamp"]) - epoch_ms(entries[i - 1]["timestamp"]) for i, e in enumerate(entries)
                            if e.get("message", {}).get("role") == "toolResult" and i > 0)
        usage = assistant[0]["message"]["usage"]
        first_input.append(usage["input"] + usage["cacheRead"] + usage["cacheWrite"])
    decomposition[arm] = {"requests": sum(r["requests"] for r in runs),
                          "usage": {key: sum(r["usage"][key] for r in runs) for key in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]},
                          "requestCountDistribution": dict(collections.Counter(r["requests"] for r in runs)),
                          "requestPathMs": request_path_ms, "toolPathMs": tool_path_ms,
                          "runDurationMs": sum(r["result"]["run"]["durationMs"] for r in runs),
                          "meanFirstInputTokens": statistics.mean(first_input)}
    decomposition[arm]["requestPathFraction"] = request_path_ms / decomposition[arm]["runDurationMs"]

probes = json.loads((RAW / "import-probes.json").read_text())
memory = {}
for subject in sorted({p["sample"]["subject"] for p in probes}):
    rows = [p["sample"] for p in probes if p["sample"]["subject"] == subject]
    assert len(rows) == 3
    memory[subject] = {"heapMiB": statistics.median(r["memory"]["heapUsed"] for r in rows) / 2**20,
                       "rssMiB": statistics.median(r["memory"]["rss"] for r in rows) / 2**20,
                       "commonJsModules": statistics.median(r["commonJsModules"] for r in rows)}
cache_increment = {}
for arm in ["disabled", "combined"]:
    increments = []
    for repetition in range(3):
        run = json.loads((OLD / f"raw/cache-{repetition}-{arm}.json").read_text())
        baseline = next(p for p in run["phases"] if p["phase"] == "baseline-gc")
        idle = next(p for p in run["phases"] if p["phase"] == "idle-gc")
        increments.append((idle["heapUsed"] - baseline["heapUsed"]) / 2**20)
    cache_increment[arm] = statistics.median(increments)

diagnostics = load_runs(RAW / "prompt-diagnostic-runs.jsonl")
diagnostic_requests = json.loads((RAW / "prompt-diagnostic-requests.json").read_text())
groups = {}
for arm in ["control", "candidate", "slim", "capabilities", "cwd"]:
    rows = [r for r in diagnostics if r["label"].startswith(f"diag-{arm}-")]
    if not rows:
        continue
    systems = [m["content"] for q in diagnostic_requests if q["label"]["label"].startswith(f"diag-{arm}-")
               for m in q["payload"]["messages"] if m["role"] == "system"]
    errors = collections.Counter()
    for r in rows:
        for e in r["session"]:
            m = e.get("message", {})
            if m.get("role") == "toolResult" and m.get("isError"):
                text = json.dumps(m.get("content", []), ensure_ascii=False)
                errors["missing_file" if "file: not found" in text else "host_path" if "can't cd to /Users/x/hermes-workspace/Light-Claw" in text else "other"] += 1
    groups[arm] = {"runs": len(rows), "strictPassed": sum(r["success"] for r in rows),
                   "artifactPassed": sum(all(c["passed"] for c in r["result"]["checks"] if c["name"].startswith("file_")) for r in rows),
                   "toolErrors": sum(r["result"]["run"]["toolErrors"] for r in rows), "errorReasons": dict(errors),
                   "meanTokens": statistics.mean(r["usage"]["totalTokens"] for r in rows),
                   "meanInputTokens": statistics.mean(r["usage"]["input"] + r["usage"]["cacheRead"] + r["usage"]["cacheWrite"] for r in rows),
                   "meanOutputTokens": statistics.mean(r["usage"]["output"] for r in rows),
                   "usageSum": {key: sum(r["usage"][key] for r in rows) for key in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]},
                   "meanSeconds": statistics.mean(r["result"]["run"]["durationMs"] for r in rows) / 1000,
                   "meanRequests": statistics.mean(r["requests"] for r in rows),
                   "systemCharsMedian": statistics.median(len(s) for s in systems),
                   "cases": {case: {"strictPassed": sum(r["success"] for r in rows if r["caseId"] == case),
                                    "artifactPassed": sum(all(c["passed"] for c in r["result"]["checks"] if c["name"].startswith("file_")) for r in rows if r["caseId"] == case)}
                             for case in sorted({r["caseId"] for r in rows})}}
result = {"originalDecomposition": decomposition, "memoryImportProbes": memory, "cacheIncrementalHeapMiB": cache_increment,
          "diagnosticStatus": "complete" if (RAW / "diagnostic-complete.json").exists() else "running", "diagnosticRuns": len(diagnostics), "diagnosticGroups": groups,
          "policy": json.loads((RAW / "policy-probes.json").read_text())}
if result["diagnosticStatus"] == "complete":
    assert len(diagnostics) == 45 and all(g["runs"] == 9 for g in groups.values())
    b = groups["control"]
    for name, group in groups.items():
        group["tokenChangeVsControlPercent"] = (group["meanTokens"] / b["meanTokens"] - 1) * 100
        group["timeChangeVsControlPercent"] = (group["meanSeconds"] / b["meanSeconds"] - 1) * 100
    result["additionalRealUsage"] = json.loads((RAW / "diagnostic-complete.json").read_text())
if (RAW / "clarification-complete.json").exists():
    clarification = load_runs(RAW / "prompt-clarification-runs.jsonl")
    assert len(clarification) == 6
    result["clarification"] = {}
    for arm in ["original", "clarified"]:
        rows = [r for r in clarification if r["label"].startswith(f"clarify-{arm}-")]
        result["clarification"][arm] = {"runs": len(rows), "strictPassed": sum(r["success"] for r in rows),
                                        "artifactPassed": sum(all(c["passed"] for c in r["result"]["checks"] if c["name"].startswith("file_")) for r in rows),
                                        "toolErrors": sum(r["result"]["run"]["toolErrors"] for r in rows)}
    result["clarificationUsage"] = json.loads((RAW / "clarification-complete.json").read_text())
(OUT / "summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")

lines = ["# 消融结果的根因诊断", "", "本报告使用原始请求/session拆解、27个独立进程内存探针、门禁反事实验证，以及45项已知案例单因素真实模型诊断。不将已知案例当新盲测。", "",
         "## 时间与Token的去向", "", "| 原盲测组 | 模型请求 | 总输入（含缓存） | 输出 | 首轮输入均值 | 请求至助手持久化占比 |", "|---|---:|---:|---:|---:|---:|"]
for arm, r in decomposition.items():
    lines.append(f"| {arm} | {r['requests']} | {r['usage']['input']+r['usage']['cacheRead']+r['usage']['cacheWrite']} | {r['usage']['output']} | {r['meanFirstInputTokens']:.1f} | {r['requestPathFraction']*100:.2f}% |")
lines += ["", "候选首轮输入增加77Token，后续请求继续携带追加指令；同时总请求多8次。输出虽少1171Token，输入却多40385Token，抵消后仍多39214总Token。请求路径包含实验记录、网络、服务端与流处理，不等于纯模型推理；工具阶段仅约4%，不能把缩短回复或清理本地队列等同减少远程轮次。", "",
          "## 真实单因素诊断", "", f"状态：{result['diagnosticStatus']}。3个已知案例、每组各重复3次；工具、任务和参数相同。candidate追加原候选；slim只移除未用到的技能/事件和配置日志/查询教程；capabilities只声明固定环境可用命令；cwd只修末尾工作目录。", "",
          "| 组 | 运行 | 产物正确 | 严格通过 | 工具错误 | 系统字符中位数 | 平均总Token | 平均请求数 | 平均秒 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
for arm, r in groups.items():
    lines.append(f"| {arm} | {r['runs']} | {r['artifactPassed']} | {r['strictPassed']} | {r['toolErrors']} | {r['systemCharsMedian']} | {r['meanTokens']:.1f} | {r['meanRequests']:.3f} | {r['meanSeconds']:.3f} |")
if result["diagnosticStatus"] == "complete":
    lines += ["", f"裁剪组相对本轮control：总Token变化{groups['slim']['tokenChangeVsControlPercent']:.2f}%，耗时变化{groups['slim']['timeChangeVsControlPercent']:.2f}%。这些是已知短文件案例的点估计，不推广为生产提升。逐例正确率及错误类型见summary.json。"]
lines += ["", "## 优化器目标与反馈缺口", "", "实际decidePromotion对质量相同、Token和耗时减半的反事实报告仍拒绝，理由是训练均分未严格提高。说明它不是成本优化器；此反事实只验证策略，不是实现了减半。候选生成只见任务与第一轮训练报告的检查失败名，未看到实际系统提示词、工具定义、环境能力或file缺失的原始错误，因此无法定位环境故障；且只能追加指令，无法删除冗长基础提示词。", "",
          "## 工作目录的准确根因", "", "LightClaw Docker envDescription正确写/workspace，但createAgentRunner给AgentSession的cwd是process.cwd()；AgentSession._rebuildSystemPrompt调用coding-agent/core/system-prompt.ts的customPrompt分支，再在末尾追加宿主cwd。原始API请求同时包含两处矛盾路径。probe-policy.mjs已确定性复现。上轮直接把根因归到agent.ts的host环境分支不准确，此处更正，不改原始实验结果。", "",
          "## 固定内存与可回收增量", "", "所有探针均3个独立进程中位数，相同GC；native-empty不加载tsx，其余使用同一开发态loader。", "", "| 导入层 | heap MiB | RSS MiB |", "|---|---:|---:|"]
for name, r in memory.items():
    lines.append(f"| {name} | {r['heapMiB']:.3f} | {r['rssMiB']:.3f} |")
lines += ["", f"旧缓存实验扣除各进程加载前的固定heap后，空闲增量中位数为{cache_increment['disabled']:.3f}→{cache_increment['combined']:.3f}MiB，减少{(1-cache_increment['combined']/cache_increment['disabled'])*100:.2f}%。相对总heap约28.7%与相对增量的比例不同，不能拿后者宣传整体内存减少。基础依赖与tsx不会随频道释放。窄导入AgentSession等仍加载相近模块图，未测到heap收益，不能只改import路径就宣称瘦身。", "",
          "RSS包含heap以外的内存，短程对象释放不保证RSS同比下降；本次未用堆快照/原生分配器归因全部RSS余量，不断言具体碎片或泄漏根因。Node文档：https://nodejs.org/api/process.html#processmemoryusage 。", "",
          "## 案例与指标边界", "", "原最终集都是小文件确定性转换，基线产物36/36正确，产物质量已触顶；严格失败主要来自缺file，不代表内容生成错误。原选型集正数过滤案例存在描述歧义，已单独复现澄清，撤回将其归因于模型理解失败的说法。现有训练反馈与目标不支持用这些例子证明综合推理、长期任务或成本优化；需另设有真实失败空间的任务和成本目标，避免事后换题挑结果。队列实验固定服务20ms，本来就没有改变服务时间，且保留同频道串行；测的是背压，不是调度算法加速。", "",
          "本轮未修改产品源码，也未安装缺失程序来改变对照环境。所有新真实请求与原始session保存在raw/，不覆盖旧实验。", ""]
if "clarification" in result:
    c = result["clarification"]
    lines += ["## 追加：用例歧义的最小复现", "",
              "原题“将数组中严格大于0的数各乘2”没有明确要求删除其他元素，模型输出[0,4,-4,14,4]属于合理解释；评分器却只接受[4,14,4]，产生错误失败标签。",
              f"保持环境和期望不变，仅将任务澄清为“先删除所有小于或等于0的元素”：原表述产物通过{c['original']['artifactPassed']}/3，澄清表述{c['clarified']['artifactPassed']}/3。严格通过分别{c['original']['strictPassed']}/3、{c['clarified']['strictPassed']}/3，澄清后仍有{c['clarified']['toolErrors']}次工具错误。这证明任务契约与环境错误是两个独立问题；不能把澄清题目当作原候选提质。原始记录与盲测结果不修改。", ""]
(OUT / "report.zh-CN.md").write_text("\n".join(lines))
print(json.dumps({"status": result["diagnosticStatus"], "diagnosticRuns": len(diagnostics), "groups": groups}, ensure_ascii=False))
