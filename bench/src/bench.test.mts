/**
 * Unit checks for the benchmark's own arithmetic.
 *
 *   npx tsx --test bench/src/bench.test.mts
 *
 * These cover the parts that could silently produce a wrong number in the
 * report: pricing, dispersion, concurrency derivation, CSV escaping, and the
 * promise that prompts come from the examples rather than from a copy.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { priceCall, pricingIsComplete } from './config.mts'
import { summarizeCalls, type CallRecord } from './proxy.mts'
import {
  decodeOpponentScores,
  dispersion,
  encodeOpponentScores,
  foldPairScore,
  percentDelta,
  toCSV,
  type RunRecord,
} from './results.mts'
import { assertLiteral, systemPromptOf } from './prompts.mts'
import { BENCH_TASKS, DAG_VARIANTS } from './tasks.mts'

const PRICES = {
  pro: { input: 2, cachedInput: 0.2, output: 8 },
  flash: { input: 0.5, cachedInput: 0.05, output: 1.5 },
  partial: { input: 1, cachedInput: null, output: 3 },
  noOutput: { input: 1, cachedInput: 0.1, output: null },
}

test('priceCall bills uncached and cached prompt tokens at different rates', () => {
  const cost = priceCall(PRICES, 'pro', { input: 1_000_000, cached: 400_000, output: 500_000 })
  // 600k uncached @ $2/M + 400k cached @ $0.2/M + 500k output @ $8/M
  assert.equal(cost, 1.2 + 0.08 + 4)
})

test('priceCall with no cache hits ignores the cached rate', () => {
  assert.equal(priceCall(PRICES, 'flash', { input: 200_000, cached: 0, output: 100_000 }), 0.1 + 0.15)
})

test('priceCall returns null rather than guessing a missing price', () => {
  assert.equal(priceCall(PRICES, 'unknown-model', { input: 10, cached: 0, output: 10 }), null)
  assert.equal(priceCall(PRICES, 'noOutput', { input: 10, cached: 0, output: 10 }), null)
  // A missing cached rate only matters when cache hits actually occurred.
  assert.equal(priceCall(PRICES, 'partial', { input: 10, cached: 5, output: 10 }), null)
  assert.notEqual(priceCall(PRICES, 'partial', { input: 10, cached: 0, output: 10 }), null)
})

test('pricingIsComplete requires every rate on every model touched', () => {
  assert.equal(pricingIsComplete(PRICES, ['pro', 'flash']), true)
  assert.equal(pricingIsComplete(PRICES, ['pro', 'partial']), false)
  assert.equal(pricingIsComplete(PRICES, ['missing']), false)
})

test('dispersion reports median, min and max, not just the mean', () => {
  const odd = dispersion([5, 1, 3])
  assert.deepEqual({ n: odd!.n, median: odd!.median, min: odd!.min, max: odd!.max }, { n: 3, median: 3, min: 1, max: 5 })
  const even = dispersion([10, 2, 4, 8])
  assert.equal(even!.median, 6)
  // A single outlier moves the mean but not the median: the reason the report
  // leads with the median.
  const skewed = dispersion([1, 1, 1, 1, 100])
  assert.equal(skewed!.median, 1)
  assert.equal(skewed!.mean, 20.8)
  assert.equal(dispersion([]), null)
})

test('percentDelta refuses to divide by a zero baseline', () => {
  assert.equal(percentDelta(150, 100), 50)
  assert.equal(percentDelta(50, 100), -50)
  assert.equal(percentDelta(10, 0), null)
})

test('summarizeCalls derives peak concurrency from overlapping calls', () => {
  const record = (startedAt: number, finishedAt: number, model = 'pro'): CallRecord => ({
    label: 'run', model, inputTokens: 100, outputTokens: 10, cachedInputTokens: 20,
    reasoningTokens: 0, status: 200, startedAt, finishedAt, latencyMs: finishedAt - startedAt,
  })
  // Three calls overlap in [200, 250]; a fourth runs alone afterwards.
  const stats = summarizeCalls(
    [record(100, 300), record(200, 400), record(200, 250), record(500, 600, 'flash')],
    1000,
  )
  assert.equal(stats.maxConcurrentCalls, 3)
  assert.equal(stats.llmCalls, 4)
  assert.equal(stats.inputTokens, 400)
  assert.equal(stats.cachedInputTokens, 80)
  // (200 + 200 + 50 + 100) / 1000
  assert.equal(stats.parallelism, 0.55)
  assert.equal(stats.perModel.get('flash')!.calls, 1)
  assert.equal(stats.perModel.get('pro')!.calls, 3)
})

test('summarizeCalls counts non-200 responses as failures', () => {
  const failed: CallRecord = {
    label: 'run', model: 'pro', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
    reasoningTokens: 0, status: 429, startedAt: 0, finishedAt: 10, latencyMs: 10, error: 'rate limited',
  }
  assert.equal(summarizeCalls([failed], 100).failedCalls, 1)
})

test('foldPairScore keeps every challenger a run was judged against', () => {
  // Regression: group A is judged once per challenger, and the earlier code
  // assigned each verdict to a single `quality_score`. With the shipped
  // `groups: ["A","B","C"]` the A-vs-C verdict landed last and erased the
  // A-vs-B one, so the report's headline subtracted A's score against C from
  // B's score against A — two different pairs.
  const vsB = foldPairScore('', 'B', 0.72)
  assert.equal(vsB.byOpponent, 'B=0.720')
  assert.equal(vsB.mean, 0.72)

  const vsBandC = foldPairScore(vsB.byOpponent, 'C', 0.84)
  assert.equal(vsBandC.byOpponent, 'B=0.720;C=0.840')
  assert.equal(decodeOpponentScores(vsBandC.byOpponent).get('B'), 0.72)
  assert.equal(decodeOpponentScores(vsBandC.byOpponent).get('C'), 0.84)
  assert.equal(vsBandC.mean, 0.78)
})

test('foldPairScore is idempotent, so recovering verdicts twice is safe', () => {
  // merge-judge.mts re-reads verdict files that run-bench.mts may already have
  // folded in, and `readdirSync` order must not change the outcome.
  const forward = foldPairScore(foldPairScore('', 'B', 0.5).byOpponent, 'C', 0.9)
  const reverse = foldPairScore(foldPairScore('', 'C', 0.9).byOpponent, 'B', 0.5)
  assert.equal(forward.byOpponent, reverse.byOpponent)
  assert.equal(foldPairScore(forward.byOpponent, 'B', 0.5).byOpponent, forward.byOpponent)
})

test('opponent scores survive a CSV round trip and ignore junk cells', () => {
  const scores = new Map([['C', 0.8125], ['B', 0.5]])
  // Rounded to three places and ordered, so a re-run diffs cleanly.
  assert.equal(encodeOpponentScores(scores), 'B=0.500;C=0.813')
  assert.deepEqual([...decodeOpponentScores('B=0.500;C=0.813')], [['B', 0.5], ['C', 0.813]])
  // An unscored run, and cells no longer parseable, are absent rather than zero.
  assert.equal(decodeOpponentScores('').size, 0)
  assert.equal(decodeOpponentScores('B=;=0.5;garbage').size, 0)
})

test('toCSV escapes separators and writes null as an empty cell', () => {
  const record = {
    run_id: 'r1', date: '2026-01-01', run_stamp: '2026-01-01-pilot', task: 't', task_kind: 'favourable',
    group: 'A', variant: 'as-published', repetition: 1,
    group_order: 'A>B', role_models: 'a=x;b=y', input_tokens: 1, output_tokens: 2, cached_tokens: 0,
    total_tokens: 3, est_cost_usd: null, wall_seconds: 1.5, agent_count: 4, parallelism: 2,
    max_concurrent_calls: 2, llm_calls: 4, success: true, quality_score: null,
    quality_by_opponent: '', judge_model: '',
    temperature: 0.2, thinking: 'disabled', cache_busting: true, framework_input_tokens: 1,
    framework_output_tokens: 2, budget_exceeded: false, notes: 'a, b "quoted"',
  } satisfies RunRecord
  const lines = toCSV([record]).trim().split('\n')
  assert.equal(lines[0]!.split(',')[0], 'run_id')
  assert.match(lines[1]!, /,"a, b ""quoted""",?$/)
  // est_cost_usd and quality_score are unknown, not zero.
  assert.match(lines[1]!, /,,1\.5,/)
})

test('system prompts are read from the cookbook examples, not restated here', () => {
  const example = 'packages/core/examples/cookbook/contract-review-dag.ts'
  const prompt = systemPromptOf(example, 'extractor')
  assert.match(prompt, /^You are a contract clause extraction specialist\./)
  assert.equal(assertLiteral(example, prompt), prompt)
  assert.throws(() => systemPromptOf(example, 'no-such-agent'), /no agent named/)
  assert.throws(() => assertLiteral(example, 'a literal that is not in the example'), /literal not found/)
})

test('every task builds a DAG whose terminal task depends on the others', () => {
  for (const task of Object.values(BENCH_TASKS)) {
    const config = { models: { strong: 'strong-model', cheap: 'cheap-model' } } as never
    const tasks = task.buildTasks({ runId: 'test', config })
    assert.equal(tasks.length, task.agentCount, `${task.id}: task count matches agent count`)
    const terminal = tasks[tasks.length - 1]!
    assert.ok((terminal.dependsOn?.length ?? 0) >= 2, `${task.id}: terminal task fans in`)
    const titles = new Set(tasks.map((t) => t.title))
    for (const t of tasks) {
      for (const dependency of t.dependsOn ?? []) {
        assert.ok(titles.has(dependency), `${task.id}: "${t.title}" depends on unknown "${dependency}"`)
      }
    }
    // Every role the routing policy names must exist on the team.
    const agentNames = new Set(tasks.map((t) => t.assignee))
    for (const rule of task.routing({ models: { strong: 's', cheap: 'c' } } as never).rules) {
      assert.ok(agentNames.has(rule.match.agent!), `${task.id}: routing names unknown agent "${rule.match.agent}"`)
    }
  }
})

test('group A and the single-agent groups are asked for the same deliverable', () => {
  for (const task of Object.values(BENCH_TASKS)) {
    const config = {
      models: { strong: 'strong-model', cheap: 'cheap-model' },
      provider: 'deepseek', temperature: 0.2, thinking: { enabled: false }, maxTurns: 1,
      cacheBusting: true,
    } as never
    const single = task.buildSingleAgent({ runId: 'test', config }, 'strong-model')
    assert.ok(single.config.systemPrompt!.includes(task.deliverable), `${task.id}: deliverable stated to the single agent`)
    // Each team role's instructions reach the single agent verbatim.
    for (const agent of task.buildTeamAgents({ runId: 'test', config })) {
      const roleInstructions = agent.systemPrompt!.replace(/^\[bench test\]\n/, '')
      assert.ok(
        single.config.systemPrompt!.includes(roleInstructions),
        `${task.id}: role "${agent.name}" instructions missing from the single-agent prompt`,
      )
    }
  }
})

test('cache-busting salt is per run and identical in shape across groups', () => {
  const config = {
    models: { strong: 's', cheap: 'c' }, provider: 'deepseek', temperature: 0.2,
    thinking: { enabled: false }, maxTurns: 1, cacheBusting: true,
  } as never
  const task = BENCH_TASKS['contract-review']!
  const teamOne = task.buildTeamAgents({ runId: 'run-one', config })
  const teamTwo = task.buildTeamAgents({ runId: 'run-two', config })
  assert.notEqual(teamOne[0]!.systemPrompt, teamTwo[0]!.systemPrompt)
  assert.match(teamOne[0]!.systemPrompt!, /^\[bench run-one\]\n/)
  assert.match(task.buildSingleAgent({ runId: 'run-one', config }, 's').config.systemPrompt!, /^\[bench run-one\]\n/)

  const off = { ...(config as object), cacheBusting: false } as never
  assert.doesNotMatch(task.buildTeamAgents({ runId: 'run-one', config: off })[0]!.systemPrompt!, /^\[bench /)
})

test('the salt varies by invocation, not only by run id', () => {
  // Regression: run ids are deterministic (`task-group-rN`), so a salt built
  // from the run id alone repeats across invocations. A re-run then inherits
  // the previous attempt's provider-side prompt cache, and cached_tokens stops
  // being zero — which is exactly what happened on 2026-08-18 repetition 1.
  const config = {
    models: { strong: 's', cheap: 'c' }, provider: 'deepseek', temperature: 0.2,
    thinking: { enabled: false }, maxTurns: 1, cacheBusting: true,
  } as never
  const task = BENCH_TASKS['contract-review']!
  const first = task.buildTeamAgents({ runId: 'contract-review-A-r1', config, nonce: 'aaaa1111' })[0]!.systemPrompt!
  const second = task.buildTeamAgents({ runId: 'contract-review-A-r1', config, nonce: 'bbbb2222' })[0]!.systemPrompt!
  assert.notEqual(first, second, 'same run id in two invocations must not produce the same prompt')
  // The nonce has to sit in the first characters, ahead of any shared text, or
  // the provider still matches a cached prefix block.
  assert.match(first, /^\[bench aaaa1111 contract-review-A-r1\]\n/)
  const single = task.buildSingleAgent({ runId: 'contract-review-B-r1', config, nonce: 'aaaa1111' }, 's')
  assert.match(single.config.systemPrompt!, /^\[bench aaaa1111 contract-review-B-r1\]\n/)
})

test('the fixed-merge variant gives each terminal task the source material', () => {
  const config = { models: { strong: 's', cheap: 'c' } } as never
  const build = (id: string, variant?: 'as-published' | 'fixed-merge') =>
    BENCH_TASKS[id]!.buildTasks({ runId: 'test', config, ...(variant ? { variant } : {}) })

  // contract-review: notify gains extract-clauses as a third dependency.
  const publishedNotify = build('contract-review').at(-1)!
  const fixedNotify = build('contract-review', 'fixed-merge').at(-1)!
  assert.deepEqual([...publishedNotify.dependsOn!], ['compliance-check', 'summary'])
  assert.deepEqual([...fixedNotify.dependsOn!], ['extract-clauses', 'compliance-check', 'summary'])

  // meeting-report: the aggregator carries the transcript the specialists saw.
  const publishedAggregate = build('meeting-report').at(-1)!
  const fixedAggregate = build('meeting-report', 'fixed-merge').at(-1)!
  const transcriptOpening = build('meeting-report')[0]!.description.slice(0, 60)
  assert.ok(!publishedAggregate.description.includes(transcriptOpening))
  assert.ok(fixedAggregate.description.includes(transcriptOpening))

  // Only the wiring moves: task count, assignees and titles are untouched.
  for (const id of Object.keys(BENCH_TASKS)) {
    const published = build(id)
    const fixed = build(id, 'fixed-merge')
    assert.equal(fixed.length, published.length)
    assert.deepEqual(fixed.map((t) => t.title), published.map((t) => t.title))
    assert.deepEqual(fixed.map((t) => t.assignee), published.map((t) => t.assignee))
  }

  // Explicitly: the default is the unmodified example.
  assert.deepEqual(build('contract-review', 'as-published').at(-1)!.dependsOn, publishedNotify.dependsOn)
  assert.ok(Object.keys(DAG_VARIANTS).includes('fixed-merge'))
})
