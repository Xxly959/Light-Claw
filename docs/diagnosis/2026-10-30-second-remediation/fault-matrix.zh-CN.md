# 第二批故障矩阵（2026-10-30）

本矩阵对应最终 43 个逐项列出文件、364 项通过、4 项真实 Docker 用例跳过的本地运行。

| 环境 | 故障 | 实际结果 | 观察 |
|---|---|---|---|
| 锁 | 陈旧文件存在；活实例竞争 | 通过 | 旧文件可重新加锁，活实例期间第二次被拒绝；不删除 inode |
| 锁 | 持锁进程 SIGTERM | 通过 | 等待进程退出后新进程/调用可取得锁 |
| 锁 | 持锁进程 SIGKILL | 通过 | 无需 TTL/PID 抢占或人工删文件即可重新持锁 |
| 独立 mock 服务 + 真实 GoalStore | 操作开始前 SIGKILL | 通过 | 崩溃时外部效果 0；查询 absent 后同 ID 执行，最终效果 1、目标 completed |
| 独立 mock 服务 + 真实 GoalStore | 外部成功、本地进度未保存时 SIGKILL | 通过 | 服务已有 1 次效果；重启 query found，不重发；最终效果仍为 1 |
| 独立 mock 服务 + 真实 GoalStore | 状态保存后、通知前 SIGKILL | 通过 | 崩溃时 goal completed、通知缺失；重启复用同回执补测试通知，外部效果仍为 1 |
| 独立 mock 服务 + 持久 inbox | 排队时 SIGKILL | 通过 | 已接纳记录仍 queued，重启消费，最终效果 1 |
| 独立 mock 服务 + 真实 GoalStore | 外部成功后 SIGTERM | 通过 | 重启查询同 ID 收敛，外部效果仍为 1 |
| 本地真实文件/队列 | 拒绝、到期、磁盘接纳失败、容量缩小 | 通过 | 拒绝/到期不执行；持久失败不执行；已接纳 backlog 排空，重复完成消息不执行 |
| 真实 main + faux runner | 运行中断并同时存在 queued 跟进 | 通过 | unknown 频道的排队/新消息不间接续跑 active 目标，记录保留待人工核对 |
| 真实 main + faux runner/平台 | 异步准备/通知包装已超时期间关闭 | 通过 | 底层请求未结束时仍持锁；释放 gate 后关闭完成，未启动新 runner，新目标保持 active |
| 真实操作账本 + mock adapter | 未知回执及无法查询服务 | 通过 | unknown 查询后进入 manual；并发同 key 只执行一次；改变请求指纹被拒绝 |
| macOS 真实监督器 + docker CLI shim | 运行中取消 | 通过（离线） | 实际父/后台子进程停止写入，返回后 250ms 文件大小不变 |
| macOS 真实监督器 + docker CLI shim | 运行中超时 | 通过（离线） | 真实写入停止，检查文件大小稳定，不仅检查 Promise |
| macOS 真实监督器 + docker CLI shim | 宿主执行拥有者 SIGTERM | 通过（离线） | stdin/心跳失去后停止写入；等待 1.8s 后再观测 250ms 稳定 |
| macOS 真实监督器 + docker CLI shim | 宿主执行拥有者 SIGKILL | 通过（离线） | stdin/心跳失去后停止写入；等待 1.8s 后再观测 250ms 稳定 |
| 真实容器（含脱组/清除标记子进程） | 取消、超时、宿主 SIGTERM/SIGKILL 共 4 项 | 未执行 | Docker daemon 无法连接；Linux subreaper/pidfd 与真实容器停止效果未获本次实测 |

每一行的具体测试文件映射见 `fault-matrix.json`；完整命令和输出见 `regressions.log`。mock 服务是独立 loopback Python HTTP 进程，原子持久化 ID/回执；worker 使用真实 GoalStore、inbox 和 OperationJournal。通知补发是这个可查询 mock 流程的测试行为，真实平台未知通知仍为 unknown/manual。

Docker daemon 不可用，本批创建容器/网络/卷均为 0，没有操作业务容器。离线 shim 在 macOS 执行相同监督器，其进程组分支不能替代 Linux subreaper/pidfd 的证据。没有断电或生产验证。
