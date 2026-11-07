# Changelog

## [Unreleased]

### Breaking Changes

- Replace Feishu chat candidate scoring with a before-send `/prompt` form: send unchanged by default or explicitly rewrite once and execute; old scoring cards require reopening the form.

- Manual completion requires structured file or explicit no-file deliverables; confirmation expires and rechecks artifact identity/content/timestamps. Execution approval under a trusted-user list requires a trusted user or administrator. Authoritative audit records move outside the tool workspace into the control directory.

- Stop handlers require a platform actor. Goal/run controls check owner or explicitly configured administrators before cancellation; human confirmation remains creator-only. Docker startup rejects unsafe or unbounded configurations. Full diagnostic payload capture now requires explicit opt-in.

- The unified evaluation CLI now defaults to a credential-free offline audit; the previous model-backed single-turn mode requires `--suite=legacy`.

- All runtime modes require host POSIX/Python flock support; stop older instances before upgrading. Docker execution requires container Python with Linux subreaper/pidfd support and confirms task termination before reporting cancellation.

- Attachment uploads require host Python 3 on POSIX, accept only current-channel paths, reject links and non-regular files, and enforce a 20 MiB limit. Transport upload paths are now channel-relative.

- Prompt optimization reports now use schema 4 and record distinct request seeds, selection objective, measured-noise guards and thresholds. Run input-token totals now include provider-reported cache reads and writes.

- Renamed the package, workspace directory, CLI, runtime directory, Docker sandbox, and environment variables from Mom to LightClaw. Configuration now uses the `LIGHTCLAW_*` prefix.
- Required Node.js 22.19.0 or newer to match undici's runtime requirement.
- Changed benchmark summaries and resource records to schema 2 with required event-loop observations.
- Required independent holdout cases and at least five repetitions for prompt optimization, with schema 2 reports retaining every evaluation and rejection reason.

### Added

- Add a reusable Feishu task-entry card (`任务入口` or `/prompt-entry`) that opens fresh actor-bound forms without model calls, with persisted chat/card binding and callback deduplication across restart.

- Support explicitly selected custom gateway model definitions through `LIGHTCLAW_MODELS_FILE`, using the upstream ModelRegistry schema without substituting a built-in model ID.

- Add a credential-free Feishu acceptance scope preflight and blank scope template; validate explicit identities, participants, action limits and fault permissions without reading credential references or starting online actions.

- Add authenticated `/approve maintain` and `/approve show <id>` for durable, digest-verified approval history archival without dropping valid tickets or replaying consumed operations.
- Enforce a frozen campaign budget across faux workers and shared A/B axes, with bounded transaction contention, explicit budget initialization and controller resume that retains spent/unknown allowances.

- Add a Feishu `/prompt` input form bound to the original actor/chat/card and expiry. Submit unchanged or explicitly rewrite once and execute the effective prompt, without chat candidate scoring or sticky defaults.

- Add authenticated `/recover` inbox/operation reconciliation and duplicate-risk retry controls, terminal inbox archival with bounded deduplication, runtime heartbeat/readiness, bounded scheduling catch-up and a local fault hook.
- Accept Feishu inbound files/images through bounded SDK streams and pinned host writes before Agent dispatch; report unsupported messages and admission failures explicitly.
- Add task Docker isolation and persistent faux-evaluation budget ledgers, standalone install verification preparation, native backup/restore tooling and explicit platform/model authorization plans.

- Add execution-side capability adjudication, one-shot human approval tickets (`/approve`) and a two-tier tool audit: a redacted summary in `<control>/.audit/tool-calls.jsonl` plus opt-in payloads in `<control>/.audit/payloads/`. Extension tools must declare `capabilities` at runtime; unregistered tools are rejected.
- Add `--isolation-report` for a machine-readable isolation statement, OTLP/JSON-compatible spans in `<control>/.audit/spans.jsonl`, and primary/backup model routing via `LIGHTCLAW_MODEL_FALLBACKS`.
- Add optional per-channel containers: `docker.sh create-channel`, `LIGHTCLAW_CHANNEL_CONTAINERS_JSON` and `LIGHTCLAW_SANDBOX_FALLBACK=deny`. A channel container mounts only `<workspace>/<channelId>`, and startup rejects any extra binding.
- `/approve` now resumes the run and retries the approved operation instead of waiting for the user to prompt again; a changed argument is intercepted again.
- Add `lightclaw-audit` for querying `<control>/.audit/tool-calls.jsonl` by tool, channel, decision and outcome, with table and JSON output.
- Add a side-effect-free public source index, native local source-release integrity tooling, credential-free CLI help/local lock health probe, deployment/recovery guidance and explicit unverified compiled-install gates.
- Add shared actual-adapter offline contracts, Unicode-safe reply previews, strict dated event scheduling and configurable resource/diagnostic retention and admission limits.

- Add a shared-production-runtime reliability evaluation suite with 36 family-separated synthetic tasks, protected exact artifact scoring, isolated faux workers, crash/fault evidence, frozen manifests and task-level paired statistics. Offline wiring results do not measure model quality or prompt benefit.

- Persist message and one-shot event admission, consumption, deadlines, bounded manual retries and uncertain/dead-letter outcomes in the protected control directory.
- Add stable-ID controlled operation records, service result reconciliation and manual resolution, with an independent mock-service process fault matrix.

- Added seven independent diagnostic feature switches and an owner-only goal verification dispute log.

- Added immutable goal acceptance contracts, deterministic file and Docker command verification, owner confirmation, protected schema 2 control storage, and explicit offline legacy migration.

- Added LightClaw branding, Feishu and Slack transport selection, configurable model providers, durable long-running goals, crash recovery, circuit breakers, and privacy-conscious run auditing.
- Added dataset-based Agent evaluation, rule scoring, JSON reports, and guarded prompt optimization that promotes only better candidates.
- Added a non-root Docker image with CPU, memory, process, capability, and privilege limits.
- Added a deterministic faux-provider concurrency benchmark with raw task, round, CPU, and memory samples plus summaries rebuilt from those records.
- Added configurable per-run duration, tool-call, reported-token limits and a default bash timeout.
- Added configurable platform request timeouts, uncertain-delivery isolation, and delivery error reporting independent of execution outcomes.
- Added benchmark P99, maximum latency, per-round results, event-loop delay, and resource-sampling lag observations.
- Added configurable pending queue capacity and wait deadlines with rejection/expiry auditing and user notices.
- Added bounded idle channel caches that retain busy resources and dispose inactive sessions without deleting persisted state.

### Changed

- Redesign optional Feishu rewriting as task-aware structured suggestions with visible changes, assumptions and questions, target capability evidence, protected-literal checks and a separate tool-free constraint review. Only confirmed editable text reaches the Agent. Add stable evidence, failure reporting and completion checks to the Agent system instructions.

- Replace Feishu rewrite-and-execute with an editable preview and explicit confirmation. Preserve actor/chat/card/expiry binding and restart deduplication; only final confirmed text enters the Agent session, with no original prompt or rewrite traffic. Long results use bounded sequential editable fields.

- Collapse validly submitted Feishu input forms into status cards while keeping the reusable entry, and report fixed safe failure reasons with durable/audit categories instead of diagnostic payload placeholders.

- Refine optional chat rewriting to preserve intent without forced expansion, serialize input as data, and execute only a valid structured prompt while excluding rewrite explanations.

- New approval tickets use 128-bit IDs; previously issued IDs remain available for historical reconciliation. Critical approval-maintenance audit failures propagate to durable recovery.

- Keep explicitly supplied prompt instructions independent of optional rewriting. Plain chat input stays unchanged; only the explicit form action rewrites the current task, with no command-privilege promotion or change to future defaults.

- Load skill creation, event scheduling, and history-query tutorials on demand from a channel-local guide while keeping installed skills discoverable.
- Support explicit quality, token, or latency objectives in repeated prompt selection, retaining quality and tool-error guards.

- Completion claims now require verification or owner confirmation; natural-language goals use manual acceptance. Goal state is stored outside the workspace and startup requires an exclusive control lock.

- Decoupled the agent, event watcher, and message context from Slack-specific transport types.
- Tested LightClaw against workspace package sources and configured CI for minimum and current Node 22 versions.
- Surfaced Slack rate limits and request failures without automatic retries after uncertain delivery.

### Fixed

- Reject missing or non-directory workspace/control backup roots before creating locks or output, and fail on unreadable subtrees instead of silently producing an incomplete successful backup.

- Give open-ended prompt rewrites task-specific execution and output guidance instead of treating a clear high-level goal as a complete instruction; explicitly label unchanged or punctuation-only previews.

- Initialize fetch and the proxy dispatcher from the same Undici implementation so compressed HTTP/2 model streams retain their headers and decode correctly instead of appearing empty.

- Reject empty or thinking-only model completions as explicit failures, replace stale thinking placeholders, and distinguish empty rewrite responses from malformed prompt envelopes without automatically replaying requests.

- Return explicit Feishu card receipts and safe admission-error toasts instead of leaking inbox payload-conflict exceptions into SDK 500 responses when a submitted form changes mode or text. Clarify that forms are single-use.

- Exclude Feishu `/prompt` composer commands and their prefills from history import so optional rewrites retain only the effective task in Agent context across subsequent turns and restarts.

- Normalize SDK mention keys identifying the Feishu bot before task dispatch, preserving other users’ mention tokens and literal text without mention metadata.

- Persist inbox admission order independently of wall-clock timestamps so equal timestamps, clock rollback and restart do not reorder accepted work; reject invalid or duplicate ordering metadata.

- Execute benchmark CLI through npm bin symlinks; require observable CLI help in clean-install checks. Resolve installed ESM-only evaluation dependencies, isolate npm configuration, and bound release source enumeration to the declared scope.

- Reissue expired approval requests without consuming valid pending quota; retain history and serialize ticket mutations. Route retryable stream errors through provider-specific credentials only before content output, preserving failed-attempt accounting and cooldown.
- Count tool audits, spans and full payloads under cumulative quotas, rotate retained segments, reject linked audit paths, fail closed on critical writes and verify every configured container separately.
- Resolve Python helpers beside compiled code, defer tsx resolution to source workers, and provide credential-free help for every CLI. Verify fresh isolated builds, independent offline installation and native compiled faux execution under explicit build authorization.

- Prevent invalid historical-goal controls from cancelling another current run, pass authenticated stop identities, and validate channel storage paths.
- Admit attachment batches atomically, enforce bounded downloads/archives, retain authoritative state on quota/write failure, and keep optional diagnostic failures nonfatal.
- Accept safe Docker tmpfs mounts throughout startup isolation and bound startup probe duration/output. Preserve the existing channel export alongside the separate attachment downloader.

- Replace stale file-token locks with kernel ownership released on process exit; stop admission and drain/cancel in-flight work before unlock.
- Retain queued work across restarts, isolate uncertain execution before follow-up/goal replay, and delete one-shot sources only after durable admission.
- Supervise Docker execution trees inside the container, with host-liveness monitoring and cancellation/exit confirmation.

- Enforce attachment authorization at both platform read boundaries using pinned directory/file descriptors and upload only bounded, verified bytes.
- Run LightClaw offline regressions through the workspace test script and an explicit required CI step, with isolated user configuration and blocked Node network access.

- Return corrective goal acceptance conditions, ignore progress-only verification revisions, deduplicate identical progress, and redact common credentials in audit failure details.
- Reject prompt promotions within measured baseline variation, training-only gains, and per-task mean regressions; send paired distinct seeds through supported OpenAI-compatible evaluation requests.

- Keep sandbox paths and fresh channel, memory, and goal context in the system prompt actually dispatched by AgentSession.
- Discover optional shell commands once per runner, report missing commands explicitly, and remove contradictory Docker package-install instructions.
- Include all training repetitions, effective system prompts, and bounded tool-error diagnostics when generating prompt candidates.

- Isolated attachment uploads per agent runner to prevent files being routed to another channel during concurrent runs.
- Rejected overlapping runs on the same runner and drained queued replies before clearing run state, including after setup or prompt failures.
- Kept model reasoning content in local logs instead of exposing it in chat responses.
- Preserved a successfully completed goal when the model gateway fails while generating the final response.
- Prevented ordinary one-turn tasks from calling long-running goal tools without an active goal.
- Rejected blank completion evidence and malformed persisted goals, isolating corrupt channels during recovery.
- Validated evaluation datasets before loading tasks.
- Archived every truncated shell output before returning its path, preserved large-output tails, and handled asynchronous spawn errors.
- Counted written UTF-8 bytes accurately.
- Recovered message updates after delivery failures, preserved execution auditing and completed goals, and paused stranded active goals.
- Prevented new model requests and tool side effects after a run budget is exhausted.
- Rejected timer-overflow budgets, non-string goal statuses, and noncanonical persisted dates.
- Corrected goal recovery hints to the supported `/goal resume` command.
- Isolated cached runners by workspace path and avoided allocating runners for inactive goals during startup.
- Rejected unknown or ineffective evaluation checks, validated programmatic datasets, scored cancellation and truncation as unsuccessful, and restricted artifact checks to channel-local regular files.
- Released evaluation sessions and used unique report paths to avoid collisions.
- Cancelled session retry and compaction alongside model execution, preserving cancellation until the current run finishes.
- Prevented a stop received during typing delivery from launching a new run.
- Observed immediate platform notifications with deadlines and failure auditing.
- Rejected prompt candidates with increased tool-error or artifact-failure frequency across repeated evaluations.
- Rejected explicit shell timeouts outside the Node timer range before command execution.

### Removed

- Remove standalone Agent evaluation, candidate-promotion and deterministic benchmark modules, datasets, CLIs and evaluation-only runtime seed injection. Keep operational regression tests, goal acceptance, audit and interactive prompt previews.

## [0.70.6] - 2026-04-28

## [0.70.5] - 2026-04-27

## [0.70.4] - 2026-04-27

## [0.70.3] - 2026-04-27

## [0.70.2] - 2026-04-24

## [0.70.1] - 2026-04-24

## [0.70.0] - 2026-04-23

### Fixed

- Fixed Mom event-directory `fs.watch` error handling to retry after transient watcher failures such as `EMFILE`, avoiding startup crashes ([#3564](https://github.com/badlogic/pi-mono/issues/3564))

## [0.69.0] - 2026-04-22

### Breaking Changes

- Migrated Mom's TypeBox-based tool examples and runtime dependency from `@sinclair/typebox` 0.34.x to `typebox` 1.x. Install and import from `typebox` instead of `@sinclair/typebox` when authoring Mom tools and integrations ([#3112](https://github.com/badlogic/pi-mono/issues/3112))

## [0.68.1] - 2026-04-22

## [0.68.0] - 2026-04-20

## [0.67.68] - 2026-04-17

## [0.67.67] - 2026-04-17

## [0.67.6] - 2026-04-16

## [0.67.5] - 2026-04-16

## [0.67.4] - 2026-04-16

## [0.67.3] - 2026-04-15

## [0.67.2] - 2026-04-14

## [0.67.1] - 2026-04-13

## [0.67.0] - 2026-04-13

## [0.66.1] - 2026-04-08

## [0.66.0] - 2026-04-08

## [0.65.2] - 2026-04-06

## [0.65.1] - 2026-04-05

## [0.65.0] - 2026-04-03

## [0.64.0] - 2026-03-29

## [0.63.2] - 2026-03-29

## [0.63.1] - 2026-03-27

### Fixed

- Fixed Mom compaction status handling to follow the unified `compaction_start` and `compaction_end` session events, keeping compaction notifications working after the event rename ([#2617](https://github.com/badlogic/pi-mono/issues/2617))

## [0.63.0] - 2026-03-27

## [0.62.0] - 2026-03-23

## [0.61.1] - 2026-03-20

## [0.61.0] - 2026-03-20

## [0.60.0] - 2026-03-18

## [0.59.0] - 2026-03-17

## [0.58.4] - 2026-03-16

## [0.58.3] - 2026-03-15

## [0.58.2] - 2026-03-15

## [0.58.1] - 2026-03-14

## [0.58.0] - 2026-03-14

## [0.57.1] - 2026-03-07

## [0.57.0] - 2026-03-07

## [0.56.3] - 2026-03-06

## [0.56.2] - 2026-03-05

## [0.56.1] - 2026-03-05

## [0.56.0] - 2026-03-04

## [0.55.4] - 2026-03-02

### Fixed

- Fixed mom startup crash caused by settings API drift by using `SettingsManager` with workspace-backed storage ([#1444](https://github.com/badlogic/pi-mono/issues/1444))

## [0.55.3] - 2026-02-27

## [0.55.2] - 2026-02-27

## [0.55.1] - 2026-02-26

## [0.55.0] - 2026-02-24

## [0.54.2] - 2026-02-23

## [0.54.1] - 2026-02-22

## [0.54.0] - 2026-02-19

## [0.53.1] - 2026-02-19

## [0.53.0] - 2026-02-17

## [0.52.12] - 2026-02-13

## [0.52.11] - 2026-02-13

## [0.52.10] - 2026-02-12

## [0.52.9] - 2026-02-08

## [0.52.8] - 2026-02-07

## [0.52.7] - 2026-02-06

## [0.52.6] - 2026-02-05

## [0.52.5] - 2026-02-05

## [0.52.4] - 2026-02-05

## [0.52.3] - 2026-02-05

## [0.52.2] - 2026-02-05

## [0.52.1] - 2026-02-05

## [0.52.0] - 2026-02-05

## [0.51.6] - 2026-02-04

## [0.51.5] - 2026-02-04

## [0.51.4] - 2026-02-03

## [0.51.3] - 2026-02-03

## [0.51.2] - 2026-02-03

## [0.51.1] - 2026-02-02

## [0.51.0] - 2026-02-01

## [0.50.9] - 2026-02-01

## [0.50.8] - 2026-02-01

## [0.50.7] - 2026-01-31

## [0.50.6] - 2026-01-30

## [0.50.5] - 2026-01-30

## [0.50.3] - 2026-01-29

## [0.50.2] - 2026-01-29

## [0.50.1] - 2026-01-26

## [0.50.0] - 2026-01-26

## [0.49.3] - 2026-01-22

## [0.49.2] - 2026-01-19

## [0.49.1] - 2026-01-18

## [0.49.0] - 2026-01-17

## [0.48.0] - 2026-01-16

## [0.47.0] - 2026-01-16

## [0.46.0] - 2026-01-15

## [0.45.7] - 2026-01-13

## [0.45.6] - 2026-01-13

## [0.45.5] - 2026-01-13

## [0.45.4] - 2026-01-13

## [0.45.3] - 2026-01-13

## [0.45.2] - 2026-01-13

## [0.45.1] - 2026-01-13

## [0.45.0] - 2026-01-13

## [0.44.0] - 2026-01-12

## [0.43.0] - 2026-01-11

## [0.42.5] - 2026-01-11

### Fixed

- Use coding-agent's SessionManager instead of custom MomSessionManager to fix API mismatch crash ([#595](https://github.com/badlogic/pi-mono/issues/595))

## [0.42.4] - 2026-01-10

## [0.42.3] - 2026-01-10

## [0.42.2] - 2026-01-10

## [0.42.1] - 2026-01-09

## [0.42.0] - 2026-01-09

## [0.41.0] - 2026-01-09

## [0.40.1] - 2026-01-09

## [0.40.0] - 2026-01-08

## [0.39.1] - 2026-01-08

## [0.39.0] - 2026-01-08

## [0.38.0] - 2026-01-08

## [0.37.8] - 2026-01-07

## [0.37.7] - 2026-01-07

## [0.37.6] - 2026-01-06

## [0.37.5] - 2026-01-06

## [0.37.4] - 2026-01-06

## [0.37.3] - 2026-01-06

## [0.37.2] - 2026-01-05

## [0.37.1] - 2026-01-05

## [0.37.0] - 2026-01-05

## [0.36.0] - 2026-01-05

## [0.35.0] - 2026-01-05

## [0.34.2] - 2026-01-04

## [0.34.1] - 2026-01-04

## [0.34.0] - 2026-01-04

## [0.33.0] - 2026-01-04

## [0.32.3] - 2026-01-03

## [0.32.2] - 2026-01-03

## [0.32.1] - 2026-01-03

## [0.32.0] - 2026-01-03

## [0.31.1] - 2026-01-02

## [0.31.0] - 2026-01-02

### Breaking Changes

- `AgentTool` import moved from `@mariozechner/pi-ai` to `@mariozechner/pi-agent-core`
- `AppMessage` type renamed to `AgentMessage`
- `Attachment` type replaced with `ImageContent` for image handling
- `MomSessionManager.loadSession()` renamed to `buildSessionContex()`
- `MomSessionManager.createBranchedSessionFromEntries()` signature changed to `createBranchedSession(leafId)`
- `ProviderTransport` removed from Agent config, replaced with direct `getApiKey` callback
- `messageTransformer` renamed to `convertToLlm`
- `ANTHROPIC_API_KEY`/`ANTHROPIC_OAUTH_TOKEN` no longer checked at startup (deferred to first API call)

### Changed

- Session entries now include `id` and `parentId` fields for tree structure support
- Auth lookup now uses `AuthStorage` class instead of direct environment variable access
- Image attachments use `ImageContent` type with `data` field instead of `Attachment` with `content`
- `session.prompt()` now uses `images` option instead of `attachments`

### Added

- Support for OAuth login via coding agent's `/login` command (link `~/.pi/agent/auth.json` to `~/.pi/mom/auth.json`)

## [0.20.2] - 2025-12-13

### Fixed

- **Skill paths now use container paths**: Skill file paths in system prompt are translated to container paths (e.g., `/workspace/skills/...`) so mom can read them from inside Docker.

## [0.20.1] - 2025-12-13

### Added

- **Skills auto-discovery**: Mom now automatically discovers skills from `workspace/skills/` and `channel/skills/` directories. Skills are directories containing a `SKILL.md` file with `name` and `description` in YAML frontmatter. Available skills are listed in the system prompt with their descriptions. Mom reads the `SKILL.md` file before using a skill.

## [0.19.2] - 2025-12-12

### Added

- Events system: schedule wake-ups via JSON files in `workspace/events/`
  - Immediate events: trigger when file is created (for webhooks, external signals)
  - One-shot events: trigger at specific time (for reminders)
  - Periodic events: trigger on cron schedule (for recurring tasks)
- `SlackBot.enqueueEvent()` for queueing events (max 5 per channel)
- `[SILENT]` response marker: deletes status message, posts nothing to Slack (for periodic events with nothing to report)
- Events documentation in `docs/events.md`
- System prompt section explaining events to mom

## [0.18.8] - 2025-12-12

### Changed

- Timestamp prefix now includes timezone offset (`[YYYY-MM-DD HH:MM:SS+HH:MM]`)

## [0.18.7] - 2025-12-12

### Added

- Timestamp prefix on user messages (`[YYYY-MM-DD HH:MM:SS]`) so mom knows current date/time

### Fixed

- Sync deduplication now strips timestamp prefix before comparing

## [0.18.6] - 2025-12-12

### Fixed

- Duplicate message in context when message has attachments (sync from log didn't strip attachment section before comparing)
- Use `<slack_attachments>` delimiter for attachments in messages (easier to parse/strip)

## [0.18.5] - 2025-12-12

### Added

- `--download <channel-id>` flag to download a channel's full history including thread replies as plain text

### Fixed

- Error handling: when agent returns `stopReason: "error"`, main message is updated to "Sorry, something went wrong" and error details are posted to the thread

## [0.18.4] - 2025-12-11

### Fixed

- Attachment downloads now work correctly
  - SlackBot now receives store for processing file downloads
  - Files are downloaded in background and stored in `<channel>/attachments/`
  - Attachment paths passed to agent as absolute paths in execution environment
  - Backfill also downloads attachments from historical messages

## [0.18.3] - 2025-12-11

### Changed

- Complete rewrite of message handling architecture (#115)
  - Now uses `AgentSession` from coding-agent for session management
  - Brings auto-compaction, overflow handling, and proper prompt caching
  - `log.jsonl` is the source of truth for all channel messages
  - `context.jsonl` stores LLM context (messages sent to Claude, same format as coding-agent)
  - Sync mechanism ensures context.jsonl stays in sync with log.jsonl at run start
  - Session header written immediately on new session creation (not lazily)
  - Tool results preserved in context.jsonl for multi-turn continuity

- Backfill improvements
  - Only backfills channels that already have a `log.jsonl` file
  - Strips @mentions from backfilled messages (consistent with live messages)
  - Uses largest timestamp in log for efficient incremental backfill
  - Fetches DM channels in addition to public/private channels

- Message handling improvements
  - Channel chatter (messages without @mention) logged but doesn't trigger processing
  - Messages sent while mom is busy are logged and synced on next run
  - Pre-startup messages (replayed by Slack on reconnect) logged but not auto-processed
  - Stop command executes immediately (not queued), can interrupt running tasks
  - Channel @mentions no longer double-logged (was firing both app_mention and message events)

- Usage summary now includes context window usage
  - Shows current context tokens vs model's context window
  - Example: `Context: 4.2k / 200k (2.1%)`

### Fixed

- Slack API errors (msg_too_long) no longer crash the process
  - Added try/catch error handling to all Slack API calls in the message queue
  - Main channel messages truncated at 35K with note to ask for elaboration
  - Thread messages truncated at 20K
  - replaceMessage also truncated at 35K

- Private channel messages not being logged
  - Added `message.groups` to required bot events in README
  - Added `groups:history` and `groups:read` to required scopes in README

- Stop command now updates "Stopping..." to "Stopped" instead of posting two messages

### Added

- Port truncation logic from coding-agent: bash and read tools now use consistent 2000 lines OR 50KB limits with actionable notices

## [0.10.2] - 2025-11-27

### Breaking Changes

- Timestamps now use Slack format (seconds.microseconds) and messages are sorted by `ts` field
  - **Migration required**: Run `npx tsx scripts/migrate-timestamps.ts ./data` to fix existing logs
  - Without migration, message context will be incorrectly ordered

### Added

- Channel and user ID mappings in system prompt
  - Fetches all channels bot is member of and all workspace users at startup
  - Mom can now reference channels by name and mention users properly
- Skills documentation in system prompt
  - Explains custom CLI tools pattern with SKILL.md files
  - Encourages mom to create reusable tools for recurring tasks
- Debug output: writes `last_prompt.txt` to channel directory with full context
- Bash working directory info in system prompt (/ for Docker, cwd for host)
- Token-efficient log queries that filter out tool calls/results for summaries

### Changed

- Turn-based message context instead of raw line count (#68)
  - Groups consecutive bot messages (tool calls/results) as single turn
  - "50 turns" now means ~50 conversation exchanges, not 50 log lines
  - Prevents tool-heavy runs from pushing out conversation context
- Messages sorted by Slack timestamp before building context
  - Fixes out-of-order issues from async attachment downloads
  - Added monotonic counter for sub-millisecond ordering
- Condensed system prompt from ~5k to ~2.7k chars
  - More concise workspace layout (tree format)
  - Clearer log query examples (conversation-only vs full details)
  - Removed redundant guidelines section
- User prompt simplified: removed duplicate "Current message" (already in history)
- Tool status labels (`_→ label_`) no longer logged to jsonl
- Thread messages and thinking no longer double-logged

### Fixed

- Duplicate message logging: removed redundant log from app_mention handler
- Username obfuscation in thread messages to prevent unwanted pings
  - Handles @username, bare username, and <@USERID> formats
  - Escapes special regex characters in usernames

## [0.10.1] - 2025-11-27

### Changed

- Reduced tool verbosity in main Slack messages (#65)
  - During execution: show tool labels (with → prefix), thinking, and text
  - After completion: replace main message with only final assistant response
  - Full audit trail preserved in thread (tool details, thinking, text)
  - Added promise queue to ensure message updates execute in correct order

## [0.10.0] - 2025-11-27

### Added

- Working memory system with MEMORY.md files
  - Global workspace memory (`workspace/MEMORY.md`) shared across all channels
  - Channel-specific memory (`workspace/<channel>/MEMORY.md`) for per-channel context
  - Automatic memory loading into system prompt on each request
  - Mom can update memory files to remember project details, preferences, and context
- ISO 8601 date field in log.jsonl for easy date-based grepping
  - Format: `"date":"2025-11-26T10:44:00.123Z"`
  - Enables queries like: `grep '"date":"2025-11-26' log.jsonl`
- Centralized logging system (`src/log.ts`)
  - Structured, colored console output (green for user messages, yellow for mom activity, dim for details)
  - Consistent format: `[HH:MM:SS] [context] message`
  - Type-safe logging functions for all event types
- Usage tracking and cost reporting
  - Tracks tokens (input, output, cache read, cache write) and costs per run
  - Displays summary at end of each agent run in console and Slack thread
  - Example: `💰 Usage: 12,543 in + 847 out (5,234 cache read, 127 cache write) = $0.0234`
- Working indicator in Slack messages
  - Channel messages show "..." while mom is processing
  - Automatically removed when work completes
- Improved stop command behavior
  - Separate "Stopping..." message that updates to "Stopped" when abort completes
  - Original working message continues to show tool results (including abort errors)
  - Clean separation between status and results

### Changed

- Enhanced system prompt with clearer directory structure and path examples
- Improved memory file path documentation to prevent confusion
- Message history format now includes ISO 8601 date for better searchability
- System prompt now includes log.jsonl format documentation with grep examples
- System prompt now includes current date and time for date-aware operations
- Added efficient log query patterns using jq to prevent context overflow
- System prompt emphasizes limiting NUMBER of messages (10-50), not truncating message text
- Log queries now show full message text and attachments for better context
- Fixed jq patterns to handle null/empty attachments with `(.attachments // [])`
- Recent messages in system prompt now formatted as TSV (43% token savings vs raw JSONL)
- Enhanced security documentation with prompt injection risk warnings and mitigations
- **Moved recent messages from system prompt to user message** for better prompt caching
  - System prompt is now mostly static (only changes when memory files change)
  - Enables Anthropic's prompt caching to work effectively
  - Significantly reduces costs on subsequent requests
- Switched from Claude Opus 4.5 to Claude Sonnet 4.5 (~40% cost reduction)
- Tool result display now extracts actual text instead of showing JSON wrapper
- Slack thread messages now show cleaner tool call formatting with duration and label
- All console logging centralized and removed from scattered locations
- Agent run now returns `{ stopReason }` instead of throwing exceptions
  - Clean handling of "aborted", "error", "stop", "length", "toolUse" cases
  - No more error-based control flow

### Fixed

- jq query patterns now properly handle messages without attachments (no more errors on empty arrays)

## [0.9.4] - 2025-11-26

### Added

- Initial release of Mom Slack bot
- Slack integration with @mentions and DMs
- Docker sandbox mode for isolated execution
- Bash tool with full shell access
- Read, write, edit file tools
- Attach tool for sharing files in Slack
- Thread-based tool details (clean main messages, verbose details in threads)
- Single accumulated message per agent run
- Stop command (`@mom stop`) to abort running tasks
- Persistent workspace per channel with scratchpad directory
- Streaming console output for monitoring
