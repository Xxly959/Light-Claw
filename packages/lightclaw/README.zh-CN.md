# LightClaw 使用指南

状态：2026-11-06功能收敛为个人Agent，采用源码启动；工程回归保留，独立评测与基准已退役。见[最终范围](docs/project-scope.zh-CN.md)、[部署](docs/deployment.zh-CN.md)和[学习路线](docs/learning-path.zh-CN.md)。

[English](README.md) · [项目首页](../../README.md) · [架构](docs/architecture.zh-CN.md) · [目标验收](docs/goals.zh-CN.md)

LightClaw 将飞书和 Slack 消息接入同一套 Agent 运行时，支持多轮任务、进度持久化、文件与命令验收、Docker 工具执行，以及运行审计和故障恢复。

项目首页介绍使用场景与核心能力；本指南说明启动、模型配置、目标控制和日常操作。

## 推荐的源码启动方式

已有.env不要覆盖。首次配置：

```bash
cp packages/lightclaw/config.env.example .env
# 本地编辑.env，填写平台凭证与模型配置
bash scripts/start-lightclaw.sh
```

启动器会载入.env并从仓库根运行；main.ts直接入口仍只读进程环境。模板默认host模式，按当前OS用户权限执行工具；如需Docker，先创建容器再修改LIGHTCLAW_SANDBOX。自定义网关使用LIGHTCLAW_MODELS_FILE，与完整步骤见[部署](docs/deployment.zh-CN.md)。项目不再包含Agent效果评测、性能基准或离线候选晋升功能。

## 安装与启动

在仓库根目录安装依赖：

LightClaw 要求 Node.js >=22.19.0、npm、Linux/macOS 和宿主 Python 3.9+；附件安全读写与运行锁需要宿主 POSIX/Python 支持。以下方案还需要已安装并运行的 Docker。Node Agent 在宿主机运行，Docker 镜像提供工具执行环境。

```bash
git clone https://github.com/Xxly959/Light-Claw.git
cd Light-Claw
npm install
mkdir -p lightclaw-data
bash packages/lightclaw/docker.sh create ./lightclaw-data
```

以下模型示例与 `.env` 模板一致，目录中存在该 ID 不代表供应商实时可用性已经验收：

```bash
export LIGHTCLAW_MODEL_PROVIDER=deepseek
export LIGHTCLAW_MODEL_ID=deepseek-v4-flash
export DEEPSEEK_API_KEY=你的密钥
# 使用自定义 OpenAI 兼容网关时按需设置 OPENAI_API_KEY 和地址：
# export OPENAI_BASE_URL=https://your-gateway.example/v1
```

`LIGHTCLAW_MODEL_PROVIDER` 和 `LIGHTCLAW_MODEL_ID` 必须能在 pi 的模型注册表中找到。自定义模型可通过 `LIGHTCLAW_MODELS_FILE` 注册；也可以改用 `zai`、`moonshotai-cn` 等已有 provider，并设置对应凭证。

### 飞书模式

```bash
export LIGHTCLAW_TRANSPORT=feishu
export LIGHTCLAW_FEISHU_APP_ID=cli_xxx
export LIGHTCLAW_FEISHU_APP_SECRET=xxx
npx tsx packages/lightclaw/src/main.ts --sandbox=docker:lightclaw-sandbox ./lightclaw-data
```

飞书应用需启用机器人能力，通过长连接订阅 `im.message.receive_v1`，并允许机器人读取和发送消息。提示词表单与预览还需订阅 `card.action.trigger`，客户端须支持卡片 JSON 2.0。群聊中需要 @ 机器人，私聊可以直接发送。

### Slack 模式

开启 Socket Mode，并按 [Slack 接入指南](docs/slack-bot-minimal-guide.md) 配置事件与权限。

```bash
export LIGHTCLAW_TRANSPORT=slack
export LIGHTCLAW_SLACK_APP_TOKEN=xapp-xxx
export LIGHTCLAW_SLACK_BOT_TOKEN=xoxb-xxx
npx tsx packages/lightclaw/src/main.ts --sandbox=docker:lightclaw-sandbox ./lightclaw-data
```

凭证通过环境变量或 pi 认证存储读取，启动入口不会自动加载 `.env`。省略 `--sandbox` 时工具在宿主机执行；Docker 工具容器默认使用 `none` 网络；需要联网时，创建容器前显式设置 `LIGHTCLAW_SANDBOX_NETWORK=bridge`。容器断网不影响宿主 Agent 的平台连接与模型请求。详见[沙箱配置](docs/sandbox.zh-CN.md)。

## 附件权限与离线回归

宿主附件读取需要 POSIX（Linux/macOS）和宿主 `python3`（Python 3.9+）；Docker 内的 Python 不能代替宿主依赖。缺少依赖时上传明确失败。仅可上传当前频道目录内的普通文件，单文件不超过 20 MiB；拒绝目录穿越、跨频道/共享文件、符号链接和多硬链接。`attach` 支持频道相对路径，例如 `scratch/report.pdf`，以及当前频道的 host/Docker 绝对路径；平台 `uploadFile` 只接受频道相对路径。

读取器逐级以目录文件描述符和 `O_NOFOLLOW` 打开，从同一文件描述符限量读取并检查变化，SDK 仅接收内存字节。宿主工作区根路径、祖先目录、Python 解释器和应用安装必须可信；这是附件读取权限边界，不是对 host 模式任意 shell 命令的隔离。Windows 不支持该安全读取器。

在 `packages/lightclaw` 目录运行已授权的具体回归：

```bash
rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run test/attachment-upload.test.ts test/runner-lifecycle.test.ts test/offline-entry.test.ts test/runtime-goal-loop.test.ts
```

包级 `test` 脚本由根 workspace 测试入口发现，CI 另有必跑的 LightClaw 步骤，防止再次被 `--if-present` 静默跳过。测试使用临时 HOME、移除继承的凭证变量、阻止 Node TCP/fetch 请求，模型与平台调用使用 faux/mock。

## 崩溃恢复与受控执行

运行时通过内核锁保持单实例；消息和一次性事件先持久接纳，执行中断保留 unknown 并等待人工核对。受控操作使用稳定 ID 和服务结果查询；任意 bash 的外部副作用仍需人工检查。Docker 使用容器内监督器确认取消。依赖、状态、人工恢复和实测边界见[恢复说明](docs/recovery.zh-CN.md)。

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

静态检查在仓库根目录执行 `npm run check`，不包含测试。定向测试从对应包目录执行，遵循[开发规则](../../AGENTS.md)。


权威审计位于工作区外的 `<控制目录>/.audit/`；包含 runs/tool-calls/spans 与显式启用的 payload。路径、配额、保留期和恢复命令以 [部署说明](docs/deployment.zh-CN.md) 为准。默认使用用户输入，不自动生成、评分或加载候选提示词；显式优化动作先预览，确认后才执行最终文本，不改变后续输入默认状态。

## 飞书可选提示词优化

普通文本直接交给Agent，不自动优化。在群里发送 `@机器人 任务入口` 或 `@机器人 /prompt-entry`，点击卡片的“输入任务”；也可用 `/prompt`（可附带预填原文）打开表单。任务入口可手动置顶，绑定原群原消息，跨重启保留。

1. 在表单输入原文（最多1000个UTF-16单元）。点击“原文发送”会直接执行；点击“优化并预览”只生成候选并进行一次独立约束复核，不启动Agent任务。
2. 原卡片更新为“优化结果预览（尚未执行）”，卡片单独显示任务类型、改动说明、假设与待确认信息；输入框预填候选提示词，可直接修改。说明不会随任务发送，需要的补充信息请写入编辑框。超过1000单元的结果分段编辑（总上限12000单元），确认时按顺序无损拼接，不额外插入换行。单个编辑框最多1000单元，短结果可在当前框上限内扩写。
3. 检查并修改后，点击“确认发送”。Agent仅收到最终提交文本，确认不会再次改写。未确认就不执行；新任务或更换发送方式请重新打开表单。

对于“调研、整理、比较”等开放任务，改写会要求补充与原任务相关的执行指引和输出结构，例如调研分类、机制、对比与可核验来源；不虚构用户项目背景或授权。如果模型仍返回原文或仅改标点/空白，预览会明确提示，不能把这类变化当作已验证的实质优化。

改写使用独立、无工具的临时模型上下文，包含专用系统提示词、本次原文和宿主提供的目标工具能力描述（JSON数据，`context: null`；默认不声称具备网页搜索能力），不读取主会话历史。原文、改写系统提示词、修改说明、假设、待确认信息及复核反馈及预览交互不会自动写入主Agent的 `context.jsonl`。只有最终确认文本作为一个用户轮次加入已有会话。`/prompt`及预填内容也不会被日志同步重新导入。普通聊天仍属于聊天历史，因此应在卡片里输入草稿，不要先作为普通消息发送原文。既有会话和历史压缩摘要不会追溯清理。

这是会话上下文隔离，不是零留存：控制目录中的草稿和inbox记录仍用于审计、去重与恢复，源聊天日志也保留；表单和预览对群成员可见。候选生成最多2048输出Token，独立约束复核最多1024输出Token。JSON格式、字面材料与数字保持检查不代替语义验证；模型复核也可能漏判，不能据此宣称普遍质量提升。复核失败不会发布候选或执行任务。

原发送者须在原群原卡片确认，有效期沿用首次表单的30分钟。确认时重新检查频道忙碌状态和活跃长期目标。预览可跨重启确认，但重复确认最多执行一次；过期、中断、改写失败、超时、取消或预览投递失败/不确定均不会自动执行或退回原文。确认文本中的 `/approve`、`/recover`、`/goal`按任务数据处理，不升级为控制命令。

`LIGHTCLAW_FEATURE_OPTIMIZATION=false`关闭表单优化入口，不影响普通原文输入。真实飞书应用需订阅 `card.action.trigger` 并支持卡片JSON 2.0。流程经实际adapter+mock SDK+faux验证；2026-11-06 另已完成独立安装产物真实模型/私聊附件验收，以及用户在真实客户端优化预览、编辑和确认，主会话记录核对了隔离边界。见[最终验收报告](../../docs/reports/FINAL-ACCEPTANCE-2026-11-06.zh-CN.md)。已有进程须重启才加载后续源码改动。Slack不增加该入口。
