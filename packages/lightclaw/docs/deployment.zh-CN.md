# 个人单实例部署与本地发行材料

适用范围：单一所有者或同一信任域、一个工作目录对应一个 Agent 实例。Node 进程负责平台连接、调度、持久控制和模型调用；`--sandbox=docker:<名称>` 只把工具执行放入已有 Docker 容器，不会把 Node Agent 本身容器化。host 模式中的工具具有 Node 进程的宿主权限。

## 发行状态与入口

要求 Node >=22.19.0；目标机器还需 Python 3（附件读取与 POSIX 控制锁）；Docker 工具模式还需可用 Docker CLI/daemon 和满足启动校验的容器。源码启动依赖 `tsx` 和本 monorepo 的依赖，不能把工作区 node_modules 链接当作干净安装证明。

`package.json` 声明库入口 `dist/index.js`、类型 `dist/index.d.ts`，对应的真实源码入口为 `src/index.ts`，导出配置、运行时创建、存储和平台契约；导入入口不启动平台。CLI 入口包括 `dist/main.js`、benchmark、eval、prompt-optimize、goal-migrate。Python 辅助脚本在获准构建后复制到 `dist/` 根，与编译代码使用相邻相对路径；源码运行使用同目录的 `.py`。新增 `lightclaw-audit` 取证入口。

2026-11-05用户明确授权仅在隔离副本构建五包并验证本地安装；已完成macOS/Node 22.23.0新鲜dist、离线干净安装、六CLI输出及编译后faux验收，见[公开交付报告](../../../docs/verification/2026-11-05/delivery.zh-CN.md)。未提交、推送、发布或执行真实平台/模型请求。共享仓库已有dist仍是历史产物，不作为本轮证据。其他操作系统、Node版本和真实平台上线尚未验收。`npm pack --ignore-scripts` 仅证明文件选择和归档行为；忽略脚本不会补齐缺失入口。

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

从已获准的源码环境，或未来已验收的编译发行执行 `lightclaw --help`，应无需凭证退出。`lightclaw --health=/绝对路径/工作目录 --control=/绝对路径/控制目录` 分别报告内核锁、进程存活、运行时心跳就绪与SDK连接状态；探测自身不连接平台，SDK connected也不证明端到端消息或模型服务可用，也不能替代日志与端到端平台验收。锁被占用只证明内核锁持有，不证明该持有者就是健康 Agent；未加锁状态不证明所有旧子进程均已终止。返回码和 JSON 字段见命令帮助。

停止时向 Node 进程发送 SIGTERM（或前台 Ctrl-C），等待关闭收敛并核对退出状态；原生平台请求或工具退出未确认时可能持续等待。不要用删锁文件来强行重启。关闭失败会保留锁并保持进程存活等待检查，不能把进程还在当作平台可用。遇到工具 Docker 任务终止未确认，先检查容器内任务与日志，再决定恢复。进程管理器应设置足够停止宽限时间并避免在旧进程未退出时循环拉起。

重启前检查工作目录与控制目录路径未改变；确认旧 Node 和工具任务均退出，再启动相同实例。重复平台消息以 durable inbox 做幂等恢复；这不是跨工作目录、多实例或跨平台的 exactly-once 保证。恢复与定时事件策略应结合故障排查和平台回归证据阅读。

## 备份与恢复

1. 停止接纳并等待 Node 正常关闭，确认所有工具任务已收敛；运行中的文件拷贝不保证一致快照。
2. 同时备份工作目录及工作区外的控制目录，保留权限与目录结构。控制目录中的 inbox、操作记录、goal state 与接纳记录是恢复所需状态，不能按普通日志删除。另行保存受控配置引用，凭证通过原秘密管理机制恢复。
3. 校验备份完整性和目标磁盘容量；把备份保存到同一信任边界内。不要把它并入 npm 包、源码材料或公开诊断报告。
4. 在隔离目录离线试恢复，检查状态记录可读，再恢复到固定绝对路径。默认控制目录由工作目录的物理路径推导；迁移路径时应显式配置恢复后的控制目录，不能仅移动工作目录。
5. 确认原实例完全停止后再切换。不要同时运行原目录和副本。锁 inode 文件本身的存在不是活跃证据；应使用本机锁探测并人工核对旧进程，禁止直接删除锁绕过保护。

本批只验证临时文件、模拟平台与本地命令；真实平台收发、网络重连、付费模型、生产恢复、真实 Docker 和全新编译安装均待部署环境验收。

编译评测入口已准备相邻worker.js、Python脚本及安装包资产哈希路径，源码运行才解析tsx；本轮已通过独立安装的原生Node入口执行100次faux任务验证，不依赖源码、tsx或monorepo布局。不能将源码下faux回归通过当作全部npm bin可安装运行。正式发行闸门除main/types/bin存在，还必须逐个执行这些命令及资产依赖测试。


## 2026-11-05 新增操作入口与边界

- 人工完成申请必须传 `deliverables: {kind:"files",paths:["scratch/report.txt"]}`，或者 `{kind:"none",reason:"仅交付解释"}`；路径为频道相对路径，evidence是描述，不作路径解析。确认绑定hash/bytes/device/inode/mtimeNs/ctimeNs；文件变化或超期都要重新申请。`LIGHTCLAW_GOAL_CONFIRMATION_TTL_MS` 默认1800000。
- `/approve` 默认30分钟有效，过期不占待审额度；名单启用时仅可信用户或管理员批准执行，创建者身份本身不能绕过。管理员恢复长期目标及审批续跑保留原请求者的信任。定时事件不凭`EVENT`身份自动获得可信权限；需要危险操作的个人定时任务应配置有权审批的管理员。
- `/recover list`、`/recover show <ID>`显示本频道未决inbox；`/recover resolve <ID> <version> <核对说明>`不重放；`/recover retry <ID> <version> ACK_DUPLICATE_RISK <说明>`显式重试。`/recover operations`、`op-show`、`op-resolve`、`op-retry`针对通知操作账本；补发是明确标注可能重复的状态通知，不重新执行整个Agent任务。旧无owner操作仅管理员可核对。频道运行时不能处置，其他未决记录继续保护。
- `/recover capacity`、`/recover maintain`提供容量状态与终态维护。默认活动记录上限10000，80%预警状态；归档保留720小时，去重摘要保留168小时，可配`LIGHTCLAW_INBOX_MAX_RECORDS`、`LIGHTCLAW_INBOX_ARCHIVE_RETENTION_HOURS`、`LIGHTCLAW_INBOX_DEDUPE_HOURS`。归档后在去重期限内不会重新执行旧投递；期限后不提供永久去重。未决记录不清理。
- 权威审计在外置控制目录`.audit/`，包含runs/tool-calls/spans及payloads；CLI沿用`lightclaw-audit <工作目录>`，自定义控制目录部署的查询进程须注入同一`LIGHTCLAW_CONTROL_DIR`。诊断可best-effort，关键审计失败会阻断工具/取消run，不保证不可变审计。`LIGHTCLAW_AUDIT_MAX_BYTES`默认16MiB、`LIGHTCLAW_AUDIT_RETENTION_HOURS`默认24、`LIGHTCLAW_AUDIT_SEGMENT_MAX_BYTES`默认1MiB；只清理过期轮转段/payload，活动日志不按mtime删掉。恢复状态无普通日志清理策略。
- 飞书支持text/post文本、file和image入站；file/image先持久接纳资源描述，下载并安全落盘后才交给Agent。默认单文件20MiB、单目录256MiB、下载30秒；对应ATTACHMENT_FILE_MAX_BYTES/ATTACHMENT_MAX_BYTES/DOWNLOAD_TIMEOUT_MS。unsupported显式反馈；下载失败返回未交给Agent处理。群内仍须@bot。附件中的指令不构成授权。
- 健康JSON的`healthy`要求内核锁、活进程、新鲜ready心跳与SDK connected同时成立；10秒心跳、30秒过期。CLI返回0表示探测执行成功，监控应读JSON的healthy/runtime/platform，不能仅看退出码或lock。模型始终标为未验证。RuntimeOptions.onFault可接本地/自有告警适配器，默认只写本地审计，本轮未接外部告警。
- one-shot默认最多迟到300000ms补执行一次，超出窗口进入events/dead-letter；`LIGHTCLAW_SCHEDULE_MISFIRE_MAX_LATENESS_MS`可配。periodic不补停机错过的历史tick，只恢复下一次执行；远期one-shot分段计时，不因Node定时器溢出提前运行。

## 可重复的安装与备份验证

以下只准备/检查，不构建：

```sh
rtk proxy node packages/lightclaw/scripts/verify-install.mjs plan
rtk proxy python3 -I packages/lightclaw/scripts/state-backup.py --help
rtk proxy node packages/lightclaw/scripts/acceptance-plan.mjs platform
rtk proxy node packages/lightclaw/scripts/acceptance-plan.mjs model
```

`verify-install.mjs verify --root <全新源码副本> --out <新目录> --cache <完整离线npm缓存>`先检查五个包的dist新鲜度、入口和Python脚本一致性，缺失/陈旧直接失败；然后只`npm pack --ignore-scripts`、在全新HOME/安装目录中`npm install --offline --ignore-scripts --no-audit --no-fund`，安装本轮五个本地包，执行库导入、逐CLI帮助和离线数据审计并保留完整日志。无完整依赖缓存时明确失败。本轮授权后已完成独立安装并保留五个tgz、1224个编译文件摘要、逐步日志；另在全新目录使用同一lockfile离线npm ci重放。缓存首次缺失ENOTCACHED记录保留；以空HOME/独立空npm配置只从公共注册表准备依赖后，再离线安装。帮助检查要求实际文本，拒绝静默零退出。此证据仅为本地构建安装验收。

`state-backup.py backup --workspace <工作目录> --control <控制目录> --out <新备份>`必须取得同一内核锁；`verify --backup <目录>`核对哈希与清单；`restore --backup <目录> --workspace <新工作目录> --control <新控制目录>`禁止覆盖现存目录，并核验同宿主源实例锁。备份包含工作区及恢复控制状态，排除`.env*`、auth.json、私钥和运行锁/心跳，拒绝链接。恢复后必须显式设置新控制目录。跨主机转移须先停止原宿主，不提供跨机器租约。脚本只在虚构临时数据上验证过，未读取实际运行目录或凭证。

### 本轮已获授权的隔离构建步骤

AGENTS.md默认仍禁止npm run build。用户本轮明确答复“允许上述五包构建和安装验证”，只授权在隔离副本运行以下五条命令，已执行通过；实际产物为五包dist/声明/Python资产、本地tgz和干净安装日志。未修改AGENTS.md。该次构建授权不包含npm发布；用户随后另行授权GitHub提交和推送。未来构建仍应按当次授权范围处理。

```sh
rtk proxy npm run build --workspace=@mariozechner/pi-tui
rtk proxy npm run build --workspace=@mariozechner/pi-ai
rtk proxy npm run build --workspace=@mariozechner/pi-agent-core
rtk proxy npm run build --workspace=@mariozechner/pi-coding-agent
rtk proxy npm run build --workspace=lightclaw
```

### 外部验收授权准备

`acceptance-plan.mjs`只生成可审阅计划，不发消息也不调用模型。平台必须补平台名、专用应用、显式凭证注入、专用会话/参与者、允许发送/编辑/撤回/上传数量及断网/改权限许可；计划内列出逐项测试和按receipt清理步骤。模型提案为安装目录已列出的openai/gpt-4.1-mini，36个合成任务、每组2次重复、166次任务尝试，加2次候选生成；请求上限1330、Token1000000、费用5美元、墙钟60分钟，预计30–60分钟仅为计划。真实可用性和计费价格未验证，执行前还须冻结价格/输出上限与精确任务清单。预算硬停可能留下未完成项，所有失败/缺失必须报告。blind保持锁定，完成selection并冻结单一candidate/hash和额外授权后才可执行。未获批准不得运行付费或真实平台流程。

## 飞书提示词优化卡片

专用应用验收需订阅`card.action.trigger`（当前安装SDK的RawCardActionEvent，context.open_chat_id/open_message_id及operator.open_id），保持原有消息权限。文本默认按原文处理；普通平台文本可显示可选按钮，不会启动候选请求。点击后至多2次无工具模型请求，按当前配置主模型/provider解析凭证；每次最多1536输出Token，整个优化受LIGHTCLAW_MODEL_ATTEMPT_TIMEOUT_MS默认120000ms约束。该交互不是预算批准的付费实验；实验仍须另行授权。

外置控制目录`.prompt-inputs/`绑定原文、发送者、频道、卡片ID、30分钟期限与offered/running/done/failed状态。卡片转发关闭；服务端仍验证身份和卡片绑定。重复点击、过期、重启后running不自动重新请求，重新发送输入才可新建申请。返回模型评审分数、理由与排序，包含原文基线；该分数不证明真实任务质量。推荐不会自动注入、提升权限或改变后续输入。优化可取消、停机时发abort；超时/未知用量不按零记录。状态受保护容量约束，满额可使可选卡片不可用，普通原文任务仍继续；未实现提示词状态永久无限保留或自动清理未决请求。

## 审批历史维护（2026-11-05 续补）

审批活动文件上限仍为200条，达到上限时明确提示`/approve maintain`。命令在当前持有内核锁的实例内执行，要求频道空闲并写意图/结果审计；名单启用时仅可信用户/管理员可维护，个人无名单时要求活动历史属于同一创建者且由其操作，多创建者混合历史需要管理员。有效pending/approved不归档；consumed/denied及过期票据先写SHA-256命名的持久归档，再压缩活动列表。若归档后中断、两处记录共存，活动记录优先，重复维护复用同一归档，不恢复旧批准。

归档保留在控制频道的`approval-archives/`，参与保护状态容量限制，不自动按诊断保留期删除。`/approve show <id>`查询归档状态、原请求者、创建者、批准者和到期时间。`/approve list`仅展示最多20条过期历史并提示更多；新票据ID为32位hex，旧8位ID只用于原有票据核对。历史不无限增长保证，保护状态满额仍明确失败，不擅自删除取证。

## 跨worker评测预算（2026-11-05 续补）

`Freeze.budget.campaign`冻结全实验请求、Token、费用微美元、墙钟和每请求预留上限。每个实际faux流请求（含压缩）先从全局及attempt账本预留，再派发；已知终态结算，崩溃/未知保留预留，数据损坏拒绝。并发锁仅对EEXIST有界等待，不猜测/抢占残留锁。每步账本有自己的原子提交；部分预留失败可保守多占额度，不会退款为零冒险继续。预算不足停止派发并保留not_started分母。已在途请求不自动重试，墙钟跨停机累计。

示例仅为已授权faux离线准备，不能打开真实模型；`limits.json`必须仅含`requests,tokens,costMicros,wallMs,tokensPerRequest,costMicrosPerRequest`六个正安全整数，每请求上限不得超过总额：

```sh
rtk proxy npx tsx packages/lightclaw/src/evals/cli.ts --suite=reliability --mode=budget --budget=/绝对路径/实验控制/shared-budget.json --limits=/绝对路径/limits.json
rtk proxy npx tsx packages/lightclaw/src/evals/cli.ts --suite=reliability --mode=offline --out=/全新输出/A --axis=A --budget=/绝对路径/实验控制/shared-budget.json --limits=/绝对路径/limits.json
rtk proxy npx tsx packages/lightclaw/src/evals/cli.ts --suite=reliability --mode=offline --out=/全新输出/B --axis=B --budget=/绝对路径/实验控制/shared-budget.json --limits=/绝对路径/limits.json
rtk proxy npx tsx packages/lightclaw/src/evals/cli.ts --suite=reliability --mode=resume --out=/已有输出/A
```

共享账本必须先显式初始化；init拒绝覆盖已有额度，resume拒绝限额变化/账本丢失/源码变化。控制器使用独立内核锁，resume仅执行从未建过任务目录的项，已启动/半写记录留给人工核对，不能自动重放。报告显示全局snapshot和每attempt ledger，缺失/不可读不伪报零。保护账本路径不能进入worker/task目录。默认非共享模式会在新输出根创建全局账本，默认限额按冻结任务数计算；A/B要累计必须显式共用同一文件和同一limits。

这批仍只启用faux worker，Token/费用来源必须按synthetic与未知标记；真实provider计价、模型选择、预算批准及Docker逐任务真实模型执行尚未验收。全局组件离线接线完成不等于可以运行付费实验。
