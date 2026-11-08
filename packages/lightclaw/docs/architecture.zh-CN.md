# LightClaw 架构说明

## 主调用链

```mermaid
flowchart LR
    User[飞书 / Slack 用户] --> Transport[ChatTransport 适配层]
    Transport --> Main[main.ts 启动 / runtime.ts 编排]

    subgraph Runtime[Agent 运行时]
        Main --> Runner[AgentRunner]
        Runner --> Loop[pi-agent-core<br/>Agent Loop]
        Loop <--> Model[pi-ai<br/>OpenAI 兼容模型]
        Loop <--> Tools[基础工具<br/>bash / read / write / edit]
        Runner <--> Session[SessionManager<br/>上下文压缩与恢复]
        Runner <--> Goal[GoalStore<br/>长期目标状态机]
    end

    Tools --> Sandbox[Docker Sandbox<br/>非 root + 资源限制]
    Session --> Data[(JSON / JSONL<br/>记忆、上下文、产物)]
    Goal --> Control[(工作区外 control<br/>目标、验收报告、互斥锁)]
    Goal --> Verifier[确定性文件 / Docker 命令验收]
    User -->|确认当前申请| Goal
    Runner --> Audit[(audit/runs.jsonl<br/>Token、耗时、工具错误)]
    Runner --> Transport


```

图中只描述线上请求和状态读写；独立评测与基准框架已退役。核心原则是：模型负责决策，确定性代码负责状态、安全边界和验收。

## 为什么需要传输层

飞书用 message ID，Slack 用时间戳；飞书的文件、回复线程和消息编辑限制也与 Slack 不同。如果 Agent 逻辑直接依赖某个平台，增加新平台时就要复制整套业务代码。

`ChatTransport` 只保留 Agent 真正需要的最小能力：发送、更新、回复、删除、上传文件、查询用户和入队事件。Slack 与飞书分别实现它，`runtime.ts` 不再关心 SDK 细节。这就是适配器模式，也是依赖倒置的一个小例子。

## Agent Loop

单轮执行可以概括为：

```text
用户消息 → 模型判断 → 调用工具 → 工具结果返回模型 → 最终回复
```

如果模型继续调用工具，`pi-agent-core` 会留在循环中。如果模型不再调用工具，一轮执行结束。LightClaw 的长期目标执行器位于这个循环外面：目标未完成时，它生成一条内部续跑消息，再启动下一轮。

## Memory 与 Context

- `log.jsonl` 是便于检索的聊天历史。
- `context.jsonl` 是模型实际使用的结构化上下文。
- 全局与频道的 `MEMORY.md` 保存跨会话需要常驻的偏好、约定和索引链接，每份最多注入 4 KiB 完整行。详细笔记可放在频道的 `memory/` 或工作区的 `.shared/memory/`，按需读取。
- 控制根的 `<channel>/goal.json` 保存 schema 2 目标、创建者、验收契约、状态版本及有界验证报告，不在可写工作区内。

把目标状态从模型上下文中独立出来非常重要。即使旧对话被压缩，目标、轮次、进展和证据仍不会丢失。

## 安全边界

LightClaw 默认推荐 Docker 沙箱。长期 Agent 比普通聊天机器人风险更高，因为它能多轮调用 bash 和文件工具。循环必须受到最大轮次、连续失败和无进展检测约束，用户也可以随时发送 `stop`。

审计日志只保存指标，不保存完整提示词、工具参数和回复正文。凭证只从环境变量或 pi 的认证存储读取。

固定契约由真实平台事件创建，恢复／调度／续跑事件通过显式 origin 区分。`goal_complete` 经验证器读取实际文件或执行预定命令，failed 保持 active，inconclusive 等待创建者确认。验证命令共享单轮工具预算与取消信号。启动验证 Docker mount 未覆盖控制目录，Bot／迁移工具用同一互斥锁。相同 UID 的 host 命令、多租户共享挂载和远端取消仍有边界，详见[验收说明](goals.zh-CN.md)。

## 临时提示词工作流

飞书表单 → prompt-input.ts独立生成与约束复核 → feishu.ts可编辑预览 → 原用户确认 → runtime.ts把最终文本交给AgentRunner。修改说明/假设/问题属于控制与UI数据，不进入主会话。主Agent的稳定行为规则在agent.ts中，优化器元指令在prompt-rewrite.ts中，两者职责不同。

## 学习入口

按learning-path.zh-CN.md中的顺序读源码。Goal验收、审计和回归测试是运行保障，不是独立Agent效果评测。
