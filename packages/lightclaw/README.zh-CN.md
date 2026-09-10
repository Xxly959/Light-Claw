# LightClaw：能长期干活的轻量个人 Agent

[English](README.md) | 中文文档

LightClaw 基于 pi 的 `pi-ai`、`pi-agent-core` 和 `pi-coding-agent` 构建。它不是套一层 LangChain，也不是把所有能力都塞进提示词，而是保留一条清晰的主线：

```text
消息平台 → Agent Loop → 基础工具 → 持久化状态 → 可验证结果
```

恭喜你，能看懂这条链路，你就已经抓住 Agent 工程最重要的部分了！

## 它解决什么问题

普通聊天机器人收到一句话，只执行一轮。长期任务却可能需要多轮尝试，还会遇到模型提前停止、工具失败、进程重启和上下文压缩。

LightClaw 在轻量框架上增加了四个工程能力：

1. 飞书和 Slack 使用同一套消息平台协议。
2. 模型、网关和运行限制全部通过环境变量配置。
3. 长期目标保存到磁盘，重启后能够继续执行。
4. 每轮记录延迟、Token、费用和工具结果数量，完成时必须提供证据。

## 五分钟启动

在仓库根目录安装依赖：

```bash
npm install
```

配置 OpenAI 兼容模型：

```bash
export LIGHTCLAW_MODEL_PROVIDER=zai
export LIGHTCLAW_MODEL_ID=glm-5.3-flash
export OPENAI_API_KEY=你的密钥
export OPENAI_BASE_URL=https://你的网关地址/v1
```

`LIGHTCLAW_MODEL_PROVIDER` 和 `LIGHTCLAW_MODEL_ID` 必须能在 pi 的模型注册表中找到。也可以改用 `deepseek`、`moonshotai-cn` 等已有 provider。

### 飞书模式

```bash
export LIGHTCLAW_TRANSPORT=feishu
export LIGHTCLAW_FEISHU_APP_ID=cli_xxx
export LIGHTCLAW_FEISHU_APP_SECRET=xxx
npx tsx packages/lightclaw/src/main.ts --sandbox=docker:lightclaw-sandbox ./lightclaw-data
```

飞书应用需要接收 `im.message.receive_v1`，并允许机器人读取和发送消息。群聊中需要 @ 机器人，私聊可以直接发送。

### Slack 模式

```bash
export LIGHTCLAW_TRANSPORT=slack
export LIGHTCLAW_SLACK_APP_TOKEN=xapp-xxx
export LIGHTCLAW_SLACK_BOT_TOKEN=xoxb-xxx
npx tsx packages/lightclaw/src/main.ts --sandbox=docker:lightclaw-sandbox ./lightclaw-data
```

任何 API Key 都不要写进源码、README 或提交记录。

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

## 数据放在哪里

每个频道独立保存上下文和目标，避免不同用户之间串数据：

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

## 推荐学习顺序

如果你现在几乎看不懂代码，按下面顺序学，不要一上来啃完整入口：

1. `src/config.ts`：学习环境变量、类型和输入校验。
2. `src/transport.ts`：学习接口和适配器模式。
3. `src/goals/store.ts`：学习状态机、JSON 持久化和原子写入。
4. `src/tools/goal.ts`：理解 Tool 本质上就是带参数描述的函数。
5. `src/agent.ts`：理解模型、上下文、工具和 Agent Loop 怎样组合。
6. `src/main.ts`：最后理解消息队列、长期循环、停止和崩溃恢复。

每看完一个文件，先回答三个问题：输入是什么、状态保存在哪里、失败后怎样停止。能回答出来，再看下一个文件。

更完整的设计说明见[架构文档](docs/architecture.zh-CN.md)和[长期目标文档](docs/goals.zh-CN.md)。
