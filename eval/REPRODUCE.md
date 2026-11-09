# 复现 Light-Claw 记忆评测

从仓库根目录运行一条命令完成离线流程。需要项目 Node 22、已安装的工作区依赖和 Python 3.12 或更新版本。

```sh
rtk proxy python3 eval/harness/reproduce.py
```

流程核对题库与判分器、复现 S0/S1 缺陷、跑 S2 单元检查、逐臂验证 5 道 dev 题的 Runner 和判分接线，再生成覆盖统计。faux 回答由固定脚本指定，故只验证工程链。离线流程不读 test 的题面、答案或布局做迭代，也不调用远程模型。原题包自检会按要求验证全部 232 条的判分规格。

## 实验身份

- S0 为 `1962a1a57509953076fcdd727bba0dd4c8558b10`。
- S1 为 `ae768386578625ffcea7262aece94ca7c957dbde`，保留在 `memory-v1-snapshot`。
- S2 来自 `memory-v2`。正式评测强制通过 `s2-frozen` 从 Git 提取 S2，校验协议、适配器和只读题包哈希。
- N 使用无文件的 S1 Runner。T 保留 S0 的 Runner 和提示，仅替换为 S1 的 4 KiB 读取策略，并使用旧单文件。O 从题目的事实 ID 构建仅供上界参考的内容。T 和 O 仅用于合成集。
- `eval/protocol.json` 固定抽样种子、重复数、统计和成功条件。种子控制调度和统计抽样。没有可移植的供应商随机种子接口。
- 所有臂只有相同的只读 `read` 与字面检索 `memory_search`。模型可见工作区路径固定，物理文件每次重建。每次运行核对文件内容未变。实验工具集与真实机器人默认工具集有差异。
- `MEMORY_FEATURES` 控制 Runner 的 i4 和 i7。布局器与矩阵分别控制 i1/i2/i3/i9 和 i6。关闭某项用 `--ablate iX`，只接受 dev 试点。

## 付费合成评测

先设置明确的总预算、模型及其凭证。把凭证放在环境变量中。不要在命令参数或日志里写出密钥。DeepSeek 使用独立变量 `LIGHTCLAW_EVAL_DEEPSEEK_API_KEY`。每次启动会先在 `cost_log.md` 写入估算，全部收费阶段共用预算和 80% 暂停线。下方 100 只是命令示例。

```sh
rtk proxy env LIGHTCLAW_EVAL_MODEL_ID=deepseek-v4-flash python3 eval/harness/run.py --route deepseek --model-slot M1 --phase smoke --budget-cny 100
```

从 `smoke` 推进至 `pilot` 后，用 dev 选择配置。正式用 `--phase formal`，强制采用冻结版本与 5 次重复。M2 替换模型 ID 并设置 `--model-slot M2`，可选 `--route configured`。配置路由须显式提供 `LIGHTCLAW_EVAL_PROVIDER`、`LIGHTCLAW_EVAL_MODEL_ID`、`LIGHTCLAW_EVAL_API_KEY`、按 `input,cacheRead,cacheWrite,output` 顺序的 `LIGHTCLAW_EVAL_CNY_PER_MILLION`，以及需要时的 `LIGHTCLAW_EVAL_MODELS_FILE` 与 HTTPS `LIGHTCLAW_EVAL_BASE_URL`。只有供应商明确提供缓存字段时才设置 `LIGHTCLAW_EVAL_CACHE_TELEMETRY=1`。重跑同一条命令从 JSONL 检查点续跑，切换源版本时选择新的 `--runtime` 和 `--result`。分析器按模型和源哈希分开汇总。

上例用当前代码目录中的 Flash 兼容名称。直接使用 `deepseek-flash` 时需显式提供包含该 ID 的模型定义文件。框架在预留费用前离线核对模型。遇到记录不完整的已预留请求，先核对供应商用量和本地账本，再重试相同组合。

官方 DeepSeek 路由可加 `--deepseek-offpeak-budget`。只有整个运行窗口都落在官方空闲时段时，预算预留与结算按高峰参考价的一半计算。跨时段的窗口按高峰价估计，工作日法定假期也按普通工作日保守估计。版本比较统一用峰值参考价。 [官方定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

官方 DeepSeek 和已确认零费率的配置路由可用 `--jobs 4` 保持最多四个运行在途。付费运行在派发前各自记入预算预留，余额不足时等在途运行结算，结算后仍不足则暂停。并发数进入运行指纹，延迟只在同一并发条件内比较。遇到基础设施失败时，框架停止派发并保存已在途的成功结果。按原命令续跑会跳过完整组合。

排查慢网关时，可在 `--phase smoke` 加 `--smoke-run-timeout-s 300`，并使用独立的 `--result` 文件。此设置只改变每项冒烟的总时限，单次模型请求超时、工具轮数、dev 和正式协议保持原值。

2026-11-09 的 M1 官方 dev 矩阵使用 `510e80aa9` 中的串行执行器。该版将本地轮次保护生成的无用量审计项误当成了一次未获用量的真实调用。只在追踪同时满足固定保护原因、真实调用数相符且每次有完整用量时，`resume_pilot.py --matrix-ref 510e80aa9 --result eval/results/pilot-M1-deepseek-flash-official-v2.jsonl --runtime eval/.runtime/m1-deepseek-300s --budget-cny 10` 可保留该失败、结算真实用量并以原执行器续跑。它要求原始失败检查点和私有预算账本。后续执行器直接应用同一追踪修正。

正式使用真实模型运行后，按 [分析器命令](harness/analyze.py) 生成统计和图表。公开数据集下载、抽样和许可见 [来源说明](external-sources.md)。真实日志筛选默认单独运行，输出留在忽略的 `eval/real/`，只由人审核。

公开数据准备后可以单独验证固定写入器，不调用远程模型：

```sh
rtk proxy python3 eval/harness/external_writer.py --plan
```

写入器的执行入口见 `--help`。它只接收历史，用相同提示生成供各臂复用的语料，并和合成矩阵共用本地预算账本。公开基准的问答和官方评分需在真实语料准备完成后单独执行。

有真实写入语料后，使用 `python3 eval/harness/external_qa.py --plan --writer-state <写入语料目录>` 校验回执并准备 N/S0/S1/S2 的共享布局、题目和裁判参考。计划把参考答案和相关会话标记放在独立文件中，Runner 只接收布局与题目。零费率路由可用 `--run --runtime <准备好的运行目录> --max-new-runs 4` 做限量接线验证。公开基准的官方评分仍单独执行。

有外部 QA 回执后，运行 `python3 eval/harness/external_score.py --profile <问答回执配置>`。该命令按固定官方版本的解析方式计算 MemoryAgentBench 的子串匹配，并把 LongMemEval 回答与裁判参考按臂导出。当前没有调用 LongMemEval 裁判，导出不等于评分。
