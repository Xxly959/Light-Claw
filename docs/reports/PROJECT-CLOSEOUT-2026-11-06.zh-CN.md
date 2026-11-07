# LightClaw 项目收尾（2026-11-06）

## 最终定位

可从源码运行、可学习的单实例个人Agent，飞书优先并保留Slack；保留多轮会话/记忆、文件与Shell、提示词预览确认、持久目标、权限/审批、调度、恢复、审计和备份。停止扩展为评测框架或通用平台。具体范围以packages/lightclaw/docs/project-scope.zh-CN.md为准。

## 本轮完成

- 按用户授权删除46个评测/基准专用产品文件：src/evals、src/benchmark、evals数据及专用测试。清单见docs/verification/2026-11-06-closeout/removed-files.json。没有删除pi上游工具/模型/会话基础设施。
- 删除三个bin、离线候选筛选导出、evaluationSeed专用注入；同步package.json、lockfile、build路径、源码打包范围、安装验证与验收计划脚本。清理同名陈旧生成目录及对应本地bin链接，不运行构建或依赖安装。
- 日常目标产物验收、交互改写约束复核、审计/预算与工程回归保留。runtime-evaluation.test.ts只是目标循环回归，重命名runtime-goal-loop.test.ts，内容未削减；不是按名字粗暴删除。
- 原.env.example已在本轮前删除，未覆盖这项既有工作。新建packages/lightclaw/config.env.example，只有占位配置，修改启动器与文档指向；启动器进入仓库根以统一相对路径。未改真实.env、私有模型文件、auth或live数据。
- 根README、中英文使用说明、部署与架构同步；三份退役评测手册移到docs/history/2026-11-06-retired-evaluation并标记历史。旧部署说明保留快照，五份本地学习/审计笔记加历史提示，不抹掉原记录。此前实验与工程证据保留，但不属于产品学习主线。
- 新增最终范围/人工功能清单及源码学习路线。学习以真实消息→队列→runtime→Agent→工具→状态/恢复为主，明确pi继承层与LightClaw业务层。

## 验证

包目录运行：

```sh
rtk proxy env PATH=/Users/x/.workbuddy/binaries/node/versions/22.22.2-6/bin:/opt/homebrew/bin:/usr/bin:/bin npx tsx ../../node_modules/vitest/dist/cli.js --run test/product-scope.test.ts test/offline-entry.test.ts test/platform-preflight.test.ts test/runtime-goal-loop.test.ts test/packaging.test.ts test/install-preflight.test.ts test/agent-runner.test.ts test/platform-contract.test.ts test/main-lifecycle.test.ts test/prompt-card.test.ts test/prompt-redesign.test.ts --silent
```

11文件144测试通过。另 `rtk proxy env PATH=/Users/x/.workbuddy/binaries/node/versions/22.22.2-6/bin:/opt/homebrew/bin:/usr/bin:/bin npx tsx ../../node_modules/vitest/dist/cli.js --run test/release-readiness.test.ts -t '^(?!.*builds pi-ai)' --silent`：5通过、1未运行。未运行的是未改动的构建测试，它内部执行npm run build；AGENTS.md明确禁止此命令，因此本轮不触发。合计149个不同工程测试通过，不是Agent效果评测。

产品范围新测试先观察3例失败（旧bin/无预览计划/无配置模板），再删除与实现，通过后连同依赖回归检查。旧平台范围预检、健康、打包清单和主会话/确认链路继续受工程回归保障。

仓库根 `rtk proxy npm run check`最终完整通过748文件、browser-smoke/web-ui/example，无错误、警告或info；完整读取输出，没有tail。`rtk proxy bash -n scripts/start-lightclaw.sh`通过。`rtk proxy node packages/lightclaw/scripts/verify-install.mjs plan`仅准备当前3个CLI的安装方案，明确installation-not-verified。

主动源码/脚本/lock没有遗留评测模块依赖。入口文档本地链接扫描曾发现中文README两条退役链接，已清理。独立只读审查发现旧学习笔记仍指向删除模块，已加历史标记；最终没有未解决新增缺陷。

## 当前限制

本轮没有Agent/model效果评测，没有真实API调用或代发平台试验消息，没有build/dev/npm test、安装包重建、发布、提交或推送。source可运行不等于新dist已验证。未重新完成真实Slack/Docker/多平台所有功能的线上验收，模型正确性也不由工程测试保证。使用自己的会话做日常功能检查，按部署文档操作；不要从历史报告推断当前代码的效果。

预先存在的dirty工作全部保留；没有git reset/stash/clean或整树暂存。本轮删除的源码和专用测试原文快照位于/tmp/lightclaw-finalize-20261106供本次回看，不自动迁移到用户其他项目。历史报告/证据保持原位置，相关退休说明仅界定当前使用边界。

源码加载/最终核对结果见工程记录。可以开始按learning-path.zh-CN.md学习，先追一条普通私聊消息，再读目标/恢复；不要求先阅读全部上游仓库。

## 同日后续授权验收

用户随后明确允许隔离构建/独立安装与当前私聊有限验收，已实际完成；上述未构建/未安装/未真实验收是本报告初稿阶段的事实，不再代表最新状态。最终证据见[最终验收报告](FINAL-ACCEPTANCE-2026-11-06.zh-CN.md)，包括68文件667测试、5包构建安装、真实模型与私聊附件、用户实际卡片编辑确认及主会话隔离核对。当前服务仍运行源码入口，没有提交/推送/发布。
