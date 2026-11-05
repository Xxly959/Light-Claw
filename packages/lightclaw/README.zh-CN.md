# LightClaw 使用指南

部署状态：2026-11-05已完成真实Docker定向验收、五包隔离构建与macOS/Node22.23.0独立离线安装；真实飞书/Slack和真实模型仍待专用环境授权。详见[部署](docs/deployment.zh-CN.md)、[故障排查](docs/troubleshooting.zh-CN.md)、[资源策略](docs/resources.zh-CN.md)和[公开验收证据](../../docs/verification/2026-11-05/README.zh-CN.md)。单实例、同一信任域，不提供租户隔离。

[English](README.md) · [项目首页](../../README.md) · [架构](docs/architecture.zh-CN.md) · [目标验收](docs/goals.zh-CN.md)

LightClaw 将飞书和 Slack 消息接入同一套 Agent 运行时，支持多轮任务、进度持久化、文件与命令验收、Docker 工具执行，以及运行审计和评测。

项目首页介绍使用场景与核心能力；本指南说明启动、模型配置、目标控制和评测方法。

## 安装与启动

在仓库根目录安装依赖：

LightClaw 要求 Node.js >=22.19.0，与 undici 的最低版本要求一致。Node Agent 在宿主机运行，Docker 镜像提供工具执行环境。

```bash
git clone https://github.com/Xxly959/Light-Claw.git
cd Light-Claw
npm install
mkdir -p lightclaw-data
bash packages/lightclaw/docker.sh create ./lightclaw-data
```

配置 OpenAI 兼容模型：

```bash
export LIGHTCLAW_MODEL_PROVIDER=zai
export LIGHTCLAW_MODEL_ID=glm-5.3-flash
export OPENAI_API_KEY=你的密钥
# 使用自定义 OpenAI 兼容网关时设置：
# export OPENAI_BASE_URL=https://your-gateway.example/v1
```

`LIGHTCLAW_MODEL_PROVIDER` 和 `LIGHTCLAW_MODEL_ID` 必须能在 pi 的模型注册表中找到。也可以改用 `deepseek`、`moonshotai-cn` 等已有 provider。

### 飞书模式

```bash
export LIGHTCLAW_TRANSPORT=feishu
export LIGHTCLAW_FEISHU_APP_ID=cli_xxx
export LIGHTCLAW_FEISHU_APP_SECRET=xxx
npx tsx packages/lightclaw/src/main.ts --sandbox=docker:lightclaw-sandbox ./lightclaw-data
```

飞书应用需启用机器人能力，通过长连接订阅 `im.message.receive_v1`，并允许机器人读取和发送消息。群聊中需要 @ 机器人，私聊可以直接发送。

### Slack 模式

开启 Socket Mode，并按 [Slack 接入指南](docs/slack-bot-minimal-guide.md) 配置事件与权限。

```bash
export LIGHTCLAW_TRANSPORT=slack
export LIGHTCLAW_SLACK_APP_TOKEN=xapp-xxx
export LIGHTCLAW_SLACK_BOT_TOKEN=xoxb-xxx
npx tsx packages/lightclaw/src/main.ts --sandbox=docker:lightclaw-sandbox ./lightclaw-data
```

凭证通过环境变量或 pi 认证存储读取，启动入口不会自动加载 `.env`。省略 `--sandbox` 时工具在宿主机执行；Docker 默认使用 `bridge` 网络，创建容器前可设置 `LIGHTCLAW_SANDBOX_NETWORK=none`。详见[沙箱配置](docs/sandbox.zh-CN.md)。

## 附件权限与离线回归

宿主附件读取需要 POSIX（Linux/macOS）和宿主 `python3`（Python 3.9+）；Docker 内的 Python 不能代替宿主依赖。缺少依赖时上传明确失败。仅可上传当前频道目录内的普通文件，单文件不超过 20 MiB；拒绝目录穿越、跨频道/共享文件、符号链接和多硬链接。`attach` 支持频道相对路径，例如 `scratch/report.pdf`，以及当前频道的 host/Docker 绝对路径；平台 `uploadFile` 只接受频道相对路径。

读取器逐级以目录文件描述符和 `O_NOFOLLOW` 打开，从同一文件描述符限量读取并检查变化，SDK 仅接收内存字节。宿主工作区根路径、祖先目录、Python 解释器和应用安装必须可信；这是附件读取权限边界，不是对 host 模式任意 shell 命令的隔离。Windows 不支持该安全读取器。

在 `packages/lightclaw` 目录运行已授权的具体回归：

```bash
rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run test/attachment-upload.test.ts test/runner-lifecycle.test.ts test/offline-entry.test.ts test/diagnosis-statistics.test.ts
```

包级 `test` 脚本由根 workspace 测试入口发现，CI 另有必跑的 LightClaw 步骤，防止再次被 `--if-present` 静默跳过。测试使用临时 HOME、移除继承的凭证变量、阻止 Node TCP/fetch 请求，模型与平台调用使用 faux/mock。统计回归调用 Python 标准库读取虚构 JSON；历史数据重算入口为 `docs/diagnosis/2026-10-21/analyze-live-v2.py`，`--check` 只读验证已生成 v2 文件，不调用模型。

## 崩溃恢复与受控执行

运行时通过内核锁保持单实例；消息和一次性事件先持久接纳，执行中断保留 unknown 并等待人工核对。受控操作使用稳定 ID 和服务结果查询；任意 bash 的外部副作用仍需人工检查。Docker 使用容器内监督器确认取消。依赖、状态、人工恢复和实测边界见[恢复说明](docs/recovery.zh-CN.md)。

## 运行 Agent 评测

下面的命令会调用你配置的模型接口，消耗相应 API 额度：

```bash
npx tsx packages/lightclaw/src/evals/cli.ts --suite=legacy \
  --sandbox=docker:lightclaw-sandbox \
  --workspace=./lightclaw-data
```

默认评测集是 `packages/lightclaw/evals/basic.json`。它不只判断模型“说得像不像”，还会检查 Agent 是否真的创建了文件、工具有没有报错，以及耗时、Token 和费用。结果保存在 `lightclaw-data/evals/report-*.json`。

## 自动优化提示词

```bash
npx --no-install tsx packages/lightclaw/src/evals/optimize-cli.ts \
  --sandbox=docker:lightclaw-sandbox \
  --workspace=./lightclaw-data \
  --dataset=packages/lightclaw/evals/basic.json \
  --holdout=packages/lightclaw/evals/holdout.json \
  --repetitions=5 \
  --candidates=2
```

流程是“训练集/留出集各跑至少 5 次基线 → 只用训练集生成候选 → 两组各重复评测 → 检查退化”。候选训练均分须严格提高，留出均分与逐用例最低得分不下降，工具错误和文件产物检查不能变差；通过才写入 `lightclaw-data/evals/optimized-prompt.txt`。两组不能共享 ID 或任务提示。默认两个候选、每组两个用例、重复 5 次共执行 60 项任务评测，另有候选生成，会消耗配置模型的实际额度。schema 4 报告保存每次结果与拒绝原因。启用它：

```bash
export LIGHTCLAW_PROMPT_INSTRUCTIONS="$(cat ./lightclaw-data/evals/optimized-prompt.txt)"
```

随包小数据集只演示流程，留出复测是回归门禁，不证明生产泛化或统计显著性。频繁选择候选也可能使留出集逐渐成为调参依据；工程验收应另外保留未用于选型的最终测试任务。评测输入统一校验文件和程序内用例，拒绝未知字段、空检查及越界路径；文件检查要求频道目录内的常规文件，取消/截断不算成功。

## 运行确定性性能基准

该基准使用 pi-mono 的 faux provider 测量 LightClaw 频道队列与 Agent Runtime，不连接真实模型、飞书或 Slack，也不消耗 API 额度：

```bash
cd packages/lightclaw
npx tsx src/benchmark/cli.ts --output=../../lightclaw-data/benchmarks
```

默认测试 1、5、10、20 个并发频道，每个级别包含预热和多轮正式测量。每次运行保留任务、轮次与资源采样 JSONL，汇总从这些原始文件重建。结果仅适用于报告记录的机器、Node.js 版本、源码状态和参数，不能表述为真实模型或消息平台性能。详见[性能基准方法](docs/performance-benchmark.zh-CN.md)。

## 使用长期目标

```text
/goal 把解析器的单元测试覆盖率提高到 90%，并给出测试结果
/goal status
/goal pause
/goal resume
/goal cancel
```

创建目标后，Agent 每轮都必须调用 `goal_progress` 保存进展。如果它认为目标完成，调用 `goal_complete` 申请验收。自然语言目标等待创建者通过 `/goal confirm <goalId> <attemptId>` 确认；JSON 目标按固定文件／Docker 命令规则检查，只有通过才自动完成。使用 `/goal status` 查看申请与确认命令。控制状态位于工作区外，可通过 `LIGHTCLAW_CONTROL_DIR` 指定；旧状态须停机运行 `lightclaw-goal-migrate` 显式迁移。详见[长期目标与完成验收](docs/goals.zh-CN.md)。

默认最多执行 8 轮；连续失败 2 轮，或连续 2 轮没有进展，目标会自动暂停。可以用以下环境变量调整：

```bash
export LIGHTCLAW_GOAL_MAX_CYCLES=8
export LIGHTCLAW_GOAL_MAX_FAILURES=2
export LIGHTCLAW_GOAL_MAX_STALE_CYCLES=2
```

单轮预算独立于目标轮次限制：

| 环境变量 | 默认值 | 含义 |
| --- | ---: | --- |
| `LIGHTCLAW_RUN_MAX_DURATION_MS` | `300000` | 模型/工具阶段时限（毫秒），计入准备耗时 |
| `LIGHTCLAW_RUN_MAX_TOOL_CALLS` | `100` | 超过数量后禁止下一个工具副作用 |
| `LIGHTCLAW_RUN_MAX_TOKENS` | `100000` | 已报告输入、输出与缓存 Token 达到限制后停止后续工作 |
| `LIGHTCLAW_BASH_TIMEOUT_SECONDS` | `120` | bash 未显式设置 timeout 时的默认秒数 |
| `LIGHTCLAW_PLATFORM_TIMEOUT_MS` | `30000` | 平台请求等待上限（毫秒） |
| `LIGHTCLAW_QUEUE_MAX_PENDING` | `5` | 单频道待执行容量，不含正在运行的一项 |
| `LIGHTCLAW_QUEUE_MAX_WAIT_MS` | `300000` | 排队等待期限（毫秒），过期不执行 |
| `LIGHTCLAW_CHANNEL_CACHE_MAX_ENTRIES` | `128` | 每个状态/平台队列缓存的频道容量 |
| `LIGHTCLAW_CHANNEL_CACHE_IDLE_TTL_MS` | `900000` | 空闲资源保留期限（毫秒），随后释放 |

模型/工具需要配合取消信号；Token 阈值在收到用量报告后生效，单次响应可超过阈值，不能当作账单硬上限。平台超时结束本地等待，投递结果可能未知；同一上下文不再发送后续消息，已经发出的请求仍可能在远端完成。活动目标暂停，检查结果后再 `/goal resume`。Slack 禁止自动请求重试，限流明确返回错误；飞书和 Slack 的 HTTP 请求也设置上述 timeout。

重启恢复可能重新执行未完成的工作，外部副作用仍需业务幂等处理。当前运行时面向单实例个人 Agent。

本地 Vitest 将 pi 工作区包解析到 TypeScript 源码，避免依赖旧 dist。源码回归不等于安装包验收；CI 配置验证最低 Node 22.19.0 和当前 Node 22，本地实际执行版本见工程记录。

## 数据放在哪里

对话、记忆、附件和产物按频道保存；工作区级 `MEMORY.md` 为共享记忆，频道划分不等于多租户安全隔离。目标控制状态另存于工作区外：

```text
lightclaw-data/
├── MEMORY.md                 # 全局长期记忆
├── settings.json             # Agent 设置
├── events/                   # 定时唤醒任务
└── <频道 ID>/
    ├── MEMORY.md             # 频道长期记忆
    ├── log.jsonl             # 可检索聊天历史
    ├── context.jsonl         # 发送给模型的上下文
    ├── attachments/
    ├── scratch/
    └── skills/
```

## 文档与开发

- [架构设计](docs/architecture.zh-CN.md)
- [长期目标与完成验收](docs/goals.zh-CN.md)
- [沙箱配置](docs/sandbox.zh-CN.md)
- [定时事件](docs/events.md)
- [历史评测记录](docs/evaluation.zh-CN.md)
- [性能基准方法](docs/performance-benchmark.zh-CN.md)

静态检查在仓库根目录执行 `npm run check`，不包含测试。定向测试从对应包目录执行，遵循[开发规则](../../AGENTS.md)。

统一评测CLI不带suite时默认无凭证数据审计。上面的legacy/optimize命令会消耗真实模型额度，必须另行授权；本批没有运行。完整提示/工具故障正文诊断需显式 `LIGHTCLAW_DEBUG_PAYLOADS=1`，否则保留计数而不捕获完整调试内容；候选分析未启用该项就没有完整基线提示记录，不应宣称据此检验自动优化收益。

权威审计位于工作区外的 `<控制目录>/.audit/`；包含 runs/tool-calls/spans 与显式启用的 payload。路径、配额、保留期和恢复命令以 [部署说明](docs/deployment.zh-CN.md) 为准。默认使用用户输入，不自动生成、评分或加载候选提示词；显式优化动作只返回推荐，不改变后续输入默认状态。

## 飞书可选提示词优化

普通文本按原文交给Agent，不自动生成候选或评分。飞书同时提供“提示词优化”交互卡片；仅原发送者可在原频道原卡片点击，有效期30分钟。点击后才进行至多2次无工具模型请求（先生成至多2条候选，再连同原文评分，每次最多1536输出Token）；按模型主观评审分数展示推荐，不是任务实测收益。不会自动替换已启动任务或下一条输入；需要时复制推荐作为新消息。输入上限12000字符，重复/过期/中断不自动重试，失败可重新发送原文。

`LIGHTCLAW_FEATURE_OPTIMIZATION=false`关闭卡片及候选优化，不影响原文输入。真实飞书应用需订阅`card.action.trigger`；本轮仅mock SDK+faux验证，无真实平台/模型调用。Slack不增加该按钮。
