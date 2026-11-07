# 2026-11-06 验证命令

Node v22.22.2；PATH=/Users/x/.workbuddy/binaries/node/versions/22.22.2-6/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin。

## 包根工程回归

工作目录 /Users/x/Light-Claw/packages/lightclaw。

```sh
rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-runner.test.ts test/approval-authority.test.ts test/approval-lifecycle.test.ts test/attachment-upload.test.ts test/audit-integrity.test.ts test/audit-query.test.ts test/audit-redaction.test.ts test/audit-routing.test.ts test/backup-restore.test.ts test/channel-isolation.test.ts test/channel-queue.test.ts test/config.test.ts test/context-prompt.test.ts test/deployment-entry.test.ts test/diagnosis-controls.test.ts test/docker-cancellation.test.ts test/docker-validation.test.ts test/durable-admission.test.ts test/durable-work.test.ts test/event-boundaries.test.ts test/events.test.ts test/feature-runner.test.ts test/feishu-callback-wire.test.ts test/feishu.test.ts test/gateway-model.test.ts test/goal-acceptance.test.ts test/goal-artifact.test.ts test/goal-commands.test.ts test/goal-control.test.ts test/goal-migration.test.ts test/goal-terminal-delivery.test.ts test/goal-tool-discovery.test.ts test/goal-verification.test.ts test/goals.test.ts test/health-readiness.test.ts test/http-transport.test.ts test/idle-cache.test.ts test/inbox-lifecycle.test.ts test/install-preflight.test.ts test/instance-lock.test.ts test/isolation-report-verification.test.ts test/main-lifecycle.test.ts test/manual-completion-binding.test.ts test/model-fallback.test.ts test/model-http-trace.test.ts test/observability.test.ts test/offline-entry.test.ts test/output-tools.test.ts test/packaging.test.ts test/platform-contract.test.ts test/platform-notifications.test.ts test/platform-preflight.test.ts test/platform-text.test.ts test/policy-core.test.ts test/presentation.test.ts test/product-scope.test.ts test/prompt-card.test.ts test/prompt-redesign.test.ts test/queued-events.test.ts test/recovery-control.test.ts test/recovery-faults.test.ts test/resource-policy.test.ts test/runner-lifecycle.test.ts test/runtime-goal-loop.test.ts test/sandbox.test.ts test/timeouts.test.ts --silent
rtk proxy env LIGHTCLAW_DOCKER_FAULT_TESTS=1 npx tsx ../../node_modules/vitest/dist/cli.js --run test/docker-live.test.ts test/release-readiness.test.ts --silent
```

## 隔离构建

工作目录 /Users/x/.pi/lightclaw/releases/20261106-final/source。第三方依赖复用现有node_modules，5个工作区包指向隔离副本；产物仅写副本。

```sh
rtk proxy npm run build --workspace=packages/tui
rtk proxy npm run build --workspace=packages/ai
rtk proxy npm run build --workspace=packages/agent
rtk proxy npm run build --workspace=packages/coding-agent
rtk proxy npm run build --workspace=packages/lightclaw
```

## 独立安装

```sh
rtk proxy node packages/lightclaw/scripts/verify-install.mjs verify --root /Users/x/.pi/lightclaw/releases/20261106-final/source --out /Users/x/.pi/lightclaw/releases/20261106-final/independent-verified --cache /Users/x/.pi/lightclaw/releases/20261106-final/public-npm-cache
```

公开npm依赖缓存使用干净HOME/npmrc及registry.npmjs.org预备；正式验证离线且禁用lifecycle脚本，未读取真实auth或平台/模型凭证。初次原缓存ENOTCACHED失败保留independent/05.log。

## 安装产物功能验证

```sh
rtk proxy node docs/verification/2026-11-06-final-acceptance/installed-tools.mjs
rtk proxy node docs/verification/2026-11-06-final-acceptance/live-installed.mjs
rtk proxy npm run check
rtk proxy git diff --check
```

live脚本有持久防重放收据，重复运行应拒绝；不应为重跑删除收据。验收外发仅用户授权的当前私聊，未调用WS start，不改生产状态。
