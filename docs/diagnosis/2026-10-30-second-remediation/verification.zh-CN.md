# 第二批整改验证记录（2026-10-30）

## 起点与实际实现

先读取 AGENTS.md、引用的 /Users/x/.codex/RTK.md 和 Git 状态。起点 4552 个文件（含被忽略的工程记录）哈希与相关文件快照保存在 `/tmp/lightclaw-batch2-20261030/`；起点 Git 状态在 `git-status-before.txt`。第一批 change-manifest 中全部交付文件当时匹配；实际包 test、CI 步骤和 v2 统计入口均在，并实际执行 v2 --check 通过。保留既有大量改动，未以 HEAD 大差异认领本批成果。

实现路径：goals/control.ts 内核锁；durable-state.ts/durable-inbox.ts 持久接纳；queued-events.ts/channel-queue.ts/idle-cache.ts 持久 backlog 与关闭；main.ts/platform adapters 接纳、恢复、受控最终通知和关闭；operations.ts 稳定 ID/结果查询；sandbox.ts/docker-supervisor.py 容器执行树取消；events.ts 一次性事件只在持久接纳后删源。Python 监督器列入 package.json 发布文件。完整恢复契约见 `packages/lightclaw/docs/recovery.zh-CN.md`。

## 实际命令与结果

最终测试环境：macOS，Node v24.22.1（通过 PATH 前置 `/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`），Vitest 3.2.4，宿主 Python 3.14.6。CI 的 Node 22/Linux 组合未在本批远端执行。

cwd `/Users/x/hermes-workspace/Light-Claw/packages/lightclaw`：

```bash
rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-runner.test.ts test/attachment-upload.test.ts test/audit-redaction.test.ts test/benchmark.test.ts test/channel-queue.test.ts test/config.test.ts test/diagnosis-controls.test.ts test/diagnosis-statistics.test.ts test/docker-cancellation.test.ts test/docker-live.test.ts test/durable-admission.test.ts test/durable-work.test.ts test/eval-runner.test.ts test/eval-validation.test.ts test/evals.test.ts test/evaluation-seed.test.ts test/events.test.ts test/feature-runner.test.ts test/feishu.test.ts test/goal-acceptance.test.ts test/goal-artifact.test.ts test/goal-commands.test.ts test/goal-control.test.ts test/goal-migration.test.ts test/goal-terminal-delivery.test.ts test/goal-tool-discovery.test.ts test/goal-verification.test.ts test/goals.test.ts test/idle-cache.test.ts test/instance-lock.test.ts test/main-lifecycle.test.ts test/observability.test.ts test/offline-entry.test.ts test/optimizer-noise.test.ts test/output-tools.test.ts test/platform-notifications.test.ts test/presentation.test.ts test/prompt-optimization.test.ts test/queued-events.test.ts test/recovery-faults.test.ts test/runner-lifecycle.test.ts test/sandbox.test.ts test/timeouts.test.ts
```

最终：42 文件通过、1 文件跳过；364 项通过、4 项跳过、0 失败，退出 0。完整输出 `regressions.log`。只选择本批新建/修改和受主入口/执行器/队列直接影响的 LightClaw 文件，没有运行其他包测试替代。第一批附件 42 项回归也在本包运行中通过。

cwd `/Users/x/hermes-workspace/Light-Claw`：

```bash
rtk proxy npm run check
rtk proxy python3 docs/diagnosis/2026-10-21/analyze-live-v2.py --check
rtk proxy git diff --check
```

均退出 0。`check-final.log` 保留根 Biome、tsgo、browser smoke、web-ui/example Biome 与 tsc 的完整输出。Python 源文件另用 compile() 只读检查语法成功，没有创建 bytecode 文件。未运行 npm test、npm run build、npm run dev，没有提交、推送、发布或调用真实平台/付费模型。

初轮 kernel lock 回归 3 项在旧实现失败，修复后通过；独立审查发现 durable Slack mention stop 条件错误，先新增回归观察失败再修复。主入口补充 unknown+queued 跟进隔离和 shutdown 异步准备竞态，后又加强“包装已超时但原始平台请求未结束仍持锁”的 80ms 时序。mock 故障矩阵从普通保存文件进一步改用真实 GoalStore；夹具初次缺少 acceptance、随后手动模式误带 files/commands，按实际 GoalAcceptance 类型修正为 mode=manual；没有删除/放宽生产校验。

检查器首轮格式化 20 个本批文件；第二轮格式化 14 个并发现上述夹具类型错误；修复后通过。对检查前快照重放相同 Biome 规则，并用 TypeScript AST 比较（只归一化 import 排序与无语义括号）核对格式变化，清单 `checker-review.json`。最后增加底层请求等待后，check 格式化 main.ts 和主入口回归两文件；完整 diff 已人工检查，只有缩进/换行，类型与全仓检查均通过。旧 goal-control 的 2 项文件令牌语义测试由新的 3 项真实进程内核锁测试替代；其余控制路径测试保留。

## Docker 与清理

实际执行 `rtk proxy docker info --format '{{.ServerVersion}}'`：沙箱先拒绝 socket 访问，提升后明确返回无法连接 Docker daemon。未自行启动 Docker、拉取镜像、构建镜像或操作现有容器。

离线测试通过 fake docker 仅把本批 supervisor 原样放到独立本地 Python 进程执行，验证父/子写文件停止，覆盖 cancel、timeout、宿主 SIGTERM、SIGKILL。真实容器 4 项默认跳过，不记通过。可在 Docker 可用且本地已有含 Python 镜像时单独运行：

```bash
LIGHTCLAW_DOCKER_FAULT_TESTS=1 rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run test/docker-live.test.ts
```

该命令本次未执行。默认镜像 `lightclaw-sandbox:local`，可设置 LIGHTCLAW_DOCKER_TEST_IMAGE；仅使用 --pull=never 创建本批唯一名称/标签、禁网、只读根目录、受限资源容器。afterEach 只清理返回 ID 且标签匹配的资源。Linux subreaper/pidfd、脱组并清除环境标识的子进程场景仍待真实容器实测。

本批实际 Docker 资源创建数 0。`cleanup.json` 保存清理结果：工作进程/mock 服务均在 afterEach 终止并等待，夹具目录移除，监督器写入已停止；只读进程清单按本批标识筛选未发现残留，不导出其他命令行。全部业务容器未触碰。

## 恢复与幂等边界

内核 flock 随拥有描述符的 Node 进程退出释放，文件不删除、不依赖超时抢占；旧版升级须先停旧实例。正常关闭停止接纳，保留 queued 项并取消/等待本地工作及底层平台请求；Docker 终止未确认则保留锁。强制 SIGKILL 与正常收敛不是同一承诺。

active 可恢复，但频道存在 unknown/dead 时阻止排队跟进和目标自动续跑；paused、awaiting_confirmation 和终态不擅自改变。持久 queued 保留原截止，拒绝/到期不自动重试，未知执行需人工核对；最多 3 次执行尝试，死信与诊断保留。

受控服务只有在原子 ID 去重/查询契约下支持安全重发；本批 mock adapter 实测覆盖关键窗口。任意 bash、所有既有平台调用与流式回复不统一获得此保证。真实平台最终通知无法独立查询结果时为 unknown/manual，可能需要人工补发。文件 fsync/rename 不等于已验证断电持久性；本批没有断电、NFS、磁盘损坏或生产测试。长期历史记录清理和停机期间周期事件全部补发未扩建。


最终完整性核对：4552 个起点文件无删除；3386 个历史诊断与第一批交付文件哈希不变，v2 --check 通过；初始暂存状态完全一致，工程记录只追加。相对本批起点共修改18个既有文件、新增13个源/测试/文档文件（证据目录另列），清单与源差异分别在 change-manifest.json、source-delta.patch。最终43文件运行后再次只读检查本批标识，残留进程为0，cleanup.json已更新。
