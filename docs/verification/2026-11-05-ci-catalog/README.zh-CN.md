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
