<br />

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg">
    <img alt="Open Multi-Agent" src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg" width="96">
  </picture>
</p>

<br />

<h1 align="center">Open Multi-Agent</h1>

<p align="center">
  <strong>只描述目标，不画任务图。</strong><br/>
  运行在你自己环境中的多智能体编排。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@open-multi-agent/core"><img src="https://img.shields.io/npm/v/@open-multi-agent/core" alt="npm version"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml"><img src="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.6-blue" alt="TypeScript"></a>
  <a href="https://codecov.io/gh/open-multi-agent/open-multi-agent"><img src="https://codecov.io/gh/open-multi-agent/open-multi-agent/graph/badge.svg" alt="codecov"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/stargazers"><img src="https://img.shields.io/github/stars/open-multi-agent/open-multi-agent" alt="GitHub stars"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/network/members"><img src="https://img.shields.io/github/forks/open-multi-agent/open-multi-agent" alt="GitHub forks"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="OMA Run Viewer 回放真实多智能体运行：任务 DAG 与 span 瀑布双视图，展示每个任务的状态、负责人、token 与工具调用" width="960" height="540" loading="eager">
</p>

<br />

<p align="center">
  <a href="https://open-multi-agent.com/zh/">官网</a> ·
  <a href="https://open-multi-agent.com/zh/getting-started/introduction/">文档</a> ·
  <a href="https://www.npmjs.com/package/@open-multi-agent/core">npm</a> ·
  <a href="https://github.com/open-multi-agent/open-multi-agent/discussions">讨论区</a>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>中文</strong>
</p>

<br />

`@open-multi-agent/core` 是面向 TypeScript 后端的 OMA 编排运行时。你可以交给它一个 Agent、一张显式任务图，或一条由 Coordinator 在运行时从目标生成的**动态工作流（dynamic workflow）**。

运行时负责依赖调度、并行执行、Agent 间上下文共享和可审查结果输出。产品定位与已知用户见[项目首页](https://github.com/open-multi-agent/open-multi-agent/blob/main/README_zh.md)。

## 目录

[快速开始](#快速开始) · [执行模式](#执行模式) · [调度](#调度) · [核心能力](#核心能力) · [架构](#架构) · [示例](#示例) · [Provider](#provider) · [生产配置](#生产配置) · [文档](#文档)

## 快速开始

要求 Node.js 20 或更高版本。生产环境请使用仍处于维护期的 Node.js LTS 版本。
一条命令初始化并运行 starter：

```bash
npm create oma-app@latest my-oma
```

在交互式终端中，脚手架会选择 starter 与 Cloud/Ollama runtime、安装依赖，然后运行确定性 Demo 并生成离线 Dashboard。Demo 使用预置模型响应，不需要 API Key，也不会发起模型请求；OMA 编排仍在本地真实运行。使用 `--no-install` 可仅生成文件，使用 `--no-run` 可安装但不启动 Demo。

若要集成到现有后端：

```bash
npm install @open-multi-agent/core
```

*若正从 `@jackchen_me/open-multi-agent` 迁移：该包已弃用，请改用 `@open-multi-agent/core`。*

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

const model = process.env.OMA_MODEL ?? 'gpt-5.4'

const agents: AgentConfig[] = [
  { name: 'researcher', model, systemPrompt: 'Find the relevant facts.' },
  { name: 'analyst', model, systemPrompt: 'Compare evidence and identify tradeoffs.' },
]

const orchestrator = new OpenMultiAgent({
  defaultProvider: 'openai',
  defaultModel: model,
})

const team = orchestrator.createTeam('research-team', {
  name: 'research-team',
  agents,
  sharedMemory: true,
})

const result = await orchestrator.runTeam(team, 'Compare three approaches and recommend one.')
console.log(result.agentResults.get('coordinator')?.output)
```

该示例需要设置 `OPENAI_API_KEY`。其他云端或本地模型见 [Provider](#provider)。

## 执行模式

| 模式 | 方法 | 适用场景 | 示例 |
|------|------|----------|------|
| 单智能体 | `runAgent()` | 一个智能体，一个提示词，最简入口 | [`basics/single-agent`](examples/basics/single-agent.ts) |
| 自动编排团队 | `runTeam()` | 给一个目标，框架自动规划和执行 | [`basics/team-collaboration`](examples/basics/team-collaboration.ts) |
| 显式任务管线 | `runTasks()` | 你自己定义任务图和分配 | [`basics/task-pipeline`](examples/basics/task-pipeline.ts) |

用 `planOnly` 在执行前审查生成的任务图，再通过 `createPlanArtifact()` 和 `runFromPlan()` 回放。当一个答案需要额外把关时，`runConsensus()` 提供 proposer→judge 校验循环。

### 结构化单 Agent 输入

`Agent.run()`、`Agent.stream()` 与 `OpenMultiAgent.runAgent()` 除了原有字符串形式，也接受完整的 `LLMMessage[]`。应用需要传入自有对话历史或图片等内容块时，可使用消息形式：

```typescript
import { OpenMultiAgent, type LLMMessage } from '@open-multi-agent/core'

const messages: LLMMessage[] = [{
  role: 'user',
  content: [
    { type: 'text', text: '描述这张图片。' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
    },
  ],
}]

const result = await new OpenMultiAgent().runAgent(
  { name: 'vision', model: 'claude-sonnet-4-6' },
  messages,
)
```

持久化对话的 `Agent.prompt()` 接受字符串或单个 `ContentBlock[]` 用户轮次；更早的轮次通过 `AgentConfig.history` 恢复。结构化输入会经过校验和防御性复制。`beforeRun` 同时收到完整的 `messages` 与向后兼容的最新用户文本 `prompt`。Process 和 ACP backend 仍只接受字符串，遇到结构化参数会明确拒绝，不会静默丢弃历史或图片。复制、hook、progress/评测与外部 backend 的完整语义见[结构化 Agent 输入](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/structured-input.md)，可运行示例见 [`basics/structured-input`](examples/basics/structured-input.ts)。

自动 `runTeam()` 默认使用确定性路由，不会产生额外模型调用。显式设置 `executionRouting: { strategy: 'hybrid' }` 才会启用混合语义路由：`DeterministicRouter` 直接保留 Team 决策，只把 Single 候选交给一次无工具调用的 `TaskProfiler`；随后由确定性 Policy 决定保持 Single、升级为 Team，或要求调用方显式声明治理约束。有效的自定义 `executionRouter` 决策、显式 `mode` 和治理声明仍具有更高优先级。自动路由结果通过 `routingDecision` 暴露实际决定；运行过 Profiler 时，还会提供 `semanticRoutingAssessment`。详见[执行路由](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/execution-routing.md)。Execution Routing 选择 Single 或 Team，[Model Routing](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/model-routing.md)选择该拓扑内使用的模型。

启用 Hybrid 后，Profiler 会把目标文本发送给显式配置的路由 adapter；若未配置，则依次使用 Coordinator adapter 和 Orchestrator 的默认 Provider。最后一种回退即使在每个 worker 都有独立 adapter 时也可能产生默认 Provider 调用。若目标不能跨越该 Provider 边界，请配置 `executionRouting.adapter` 或使用 deterministic 策略。

当应用必须强制使用具名的独立角色时，直接声明治理意图，而不是依赖目标里的措辞：

```typescript
const governed = await orchestrator.runTeam(team, 'Review the evidence and assess the risk.', {
  governanceIntent: 'required',
  requiredRoles: ['researcher', 'analyst'],
  requiredOrder: ['researcher', 'analyst'],
})

if (governed.governanceConclusion !== 'satisfied') {
  throw new Error('Required governance was not satisfied by the executed topology.')
}
```

`required` 与 `preferred` 都会绕过自动拆解和简单目标短路。OMA 为每个声明的 roster 名称创建一个任务、指派给该 Agent，并按 `requiredOrder` 串联任务；依赖输出会传递给下游角色。拓扑只来自这些结构化字段，因此不同语言的等价目标会得到相同的角色与顺序。`none` 或省略 `governanceIntent` 时保持现有的自动 `runTeam()` 行为。

执行结束后，`governanceConclusion` 的值为 `satisfied`、`unsatisfied` 或 `not-applicable`。对治理有要求的应用必须将它与 `success` 分开检查：该结论来自结构化执行回执，而不是模型回答中的角色名称或批准措辞。详见[工具配置](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md#declared-governance-roles-in-runteam)。

## 调度

在 `OpenMultiAgent` 上设置 `schedulingStrategy`，可以选择如何把未分配的任务映射给 Agent。该配置同时适用于 Coordinator 生成的 `runTeam()` 计划，以及显式或恢复的任务队列。已有显式 `assignee` 的任务会保留原分配。

任务 DAG 按事件驱动执行：下游任务在依赖满足时立即启动，不等待同一 ready
set 中无关的任务；依赖输出以任务级结果和经校验的结构化交接传给下游任务。

```typescript
const orchestrator = new OpenMultiAgent({
  schedulingStrategy: 'composite',
  schedulingWeights: { fit: 0.7, load: 0.3 },
})
```

| 策略 | 分配行为 | 适用场景 |
|------|----------|----------|
| `dependency-first`（默认） | 优先分配能解锁最多下游工作的任务，并在合格 Agent 中轮转选择 | 任务图存在明确依赖关系 |
| `round-robin` | 按队列顺序在合格 Agent 中轮转分配 | Agent 能力可以互换 |
| `least-busy` | 选择当前活跃任务或本批新分配任务最少的合格 Agent | 任务耗时差异较大，需要负载均衡 |
| `capability-match` | 先过滤显式任务要求，再优先匹配声明的能力标签，最后使用兼容的关键词亲和度 | 任务或 Agent 声明了有区分度的要求/能力 |
| `composite` | 按阻塞的下游任务数排列任务，再在合格 Agent 中综合选择匹配度与可用容量最优者 | 需要在一次决策中同时考虑关键度、能力匹配与当前负载 |

Agent 可声明 `description`、`capabilities`、`costTier` 与 `latencyClass`，
任务可通过 `requires` 声明硬约束。任何调度策略无法满足这些约束时，都会在
worker 执行前失败。Coordinator 计划默认也会在引用
roster 之外的 Agent 时提前失败；仅在需要保留旧的自动重新分配行为时设置
`strictAssignees: false`。权重语义、负载归一化、
`NO_ELIGIBLE_AGENT` 与 `INVALID_ASSIGNEE` 行为、审批兼容与 progress 事件迁移
见[任务调度与派发](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/task-scheduling.md)。

## 核心能力

| 能力 | 说明 |
|------|------|
| **动态编排** | 运行时目标拆解、依赖调度、并行分支、可配置分配、任务级结果与交接、可选的 worker 团队上下文注入（`revealCoordinator`）和最终合成。 |
| **模型与推理** | 混用内置、OpenAI 兼容、AI SDK 或本地模型；单个 `thinking` 配置映射到各 provider 的原生推理设置，按阶段路由，并仅在显式开启时保留推理内容。 |
| **工具与委派** | 内置工具默认拒绝；自定义工具、MCP 和受保护的 `delegate_to_agent` 按需开启；后果性工具出现在未声明治理的运行中时会被标记以供确认。 |
| **可控输出** | 发送文本或结构化单 Agent 输入，按 Agent 流式输出、Zod 校验，可审批或持久化挂起计划、任务轮次、单任务派发与工具调用，用 `beforeRun` / `afterRun` 改写消息/提示词或后处理结果，以及 `AbortSignal` 取消。 |
| **评测** | 对 EvalSet 做版本管理，运行参考 scorer，用离线报告把关 CI，持久化结果，或尽力而为地抽样生产运行。 |
| **记忆与恢复** | 共享记忆可插拔；checkpoint 可在不重复已完成任务的前提下恢复运行。 |
| **可观测性** | 无需托管服务即可使用稳定运行标识、trace、执行回执、脱敏、TraceStore 和离线 DAG/Waterfall Viewer。 |
| **外部 Agent** | ACP 和进程后端让编码 CLI 加入团队，OMA 继续管理调度、记忆和预算。 |

## 架构

```text
目标或显式任务
         |
         v
Coordinator -> 任务 DAG -> Scheduler -> AgentPool
                    |                       |-- LLM adapter
                    |                       `-- 工具 / 外部后端
                    |
                    |-- SharedMemory / checkpoint
                    |-- TraceRecord -> TraceStore / Run Viewer / OTel
                    `-- 结果 -> 评测（离线 / 抽样，仅观察）
```

默认情况下，Coordinator 只负责产生一次计划，Scheduler 负责执行顺序。当任务结果需要修改任务图中尚未执行的部分时，应用可以选择启用仅追加式自适应恢复。Agent 通过记忆共享结果，checkpoint 与 trace 分别形成恢复和可观测路径。评测只观察已完成的结果，不会改变它们。详细契约见下方各子系统指南。

## 示例

从与目标行为最接近的示例开始：

| 目标 | 示例 |
|---|---|
| 发送图片内容块与应用自有历史 | [`basics/structured-input`](examples/basics/structured-input.ts) |
| 查看 Coordinator 规划 | [`basics/team-collaboration`](examples/basics/team-collaboration.ts) |
| 构建显式 DAG | [`cookbook/contract-review-dag`](examples/cookbook/contract-review-dag.ts) |
| 观察事件驱动 DAG 派发 | [`patterns/event-driven-dag`](examples/patterns/event-driven-dag.ts) |
| 校验结构化输出 | [`patterns/structured-output`](examples/patterns/structured-output.ts) |
| Agent 之间委派 | [`patterns/agent-handoff`](examples/patterns/agent-handoff.ts) |
| 回放固定计划 | [`patterns/plan-replay`](examples/patterns/plan-replay.ts) |
| 挂起并恢复审批 | [`patterns/durable-approval`](examples/patterns/durable-approval.ts) |
| 嵌入真实后端 | [`integrations/express-customer-support`](examples/integrations/express-customer-support/) |
| 导出离线 trace Viewer | [`integrations/observability-v2/run-viewer`](examples/integrations/observability-v2/run-viewer.ts) |

[示例索引](examples/README.md)收录 50+ 个可运行示例，覆盖 basics、cookbook 流程、patterns、Provider 和 integrations。

## Provider

只需修改 `provider`、`model` 和凭证，agent 配置结构保持不变。

| 接入方式 | 适用范围 |
|---|---|
| 内置 | Anthropic、OpenAI、Azure OpenAI、Copilot、Grok、DeepSeek、Doubao、Hunyuan、MiniMax、MiMo、Qiniu |
| 可选 peer | Gemini（`@google/genai`）和 Bedrock（`@aws-sdk/client-bedrock-runtime`） |
| OpenAI 兼容 | 设置 `provider: 'openai'` + `baseURL`，接入 Ollama、vLLM、LM Studio、OpenRouter、Groq、Mistral、Kimi、Qwen、Zhipu |
| AI SDK | 通过 `AISdkAdapter`、`ai` 和所选 `@ai-sdk/*` provider 接入（AI SDK 7 需 Node.js 22+） |

可选集成只在使用时加载：core 直接安装的只有 `@anthropic-ai/sdk`、`openai` 和 `zod`，其余 SDK 都是按需懒加载的可选 peer，OpenTelemetry 完全归属 `@open-multi-agent/otel`。依赖变更按实际价值与安全、体积、维护、兼容成本权衡，不设固定数量上限。

凭证、模型、AI SDK 桥接、推理设置、MCP 与本地端点配置见 [Provider](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md)和[工具配置](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md)。

**Provider 赞助商**

支持 `open-multi-agent` 的付费赞助商。赞助不影响技术决策与模型推荐。

- **[Atlas Cloud](https://www.atlascloud.ai/console/coding-plan)**：全模态 AI 推理平台，单一 API 打通视频、图像与 LLM，覆盖 300+ 精选模型。OMA 用户可申请限量 $5 credit 兑换码。见 [Atlas Cloud 接入指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers-atlascloud_zh.md)。

## 生产配置

| 目标 | 配置 |
|---|---|
| 限定工作量 | `maxTurns`、`timeoutMs`、`callTimeoutMs`、`contextStrategy`、`loopDetection` |
| 控制成本 | `maxTokenBudget`；`maxCostBudget` + 应用自有 `estimateCost` |
| 限制工具 | `tools` / `toolPreset`、`cwd` / `defaultCwd`、工具输出上限 |
| 故障恢复 | 任务重试、checkpoint、`restore()` 与可选的自适应计划修复 |
| 人工把关 | `planOnly`、同步审批回调或[持久化审批 gate](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/durable-approvals.md) |
| 统一观测 | Trace sink、TraceStore、执行回执、Run Viewer，或可选 OTel adapter |

预算检查发生在 turn 和任务边界，因此单次运行最多可能超出一个模型 turn，不是分厘精确的截停。`estimateCost` 收到每次调用的 token 用量，以及 agent、生效的 `model`、`provider`、阶段和 `taskId`；价格表由应用自己维护。

内置工具默认拒绝，且每个对模型可见的工具结果都会发送给你的模型 provider，读取与执行权限应审慎授予。工具可通过 `modelOutput` 将应用自有数据与发送给模型的文本、图片或文件内容分开；完整契约见[工具配置指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md#rich-image-and-file-results)。文件工具受配置的 `cwd` 限制；`bash` 一旦授权便不受该沙箱约束。trace、shell 输出和 Viewer payload 默认自动脱敏，但结果消息与 checkpoint 属于各自独立的持久化边界。

### 可观测性

Core 已提供运行标识、trace sink、执行回执、可查询的内存/文件存储和离线 Run Viewer，足以完成本地排障、审计留档与运行后分析，无需安装 OpenTelemetry。

[`@open-multi-agent/otel`](https://github.com/open-multi-agent/open-multi-agent/blob/main/packages/otel/README.md) 是面向已有集中式 OpenTelemetry 平台团队的**可选企业集成**。它把 OMA trace 转成标准 OTel span，让多 agent 运行接入企业统一监控、告警和故障处理流程。应用负责 provider 及其生命周期；telemetry 故障不会改变业务运行结果。

详见[可观测性指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md)、[迁移指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability-migration.md)与[性能指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability-performance.md)。

## 文档

| 主题 | 指南 |
|---|---|
| 构建 agent | [Provider](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md)、[结构化输入](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/structured-input.md)、[工具](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md)、[上下文](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/context-management.md) |
| 稳定运行 | [评测](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/evaluation.md)、[Checkpoint & resume](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/checkpoint.md)、[持久化审批](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/durable-approvals.md)、[自适应恢复](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/adaptive-recovery.md)、[执行路由](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/execution-routing.md)、[模型路由](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/model-routing.md)、[Consensus](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/consensus.md) |
| 控制流程 | [计划预览与回放](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/plan-replay.md)、[共享记忆](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/shared-memory.md)、[外部 agent](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/external-agents.md) |
| 生产运维 | [可观测性](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md)、[CLI](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/cli.md)、[生产示例](examples/production/README.md) |

## 参与贡献

欢迎 Issue 和 PR。生产示例请遵循[收录标准](examples/production/README.md)；代码改动请阅读[贡献指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/.github/CONTRIBUTING.md)。

## 贡献者

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100" />
</a>

<details>
<summary>按领域展开贡献者致谢</summary>

**框架功能**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv)（token 预算、上下文策略、依赖隔离上下文、工具预设、glob、MCP 集成、可配置 Coordinator、CLI、Dashboard 渲染、trace 事件类型）
- [@apollo-mg](https://github.com/apollo-mg)（上下文压缩修复、采样参数）
- [@tizerluo](https://github.com/tizerluo)（onPlanReady、onAgentStream）
- [@CodingBangboo](https://github.com/CodingBangboo)（planOnly 模式）
- [@Xin-Mai](https://github.com/Xin-Mai)（output schema 验证）
- [@JasonOA888](https://github.com/JasonOA888)（AbortSignal 支持）
- [@EchoOfZion](https://github.com/EchoOfZion)（简单目标跳过 Coordinator）
- voidborne-d（OpenAI 混合内容修复、text-tool-extractor 深度修复）
- [@NamelessNATM](https://github.com/NamelessNATM)（agent 委派基础实现）
- [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)（reasoning blocks、reasoning_effort、采样参数对齐、trace 输入输出）
- [@SiMinus](https://github.com/SiMinus)（流式 reasoning 事件）
- [@matthewYang08](https://github.com/matthewYang08)（OpenAI reasoning 转文本回退）
- [@dvirarad](https://github.com/dvirarad)（OpenAI 系列 adapter 健壮性）
- [@cat0825](https://github.com/cat0825)（model routing 策略、plan 重放、结构化共享记忆 handoff）
- [@mvanhorn](https://github.com/mvanhorn)（checkpoint & resume）
- [@lesbass](https://github.com/lesbass)（`TeamRunResult` 运行级 metrics 汇总）
- [@tlysanhuo](https://github.com/tlysanhuo)（trace span 父级链接）
- [@LambIessz](https://github.com/LambIessz)（orchestrator 成本预算、MessageBus 持久化进 checkpoint、可重试路由回退）
- [@Bobuyoucrypto](https://github.com/Bobuyoucrypto)（Windows bash 超时杀进程树）

**Provider 集成**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv)（Gemini）
- [@hkalex](https://github.com/hkalex)（DeepSeek、MiniMax）
- [@marceloceccon](https://github.com/marceloceccon)（Grok）
- [@Klarline](https://github.com/Klarline)（Azure OpenAI）
- [@Deathwing](https://github.com/Deathwing)（GitHub Copilot）
- [@JackChiang233](https://github.com/JackChiang233)（Qiniu）
- [@CodingBangboo](https://github.com/CodingBangboo)（AWS Bedrock）
- [@kidoom](https://github.com/kidoom)（MiMo、Doubao）
- [@KaitlynFeng](https://github.com/KaitlynFeng)（Hunyuan）
- [@octo-patch](https://github.com/octo-patch)（MiniMax-M3 模型升级）

**示例与 Cookbook**

- [@mvanhorn](https://github.com/mvanhorn)（研究聚合、代码评审、会议总结、Groq 示例、Mistral 示例）
- [@Kinoo0](https://github.com/Kinoo0)（代码评审升级）
- [@Optimisttt](https://github.com/Optimisttt)（研究聚合升级）
- [@Agentscreator](https://github.com/Agentscreator)（Engram 记忆集成）
- [@fault-segment](https://github.com/fault-segment)（合同审查 DAG）
- [@HuXiangyu123](https://github.com/HuXiangyu123)（分级成本示例）
- [@zouhh22333-beep](https://github.com/zouhh22333-beep)（翻译/回译）
- [@pei-pei45](https://github.com/pei-pei45)（竞品监测）
- [@mmjwxbc](https://github.com/mmjwxbc)（面试模拟器）
- [@binghuaren96](https://github.com/binghuaren96)（事故复盘 DAG）
- [@DaiMao-UT](https://github.com/DaiMao-UT)（论文复现分诊）
- [@oooooowoooooo](https://github.com/oooooowoooooo)（罕见病信息分诊）
- [@CodingBangboo](https://github.com/CodingBangboo)（Express 客服流水线）
- [@nuthalapativarun](https://github.com/nuthalapativarun)（Doubao、Zhipu provider 示例）
- [@goodneamtakenbydogs](https://github.com/goodneamtakenbydogs)（Moonshot、Qwen provider 示例）
- [@suans4746-del](https://github.com/suans4746-del)（叙事谜题提示仲裁）
- [@gregkonush](https://github.com/gregkonush)（Bilig WorkPaper MCP 集成）

**文档与测试**

- [@tmchow](https://github.com/tmchow)（llama.cpp 文档）
- [@kenrogers](https://github.com/kenrogers)（OpenRouter 文档）
- [@jadegold55](https://github.com/jadegold55)（LLM adapter 测试覆盖）
- [@btroops](https://github.com/btroops)（DeepSeek 工具调用测试）
- [@nuthalapativarun](https://github.com/nuthalapativarun)（上下文管理文档）
- [@Oxygen56](https://github.com/Oxygen56)（errors.ts 测试、Grok/DeepSeek/Doubao provider 文档）
- [@RheagalFire](https://github.com/RheagalFire)（LiteLLM 网关文档）

</details>

## 许可证

MIT
