# LightClaw

状态：2026-11-06功能收敛为个人Agent，采用源码启动；工程回归保留，独立评测与基准已退役。见[最终范围](docs/project-scope.zh-CN.md)、[部署](docs/deployment.zh-CN.md)和[学习路线](docs/learning-path.zh-CN.md)。

**A self-hosted agent for Feishu and Slack that saves progress and verifies task completion.**

[中文](README.zh-CN.md) · [Repository overview](../../README.md) · [Architecture](docs/architecture.zh-CN.md) · [Goal acceptance](docs/goals.zh-CN.md)

Give LightClaw a task in chat. It uses file and shell tools, keeps conversation and goal state on disk, and checks completion against fixed file/command rules or the goal owner's confirmation.

## 推荐的源码启动方式

已有.env不要覆盖。首次配置：

```bash
cp packages/lightclaw/config.env.example .env
# 本地编辑.env，填写平台凭证与模型配置
bash scripts/start-lightclaw.sh
```

启动器会载入.env并从仓库根运行；main.ts直接入口仍只读进程环境。模板默认host模式，按当前OS用户权限执行工具；如需Docker，先创建容器再修改LIGHTCLAW_SANDBOX。自定义网关使用LIGHTCLAW_MODELS_FILE，与完整步骤见[部署](docs/deployment.zh-CN.md)。项目不再包含Agent效果评测、性能基准或离线候选晋升功能。

## Highlights

- **Durable goals:** pause, resume, cancel, and recover active goals after process restarts.
- **Verified completion:** a model's completion claim starts acceptance; it does not by itself complete a goal.
- **Bounded execution:** per-run deadlines, tool and reported-token limits, plus failure and stale-progress circuit breakers.
- **Channel scheduling:** bounded queues, queue expiry, and idle state disposal.
- **Tool sandbox:** optional Docker execution with CPU, memory, process, and network settings.
- **Controlled operation:** deterministic goal acceptance, protected state, approvals, recovery and audit logs.
- **Editable prompt preview:** isolated suggestions with explicit user confirmation before execution.

Built on pi's model, Agent, and session infrastructure. LightClaw adds chat transports and the task lifecycle in this package.

## Quick start

Install dependencies from the repository root:

LightClaw requires Node.js 22.19.0 or newer, npm, a Linux/macOS host, and host Python 3.9+ for secure attachments and POSIX runtime locking. The following setup also requires an installed and running Docker engine. The Docker sandbox contains tools; the Node agent runs on the host.

```bash
git clone https://github.com/Xxly959/Light-Claw.git
cd Light-Claw
npm install
mkdir -p lightclaw-data
bash packages/lightclaw/docker.sh create ./lightclaw-data
```

This model example matches the `.env` template. Its presence in the checked-in catalog does not verify live provider access. The provider and model must exist in pi's registry or a custom `LIGHTCLAW_MODELS_FILE`:

```bash
export LIGHTCLAW_MODEL_PROVIDER=deepseek
export LIGHTCLAW_MODEL_ID=deepseek-v4-flash
export DEEPSEEK_API_KEY=your-key
# For a custom OpenAI-compatible gateway, set OPENAI_API_KEY as needed and override the endpoint
# export OPENAI_BASE_URL=https://your-openai-compatible-gateway.example/v1
```

For Feishu, enable the bot, subscribe to `im.message.receive_v1` through a long connection, and grant message read/send permissions. Prompt forms and previews additionally require `card.action.trigger` and a client supporting card JSON 2.0. Send a direct message or mention the bot in a group:

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

Credentials come from environment variables or pi's auth store; the entrypoint does not load `.env` automatically. Omitting `--sandbox` runs tools on the host. Docker tool containers use `none` networking by default; explicitly set `LIGHTCLAW_SANDBOX_NETWORK=bridge` before creating a container when tools need network access. Container networking does not restrict the host agent’s platform connections or model requests. See [sandbox configuration](docs/sandbox.zh-CN.md).

## Execution boundaries

Per-channel containers restrict tool filesystem access. The host agent still injects the global memory index excerpt into model context and loads global skill metadata, so this is not complete channel information or tenant isolation. Unmapped channels use the shared container unless `LIGHTCLAW_SANDBOX_FALLBACK=deny` is set.

With `LIGHTCLAW_POLICY_MODE=enforce`, calls matching danger rules require a one-time approval. These rules do not cover arbitrary shell commands or scripts. Approval starts a model continuation requesting the same operation; it does not guarantee a retry or success. Changed arguments do not inherit the original ticket and are evaluated again.

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

Schema 2 state lives outside the workspace at `~/.pi/lightclaw/control/<SHA-256 of canonical workspace>/<channel>/goal.json`. `LIGHTCLAW_CONTROL_DIR` overrides the control root. Docker mounts overlapping any protected state prevent startup. The current workspace must map exactly to `/workspace`, without nested mounts shadowing channels or sources. Host mode with the same UID remains outside the adversarial isolation guarantee. Bot and migration share `instance.lock`; wait for shutdown and kernel lock release; an existing lock file alone is not a reason to delete it. Only active protected goals recover; awaiting confirmation does not.

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
├── .shared/memory/
├── settings.json
├── events/
└── <channel-id>/
    ├── MEMORY.md
    ├── memory/
    ├── log.jsonl
    ├── context.jsonl
    ├── attachments/
    ├── scratch/
    └── skills/
```

Each `MEMORY.md` is re-read on every run. LightClaw injects up to 4 KiB of complete lines from each file and leaves the rest on disk for on-demand lookup. Keep stable preferences and links in the indexes, and put longer notes under the corresponding `memory/` directory. An isolated channel can read shared notes when `.shared/` is mounted read-only.

The audit log contains operational metadata only. It does not intentionally store prompts, tool arguments, API keys, or response bodies.

## Documentation

- [Chinese guide](README.zh-CN.md)
- [Architecture](docs/architecture.zh-CN.md)
- [Long-running goals](docs/goals.zh-CN.md)
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


### Explicit prompt input and optimization

Ordinary messages execute unchanged. `LIGHTCLAW_PROMPT_INSTRUCTIONS` remains explicit operator configuration, independent of optional rewriting. In a Feishu group, send `@bot 任务入口` (alias `/prompt-entry`) and manually pin the reusable entry card. Click **输入任务** to open a fresh actor-bound form; alternatively send `@bot /prompt` with an optional prefill. The entry is bound to its original chat/message and survives restart; missing interaction tokens and forwarded cards are refused. Forms and previews are visible to the group. Enter up to 1,000 UTF-16 units and choose **原文发送** to execute unchanged, or **优化并预览** to make a tool-free candidate request (at most 2048 output tokens) and a separate constraint review (at most 1024 output tokens). The original card then shows task type, actual change suggestions, assumptions and open questions separately from the editable prompt and **确认发送**. Those explanations are rendered as literal text and are not sent to the Agent. No Agent task runs during preview. Edit the text, then confirm to execute exactly the final submitted text; confirmation never rewrites it again. Results over 1,000 units use sequential fields (up to 12,000 units total), concatenated without extra separators or broken surrogate pairs. Each field allows at most 1,000 units, and a short preview can be edited up to that field limit.

For open-ended requests, the rewriter adds task-specific execution and output guidance (for research: classification, mechanisms, comparison and verifiable sources) rather than merely polishing punctuation. Identical or punctuation/whitespace-only responses are explicitly labeled in the preview. The rewriter preserves intent and constraints, avoids forced expansion or invented context, and receives its own system prompt, original input and host-provided target capability description as a JSON data envelope (`context: null`; web search is unverified by default). It returns bounded JSON metadata and a candidate prompt. Protected code, URLs, paths, variables and numbers are checked before a separate tool-free original/candidate constraint review; rejection fails closed without running the task. These checks do not establish general semantic equivalence or improved downstream quality. Neither raw input, rewrite instructions, change metadata, nor preview interactions are automatically appended to the Agent session. Only the final confirmed text becomes a user turn alongside prior conversation. Feishu `/prompt` commands and prefills are excluded from log-to-session import, including after restart. This is **session-context isolation**, not zero retention: source chat logs, protected drafts and durable inbox records still retain input for reconciliation; existing session entries and older summaries are unchanged. Ordinary chat messages remain conversation history, so enter a draft in the form instead of sending it as ordinary chat first.

Only the creator can submit or confirm in the original chat/card within the original 30-minute expiry. Confirmation rechecks expiry, current channel activity and active goals; pause a long-running goal before submitting an independent task. Duplicate or interrupted requests never replay automatically, including after restart. A preview can survive restart until expiry. Malformed/incomplete rewrites, failed or uncertain preview delivery, cancellation and timeout do not execute the task or fall back to the original. A consumed confirmation cannot execute again. Submitted controls collapse to a status card; the navigation entry remains reusable. Open a new form for a new task or a different sending mode. Callback receipts acknowledge admission only; conflicting payloads return a safe error toast rather than throwing through the SDK. Rewritten or edited task text cannot invoke `/approve`, `/recover` or `/goal` command routing. Enable `card.action.trigger` and a client supporting card JSON 2.0 forms. Slack and ordinary text remain unchanged.

The 2026-11-06 [functional acceptance report](../../docs/reports/FINAL-ACCEPTANCE-2026-11-06.zh-CN.md) records fresh isolated builds, clean installation, live private-chat/model checks, and the user-completed preview/edit/confirm flow with session inspection. Standalone evaluation, candidate-promotion and benchmark CLIs have been removed. Operational regression tests and interactive prompt suggestions remain. Existing processes need a controlled restart to load source changes.

权威审计位于工作区外的 `<控制目录>/.audit/`；包含 runs/tool-calls/spans 与显式启用的 payload。路径、配额、保留期和恢复命令以 [部署说明](docs/deployment.zh-CN.md) 为准。普通聊天直接使用用户输入；飞书表单在“优化并预览”后展示可编辑结果，点击“确认发送”才执行最终文本，不评分，不改变后续输入默认状态。
