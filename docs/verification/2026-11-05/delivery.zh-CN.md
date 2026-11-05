# LightClaw 续做交付（2026-11-05）

本轮接续前一份[四阶段交付报告](stage-report.zh-CN.md)，以本报告更新全局预算、审批维护及授权后本地发行验证的状态。保持单实例、同一信任域；仅在用户授权的仓库外副本构建五包，未提交、推送、发布，未接真实平台、读取真实凭证或调用付费模型。飞书“提示词优化”默认直通/点击才优化的行为保留。

## 1. 全实验预算和安全恢复

**原问题**：账本仅接单个attempt，不限制多个worker、重复运行、A/B轴的累计请求与费用；控制器缺少安全resume，账本丢失时构造器会重新初始化，可能重置额度。

**实现**：

- `src/evals/reliability/{budget-ledger,controller,fixture-runner,worker,protocol,types,cli}.ts`：冻结`budget.campaign`，实际faux流请求（含compaction）先取得共享全局与attempt两个持久预留，再派发；每步终态结算。失败、崩溃或未知用量保留预留，不填零。锁竞争仅对EEXIST有界等待，不抢残留锁；额度/损坏/非锁故障直接拒绝。
- `--mode=budget --budget=<全新文件> --limits=<六字段限额文件>`只初始化faux预算，拒绝覆盖已有文件；`--budget`允许A/B、重复或候选共用同一账本，默认每个新输出根建立该轴全局账本。跨轴累计必须显式共用同一路径/同一限额。
- `--mode=resume --out=<既有输出>`复核freeze、源码、限额和内核锁，保留startedAt、已花费与未知预留。只运行从未建立过任务目录的项目；已有目录/半写记录不自动重放，保留缺失/失败分母。丢失账本拒绝resume，报告标missing/unavailable而非零；变更limits在接触实验前拒绝。
- `parseBudgetLimits`拒绝多余字段、非正安全整数、每请求预留高于总额。保留candidate_generation/selection/task标签及未计量humanMinutes=null。损坏的reserved记录不能伪造已结算小用量来降低预留。
- 控制器在不足时停止派发，保留not_started和全部已启动记录，实际worker外部期限受剩余全局墙钟约束。两个账本独立提交；一处预留成功另一处失败可保守多占额度，不冒险退款重放。

**回归**：`test/reliability-budgets.test.ts`（7项）、`test/reliability-controller.test.ts`（16项）、`test/reliability-full-flow.test.ts`（完整流程）已运行。覆盖跨worker只有1次请求额度、控制器恢复不重置、不重放既有目录、A/B共用已耗尽账本、未知候选生成预留保留、限额变更、账本丢失、初始化拒绝覆盖、锁竞争及损坏预留。新增失败用例均先复现红灯，再修复；完整流程另核验两轴共用账本。

**边界**：实际生产编排仍是faux worker，真实模型入口未启用。真实provider计价与每请求保守价格/Token上界需在模型和预算获批后核实；离线全局接线不等于付费计价或账单硬上限已实测。模拟生成步骤不是实际候选模型生成；已生成/选择成本的账本标签和全部预留均保留，不把未运行步骤算零收益。残留事务锁须停机核对，不自动猜测过期；网络文件系统和断电未测。

## 2. 审批历史正式维护

**原问题**：200条历史上限会阻断新申请，只有停机手工维护建议；没有可审计归档入口。

**实现**：

- `src/policy/{approvals,commands}.ts`：新增`/approve maintain`与`/approve show <id>`。有效pending/approved不归档；consumed/denied及过期票据先发布SHA-256命名的持久归档，再更新活动列表。归档可查询，不恢复旧批准、不再次消费；归档中断留下双份时活动状态优先，重复维护复用同一份归档。
- 维护要求平台身份；名单启用时仅可信用户/管理员，个人无名单时同一创建者可维护，混合创建者历史需管理员。runtime要求持有实例锁、频道空闲，存储还有审批文件事务锁，意图/结果都写关键审计。
- `src/runtime.ts`、`src/observability.ts`：增加approval_maintenance审计；关键命令审计的瞬时失败不能被普通命令异常处理吞掉，传播到durable队列核对。
- 归档位于保护控制频道`approval-archives/`，受状态容量约束，不随诊断日志清理。活动上限200保留，但满额提示正式维护命令；列表仅展示20条过期历史并提示更多，按ID可查询历史。新票据128-bit ID避免长期历史中短随机ID的碰撞风险；原有8位票据仍可核对。
- 普通create/consume/pending仅读活动文件；完整历史读取放在显式查询/维护，避免每次工具调用扫描归档。持久写改为现有fsync+rename+目录fsync工具，没有删除历史或减少审批功能。

**回归**：`test/approval-lifecycle.test.ts`从6项增加至10项，覆盖200条历史归档后新申请、有效批准保留、身份限制、归档中断、意图审计失败不修改、结果审计失败后核对与幂等维护。`test/main-lifecycle.test.ts`新增瞬时维护审计失败传播，先得到Promise被吞的红灯，再修复；审批权限/策略/主入口/平台契约一起回归。

**边界**：不是无限存储；归档配额满时明确失败，不自动删除取证。归档摘要校验用于发现内容变化，不构成对可信宿主同UID的不可篡改保证。磁盘故障为quota/链接/锁及审计失败注入，未进行实际磁盘耗尽或断电实验。

## 3. 新鲜dist与独立安装闭环

用户明确回复“允许上述五包构建和安装验证”，已覆盖本轮隔离副本的build禁令；AGENTS.md默认规则未改。副本为`${RELEASE_CHECK}/source`，共享工作区dist没有作为本轮发行证据。

### 实际修复

| 问题、根因 | 影响文件及结果 | 针对性回归 |
|---|---|---|
| 无关未跟踪诊断资产使Git枚举超过子进程缓冲 | scripts/local-release.mjs在枚举时限制发行白名单，不先收集全仓库再过滤；保留清单和链接拒绝 | packaging：5200个无关长文件名 |
| npm拒绝user/global共用/dev/null | scripts/verify-install.mjs创建两个不同0600空配置，隔离HOME；只公共缓存准备，正式安装离线且禁生命周期脚本 | install-preflight：原生npm配置探测 |
| 公共catalog遗漏整个已知provider使五包编译失败 | packages/ai/scripts/generate-models.ts保留该provider既有快照并明确价格/可用性未刷新；未删除kimi-coding功能或降级类型 | release-readiness：mock三个公共catalog后保留provider |
| 安装包冻结依赖时CommonJS resolve不支持ESM-only exports | src/evals/reliability/protocol.ts使用import.meta.resolve，不依赖tsx或源码目录 | release-readiness：临时安装布局与ESM-only依赖 |
| benchmark经npm bin链接启动时静默退出 | src/benchmark/cli.ts比较真实入口路径；verify-install要求实际帮助文本，不能只看exit=0 | release-readiness：真实bin符号链接启动 |
| macOS系统临时目录别名被严格控制路径拒绝 | 仅规范化benchmark自己创建的临时根，工作区与外置控制状态同属该根，finally一并清理；控制路径禁止链接规则未放宽 | release-readiness：别名TMPDIR真实执行3任务并检查清理 |
| 负载下故障注入先于被测provider启动 | fixture-runner.ts的s06等待实际provider就绪再使pending过期；docker-cancellation测试等待父/子真实写入再检验停止后无增长 | reliability-controller、docker-cancellation；原失败日志保留 |

### 构建、安装与原生执行

五条准确构建命令（仅在上述副本根执行）：

```sh
rtk proxy npm run build --workspace=@mariozechner/pi-tui
rtk proxy npm run build --workspace=@mariozechner/pi-ai
rtk proxy npm run build --workspace=@mariozechner/pi-agent-core
rtk proxy npm run build --workspace=@mariozechner/pi-coding-agent
rtk proxy npm run build --workspace=lightclaw
```

前四包完整成功输出为`build-final-pi-*.log`；LightClaw在发现原生入口问题后单独重建，最终为`build-lightclaw-native-final.log`。五包生成JS/声明，LightClaw包含三个Python助手。AI构建获取公共模型元数据，隔离副本中models.generated.ts更新，与共享仓库原始快照有差异；不是推理调用，也不证明实时价格/模型可用性。差异与构建失败记录全部保留。

最终安装命令和绝对路径见`clean-install-native-final.log`：`rtk proxy node packages/lightclaw/scripts/verify-install.mjs verify --root <隔离副本> --out <新安装目录> --cache <专用公共缓存>`。脚本打包5个tgz、检查1224个编译文件摘要、离线安装249个依赖，执行库导入、六CLI实际帮助及离线评测资产审计。Node为22.23.0/darwin；没有tsx、内部五包均在新node_modules内，无monorepo链接。完整各步日志在`release-locations.json`所指安装目录00–13.log。

同一lockfile在另一全新目录执行`rtk proxy npm ci --offline --ignore-scripts --no-audit --no-fund`，核对哈希和六CLI输出。原生消费方NodeNext严格声明检查已通过（skipLibCheck=true，不代表依赖声明全部检查）；实际编译后的可靠性入口与benchmark任务也已运行，最终证据索引见`final-release-evidence.json`。benchmark为1频道、1热身、2正式轮、每轮1任务的小功能检查，没有做性能前后对照，不声称提速。

首次缓存ENOTCACHED、npm重复配置、catalog类型错误、ESM解析失败、bin空输出、临时目录链接错误及无效benchmark参数的退出记录均保留；没有把这些失败删出记录。公共缓存准备使用空HOME、独立空npm配置、--ignore-scripts/--no-audit/--no-fund，未搜索实际凭证。上游node-domexception弃用提示保留。

## 4. 最终验证和证据层级

- `check-native-final.log`：根目录`rtk proxy npm run check`完整输出，exit=0，无残余错误/警告/info，格式化1个本轮测试；没有修改其他基线工作。另一次在faux写账本时并发执行的check遇到Biome遍历临时锁消失的内部诊断，虽exit=0仍保留为非最终证据；最终check在无运行写入时通过。
- `regression-native-final.log`：64个具体受影响测试文件，637项通过；完整命令见本日志。包含所有修改测试及共享runtime/agent/平台/安全回归。包根执行，未运行npm test。
- `full-flow-native-final.log`：最终源码完整faux A/B矩阵200次attempt；25个development/selection任务×2臂×2重复×2轴。每轴80 completed、20 task_failed，失败场景保留，不是全部任务成功。具体源/资产哈希核对、共享预算和缺失计数见`final-release-evidence.json`。blind未运行；候选为人工布线占位，不能推出候选语义收益。
- `docker-final.log`：2文件6项真实Docker通过，实际Agent/faux读写、隐藏资产不挂载，Linux监督器cancel/timeout/SIGTERM/SIGKILL。之后发行修复未改Docker执行/挂载源码；不是声称全部200次矩阵均在Docker内。本轮没有镜像build/pull。2026-11-01真实Docker历史已单独核实，不能自动证明本轮源码通过。
- 编译安装：原生Node22.23.0、五tgz、全新离线安装/同锁重装/库入口/六CLI/Python资产；编译后100次faux矩阵和benchmark实际工作。Vitest/tsx入口日志曾显示Node26及DEP0205弃用提示，均保留；最终源码冻结矩阵和原生安装矩阵记录均为Node22.23.0。各入口以实际日志/冻结版本为准。
- 真实Feishu/Slack：未运行。已有实际adapter+mock SDK+生产runtime+faux契约，覆盖收发、附件、重复、重连、权限、429、审批续跑、通知失败、身份和按钮，但不能证明真实权限、卡片展示及回调。
- 真实模型：未运行，未付费。合成用量不是账单Token；报告cost=null/pricesKnown=false，未知人力仍为null。独立预算账本的faux零成本预留计数不能解释为真实实验零费用。没有成功率、降本、提速或语义效果声明。

准确测试命令从`packages/lightclaw`执行，完整64文件命令见`test-commands.txt`及最终回归日志；本轮另外执行：

```sh
rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run test/release-readiness.test.ts test/install-preflight.test.ts test/packaging.test.ts
rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run test/release-readiness.test.ts test/benchmark.test.ts
rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run test/reliability-full-flow.test.ts
rtk proxy env LIGHTCLAW_DOCKER_EVAL_TESTS=1 LIGHTCLAW_DOCKER_FAULT_TESTS=1 npx tsx ../../node_modules/vitest/dist/cli.js --run test/reliability-docker-isolation.test.ts test/docker-live.test.ts
```

备份恢复脚本已用虚构状态验证；没有操作实际运行目录。真实断电、磁盘耗尽、NFS、其他OS/Node版本及生产无人值守负载未实测。审计保留/摘要不是可信宿主同UID对抗下的不可篡改保证；没有把上游Agent Loop/模型协议/SessionManager能力归为本轮成果。

## 5. 保留的外部验收

- 真实平台：须提供平台、专用应用、显式凭证注入方式、专用会话/参与者、send/edit/recall/upload数量，以及断网/权限调整许可。专用计划和清理步骤已备，允许动作当前仍为0；不会向业务频道试验。
- 真实模型/盲测：须批准具体模型、任务/重复数、请求/Token/费用/墙钟上限、停止条件和计价依据。现有提案与上限见前轮model-authorization-plan.json；没有授权真实后端。全局预算已接faux生产编排，真实provider保守计价、实际请求接线与逐任务Docker执行仍需在启用前验证，不能用离线结果替代。blind须单独冻结候选与批准，新版本用新输出目录。
- 本地构建安装验收已完成；发行发布、真实平台上线、其他OS部署未执行。没有要求再次批准已授权的五包本地构建。

## 6. 工作区来源与交付索引

续做前`baseline-hashes.json`记录108个既有改动/未跟踪文件；与最初四阶段前33文件基线是不同时间点。`status-before.txt`和`tracked-before.patch`保留；最终`change-inventory.json`区分续做前已有且本轮未改、同文件叠加、本轮原来干净而新改三类；所有基线文件保留，无暂存。文档和工程日志的更新也实际写入，历史实验与失败日志未覆盖。

逐项问题、根因、前后行为、精确验证、未验证边界追加到`docs/engineering-change-log.zh-CN.md`。根README、部署说明与Unreleased已同步真实构建安装状态。前轮阶段报告保留历史内容并增加本报告指针。没有提交、推送或发布。

## 最终证据补记

- 最终源码矩阵：`faux-v4-ec790d00-b2d2-4d94-8350-c8e7a7eee4d0`；两轴各317个源/资产hash与最终源码一致，预算累计606次faux请求。
- 最终安装：`${RELEASE_CHECK}/install-verification-native-final`；重装：同父目录`lockfile-replay-native-final`。1224个编译文件逐一与安装文件摘要相符，五tgz摘要保留于`final-release-evidence.json`。
- 最终原生矩阵：同父目录`compiled-faux-A-native-final`，100次attempt、80completed/20task_failed、其余缺失/超时/worker_error为0，622个已安装冻结文件核对无差异；294次faux请求，cost=null。`compiled-faux-native-final.log`为完整命令/输出。
- `native-benchmark-verified.log/.json`记录最终原生bin实际完成3任务；`installed-types-native-final.log`通过本地安装消费方的声明检查。
- `final-workspace-review.json`：续做前108文件全保留，本轮在8个原来干净路径新改、21个既有路径叠加；不含诊断资产与被忽略的工程日志。`git diff --check`通过，无暂存。
