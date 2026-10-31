# 新真实实验协议和pilot记录

模型认证已获用户明确授权，官方/models确认deepseek-flash。凭证只在工作进程内存中读取，不复制到仓库、工具工作区或容器。parent env只允许PATH/HOME/TMPDIR及代理配置，不把其他模型密钥传入工具环境。

冻结旧ablation数据集的12个final任务及原检查器；输入、预期、严格比较和零工具错误阈值不变。使用Node24.19.0、thinking disabled、temperature0.2、max_tokens2048、每重复对应不同请求seed。供应商收到seed不等于承诺确定性。容器镜像digest与旧实验一致，非root、禁网、CPU1/512MiB/pids128/cap-dropALL，只挂载单slot任务目录；每个任务是新Node进程，保存session与产物后清除该slot。3并发，各slot隔离，避免模型看到其他任务答案。

pilot两个版本均保留。第一次发现原mom的AgentSession会先经ModelRegistry校验凭证，单改Agent.getApiKey不足；适配补充AuthStorage运行时密钥（不落盘）。适配原mom只更换模型/认证及导出factory，不改提示词、工具或循环。第二次pilot三个运行器均完整运行；旧及当前LightClaw在goal_complete终止后仍返回toolUse，当前主消息没有最终摘要。单独记录评价/运行合同冲突，不改评分器。自动/人工两个faux回归先红，随后只修产品最终投递及运行结束状态，原始模型toolUse仍保存在session。

noise：上游mom在同一加固Docker条件和当前功能全部关闭(host)各5重复×12任务，共120。两环境不同，不能将这个上游条件当作纯host原始基线；保留独立环境诊断。517次请求、1519518报告Token，所有120次都有完整记录。功能关闭组58/60严格通过、60/60产物正确；原mom加固容器组1/60严格通过、60/60产物正确，主要与cwd/缺失命令有关。必须另跑原mom-host基线，不在看到结果后改镜像或安装工具抹去失败。

noise-host：原mom-host5×12=60，400请求/150万报告Token上限。模型可用原始host工具访问任务目录外路径，自动审批拒绝启动，已向用户申请明确授权；未获授权前不运行此阶段或含host的后续矩阵。

matrix：16开关组合：all-off复用noise前3次；其余15组各3×12，再加旧LightClaw-all-on3×12，总576新任务。goal开关开启时，同一用户目标经GoalStore创建为自动文件存在性验收，不把正确答案注入prompt；goal循环适配main的继续/recordCycle/暂停逻辑，非真实IM投递。队列/TTL单请求时不激活；优化开关不强行应用已被拒绝的候选，候选实验沿用历史独立冻结结果。以上三领域在该任务集不能被解释成完整的生产因果检验。

每阶段在首次付费请求前生成freeze.json，锁定任务、源码哈希、镜像、worker脚本、参数、种子和预算。matrix最多3500请求/1300万报告Token；after36任务最多400请求/120万报告Token。每任务外部120秒、最多30请求、最多8目标循环，均独立于产品控制开关；触发外部保护会作为失败记录，不算产品熔断。parent在发送前集中预留请求并逐响应计Token；Token上限是派发边界，最多3个在途响应可超过它，不承诺硬账单上限。不知道实际价格，不报告货币费用为0。

当前产品source-before与修复后的source-after独立保存。当前before矩阵只导入冻结source-before，不受后续产品修复影响；修复后单独after阶段使用source-after。原始mom源自3ffc2b430，源文件SHA及模型/auth适配均可审计。所有pilot失败、正式失败和外部保护都留在live/raw，不事后删样本。

## 2026-10-22 完整重复预注册

ordinary 原批108项耗时约6小时，其中68项进程非零退出（67份缺失run记录，另1份已有run）；不删除、不覆盖、不仅统计完成者。无法确定休眠、网络或执行器原因，不归因于功能。新增 ordinary-replication，在相同12任务、三重复、相同三条件、相同seed/温度/上限和顺序下完整重跑108项；两批分开展示，并展示合并失败分母。只依据完整重复是否支持无害简化来决定普通任务隐藏goal工具方案；不声称时间点之间存在严格随机化。上限500请求、150万上报token、单任务120秒、并发3。host两批已获用户明确授权。
