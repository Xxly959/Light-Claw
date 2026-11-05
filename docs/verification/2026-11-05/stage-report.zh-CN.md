# LightClaw 工程补齐交付报告（2026-11-05）

> 后续状态更新：用户随后明确授权五包隔离构建和安装验证；全实验预算、审批归档及本地发行验证结果见[续做交付报告](delivery.zh-CN.md)。下文保留本阶段完成时的历史状态。

范围：单实例、同一信任域个人Agent。原地叠加既有隔离/策略/审批/审计/遥测/启动脚本工作；没有提交、推送、发布、构建，没有读取真实凭证、发送真实消息或调用付费模型。上游pi-mono会话、模型、工具能力仍归属上游，本轮结果仅为LightClaw增量与回归证据。

## 验证结论

- 第一阶段：结构化交付物绑定与确认期限、审批过期与一次消费、流式主备模型路由已实现；阶段回归188项通过。
- 第二阶段：执行审批授权、外置累计审计、逐容器检查报告、inbox/operation人工处置已实现；阶段回归217项通过。
- 第三阶段：inbox终态归档与有限去重、飞书附件入站、独立健康状态、定时错过策略及本地告警钩子已实现；阶段回归208项通过。
- 第四阶段：无构建安装/发行准备、备份恢复、平台/模型授权清单、Docker任务隔离组件和跨重启faux预算账本已实现。新鲜dist与干净安装未验收；真实平台和模型未授权、未运行。
- 最终受影响回归、完整check、当前源码Docker和完整faux矩阵的精确结果见本报告末尾最终验证补记；完整日志不截尾保存。

## 分项改动与回归

下表源文件均相对`packages/lightclaw/src/`；完整新增/修改路径见`change-inventory.json`，原始差异见`tracked-before.patch`和`tracked-final.patch`。测试从`packages/lightclaw`执行，统一前缀为`rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run`，后接表中具体`test/*.test.ts`。最终精确完整命令已保存于`regression-delivery.log`首行。

| 项目 | 实际行为与影响文件 | 具体回归文件 |
|---|---|---|
| 1A 人工验收 | goals/{types,artifact,acceptance,verifier,store,commands}.ts、tools/goal.ts、config.ts：明确files/none声明，不猜evidence路径，绑定路径/hash/bytes/device/inode/mtime/ctime；默认30分钟TTL，过期或变更重新申请，保留创建者/goal/attempt/revision约束 | manual-completion-binding、goals、goal-commands、goal-acceptance、goal-artifact、goal-control、goal-migration、goal-terminal-delivery、goal-verification、goal-tool-discovery |
| 1B 审批生命周期 | policy/{approvals,commands}.ts：有效pending/approved才去重，过期不占pending额度，过期历史可解释；文件事务锁防重复批准/消费，参数变化不复用 | approval-lifecycle、policy-core、approval-authority、main-lifecycle |
| 1C 流式主备 | model-router.ts、agent.ts、observability.ts、config.ts：处理流error终态，只有无内容输出时切换，逐provider凭证、链去环/冷却/取消/超时/不可重试边界；实际终态成功才重置；已知失败用量计入，未知null/usageIncomplete | model-fallback、agent-runner、runner-lifecycle |
| 2A 权限语义 | authorization.ts、policy/trust.ts、policy/{approvals,commands}.ts、runtime.ts：请求者/任务创建者/审批者分开；可信名单启用时创建者身份本身不授予执行批准；普通输入不继承active goal owner，续跑保留原actor | approval-authority、policy-core、main-lifecycle、platform-contract |
| 2B 审计 | audit/{storage,tool-audit,query,cli}.ts、telemetry/spans.ts、observability.ts、resource-policy.ts、agent.ts、runtime.ts：权威记录外置control/.audit；runs/toolcalls/spans/payload累计限额/轮换/保留期；恢复状态不日志清理；nofollow/单链接/写锁/fsync；关键失败阻断执行并进入可核对unknown，诊断可best-effort | audit-integrity、audit-query、audit-routing、audit-redaction、observability、resource-policy、runner-lifecycle、main-lifecycle |
| 2C 隔离报告 | isolation.ts、sandbox.ts、main.ts：configured与verified分开，逐频道容器inspect、挂载/网络/UID/完整安全契约，缺失/停止/检查失败/不匹配明确 | isolation-report-verification、channel-isolation、docker-validation、deployment-entry |
| 2D 人工处置 | recovery-control.ts、operations.ts、durable-inbox.ts、runtime.ts、slack.ts、feishu.ts：/recover查询ID/来源/版本/失败和副作用，resolve不重放，retry需ACK_DUPLICATE_RISK；身份、实例锁、空闲频道、CAS、审计保护；通知补发不重跑Agent | recovery-control、durable-work、durable-admission、recovery-faults、main-lifecycle |
| 3A 生命周期 | durable-inbox.ts、durable-state.ts：一次加载索引；终态先gzip归档再摘要再删活动payload，未决保留；默认归档720h/归档后去重168h，容量1万/80%预警与/recover maintain；摘要不残留preparedEvent | inbox-lifecycle、durable-work、durable-admission |
| 3B 飞书附件 | feishu-resources.ts、attachment-writer.py、feishu.ts、queued-events.ts、transport.ts、agent.ts、package.json：实际安装SDK流接口、20MiB文件/256MiB目录/30s超时、安全文件名/频道边界/链接拒绝；持久接纳与preparedEvent先于Agent；图片读取，不支持类型明确反馈，附件无权限提升 | platform-contract、feishu、attachment-upload、output-tools |
| 3C 无人值守 | health.ts、runtime.ts、events.ts、config.ts：锁/进程/心跳ready/SDK连接分别报告；10s心跳30s过期；one-shot默认最多迟到300000ms补执行，历史过期死信，periodic不补停机tick、远期分段timer；本地onFault钩子 | health-readiness、event-boundaries、events、deployment-entry、main-lifecycle |
| 4A 发行准备 | attachments.ts、sandbox.ts、feishu-resources.ts邻接Python助手；package.json声明复制三助手；evals/reliability/{controller,protocol}.ts区分源码tsx与已安装dist；benchmark不依赖git cwd；六CLI无凭证help；scripts/verify-install.mjs及state-backup.py | release-readiness、install-preflight、packaging、backup-restore、benchmark、offline-entry、reliability-controller |
| 4B 平台准备 | 实际Feishu/Slack adapter+mock SDK+生产runtime+faux，收发/附件/重复/重连/权限/429/审批/通知/身份契约；scripts/acceptance-plan.mjs生成专用会话范围、动作额度与清理步骤 | platform-contract、platform-notifications、approval-authority、main-lifecycle |
| 4C 评测准备 | evals/reliability/{budget-ledger,task-sandbox,fixture-runner,controller,protocol}.ts：任务唯一挂载、禁止控制/评分/答案/源码/socket暴露；冻结源/分集；预算预留/结算跨重启，未知不填零，人工时长未计量为null；两条轴与任务级配对报告分开 | reliability-budgets、reliability-docker-isolation、reliability-full-flow、reliability-controller、reliability-system、reliability-statistics |

每项根因、红灯/修复过程、遇到的问题与完整阶段命令追加于`docs/engineering-change-log.zh-CN.md`，未覆盖历史记录。初次check出现的类型/格式问题均保留失败日志并修正；没有降级依赖或为macOS隐藏Linux断言。

## 追加：飞书“提示词优化”卡片

- `prompt-input.ts`、`feishu.ts`、`runtime.ts`、`transport.ts`、`observability.ts`、`evals/optimizer.ts`、`index.ts`、`agent.ts`：普通输入直接用于正常任务，不生成/评分候选，不自动加载优化文件。显式操作者附加指令与优化开关解耦。
- 飞书原文旁提供按钮；原发送者在原频道原卡片30分钟内点击后，才生成至多2条候选，再连同原文评分，分数降序显示推荐。包含原文，平分优先原文；不会自动替换运行任务或后续输入。需要时复制推荐作为新消息。
- 两次无工具模型请求，每次最多1536输出Token，输入最多12000字符；请求按配置主provider取凭证，整个动作默认120s，可取消。模型主观评分不是任务实测，也不保证提示词收益。本轮只调用faux。
- `.prompt-inputs/`在保护控制目录内，持久绑定输入、actor/channel/card/期限/状态；重复、错误身份/频道/卡片、过期均不重复模型请求。重启后running不自动重放；失败需重新发原文。原文不写到权威审计正文。
- SDK `RawCardActionEvent`与`InteractiveCard`取自当前安装类型；事件订阅为`card.action.trigger`。平台真实回调、权限及展示仍待专用应用验收。Slack无新增按钮。
- 回归：`test/prompt-card.test.ts`、`test/prompt-optimization.test.ts`、`test/feature-runner.test.ts`、`test/platform-contract.test.ts`。完整生产adapter+runtime+faux测试验证普通调用1次、点击后再2次、其他人/重复点击无新增、下一条仍原文；另验证所有者取消。新测试先红灯后实施，未调用真实SDK服务。

## 证据分层与边界

| 证据 | 已取得 | 不能推出 |
|---|---|---|
| 离线/mock | 全部受影响定向回归；实际adapter、生产runtime、faux流/工具/附件；虚构备份恢复；安装plan与缺dist拒绝 | 真实飞书/Slack权限、投递及回调已可用；独立发行已通过 |
| 当前真实Docker | 本地冻结镜像，任务实际读写、隐藏资产不挂载；Linux监督器cancel/timeout/SIGTERM/SIGKILL；自有label清理 | 200次faux矩阵均在Docker内、真实模型或平台通过；host同UID对抗安全 |
| 完整faux矩阵 | A/B各100次attempt，development13+selection12、2臂、2重复；失败/缺失保留、逐任务统计；blind未执行 | 模型能力、候选收益、生产成功率或经济收益 |
| 历史Docker | 已核实2026-11-01记录并保留 | 自动证明当前新源码通过 |
| 真实平台 | 未运行 | 任何平台生产可用保证 |
| 真实模型 | 未运行，费用/用量未知不填0，faux token估计另标记 | 付费模型质量、统计显著性或降本 |

64条终态固定样本工程观察仅比较同操作的历史JSON读取调用：旧128次，新<=1；不是计时/吞吐实验。list仍在内存排序、持久写容量检查仍stat扫描，不声称全链路O(1)。审计为有保留期的本地证据，不是不可篡改或对同UID宿主工具的强隔离。真实磁盘耗尽/断电/NFS/内核崩溃未实测；quota/链接/写锁为离线注入。审批200条历史满额会明确停止新票据，不静默删除；没有实现无限历史或自动审批历史归档，应在达到容量前安排停机维护。新提示词状态也受保护存储容量约束，不普通清理未决请求。

## 待批准及未验收

### 发行构建与干净安装

AGENTS.md明确：`NEVER run: npm run dev, npm run build, npm test`。本轮未覆盖。若批准覆盖其中**npm run build**禁令，只需构建以下五包（不运行dev/test，不发布）：

```bash
rtk proxy npm run build --workspace=@mariozechner/pi-tui
rtk proxy npm run build --workspace=@mariozechner/pi-ai
rtk proxy npm run build --workspace=@mariozechner/pi-agent-core
rtk proxy npm run build --workspace=@mariozechner/pi-coding-agent
rtk proxy npm run build --workspace=lightclaw
```

预期产物：五个dist的JS/d.ts、LightClaw三个Python助手；然后使用`rtk proxy node packages/lightclaw/scripts/verify-install.mjs verify --root <仓库绝对路径> --out <全新目录> --cache <完整离线npm缓存>`生成本地tgz、独立node_modules、六CLI与库入口验证日志。精确参数以部署文档和脚本为准；缺缓存明确NOT VERIFIED。未获得全新dist/安装证据前不得称发行通过。

### 专用真实平台

见`platform-authorization-plan.json`：平台、专用应用、凭证注入、会话/参与者、允许send/edit/recall/upload数量、允许断网/改权限必须由用户明确提供。提议最低12/2/2/2动作不是授权；当前允许数全部0。卡片需补真实按钮回调验收。仅操作会话回执ID清理，保留未决账本；不搜索已有凭证或向业务频道实验。

### 真实模型与盲测

见`model-authorization-plan.json`：本地catalog模型提案`openai/gpt-4.1-mini`，13/12/11任务、2重复、166attempts，候选生成2请求，最多1330请求/100万Token/5美元/60分钟，预计30–60分钟仅规划估计。当前可用性、价格及保守单请求价格上界仍须实际确认，未批准不运行。blind在候选冻结与批准前锁定。当前持久预算接入faux per-attempt，真实付费全实验全局执行器还未接线；计划不是可直接执行付费实验的证明。授权后仍需完成真实模型计价/全局预算接线与隔离预检，不能仅凭离线单测启动付费实验。

## 工作区来源

最初基线见`git-status-before.txt`、`tracked-before.patch`、`baseline-hashes.json`（33个文件hash；此前实施清单“35条路径”为统计口径错误，已纠正）。最终逐项分类见`change-inventory.json`；所有基线文件保留，无破坏性Git操作、无暂存或提交。既有策略/隔离/审计等不全部归为本轮新增；同文件叠加部分通过前后hash与原始patch区分。工程日志可能受仓库忽略规则影响，但文件已实际追加。


## 最终验证补记

- `check-delivery.log`：根目录 `rtk proxy npm run check`，完整输出，exit=0；biome自动格式化1个本轮测试文件，无残余错误/警告/info。`rtk proxy git diff --check`通过。
- `regression-delivery.log`：64文件618/618通过，包含本轮所有新增/修改测试和共享runtime/agent影响回归。命令完整列于本日志首行及`test-commands.txt`，未运行npm test。
- `docker-delivery.log`：2文件6/6通过；实际Docker读写/挂载隔离与Linux监督器cancel/timeout/SIGTERM/SIGKILL。当前源码集成事实与历史2026-11-01记录分开。
- `reliability-full-flow-delivery.log`：1项完整流程回归通过，200个attempt保留于`faux-v4-e318353a-89c3-4799-946a-4f921454c668/`。A/B各100条，分别80 completed、20 task_failed；external_timeout/worker_error/missing_record/not_started均0。这是故障场景核算结果，不是200次任务成功。没有真实模型调用；未知费用和主观/未计量人力仍不作零值收益。
- `frozen-source-verification.json`：逐个核对两轴freeze中的所有源/资产哈希与当前文件，没有差异。之前的各版faux-v4目录完整保留，不覆盖历史。
- 飞书卡片通过实际adapter+mock SDK+生产runtime+faux完整测试；主体尚未连接真实平台，所以真实展示、权限和回调验收仍待专用应用授权。
- `change-inventory.json`、`git-status-final.txt`与`tracked-final.patch`为最终复核快照；没有基线文件被删。无commit/push/publish，禁止构建仍未运行。环境Node/tsx测试有DEP0205弃用提示，完整保留；check无该问题，未为此降级或绕过检查。
