<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg">
    <img alt="" src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg" width="72">
  </picture>
  <br>Open Multi-Agent
</h1>

<p align="center">
  <strong>只描述目标，不画任务图。</strong><br/>
  多智能体自主分工协作，在自有环境中运行：关键操作经审批放行，每次运行留有可核验记录。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@open-multi-agent/core"><img src="https://img.shields.io/npm/v/@open-multi-agent/core" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/node/v/@open-multi-agent/core" alt="Node.js version"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml"><img src="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/supply-chain-audit.yml"><img src="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/supply-chain-audit.yml/badge.svg" alt="Supply chain audit"></a>
  <a href="https://codecov.io/gh/open-multi-agent/open-multi-agent"><img src="https://codecov.io/gh/open-multi-agent/open-multi-agent/graph/badge.svg" alt="codecov"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://open-multi-agent.com/zh/?utm_source=github&utm_medium=readme">官网</a> ·
  <a href="https://open-multi-agent.com/zh/getting-started/introduction/?utm_source=github&utm_medium=readme">文档</a> ·
  <a href="./packages/core/examples/">示例</a> ·
  <a href="https://www.npmjs.com/package/@open-multi-agent/core">npm</a>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>中文</strong>
</p>

<br />

`open-multi-agent` 是面向 TypeScript 后端的多智能体编排框架，可直接嵌入任意 Node.js 应用。它运行的是**动态工作流（dynamic workflows）**：Coordinator 在运行时将一个目标分解为任务 DAG，由确定性调度器分派给团队执行，整个运行过程始终是可审查、可审批、可回放的数据。下文的动图是内置离线 Run Viewer 对一次真实运行的回放。

## 快速开始

要求 Node.js 20 或更高版本。生产环境请使用仍处于维护期的 Node.js LTS 版本。Node.js 20 上游已停止维护，OMA 仅将其保留为迁移过渡窗口，会在下一个 major 版本移除，最早不早于 2026-10-31。

初始化 PR 审查 Agent、安全分析 Agent 或教学用 DAG：

```bash
npm create oma-app@latest my-oma
```

在交互式终端中，这一条命令会完成 starter 与 runtime 选择、依赖安装，并运行确定性的本地 Demo。Demo 不需要 API Key，也不会发起模型请求：预置模型响应负责模拟生成边界，OMA 的调度、结果聚合与离线 Dashboard 均真实运行。

也可以把 OMA 直接加入现有后端：

```bash
npm install @open-multi-agent/core
```

```typescript
import { OpenMultiAgent } from '@open-multi-agent/core'

const oma = new OpenMultiAgent({ defaultProvider: 'openai', defaultModel: 'gpt-5.4' })

const team = oma.createTeam('research-team', {
  name: 'research-team',
  agents: [
    { name: 'researcher', systemPrompt: 'Find the relevant facts.' },
    { name: 'analyst', systemPrompt: 'Compare evidence and identify tradeoffs.' },
  ],
  sharedMemory: true,
})

const result = await oma.runTeam(team, 'Compare three approaches and recommend one.')

console.log(result.agentResults.get('coordinator')?.output)
```

<details>
<summary>完整示例：DAG 回读、token 统计与环境变量覆盖</summary>

```typescript
import { OpenMultiAgent } from '@open-multi-agent/core'

const model = process.env.OMA_MODEL ?? 'gpt-5.4'

const oma = new OpenMultiAgent({ defaultProvider: 'openai', defaultModel: model })

const team = oma.createTeam('research-team', {
  name: 'research-team',
  agents: [
    { name: 'researcher', systemPrompt: 'Find the relevant facts.' },
    { name: 'analyst', systemPrompt: 'Compare evidence and identify tradeoffs.' },
  ],
  sharedMemory: true,
})

const result = await oma.runTeam(team, 'Compare three approaches and recommend one.')

// 以上代码没有声明任何任务图，任务 DAG 由 Coordinator 在运行时生成，
// 运行结束后整个过程都是可以读回的数据。
for (const task of result.tasks ?? []) {
  console.log(`[${task.status}] ${task.title} → ${task.assignee ?? 'unassigned'}`, task.dependsOn)
}

console.log(result.agentResults.get('coordinator')?.output)
console.log(result.totalTokenUsage)
```

</details>

<details>
<summary>让有副作用的工具调用挂起等待审批</summary>

```typescript
import { FileStore, OpenMultiAgent } from '@open-multi-agent/core'

// 密钥与端点都是你自己的：托管模型，或通过 baseURL 接本地服务。
const oma = new OpenMultiAgent({
  defaultProvider: 'openai',
  defaultModel: 'gpt-5.4',
  // 有实际副作用的工具调用（写文件、执行 shell）挂起，等待人工决定。
  onToolCall: ({ consequential }) => (consequential ? { action: 'suspend' } : { action: 'allow' }),
})

const team = oma.createTeam('ops', {
  name: 'ops',
  agents: [{ name: 'operator', systemPrompt: '核对逾期发票。', toolPreset: 'readwrite' }],
})

// Coordinator 从目标规划任务 DAG；checkpoint store 让整次运行可持久化。
const result = await oma.runTeam(team, '找出逾期发票并起草催款提醒。', {
  checkpoint: { store: new FileStore('./.oma/run.json') },
})

// 在审批人处理 result.pendingApprovals 之前，result.status?.code 保持为 'suspended'；
// 每条待审批请求都绑定审批人实际看到内容的哈希。
```

</details>

运行这段示例需要设置 `OPENAI_API_KEY`。其他云端模型、本地服务、OpenAI 兼容端点与 AI SDK provider 的配置见 [Provider 文档](docs/providers.md)。

`runTeam()` 从目标自动规划，`runAgent()` 运行单个 Agent，`runTasks()` 执行显式流水线。三种模式、Provider 与凭证配置、生产检查清单见[核心包使用指南](packages/core/README_zh.md)。[示例索引](packages/core/examples/README.md)收录全部可运行示例，覆盖基础、cookbook 流程、模式、Provider 与集成。

## 为什么选择 OMA

**万物皆接口，每次运行皆可回溯。**

OMA 将动态编排与生产所需的控制、证据和恢复能力结合起来，帮助多智能体系统从原型走向生产环境。

- **动态编排。** 只需描述目标，Coordinator 就会在运行时生成任务 DAG、分配工作并合成结果，无需手工维护工作流图。
- **受控执行。** 可预览、审批或持久化挂起计划、任务派发与工具调用，并固化已审批计划以供重放；框架提供审批 API 与持久化审批记录，审批界面与传递通道由接入方自行实现。当拓扑不容漂移时可声明必需的角色与执行顺序，并通过多 Agent 共识验证结果。
- **可靠性。** 通过 Checkpoint 从断点恢复中断的运行，或选择在任务结果屏障处启用仅追加式计划修复；重试、超时、循环检测与 token、成本双预算让执行始终有明确边界。
- **可观测与评测。** 通过稳定的运行标识、执行回执与 Trace 跟踪每次运行，在离线 Run Viewer 中回放任务 DAG 与 span 瀑布，或通过可选的 OpenTelemetry 适配器导出；同一套运行记录可直接支撑版本化 EvalSet、离线报告、CI gate 与线上采样。这套记录可核验执行顺序与血缘，但不提供防篡改保证。
- **安全与隐私。** 内置工具默认拒绝，支持逐次调用 gate，并对遥测与持久化状态应用显式的隐私控制。
- **开放运行时。** Process 与 ACP backend 让 Claude Code、Gemini CLI、Codex 和 LLM Agent 同处一个任务 DAG，并共享记忆与预算，但这类外部 backend 不在逐次工具 gate、文件沙箱与 LLM 出网策略的覆盖范围内；可混用云端模型、本地开源模型、原生接入的国产模型、OpenAI 兼容端点与 AI SDK provider，并通过容错解析支持以文本形式返回工具调用的本地模型；支持使用自有基础设施与凭证，本地、离线或气隙部署，详见[自托管与数据驻留](docs/self-hosting.md)。

<p align="center">
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="OMA Run Viewer 回放真实多智能体运行：任务 DAG 与 span 瀑布双视图，展示每个任务的状态、负责人、token 与工具调用" width="960" height="540" loading="lazy">
</p>
<p align="center"><em>内置离线 Run Viewer 基于 trace store 回放一次真实运行：任务 DAG、span 瀑布与逐任务证据，不依赖任何托管服务。</em></p>

## 基于 OMA 构建

`open-multi-agent` 2026-04-01 发布，MIT 协议。当前公开在用与集成的项目：

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)**，作者 [Ali Sünbül](https://github.com/xeloxa)。WordPress 安全分析平台，在 Docker runtime 里直接使用 OMA 内置工具（`bash`、`file_*`、`grep`）。已确认生产环境使用。
- **[Mark Galyan](https://github.com/apollo-mg)** 在本地量化模型上完全离线运行 OMA，借助 Coordinator 与上下文压缩，在显存受限的条件下维持自治 Agent 循环持续运行。自框架发布首月起持续贡献。
- **[PR-Copilot](https://github.com/kidoom/PR-Copilot)**，作者 [kidoom](https://github.com/kidoom)。AI pull request 审查助手，运行 OMA 审查 team，用 `defineTool` 定义仓库上下文工具，并加入自定义 `ContextStrategy` 做 token-aware 的 diff 压缩。
- **[StuFlow](https://github.com/znc15/StuFlow)**，作者 [znc15](https://github.com/znc15)。终端 AI 编码助手，以 OMA 为编排内核，通过 `runAgent` / `runTasks` / `runTeam` 驱动自定义 coordinator，搭配 DeepSeek。
- **[Reports to Charts Studio](https://github.com/NARNIX0/Evident-Project)**。把文档和研究表格转换成可直接用于幻灯片的图表，使用由五个角色组成的数据提取评审组，结合结构化输出与确定性校验。

**集成**

- **[Engram](https://www.engram-memory.com)**："AI 记忆的 Git"。在 agent 之间即时同步知识并标记冲突。([repo](https://github.com/Agentscreator/engram-memory)，约 80 stars)
- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)**：Sidecar，检测跨运行的委派环、重复和速率突增。
- **[CodingScaffold](https://github.com/JRS1986/CodingScaffold)**：agentic-coding 脚手架，把 OMA 列为可选编排后端，附带 `runTeam` 工作流模板。
- **[Bilig WorkPaper](https://github.com/proompteng/bilig)**：公式工作簿 MCP 服务，提供双向收录的 OMA 集成，可编辑输入、重新计算公式、校验回读结果并持久化 WorkPaper JSON。
- **[baize-oma](https://github.com/timywel/baize-oma)**：HTTP 适配层，把 OMA 的 `runAgent()` 和 `runTeam()` 暴露为 Baize slot 能力。

在生产或 side project 中使用了 `open-multi-agent`？[请开个 Discussion](https://github.com/open-multi-agent/open-multi-agent/discussions)，我们会将其列在这里。做了集成？收录方式见[集成指南](packages/core/examples/integrations/README.md)。深度集成的产品见 [Featured partner 计划](docs/featured-partner.md)。

## 赞助商

支持 `open-multi-agent` 的付费赞助商。赞助不影响技术决策与模型推荐。

**Provider**

- **[Atlas Cloud](https://www.atlascloud.ai/console/coding-plan)**：全模态 AI 推理平台，单一 API 打通视频、图像与 LLM，覆盖 300+ 精选模型。$5 credit 兑换码面向 OMA 用户开放，先到先得。见 [Atlas Cloud 接入指南](docs/providers-atlascloud_zh.md)。

## OMA 适合什么场景

OMA 面向希望任务图随目标动态生成的 TypeScript 团队。

如果工作流必须逐节点手工设计，图优先框架更合适；如果只需要单个 Agent 调用，一个 LLM 工具库就够了。当多个 Agent、任务依赖、审批或恢复机制需要协同时，OMA 负责这一编排层。

与 LangGraph、Mastra、CrewAI、Vercel AI SDK 等的逐项对比见[对比页](https://open-multi-agent.com/zh/compare/?utm_source=github&utm_medium=readme)。

## 包

- **[`@open-multi-agent/core`](packages/core/README_zh.md)**：编排运行时、工具、记忆、checkpoint、trace、CLI 和离线 Run Viewer。
- **[`@open-multi-agent/otel`](packages/otel/README.md)**：面向已建立 OpenTelemetry 统一监控体系的生产团队的可选企业集成。
- **[`create-oma-app`](packages/create-oma-app/README.md)**：`npm create oma-app` 背后的脚手架；提供自带免 API Key 本地 Demo 的 starter 模板。

Core 用户可以在本地保存 trace，并用离线 Run Viewer 查看。只有当 OMA trace 需要进入应用现有的统一监控平台时，才需要安装 OTel 包。

## 企业服务

面向已有产品或业务系统的团队，提供 AI 场景梳理、Agent 能力嵌入与交付支持。微信扫码联系，或邮件 [jack@yuanasi.com](mailto:jack@yuanasi.com)。

<p align="center">
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/wechat-qr.jpg" alt="微信扫码添加 JackChen 咨询" width="180">
</p>

## 文档

| 目标 | 从这里开始 |
|---|---|
| 安装与运行 | [文档索引](docs/README.md) · [核心包使用指南](packages/core/README_zh.md) · [示例](packages/core/examples/README.md) · [CLI](docs/cli.md) · [术语表](docs/glossary.md) · [生产检查清单](docs/production-checklist.md) |
| 配置模型与工具 | [Provider](docs/providers.md) · [LLM 出网策略](docs/egress-policy.md) · [工具配置](docs/tool-configuration.md) · [沙箱与 shell 执行](docs/sandbox-and-shell.md) · [MCP](docs/mcp.md) · [结构化输入](docs/structured-input.md) · [外部 Agent](docs/external-agents.md) |
| 稳定运行 | [可观测性](docs/observability.md) · [Run Viewer](docs/run-viewer.md) · [运行事件日志](docs/run-journal.md) · [评测](docs/evaluation.md) · [Checkpoint 与恢复](docs/checkpoint.md) · [持久化审批](docs/durable-approvals.md) · [自适应恢复](docs/adaptive-recovery.md) · [上下文管理](docs/context-management.md) · [错误](docs/errors.md) |
| 控制编排 | [Coordinator](docs/coordinator.md) · [Consensus](docs/consensus.md) · [执行路由](docs/execution-routing.md) · [模型路由](docs/model-routing.md) · [任务调度](docs/task-scheduling.md) · [计划回放](docs/plan-replay.md) · [共享记忆](docs/shared-memory.md) · [流式输出](docs/streaming.md) · [预算与限制](docs/budgets-and-limits.md) |

## 参与贡献

欢迎提交 Issue 和 Pull Request。Workspace 边界、验证要求和提交流程见 [CONTRIBUTING.md](.github/CONTRIBUTING.md)。

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100" />
</a>

按领域展开的贡献者致谢见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

## 许可证

MIT
