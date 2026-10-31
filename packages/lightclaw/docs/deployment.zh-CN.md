# 个人单实例部署与本地发行材料

适用范围：单一所有者或同一信任域、一个工作目录对应一个 Agent 实例。Node 进程负责平台连接、调度、持久控制和模型调用；`--sandbox=docker:<名称>` 只把工具执行放入已有 Docker 容器，不会把 Node Agent 本身容器化。host 模式中的工具具有 Node 进程的宿主权限。

## 发行状态与入口

要求 Node >=22.19.0；目标机器还需 Python 3（附件读取与 POSIX 控制锁）；Docker 工具模式还需可用 Docker CLI/daemon 和满足启动校验的容器。源码启动依赖 `tsx` 和本 monorepo 的依赖，不能把工作区 node_modules 链接当作干净安装证明。

`package.json` 声明库入口 `dist/index.js`、类型 `dist/index.d.ts`，对应的真实源码入口为 `src/index.ts`，导出配置、运行时创建、存储和平台契约；导入入口不启动平台。CLI 入口包括 `dist/main.js`、benchmark、eval、prompt-optimize、goal-migrate。Python 辅助脚本必须随包保留在 `src/` 下。

本批未执行编译、生命周期、发布或真实凭证操作。仓库已有 dist 是历史产物，不能证明当前源码可发行。缺失 dist 时，源码清单验收通过仍不构成编译包验收通过。`npm pack --ignore-scripts` 仅证明文件选择和归档行为；忽略脚本不会补齐缺失入口。

## 准备与核验源码材料

以下命令从仓库根执行，使用原生 Node，无平台连接、模型调用、依赖安装或转译：

```sh
rtk node packages/lightclaw/scripts/local-release.mjs --help
rtk node packages/lightclaw/scripts/local-release.mjs prepare --output /tmp/lightclaw-source-review
rtk node packages/lightclaw/scripts/local-release.mjs verify /tmp/lightclaw-source-review
rtk node packages/lightclaw/scripts/local-release.mjs verify-dist /tmp/lightclaw-source-review/packages/lightclaw
```

输出必须是新的仓库外目录。`prepare` 从 git tracked 和未忽略 untracked 文件取当前字节，写显式 `source-manifest.json`，逐文件记来源类别、字节数和 SHA-256。范围限定为根依赖/编译元数据及 lightclaw、ai、agent、coding-agent、tui 的源码、脚本、文档、测试、评估和包元数据；不复制 dist、node_modules、隐藏文件或运行工作目录；遇到范围内符号链接（含悬空链接）直接拒绝。`verify` 不依赖原仓库，核对缺失、篡改、多余文件与符号链接。清单只提供完整性检查，不提供签名或恶意源码审计。

这是便于审查和离线转移的源码材料，不是可执行生产发行物。清单包含本地未跟踪源码，分享前必须人工逐项审查，不自动公开。评估器、测试与 blind oracle 保留在包的独立目录，禁止复制到 Agent 工作目录。原工作目录及控制目录也不进入发行材料。

编译发行须在获准编译的独立阶段产生全新 dist，完成依赖闭包、Python 资产、bin 执行位和平台启动检查，再从干净目录安装并执行命令。`verify-dist` 只检查声明的 main/types/bin 文件存在且无符号链接；即使通过，也不证明源码新鲜度、依赖闭包或程序可运行。

## 配置与首次启动

把凭证交给进程管理器的受限环境文件或秘密管理机制，不写入仓库、发行材料、聊天或日志。选择一个平台：

| 配置 | 用途 |
| --- | --- |
| `LIGHTCLAW_TRANSPORT=feishu` | 默认平台；需要 `LIGHTCLAW_FEISHU_APP_ID`、`LIGHTCLAW_FEISHU_APP_SECRET` |
| `LIGHTCLAW_TRANSPORT=slack` | 需要 `LIGHTCLAW_SLACK_APP_TOKEN`、`LIGHTCLAW_SLACK_BOT_TOKEN` |
| `LIGHTCLAW_MODEL_PROVIDER`、`LIGHTCLAW_MODEL_ID` | 默认 `zai` / `glm-5.3-flash`；模型凭证按所选 pi provider 配置 |
| `OPENAI_BASE_URL` | 可选自定义兼容端点；端点可用性需单独检查 |
| `LIGHTCLAW_CONTROL_DIR` | 持久控制目录，必须在工作目录外；不可通过 Docker 挂载暴露 |
| `LIGHTCLAW_RUN_MAX_DURATION_MS`、`LIGHTCLAW_RUN_MAX_TOOL_CALLS`、`LIGHTCLAW_RUN_MAX_TOKENS` | 默认 300000ms、100 次工具、100000 tokens 的单轮上限 |
| `LIGHTCLAW_QUEUE_MAX_PENDING`、`LIGHTCLAW_QUEUE_MAX_WAIT_MS` | 默认每频道 5 条、300000ms；不是全进程磁盘或付费硬预算 |

完整默认值以 `src/config.ts` 与资源治理文档为准。关闭 Feishu feature 会强制 Slack 路径，部署前应检查实际配置。用独立 OS 账户和绝对路径，固定 Node 版本、工作目录和控制目录。已验收编译发行下的示例形态是 `lightclaw --sandbox=host /绝对路径/工作目录`；Docker 形态为 `lightclaw --sandbox=docker:容器名 /绝对路径/工作目录`。当前源码材料尚未达到该编译发行前提。

Docker 启动校验会检查容器配置与控制目录隔离；实际非 root 身份、挂载与资源限制仍需在目标机器验收。容器须常驻，不能假定 Agent 会创建或修复容器。Node 自身仍能访问平台与模型网络。

## 本地健康、停止与重启

从已获准的源码环境，或未来已验收的编译发行执行 `lightclaw --help`，应无需凭证退出。`lightclaw --health=/绝对路径/工作目录 --control=/绝对路径/控制目录` 仅检查本机持久控制锁；它不连接平台、不证明模型服务或消息投递可用，也不能替代日志与端到端平台验收。锁被占用只证明内核锁持有，不证明该持有者就是健康 Agent；未加锁状态不证明所有旧子进程均已终止。返回码和 JSON 字段见命令帮助。

停止时向 Node 进程发送 SIGTERM（或前台 Ctrl-C），等待关闭收敛并核对退出状态；原生平台请求或工具退出未确认时可能持续等待。不要用删锁文件来强行重启。关闭失败会保留锁并保持进程存活等待检查，不能把进程还在当作平台可用。遇到工具 Docker 任务终止未确认，先检查容器内任务与日志，再决定恢复。进程管理器应设置足够停止宽限时间并避免在旧进程未退出时循环拉起。

重启前检查工作目录与控制目录路径未改变；确认旧 Node 和工具任务均退出，再启动相同实例。重复平台消息以 durable inbox 做幂等恢复；这不是跨工作目录、多实例或跨平台的 exactly-once 保证。恢复与定时事件策略应结合故障排查和平台回归证据阅读。

## 备份与恢复

1. 停止接纳并等待 Node 正常关闭，确认所有工具任务已收敛；运行中的文件拷贝不保证一致快照。
2. 同时备份工作目录及工作区外的控制目录，保留权限与目录结构。控制目录中的 inbox、操作记录、goal state 与接纳记录是恢复所需状态，不能按普通日志删除。另行保存受控配置引用，凭证通过原秘密管理机制恢复。
3. 校验备份完整性和目标磁盘容量；把备份保存到同一信任边界内。不要把它并入 npm 包、源码材料或公开诊断报告。
4. 在隔离目录离线试恢复，检查状态记录可读，再恢复到固定绝对路径。默认控制目录由工作目录的物理路径推导；迁移路径时应显式配置恢复后的控制目录，不能仅移动工作目录。
5. 确认原实例完全停止后再切换。不要同时运行原目录和副本。锁 inode 文件本身的存在不是活跃证据；应使用本机锁探测并人工核对旧进程，禁止直接删除锁绕过保护。

本批只验证临时文件、模拟平台与本地命令；真实平台收发、网络重连、付费模型、生产恢复、真实 Docker 和全新编译安装均待部署环境验收。

编译评测入口另有仓库源码/tsx和Python资产定位假设，当前未通过干净dist执行验证；第三批reliability完整流程按源码checkout运行。不能将源码下faux回归通过当作全部npm bin可安装运行。正式发行闸门除main/types/bin存在，还必须逐个执行这些命令及资产依赖测试。
