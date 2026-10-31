# 个人实例诊断与资源边界

这些限制针对单实例、同一信任域的个人部署。正整数环境变量在使用时校验，单位为字节、毫秒或小时；无效值拒绝相应资源操作。它们不是容器磁盘配额，也不能阻止同一信任域中的 shell 命令自行写任意文件。

| 环境变量 | 默认值 | 实际执行点 |
| --- | --- | --- |
| `LIGHTCLAW_DEBUG_PAYLOADS` | 关闭，只有 `1` 启用 | console、工具诊断线程、`last_prompt.jsonl` |
| `LIGHTCLAW_DIAGNOSTIC_MAX_BYTES` | 1 MiB | 每频道提示快照，新快照原子替换 |
| `LIGHTCLAW_DIAGNOSTIC_RETENTION_HOURS` | 24 小时 | 下一次提示快照操作清理过期文件；关闭 debug 时删除旧快照 |
| `LIGHTCLAW_AUDIT_MAX_BYTES` | 16 MiB | `audit/runs.jsonl` 追加前 |
| `LIGHTCLAW_AUDIT_RETENTION_HOURS` | 24 小时 | 下一次 audit 写入时按文件修改时间清理 |
| `LIGHTCLAW_STATE_MAX_BYTES` | 128 MiB | writeDurableJson 同目录普通文件合计，原子替换前检查，不删除旧状态 |
| `LIGHTCLAW_CONTEXT_MAX_BYTES` | 128 MiB | 每频道 context.jsonl，run 开始及 model prompt 前检查 |
| `LIGHTCLAW_HISTORY_MAX_BYTES` | 128 MiB | 每频道 `log.jsonl` 追加前，永不自动删除历史 |
| `LIGHTCLAW_ARCHIVE_MAX_BYTES` | 128 MiB | 临时目录中 `lightclaw-exec-*.log` / `lightclaw-bash-*.log` 合计；每个 stream chunk 写入前预留，包含等待落盘字节 |
| `LIGHTCLAW_ARCHIVE_RETENTION_HOURS` | 24 小时 | 下一次归档准入清理过期文件，跳过当前活动归档 |
| `LIGHTCLAW_ATTACHMENT_MAX_BYTES` | 256 MiB | 每个频道 attachments 目录合计，发布下载文件前 |
| `LIGHTCLAW_ATTACHMENT_FILE_MAX_BYTES` | 20 MiB | 每次附件下载按读取 chunk 累计，超限前不加入缓冲 |
| `LIGHTCLAW_ATTACHMENT_RETENTION_HOURS` | 168 小时 | 下载准入时清理目录中过期普通文件 |
| `LIGHTCLAW_DOWNLOAD_TIMEOUT_MS` | 30000 | fetch 和整个响应体读取共享 deadline |
| `LIGHTCLAW_DOWNLOAD_QUEUE_MAX` | 32 | 每个 ChannelStore 后台下载排队数量 |
| `LIGHTCLAW_MIN_FREE_BYTES` | 16 MiB | 受管写入前检查目标文件系统剩余空间 |

诊断默认只显示 payload 字节数及工具名、耗时、状态等元数据。显式 debug 启用后也会脱敏并截断每个字符串至约 4096 字节，敏感对象字段整项替换，深度与数组/对象长度有上限；单次结构化诊断共享 64 KiB 字符串预算及 2048 节点预算（JSON 结构与省略标记另计）。统一覆盖常见 API key、Bearer、口令、cookie、URL 用户密码、签名参数和 PEM；这是一套已知模式策略，无法识别所有业务秘密。不要将诊断目录当作可公开的数据。

SDK 自带 console logger 被替换，默认不序列化 SDK 原始请求、响应、异常对象，每个 logger 每分钟最多接纳 20 次诊断。ws error 等异常通过相同诊断策略处理。audit 保留结构化类型、状态、计数和脱敏的有界错误说明。用户最终回复及附件是功能输出；主回复及其长文本续篇不按诊断 payload 丢弃。

`log.jsonl`、`context.jsonl`、目标、inbox、操作记录是恢复所需的权威状态。原始对话和工具结果保留在信任域内，继续进入模型上下文，不因诊断脱敏而改变任务语义。`log.jsonl` 配额拒绝或 ENOSPC 会向调用方抛错，失败写入不加入 dedupe；调用方不得确认接纳。`context.jsonl` 在 run 开始及 model prompt 前做容量与剩余磁盘预检，超限不发起新模型请求；内部 SessionManager 的后续追加并非逐 chunk 配额接口，一次 run 的模型/工具响应可能超出此准入上限，下一次 run 会拒绝。writeDurableJson 对同目录普通文件执行总量与磁盘预检；原子替换占用新旧副本的临时磁盘空间，ENOSPC 仍会作为持久化错误传播。它们不能保证所有状态与工具文件的全工作区硬配额。控制、未知副作用、goal、inbox 永远不参与清理。

诊断容量或写盘失败只给出有界元数据 warning，不打断正常交付。达到 audit 配额时停止追加；该单文件在持续修改期间的旧行没有逐行 TTL，容量达到上限后需清理/备份，或等待文件过期后下一次写入清理。stdout 的轮转与保留由进程管理器负责；本模块限制内容，不控制外部收集器。

附件仅接受成功、大小/时间合规的响应，重定向拒绝以免凭证随重定向传播。先计数后缓冲，完整下载后写入独占临时文件并 rename，失败清理临时文件；不留下可被模型误当作完成文件的半成品。后台下载失败只记录诊断，附件路径可能不可读，任务需按缺失附件处理。飞书当前只消费文本与已有安全上传路径，未增加下载支持。

清理是使用时执行，空闲实例不运行额外清理定时器。文件修改时间是保留期基准；用户不应通过 touch 延长敏感快照生命周期。配额按目录/单实例计算，不包含其他进程并发写入、任意工具创建的文件、平台已收到的数据和外部日志系统。恢复状态需要运营者自行备份、审核与容量治理。

本批用临时目录、虚构凭证、mock fetch/SDK、faux provider 验证。未读取真实凭证，未调用真实平台或付费模型，未验证生产磁盘耗尽、真实 Slack 下载或真实 Docker。
