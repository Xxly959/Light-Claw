# 2026-11-05 CI 模型目录漂移修复

## 原因

截图来自GitHub run41992925146。CI先build再check，pi-ai原build会先实时调用外部模型目录并覆盖models.generated.ts；部分旧ID已不在实时目录，导致类型联合变化。截图只展示部分annotation，完整日志为github-before.txt。本地check使用提交快照，因此本地绿不能证明远端build后仍绿。此前五包隔离构建通过也没有覆盖“刷新目录后检查全部上游测试”的组合，本轮补上该验证缺口。

## 修改

- pi-ai默认build仅用原tsgo编译提交的模型快照。保留显式npm run generate-models；刷新必须审阅diff并连同所有模型引用/测试一起提交，不弱化类型、不删除测试或provider。
- CI增加git diff --exit-code -- packages/ai/src/models.generated.ts，阻止构建改写固定目录。
- checkout/setup-node/setup-python升级官方v6，已读取三者action.yml确认using node24；被测Node矩阵仍为22.19.0和22，未改测试目标。运行镜像固定ubuntu-24.04，避免ubuntu-latest切换提示和环境漂移。
- release-readiness新增实际pi-ai隔离副本构建，空HOME/独立空npm配置、离线npm、阻止fetch/socket并记录调用。旧脚本失败堆栈明确指向fetchAiGatewayModels；新脚本无触网、源字节不变、实际dist JS和声明正确。测试中的npm更新通知与声明re-export断言问题已核对修正，不以降低生产类型或跳过断言修复。

## 验证

从packages/lightclaw执行：

```sh
rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run test/release-readiness.test.ts test/packaging.test.ts test/install-preflight.test.ts
```

3文件23项通过，red.txt记录旧脚本预期失败，green.txt记录修复后通过。根目录rtk proxy npm run check完整通过，见check.txt。正常提交钩子照常运行；GitHub两组矩阵结果在推送后核对，不能用本地结果替代。只在临时隔离副本构建已获授权的pi-ai，没有共享仓库构建、付费模型或真实平台请求。

日志公开副本替换本机路径为${REPOSITORY}/${TEMP}；原始副本保留本地。历史run上的红色注释不会被修改；请看新提交对应的CI结果。

## 远端后续发现：诊断夹具迁移

run42021291538的两个矩阵已通过Build、固定目录守卫和Check，原类型错误及基础Action警告消失；但完整LightClaw回归发现旧diagnosis-controls.test.ts夹具缺少结构化交付物声明（fixture-before.txt）。这属于原定向64文件没有覆盖到的旧测试，不应把类型错误修好当作全CI完成。

只为acceptance-off的自报完成夹具补report.md结构化声明，不创建文件，也不改“自报、不伪造通过检查”的既有断言；生产的强制声明要求保持。包根运行diagnosis-controls、release-readiness、manual-completion-binding，结果见fixture-green.txt。后续仍以最终GitHub运行结果为准。

## 第二项远端后续：同毫秒接纳破坏FIFO

run42022519742在Node22矩阵通过了完整LightClaw回归，Node22.19.0矩阵发现durable-admission恢复顺序从1/2/3/4变为1/3/2/4。根因为acceptedAt使用毫秒墙钟，相等时按SHA-256 ID排序，无法表示接纳先后；时钟回拨也会重排。此次是实际队列问题，不能通过放宽顺序断言或增加延时解决。

先把原测试固定为同一毫秒接纳，并真正重建DurableInbox实例，稳定复现3/1/4/2；另复现回拨和终态归档后的次序错误（fifo-red.txt）。为新记录持久化正安全整数admissionOrder，从活动账本最大值恢复计数，排序优先用接纳序号；acceptedAt和expiresAt仍保留真实墙钟语义，去重/审批/副作用保护不变。无效/重复序号拒绝，写失败可有序号空隙，不会倒序或复用仍活动的序号。单实例锁仍是唯一写入者前提。

既有未带序号的记录保持原先确定性顺序并位于新记录前；旧记录已经丢失的同毫秒真实先后无法可靠重建，不猜测或删记录。归档去重摘要不能重放，全部活动记录清空后新序号可重新从1起；这不会使旧归档重新执行。

定向覆盖恢复队列、时钟相等/回拨、归档/重启、序号损坏，以及durable-work、人工对账、故障恢复、真实adapter+mock SDK和主入口，结果见fifo-green.txt。最终仍须核对新GitHub矩阵，不将中间失败当成成功。

## 第三项远端后续：大输出取消夹具的就绪同步

run42024376747两组都通过了完整LightClaw专项，随后全仓库测试中的第二遍LightClaw执行，在Node22发现sandbox.test.ts等待输出写完标记超出5秒（archive-before.txt）。其余全仓库测试日志未出现另一个失败用例；另一矩阵按fail-fast取消。

目标是验证12MiB输出在取消前产生、取消返回前归档完成，不是5秒吞吐SLA。修改仅在该夹具：提前订阅独立临时目录的fs.watch，等待子进程stdout写回调产生ready标记；命令提前失败立即传播，取消/等待进程退出/关闭watcher/清理目录都放在finally路径。单次夹具执行设20秒（原执行器默认120秒），整体测试30秒不变，生产超时不变；保留12MiB精确长度、CANCEL-END结尾、Command aborted和归档路径断言。没有跳过Linux测试或改变生产取消行为。

包根执行test/sandbox.test.ts和test/docker-cancellation.test.ts，2文件14项通过（archive-green.txt）。后者是本地shim，不能冒充真实Linux Docker验收。完整check与最终远端矩阵另核对。
