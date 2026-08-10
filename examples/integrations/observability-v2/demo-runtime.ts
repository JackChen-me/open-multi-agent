import {
  OpenMultiAgent,
  type AgentConfig,
  type LLMAdapter,
  type LLMResponse,
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
