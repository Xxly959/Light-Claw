# LightClaw 源码部署与日常运维

当前交付面向单实例、同一信任域个人Agent。Node在宿主运行；Docker仅执行工具。当前生产实例继续使用源码入口；2026-11-06已获准在隔离副本完成5包新鲜构建、独立安装和有限飞书私聊/模型验收，详见../../../docs/reports/FINAL-ACCEPTANCE-2026-11-06.zh-CN.md。安装产物未替换当前服务入口。没有多租户/高可用承诺。

## 首次启动

需要Node.js>=22.19.0、npm、Linux/macOS宿主、宿主Python3（3.9+）、平台机器人应用及模型凭证。Docker方案还需已安装并运行的Docker。先安装仓库依赖，再从根目录：

```bash
cp packages/lightclaw/config.env.example .env
# 在本地编辑.env，不要覆盖已有配置或把密钥发到聊天
bash scripts/start-lightclaw.sh
```

启动器载入.env，校验所选平台必需变量，从仓库根执行源码。直接用 `npx tsx packages/lightclaw/src/main.ts` 不载入.env，须事先导出变量。工作区与控制目录必须分离：模板使用./lightclaw-data和./lightclaw-control。启动器从任意当前目录调用时都会进入仓库根，保证相对模型/状态路径一致。

模型provider/ID必须在pi注册表或显式指定的LIGHTCLAW_MODELS_FILE中存在。模板示例来自当前本地模型目录，不代表供应商实时可用性已验收。私有网关不要把私有模型ID替换成另一个内置模型：配置上游ModelRegistry JSON、对应provider/ID、OPENAI_API_KEY，必要时OPENAI_BASE_URL。不要提交模型文件中的密钥。主备用LIGHTCLAW_MODEL_FALLBACKS，见故障排查。

飞书需机器人能力、长连接事件im.message.receive_v1；卡片还需card.action.trigger和支持JSON2.0的客户端。附件权限按应用配置，缺权限应明确报错。私聊直接发送，群聊@机器人。任务入口可手动置顶。Slack保留Socket Mode接入，具体权限见slack-bot-minimal-guide.md；本轮不冒称已重新做完整真实Slack验收。

## 工具权限与Docker

模板默认host，意味着工具以当前OS用户运行，不提供文件系统隔离。不要把工作区和控制目录的分离误当host任意shell的安全边界。多人共用前设置可信用户与频道能力策略，见enterprise-hardening.zh-CN.md。

需要Docker时先创建再启动：

```bash
bash packages/lightclaw/docker.sh create ./lightclaw-data
# .env中设LIGHTCLAW_SANDBOX=docker:lightclaw-sandbox
bash scripts/start-lightclaw.sh
```

容器非root、资源受限；宿主Python负责安全附件读写，容器Python负责任务监督。容器默认网络为none，需要联网工具时应在创建前显式设置LIGHTCLAW_SANDBOX_NETWORK=bridge；不影响宿主平台连接与模型请求。全局共享容器不是租户隔离，频道专用容器只限制工具文件访问；宿主仍会将全局MEMORY.md注入模型上下文并加载全局技能元数据。挂载规则见sandbox.zh-CN.md。定时事件的真实可见路径应与所选挂载方式一致。

## 日常操作

- 普通消息直接执行；/prompt或任务入口打开表单。优化并预览仅用独立无工具请求生成JSON候选并复核，原卡片显示改动、假设、待确认项。编辑并确认后才执行；控制命令写在普通聊天中，输入框里的/approve、/goal只是任务数据。
- /goal创建持续目标；status/pause/resume/cancel与创建者确认见goals.zh-CN.md。目标的产物验收属于运行功能，与已删除的Agent效果评测无关。
- stop取消当前工作；只有有权限的用户可控制对应任务。模型说完成不等于目标已验收。
- /approve处理受控操作；未知结果先/recover核对，不能直接删账本、锁或反复重发。重启只恢复排队工作，已执行结果未知的任务不会自动重放，详见recovery.zh-CN.md。
- 提示词草稿、inbox与审计仍留存；只是不自动加入模型上下文，不是零落盘或群卡片私密。

## 健康与停止

```bash
npx tsx packages/lightclaw/src/main.ts --help
npx tsx packages/lightclaw/src/main.ts --health=./lightclaw-data --control=./lightclaw-control
npx tsx packages/lightclaw/src/main.ts --isolation-report ./lightclaw-data --sandbox=host
LIGHTCLAW_CONTROL_DIR=./lightclaw-control npx tsx packages/lightclaw/src/audit/cli.ts ./lightclaw-data --last=20
```

审计示例使用模板中的控制目录；自定义部署需设置与运行实例一致的LIGHTCLAW_CONTROL_DIR，CLI不会自动读取.env。上述探测不发试验消息。健康JSON中的lock、runtime和platform各有含义；锁持有不等于平台就绪，ready不证明模型可用。心跳过期、权限失败、空模型回复等处理见troubleshooting.zh-CN.md。模型报价缺失时cost=0不代表免费。资源/保留期以resources.zh-CN.md为准。

正常停止使用Ctrl-C或对确认身份的进程发SIGINT/SIGTERM，等待任务收敛与内核锁释放。更新源码后，只有实例空闲（无排队/执行/活动目标/已开始操作）才进行受控重启；不强杀或启动第二实例。不要因锁文件存在就删它。

## 备份与恢复

```bash
python3 -I packages/lightclaw/scripts/state-backup.py --help
python3 -I packages/lightclaw/scripts/state-backup.py backup --workspace /绝对路径/work --control /绝对路径/control --out /全新路径/backup
python3 -I packages/lightclaw/scripts/state-backup.py verify --backup /绝对路径/backup
python3 -I packages/lightclaw/scripts/state-backup.py restore --backup /绝对路径/backup --workspace /全新路径/work --control /全新路径/control
```

备份须使用已存在的工作区和控制目录，缺失或不是目录会明确拒绝；获得同一实例锁前先停机；校验文件清单/哈希，拒绝链接，排除.env/auth/私钥/运行锁心跳，恢复禁止覆盖现存目录。恢复后显式设置新控制目录。跨机器前须停止旧宿主，不提供跨主机租约。源码回归使用虚构目录，不代表已读取/恢复你的真实数据。

## 工程维护与发布边界

npm run check做静态检查，不运行测试。只执行获授权的具体回归文件；没有Agent效果评测、benchmark或候选晋升CLI。三个保留命令为lightclaw、lightclaw-audit、lightclaw-goal-migrate。

scripts/local-release.mjs只准备源码清单；verify-install.mjs plan只准备安装验证方案，不构建或联网。安装验证要求获准的新鲜编译产物/完整离线依赖缓存。本次用户明确允许隔离构建与安装验证，已验证5包及3个CLI；未运行dev/npm test、提交、推送或发布。此授权仅覆盖本次验证，不修改AGENTS.md的日常命令规则。

如要向专用飞书会话发运维试验消息，scripts/acceptance-plan.mjs platform提供清单，platform-check --scope校验非敏感范围，不读取凭证引用或执行动作。原model实验计划已删除；平台清单不是效果评测，也不自动授权外发。
