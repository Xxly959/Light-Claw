# LightClaw 提示词设计源码对照审计（2026-11-06）

## 结论与范围

当前飞书“优化并预览”实现了改写、用户编辑、确认与主上下文隔离；尚没有证据证明改写提升任务效果。早先以格式解析、测试数量、结果变长作为交付依据，不能支持质量结论。用户质疑成立。

本轮为只读产品代码审计，查阅GitHub一手源码/项目说明，没有继续替换线上提示词、修改配置、重启、发送消息或调用模型。仅新增本报告并追加工程记录。上轮两次真实请求是开发样例，不能证明泛化收益；工程回归证明流程，不证明模型质量。

## 查阅的一手项目

### linshenkx/prompt-optimizer：最贴近飞书用户提示词改写

实际阅读master分支：
- 用户基础优化： https://github.com/linshenkx/prompt-optimizer/blob/master/packages/core/src/services/template/default-templates/user-optimize/user-prompt-basic.ts
- 专业优化： https://github.com/linshenkx/prompt-optimizer/blob/master/packages/core/src/services/template/default-templates/user-optimize/user-prompt-professional.ts
- 规划优化： https://github.com/linshenkx/prompt-optimizer/blob/master/packages/core/src/services/template/default-templates/user-optimize/user-prompt-planning.ts
- 上下文与工具感知： https://github.com/linshenkx/prompt-optimizer/blob/master/packages/core/src/services/template/default-templates/user-optimize/context/context-user-prompt-basic.ts
- 系统提示词模板： https://github.com/linshenkx/prompt-optimizer/blob/master/packages/core/src/services/template/default-templates/optimize/general-optimize.ts
- 调用链： https://github.com/linshenkx/prompt-optimizer/blob/master/packages/core/src/services/prompt/service.ts
- 用户提示词比较： https://github.com/linshenkx/prompt-optimizer/blob/master/packages/core/src/services/template/default-templates/evaluation/basic/user/evaluation-compare.ts

观察：用户优化和系统优化有独立模式与模板，用户侧还区分基础、专业、规划。上下文模板分别处理会话证据、工具证据、缺失情况和变量保留。service提供优化、带用户反馈的迭代以及独立测试调用；比较评估引用测试快照。

可借鉴的是职责划分、上下文边界、迭代反馈和测试能力，不是照搬长角色模板。其模板包含较强结构化/细化指令，不能据此推断适合所有任务，更不能把GitHub项目的宣传当作本项目效果证据。公开源代码可阅读不等于可忽略许可证直接复制进本项目；本轮没有复制实现。

### DSPy/GEPA：用于有反馈的数据集优化

实际阅读：
- 源码： https://github.com/stanfordnlp/dspy/blob/main/dspy/teleprompt/gepa/gepa.py
- 机制说明： https://github.com/stanfordnlp/dspy/blob/main/docs/docs/diving-deeper/gepa-in-depth.md

观察：用指标与具体反馈指导反思式候选修改，再以运行评估选择；实现区分反思模型和任务执行，提供预算。源码明确警告用训练集兼作验证集会过拟合，想支持泛化结论需独立验证集。

启示：提示词变化只是候选，是否更好要看下游任务结果。它适合离线优化稳定指令，不宜直接把完整候选搜索塞入每次飞书预览。采用其机制也不会自动证明结果可靠；指标设计仍需审查。

### Microsoft PromptWizard：反馈驱动优化的补充参考

阅读项目README： https://github.com/microsoft/PromptWizard

项目描述候选生成、批评反馈、指令与示例迭代，并分别支持无训练示例、合成示例与真实训练数据场景。本轮未复现其算法或核验论文效果；仅将其作为方法和场景划分参考，未声称阅读或运行全部算法源码。

以上链接为本次读取的可变分支，不是不可变commit快照；实施引用前应固定版本和许可证。

## 本地发现

### A. 优化器的系统提示词：缺少经过验证的任务适配

位置： packages/lightclaw/src/prompt-input.ts，REWRITER_SYSTEM_PROMPT与createPromptRewriter。

1. 原指令过分强调不补充内容，真实调研请求仅补句号。上一修补又引入相近的完整调研例子，当前输出明显继承其骨架。few-shot不是错误，但只测试相近输入无法排除示例依赖。
2. 所有任务使用同一改写器。虽有原则描述，没有任务适配的验证记录：研究、编码、摘要、创作、精确格式与含上下文指代的请求是否各自保持意图，尚无证据。
3. context固定为null，改写器既没有用户选择提供的背景，也没有目标Agent工具/权限说明。保持主上下文隔离是必要的，但这不要求改写器永远缺少能力描述。能力摘要可在临时请求内提供，原始/改写过程仍不写主会话；缺失的用户事实不得补造。
4. 模型生成changes，extractRewrittenPrompt只返回prompt。用户看不到具体增删与假设，无法有效判断优化是否偏题。
5. XML标签与长度检查只验证信封格式；原文/标点比对只描述文本差异，无法检测新增需求、丢约束、改变量或改变用户意图。
6. 字面上“不得擅自增加范围”必须与“允许必要执行细化”一致；不能用篇幅或套模板解决这个冲突。

### B. 主Agent系统提示词：环境信息较完整，通用工作标准不足

位置： packages/lightclaw/src/agent.ts 的buildSystemPrompt、每轮刷新逻辑；src/tools/index.ts 的默认工具列表。

已有：身份、平台格式、用户/频道、环境、工具、沙箱写边界、技能、记忆，以及目标提示；运行时另有权限/审批等机制。这些功能不能因本次质量问题被一概否定。

默认模板没有明确统一规定：如何选择并核验来源、如何处理无法联网或工具失败、怎样区分已执行/推测/未验证、怎样按照用户要求组织交付，以及何时自检和继续修正。单一Be concise不足以表达这些工作标准。本轮只读核对.env：没有配置LIGHTCLAW_PROMPT_INSTRUCTIONS；没有读取/发布凭证值。记忆、技能和工具说明仍可能补充部分行为，不能据默认模板就断言每次真实输出必然失败。

默认注册工具是read/bash/edit/write/attach与goal工具，没有专用网页搜索工具。bash可调用curl等命令不等于已验证具备稳定检索能力；是否有检索技能、联网与具体数据访问，需按实际实例验证。优化器不应假设“要求附链接”就能让执行Agent自动具备检索能力。

### C. 验证：当前没有完整的质量闭环

58个定向回归验证了卡片、状态、权限、隔离、去重等工程行为。两次真实调用验证一个开发调研样例得到更详细的文本、一个精确指令保持原样；没有比较原文/改写后的下游任务产出，没有独立盲评或留出集。没有足够证据把产品标成“已验证提升质量”。

## 建议实施边界与验收标准

1. 主Agent的稳定系统指令：补齐可靠执行、来源核验、工具失败反馈、事实与推测区分、完成检查；保留现有工具权限与沙箱约束。使用任务回归验证，不通过用户提示词来弥补所有系统行为缺口。
2. 临时改写工作流：先识别任务目标/类型、已有硬约束、缺失事实，再选择最小充分的精炼或规划方式。输出候选文本、实际修改说明、必要假设/待确认项。依据用户提供的背景和实际工具描述做适配；不复制固定内容骨架，不硬编数量、版本、事实、权限或文件路径。
3. 卡片仍需原文 → 预览编辑 → 用户确认。修改说明/假设展示在编辑文本之外，不混进主Agent输入。保持隔离；预览不执行实际任务，不在后台替用户试跑有副作用的任务。
4. 离线评估独立进行：冻结原文、改写器版本、目标模型、系统提示词、工具集合和预算；在安全fixture/无副作用任务上对比下游产出。评估维度为意图/约束保持、任务完成、证据正确性、无依据新增、冗余；字数不是效果指标。
5. 样例覆盖研究、代码排障、总结提取、创作、精确格式、上下文指代；区分开发样例与未用于修改模板的留出样例。打乱原文/优化版本标签做盲评；模型裁判仅为辅助，报告失败例和用户复核。优先保证硬约束不回归，不用一个综合分掩盖权限/约束错误。
6. 工程验收与效果验收分开记录；有结果后才能决定是否推广。DSPy/GEPA是离线评估机制参考，不是本轮必需新增的运行时依赖。

## 本轮交付状态

完成上述GitHub检索、源码对照与本地审计。尚未按照这些建议重做产品代码或运行新的质量实验；本报告不宣称已修复泛化质量问题。
