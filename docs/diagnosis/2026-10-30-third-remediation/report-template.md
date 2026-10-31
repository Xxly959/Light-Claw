# 长期任务评测报告模板 v1

证据级别：填写 faux 接线 / 真实模型语义 / 模拟平台 / 真实平台。禁止混写。

- 冻结目录、源码/依赖/数据/答案/评分器哈希、模型实际返回版本、日期、沙箱摘要：待填。
- 实验轴：A（明确运行时开关差异）或 B（完全相同运行时，只变候选文本及 hash）；禁止混合归因。
- 数据：任务族/来源，development/selection/blind 数量，近重复审查，泄漏检查，谁能读取答案：待填。
- 预注册主要端点与停止规则；全部候选、生成与筛选开销，是否拒绝候选：待填。

|流量核算|数量|
|---|---|
|冻结尝试 / 不同任务 / 每任务重复|待填|
|已派发 / OS 启动 / worker entered|待填|
|控制器结果 / 完整 observation / 可评分|待填|
|completed / task_failed / external_timeout / worker_error / missing_record / not_started|待填，必须与计划相加一致|

按臂、任务和场景填 artifactExact、inputPreserved、businessValid、handlingCorrect、systemCompletion、falseCompletion、modelFalseCompletion、falseRefusal、artifactRightSystemFailure、humanRequired、人工控制命令、工具错误、产品超时、丢失、重复副作用。每项写 numerator/denominator、N/A、known/unknown 与上下界；不要只填百分比，也不要给规则均分起名“任务准确率”。

|臂|输入Token|输出Token|缓存读/写Token|请求数|墙钟毫秒|工具错误|人工控制次数|已知/未知资源记录|费用|
|---|---|---|---|---|---|---|---|---|---|
|对照|待填||||||||未知时 null|
|处理|待填||||||||未知时 null|

每个资源列同时给 observedTotal、fullTotal、known、unknown；单价、计费日期、缓存口径和任何缺失不能省略。候选生成与筛选单列，不能只报入选候选的盲测成本。

配对统计：任务内平均重复，再计算任务级差值与 task-bootstrap 95% CI；独立单位是任务。主分析保留全计划失败/缺失；普通业务与注入故障分层，正确拒绝/澄清单列，禁止将拒绝增加解释为相同工作提速。若报告成功集条件耗时，必须清楚标为条件描述，不能替代全任务成本/完成率。

故障解释：列出崩溃点、持久接纳/外部 effect/保存/投递证据、恢复后状态、最终处理方式。对 unknown/manual 不声称 exactly-once；对断电持久性、真实平台或 Docker 没有证据就列未验证。

结论：分别写已观察现象、支持范围、不能推断的收益、已知缺陷。faux 仅证明评分/统计/编排接线，不能填模型收益结论。列出剩余问题和下一次审批项。
