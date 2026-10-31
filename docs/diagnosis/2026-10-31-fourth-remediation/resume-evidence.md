# 五条工程主张到证据的映射

这里按当前项目整理五条可用于简历的工程主张，不冒充未提供的简历逐字原文；本批未读取或修改简历源文件。当前所有代码仍为本地未提交状态，不能称远端已交付。源码均位于 packages/lightclaw；实际本批命令/数字见verification.md。历史记录不当作本批新实验。

|主张|源码入口|可复核证据|允许表述与限制|
|---|---|---|---|
|1. 多轮目标、持久接纳与恢复|src/runtime.ts、goals/store.ts、durable-inbox.ts、operations.ts、goals/control.ts|main-lifecycle、instance-lock、durable-admission/work、recovery-faults；第二批故障矩阵|实现单实例状态恢复、unknown隔离及mock稳定operation对账；任意bash无exactly-once，不声称断电持久性或生产零丢失|
|2. 固定完成验收及人工确认|goals/acceptance/artifact/verifier.ts、tools/goal.ts、goals/commands.ts、authorization.ts|goal-acceptance/artifact/verification/commands；第三批评分反例；第四批取消前权限回归|创建时固定契约，文件/Docker命令检查或创建者确认；纯manual未绑定产物快照的缺口仍在，不称通用语义验收准确|
|3. 飞书/Slack统一交付边界|transport.ts、slack.ts、feishu.ts、attachments.ts、attachment-reader.py|platform-contract、platform-notifications、attachment-upload；本批平台待执行清单|完成两个adapter和统一协议离线验收；真实平台仍未验收，飞书未支持入站文件下载，不称完整生态接入/线上使用|
|4. 受控执行与个人部署治理|sandbox.ts、docker-supervisor.py、channel-queue.ts、events.ts、resource-policy.ts、redaction.ts、health.ts、scripts/local-release.mjs|Docker mock策略/取消写文件、日期/timer、资源/日志、packaging/deployment-entry测试|时间/工具/已报告Token、排队/磁盘/日志边界和启动检查已实现；Token非账单硬上限、context有单轮超额窗口、无真实Docker/干净编译安装证明|
|5. 可复现离线评测与候选门禁|evals/reliability/*、evals/{runner,scoring,optimizer}.ts、evals/reliability数据|第三批36族、25开发选择任务×两臂×两重复每轴100faux记录；当前统计/评分回归；2026-10-21历史原始报告及第一批v2更正|区分产物正确、系统声明、错误完成/拒绝、人工与失败分母；faux只验证接线，候选门禁存在不等于自动优化有效，不写提速/费用下降结论|

## 与上游的归属

pi-mono提供模型协议/流式事件、Agent工具循环、SessionManager、上下文压缩、工具及终端基础；Mom已有Slack、记忆、事件、部分Docker/工具基础。LightClaw基于这些设施扩展ChatTransport与飞书适配、持久目标及验收、接纳/调度治理、受控操作对账、权限/诊断资源边界和评测协议。不要把重命名、基础Agent Loop或上游压缩机制写成独立原创。

## 精简项目描述

**LightClaw｜基于 pi-mono 的个人长期任务 Agent**  
基于 TypeScript 与 pi-mono，扩展飞书/Slack统一接口、多轮目标状态、固定完成验收与创建者确认；通过持久接纳、内核单实例锁、未知副作用隔离及mock操作对账支持可解释恢复。补充工具取消、权限前置、日志资源限额与分族离线评测，用faux provider和故障注入验证关键运行链路。当前真实平台、真实Docker与干净编译安装尚未验收。

如需简历压缩成两句：**基于pi-mono实现个人Agent的长期目标推进、完成验收与运行治理扩展；以持久接纳、单实例锁、受控操作对账及离线故障回归验证恢复和交付边界。** 不附未经本批验证的生产规模、成功率、性能提升或自动优化收益。
