# 平台交付契约与真实验收待执行清单

状态：Slack、飞书真实平台均**未验收**。本批没有账号/会话/消息范围授权，未搜索凭证、连接真实平台或发送消息。platform-contract.test.ts对两个真实适配器运行同一组mock契约；main-lifecycle/attachment-upload/platform-notifications等分别验证业务与文件边界，不能等价于真实SDK网络行为。

|项目|共同契约/实际离线证据|平台差异与未验证处|
|---|---|---|
|连接/关闭|实际adapter.start/stop调用mock SDK，正常初始化用户/会话与关闭队列|Slack Socket Mode + Web API；飞书WSClient+HTTP。真实DNS/TLS/auth、SDK断线退避、token刷新未验收|
|重投/重连|模拟SDK重连后的同一message ID重投，durable inbox只执行业务一次|Slack用channel+ts，飞书message_id；回调模拟不证明真实断网重连|
|权限/限流|业务错误或mock429向调用方传播，应用层不盲目重发|Slack WebClient retry=0/rejectRateLimitedCalls；飞书业务code需非0报错，SDK内部策略仍需实测|
|附件|两端当前频道普通文件字节上传；越界、link/race、体积拒绝|飞书im:resource权限、空文件/平台文件限制需实测；入站飞书当前只消费文本，不伪称支持文件下载|
|长回复|runtime保守预览上限：Slack35000个UTF16单位；飞书JSON序列化UTF8≤18000字节；不切断Unicode码点|不是声明平台当前正式上限。完整主回复仍在本地权威会话；直接SDK差异及编辑频率限制待验收|
|消息ID|发送必须取得非空ID，缺失即失败|Slack ts；飞书message_id；缺ID不能伪称已交付|
|失败与保存|mock投递失败保留结果日志及unknown inbox；production runtime最终通知 journal另记未决|真实远端可能已经接收但本地超时，需人工对账，不能自动认定未发出|
|stop身份|两个adapter均传平台sender与origin，runtime先判断owner/admin再取消|平台认证真实性属于SDK/真实账号验收；合成事件不能伪装人类授权|

公开资料只读核对：Slack [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) 连接URL会刷新，应由SDK处理；[限流](https://docs.slack.dev/apis/web-api/rate-limits/) 按方法/工作区计量、429附带Retry-After，不应该把突发接受当持久投递保证。飞书 [编辑消息](https://open.feishu.cn/document/server-docs/im-v1/message/update) 与 [上传文件](https://open.feishu.cn/document/server-docs/im-v1/file/create) 网页正文未被当前只读工具解析，未声称核对其所有最新限制；本地安装的SDK types声明im.v1.file.create返回根file_key、上限30MB且不允许空文件，本项目统一更保守20MiB。实际scope及编辑限制以获批测试账号实测为准。

## 等待用户提供的范围

必须先明确：测试平台/专用应用或账号、凭证的**指定路径或注入方式**、专用测试会话ID、允许发送/编辑/撤回/上传的消息数量与时间窗口、参与者名单，以及是否允许改变专用应用scope和临时断网。未给出这些内容前不执行以下步骤。不得使用业务频道、任意联系人或自动搜索到的凭证。

## 获批后逐项执行（当前未执行）

1. 固定源码/Node/SDK/工具容器digest与两个持久目录；先跑本批离线回归，`--health`只能探锁。用faux runner，不调用付费模型；所有消息带唯一BATCH4-TEST前缀和operation标签。
2. 只连接专用应用和会话。核对bot身份、接收者和scope，发送一条固定短回复；保存本地trace与远端message ID，确认仅指定人员可见。
3. 发送同一平台事件/测试回调的重复样本，检查只有一次业务效果；不得凭相同文本假冒同一事件ID。
4. 在获准范围内短暂断网，恢复连接并在停止后重启，检查旧事件重投、已接纳/排队/unknown状态；记录SDK真实重连时间与最终投递，不把socket connected当收发成功。
5. 专用测试应用使用缺少权限的token/scope测试失败（不改业务应用）；不刻意打爆真实平台限流，429以离线注入为主，真实出现时记录Retry-After并停止自动发信。
6. 上传虚构TXT（正常、小于上限），验证文件名/字节/当前频道；越界与敏感路径仅离线测试，不让真实平台接触虚构越界以外的文件。
7. 固定Unicode长回复验证预览/本地完整结果；少量编辑、线程回复、获准撤回，记录双方平台差异，不循环刷屏。
8. 通过mock/faux固定业务结果再注入最后一次网络失败，核对持久结果与投递unknown；按远端消息ID人工消除不确定性，不能靠自动重试制造第二条副作用。
9. 核对owner、普通非owner、显式admin的pause/resume/cancel/stop和创建者confirm，验证拒绝动作前无abort；清理仅本次有标签的消息/文件（需授权），关闭专用进程及本批创建容器。
10. 填入真实验收日期、平台/SDK版本、每项message ID/脱敏trace、结果与残留资源。未做或失败项继续标未验收；不扩展为生产使用/多租户隔离证明。
