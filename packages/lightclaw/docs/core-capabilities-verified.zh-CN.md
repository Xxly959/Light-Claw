# 六项核心能力：实现依据、学习入口与边界

核对日期：2026-11-06。结论：会话记忆、工具执行、提示词预览、长期目标、运行恢复、状态备份均有当前实现及工程验证。这里的“已实现”限定为下文具体行为，不能扩展成自动记住所有事实、无限自治、任意副作用可重放或全环境无缺陷。

本轮重新执行18个具体回归文件，共214项通过；完整静态检查通过。新增session-memory.test.ts补充原先不够直接的记忆刷新/恢复测试，另修复备份源目录校验缺陷；没有调用真实模型或外发消息。此前同日的独立安装及真实飞书验收另见[最终验收报告](../../../docs/reports/FINAL-ACCEPTANCE-2026-11-06.zh-CN.md)。

## 1. 会话记忆

实现入口：[agent.ts](../src/agent.ts)的getMemory、createAgentRunner、run；[context.ts](../src/context.ts)的syncLogToSessionManager；[store.ts](../src/store.ts)。pi基础实现位于packages/coding-agent/src/core/session-manager.ts及agent-session.ts。

| 数据 | 位置 | 实际用途 |
| --- | --- | --- |
| 聊天日志 | `<workspace>/<chat_id>/log.jsonl` | 保存可检索的聊天记录；run前同步尚未进入会话的用户消息，排除当前消息、重复消息、机器人消息及飞书表单入口 |
| 结构化会话 | 同频道的`context.jsonl` | SessionManager持久化消息；Runner创建/重建时恢复，构造模型可用的会话上下文 |
| 共享记忆 | `<workspace>/MEMORY.md` | run开始时读取并加入系统提示，所有频道共享 |
| 频道记忆 | `<workspace>/<chat_id>/MEMORY.md` | run开始时读取，仅注入本频道的系统提示 |

它们不是同一份数据。MEMORY.md是明确写入的文本记忆文件，可由操作者或Agent借助工具维护；没有一个独立的后台服务保证自动提取所有偏好、消除矛盾或永不遗忘，也没有专用向量记忆检索流程。文件更新在下一次run开始时重新读取。

上下文压缩使用pi的能力。压缩后的有效模型输入是摘要、保留消息及后续消息，不保证原文所有细节都继续在模型窗口内；磁盘上有历史不等于每轮全量发送。工作区settings.json可以影响压缩设置，不能把默认开启写成不可配置。

会话键是频道/chat_id。一个群内成员共用群会话；当前不是按成员、平台话题分别开session。私聊/不同频道的会话文件分开，但全局MEMORY.md有意共享；host模式亦不提供操作系统级文件隔离。

证据：新增[session-memory.test.ts](../test/session-memory.test.ts)通过实际Runner的faux请求检查：同一Runner下一轮取得更新后的两级记忆；重建Runner仍取得上一轮用户/助手消息；另一频道取得共享记忆及自己的记忆，不取得A频道私有记忆或对话。assert在run返回后执行，不把faux回调里的断言错误吞进模型错误路径。

学习自检：分别指出哪段代码恢复历史、哪段代码刷新MEMORY.md；解释全局记忆为什么会跨频道出现，以及文本摘要为什么不是无损记忆。

## 2. 工具执行

实现入口：[tools/index.ts](../src/tools/index.ts)注册read、bash、edit、write、attach和两个goal工具；[agent.ts](../src/agent.ts)创建pi Agent/AgentSession并在beforeToolCall中检查预算、身份信任、频道能力与审批；[sandbox.ts](../src/sandbox.ts)提供Executor。

调用过程：模型提出工具名和参数 → 工具schema/Agent循环处理 → 应用策略与预算裁决 → 允许后执行工具execute → 返回结果或错误 → 模型据此继续。需要审批的调用先被阻断、创建票据；批准后对同一操作重新提出调用才可能放行。审批不能由提示词正文冒充。

实际命令由HostExecutor或DockerExecutor执行。名为bash的工具在当前POSIX host实现中调用`sh -c`，不应仅凭工具名假定一定由Bash解释器执行。非零退出、超时/取消和输出截断都有处理路径；截断输出可以另存完整归档，受配额约束。

attach经频道相对路径校验及宿主Python安全读取后交给平台SDK。工具可用不表示当前机器必然安装curl/git/python等外部命令，也不表示网络一定可用。当前没有独立注册的web_search工具；需要联网的任务可受Shell能力、审批和容器网络约束。

host工具使用当前OS用户权限。应用级策略不能当作完整操作系统沙箱；Docker模式还有启动校验、挂载与任务监督要求，共享容器和频道专属容器的边界也不同。

证据：agent-runner/runner-lifecycle/output-tools工程回归；此前独立安装产物已以faux驱动真实write/read并检查实际文件。真实模型固定回复验收禁用了工具，因此不能把那个回合称为真实模型选工具验收。此前真实Docker四项取消故障测试单独记录，不扩大成全部业务覆盖。

学习自检：找到模型提出调用、策略阻断、实际启动进程这三个不同位置；解释“模型说已写文件”为何不能代替读取文件核对。

## 3. 提示词预览

实现入口：[prompt-rewrite.ts](../src/prompt-rewrite.ts)、[prompt-input.ts](../src/prompt-input.ts)的createPromptRewriter/PromptDraftStore、[runtime.ts](../src/runtime.ts)表单分支、[feishu.ts](../src/feishu.ts)卡片及回调。

流程：原文 → 独立改写和约束复核 → 可编辑预览 → 用户确认 → 主Agent执行。改写请求无工具、没有主会话历史，JSON数据包使用context:null；系统元指令、原文和候选只用于独立请求。预览展示taskType/changes/assumptions/openQuestions，说明与可编辑任务正文分开。

草稿状态为offered → running → preview → running → consumed，也可进入failed；直接发送走offered → running → consumed。确认检查创建者、频道、原卡片、状态及有效期，再消费一次。确认后的文本不再次改写；失败、重复点击或超时不会自动变成一次Agent执行。有效期从原表单创建时计30分钟，预览不会重新计时。

原文表单上限1000个UTF-16单位，预览/最终确认上限12000；较长候选在卡片中按顺序分段，确认时拼接。不要把这些限制混称为模型Token上限。

主Agent只取得最终确认文本，并保留既有正常会话。原文、改写元指令、说明和预览不自动追加为主会话；日志同步也排除飞书/prompt预填。普通聊天先发送过的原文仍属于普通历史，旧历史/摘要不会追溯清理。草稿、inbox及聊天日志仍可保留记录；群卡片对群成员可见。当前入口为飞书，Slack没有增加同一表单功能。

证据：prompt-card/prompt-redesign/context-prompt/platform-contract回归，涵盖确认、重启、伪造身份及失败关闭；此前用户真实客户端已完成编辑确认，manual-result.json验证了草稿consumed及主context只含最终文本的边界。约束检查与模型复核不保证所有改写语义正确或普遍提高任务质量。

学习自检：追踪一次原文从控制草稿到最终用户回合；说明“临时模型上下文”和“零落盘”为什么是不同要求。

## 4. 长期目标

实现入口：[goals/commands.ts](../src/goals/commands.ts)、[goals/store.ts](../src/goals/store.ts)、[goals/verifier.ts](../src/goals/verifier.ts)、[tools/goal.ts](../src/tools/goal.ts)，以及runtime的跨run循环。

`/goal <目标>`创建当前频道目标；`/goal status|pause|resume|cancel`查看或控制。每频道同时只允许一个未结束目标，不是多任务项目管理数据库。状态保存在工作区外的`<control>/<chat_id>/goal.json`，包含owner、revision、状态、轮次、进展和验收记录。模型通过goal_progress/goal_complete提出进展与完成申请，确定性代码决定状态。

| 状态/情况 | 行为 |
| --- | --- |
| active | 当前run结束后，符合条件则继续下一轮 |
| paused | 不自动续跑；可由有权限用户resume |
| awaiting_confirmation | 等待目标创建者确认当前申请，不自动当作完成 |
| completed/cancelled | 停止推进当前目标 |
| 超限、失败、停滞、投递或预算问题 | 按对应条件暂停/结束本轮，不能无限运行 |

普通自然语言创建默认人工验收。Agent需声明交付文件或无文件交付的原因；完成申请采集产物快照后等待创建者`/goal confirm <goalId> <attemptId>`。确认还检查申请有效期、版本和产物是否变化。

`/goal create`的结构化规则可指定文件存在、contains和相对创建基线的changed条件；命令验收仅支持Docker，按预定命令、sourcePaths和输出条件核验。返回0或文件匹配只证明预设检查通过，不自动证明整个开放任务语义正确。目标evidence和verificationHistory当前仅保留最近20项，不是无限历史。

当前本地配置GOALS/ACCEPTANCE/CONTROLS均开启，轮次上限8、连续失败2、连续无进展2。若关闭ACCEPTANCE，代码允许标记self_reported完成，不能再称为已验证完成；若关闭CONTROLS，相应轮次保护会变。配置核对不等于运行进程自动热加载。

证据：goals/goal-commands/goal-verification/manual-completion-binding/runtime-goal-loop/runner-lifecycle回归，验证真实状态文件、文件条件、拒绝过期/错误创建者确认、跨轮推进及申请完成后停止工具链。部分执行器/平台为faux或mock，没有新做真实平台长期业务演练。

学习自检：画出一次run与跨run目标循环的边界；找到谁能申请完成、谁能确认，以及哪个开关会改变完成语义。

## 5. 运行恢复

实现入口：[durable-inbox.ts](../src/durable-inbox.ts)、[queued-events.ts](../src/queued-events.ts)、[operations.ts](../src/operations.ts)、[recovery-control.ts](../src/recovery-control.ts)、[goals/control.ts](../src/goals/control.ts)和runtime.start/shutdown。

持久inbox负责消息是否接纳、执行与待核对；它不同于context聊天历史，也不同于目标状态。稳定ID和请求指纹用于去重。实例内核锁限制同一控制目录只有一个写入实例。

重启时：未到期queued可恢复；中断的running变unknown（达到尝试限制可为dead），不自动重跑；未知记录阻止相关频道后续排队与目标自动推进。completed表示这条消息已消费，不等于业务目标成功。active目标也只有满足恢复条件时才续跑；paused/awaiting_confirmation不会擅自继续。

`/recover list|show`查看，resolve在核对后标记处理且不重放；retry必须给当前版本、ACK_DUPLICATE_RISK和说明，仍需身份、频道、空闲及审计检查。OperationJournal可对支持稳定operation ID及结果查询的服务进行核对；当前平台通知不能据此保证安全重放，未知结果需要人工处理。

任意Shell、邮件或外部写入没有统一事务保证；不知道结果时重发可能重复。代码不提供跨机器租约、通用exactly-once、断电或磁盘损坏后绝不丢失的保证。恢复不是撤销已发生的副作用。

证据：recovery-control/inbox-lifecycle回归；recovery-faults实际终止/重启独立进程并使用loopback mock服务持久回执。该服务支持去重查询，不能推导所有第三方API都支持。没有在你的真实业务任务中故意制造崩溃。

学习自检：给出queued、running中断、外发结果未知三种情形的不同处置，解释为何不能删除锁/账本后直接重试。

## 6. 备份与从备份恢复

实现入口：[scripts/state-backup.py](../scripts/state-backup.py)，使用backup/verify/restore三个显式命令。它是手动运维工具，当前没有自动定时备份、远程备份服务或完整机器镜像功能。

backup同时保存workspace及control：会话、记忆、产物，以及目标/inbox/审批/操作账本等文件。它需取得同一实例锁，所以正常做法是先停机；运行实例持锁时拒绝备份。源workspace/control必须已经存在且均为目录；缺失或误指向普通文件会在创建锁或输出前拒绝。输出目录必须全新，三个根目录不能相互包含，文件生成SHA-256及大小清单。遍历源树发生权限等错误时明确失败，不静默漏掉子目录。

verify校验文件集与哈希；restore先校验，再恢复到两组不存在的新目录，不覆盖当前数据。恢复后须显式配置新工作/控制路径，并保证原实例停止；同机可检查源控制目录锁，跨机器需要人工停止旧宿主。两者均使用POSIX fcntl/flock，本轮在macOS验证。

过滤依据是文件名/扩展名和目录：`.env*`、auth.json、实例锁/健康心跳、`.pem/.key/.p12`、`.ssh/.aws/node_modules`等会排除；链接/非普通文件会拒绝。它不是任意内容的密钥扫描器。如果把密钥写进普通业务文件、日志或其他名字的配置，该文件仍可能被备份；备份数据本身也需要保护。不能把脚本输出credentials:excluded解释成绝对无秘密。

哈希用于校验当前备份文件与清单一致；没有加密、签名、远程容灾和自动补齐平台/模型凭证；按文件清单恢复，不保留所有空目录、ACL及扩展属性等完整文件系统元数据。发生中途I/O失败可能留下不完整新目录，校验未通过就不能用它恢复。新环境还需要单独准备运行依赖与凭证。

证据：[backup-restore.test.ts](../test/backup-restore.test.ts)8项回归实际运行Python脚本，在虚构目录完成双根往返、排除.env、持锁拒绝、损坏备份拒绝及源路径缺失/普通文件及不可读子目录拒绝，并检查未写无效源或恢复目标。restore执行同一清单校验路径。本轮没有停机备份或恢复你的真实数据。

学习自检：区分进程重启恢复、从备份恢复、重新安装程序；说明每一种分别解决什么问题，哪些外部副作用仍不会被撤销。

## 本轮证据与阅读顺序

证据目录：`docs/verification/2026-11-06-capability-audit/`。verification.json记录最终18文件214项及完整命令；regressions.log包含完整输出，integration.log保留前轮平台适配器/mock SDK与Runner集成输出；check.log保存最终完整静态检查，check-initial.log保留补充记忆回归后的首次检查；config.json只记录非敏感功能开关。历史独立安装/真实平台结果保留原时间与边界，不改写为本轮重新执行。

先按[学习路线](learning-path.zh-CN.md)追普通消息，再按本页六节对照代码和测试。pi提供模型接口、Agent loop、SessionManager及压缩等基础设施；LightClaw提供平台编排、文件记忆接入、提示词流程、目标、控制与恢复。实现存在、工程回归通过和模型完成真实业务任务是三种不同结论。

本轮实际修复：旧备份脚本对不存在的工作区、普通文件工作区及不存在的控制目录可返回成功，导致漏备一侧；原因是os.walk对无效工作区不抛错且locked会创建控制目录。先新增负例，观察3失败/4通过，再在backup分支验证两源均为现有目录，7项通过。进一步以无读权限子目录复现os.walk默认忽略遍历错误的漏备，增加onerror抛错后8项通过；权限用例仅在非root下有区分力，本轮macOS实际执行、未跳过。红绿记录见backup-red.log/backup-green.log及backup-walk-red.log/backup-walk-green.log。这个发现也说明工程测试通过不能替代逐项核对边界。此前安装验证快照不包含这项后续脚本修复；备份使用当前仓库的scripts/state-backup.py，未冒称旧安装包已重新验证该修复。
