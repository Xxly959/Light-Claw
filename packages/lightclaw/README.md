# LightClaw

部署状态：2026-11-05已完成真实Docker定向验收、五包隔离构建与macOS/Node22.23.0独立离线安装；真实飞书/Slack和真实模型仍待专用环境授权。详见[部署](docs/deployment.zh-CN.md)、[故障排查](docs/troubleshooting.zh-CN.md)、[资源策略](docs/resources.zh-CN.md)和[公开验收证据](../../docs/verification/2026-11-05/README.zh-CN.md)。单实例、同一信任域，不提供租户隔离。

**A self-hosted agent for Feishu and Slack that saves progress and verifies task completion.**

[中文](README.zh-CN.md) · [Repository overview](../../README.md) · [Architecture](docs/architecture.zh-CN.md) · [Goal acceptance](docs/goals.zh-CN.md)

Give LightClaw a task in chat. It uses file and shell tools, keeps conversation and goal state on disk, and checks completion against fixed file/command rules or the goal owner's confirmation.

## Highlights

- **Durable goals:** pause, resume, cancel, and recover active goals after process restarts.
- **Verified completion:** a model's completion claim starts acceptance; it does not by itself complete a goal.
- **Bounded execution:** per-run deadlines, tool and reported-token limits, plus failure and stale-progress circuit breakers.
- **Channel scheduling:** bounded queues, queue expiry, and idle state disposal.
- **Tool sandbox:** optional Docker execution with CPU, memory, process, and network settings.
- **Evaluation workflow:** artifact checks, JSONL audit metrics, repeated train/holdout evaluation, and guarded prompt promotion.

Built on pi's model, Agent, and session infrastructure. LightClaw adds chat transports and the task lifecycle in this package.

## Quick start

Install dependencies from the repository root:

LightClaw requires Node.js 22.19.0 or newer, matching its undici dependency. The Docker sandbox contains tools; the Node agent runs on the host.

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
# Optional: override the provider endpoint for an OpenAI-compatible gateway
# export OPENAI_BASE_URL=https://your-openai-compatible-gateway.example/v1
```

For Feishu, enable the bot, subscribe to `im.message.receive_v1` through a long connection, and grant message read/send permissions. Send a direct message or mention the bot in a group:

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
npx tsx packages/lightclaw/src/evals/cli.ts --suite=legacy \
  --sandbox=docker:lightclaw-sandbox \
  --workspace=./lightclaw-data
```

Prompt optimization generates candidates from the training dataset only. It evaluates the baseline and each candidate on training and independent holdout cases at least five times, then writes a prompt only when training improves and holdout, individual cases, tool errors, and artifact checks do not regress:

```bash
npx --no-install tsx packages/lightclaw/src/evals/optimize-cli.ts \
  --sandbox=docker:lightclaw-sandbox \
  --workspace=./lightclaw-data \
  --dataset=packages/lightclaw/evals/basic.json \
  --holdout=packages/lightclaw/evals/holdout.json \
  --repetitions=5 \
  --candidates=2
```

To use the promoted instructions, load the generated text before starting LightClaw:

```bash
export LIGHTCLAW_PROMPT_INSTRUCTIONS="$(cat ./lightclaw-data/evals/optimized-prompt.txt)"
```

Add project-specific cases by copying `evals/basic.json`. Evaluation directories and reports live under `lightclaw-data/` and are excluded from Git.

Training and holdout cases must have distinct IDs and task prompts. The small bundled sets demonstrate the workflow; repeated validation is a regression gate, not proof of production generalization or statistical significance. Default optimization now runs 60 task evaluations for two candidates and two cases in each dataset, plus candidate generation, and consumes the configured model quota. Schema 4 optimization reports retain every repetition and rejection reason. Dataset validation also applies to programmatic evaluation: unknown fields, empty checks, and escaping paths are rejected; artifact checks require regular files within the channel directory.

## Deterministic performance benchmark

The benchmark exercises the LightClaw channel queue and Agent Runtime with pi-mono's faux provider. It does not call a real model or chat platform and does not consume API quota:

```bash
cd packages/lightclaw
npx tsx src/benchmark/cli.ts --output=../../lightclaw-data/benchmarks
```

The defaults run 1, 5, 10, and 20 concurrent channels with warmup and repeated measurement rounds. Each run preserves task-, round-, and resource-level JSONL records; its summary is rebuilt from those raw files. Results describe only the recorded machine, Node.js version, source state, and parameters, not real-model or Slack/Feishu performance. See [benchmark methodology](docs/performance-benchmark.zh-CN.md).

## Long-running goals

Send these commands in a direct message or mention:

```text
/goal bring unit-test coverage of the parser to 90%
/goal status
/goal pause
/goal resume
/goal cancel
```

Natural-language goals use manual acceptance. `goal_complete` submits a claim; the creating platform user confirms the current attempt with `/goal confirm <goalId> <attemptId>` from `/goal status`. Pending confirmation stops continuation and cannot be overwritten by a new goal.

For automatic file acceptance:

```text
/goal create {"objective":"write a report","acceptance":{"files":[{"path":"scratch/report.md","contains":["Conclusion"],"changed":true}]}}
```

Contracts are fixed at creation. File changes compare actual SHA-256 against the creation baseline. Docker-only `commands` require `command`, `sourcePaths`, and optional `stdoutIncludes`; they run again under `/workspace/<channel>` with the run's shared tool quota, deadline, and cancellation signal. Use repeatable test commands. Maximums: 16 files, 4 commands, 16 source paths per command, 4096 command characters; file hashing 10 MiB and content matching 1 MiB. Symlinks and nonregular files are rejected. Snapshot identity and content are checked again before committing.

Schema 2 state lives outside the workspace at `~/.pi/lightclaw/control/<SHA-256 of canonical workspace>/<channel>/goal.json`. `LIGHTCLAW_CONTROL_DIR` overrides the control root. Docker mounts overlapping any protected state prevent startup. The current workspace must map exactly to `/workspace`, without nested mounts shadowing channels or sources. Host mode with the same UID remains outside the adversarial isolation guarantee. Bot and migration share `instance.lock`; verify all instances are stopped before manually removing a stale lock. Only active protected goals recover; awaiting confirmation does not.

Stop the bot before explicitly migrating old workspace `goal.json` files:

```bash
lightclaw-goal-migrate --workspace /absolute/workspace --channel CHANNEL --owner PLATFORM_USER_ID
```

Add `--control-dir` when using a custom root. Migration preserves the old file and refuses overwrite. Active/paused goals retain counters and become manual contracts; completed/cancelled legacy states are only archived, never promoted to verified completion. See [acceptance details](docs/goals.zh-CN.md).

The default circuit breakers are:

| Variable | Default | Meaning |
|---|---:|---|
| `LIGHTCLAW_GOAL_MAX_CYCLES` | `8` | Maximum cycles for one goal |
| `LIGHTCLAW_GOAL_MAX_FAILURES` | `2` | Consecutive failed cycles before pausing |
| `LIGHTCLAW_GOAL_MAX_STALE_CYCLES` | `2` | Cycles without a progress update before pausing |

Per-run limits are independent of the goal cycle limits:

| Variable | Default | Meaning |
|---|---:|---|
| `LIGHTCLAW_RUN_MAX_DURATION_MS` | `300000` | Model/tool phase deadline in milliseconds, including preparation time |
| `LIGHTCLAW_RUN_MAX_TOOL_CALLS` | `100` | Tools permitted before blocking the next side effect |
| `LIGHTCLAW_RUN_MAX_TOKENS` | `100000` | Reported input/output/cache tokens before stopping further work |
| `LIGHTCLAW_BASH_TIMEOUT_SECONDS` | `120` | Shell timeout when the tool omits one |
| `LIGHTCLAW_PLATFORM_TIMEOUT_MS` | `30000` | Platform request wait limit |
| `LIGHTCLAW_QUEUE_MAX_PENDING` | `5` | Pending tasks per channel, excluding the running task |
| `LIGHTCLAW_QUEUE_MAX_WAIT_MS` | `300000` | Maximum pending wait before expiry |
| `LIGHTCLAW_CHANNEL_CACHE_MAX_ENTRIES` | `128` | Retained channel states and transport queues per cache |
| `LIGHTCLAW_CHANNEL_CACHE_IDLE_TTL_MS` | `900000` | Idle cache retention before disposal |

Model/tool cancellation is cooperative. Reported-token limits can overshoot within one response and do not impose a billing cap. A platform timeout releases the local wait, marks delivery as uncertain, and prevents later sends from that context; an already issued request can still finish remotely. Active goals pause for inspection before `/goal resume`. Slack automatic request retries are disabled and rate limits surface as errors. Feishu and Slack HTTP requests also receive the configured timeout.

## Workspace data

```text
lightclaw-data/
├── MEMORY.md
├── settings.json
├── events/
└── <channel-id>/
    ├── MEMORY.md
    ├── log.jsonl
    ├── context.jsonl
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
- [Performance benchmark methodology](docs/performance-benchmark.zh-CN.md)
- [Events](docs/events.md)
- [Sandbox](docs/sandbox.md)
- [Slack setup](docs/slack-bot-minimal-guide.md)

## Development

LightClaw's Vitest configuration resolves pi workspace packages to their TypeScript sources, so local regressions exercise current code. Source tests do not validate a published `dist` package. CI is configured for Node 22.19.0 and Node 22; the local verification record identifies the version actually run. Restart recovery can repeat unfinished work; external side effects still require application-level idempotency. This runtime is intended for a single personal-agent instance.

```bash
npm run check
cd packages/lightclaw
npx tsx ../../node_modules/vitest/dist/cli.js --run test/config.test.ts test/goals.test.ts test/observability.test.ts test/feishu.test.ts test/events.test.ts test/presentation.test.ts
```

Unit tests do not call external APIs. A real Feishu or Slack smoke test requires platform credentials and should be performed in a disposable workspace.

## Attachment boundary and offline regressions

Attachment uploads require **host Python 3.9+ on POSIX (Linux/macOS)**, including when tools run in Docker. Missing dependencies fail closed. Only regular files in the current channel directory are authorized, up to 20 MiB each; traversal, other channels, shared files, symlinks and multiple hard links are rejected. The attach tool accepts channel-relative paths or the current channel's host/container absolute prefix; transport `uploadFile` accepts channel-relative paths only. A Python standard-library reader pins each directory with `dir_fd` and `O_NOFOLLOW`, reads the same file descriptor with a size limit and change checks, and supplies bytes to the SDK. The configured root, its ancestors, interpreter and installation must be trusted. This does not isolate arbitrary host shell execution. Windows is unsupported for attachment reads.

CI explicitly runs the LightClaw workspace test script. Tests isolate HOME/credentials and block Node TCP/fetch access; models and platform APIs use faux/mock implementations. For targeted local regression runs, follow AGENTS.md and select explicit test files. Historical experiment accounting is available in `docs/diagnosis/2026-10-21/analyze-live-v2.py`; `--check` verifies versioned outputs without writing or calling models.

## Single-instance recovery

The runtime holds a kernel flock through a parent-owned descriptor, persists accepted messages/events before dispatch, and retains interrupted execution as unknown for manual reconciliation. Controlled operations use stable IDs and service result queries. Docker tasks are supervised inside the container and cancellation requires exit confirmation. Host POSIX/Python support is required; Docker additionally requires container Python and Linux subreaper/pidfd support. Arbitrary bash side effects do not gain exactly-once guarantees. See [recovery semantics and validation boundaries](docs/recovery.zh-CN.md).

统一评测CLI不带suite时默认无凭证数据审计。上面的legacy/optimize命令会消耗真实模型额度，必须另行授权；本批没有运行。完整提示/工具故障正文诊断需显式 `LIGHTCLAW_DEBUG_PAYLOADS=1`，否则保留计数而不捕获完整调试内容；候选分析未启用该项就没有完整基线提示记录，不应宣称据此检验自动优化收益。

### Explicit prompt input and optimization

Ordinary messages use the supplied input without candidate generation or scoring. `LIGHTCLAW_PROMPT_INSTRUCTIONS` is explicitly supplied operator text and remains independent of the optimization feature switch; no optimized file is discovered or loaded automatically. The public `resolvePromptInput` action defaults to `inject`, preserves the input bytes, and calls its scoring dependency only for `action: "optimize"`. It returns a recommendation rather than changing future input defaults. Feishu offers a “提示词优化” interactive card for ordinary text input (up to 12,000 characters). Only the original sender can click the bound card in the original chat, within 30 minutes. Clicking makes up to two tool-free model requests (candidate generation then subjective scoring), at most 1536 output tokens each; the original is also scored. The ranked recommendation is displayed for manual use and never replaces a running task or future input. Duplicate, expired, forwarded or interrupted requests do not automatically rerun. Subscribe the dedicated Feishu application to `card.action.trigger` before live acceptance. Slack remains direct input; it has no new optimization button.

权威审计位于工作区外的 `<控制目录>/.audit/`；包含 runs/tool-calls/spans 与显式启用的 payload。路径、配额、保留期和恢复命令以 [部署说明](docs/deployment.zh-CN.md) 为准。默认使用用户输入，不自动生成、评分或加载候选提示词；显式优化动作只返回推荐，不改变后续输入默认状态。
