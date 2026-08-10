/**
 * Offline evaluation regression — two model configurations, rule + judge scorers, and a gate.
 *
 * Run:
 *   npx tsx examples/patterns/eval-offline-regression.ts
 *
 * This fixture uses local mock adapters so it runs without network access or API keys.
 * Replace the adapters and fixture model names with production AgentConfig values.
 */
import type { LLMAdapter, LLMMessage } from '../../packages/core/src/index.js'
import {
  createAnswerRelevancyScorer,
  defineEvalSet,
  defineScorer,
  evaluateGate,
  runEvalSet,
  targetFromAgent,
  type EvalRunReport,
} from '../../packages/core/src/eval/index.js'

function lastUserText(messages: LLMMessage[]): string {
  const user = [...messages].reverse().find((message) => message.role === 'user')
  return (user?.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

const fixtureTargetAdapter: LLMAdapter = {
  name: 'fixture-target',
  async chat(messages, options) {
    const prompt = lastUserText(messages)
    const text = prompt.includes('2 + 2') ? '4' : 'Paris'
    return {
      id: `fixture-${options.model}`,
      content: [{ type: 'text', text }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 8, output_tokens: 1 },
    }
  },
  async *stream() {},
}

const fixtureJudgeAdapter: LLMAdapter = {
  name: 'fixture-judge',
  async chat(_messages, options) {
    return {
      id: 'fixture-judge-response',
      content: [{ type: 'text', text: '{"score":1,"reason":"directly answers the case"}' }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 8 },
    }
  },
  async *stream() {},
}

const set = defineEvalSet({
  name: 'offline-regression-fixture',
  version: '1.0.0',
  cases: [
    { id: 'arithmetic', input: 'What is 2 + 2?', expected: '4', tags: ['critical'] },
    { id: 'capital', input: 'What is the capital of France?', expected: 'Paris' },
  ],
})

const exact = defineScorer({
  name: 'exact_match',
  version: '1',
  score({ output, evalCase }) {
    const pass = output === evalCase.expected
    return { score: pass ? 1 : 0, pass }
  },
})
const relevancy = createAnswerRelevancyScorer({
  version: 'fixture-prompt-v1',
  judges: [{
    name: 'relevancy-judge',
    model: 'fixture-judge-v1',
    adapter: fixtureJudgeAdapter,
  }],
})

const targets = [
  {
    name: 'baseline-model',
    target: targetFromAgent({
      name: 'baseline-agent',
      model: 'fixture-baseline-v1',
      adapter: fixtureTargetAdapter,
    }),
  },
  {
    name: 'candidate-model',
    target: targetFromAgent({
      name: 'candidate-agent',
      model: 'fixture-candidate-v2',
      systemPrompt: 'Answer directly and concisely.',
      adapter: fixtureTargetAdapter,
    }),
  },
] as const

const reports: EvalRunReport[] = []
for (const entry of targets) {
  reports.push(await runEvalSet(set, entry.target, {
    scorers: [exact, relevancy],
    repeats: 2,
    metadata: { target_name: entry.name },
  }))
}

const [baseline, candidate] = reports
if (baseline === undefined || candidate === undefined) throw new Error('Expected two reports.')
const verdict = evaluateGate(candidate, {
  schemaVersion: 1,
  thresholds: [
    { scorer: 'exact_match', metric: 'passRate', min: 1 },
    { scorer: 'answer_relevancy', metric: 'avg', min: 0.9 },
  ],
  maxScorerErrorRate: 0,
  maxTargetErrorRate: 0,
  baseline: { maxRegression: 0 },
}, baseline)

if (!verdict.pass) throw new Error(`Fixture gate failed: ${JSON.stringify(verdict.failures)}`)
console.log(JSON.stringify({
  targets: targets.map((target) => target.name),
  candidate: candidate.aggregates,
  verdict,
}, null, 2))
