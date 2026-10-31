import json
import random
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load(mode):
    return [json.loads(line) for line in (ROOT / 'raw' / f'prompt-{mode}-runs.jsonl').read_text().splitlines()]


def percentile(values, fraction):
    values = sorted(values)
    position = (len(values) - 1) * fraction
    index = int(position)
    return values[index] + (values[min(index + 1, len(values) - 1)] - values[index]) * (position - index)


def metrics(rows):
    return {
        'n': len(rows),
        'strictPassed': sum(row['success'] for row in rows),
        'artifactPassed': sum(all(check['passed'] for check in row['result']['checks'] if check['name'].startswith('file_')) for row in rows),
        'toolErrors': sum(row['result']['run']['toolErrors'] for row in rows),
        'requests': sum(row['requests'] for row in rows),
        'meanTokens': statistics.mean(row['usage']['totalTokens'] for row in rows),
        'meanInputIncludingCache': statistics.mean(row['usage']['input'] + row['usage']['cacheRead'] + row['usage']['cacheWrite'] for row in rows),
        'meanOutput': statistics.mean(row['usage']['output'] for row in rows),
        'meanDurationMs': statistics.mean(row['result']['run']['durationMs'] for row in rows),
        'p95DurationMs': percentile([row['result']['run']['durationMs'] for row in rows], .95),
    }


def comparison(mode):
    rows = load(mode)
    arms = {arm: [row for row in rows if f'-{arm}-' in row['label']] for arm in ['before', 'fixed']}
    result = {arm: metrics(values) for arm, values in arms.items()}
    result['changePercent'] = {key: (result['fixed'][key] / result['before'][key] - 1) * 100 for key in ['meanTokens', 'meanDurationMs']}
    ids = sorted({row['caseId'] for row in rows})
    clusters = {arm: {case: metrics([row for row in values if row['caseId'] == case]) for case in ids} for arm, values in arms.items()}
    rng = random.Random(20261021)
    samples = {'meanTokens': [], 'meanDurationMs': [], 'strictRateDifferencePp': []}
    for _ in range(10000):
        chosen = rng.choices(ids, k=len(ids))
        for key in ['meanTokens', 'meanDurationMs']:
            before = sum(clusters['before'][case][key] for case in chosen)
            after = sum(clusters['fixed'][case][key] for case in chosen)
            samples[key].append((after / before - 1) * 100)
        samples['strictRateDifferencePp'].append(statistics.mean((clusters['fixed'][case]['strictPassed'] - clusters['before'][case]['strictPassed']) / 3 * 100 for case in chosen))
    result['taskClusterBootstrap95'] = {key: [percentile(values, .025), percentile(values, .975)] for key, values in samples.items()}
    return result


summary = {mode: comparison(mode) for mode in ['paired', 'followup']}
summary['auxiliary'] = metrics(load('aux'))
all_rows = load('paired') + load('followup') + load('aux')
summary['total'] = {'runs': len(all_rows), 'requests': sum(row['requests'] for row in all_rows), 'reportedTokens': sum(row['usage']['totalTokens'] for row in all_rows)}
(ROOT / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')

lines = ['# 修复与真实复测结果', '', '已修复产品代码并完成测试。原始消融/诊断数据保持不变，本轮未提交。', '',
         '## 72次主对照：完整12项既有final任务，每组36次', '',
         '本轮 before 为修改前工作区快照；fixed-v1 为精简提示词、修正路径/刷新、探测可用命令的产品实现。实际模型请求没有提示词变换，也没有追加候选。两组使用同一 Node v24.19.0、deepseek-flash、temperature=0.2、thinking disabled、max_tokens=2048 和同一禁网/限资源 Docker 镜像，AB/BA交错。', '',
         '| 指标 | before | fixed-v1 |', '|---|---:|---:|']
p = summary['paired']
for label, key, fmt in [('严格通过', 'strictPassed', '{} / 36'), ('产物正确且输入保持', 'artifactPassed', '{} / 36'), ('工具错误', 'toolErrors', '{}'), ('平均全部Token', 'meanTokens', '{:.1f}'), ('平均耗时ms', 'meanDurationMs', '{:.1f}'), ('模型请求次数', 'requests', '{}')]:
    lines.append(f"| {label} | {fmt.format(p['before'][key])} | {fmt.format(p['fixed'][key])} |")
lines += ['', f"平均Token变化 {p['changePercent']['meanTokens']:.2f}%，平均耗时变化 {p['changePercent']['meanDurationMs']:.2f}%。12任务成簇、10000次bootstrap的95%区间（描述本样本，不代表未知任务泛化）：Token {p['taskClusterBootstrap95']['meanTokens']}%；耗时 {p['taskClusterBootstrap95']['meanDurationMs']}%；严格通过率差 {p['taskClusterBootstrap95']['strictRateDifferencePp']} 个百分点。", '',
          '产物本来就是36/36正确，因此不能说推理/生成质量从错误变正确；严格成功率改善主要来自减少无意义工具错误。Token降低主要来自不再每轮携带完整技能/事件/日志教程。API往返仍占大头，节省Token不等于等比例节省时间。缓存Token全部计入；模型单价未知，不报告货币节省。', '',
          '## 18次追加故障回归：当前fixed-v2', '',
          '主对照仍发现一次调用缺失的file。fixed-v2增加明确的“已确认缺失命令”列表，而不是只给可用列表。原72次记录全部保留。对已知unicode路径、文本替换、嵌套配置三项，各组3次，共18次。此轮是定向回归，不能当盲测，当前最终源码与fixed-v2-agent.ts一致。', '',
          '| 指标 | before | fixed-v2 |', '|---|---:|---:|']
f = summary['followup']
for label, key in [('严格通过 /9', 'strictPassed'), ('产物正确且输入保持 /9', 'artifactPassed'), ('工具错误', 'toolErrors'), ('平均全部Token', 'meanTokens'), ('平均耗时ms', 'meanDurationMs')]:
    lines.append(f"| {label} | {f['before'][key]:.2f} | {f['fixed'][key]:.2f} |")
lines += ['', '## 五次附加功能回归', '',
          '明确过滤非正数后的selection任务3/3严格通过；读取事件指南并创建本地事件JSON、发现已安装技能并调用原脚本各1/1通过。实际session记录确认read读取指南/技能文件，bash调用现有技能脚本。未启动events watcher，没有外部提醒投递。此轮仅功能冒烟，不统计质量提升。', '',
          '## 实际产品修复', '',
          '- agent.ts：Docker cwd修正；ResourceLoader读取最新提示词并重建AgentSession base prompt，防止旧的用户/记忆/目标覆盖；教程放到可读指南，保留技能发现；每runner一次能力探测，明确缺失命令；缓存Token纳入输入统计。',
          '- evals/optimizer.ts、optimize-cli.ts：显式quality/tokens/latency目标，质量与工具/产物守卫保留；成本目标需训练和留出集每次重复达到阈值、另一资源指标不超容限；schema3记录策略。生成器收到全部训练重复、有效系统提示词和失败详情。',
          '- evals/runner.ts、types.ts：采集有界、常见Key/Bearer脱敏诊断；可选诊断缺失不会覆盖原任务评分。',
          '- 新版本歧义用例明确先删除非正数；历史数据不变。', '',
          '## 验证和边界', '',
          '27个LightClaw具体测试文件、252项测试通过（tests.log / tests-result.json），npm run check完整通过（check.log）。故障注入测试中预期的错误日志不是未处理失败。其余包未运行完整测试；没有构建、发布、提交或真实平台投递。',
          '自动追加候选生成与成本晋升路径有回归测试；本轮真实API收益来自上述人工定位后的系统提示词/环境工程修复，不是新一轮自动候选搜索的效果证明。',
          '队列和缓存本轮没有改写，也未获得新的进程RSS/内存下降证据。此前队列容量效果属于背压、并非等量任务提速；内存固定依赖开销问题不能靠缩短提示词声称已解决。', '',
          f"本轮共 {summary['total']['runs']} 次任务、{summary['total']['requests']} 次API请求、{summary['total']['reportedTokens']:,} 报告Token；没有排除失败运行。临时容器、挂载工作区与凭证均已删除，旧实验文件哈希独立核对。", '',
          '精确命令见tests-result.json、check-result.json及下列脚本：run-paired.mjs、run-followup.mjs、run-aux.mjs（Node --import tsx，仓库外0600凭证参数；凭证已删除），analyze.py、verify.py。所有原始请求、session、产物及SHA留在raw/与本目录。']
(ROOT / 'report.zh-CN.md').write_text('\n'.join(lines) + '\n')
print(json.dumps(summary, ensure_ascii=False, indent=2))
