# 实际验证命令与结果

当前运行目录为 packages/lightclaw，Node v24.22.1、Python 3.14.6。没有运行 npm test、npm run build/dev，没有提交、推送、发布、真实模型或真实平台请求。PATH 显式选择了本机现有运行时；不要求该缓存路径在其他机器存在，可使用满足版本的 Node。

共享 runtime/AgentRunner 提取影响接纳、队列、恢复、验收、投递与旧评测路径，因此最后按明确清单运行本包 47 个直接相关文件（不是其他包的替代证据）：

```sh
rtk proxy env PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin LIGHTCLAW_DOCKER_FAULT_TESTS=0 npx tsx ../../node_modules/vitest/dist/cli.js --run test/instance-lock.test.ts test/queued-events.test.ts test/reliability-statistics.test.ts test/durable-admission.test.ts test/evals.test.ts test/goal-acceptance.test.ts test/feature-runner.test.ts test/offline-entry.test.ts test/eval-runner.test.ts test/docker-cancellation.test.ts test/evaluation-seed.test.ts test/config.test.ts test/goal-artifact.test.ts test/benchmark.test.ts test/feishu.test.ts test/diagnosis-statistics.test.ts test/goal-commands.test.ts test/platform-notifications.test.ts test/presentation.test.ts test/idle-cache.test.ts test/agent-runner.test.ts test/diagnosis-controls.test.ts test/goal-terminal-delivery.test.ts test/runtime-evaluation.test.ts test/recovery-faults.test.ts test/prompt-optimization.test.ts test/channel-queue.test.ts test/goal-verification.test.ts test/reliability-controller.test.ts test/reliability-system.test.ts test/eval-validation.test.ts test/optimizer-noise.test.ts test/goal-migration.test.ts test/timeouts.test.ts test/output-tools.test.ts test/goal-control.test.ts test/goals.test.ts test/docker-live.test.ts test/main-lifecycle.test.ts test/runner-lifecycle.test.ts test/events.test.ts test/audit-redaction.test.ts test/sandbox.test.ts test/goal-tool-discovery.test.ts test/observability.test.ts test/durable-work.test.ts test/attachment-upload.test.ts > /tmp/lightclaw-batch3-20261030/regressions-final.log 2>&1
```

结果：46 文件通过、1 文件跳过；390 passed、4 skipped、0 failed。真实 Docker 4 项显式关闭；docker-cancellation 的 Python 监督器与虚构 Docker CLI 回归仍执行，不能称真实容器验证。完整输出 logs/regressions-final.log。

新增四文件和修改的 offline-entry 已全部运行。review-red.log 的四个失败断言复现三项独立审查问题：压缩前提前完成、遗漏最终投递、截断 observation/JSONL。review-green-2.log 为修复后的 24/24；中间一次括号语法错误日志也保留。cli-default-red/green 记录默认入口先依赖 Docker、改为数据审计后通过。统计初始失败及修复日志完整保留，不删除失败尝试。

最终冻结复跑：

```sh
rtk proxy env PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin npx tsx src/evals/cli.ts --suite=reliability --mode=offline --axis=A --splits=development,selection --repetitions=2 --out=/tmp/lightclaw-batch3-20261030/final-A > /tmp/lightclaw-batch3-20261030/final-A-command.log 2>&1
rtk proxy env PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin npx tsx src/evals/cli.ts --suite=reliability --mode=offline --axis=B --splits=development,selection --repetitions=2 --out=/tmp/lightclaw-batch3-20261030/final-B > /tmp/lightclaw-batch3-20261030/final-B-command.log 2>&1
rtk proxy env PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin npx tsx src/evals/cli.ts --suite=reliability --mode=analyze --out=/tmp/lightclaw-batch3-20261030/final-A > /tmp/lightclaw-batch3-20261030/analyze-A.log 2>&1
rtk proxy env PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin npx tsx src/evals/cli.ts --suite=reliability --mode=analyze --out=/tmp/lightclaw-batch3-20261030/final-B > /tmp/lightclaw-batch3-20261030/analyze-B.log 2>&1
```

A/B 各 25 个开发/选择任务 × 两臂 × 两次=100 尝试；各100派发/OS启动/worker进入/控制器/完整记录。两份重统计与原报告 JSON 深比较完全相同；290 个源/数据/依赖文件 hash 在 A/B 相同。blind 11 个未执行。

根目录命令：

```sh
rtk proxy env PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin npm run check > /tmp/lightclaw-batch3-20261030/check-final.log 2>&1
rtk proxy python3 docs/diagnosis/2026-10-21/analyze-live-v2.py --check
rtk proxy git diff --check
```

均退出0；完整 check 输出已逐轮保留（check-1 至 check-6、check-final）。最终根 Biome723文件、tsgo、browser smoke、web-ui73及example3文件通过，无 fixes。第一轮19个自动格式修改按原始差异重建，逐文件 AST（忽略 import 排序/格式括号）相同，formatting-review.json；后续格式变更仅本批新文件及本批已修改文件，经源审查/完整回归，最终无自动修改。未将其他既有脏文件“恢复”或覆盖。

原始 worker 记录保存在 offline-A/B/raw-workers.tar.gz；解压到相应输出目录恢复 runs/ 后，可直接使用 analyze 模式（须当前冻结哈希匹配）。报告和 JSONL 原文件保持不变。frozen-sources.tar.gz 是控制器侧源快照，含 protected 答案，不得挂进 Agent 沙箱。中间旧源码版本管线试跑仍留在 /tmp/lightclaw-batch3-20261030/offline-A，不计最终证据，不冒充新模型实验。
