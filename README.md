# LightClaw

**在飞书和 Slack 中执行任务，保存进度，并核验完成结果。**

[English](packages/lightclaw/README.md) · [使用指南](packages/lightclaw/README.zh-CN.md) · [架构](packages/lightclaw/docs/architecture.zh-CN.md) · [目标验收](packages/lightclaw/docs/goals.zh-CN.md)

LightClaw 是一个基于 TypeScript 的自托管个人 Agent。你在聊天中交付目标，它调用文件和 Shell 工具完成工作，将进度保存到磁盘，并在完成前检查文件、运行验收命令，或等待创建者确认。

适合需要多轮执行、保留产物和追踪过程的任务：整理资料、生成报告、修改代码、运行测试，以及定时处理工作区内的文件。


## 当前交付状态

面向**单实例、同一信任域**的个人Agent；频道文件组织不是租户隔离。源码、离线回归与本地发行清单已有实现；**真实飞书/Slack、真实Docker、干净依赖安装与新鲜dist均未验收**。本批独立目录离线安装遇到ENOTCACHED，未运行被禁止的构建，也未发布服务。

[部署与备份恢复](packages/lightclaw/docs/deployment.zh-CN.md) · [故障排查](packages/lightclaw/docs/troubleshooting.zh-CN.md) · [日志/资源默认值](packages/lightclaw/docs/resources.zh-CN.md) · [本批验收矩阵](docs/diagnosis/2026-10-31-fourth-remediation/README.md) · [五条简历证据](docs/diagnosis/2026-10-31-fourth-remediation/resume-evidence.md)

`--help`无需凭证；`--health=<工作目录> --control=<控制目录>`只探测本地锁。Node Agent运行于宿主，Docker仅执行工具；正常退出收敛后才释放锁，异常执行进入unknown等待人工核对，不能因锁文件存在就删除它。

## 为什么用 LightClaw

| 能力 | 解决的问题 | 实现方式 |
| --- | --- | --- |
| 持久化目标 | 任务需要多轮推进，进程可能中断 | 保存状态与进度，支持暂停、恢复、取消和重启恢复 |
| 完成验收 | 模型说“完成”后，还需要检查结果 | 创建时固定文件／命令规则；自然语言目标由创建者确认 |
| 受控执行 | 工具调用可能超时、失败或持续循环 | 单轮时间、工具和 Token 阈值；失败与停滞熔断 |
| 多频道调度 | 同一频道的请求需要有序处理 | 频道队列、排队期限、容量限制和空闲缓存回收 |
| 工具沙箱 | 文件与 Shell 操作需要限制影响范围 | 可选 Docker 执行环境，配置 CPU、内存、进程数和网络 |
| 可检查的运行过程 | 需要知道一次任务做了什么、花了多少资源 | JSONL 审计、产物评测、重复评测与提示词候选门禁 |

飞书和 Slack 共用一套 `ChatTransport` 接口。模型、工具、会话和上下文管理复用 [pi-mono](https://github.com/badlogic/pi-mono)；LightClaw 的业务代码集中在 [`packages/lightclaw`](packages/lightclaw)。

## 一次任务如何完成

```mermaid
flowchart LR
    Chat[飞书 / Slack] --> Queue[频道队列]
    Queue --> Agent[Agent 与工具循环]
    Agent --> Tools[文件 / Shell / 附件]
    Tools --> Agent
    Agent --> Goal[目标进度与完成验收]
    Goal -->|继续执行| Queue
    Goal -->|验收通过或人工确认| Result[结果与证据]
    Result --> Chat
```

例如，在飞书中发送：

```text
/goal 读取 scratch/notes.md，整理成 scratch/report.md，并附上结果文件
/goal status
```

Agent 可以多轮读取、写入和检查产物。自然语言目标提交完成申请后暂停推进，创建者使用 `/goal status` 中的 `/goal confirm <goalId> <attemptId>` 确认本次结果。

如果完成条件可以写成规则，可在创建时指定自动验收：

```text
/goal create {"objective":"根据 notes.md 生成报告","acceptance":{"files":[{"path":"scratch/report.md","contains":["结论"],"changed":true}]}}
```

验收器检查产物内容及相对创建基线的变化。Docker 模式还支持重新执行测试命令，详见[目标验收说明](packages/lightclaw/docs/goals.zh-CN.md)。

## 快速开始

需要 **Node.js >= 22.19.0**、npm、可用的模型凭证，以及飞书或 Slack 应用。以下步骤使用 Docker 运行工具，Node Agent 在宿主机运行。

### 1. 安装并创建工具环境

```bash
git clone https://github.com/Xxly959/Light-Claw.git
cd Light-Claw
npm install
mkdir -p lightclaw-data
bash packages/lightclaw/docker.sh create ./lightclaw-data
```

### 2. 配置模型与聊天平台

以下使用仓库默认的 `zai/glm-5.3-flash`。provider 与 model ID 必须存在于 pi 的模型注册表中；OpenAI 兼容网关可通过 `OPENAI_BASE_URL` 覆盖地址。

```bash
export LIGHTCLAW_MODEL_PROVIDER=zai
export LIGHTCLAW_MODEL_ID=glm-5.3-flash
export OPENAI_API_KEY='your-api-key'
# 使用自定义 OpenAI 兼容网关时设置：
# export OPENAI_BASE_URL='https://your-gateway.example/v1'

export LIGHTCLAW_TRANSPORT=feishu
export LIGHTCLAW_FEISHU_APP_ID='cli_xxx'
export LIGHTCLAW_FEISHU_APP_SECRET='your-app-secret'
```

飞书应用需开启机器人能力，使用长连接订阅 `im.message.receive_v1`，并具备读取和发送消息的权限。私聊直接发送，群聊 @ 机器人。

<details>
<summary>改用 Slack</summary>

开启应用的 Socket Mode，按 [Slack 接入指南](packages/lightclaw/docs/slack-bot-minimal-guide.md) 配置事件和权限，再替换聊天平台变量：

```bash
export LIGHTCLAW_TRANSPORT=slack
export LIGHTCLAW_SLACK_APP_TOKEN='xapp-xxx'
export LIGHTCLAW_SLACK_BOT_TOKEN='xoxb-xxx'
```

</details>

### 3. 启动并发送任务

```bash
npx tsx packages/lightclaw/src/main.ts \
  --sandbox=docker:lightclaw-sandbox \
  ./lightclaw-data
```

先发送一条普通消息验证连接，再尝试 `/goal`。凭证通过环境变量或 pi 认证存储读取；启动入口不会自动加载 `.env`。

省略 `--sandbox` 会使用宿主机执行。Docker 默认网络为 `bridge`；离线工具环境可在创建容器前设置 `LIGHTCLAW_SANDBOX_NETWORK=none`。详细参数见[沙箱说明](packages/lightclaw/docs/sandbox.zh-CN.md)。

## 目标控制与执行边界

```text
/goal status     查看目标、进展与待确认结果
/goal pause      暂停目标
/goal resume     恢复目标
/goal cancel     取消目标
```

默认目标上限为 8 轮；连续失败或停滞达到 2 轮时暂停。单轮默认 5 分钟、100 次工具调用和 100,000 个已报告 Token，均可通过环境变量配置。Token 阈值在收到用量报告后生效，不能作为账单硬上限。

目标控制状态保存在工作区外；对话、记忆、附件和产物按频道组织在 `lightclaw-data/` 中。排队记录可恢复；执行结果不确定的任务进入unknown并阻止自动重放，受控服务可按稳定operation ID对账，任意bash仍需人工核对副作用。当前设计面向单实例个人 Agent，详见[使用指南](packages/lightclaw/README.zh-CN.md)。

## 评测与提示词优化

LightClaw 提供分层验证入口：

- **长期任务离线评测**：统一eval CLI默认做无凭证数据审计；`--suite=reliability --mode=offline`复用生产编排，faux只证明接线/评分。见[评测协议](packages/lightclaw/docs/reliability-evaluation.zh-CN.md)。

- **确定性性能基准**：使用 faux provider 测量队列与运行时，保留原始任务和资源记录，不调用真实模型。
- **Agent 任务评测**：调用配置的模型，检查回复、文件产物、工具错误、耗时和 Token；提示词候选须通过训练集与独立留出集的重复评测门禁。

```bash
# 不消耗模型额度的运行时基准
cd packages/lightclaw
npx tsx src/benchmark/cli.ts --output=../../lightclaw-data/benchmarks
```

真实模型评测及提示词优化会消耗 API 额度，命令见[使用指南](packages/lightclaw/README.zh-CN.md)。随包小数据集用于展示和回归；历史冒烟结果与 faux-provider 基准不代表生产可靠性或真实平台性能。

## 项目结构与文档

| 路径 | 用途 |
| --- | --- |
| [`packages/lightclaw`](packages/lightclaw) | 平台接入、目标、队列、沙箱、审计与评测 |
| [`packages/ai`](packages/ai) | 模型接口与流式事件 |
| [`packages/agent`](packages/agent) | Agent 工具循环 |
| [`packages/coding-agent`](packages/coding-agent) | 会话、上下文压缩与工具基础设施 |
| [`packages/tui`](packages/tui) | coding-agent 所依赖的终端组件 |

- [中文使用指南](packages/lightclaw/README.zh-CN.md) / [English guide](packages/lightclaw/README.md)
- [架构设计](packages/lightclaw/docs/architecture.zh-CN.md) · [目标状态与验收](packages/lightclaw/docs/goals.zh-CN.md)
- [沙箱配置](packages/lightclaw/docs/sandbox.zh-CN.md) · [定时事件](packages/lightclaw/docs/events.md)
- [评测记录](packages/lightclaw/docs/evaluation.zh-CN.md) · [性能基准方法](packages/lightclaw/docs/performance-benchmark.zh-CN.md)

## 开发检查

在仓库根目录执行 `npm run check` 进行静态检查；该命令不运行测试。定向测试从相应包目录执行，遵循 [开发规则](AGENTS.md)。

## 许可证与致谢

[MIT](LICENSE)。LightClaw 基于 [pi-mono](https://github.com/badlogic/pi-mono)，保留上游版权声明与历史。感谢 pi 提供模型、Agent 和会话基础设施。
