> 历史文档：2026-11-06相关产品代码已按用户要求删除。以下内容仅保留历史，不是当前可运行说明。

# 长期任务可靠性评测 v1

本入口检验任务产物、完成声明、恢复与投递的关系。默认只做离线数据审计；`--mode=offline` 使用固定响应/faux provider、临时工作区和协议模拟平台，复用 `runtime.ts` 与 `createAgentRunner`。生产 `main.ts` 也调用该 runtime，评测没有另一套目标循环。真实平台、真实模型语义效果、Docker 隔离效果均不在本次证据范围。

旧单轮评测保留为显式 `--suite=legacy`。它的规则均分是 check-pass fraction，不能叫任务准确率。不要将旧系统提示词修复或运行时修复的收益归于自动候选提示词。本批没有重新运行历史模型实验。

## 数据与答案隔离

`evals/reliability/tasks.json` 包含任务全文与输入，共 36 个手工合成业务族，开发 13、候选选择 12、最终盲测 11。没有按同一模板替换数字来扩样；人工审查已剔除两个同构副作用样本，并替换一个相似的版本复制任务。相同治理故障会跨业务族出现，不能由此宣称 36 个独立自然用户需求。一个族只有一个任务，样本小，不能支持广泛质量结论。

`auditData` 检查跨 split 共享 family、重复 ID/提示词，并在去掉共同输出协议后用 NFKC 四字符 shingles/Jaccard≥0.55 检查近重复。人工语义审查与机器审查互补；低词面重合不能证明不存在语义泄漏。覆盖矩阵与全部公开任务见仓库第三批交付目录 `coverage.md`。

参考答案在 `evals/reliability/protected/oracles.json`，验收脚本在同目录 `check-artifacts.py`。控制器将当次开发/选择答案交给固定响应 worker，**不会把答案或评分器复制到 Agent 工作区/请求上下文**。这专用于接线验证；固定响应知道参考答案，绝不能作为模型能力评测。`runFixture` 与 `makeFreeze` 都拒绝执行 blind；候选占位文本为人工编写，没有调用候选生成模型。盲测答案未进入候选生成或选择。

Agent 只获得 `/workspace` 下当前频道的有界文件工具、实际 goal 工具和 mock operation 工具，没有 bash、网络、宿主绝对路径或加载任意模块的工具。worker 使用空 HOME、内存认证/模型注册表/设置、固定 faux key，禁用 Node socket/fetch。宿主仅运行受信任的锁/只读评分 Python 代码，未让模型执行宿主命令。**这是固定响应下的能力约束，不是已验证的敌对代码 OS 沙箱**。真实实验必须另行实现并核验 Docker 只挂载任务目录、无宿主源码/答案/控制目录/socket、网络关闭；模型请求由容器外受限代理发出。

评分器在控制器侧执行受保护路径，SHA-256 与冻结清单一致，前后复查。它通过第一批已实现的目录/文件描述符读取器读取普通、小于 1 MiB、非链接文件，不执行产物；输入逐字节比对，产物按 JSON 结构精确比较，拒绝重复键/非有限数，区分布尔与数字。业务规则包括整数非负金额、唯一性、资格匹配、非重叠预约、装箱容量与顺序。工作区里的 `checker.py` 不会参与评分。

## 指标与分母

不计算“规则均分准确率”。以下指标分别报告；比例同时输出 numerator、denominator、known、unknown、上下界。未知不等于 N/A，也不等于零。

|指标|单位及分母|N/A / 未知规则|
|---|---|---|
|artifactExact / businessValid|应交付产物的已尝试任务数；失败/超时不剔除|澄清/拒绝/不可行任务为 N/A；缺记录保留 unknown，完整比例为 null|
|inputPreserved|所有已尝试任务，输入字节哈希全部一致|缺记录 unknown|
|handlingCorrect|所有已尝试任务；decision 是否等于参考处理类别|缺回复/无法解析为 unknown，保留分母；这里只比较类别，不把 reason 关键词当事实证明|
|systemCompletion|所有已尝试任务；目标 completed，或普通任务明确 complete 且执行正常结束|与 artifactCorrect 分开；缺记录 unknown|
|falseCompletionAmongKnownSystemClaims|已知的系统完成声明；产物/输入/业务约束错误，或本应拒绝/澄清/无法完成|无已知声明时 N/A；另报记录缺口，不能推断缺失任务没有声明|
|modelFalseCompletion|所有已尝试任务中模型宣称 complete 且产物/处理错误|与系统 completed 分开，缺记录 unknown|
|falseRefusal|参考应交付产物的已尝试任务，实际 decision=refuse|本应拒绝/澄清/无法完成为 N/A|
|artifactRightSystemFailure|应交付产物任务；产物正确但执行错误/预算超时/明确 unable|不是“产物对就算运行成功”|
|humanRequired / humanInterventions|待人工处理比例 / 实际模拟人工控制命令次数（pause/resume/confirm 各一次）|缺记录 unknown；自动固定回答不算人工|
|taskLoss|已知持久接纳的任务中，找不到其 inbox 记录的比例|不把 expired/unknown/dead 当丢失；缺 observation 时另报 unknownEligibilityRecords|
|duplicateEffects|受控 mock effect 任务中服务按稳定 ID 计数的额外执行次数|普通文件任务 N/A；缺记录 unknown；不声称任意 bash 幂等|
|toolErrors / productTimeout|工具错误次数 / 产品预算终止标志|工具错误可以被恢复，不能直接等于任务错误；缺记录 unknown|
|input/output/cacheRead/cacheWrite、modelRequests|每次尝试的 Token 四个互斥量与请求次数，另报已知/未知覆盖率|faux Token 是人工估算；缺用量 null，不能置零；请求日志独立计数|
|durationMs|控制器跨全部 worker boots 的墙钟毫秒；单元构造记录退回业务运行时长|缺记录未知；不能把更多拒绝/未执行造成的均值下降称为相同任务提速|
|cost|金额|本次没有付费模型调用；faux 用量不能换算真实费用。未知单价/用量一律 null|

尝试终态互斥，优先级：external_timeout > 非零退出/信号(worker_error) > 无完整记录(missing_record) > 系统失败、预算终止、unknown/dead 或未消费(task_failed) > completed。`completed` 只表示执行生命周期收敛，不等于产物正确。未启动为 not_started；外部超时即使退出码 0、记录声明完成也只归入 external_timeout。评分器错误单独保存并使尝试 worker_error，不能算通过。截断/无效 observation 保留原文并判 worker_error；JSONL坏行记录行号/哈希诊断，按冻结job恢复独立durable attempt或controller-only，恢复不到的保留missing，不中断整份分母报告。最终通知journal的unknown/manual同样进入失败与人工需求，不能只看onRun之前的Agent结果。

控制器另报 frozen planned、dispatched、OS launched、worker entered、controller records、complete observations。排队到期与未启动/记录缺失不同。所有冻结 job 均保留在计划连接中；失败、超时、缺失、不启动都不能消失。资源汇总提供 observedTotal 与 fullTotal，含未知时 fullTotal=null。

配对端点叫 **observed verified workflow completion**：必须生命周期 completed、正确处理类别、输入/评分器完整、产物与业务约束正确，需交付任务还必须系统声明完成。澄清/拒绝/不可行不要求产物。缺失和未启动不算已验证完成，但费用仍未知。注入后正确停在人工处理的任务可能没有达到“完成”端点，必须同时阅读故障矩阵与分项指标。

## A 与 B 协议

A：同模型、公开输入、工具实现、预算、环境与安全接纳/锁，匹配一次请求基线与目标推进/验收治理；差异明确为 goals/acceptance 及外层继续推进。暂停/人工确认只有治理臂可用，这是干预的一部分，必须单列人工成本，不能把基线功能缺失隐藏。两臂都注入相同的崩溃/到期/投递/超时条件。持久接纳是最低安全底线，两臂都保留，因此 A 不估计“完全没有 inbox 的系统”收益。

B：冻结 A 后选定的运行时，不再修 system prompt、工具或治理机制，仅比较空附加指令和一个明确记录的 candidate 字符串。候选仅用 development 生成，selection 选择并记录全部候选/筛选成本，最终 blind 不参与任何生成/筛选/改参。当前 candidate 是人工占位，用于 payload 差异校验；没有自动候选收益结论。

每个任务/重复的两臂使用相同配对标签，按任务与重复奇偶交错 AB/BA。faux 无随机推理，seed 只是配对标签；未来若供应商不支持 seed，记录不支持，不能伪称可控随机种子。先在任务内部平均重复，再在任务级估计配对差值；固定种子 bootstrap 按 task ID 重采样 2000 次，报告 95% 区间。绝不把 5 次重复称为 5 个任务。小盲测仅是可行性样本，不能保证统计功效。

压缩用例第一阶段只读与计划，断言尚无产物；actual Session.compact 后后续请求必须携带摘要标记，再执行读写产物。

每次请求保存实际 systemPrompt、归一化副本（只替换运行根路径和 UUID）、完整消息/工具 schema 与 payload 哈希；原始副本不删除。B 回归验证除 candidate section 外首次有效 systemPrompt 和工具相同。两臂先比较正确性、错误拒绝/完成和人工成本，再看同任务配对资源；不按结果筛去失败，不使用幸存成功集冒充全样本提速。故障注入矩阵与普通业务任务分层报告；faux 的 A/B 差值仅验证统计接线。

## 冻结、复现与停止条件

冻结包含 Node/Python、平台/架构、Git HEAD、脏工作区源码哈希、依赖锁、解析配置、业务运行时/Agent/ai/tui 源码、公开数据、受保护答案/评分器、两个提示词、工具/沙箱、预算、任务/顺序/配对标签。Git HEAD 不能代表未提交源码；完整哈希为准。分析验证清单无遗漏且当前源码逐文件匹配，发生漂移就停止，保留旧原始结果。新版本需新目录/新冻结，禁止覆盖旧结果。

在 `packages/lightclaw` 执行（Node≥22.19、Python3/POSIX，均不需要凭证/Docker）：

```sh
rtk proxy npx tsx src/evals/cli.ts
rtk proxy npx tsx src/evals/cli.ts --suite=reliability --mode=offline --axis=A --splits=development,selection --repetitions=2 --out=/tmp/lightclaw-eval-A-new
rtk proxy npx tsx src/evals/cli.ts --suite=reliability --mode=offline --axis=B --splits=development,selection --repetitions=2 --out=/tmp/lightclaw-eval-B-new
rtk proxy npx tsx src/evals/cli.ts --suite=reliability --mode=analyze --out=/tmp/lightclaw-eval-A-new
rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run test/reliability-system.test.ts test/reliability-controller.test.ts test/reliability-statistics.test.ts test/runtime-evaluation.test.ts test/offline-entry.test.ts
```

输出目录必须不存在。原始 `freeze.json`、`attempts.jsonl`、逐 worker payload/请求/用量/inbox/goal/退出证据保留；重统计写 `report.reanalyzed.json`，不覆盖历史报告。并发最多 2、每 boot 外部限时 12 秒、每 runner 请求上限 16、业务轮数上限 4；崩溃最多注入一次并重启一次，不无限重试。重启后未决普通执行进入 unknown，需要人工对账；不会自动重放任意副作用。

当前没有 live 模式；未知 mode/suite、盲测 faux 执行和冻结漂移均拒绝。真实实验的模型、任务次数、累计 Token/请求/费用上限及 Docker 沙箱需按第三批交付目录的 `approval.md` 单独批准，获批前不读取凭证、不发出真实请求。
