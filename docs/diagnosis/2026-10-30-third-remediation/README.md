# 第三批交付：长期任务可靠性与完成验收评测

本批完成离线实现与协议，未调用真实模型、平台或凭证，未提交/推送/发布。保留工作区全部既有改动。主因是旧评测仅运行单次 AgentRunner 并以关键词/文件存在评分，未复用生产外层目标/恢复/投递机制；规则分数也不能代表任务正确性。

- [完整机制、指标定义与协议](../../../packages/lightclaw/docs/reliability-evaluation.zh-CN.md)（仓库包文档另有入口）。
- [公开任务与覆盖矩阵](coverage.md)、[机器近重复审计](data-audit.json)：36 个手工业务族，13/12/11 划分；盲测未执行。人工剔除重复模板，机器未报近重复，仍不等于自然分布或完全无语义重合。
- [实际命令及完整日志入口](verification.md)、[独立审查及 RED→GREEN](review.md)、[报告模板](report-template.md)。
- [A 冻结计划](offline-A/freeze.json)、[A 全尝试](offline-A/attempts.jsonl)、[A 报告](offline-A/report.json)；B 对应 offline-B。原 worker 压缩档含完整源码请求/工具/用量、控制器退出、goal/inbox/operation 状态；须在控制器侧解压。
- frozen-sources.tar.gz 保存290文件的源码/依赖/数据/评分器版本，包含受保护答案，不能挂入 Agent 工作区。source-changes.json 精确区分批前脏修改与本批增量；delivery-manifest.json 给交付文件哈希。

## 实际离线结果

|轴|不同任务|重复/臂|冻结/启动/控制器/完整记录|生命周期 completed / task_failed|产物精确正确（需产物分母）|错误完成（已知系统声明分母）|
|---|---:|---:|---|---|---|---|
|A|25|2|100 / 100 / 100 / 100|80 / 20|70 / 80|2 / 62|
|B|25|2|100 / 100 / 100 / 100|80 / 20|68 / 80|4 / 60|

两个轴的 source hashes 完全相同；重统计逐字段等于原报告。其余 external_timeout/worker_error/missing/not_started 在本次完整套件均为0，这些分支由定向故障/统计校验样本覆盖，并未从数据清除。4次产品预算超时/轴归 task_failed，不能和外部控制器超时混用。缺记录/截断的校验单独保留在测试日志中。

A 任务级配对端点差 -0.08，bootstrap95% [-0.20,0]；B 为0，区间[0,0]。这些是固定响应及预设故障的统计接线结果，**不支持长期任务收益、模型语义提升、候选改进或任何提速结论**。A 只有治理臂经历人工确认/暂停；B 两臂均治理，导致人工产物变更样本各两倍，不能把跨轴绝对分数作因果比较。

|轴|faux输入/输出Token估算|缓存读/写估算|faux请求数|控制器墙钟毫秒合计|humanRequired|mock重复effect|
|---|---|---|---:|---:|---|---|
|A|300800 / 6676|0 / 0|294|88609|10 / 100|0额外执行 / 4受控尝试|
|B|341098 / 7196|0 / 0|312|102344|12 / 100|0额外执行 / 4受控尝试|

所有数值只描述本机 faux run；Token 为模拟估算，金额保持 null，不能乘真实单价。两次运行主机负载不同，部分回归与B重叠，墙钟不可作性能对比。详细工具错误、输入保持、声明/拒绝/人工等分项及已知/未知资源覆盖率见 JSON。缺用量的统计校验保持 null；未知不能补0。

## 故障与机制矩阵（A+B 共200尝试）

|机制/样本|实际证据与结果|证据范围|
|---|---|---|
|多轮目标 d02/s03/b04|开发/选择治理臂12次通过实际 goal_progress → 外层继续 → goal_complete|b04未运行；没有真实推理质量证明|
|暂停恢复 d03/s04|12次治理尝试保存pause-observed、resume-dispatched，并实际完成后续工具写入|模拟创建者发送真实命令，计人工控制|
|压缩 d04/s05|16次先无产物，actual Session.compact 后携带摘要，再读/写产物|FROZEN_INPUT_CONSTRAINT 出现在后续实际请求中；不能证明模型理解摘要|
|最终投递失败 d05|8次正确产物，最终通知 journal unknown，task_failed；完成声明独立保留|协议模拟适配器；真实Slack/Feishu未验证|
|人工确认 d08/s10|12次治理尝试按实际 goal/attempt ID 由模拟创建者确认|不让模型代替人确认|
|旧申请 d09|6次旧attempt ID不能确认新申请，停 awaiting_confirmation|是状态/申请身份失效；产品无墙钟TTL，不声称等待多久自动过期|
|产物变更 d10|6次治理尝试产物被改后仍确认completed，评分准确报falseCompletion|已复现的产品缺口，非评测通过|
|排队到期 s06|8次持久记录expired，目标未消费、不续跑|与未启动、缺记录、丢失分开|
|崩溃 s07|8次控制器于工具写文件后SIGKILL，各2个boots，inbox unknown、人工作业，不盲目重放|进程崩溃；不证明断电持久性|
|预算超时 s08|8次保留productTimeout与task_failed|非外部worker超时；外部超时/code0冲突另有统计单测|
|正确产物系统失败 s09|8次产物正确、artifactRightSystemFailure=true、task_failed|不把产物对等价成完成|
|稳定operation ID d13|8次“服务成功但回执丢失”后查询同ID，实际服务每ID只执行1次|mock受控服务，不支持任意bash exactly-once|
|拒绝/澄清/不可行|40次固定响应分别评分，产物N/A、输入保持与处理类别单列|不证明真实模型能识别这些情形|
|错误产物假完成 / 伪造checker / 改输入 / 重复JSON键 / 跨频道symlink|定向评分校验全部通过|均虚构临时文件、受保护只读评分器，不读取真实敏感文件|
|截断observation/JSONL、missing与not_started、timeout code0成功冲突|独立进程和统计回归先失败后通过，原损坏内容不覆盖，冻结分母可重建|已知timeout优先；缺记录资源unknown；不承诺断电最后写入不丢|

## 剩余限制与审批

离线390项通过，真实Docker4项跳过；未创建Docker资源。没有真实模型、真实平台、敌对代码OS隔离或生产效果证据。纯人工验收 snapshots=[] 不能绑定产物，产品也没有基于墙钟的确认TTL；本批只建立可复现检测。blind样本小，未覆盖全部worker/时序故障，相关机制以独立故障校验为主。taskLoss只在已知持久接纳记录中估计，缺observation的资格另报unknown；不得称已证明零丢失。

选择使用有界工具faux worker完成本批，真实模型必须新增并验证Docker挂载与跨boots硬预算/计费上限；当前没有live开关。若把离线能力约束误当成OS沙箱，会高估安全性；因此当前CLI拒绝live/blind执行，审批后先完成沙箱前置核验。

[具体真实实验审批项](approval.md)：deepseek-flash公开版本V4.1-Flash-1017，354次任务尝试+2个候选生成请求，2500万Token/4250请求/18美元硬上限，预计$0.85–$1.71、按高峰无缓存保守上限约$15.30；上述Docker隔离、无宿主bash、只允许mock副作用。未批准、未执行，也未读取凭证。单价来源与预算假设在审批单中，可审查后明确批准。
