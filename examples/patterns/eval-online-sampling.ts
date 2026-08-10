/**
 * Online evaluation sampling — asynchronous scoring with a durable local FileEvalStore.
 *
 * Run:
 *   npx tsx examples/patterns/eval-online-sampling.ts
 *
 * This fixture uses a local adapter. Set OMA_EVAL_STORE_PATH to choose the NDJSON file.
 */
import { OpenMultiAgent, type LLMAdapter } from '../../packages/core/src/index.js'
import { costBudgetScorer } from '../../packages/core/src/eval/index.js'
import { FileEvalStore } from '../../packages/core/src/eval/file.js'

const adapter: LLMAdapter = {
  name: 'fixture-online',
  async chat(_messages, options) {
    return {
      id: 'fixture-online-response',
      content: [{ type: 'text', text: 'Evaluation runs after this response settles.' }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 7 },
    }
  },
  async *stream() {},
}

const path = process.env['OMA_EVAL_STORE_PATH'] ?? './eval-results/online-eval.ndjson'
const store = await FileEvalStore.open(path)
const orchestrator = new OpenMultiAgent({
  evaluation: {
    scorers: [costBudgetScorer({ maxTokens: 100 })],
    sample: 1,
    maxConcurrent: 1,
    maxQueueLength: 10,
    budget: { maxEvaluationsPerMinute: 10 },
    store,
  },
})

try {
  const result = await orchestrator.runAgent({
    name: 'online-fixture',
    model: 'fixture-model-v1',
    adapter,
  }, 'Explain when online evaluation runs.')

  const flush = await orchestrator.evaluation.forceFlush({ timeoutMs: 5_000 })
  await store.flush()
  console.log(JSON.stringify({
    businessOutput: result.output,
    evaluation: flush,
    stats: orchestrator.evaluation.getStats(),
    store: path,
  }, null, 2))
} finally {
  await orchestrator.evaluation.shutdown({ timeoutMs: 5_000 })
  await store.flush()
  await store.close()
}
