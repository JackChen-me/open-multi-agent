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
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  classifyInvocationWindow,
  priceCall,
  pricingIsComplete,
  TIME_OF_DAY_PRICING,
} from './config.mts'
import { summarizeCalls, type CallRecord } from './proxy.mts'
import {
  CSV_COLUMNS,
  decodeOpponentScores,
  dispersion,
  encodeOpponentScores,
  foldPairScore,
  fromCSV,
  percentDelta,
  toCSV,
  type RunRecord,
} from './results.mts'
import { assertLiteral, systemPromptOf } from './prompts.mts'
import { aggregateOrders } from './judge.mts'
import { budgetLimit, cacheNote, deltaShifts, pricingLimit, rangesOverlap, thinkingNote } from './report.mts'
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

// ---------------------------------------------------------------------------
// Limits prose that used to be asserted rather than computed
// ---------------------------------------------------------------------------

const budgetRow = (run_id: string, framework: number, exceeded = false) => ({
  run_id,
  budget_exceeded: String(exceeded),
  framework_input_tokens: String(Math.round(framework * 0.9)),
  framework_output_tokens: String(framework - Math.round(framework * 0.9)),
})

test('budgetLimit reports a run that hit the ceiling instead of denying it happened', () => {
  // Regression: this line read "The token budget never bound" unconditionally
  // while budget_exceeded sat unread in every row, so a run that was truncated
  // at the ceiling got a report stating the opposite.
  const line = budgetLimit(
    [budgetRow('contract-review-A-r1', 10_000), budgetRow('contract-review-A-r2', 400_000, true)],
    { maxTokenBudget: 400_000 },
  )
  assert.match(line, /budget bound on 1 run\(s\)/)
  assert.match(line, /contract-review-A-r2/)
  assert.doesNotMatch(line, /never bound/)
  // A truncated run must not be read as a cheap one.
  assert.match(line, /truncated, not as cheap/)
})

test('budgetLimit states real headroom when the budget did not bind', () => {
  const line = budgetLimit(
    [budgetRow('a', 10_000), budgetRow('b', 40_000), budgetRow('c', 25_000)],
    { maxTokenBudget: 400_000 },
  )
  assert.match(line, /never bound/)
  // The peak run, not the mean or the last: 40,000 of 400,000 is 10.0%.
  assert.match(line, /40,000 tokens of the 400,000 configured \(10\.0%\)/)
  // Headroom is measured on the accounting the budget is actually enforced against.
  assert.match(line, /framework's own\s+accounting/)
})

test('budgetLimit does not claim a budget held when none was set', () => {
  for (const config of [{}, { maxTokenBudget: 0 }, { maxTokenBudget: 'unset' }]) {
    const line = budgetLimit([budgetRow('a', 10_000)], config)
    assert.match(line, /No token budget was configured/)
    assert.doesNotMatch(line, /never bound/)
  }
})

const cmp = (tokens: number | null, wall: number | null, cost: number | null) =>
  ({ tokens, wall, cost, quality: null, aQuality: null, bQuality: null })

test('deltaShifts measures how far dropping rows moves the headline', () => {
  const shifts = deltaShifts(cmp(66.8, 192.3, 21.3), cmp(64.1, 190.0, 19.9))
  assert.deepEqual(shifts.map((s) => s.metric), ['tokens', 'wall', 'cost'])
  assert.equal(shifts[0]!.movedPoints!.toFixed(1), '-2.7')
  assert.equal(shifts.some((s) => s.flipped), false)
})

test('deltaShifts flags a comparison that reverses direction', () => {
  // The case the old hard-coded prose promised could not happen: A looks worse
  // than B on the full sample and better once the contaminated rows go.
  const shifts = deltaShifts(cmp(12.0, 5.0, 3.0), cmp(-4.0, 5.0, 3.0))
  assert.equal(shifts[0]!.flipped, true)
  assert.equal(shifts[0]!.movedPoints, -16)
  assert.equal(shifts[1]!.flipped, false)
})

test('deltaShifts treats an uncomputable or zero side as no flip', () => {
  const missing = deltaShifts(cmp(null, 5.0, null), cmp(10.0, null, null))
  assert.equal(missing[0]!.movedPoints, null)
  assert.equal(missing[0]!.flipped, false)
  assert.equal(missing[1]!.flipped, false)
  // A delta landing exactly on zero has no direction to reverse.
  assert.equal(deltaShifts(cmp(5, 0, 0), cmp(0, 0, 0))[0]!.flipped, false)
})

// ---------------------------------------------------------------------------
// Judge aggregation, CSV round-tripping, and vendor-neutral prose
// ---------------------------------------------------------------------------

test('aggregateOrders cancels a judge that always prefers whatever it reads first', () => {
  // The report claims position preference cannot move the result. This is that
  // claim: a judge that scores slot 1 at 0.9 and slot 2 at 0.4 regardless of
  // content must leave both groups on the same score and no winner.
  const { scores, preferred } = aggregateOrders([
    { firstGroup: 'A', secondGroup: 'B', firstScore: 0.9, secondScore: 0.4, preferred: '1' },
    { firstGroup: 'B', secondGroup: 'A', firstScore: 0.9, secondScore: 0.4, preferred: '1' },
  ])
  assert.equal(scores['A'], 0.65)
  assert.equal(scores['B'], 0.65)
  assert.deepEqual(preferred, { A: 'tie', B: 'tie' })
})

test('aggregateOrders keeps a real preference that survives both orders', () => {
  const { scores, preferred } = aggregateOrders([
    { firstGroup: 'A', secondGroup: 'B', firstScore: 0.9, secondScore: 0.5, preferred: '1' },
    { firstGroup: 'B', secondGroup: 'A', firstScore: 0.5, secondScore: 0.9, preferred: '2' },
  ])
  assert.equal(scores['A'], 0.9)
  assert.equal(scores['B'], 0.5)
  assert.deepEqual(preferred, { A: 'win', B: 'loss' })
})

test('aggregateOrders reports a split verdict as a tie, not as the last order seen', () => {
  const { preferred } = aggregateOrders([
    { firstGroup: 'A', secondGroup: 'B', firstScore: 0.8, secondScore: 0.7, preferred: '1' },
    { firstGroup: 'B', secondGroup: 'A', firstScore: 0.8, secondScore: 0.7, preferred: '1' },
  ])
  assert.deepEqual(preferred, { A: 'tie', B: 'tie' })
  // An explicit tie in both orders is also a tie.
  assert.deepEqual(
    aggregateOrders([
      { firstGroup: 'A', secondGroup: 'B', firstScore: 0.5, secondScore: 0.5, preferred: 'tie' },
      { firstGroup: 'B', secondGroup: 'A', firstScore: 0.5, secondScore: 0.5, preferred: 'tie' },
    ]).preferred,
    { A: 'tie', B: 'tie' },
  )
})

test('fromCSV round-trips everything toCSV escapes', () => {
  // There used to be four readers; the naive one would have split this row's
  // notes into extra cells and shifted every column after it.
  const record = {
    run_id: 'r1', date: '2026-01-01', run_stamp: '2026-01-01-pilot', task: 't', task_kind: 'favourable',
    group: 'A', variant: 'as-published', repetition: 1, group_order: 'A>B', role_models: 'a=x;b=y',
    input_tokens: 1, output_tokens: 2, cached_tokens: 0, total_tokens: 3, est_cost_usd: null,
    wall_seconds: 1.5, agent_count: 4, parallelism: 2, max_concurrent_calls: 2, llm_calls: 4,
    success: true, quality_score: null, quality_by_opponent: 'B=0.700;C=0.900', judge_model: '',
    temperature: 0.2, thinking: 'disabled', cache_busting: true, framework_input_tokens: 1,
    framework_output_tokens: 2, budget_exceeded: false,
    notes: 'a, b "quoted"\nand a newline',
  } satisfies RunRecord
  const [row] = fromCSV(toCSV([record]))
  assert.ok(row)
  assert.equal(row['notes'], 'a, b "quoted"\nand a newline')
  assert.equal(row['quality_by_opponent'], 'B=0.700;C=0.900')
  assert.equal(row['run_stamp'], '2026-01-01-pilot')
  // Unknown stays unknown across the round trip: not zero, not "null".
  assert.equal(row['est_cost_usd'], '')
  assert.equal(row['quality_score'], '')
  // The column after the embedded comma and newline is still itself.
  assert.equal(row['group_order'], 'A>B')
  assert.equal(row['wall_seconds'], '1.5')
})

test('fromCSV tolerates CRLF, a missing trailing newline, and an empty file', () => {
  const rows = fromCSV('a,b\r\n1,2\r\n3,4')
  assert.deepEqual(rows, [{ a: '1', b: '2' }, { a: '3', b: '4' }])
  assert.deepEqual(fromCSV(''), [])
  assert.deepEqual(fromCSV('a,b\n'), [])
})

test('the README CSV column list matches the columns actually written', () => {
  // The list drifted once already: `variant` shipped in the CSV and never made
  // it into the README.
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf-8')
  const section = readme.slice(readme.indexOf('## CSV columns'))
  const documented = [...section.slice(0, section.indexOf('\n\n', section.indexOf('`')) + 2).matchAll(/`([a-z_]+)`/g)]
    .map((match) => match[1]!)
  for (const column of CSV_COLUMNS) {
    assert.ok(documented.includes(column), `README does not document the "${column}" column`)
  }
})

test('report prose names the provider that actually ran, not DeepSeek by default', () => {
  // A run against another vendor used to inherit DeepSeek's product facts:
  // its default reasoning effort, its uncloseable prompt cache, its peak rates.
  const other = { provider: 'openai', thinking: { enabled: true } }
  assert.doesNotMatch(thinkingNote('openai', other), /DeepSeek/)
  assert.match(thinkingNote('openai', other), /Thinking is enabled identically/)
  assert.doesNotMatch(cacheNote('openai'), /DeepSeek/)
  assert.match(cacheNote('openai'), /openai server-side behaviour/)
  assert.doesNotMatch(pricingLimit('openai'), /DeepSeek|peak/)

  // The vendor facts survive for the vendor they are true of.
  assert.match(thinkingNote('deepseek', { thinking: { enabled: false } }), /DeepSeek V4 enables thinking/)
  assert.match(cacheNote('deepseek'), /DeepSeek's context cache cannot be switched off/)
  assert.match(pricingLimit('deepseek'), /01:00-04:00 and 06:00-10:00 UTC/)
  // Either way the report says where the prices came from.
  for (const provider of ['deepseek', 'openai']) {
    assert.match(pricingLimit(provider), /operator-supplied/)
  }
})

test('rangesOverlap refuses to separate two groups whose observed ranges touch', () => {
  const span = (min: number, max: number) => ({ n: 2, median: (min + max) / 2, min, max, mean: (min + max) / 2 })
  assert.equal(rangesOverlap(span(0.4, 0.6), span(0.5, 0.8)), true)
  assert.equal(rangesOverlap(span(0.4, 0.5), span(0.5, 0.8)), true, 'touching at a single point still overlaps')
  assert.equal(rangesOverlap(span(0.1, 0.4), span(0.5, 0.8)), false)
  // Missing data is not evidence of separation.
  assert.equal(rangesOverlap(null, span(0.5, 0.8)), true)
})

// ---------------------------------------------------------------------------
// Which rate schedule the invocation was actually billed on
// ---------------------------------------------------------------------------

const DEEPSEEK = TIME_OF_DAY_PRICING['deepseek']!
const at = (iso: string) => `2026-08-18T${iso}Z`

test('classifyInvocationWindow separates peak, off-peak and a straddled boundary', () => {
  // DeepSeek peak is 01:00-04:00 and 06:00-10:00 UTC.
  assert.equal(classifyInvocationWindow(DEEPSEEK, at('01:30:00'), at('03:45:00')), 'peak')
  assert.equal(classifyInvocationWindow(DEEPSEEK, at('06:05:00'), at('09:55:00')), 'peak')
  assert.equal(classifyInvocationWindow(DEEPSEEK, at('12:00:00'), at('13:00:00')), 'off-peak')
  // 04:00-06:00 is the gap between the two peak windows.
  assert.equal(classifyInvocationWindow(DEEPSEEK, at('04:10:00'), at('05:50:00')), 'off-peak')
  // Started in peak, finished after it closed.
  assert.equal(classifyInvocationWindow(DEEPSEEK, at('03:30:00'), at('04:30:00')), 'mixed')
  // Started off-peak, ran into a window.
  assert.equal(classifyInvocationWindow(DEEPSEEK, at('05:30:00'), at('06:30:00')), 'mixed')
  // Spanning both windows necessarily covers the off-peak gap between them.
  assert.equal(classifyInvocationWindow(DEEPSEEK, at('02:00:00'), at('08:00:00')), 'mixed')
})

test('classifyInvocationWindow handles boundaries, midnight, and long runs', () => {
  // The window is half-open: 04:00 is already off-peak.
  assert.equal(classifyInvocationWindow(DEEPSEEK, at('01:00:00'), at('04:00:00')), 'peak')
  assert.equal(classifyInvocationWindow(DEEPSEEK, at('04:00:00'), at('04:00:00')), 'off-peak')
  assert.equal(classifyInvocationWindow(DEEPSEEK, at('01:00:00'), at('01:00:00')), 'peak')
  // Crossing UTC midnight into the 01:00 window, which needs the previous day's
  // windows to be considered too.
  assert.equal(
    classifyInvocationWindow(DEEPSEEK, '2026-08-18T23:30:00Z', '2026-08-19T00:30:00Z'),
    'off-peak',
  )
  assert.equal(
    classifyInvocationWindow(DEEPSEEK, '2026-08-18T23:30:00Z', '2026-08-19T01:30:00Z'),
    'mixed',
  )
  // A daily schedule cannot be uniform across a whole day.
  assert.equal(classifyInvocationWindow(DEEPSEEK, at('01:30:00'), '2026-08-19T02:00:00Z'), 'mixed')
})

test('classifyInvocationWindow refuses to guess without a usable window', () => {
  assert.equal(classifyInvocationWindow(undefined, at('01:30:00'), at('02:00:00')), 'unknown')
  assert.equal(classifyInvocationWindow(DEEPSEEK, undefined, at('02:00:00')), 'unknown')
  assert.equal(classifyInvocationWindow(DEEPSEEK, at('01:30:00'), null), 'unknown')
  assert.equal(classifyInvocationWindow(DEEPSEEK, 'not a date', at('02:00:00')), 'unknown')
  // Finishing before starting is a broken manifest, not an instant.
  assert.equal(classifyInvocationWindow(DEEPSEEK, at('03:00:00'), at('02:00:00')), 'unknown')
})

test('pricingLimit says which schedule the run was billed on rather than assuming peak', () => {
  // Regression: this line asserted "Pricing is DeepSeek's published peak rate at
  // the time of the run" for every run, including runs that were entirely
  // off-peak and therefore billed half of what the cost column reports.
  const inPeak = pricingLimit('deepseek', { startedAtUtc: at('01:30:00'), finishedAtUtc: at('03:00:00') })
  assert.match(inPeak, /ran entirely inside the peak window/)
  assert.match(inPeak, /needs no adjustment/)

  const offPeak = pricingLimit('deepseek', { startedAtUtc: at('12:00:00'), finishedAtUtc: at('13:00:00') })
  assert.match(offPeak, /ran entirely off-peak/)
  assert.match(offPeak, /about 2x what was actually billed/)

  const straddled = pricingLimit('deepseek', { startedAtUtc: at('03:30:00'), finishedAtUtc: at('04:30:00') })
  assert.match(straddled, /crossed a peak boundary/)
  assert.match(straddled, /weakest number in this report/)

  // No manifest window is stated as unchecked, not as peak.
  const unchecked = pricingLimit('deepseek', {})
  assert.match(unchecked, /was not checked/)
  assert.doesNotMatch(unchecked, /entirely inside|entirely off-peak/)

  // A provider with no time-of-day schedule says nothing about windows at all.
  assert.doesNotMatch(pricingLimit('openai', { startedAtUtc: at('12:00:00'), finishedAtUtc: at('13:00:00') }), /peak/)
})
