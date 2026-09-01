import { z } from 'zod'
import {
  defineTool,
  OpenMultiAgent,
  type AgentConfig,
  type LLMAdapter,
  type LLMResponse,
  type TraceCapturePolicy,
  type TraceSink,
} from '@open-multi-agent/core'

function response(text: string): LLMResponse {
  return {
    id: 'observability-demo-response',
    content: [{ type: 'text', text }],
    model: 'deterministic-local-adapter',
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 2 },
  }
}

const adapter: LLMAdapter = {
  name: 'deterministic-local-adapter',
  async chat() { return response('observability plumbing completed') },
  async *stream() {},
}

const agent: AgentConfig = {
  name: 'observability-demo',
  model: 'deterministic-local-adapter',
  adapter,
}

/** Exercise the real OMA instrumentation without network access or an API key. */
export async function runDemo(sink: TraceSink, runId: string) {
  const oma = new OpenMultiAgent({ observability: { sinks: [sink] } })
  return oma.runAgent(agent, 'Run the deterministic observability demo.', { runId })
}

const echoTool = defineTool({
  name: 'echo_tool',
  description: 'Return the caller-supplied payload unchanged.',
  inputSchema: z.object({ payload: z.string() }),
  execute: async ({ payload }) => ({ data: `echoed:${payload}` }),
})

/** Two-turn adapter: request the tool once, then answer. */
function toolCallingAdapter(): LLMAdapter {
  let turn = 0
  return {
    name: 'deterministic-local-adapter',
    async chat() {
      turn += 1
      if (turn === 1) {
        return {
          id: 'observability-demo-tool-call',
          content: [{
            type: 'tool_use',
            id: 'tool-use-1',
            name: 'echo_tool',
            input: { payload: 'demo payload' },
          }],
          model: 'deterministic-local-adapter',
          stop_reason: 'tool_use',
          usage: { input_tokens: 3, output_tokens: 2 },
        }
      }
      return response('observability plumbing completed')
    },
    async *stream() {},
  }
}

/**
 * Same instrumentation as `runDemo`, plus one tool call, so an example can
 * show what a capture policy does to `execute_tool` spans.
 */
export async function runToolDemo(sink: TraceSink, runId: string, capture?: TraceCapturePolicy) {
  const oma = new OpenMultiAgent({
    observability: { sinks: [sink], ...(capture ? { capture } : {}) },
  })
  return oma.runAgent({
    name: 'observability-demo',
    model: 'deterministic-local-adapter',
    adapter: toolCallingAdapter(),
    tools: ['echo_tool'],
    customTools: [echoTool],
  }, 'Call the echo tool, then summarize.', { runId })
}
