# LightClaw

[English](packages/lightclaw/README.md) | 中文

LightClaw 是一个能持续推进目标、保存进度并提供完成证据的轻量个人 Agent。它通过飞书或 Slack 接收任务，使用 OpenAI 兼容模型规划和调用工具，并在 Docker 沙箱内安全执行命令。

本项目基于 [pi-mono](https://github.com/badlogic/pi-mono) 的轻量 Agent 运行时开发，不依赖 LangChain、Dify 等重型编排框架。

```text
飞书 / Slack
      ↓
消息平台适配层
      ↓
Agent Loop + 上下文记忆
      ↓
基础工具 + 长期目标状态机
      ↓
Docker 沙箱 + JSONL 审计
```

## 核心能力

- 飞书与 Slack 共用一套 `ChatTransport` 协议
- 兼容 OpenAI Chat Completions 的模型网关
- `read`、`write`、`edit`、`bash` 等基础工具
- `/goal` 长期目标创建、查询、暂停、恢复和取消
- 目标状态持久化，进程重启后能够继续
- 最大轮次、连续失败和停滞熔断
- 完成前必须保存进展和可核验证据
- 记录延迟、Token、费用和工具调用指标
- Docker 隔离执行环境

## 已验证链路

```text
飞书消息
  → LightClaw
  → OpenAI 兼容 GLM-5.3-Flash
  → Docker 中创建 Python 项目
  → unittest 4 项通过
  → goal_complete 保存证据
  → 飞书返回结果
```

## 快速开始

```bash
npm install
mkdir -p lightclaw-data
bash packages/lightclaw/docker.sh create ./lightclaw-data
```

配置环境变量：

```bash
export LIGHTCLAW_TRANSPORT=feishu
export LIGHTCLAW_FEISHU_APP_ID=cli_xxx
export LIGHTCLAW_FEISHU_APP_SECRET=xxx
export LIGHTCLAW_MODEL_PROVIDER=zai
export LIGHTCLAW_MODEL_ID=glm-5.3-flash
export OPENAI_API_KEY=你的密钥
export OPENAI_BASE_URL=https://你的网关地址/v1
```

启动：

```bash
npx tsx packages/lightclaw/src/main.ts \
  --sandbox=docker:lightclaw-sandbox \
  ./lightclaw-data
```

在飞书中创建长期目标：

```text
/goal 在 scratch 目录创建一个 Python 项目，运行测试并提供完成证据
/goal status
```

任何凭证都必须通过环境变量传入，禁止写进代码或提交到仓库。

## 文档

- [中文教程](packages/lightclaw/README.zh-CN.md)
- [English guide](packages/lightclaw/README.md)
- [架构设计](packages/lightclaw/docs/architecture.zh-CN.md)
- [长期目标状态机](packages/lightclaw/docs/goals.zh-CN.md)

## 验证

```bash
npm run check
cd packages/lightclaw
npx tsx ../../node_modules/vitest/dist/cli.js --run \
  test/config.test.ts \
  test/goals.test.ts \
  test/observability.test.ts \
  test/feishu.test.ts \
  test/events.test.ts \
  test/presentation.test.ts
```

单元测试不会调用真实模型或消耗 API 额度。

## 项目来源

LightClaw 保留 pi-mono 的 MIT 许可证和上游历史。本仓库的新增工作集中在 `packages/lightclaw`，包括飞书适配、可配置模型网关、长期目标状态机、崩溃恢复、运行审计和中文教程。
