# 故障排查与运行边界

仅面向单实例同一信任域。先保存工作/控制目录并停止接纳，不扫描秘密文件或向业务会话试发。Node进程、工具容器、模型服务、消息平台是四个不同故障域。

|现象|检查与处理|
|---|---|
|入口main/types/bin不存在|运行原生local-release verify-dist；缺dist即未验收，不能借旧dist/工作区链接或跳过构建宣称可发行。当前禁止build，保留待验证状态|
|源码导入失败|核对source-manifest和依赖闭包；原生--help通过不证明tsx/工作区SDK干净安装完成；离线缺缓存就停止，不自动上网|
|--health显示held|只证明锁占用，不证明平台/模型健康。不要删除锁文件；核对自己启动的进程、最近运行元数据和未知任务|
|关闭未确认|Node保持锁等待处理。确认本次工具任务停止写入/退出，检查未决通知或平台请求；不要启动第二实例绕过|
|unauthorized stop/pause|核对真实平台sender，目标owner或显式admin名单；人工confirm仍仅创建者。无效/无权控制不得先中止其他人的执行|
|Docker拒绝启动|依次核对实际UID/groups、privileged/caps/no-new-privileges、namespace、挂载source及CPU/memory/swap/PIDs。只修本实例容器，不替用户操作现有业务容器|
|事件提前/未执行|日期需有效日历且带时区；超远期分段计时；合法过期one-shot启动时接纳一次，periodic不补历史周期；源保留/expired/unknown/dead分别排查|
|平台失败但产物已生成|保留本地结果与operation/inbox，投递unknown需按message ID人工对账，不能盲目重发；真实SDK或token刷新仍需专用账号验收|
|附件不可读|确认下载状态、大小/期限与当前频道路径，不使用其他频道/宿主路径补救；飞书入站文件未支持，不要当平台下载成功|
|配额/ENOSPC|权威写入失败拒绝接纳或停止新请求，保留原状态；不要清理goal/inbox/unknown operation。停止后备份恢复目录，人工扩容或审核历史；诊断写失败仅metadata告警|
|诊断信息不足|必要时显式LIGHTCLAW_DEBUG_PAYLOADS=1，保持短期、信任域内存储，完成后关闭并清理过期debug。工具结果/对话原文是权威状态，不能公开上传；已知模式脱敏不能覆盖所有业务秘密|

日志与资源默认值见resources.zh-CN.md。context仅在dispatch边界预检，一次运行可能超限；quota非全局/OS磁盘硬隔离，也不能阻止同信任域工具写任意文件。stdout轮转由本地进程管理器管理。显式--download导出是原始聊天功能输出，不受debug隐藏策略影响，只能在获准范围内安全重定向，不是可公开诊断日志。

重启/备份：正常停机后同时备份工作和控制目录，保留权限、配置引用及路径映射；空目录先离线恢复验证，再确保原实例停止后切换。不要对unknown状态自动重放任意bash。进程崩溃测试不证明断电持久性，模拟平台/容器也不证明真实集成。
