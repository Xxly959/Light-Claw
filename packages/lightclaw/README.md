# LightClaw

**A self-hosted agent for Feishu and Slack that saves progress and records completion evidence.**

[中文](README.zh-CN.md) · [Repository overview](../../README.md) · [Architecture](docs/architecture.zh-CN.md) · [Long-running goals](docs/goals.zh-CN.md)

Give LightClaw a task in chat. It uses file and shell tools, keeps conversation and goal state on disk, and records progress and completion evidence across multiple execution cycles.

## Highlights

- **Durable goals:** pause, resume, cancel, and recover active goals after process restarts.
- **Completion evidence:** require a summary and evidence before marking a goal complete.
- **Loop circuit breakers:** stop at cycle, consecutive-failure, or stale-progress limits.
- **Chat integration:** Feishu and Slack share one transport interface and retain channel-specific context.
- **Tool sandbox:** optional Docker execution with CPU, memory, process, and network settings.
- **Evaluation workflow:** check responses, files, tool errors, and latency; record tokens and cost; compare prompt candidates with a baseline.

Built on pi's model, Agent, and session infrastructure. LightClaw adds chat transports and the task lifecycle in this package.

## Quick start

Requires Node.js >= 22.19.0, npm, a model account, and a Feishu or Slack application. The Node agent runs on the host; the following setup uses Docker for tools. Install from the repository root:

```bash
git clone https://github.com/Xxly959/Light-Claw.git
cd Light-Claw
npm install
mkdir -p lightclaw-data
bash packages/lightclaw/docker.sh create ./lightclaw-data
```

Configure a model. The provider and model must exist in pi's model registry:

```bash
export LIGHTCLAW_MODEL_PROVIDER=zai
export LIGHTCLAW_MODEL_ID=glm-5.3-flash
export OPENAI_API_KEY=your-key
# Optional gateway endpoint
# export OPENAI_BASE_URL=https://your-openai-compatible-gateway.example/v1
```

For Feishu, enable the bot, subscribe to `im.message.receive_v1` over a long connection, and grant message read/send permissions:

```bash
export LIGHTCLAW_TRANSPORT=feishu
export LIGHTCLAW_FEISHU_APP_ID=cli_xxx
export LIGHTCLAW_FEISHU_APP_SECRET=xxx
npx tsx packages/lightclaw/src/main.ts --sandbox=docker:lightclaw-sandbox ./lightclaw-data
```

For Slack, enable Socket Mode and configure events and scopes using the [setup guide](docs/slack-bot-minimal-guide.md):

```bash
export LIGHTCLAW_TRANSPORT=slack
export LIGHTCLAW_SLACK_APP_TOKEN=xapp-xxx
export LIGHTCLAW_SLACK_BOT_TOKEN=xoxb-xxx
npx tsx packages/lightclaw/src/main.ts --sandbox=docker:lightclaw-sandbox ./lightclaw-data
```

Credentials come from environment variables or pi's auth store; the entrypoint does not load `.env` automatically. Omitting `--sandbox` runs tools on the host. Docker uses `bridge` networking by default; set `LIGHTCLAW_SANDBOX_NETWORK=none` before creating the container for offline tool execution. See [sandbox configuration](docs/sandbox.zh-CN.md).

## Evaluation and prompt optimization

The included evaluation set runs the real Agent loop and checks responses, files, tool errors, latency, tokens, and cost. It calls the configured model and therefore consumes API quota:

```bash
npx tsx packages/lightclaw/src/evals/cli.ts \
  --sandbox=docker:lightclaw-sandbox \
  --workspace=./lightclaw-data
```

Prompt optimization generates candidates, evaluates every candidate on the same dataset, and writes a prompt only when it beats the baseline:

```bash
npx tsx packages/lightclaw/src/evals/optimize-cli.ts \
  --sandbox=docker:lightclaw-sandbox \
  --workspace=./lightclaw-data \
  --candidates=2
```

To use the promoted instructions, load the generated text before starting LightClaw:

```bash
export LIGHTCLAW_PROMPT_INSTRUCTIONS="$(cat ./lightclaw-data/evals/optimized-prompt.txt)"
```

The bundled two-case set is a smoke check. Same-dataset prompt selection does not establish generalization or production reliability. Add project-specific cases by copying `evals/basic.json`. Evaluation directories and reports live under `lightclaw-data/` and are excluded from Git.

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

Completion evidence is submitted by the executing Agent; it is not independent verification. Restart recovery may repeat unfinished work, so external side effects require application-level idempotency.

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
- [Evaluation record](docs/evaluation.zh-CN.md)
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
