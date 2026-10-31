# 第一批整改验证记录（2026-10-29）

## 基线与范围

先读取根 AGENTS.md、/Users/x/.codex/RTK.md，保存 Git 状态和 4533 个既有非忽略文件 SHA-256；相关原文件快照在 `/tmp/lightclaw-batch1-20261029/before/`，完整基线在同目录 `baseline.json`。`git-status-before.txt` 保留初始暂存/未暂存状态。本批未提交、推送、发布；未修改冻结计划、控制器记录、历史 run.json、旧分析脚本或旧报告。

## 实际验证

主机 macOS，最终验证 Node v24.22.1、Vitest 3.2.4、宿主 Python 3。Node 24 路径通过验证进程 PATH 前置：`/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`。早期 Node 26 的 tsx loader 有 module.register 弃用警告；未屏蔽检查警告，也未降级依赖。tsx 在受限沙箱创建本地 IPC 管道报 EPERM，授权测试命令经提升运行；没有自动审批拒绝遗留事项。

### LightClaw 本包回归

cwd: `/Users/x/hermes-workspace/Light-Claw/packages/lightclaw`

```bash
rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-runner.test.ts test/attachment-upload.test.ts test/audit-redaction.test.ts test/benchmark.test.ts test/channel-queue.test.ts test/config.test.ts test/diagnosis-controls.test.ts test/diagnosis-statistics.test.ts test/eval-runner.test.ts test/eval-validation.test.ts test/evals.test.ts test/evaluation-seed.test.ts test/events.test.ts test/feature-runner.test.ts test/feishu.test.ts test/goal-acceptance.test.ts test/goal-artifact.test.ts test/goal-commands.test.ts test/goal-control.test.ts test/goal-migration.test.ts test/goal-terminal-delivery.test.ts test/goal-tool-discovery.test.ts test/goal-verification.test.ts test/goals.test.ts test/idle-cache.test.ts test/main-lifecycle.test.ts test/observability.test.ts test/offline-entry.test.ts test/optimizer-noise.test.ts test/output-tools.test.ts test/platform-notifications.test.ts test/presentation.test.ts test/prompt-optimization.test.ts test/queued-events.test.ts test/runner-lifecycle.test.ts test/sandbox.test.ts test/timeouts.test.ts
```

结果：37 个具体文件、341 项测试全部通过，0 失败、0 跳过。离线 setup 改变了所有文件的测试环境，因此逐个列出本包全部文件验证；未运行其他包测试替代。完整输出 `lightclaw-regressions.log`。日志中的平台超时、拒绝和损坏状态提示均由故障注入用例主动产生，并非验收失败。

核心新增/修改：`attachment-upload.test.ts` 42 项（两平台、越界/普通文件/大小/链接/确定性竞争）；`runner-lifecycle.test.ts` 33 项（保留原生命周期，增加 5 项路径拒绝及 4 项 host/Docker × Feishu/Slack 完整交付链）；`offline-entry.test.ts` 2 项；`diagnosis-statistics.test.ts` 4 项。

红灯证据：两平台在原实现中对临时虚构的工作区外绝对路径上传成功，预期拒绝的 2 项断言失败；原包 test 缺失导致入口断言 `undefined` 失败；从旧 analyze-live.py AST 提取原 metrics 并传入单一虚构 timeout=true/code=0/success=true 尝试，得到 successes=1、external_timeouts=1、n=1，互斥断言失败。修复后保留上述输入在定向回归中。

### 全仓代码检查

cwd: `/Users/x/hermes-workspace/Light-Claw`

```bash
rtk proxy npm run check
rtk proxy git diff --check
```

最终两项退出 0。check 完整输出 `check-final.log`，包括根 Biome、tsgo、browser smoke、web-ui/example Biome 和 tsc。未运行 npm test、npm run build、npm run dev。

首轮 check 发现 Feishu 废弃 readFileSync import，已手动删除；第二轮发现测试 mock 对象的私有字段交叉类型归约为 never，改为显式公共 uploadFile 夹具返回类型。第三轮及最终 check 通过。检查器首轮只改 `checker-changes.json` 中的 7 个本批文件，逐项比较确认仅导入顺序、格式和等价箭头函数；第三轮仅格式化夹具类型，最终仅格式化新增完整链测试。没有修改无关既有源码。

### CI 入口

解析根 package.json、LightClaw package.json 和 CI YAML：根 workspaces 包含 packages/*；根 test 为 npm run test --workspaces --if-present；包 test 为 tsx ../../node_modules/vitest/dist/cli.js --run；CI 有无条件、无 continue-on-error 的 npm run test --workspace lightclaw 步骤；Node 矩阵为 22.19.0 和 22；结果在 `ci-discovery.json`。测试使用隔离 HOME/认证目录，移除继承凭证变量，Node TCP/fetch 被拒绝。新增 setup-python 3.12 提供附件读取与离线统计所需的标准库解释器。

这是本地入口解析和实际本包回归证据，未触发远端 Actions，也未在 Linux/Node 22 上执行。CI 显式步骤与原根 workspace 测试会重复执行本包；保留原 CI 其他包流程，未为消除重复扩大改动。

### 历史统计

```bash
rtk proxy python3 docs/diagnosis/2026-10-21/analyze-live-v2.py
rtk proxy python3 docs/diagnosis/2026-10-21/analyze-live-v2.py --check
```

首次生成退出 0。审查修正 terminal_priority 字段命名为 terminal_states 后，使用 `--output-dir` 生成临时新副本，只替换本批新建的 v2 输出；最终 --check 退出 0、逐字节一致。脚本默认拒绝覆盖已有输出。正式计划/启动证据/控制器均 1008；完整记录 938，缺失 70；互斥成功 513、任务失败 422、超时 73。ordinary 为成功 39/108、超时 69/108，不再把 ordinary-0034 的 timeout 与 success 双计。无新模型请求。

新输出：`../2026-10-21/report.v2.zh-CN.md`、`live-summary.v2.json`、`live-attempts.v2.jsonl`、`live-inputs.v2.json`。后者保存输入和分析器 SHA-256；记录级检查与成功标记一致，冻结源码哈希全部成立。未重新执行语义评分；未恢复不存在的逐进程 PID 启动日志；缺失用量与货币费用仍未知。

## 独立审查与限制

按执行技能进行了只读独立审查；未发现阻断问题，1 项机器可读优先级字段命名问题已修正并重新生成/验证 v2 文件。未调用平台 API、真实模型或读取敏感文件作为攻击夹具。附件验证使用真实临时文件系统与 mock SDK；Docker 路径验证使用 faux runner，不是容器或生产交付验证。

安全读取新增宿主 Python 3.9+ / POSIX 依赖（Linux/macOS；本次仅实测 macOS），20 MiB 上限、10 秒读取时限；失去依赖时失败关闭。配置根及其祖先、宿主解释器与应用安装需可信，host shell 的任意文件系统权限未由本批隔离。跨频道/共享附件现在明确拒绝，可先将授权内容放入本频道。没有性能/成本收益实测，不作此类改善声明。


最终完整性核对：3374 个已纳入起点基线的历史诊断文件 SHA-256 均未改变；基线中 4533 个文件未发生删除；暂存状态与起点一致。`change-manifest.json` 区分本批修改/新增，`source-delta.patch` 是相对本轮起点的源代码/配置/文档差异，而非混有既有工作的 HEAD 差异。工程记录本身被 Git 忽略，因此其旧哈希由本次追加边界之前的原前缀重建，清单明确标注这一方法；未冒充起点时保存的快照。
