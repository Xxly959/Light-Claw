# 单实例恢复与受控副作用

LightClaw 仍是单实例个人 Agent。控制目录中的状态只由持有同一内核锁的实例写入；没有租约、多节点调度或分布式事务。

## 进程锁和关闭

`goals/control.ts` 打开稳定的 `instance.lock` 文件，以继承给宿主 Python 的 fd 3 调用非阻塞 `flock`。Python 与 Node 共享同一 open-file-description；辅助进程退出后，Node 的描述符继续持锁。Node 正常退出、SIGKILL 或崩溃时，内核关闭描述符并释放锁。锁文件保留在磁盘上，文件存在不再表示实例存活，不根据文件时间、PID 或超时删除它。

宿主需要 POSIX 和 Python 3.9+。控制目录、祖先目录及解释器必须可信，锁文件禁止符号链接和多硬链接。文件系统必须正确支持本地 flock；网络文件系统未验证。升级前停止所有旧版实例，旧版的 `wx` 文件令牌不参与新内核锁，不能混跑。

SIGINT/SIGTERM 的正常关闭顺序：停止接纳和事件 watcher，关闭待执行内存队列（持久 queued 项保留），取消全部当前 runner，等待队列、已进入处理函数的请求及底层平台请求收敛（包装超时不算底层已结束），关闭缓存，再释放锁。异步命令准备返回后仍检查 stopping，不会在取消扫描后启动新 runner。Docker 任务退出无法确认时，正常关闭失败并保留锁等待人工检查；强制 SIGKILL 属于崩溃路径。

## 持久接纳与消费

控制目录下 `.inbox/<sha256>.json` 保存来源、频道、原消息/事件、来源 ID、请求指纹、排队截止时间、执行尝试数及状态。ID 来自平台种类、origin、频道和消息 ts；同 ID 不同内容拒绝。文件用私有临时文件、文件 fsync、rename 和目录 fsync 写入，成功后才返回任务已接纳。平台 ACK 与业务任务完成是不同层次；容量拒绝会保存 rejected 并发送未接纳通知。持久写失败不会调用执行函数；飞书会把失败抛回 SDK，Slack 不会执行后续 ACK 语句。平台重投策略和真实消息交付未在本批连接平台验证。

| 状态 | 重启行为 |
|---|---|
| queued | 截止未到则按频道恢复；保留原截止时间；内存容量缩小时从持久 backlog 继续消费 |
| running | 改为 unknown，保留执行窗口与原消息，不自动重试 |
| completed | 已消费，重复消息不再执行；这不是任务质量成功标记，目标/审计另有结果 |
| rejected | 未接纳、不自动重试，保留决定 |
| expired | 尚未开始且已到期、不执行、不自动重试 |
| unknown | 副作用不确定，阻止同频道后续排队项及目标自动续跑，等待人工核对 |
| dead | 执行尝试上限（默认 3）或显式死信，保留记录并阻止不经核对的续跑 |

没有自动无限重试。正式入口为真实平台用户发送 `/recover list`、`/recover show <id>`，核对后使用 `/recover resolve <id> <revision> <说明>` 标记已处理且不重放，或 `/recover retry <id> <revision> ACK_DUPLICATE_RISK <说明>` 明确承担重复风险重试。处置在持有内核锁的当前实例内执行，要求身份、频道空闲、状态版本及审计通过；其他未决记录仍阻断频道。手工重试额外授权一次执行，保留累计 attempts。不得手改 JSON，也不能通过另一个进程绕过运行实例锁。过期/拒绝项重复投递不会重置决定。

启动时先恢复历史记录，再接收平台事件；平台启动期间的新消息只落盘不派发，准备好后与历史 queued 项一起消费。未知频道的后续消息可以落盘，但不绕过隔离开始执行。`/recover capacity` 查询容量；`/recover maintain` 仅归档 completed/rejected/expired 为gzip并保留去重摘要。默认归档720小时、归档后去重168小时；期满后相同旧事件可能作为新任务接纳。未决状态不普通清理；索引在单实例内加载并更新。

一次性与 immediate 事件的 ID 固定为文件名及有效载荷的摘要，重启前后相同；只有 `durableAdmission=true` 的接纳成功后才删除源文件。内存接纳或拒绝均保留源文件。启动前创建的 immediate 会尝试持久接纳。one-shot 仅在可配迟到窗口内补执行，默认300000ms；历史过期转死信，不静默重放。若要再次创建内容相同的新事件，应使用新文件名/新的 at。无效事件保留在 `events/dead-letter/`。周期事件按每次触发产生独立记录；本批不实现停机期间所有错过周期的补发。

## 目标恢复与重复窗口

仅 active 目标可在无未知任务隔离时自动恢复；paused、awaiting_confirmation、completed、cancelled 保持原状态。普通消息恢复不会擅自恢复暂停或待人工确认的目标。若某次执行已改变外部系统，但在目标进度/本地结果提交前崩溃，重跑相同自然语言任务可能重复操作。新的 inbox 把已开始执行的中断任务隔离为 unknown，旧版本没有 inbox 的 active 目标仍保留原有至少一次恢复窗口。旧版消息日志不等于消费账本，首次升级时平台重投的历史消息也无法由新 inbox 证明已完成，需人工核对；本批不伪造历史接纳记录。

任意 bash（包括 curl、邮件、数据库写入、其他脚本）无法通用查询结果或保证幂等，不能承诺 exactly-once。人工恢复必须检查实际系统结果；提示词中的“不重复”不构成工程保证。模型或脚本自己换一个业务步骤键也不能保持同一操作身份。

## 受控操作账本

`operations.ts` 的 `OperationJournal.execute(scope, key, request, service)` 将稳定业务 scope/step key 派生为 operation ID，并固定请求指纹，保存 prepared → started → succeeded。失败/丢失回执为 unknown；再次执行相同 ID 时先调用服务 `query(id)`：

- found：保存同一回执，不再执行副作用。
- absent 且 adapter 明确声明 `replaySafe=true`：以同 ID 重发。该声明要求服务端对并发、在途和重试原子去重，单靠“先查再发”不够。
- unknown、查询失败或服务不支持安全重发：保存 manual，不自动发第二次。`resolveManually(id, independentlyVerifiedResult)` 可记录人工确认结果。

记录在 `.operations/`；正式入口为 `/recover operations|op-show|op-resolve|op-retry`。核对需ID和revision，重试还需ACK_DUPLICATE_RISK及说明；旧无owner记录仅管理员可处置。通知补发明确提示可能重复，不重新执行Agent任务。一个实例对每个控制目录使用一个 journal；不要绕过实例锁并发创建写者。adapter 必须自行实现请求期限、认证和结果查询契约。真实主入口的最终通知通过同一账本；目前 Feishu/Slack 通知 adapter 不能按此 ID 独立查询，故 `replaySafe=false`，不把不确定的通知自动重发。流式回复、任意平台 API、bash 和所有既有工具并未因此获得统一的副作用幂等保证。

故障测试的独立 loopback mock 服务按 operation ID 原子保存副作用和回执，支持查询；真实 GoalStore 与操作账本在独立工作进程中执行，在操作前、服务成功但进度未保存、目标完成但通知未发时终止进程，再启动查询/收敛。它是明确选定 adapter 的工程证据，不是所有业务系统的事务证明。

## Docker 取消

`DockerExecutor` 将每次执行标为 UUID，在容器内启动 Python 监督器及独立进程组。宿主 Node 直接写 stdin 心跳；宿主消失、EOF、取消标记或期限到达都会触发停止。取消请求通过独立 docker exec 创建持久取消 tombstone；与启动使用同一文件锁，避免取消已确认后延迟启动任务。

Linux 监督器使用 subreaper 让双重 fork / setsid 的孤儿后代归属自身，通过 `/proc` 的祖先关系及任务标记发现成员，使用进程出生标识和 pidfd 安全终止；清理不单独信任可能复用的 PGID。所有已识别任务成员退出后才返回 STOPPED，宿主才报告取消完成。正常 shell 退出后也会清理后台子进程。独立监督器消失而任务退出无法证明时返回未确认，主入口正常关闭不释放锁。

Docker 需要容器内 Python 3.9+、Linux subreaper 与 pidfd 支持；当前 Dockerfile 原本安装 Python，本批没有构建或修改业务容器。运行元数据与取消 tombstone 位于容器 `/tmp/lightclaw-exec/<uuid>`，保留用于诊断，不自动复用 UUID。它保护本次执行树；任务主动向另一个服务/其他容器派发工作、利用更高权限逃逸或破坏监督器/其元数据的行为不能获得同样保证。该机制不把任意 bash 变为事务。

历史批次曾因 Docker daemon 不可用只运行macOS shim，不能视为Linux验证。2026-11-01已有真实Docker验收；2026-11-05当前源码再次运行任务隔离+实际Agent/faux读写2项及Linux容器监督器cancel/timeout/SIGTERM/SIGKILL4项，全部通过，日志在 `docs/diagnosis/2026-11-05-completion/docker-final.log`。macOS shim仍不能单独证明Linux专用能力。`test/docker-live.test.ts` 保留 4 项显式启用的真实容器测试，包含脱组且清除标记的子进程；仅创建 `lightclaw-batch2-*`、带唯一标签的资源，清理前再次校验标签，镜像只用本地已有镜像（`--pull=never`）。启用方法和实际缺口见本批验证报告。

## 持久性边界

本批验证的是进程退出、SIGTERM、SIGKILL 和原子文件状态恢复。新 journal 的 fsync/rename 增强本地提交顺序，GoalStore 仍沿用既有原子 rename；未做断电、磁盘损坏、NFS、主机内核崩溃或生产平台测试。不以进程崩溃测试宣称断电后不丢数据。

## 审批归档与评测控制器恢复

审批活动历史满额无需手改JSON：使用`/approve maintain`归档终态/过期票据，`/approve show <id>`核对历史。有效pending/approved和其他未决恢复状态不普通清理。身份、实例锁、空闲频道、文件事务与意图/结果审计均须通过；审计瞬时失败也不能当作普通命令失败吞掉。归档先持久发布，再更新活动文件，中断保留双份并以活动记录优先。

离线评测`--mode=resume --out=<已有目录>`保留原freeze、共享预算startedAt、已花费/未知预留，不重新执行已有任务目录。全局账本丢失必须停止核对，不能重置额度；新输出实验仍不得覆盖旧结果。具体命令与限额文件格式见部署说明。
