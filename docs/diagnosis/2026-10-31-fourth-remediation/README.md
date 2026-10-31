# 第四批：个人 Agent 本地交付验收

定位为单实例、同一信任域个人Agent。当前代码/离线机制已实施；**尚不构成可发布、可生产部署的二进制发行**。没有提交、推送、发布、读取真实API凭证、连接真实平台或调用付费模型。

- [部署、启动、健康、关闭、备份恢复](../../../packages/lightclaw/docs/deployment.zh-CN.md)
- [故障排查](../../../packages/lightclaw/docs/troubleshooting.zh-CN.md) / [资源策略与默认值](../../../packages/lightclaw/docs/resources.zh-CN.md)
- [实际复现命令与日志](verification.md) / [独立审查及修复](review.md)
- [真实平台待执行清单](platform-acceptance.md) / [五条简历主张证据和精简描述](resume-evidence.md)
- final-source-manifest.json与final-source.tar.gz：最终688文件源码材料；final-deployment.json：本地pack/安装验收结果。local-source是审查材料，含受保护评估资产，不可当Agent数据目录。

|领域|实际结果|范围/未验证|
|---|---|---|
|前三批|第三批47个交付hash全部匹配；第一/二批记录和历史模型数据保留；v2 --check通过|旧冻结报告不作为本次新实验，源码漂移应重新冻结，不能覆盖历史|
|入口|补src/index对应原main/types声明；源码public API导入、无凭证--help/本地锁health通过|dist没有新构建；不得借旧dist宣称可安装|
|源码发行|688文件逐hash核验，tracked578/untracked110显式记录、无软链接|依赖和代码完整性清单不是签名/生产验收|
|本地pack|offline/ignore-scripts打包18文件成功；独立解压原生工具--help通过|archive没有dist；没有执行Agent npm bin|
|独立安装|offline install实际退出1，ENOTCACHED；verify-dist退出1|明确NOT VERIFIED；不联网补缓存，不编译或绕过build限制|
|平台|两端统一真实adapter/mock契约14项通过；主流程/附件/通知回归通过|真实飞书/Slack收发、断网重连、scope、SDK限流行为均未验收|
|权限|stop传actor；控制权限/状态先于abort，绑定当前run；owner/admin/creator确认规则可检验|共享工作区和任意工具属于同信任域，频道不等于租户隔离|
|Docker|配置/实际UID+groups、cap/privilege/ns/mount/resources、startup探针有界；tmpfs贯通控制隔离|全部mock。取消测试是本机Python监督器shim，真实Docker4项跳过，无真实容器操作|
|调度|非法日历/无时区拒绝，超远期分段timer，合法过期one-shot重启接纳一次|不限制过期历史年龄，periodic不补历史周期；不是实时调度保证|
|诊断/资源|默认payload隐藏，opt-in脱敏/有界；历史/控制持久化失败拒绝，诊断失败非致命；附件超时限额、归档预留与保留策略|已知模式不能识别所有秘密；context有单轮超额窗口；非全局OS硬配额，stdout由进程管理器轮转|
|回归|54明确文件：485 passed、4真实Docker skipped、0失败|没有其他包测试替代本包证据，未运行npm test|
|静态检查|rtk proxy npm run check退出0，最终无自动修改|完整输出保留，不代替测试或安装验证|

保留所有既有dirty/index工作，source-changes.json列本批增量。必要归档/失败日志均保留；本批临时服务由测试清理，没有生产服务或容器需要撤销。基线/源码材料/npm cache等有意留档目录列表见verification；不对未属本批的资源执行清理。

剩余产品限制：manual验收快照绑定与墙钟确认TTL仍未修复（第三批已检出）；任意bash不承诺幂等；Token上限是用量反馈阈值；真实模型语义/性能/自动候选收益未验证。legacy评测/优化完整提示诊断需要显式DEBUG_PAYLOADS，默认只保留必要计数。编译reliability工具仍有源码/tsx/资产定位前提，须未来构建与逐bin验收；当前仅承诺源checkout工作流。

下一次真实平台测试必须由用户指定测试账号、会话、凭证路径和消息授权范围；本批仅交付步骤，不把这份文档视作授权。编译/依赖联网安装也需另行按环境限制执行；当前不发布未验证tgz。
