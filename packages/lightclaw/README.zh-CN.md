# LightClaw 使用指南

[English](README.md) · [项目首页](../../README.md) · [架构](docs/architecture.zh-CN.md) · [长期目标](docs/goals.zh-CN.md)

LightClaw 将飞书和 Slack 接入同一套 Agent 运行时，支持多轮任务、进度持久化、完成证据、Docker 工具执行、运行审计和任务评测。

## 安装与启动

需要 Node.js >=22.19.0、npm、模型凭证和飞书或 Slack 应用。Node Agent 在宿主机运行，以下使用 Docker 执行工具。在仓库根目录安装依赖：

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
# 使用自定义 OpenAI 兼容网关时设置
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

## 运行 Agent 评测

下面的命令会调用配置的模型接口，消耗相应 API 额度：

```bash
npx tsx packages/lightclaw/src/evals/cli.ts \
  --sandbox=docker:lightclaw-sandbox \
  --workspace=./lightclaw-data
```

默认评测集是 `packages/lightclaw/evals/basic.json`。它不只判断模型“说得像不像”，还会检查 Agent 是否真的创建了文件、工具有没有报错，以及耗时、Token 和费用。结果保存在 `lightclaw-data/evals/report-*.json`。

## 自动优化提示词

```bash
npx tsx packages/lightclaw/src/evals/optimize-cli.ts \
  --sandbox=docker:lightclaw-sandbox \
  --workspace=./lightclaw-data \
  --candidates=2
```

流程是“跑基线 → 生成候选 → 同集复测 → 比较指标”。候选没有超过基线时，不会覆盖原提示词；超过后才会写入 `lightclaw-data/evals/optimized-prompt.txt`。启用它：

```bash
export LIGHTCLAW_PROMPT_INSTRUCTIONS="$(cat ./lightclaw-data/evals/optimized-prompt.txt)"
```

随包两例数据集用于冒烟检查。同集候选选优不代表独立测试集泛化或生产可靠性；重要任务应增加独立用例并重复评测。

## 使用长期目标

```text
/goal 把解析器的单元测试覆盖率提高到 90%，并给出测试结果
/goal status
/goal pause
/goal resume
/goal cancel
```

创建目标后，Agent 每轮都必须调用 `goal_progress` 保存进展。如果它认为目标完成，还必须调用 `goal_complete` 并给出至少一条证据。只说“已经完成”不算完成。

默认最多执行 8 轮；连续失败 2 轮，或连续 2 轮没有进展，目标会自动暂停。可以用以下环境变量调整：

```bash
export LIGHTCLAW_GOAL_MAX_CYCLES=8
export LIGHTCLAW_GOAL_MAX_FAILURES=2
export LIGHTCLAW_GOAL_MAX_STALE_CYCLES=2
```

完成证据由执行 Agent 提交，不是独立验收器的核验结果。重启恢复可能重复执行未完成工作，外部副作用需要业务幂等处理。

## 数据放在哪里

对话、目标和产物按频道保存；工作区级 `MEMORY.md` 为共享记忆，频道划分不等于多租户安全隔离：

```text
lightclaw-data/
├── MEMORY.md                 # 全局长期记忆
├── settings.json             # Agent 设置
├── events/                   # 定时唤醒任务
├── audit/runs.jsonl          # 脱敏运行指标
└── <频道 ID>/
    ├── MEMORY.md             # 频道长期记忆
    ├── log.jsonl             # 可检索聊天历史
    ├── context.jsonl         # 发送给模型的上下文
    ├── goal.json             # 当前长期目标
    ├── attachments/
    ├── scratch/
    └── skills/
```

## 文档与开发

- [架构设计](docs/architecture.zh-CN.md)
- [长期目标](docs/goals.zh-CN.md)
- [沙箱配置](docs/sandbox.zh-CN.md)
- [定时事件](docs/events.md)
- [历史评测记录](docs/evaluation.zh-CN.md)

静态检查在仓库根目录执行 `npm run check`，不包含测试。定向测试从对应包目录执行，遵循[开发规则](../../AGENTS.md)。
