# 独立只读审查及处理

审查者 batch3_review，未修改文件、运行模型或平台。三项 P2，无 Critical：

1. observation/JSONL 截断会使控制器或分析直接抛错。现有回归先失败，修复后保留原文/行哈希诊断，核验记录 schema，优先恢复 durable attempt，再恢复 controller-only；完整计划依旧连接，已知 timeout 优先。新增 records.ts；普通 observation/controller/attempt 使用 writeDurableJson。
2. onRun 之后的最终通知失败未进入观察。现从实际 protected OperationJournal 读取未决通知，保留产品 completed 声明，同时将系统/交付失败和人工需求计入 observation、终态与配对端点。模拟适配器专门注入 final-update，回归验证正确产物仍保留、终态 task_failed。
3. 初轮已经写好答案，再 compact 无法检查继续执行。现第一阶段只有读取与计划，断言产物不存在；actual AgentSession.compact 后才再次工具读取/写入，后续完整请求中断言 FROZEN_INPUT_CONSTRAINT 摘要标记存在。

四个 RED 断言对应三项问题，review-red.log；修复后的 review-green-2.log 24/24，最终包内390/390离线项通过、真实Docker4项跳过。没有再次请求审查；修复由针对性回归及完整包内回归验证。

审查未覆盖真实模型、平台、Docker/敌对代码隔离。人工验收缺少产物快照已被诚实测出，是产品剩余缺口，不将其解释为评测器通过或扩大到本批产品修复。
