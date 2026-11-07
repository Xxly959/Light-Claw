# LightClaw 最终功能与安装验收（2026-11-06）

## 结论

个人、单实例、同一信任域的项目范围已完成工程收尾，当前机器可运行，可以开始学习。独立构建、安装及飞书真实交互已有本轮证据。当前生产进程继续从源码运行，未替换成隔离安装的入口；未提交、推送或发布。

本报告补充并更新 PROJECT-CLOSEOUT-2026-11-06.zh-CN.md 中“尚未构建/安装/真实验收”的阶段性限制，不改写历史结果。不承诺所有任务成功、跨平台全覆盖或多租户生产能力。

## 已完成的验证

| 验证面 | 本轮结果 | 证据 |
| --- | --- | --- |
| 静态检查 | npm run check完整通过：748文件、browser-smoke、web-ui与example；无错误、警告或info | 完整终端输出，最终check.log |
| 功能回归 | 66文件657项通过 | ../verification/2026-11-06-final-acceptance/regressions.log |
| Docker故障与发布回归 | 2文件10项通过；Docker真实取消、超时、SIGTERM、SIGKILL各1项 | docker-and-release.log |
| 新鲜构建 | Node v22.22.2，隔离副本依次构建tui/ai/agent/coding-agent/lightclaw成功 | build-*.log |
| 独立安装 | 5份tgz，干净HOME/npmrc、独立node_modules、离线且禁用lifecycle；库导入与3个CLI通过 | install-result.json；私有目录完整verification.json和00–09.log |
| 安装后真实工具 | 原生Node运行安装产物，faux模型驱动真实write/read，实际文件、2次工具调用、context落盘通过 | installed-tools-result.json |
| 安装后真实API | 独立改写与约束复核、无工具Agent固定回复、私聊发送/更新、虚构文件上传通过 | live-result.json |
| 真实客户端链路 | 用户实际打开表单→优化预览→编辑→确认；草稿consumed，原生飞书界面出现Agent回复 | 用户回执、manual-result.json |
| 上下文隔离 | 最终文本进入最后一个Agent用户回合；原文及本次改写changes未出现在主context.jsonl | manual-result.json |
| 服务状态 | 源码PID27095身份、心跳、ready、平台连接及内核锁检查通过，未重启；队列/运行/活动目标/改写/已开始操作均0 | restart.mjs只读检查；runtime-result.json |

合计68个不同工程测试文件、667项测试通过。原生安装产物功能脚本另记，不混入Vitest数量。Docker故障测试验证受控容器内任务停止与清理，不证明所有频道容器配置或全部Docker业务链路。

确切命令见 ../verification/2026-11-06-final-acceptance/commands.md。测试从packages/lightclaw包根运行具体文件，未运行npm test或npm run dev。构建仅在用户明确允许后于隔离副本执行，不修改AGENTS.md日常限制。

## 真实验收的范围与实际结果

用户授权当前私聊有限验收：最多5次发送、5次更新、1份虚构文件，不向群聊发送、不修改权限或执行业务任务。自动脚本持久预留后实际send2/edit1/upload1，未启动第二个WebSocket连接。随后用户自行完成客户端交互，助手仅只读核对界面与状态，没有代替用户点击确认。

旧scope配置实际指向群，chat.get返回group；脚本在零发送、零更新、零上传时停止。之后从真实入站dm定位目标，实际API确认p2p才继续，未向旧群发送验收内容。私有标识、凭证、完整收据留在用户私有目录，公开证据仅保留脱敏结果。

人工表单原文为“只回复：收尾验收通过”，最终编辑内容实际为“人工确认验收通过”，草稿已消费。Agent作了确认并提及既有会话任务；最终文本没有保留“只回复”限制，因此不把这个回合算成严格字面输出测量。安装产物另用无工具、独立会话确实返回固定文本LIGHTCLAW_ACCEPTANCE_OK。没有Agent效果评分或模型能力实验。

主Agent保留既有对话历史；隔离范围是本次未确认原文、改写系统提示及中间元信息。草稿/inbox/聊天日志仍留存，不能称为零落盘。已有回归同时验证独立改写请求及重启后日志同步隔离，真实会话记录补充验证最终文本边界。

## 产物与运行方式

- 独立安装目录：`/Users/x/.pi/lightclaw/releases/20261106-final/independent-verified/install/`。
- 5份安装包：同级`archives/`，名称、字节数与SHA-256见install-result.json。
- 隔离构建副本：`/Users/x/.pi/lightclaw/releases/20261106-final/source/`，第三方构建依赖复用现有环境；正式安装没有复用该node_modules。
- 697文件的源码审阅材料独立校验；5包src与package.json共298文件逐项哈希匹配构建快照。文档更新不冒充重新编译；见source-parity.json。源码审阅材料不是完整仓库安装器。
- 当前服务仍由`bash /Users/x/Light-Claw/scripts/start-lightclaw.sh`加载本地配置，从源码入口启动。真实配置、模型文件、auth与原业务数据未被替换。

## 遇到的问题及边界

首次离线安装因原npm缓存缺少公开依赖元数据ENOTCACHED失败，保留independent/05.log；在干净配置下预备公开npm依赖缓存后，新的独立离线安装通过。首次Docker测试因PATH没有/usr/local/bin而ENOENT失败；补齐测试环境PATH后4项通过，未修改产品逻辑或降低断言。

真实API收据的model字段仅记录固定Agent回合，不含改写/复核用量；providerReportedCost=0不构成整轮免费或总费用证明。没有读取真实平台业务文件，也没有对真实数据执行备份恢复；相关回归使用虚构目录。未重新进行真实Slack全流程、Linux新机器部署、长时压力或全平台权限矩阵验收。

预先存在的dirty工作全部保留。原有独立评测代码删除、提示词重做及启动器修复属于此前工作项；本项补充验证脚本、证据、部署/范围文档与工程记录，没有新增产品功能。

## 同日后续六项能力复核

后续逐项核对新增记忆刷新/历史恢复/频道边界回归，并在备份负例中发现源路径无效、目录不可读可能静默漏备却报告成功。当前仓库state-backup.py已增加既有源目录检查及严格遍历错误处理；记录见packages/lightclaw/docs/core-capabilities-verified.zh-CN.md和docs/verification/2026-11-06-capability-audit。上述已验证的隔离安装快照早于这项脚本修复，不包含该修复，本次没有再次构建或安装；备份操作应使用当前仓库脚本。原有模型/平台验收证据保持原日期和范围。
