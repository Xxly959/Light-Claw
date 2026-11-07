> 历史文档：2026-11-06相关产品代码已按用户要求删除。以下内容仅保留历史，不是当前可运行说明。

# LightClaw 并发性能基准

## 目标与边界

本基准测量 LightClaw 在确定性本地工作负载下的频道队列和 Agent Runtime 路径。测试使用 pi-mono 提供的 `pi-ai` faux provider，固定产生一次工具调用和一次最终回复，不连接真实模型、Slack、飞书或其他外部服务。

结果只适用于报告记录的 Git 状态、机器、Node.js 版本和运行参数。faux provider 的延迟与 Token 都是模拟值，不能表示真实模型性能；内存 transport 也不能表示消息平台 API 延迟。

## 被测并发模型

Slack 和飞书都为每个频道维护独立 FIFO 队列。同一频道中的任务串行执行，不同频道的队列可并行执行。系统目前没有跨频道全局并发上限。

基准复用生产队列实现，并为每个频道创建独立 AgentRunner。每项任务包含两次 faux provider 响应和一次确定性等待工具：

```text
enqueue -> queue start -> faux model wait -> tool wait -> faux model wait -> complete
```

## 默认参数

- 并发频道：`1,5,10,20`
- 每频道每轮任务数：`5`
- 每个并发级别预热：`2` 轮
- 每个并发级别正式测量：`10` 轮
- 每次模型响应配置等待：`25 ms`
- 每次工具调用配置等待：`10 ms`
- 资源采样间隔：`10 ms`

正式任务样本分别为 50、250、500 和 1000，总计 1800。预热任务不进入汇总。

## 指标口径

- 队列等待时间：`startedAtNs - enqueuedAtNs`。
- 端到端延迟：`completedAtNs - enqueuedAtNs`。
- 服务时间：`completedAtNs - startedAtNs`。
- 模拟模型等待：两次 faux response factory 实际等待时间之和。
- 模拟工具等待：等待工具内部实际等待时间。
- Agent Runtime 路径开销：服务时间减去模拟模型等待与模拟工具等待。它包含 faux 流式分发、Agent Loop、Session、文件 I/O 和内存 transport。
- 吞吐量：该并发级别所有正式轮次的完成任务总数除以正式轮次墙钟时间之和。
- 错误率：失败任务数除以已接纳任务数。
- P50/P95/P99 与最大值：对所有正式任务原始样本使用 nearest-rank 算法，不平均各轮 percentile；同时提供逐轮统计以定位慢轮次。
- CPU 峰值：资源采样间隔内的最大进程 CPU 利用率，100% 表示一个逻辑核。
- 内存峰值：资源样本中的最大 RSS 和 heap used，同时保留轮次基线与峰值增量。
- 事件循环：Node `monitorEventLoopDelay` 的窗口样本数与最大延迟（分辨率为 `min(resourceSampleMs, 10)` ms），汇总取所有非空窗口最大值。无观测记 `null`/`unavailable`，不是零；不平均窗口百分位数。高速资源采样不得在首个观测前 reset 直方图，否则 Node 计时器一直重启而采不到数据。
- 资源采样迟到：周期回调的实际间隔减配置间隔，下限为零；末尾不完整采样间隔不计迟到。事件循环与采样迟到只能辅助定位，不能单独确认宿主暂停、模型或文件 I/O 是长尾根因。

所有持续时间来自单调时钟。报告同时保存原始时间戳和派生值，以便独立重算。

## 产物

每次运行写入独立目录：

```text
<output>/<run-id>/
├── manifest.json
├── tasks.jsonl
├── rounds.jsonl
├── resources.jsonl
├── summary.json
└── report.md
```

`manifest.json` 记录源码、环境、Docker 可用性、参数、样本数和原始文件 SHA-256。`tasks.jsonl`、`rounds.jsonl` 与 `resources.jsonl` 是逐次原始数据。`summary.json` 和 `report.md` 必须由这些原始文件生成，不得手工补写指标。

新报告 schema 为 2，`summary.json` 的每个并发级别包含 `rounds` 逐轮结果。历史 schema 1 产物保持原样；缺少新资源字段的数据不能直接按新格式重建，避免伪造事件循环观测。基准运行源码入口时，依赖按工作区包的 export 路径加载；本地 Vitest 另用 source alias，两种路径的验收不能互相替代。

## 运行

从包目录运行：

```bash
rtk proxy npx --no-install tsx src/benchmark/cli.ts \
  --channels=1,5,10,20 \
  --warmup-rounds=2 \
  --measurement-rounds=10 \
  --tasks-per-channel=5 \
  --model-delay-ms=25 \
  --tool-delay-ms=10 \
  --resource-sample-ms=10 \
  --output=../../lightclaw-data/benchmarks
```

基准运行在宿主 Node.js 进程中，工具为内存中的确定性等待工具，不使用 LightClaw Docker sandbox。报告仍记录 Docker client/server 和 Docker Desktop 资源配置，并明确标记 `benchmarkUsesDocker: false`。

## 能力归属

`pi-ai` faux provider、`pi-agent-core` Agent Loop 和 `pi-coding-agent` SessionManager 属于 pi-mono 上游。LightClaw 的新增工作是统一频道队列、基准驱动、跨度记录、资源采样、原始报告、汇总生成和适用边界说明。
