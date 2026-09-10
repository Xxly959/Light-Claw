# LightClaw

[中文文档](README.zh-CN.md) | English

LightClaw is a durable personal agent built on pi. It connects Feishu or Slack to the same small agent runtime, supports configurable model providers, survives process restarts, and records privacy-conscious execution metrics.

It intentionally keeps pi's lightweight design: one agent loop, a small set of filesystem and shell tools, JSON/JSONL persistence, and no orchestration framework.

## Features

- Feishu and Slack transport adapters behind one `ChatTransport` interface
- OpenAI-compatible model gateways configured with environment variables
- Persistent conversation context and workspace/channel memory
- Durable long-running goals with pause, resume, cancel, and crash recovery
- Safety limits for total cycles, consecutive failures, and stalled cycles
- Completion evidence required before a goal can be marked complete
- JSONL run audit with latency, token, cost, and tool-call metrics
- Docker sandbox support
- Scheduled and periodic events

## Quick start

Install dependencies from the repository root:

```bash
npm install
```

Configure a model. The provider and model must exist in pi's model registry:

```bash
export LIGHTCLAW_MODEL_PROVIDER=zai
export LIGHTCLAW_MODEL_ID=glm-5.3-flash
export OPENAI_API_KEY=your-key
export OPENAI_BASE_URL=https://your-openai-compatible-gateway.example/v1
```

For Feishu:

```bash
export LIGHTCLAW_TRANSPORT=feishu
export LIGHTCLAW_FEISHU_APP_ID=cli_xxx
export LIGHTCLAW_FEISHU_APP_SECRET=xxx
npx tsx packages/lightclaw/src/main.ts --sandbox=docker:lightclaw-sandbox ./lightclaw-data
```

For Slack:

```bash
export LIGHTCLAW_TRANSPORT=slack
export LIGHTCLAW_SLACK_APP_TOKEN=xapp-xxx
export LIGHTCLAW_SLACK_BOT_TOKEN=xoxb-xxx
npx tsx packages/lightclaw/src/main.ts --sandbox=docker:lightclaw-sandbox ./lightclaw-data
```

Do not hardcode credentials. `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and chat-platform credentials are read only from the environment or pi's auth store.

## Long-running goals

Send these commands in a direct message or mention:

```text
/goal bring unit-test coverage of the parser to 90%
/goal status
/goal pause
/goal resume
/goal cancel
```

An active goal is stored in `<workspace>/<channel>/goal.json`. LightClaw asks the model to report progress every cycle and to provide evidence before completion. Active goals are re-enqueued after a process restart.

The default circuit breakers are:

| Variable | Default | Meaning |
|---|---:|---|
| `LIGHTCLAW_GOAL_MAX_CYCLES` | `8` | Maximum cycles for one goal |
| `LIGHTCLAW_GOAL_MAX_FAILURES` | `2` | Consecutive failed cycles before pausing |
| `LIGHTCLAW_GOAL_MAX_STALE_CYCLES` | `2` | Cycles without a progress update before pausing |

## Workspace data

```text
lightclaw-data/
├── MEMORY.md
├── settings.json
├── events/
├── audit/runs.jsonl
└── <channel-id>/
    ├── MEMORY.md
    ├── log.jsonl
    ├── context.jsonl
    ├── goal.json
    ├── attachments/
    ├── scratch/
    └── skills/
```

The audit log contains operational metadata only. It does not intentionally store prompts, tool arguments, API keys, or response bodies.

## Documentation

- [Chinese guide](README.zh-CN.md)
- [Architecture](docs/architecture.zh-CN.md)
- [Long-running goals](docs/goals.zh-CN.md)
- [Events](docs/events.md)
- [Sandbox](docs/sandbox.md)
- [Slack setup](docs/slack-bot-minimal-guide.md)

## Development

```bash
npm run check
cd packages/lightclaw
npx tsx ../../node_modules/vitest/dist/cli.js --run test/config.test.ts test/goals.test.ts test/observability.test.ts test/feishu.test.ts test/events.test.ts test/presentation.test.ts
```

Unit tests do not call external APIs. A real Feishu or Slack smoke test requires platform credentials and should be performed in a disposable workspace.
