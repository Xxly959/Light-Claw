# 第四批实际验证与精确复现

本地测试 Node v24.22.1；原生清单工具还使用系统 Node v22.23.0。测试均从 packages/lightclaw 执行，所有SDK/faux/文件为离线/虚构，真实Docker明确关闭。主入口、适配器、存储、执行器改动影响本包全链路，因此明确列出54个直接相关文件：

```sh
rtk proxy env PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin LIGHTCLAW_DOCKER_FAULT_TESTS=0 npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-runner.test.ts test/attachment-upload.test.ts test/audit-redaction.test.ts test/benchmark.test.ts test/channel-queue.test.ts test/config.test.ts test/deployment-entry.test.ts test/diagnosis-controls.test.ts test/diagnosis-statistics.test.ts test/docker-cancellation.test.ts test/docker-live.test.ts test/docker-validation.test.ts test/durable-admission.test.ts test/durable-work.test.ts test/eval-runner.test.ts test/eval-validation.test.ts test/evals.test.ts test/evaluation-seed.test.ts test/event-boundaries.test.ts test/events.test.ts test/feature-runner.test.ts test/feishu.test.ts test/goal-acceptance.test.ts test/goal-artifact.test.ts test/goal-commands.test.ts test/goal-control.test.ts test/goal-migration.test.ts test/goal-terminal-delivery.test.ts test/goal-tool-discovery.test.ts test/goal-verification.test.ts test/goals.test.ts test/idle-cache.test.ts test/instance-lock.test.ts test/main-lifecycle.test.ts test/observability.test.ts test/offline-entry.test.ts test/optimizer-noise.test.ts test/output-tools.test.ts test/packaging.test.ts test/platform-contract.test.ts test/platform-notifications.test.ts test/platform-text.test.ts test/presentation.test.ts test/prompt-optimization.test.ts test/queued-events.test.ts test/recovery-faults.test.ts test/reliability-controller.test.ts test/reliability-statistics.test.ts test/reliability-system.test.ts test/resource-policy.test.ts test/runner-lifecycle.test.ts test/runtime-evaluation.test.ts test/sandbox.test.ts test/timeouts.test.ts
```

最终 regressions-final.log：53文件通过/1跳过，485 passed/4 skipped/0失败。4项为真实Docker opt-in测试，未访问daemon或业务容器。此前regressions-1.log两处失败是旧测试依赖默认last_prompt和把诊断失败当业务失败，现显式debug诊断仍可用、可选诊断失败不致任务失败；恢复所需权威写入失败仍必须传播。更新测试后整包通过，保留全部失败日志。

根目录：

```sh
rtk proxy env PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin npm run check > /tmp/lightclaw-batch4-20261031/check-final.log 2>&1
rtk proxy git diff --check
rtk proxy python3 docs/diagnosis/2026-10-21/analyze-live-v2.py --check
rtk proxy node packages/lightclaw/scripts/local-release.mjs prepare --output /tmp/lightclaw-batch4-20261031/final-source
rtk proxy node packages/lightclaw/scripts/local-release.mjs verify /tmp/lightclaw-batch4-20261031/final-source
```

check-final退出0：根Biome738文件无fix，tsgo/browser-smoke，web-ui73/example3全部通过。初轮自动格式11文件、后续3/2文件，均为本批触及文件；逐项before/final差异保留于source-diffs.tar.gz（包含经回归验证的人工审查修复，不能全当formatter变更），checker-review-files列明。未修改其他包源码来掩盖类型问题。最终无自动修改。

最终source688文件：578 tracked、110 untracked，SHA逐文件核验，无源码/依赖软链接。清单不是签名，也不是源码无秘密证明；不扫描真实凭证。final-source.tar.gz包含评估器blind资产，只能控制器侧审查，不能挂载到Agent工作区。元数据、原脚本、完整日志均留档。

最终本地pack（从 final-source/packages/lightclaw 执行）：

```sh
rtk proxy env -i PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin npm pack --offline --ignore-scripts --userconfig=/tmp/lightclaw-batch4-20261031/empty-user.npmrc --globalconfig=/tmp/lightclaw-batch4-20261031/empty-global.npmrc --cache=/tmp/lightclaw-batch4-20261031/deploy/npm-cache --json --pack-destination /tmp/lightclaw-batch4-20261031/final-package
```

两份npmrc为本批创建的空文件；临时cache为既有package缓存副本，未修改用户cache；完全offline、无lifecycle。结果：18文件、48894字节、无dist。不可执行运行时的包被明确命名lightclaw-0.70.6-unverified.tgz，不能发布。全新目录 final-install 中执行：

```sh
rtk proxy env -i PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin npm install --offline --ignore-scripts --no-audit --no-fund --package-lock=false --omit=dev --userconfig=/tmp/lightclaw-batch4-20261031/empty-user.npmrc --globalconfig=/tmp/lightclaw-batch4-20261031/empty-global.npmrc --cache=/tmp/lightclaw-batch4-20261031/deploy/npm-cache /tmp/lightclaw-batch4-20261031/final-package/lightclaw-0.70.6.tgz
```

退出1，ENOTCACHED @anthropic-ai/sandbox-runtime；没有在线重试。全新安全解压目录中的原生工具--help退出0，但verify-dist退出1/NOT VERIFIED（main/types/bin缺失）。这不构成Agent bin安装成功或依赖闭包验收。未运行build/dev/npm test，也未用tsc/转译绕过构建禁令。

源码CLI无凭证入口由deployment-entry.test.ts用独立HOME实际子进程执行：--help退出0；--health=<临时workspace> --control=<临时control>区分held/free，平台/模型始终unverified。固定假docker脚本报含虚构secret错误，启动日志不输出原文。--download历史导出保留；附件helper另命名避免覆盖。

资源清理：SDK mock与watcher/队列由测试afterEach关闭，临时测试工作目录由各测试清理；全部最终测试控制器正常退出。未创建真实Docker容器/卷/镜像或生产服务，也没有执行全机容器清理。/tmp/lightclaw-batch4-20261031保留基线、原始日志、最终/中间源码材料和临时npm缓存以便复核；这些是有意留档，不宣称已删除所有临时文件。没有跨业务资源操作、真实消息或模型调用。
