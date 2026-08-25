# Atlas Cloud 接入指南

[English](providers-atlascloud.md)

Atlas Cloud 是一个全模态 AI 推理平台，通过单一 API 为开发者提供视频生成、图像生成及 LLM 接入。免去繁琐的多供应商对接，一次连接即可调用 300+ 款全模态精选模型。

## OMA 用户专属兑换码

面向 OMA 用户的 $5 Atlas Cloud 兑换码，先到先得。每人取用一张，其余留给他人。

```
37699C92-8CCC-4224-963E-126CC2475C3B
E4D81992-9FB2-4823-A970-D90E58DB0377
29A2888B-F8B3-4157-A6EA-705781815EA6
BDA10EA7-1F2D-48EF-BF26-F37EEE325B1B
DCD47541-22BE-4314-BF6B-9EE031E5F421
```

在 Atlas Cloud [领取模型奖励](https://www.atlascloud.ai/zh/event/claim-model-rewards)页面兑换。

若上述兑换码均已被领取，可邮件 [jack@yuanasi.com](mailto:jack@yuanasi.com)，附 GitHub 用户名与一句话用途。数量有限，恕不保证仍有余量。

声明：赞助来自 Atlas Cloud；兑换码数量有限，不构成对任何模型或功能的付费背书。

## 接入配置

Atlas Cloud 提供 OpenAI 兼容的 Chat Completions API（官方描述为 OpenAI SDK 的直接替代），因此 OMA 通过内置 `openai` provider 加自定义 `baseURL` 接入。这与 OMA 接入 OpenRouter、Groq、Mistral 及 [Provider 文档](providers.md)中其他 OpenAI 兼容端点的方式一致。

### 环境变量

在 [Atlas Cloud 控制台](https://www.atlascloud.ai/console/coding-plan)创建 API key，然后导出：

```bash
export ATLASCLOUD_API_KEY=your-api-key
```

`ATLASCLOUD_API_KEY` 是 Atlas Cloud 官方文档使用的变量名。OMA 的 OpenAI 兼容配置在代码中读取该变量并传入 `apiKey`。

### Agent 配置

由于凭证并非 `OPENAI_API_KEY`，需通过 `apiKey` 显式传入；否则 `openai` adapter 会回退到 `OPENAI_API_KEY`。

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

const agent: AgentConfig = {
  name: 'analyst',
  provider: 'openai',
  baseURL: 'https://api.atlascloud.ai/v1',
  apiKey: process.env.ATLASCLOUD_API_KEY,
  model: 'deepseek-v4-flash-0731', // 从模型库中选取当前可用的 ID
  systemPrompt: 'Analyze data and produce concise reports.',
  tools: ['bash', 'file_read', 'file_write'],
}

const orchestrator = new OpenMultiAgent()
// 内置文件系统工具默认沙箱为 `<cwd>/.agent-workspace`；
// 请将 agent 指向该根目录内的绝对路径。
const result = await orchestrator.runAgent(
  agent,
  `Summarize the file ${process.cwd()}/.agent-workspace/report.csv`,
)
console.log(result.output)
```

## 支持的模型

Atlas Cloud 提供覆盖 LLM、图像与视频模态的数百款模型，其中 OMA 编排的是文本 LLM。模型目录更新频繁，因此请以 Atlas Cloud 官方列表为准，不在此固定版本号。可浏览[模型库](https://www.atlascloud.ai/models/llm)查看当前目录，并将模型的精确 ID 字符串填入 `model` 字段。

当前覆盖的模型家族包括 DeepSeek、Qwen（阿里）、Kimi（月之暗面）、GLM（智谱）、MiniMax、豆包（字节跳动）、Grok（xAI）。

由于 Atlas Cloud 将所有模型统一置于同一个 OpenAI 兼容端点之后，单个 Atlas Cloud key 即可让一个 OMA team 在不同 agent 间混用多个模型家族，全部通过上述 `provider: 'openai'` + `baseURL` 配置完成，无需逐厂商单独接线。

Atlas Cloud 的图像与视频生成模型并非文本 LLM，不在 OMA 的 agent 编排范围内。

## 原生 adapter

目前尚无 Atlas Cloud 原生 adapter，上述 OpenAI 兼容方式即为受支持的接入路径。该 adapter 位置对 Atlas Cloud 开放，可参照 OMA 既有的 provider 实现模式提交 PR，参考实现见 [`packages/core/src/llm/minimax.ts`](../packages/core/src/llm/minimax.ts)。

## 声明

- Atlas Cloud 是 `open-multi-agent` 的付费赞助商。赞助不影响技术决策与模型推荐。
- 兑换码数量有限，不构成对任何模型或功能的付费背书。
