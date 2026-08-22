/**
 * OMA A/B benchmark runner.
 *
 *   npx tsx bench/src/run-bench.mts --mock                 # offline wiring check
 *   npx tsx bench/src/run-bench.mts --repetitions 1        # paid pilot
 *   npx tsx bench/src/run-bench.mts --repetitions 5        # full run
 *
 * Groups:
 *   A — OMA multi-agent orchestration (`runTasks`), deterministic model routing
 *       plus a token budget.
 *   B — one agent, one call, the same strong model, same goal, same deliverable.
 *   C — one agent on the cheap tier, to bracket how much of A-vs-B is model tier
 *       rather than orchestration.
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentRunResult, OrchestratorEvent, TeamRunResult } from '../../packages/core/src/index.js'
import {
  BENCH_ROOT,
  loadConfig,
  priceCall,
  PROVIDER_KEY_ENV,
  PROVIDER_ORIGINS,
  type BenchConfig,
} from './config.mts'
import { Judge } from './judge.mts'
import { startMockUpstream } from './mock-upstream.mts'
import { RecordingProxy, summarizeCalls } from './proxy.mts'
import { dispersion, foldPairScore, toCSV, type RunRecord } from './results.mts'
import { readFixture } from './prompts.mts'
import { DAG_VARIANTS, taskById, type BenchTaskDefinition, type DagVariant } from './tasks.mts'

interface CliOptions {
  readonly mock: boolean
  readonly verbose: boolean
  readonly repetitions?: number
  readonly tasks?: readonly string[]
  readonly groups?: readonly string[]
  readonly out?: string
  readonly label: string
  readonly skipJudge: boolean
  readonly configPath?: string
  readonly variant: DagVariant
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`bench: ${flag} must be a positive integer, got "${raw}".`)
  }
  return value
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = true
    } else {
      options[key] = next
      i += 1
    }
  }
  return {
    mock: options['mock'] === true,
    verbose: options['verbose'] === true,
    skipJudge: options['skip-judge'] === true,
    // Validated rather than coerced: `Number('abc')` is NaN and `--repetitions 0`
    // is 0, both falsy, so both used to fall through to the config value and run
    // a different number of repetitions than the operator asked for, silently.
    ...(typeof options['repetitions'] === 'string'
      ? { repetitions: positiveInteger(options['repetitions'], '--repetitions') }
      : {}),
    ...(typeof options['tasks'] === 'string' ? { tasks: options['tasks'].split(',') } : {}),
    ...(typeof options['groups'] === 'string' ? { groups: options['groups'].split(',') } : {}),
    ...(typeof options['out'] === 'string' ? { out: options['out'] } : {}),
    ...(typeof options['config'] === 'string' ? { configPath: options['config'] } : {}),
    variant: (() => {
      const value = options['variant']
      if (typeof value !== 'string') return 'as-published'
      if (!(value in DAG_VARIANTS)) {
        throw new Error(`bench: unknown --variant "${value}". Known: ${Object.keys(DAG_VARIANTS).join(', ')}`)
      }
      return value as DagVariant
    })(),
    label: typeof options['label'] === 'string' ? options['label'] : '',
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) return []
  const offset = ((by % items.length) + items.length) % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

/** Wall-clock stamped line, for `--verbose` runs that are meant to be watched. */
function trace(message: string): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}Z] ${message}`)
}

function thinkingLabel(config: BenchConfig): string {
  return config.thinking.enabled
    ? `enabled${config.thinking.effort ? `:${config.thinking.effort}` : ''}`
    : 'disabled'
}

interface ExecutionOutcome {
  readonly success: boolean
  readonly output: string
  readonly frameworkInput: number
  readonly frameworkOutput: number
  readonly wallMs: number
  readonly agentCount: number
  readonly budgetExceeded: boolean
  readonly notes: string[]
}

async function runGroupA(
  config: BenchConfig,
  task: BenchTaskDefinition,
  runId: string,
  proxyBaseURL: string,
  nonce: string,
  variant: DagVariant,
  verbose = false,
): Promise<ExecutionOutcome> {
  const events: OrchestratorEvent[] = []
  const orchestrator = new OpenMultiAgent({
    defaultProvider: config.provider,
    defaultModel: config.models.strong,
    defaultBaseURL: proxyBaseURL,
    maxTokenBudget: config.maxTokenBudget,
    onProgress: (event) => {
      events.push(event)
      if (!verbose) return
      const data = event.data as { title?: string; tokenUsage?: { input_tokens: number; output_tokens: number } } | undefined
      switch (event.type) {
        case 'task_start':
          trace(`  task_start      ${data?.title ?? ''}${event.agent ? ` -> ${event.agent}` : ''}`)
          break
        case 'task_complete':
          trace(
            `  task_complete   ${event.agent ?? ''}`
            + (data?.tokenUsage ? `  ${data.tokenUsage.input_tokens} in / ${data.tokenUsage.output_tokens} out` : ''),
          )
          break
        case 'task_retry':
          trace(`  task_retry      ${JSON.stringify(event.data).slice(0, 120)}`)
          break
        case 'error':
          trace(`  error           ${event.agent ?? ''}`)
          break
        default:
          break
      }
    },
  })
  const ctx = { runId, config, nonce, variant }
  const team = orchestrator.createTeam(runId, {
    name: runId,
    agents: task.buildTeamAgents(ctx),
    sharedMemory: true,
  })

  const started = performance.now()
  let result: TeamRunResult
  try {
    result = await orchestrator.runTasks(team, task.buildTasks(ctx), {
      modelRouting: task.routing(config),
      maxTokenBudget: config.maxTokenBudget,
    })
  } finally {
    await orchestrator.shutdown()
  }
  const wallMs = performance.now() - started

  const notes: string[] = []
  const retries = events.filter((event) => event.type === 'task_retry').length
  if (retries > 0) notes.push(`task_retry x${retries}`)
  for (const event of events) {
    if (event.type !== 'error') continue
    const message = (event.data as { output?: unknown } | undefined)?.output
    notes.push(`error(${event.agent ?? '?'}): ${String(message ?? '').slice(0, 200)}`)
  }
  const failedTasks = (result.tasks ?? []).filter((t) => t.status === 'failed').map((t) => t.title)
  if (failedTasks.length > 0) notes.push(`failed tasks: ${failedTasks.join('|')}`)

  const budgetExceeded = [...result.agentResults.values()].some((r) => r.budgetExceeded === true)
    || result.governanceReason === 'budget'

  const output = task.finalOutput(result)
  if (result.success && output.trim().length === 0) {
    notes.push('terminal task produced empty output')
  }

  return {
    success: result.success && output.trim().length > 0,
    output,
    frameworkInput: result.totalTokenUsage.input_tokens,
    frameworkOutput: result.totalTokenUsage.output_tokens,
    wallMs,
    agentCount: task.agentCount,
    budgetExceeded,
    notes,
  }
}

async function runSingleAgent(
  config: BenchConfig,
  task: BenchTaskDefinition,
  runId: string,
  model: string,
  proxyBaseURL: string,
  nonce: string,
  variant: DagVariant,
): Promise<ExecutionOutcome> {
  const orchestrator = new OpenMultiAgent({
    defaultProvider: config.provider,
    defaultModel: model,
    defaultBaseURL: proxyBaseURL,
    maxTokenBudget: config.maxTokenBudget,
  })
  const { config: agentConfig, input } = task.buildSingleAgent({ runId, config, nonce, variant }, model)

  const started = performance.now()
  let result: AgentRunResult
  try {
    result = await orchestrator.runAgent(agentConfig, input)
  } finally {
    await orchestrator.shutdown()
  }
  const wallMs = performance.now() - started

  const notes: string[] = []
  if (result.loopDetected) notes.push('loop detected')

  return {
    success: result.success && result.output.trim().length > 0,
    output: result.output,
    frameworkInput: result.tokenUsage.input_tokens,
    frameworkOutput: result.tokenUsage.output_tokens,
    wallMs,
    agentCount: 1,
    budgetExceeded: result.budgetExceeded === true,
    notes,
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2))
  const base = loadConfig(cli.configPath ? path.resolve(cli.configPath) : undefined)
  const config: BenchConfig = {
    ...base,
    ...(cli.repetitions ? { repetitions: cli.repetitions } : {}),
    ...(cli.tasks ? { tasks: cli.tasks } : {}),
    ...(cli.groups ? { groups: cli.groups } : {}),
  }

  const date = today()
  const startedAtUtc = new Date().toISOString()
  const nonce = randomUUID().slice(0, 8)
  const stamp = `${date}${cli.label ? `-${cli.label}` : ''}`
  const runsDir = path.join(BENCH_ROOT, 'runs', stamp)
  mkdirSync(runsDir, { recursive: true })
  const csvPath = cli.out
    ? path.resolve(cli.out)
    : path.join(BENCH_ROOT, `results-${stamp}.csv`)

  // -- Preflight -------------------------------------------------------------
  let mock: Awaited<ReturnType<typeof startMockUpstream>> | undefined
  let upstreamOrigin: string
  if (cli.mock) {
    mock = await startMockUpstream()
    upstreamOrigin = mock.origin
    process.env[PROVIDER_KEY_ENV[config.provider] ?? 'DEEPSEEK_API_KEY'] ??= 'mock-key'
    console.log(`[preflight] mock upstream at ${mock.origin} — no provider calls will be made`)
  } else {
    upstreamOrigin = PROVIDER_ORIGINS[config.provider] ?? ''
    if (!upstreamOrigin) {
      throw new Error(`bench: no upstream origin known for provider "${config.provider}".`)
    }
    const keyEnv = PROVIDER_KEY_ENV[config.provider]
    if (keyEnv && !process.env[keyEnv]) {
      throw new Error(`bench: ${keyEnv} is not set; the ${config.provider} groups cannot run.`)
    }
  }

  let judgeEnabled = config.judge.enabled && !cli.skipJudge
  if (judgeEnabled && cli.mock) {
    // The offline check needs a judge that talks to the mock, not a real vendor.
    Object.assign(config.judge as { provider: string | null; model: string | null }, {
      provider: config.judge.provider ?? 'openai',
      model: config.judge.model ?? 'mock-judge',
    })
    process.env['OPENAI_API_KEY'] ??= 'mock-key'
  }
  if (judgeEnabled && !cli.mock) {
    if (!config.judge.provider || !config.judge.model) {
      console.warn('[preflight] judge.provider / judge.model are unset — continuing with quality_score empty.')
      judgeEnabled = false
    }
    const judgeKeyEnv = config.judge.provider ? PROVIDER_KEY_ENV[config.judge.provider] : undefined
    if (judgeKeyEnv && !process.env[judgeKeyEnv]) {
      throw new Error(`bench: ${judgeKeyEnv} is not set; the judge cannot run. Pass --skip-judge to defer scoring.`)
    }
    if (config.judge.provider === config.provider) {
      console.warn(
        `[preflight] WARNING: the judge provider (${config.judge.provider}) is the same vendor as the `
        + 'models under test. Same-vendor self-preference is a known bias; this must be stated in REPORT.md.',
      )
    }
  }

  const proxy = new RecordingProxy(upstreamOrigin)
  if (cli.verbose) {
    proxy.observe((record) => {
      trace(
        `  http ${record.status}        ${record.model.padEnd(18)}`
        + `${String(record.inputTokens).padStart(6)} in`
        + `${String(record.cachedInputTokens).padStart(6)} cached`
        + `${String(record.outputTokens).padStart(6)} out`
        + `${String(record.latencyMs).padStart(7)} ms`,
      )
    })
  }
  await proxy.start()
  console.log(`[preflight] recording proxy at ${proxy.baseURL} -> ${upstreamOrigin}`)
  if (cli.variant !== 'as-published') {
    console.log(`[preflight] DAG variant "${cli.variant}": ${DAG_VARIANTS[cli.variant]}`)
  }

  const records: RunRecord[] = []
  const outputs = new Map<string, string>()
  let judgeCalls = 0
  let judgeInputTokens = 0
  let judgeOutputTokens = 0
  let judgeFailures = 0

  try {
    for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
      for (const taskId of config.tasks) {
        const task = taskById(taskId)
        // Rotate group order per repetition so no group systematically runs
        // first (and therefore systematically warm or cold).
        const order = rotate(config.groups, repetition - 1)
        const orderLabel = order.join('>')

        for (const group of order) {
          const runId = `${taskId}-${group}-r${repetition}`
          proxy.setLabel(runId)
          const roleModels = group === 'A'
            ? Object.entries(task.roleModels(config)).map(([role, model]) => `${role}=${model}`).join(';')
            : `single-agent=${group === 'B' ? config.models.strong : config.models.cheap}`

          if (cli.verbose) trace(`run_start       ${runId}  (${roleModels})`)
          else process.stdout.write(`[run] ${runId} ... `)
          let outcome: ExecutionOutcome
          try {
            outcome = group === 'A'
              ? await runGroupA(config, task, runId, proxy.baseURL, nonce, cli.variant, cli.verbose)
              : await runSingleAgent(
                config,
                task,
                runId,
                group === 'B' ? config.models.strong : config.models.cheap,
                proxy.baseURL,
                nonce,
                cli.variant,
              )
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.log(`FAILED (${message})`)
            outcome = {
              success: false,
              output: '',
              frameworkInput: 0,
              frameworkOutput: 0,
              wallMs: 0,
              agentCount: group === 'A' ? task.agentCount : 1,
              budgetExceeded: false,
              notes: [`threw: ${message.slice(0, 200)}`],
            }
          }

          const calls = proxy.recordsFor(runId)
          const stats = summarizeCalls(calls, outcome.wallMs)
          let cost: number | null = 0
          for (const [model, usage] of stats.perModel) {
            const modelCost = priceCall(config.pricing, model, {
              input: usage.input,
              cached: usage.cached,
              output: usage.output,
            })
            if (modelCost === null) { cost = null; break }
            cost += modelCost
          }

          const notes = [...outcome.notes]
          if (stats.failedCalls > 0) notes.push(`${stats.failedCalls} non-200 provider call(s)`)
          if (stats.cachedInputTokens > 0) notes.push(`cache hits: ${stats.cachedInputTokens} tok`)
          if (Math.abs(stats.inputTokens - outcome.frameworkInput) > 0
            || Math.abs(stats.outputTokens - outcome.frameworkOutput) > 0) {
            notes.push(
              `http vs framework tokens differ (in ${stats.inputTokens}/${outcome.frameworkInput}, `
              + `out ${stats.outputTokens}/${outcome.frameworkOutput})`,
            )
          }

          records.push({
            run_id: runId,
            date,
            run_stamp: stamp,
            task: taskId,
            task_kind: task.hypothesis,
            group,
            variant: cli.variant,
            repetition,
            group_order: orderLabel,
            role_models: roleModels,
            input_tokens: stats.inputTokens,
            output_tokens: stats.outputTokens,
            cached_tokens: stats.cachedInputTokens,
            total_tokens: stats.inputTokens + stats.outputTokens,
            est_cost_usd: cost === null ? null : Number(cost.toFixed(6)),
            wall_seconds: Number((outcome.wallMs / 1000).toFixed(2)),
            agent_count: outcome.agentCount,
            parallelism: Number(stats.parallelism.toFixed(2)),
            max_concurrent_calls: stats.maxConcurrentCalls,
            llm_calls: stats.llmCalls,
            success: outcome.success,
            quality_score: null,
            quality_by_opponent: '',
            judge_model: '',
            temperature: config.temperature,
            thinking: thinkingLabel(config),
            cache_busting: config.cacheBusting,
            framework_input_tokens: outcome.frameworkInput,
            framework_output_tokens: outcome.frameworkOutput,
            budget_exceeded: outcome.budgetExceeded,
            notes: notes.join(' | '),
          })

          outputs.set(runId, outcome.output)
          writeFileSync(path.join(runsDir, `${runId}.md`), outcome.output)
          const summary = `${outcome.success ? 'ok' : 'FAILED'} — ${stats.inputTokens + stats.outputTokens} tok `
            + `(${stats.inputTokens} in / ${stats.cachedInputTokens} cached / ${stats.outputTokens} out), `
            + `${(outcome.wallMs / 1000).toFixed(2)}s, ${stats.llmCalls} call(s), `
            + `peak concurrency ${stats.maxConcurrentCalls}, parallelism ${stats.parallelism.toFixed(2)}`
            + `${cost === null ? '' : `, $${cost.toFixed(5)}`}`
          if (cli.verbose) trace(`run_done        ${summary}`)
          else console.log(summary)
        }
      }
    }

    // Persist run data before judging: a judge failure must never discard runs
    // that have already been paid for.
    writeFileSync(csvPath, toCSV(records))

    // -- Judging -------------------------------------------------------------
    if (judgeEnabled) {
      try {
      const judge = new Judge(
        config,
        mock ? { baseURL: `${mock.origin}/v1`, apiKey: 'mock-key' } : {},
      )
      for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
        for (const taskId of config.tasks) {
          const task = taskById(taskId)
          const input = readFixture(task.fixture)
          const challengers = config.groups.filter((group) => group !== 'A')
          if (!config.groups.includes('A') || challengers.length === 0) continue

          for (const challenger of challengers) {
            const aId = `${taskId}-A-r${repetition}`
            const bId = `${taskId}-${challenger}-r${repetition}`
            const aOut = outputs.get(aId)
            const bOut = outputs.get(bId)
            if (!aOut?.trim() || !bOut?.trim()) {
              console.log(`[judge] skip ${aId} vs ${bId}: an output is empty`)
              continue
            }
            process.stdout.write(`[judge] ${aId} vs ${bId} ... `)
            // One bad pair must not cost the pairs after it. The earlier design
            // aborted the whole pass on the first transient provider error and
            // still exited 0, which read as a finished run.
            let pair
            try {
              pair = await judge.scorePair(task, input, [
                { group: 'A', output: aOut },
                { group: challenger, output: bOut },
              ])
            } catch (error) {
              judgeFailures += 1
              console.log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
              continue
            }
            judgeCalls += pair.calls
            judgeInputTokens += pair.judgeTokens.input
            judgeOutputTokens += pair.judgeTokens.output

            for (const [group, score] of Object.entries(pair.scores)) {
              const record = records.find((r) => r.run_id === `${taskId}-${group}-r${repetition}`)
              if (!record) continue
              const opponent = group === 'A' ? challenger : 'A'
              // A is judged once per challenger, so this is its second visit for
              // every challenger after the first. Fold, never assign: the report
              // needs A's score from *this* pair to compare it against *this*
              // opponent.
              const folded = foldPairScore(record.quality_by_opponent, opponent, score)
              record.quality_by_opponent = folded.byOpponent
              record.quality_score = Number(folded.mean.toFixed(3))
              record.judge_model = judge.model
              record.notes = [record.notes, `judge ${pair.preferred[group]} vs ${opponent}`]
                .filter(Boolean)
                .join(' | ')
            }
            writeFileSync(
              path.join(runsDir, `judge-${taskId}-A-vs-${challenger}-r${repetition}.json`),
              JSON.stringify(pair, null, 2),
            )
            console.log(
              Object.entries(pair.scores).map(([group, score]) => `${group}=${score.toFixed(2)}`).join(' '),
            )
          }
        }
      }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        judgeFailures += 1
        console.error(`[judge] ABORTED: ${message}`)
        console.error('[judge] run data is already written; finish scoring with bench/src/judge-missing.mts.')
      }
    } else {
      console.log('[judge] skipped — quality_score column stays empty')
    }
  } finally {
    await proxy.stop()
    await mock?.stop()
  }

  // -- Artefacts -------------------------------------------------------------
  writeFileSync(csvPath, toCSV(records))
  writeFileSync(path.join(runsDir, 'calls.json'), JSON.stringify(proxy.allRecords(), null, 2))
  writeFileSync(
    path.join(runsDir, 'manifest.json'),
    JSON.stringify(
      {
        date,
        startedAtUtc,
        finishedAtUtc: new Date().toISOString(),
        nonce,
        gitSha: gitSha(),
        node: process.version,
        mock: cli.mock,
        variant: cli.variant,
        config,
        judge: { calls: judgeCalls, inputTokens: judgeInputTokens, outputTokens: judgeOutputTokens },
        providerCalls: proxy.allRecords().length,
      },
      null,
      2,
    ),
  )

  // -- Summary ---------------------------------------------------------------
  console.log(`\nCSV:  ${csvPath}`)
  console.log(`Raw:  ${runsDir}`)
  console.log('\n--- per task/group medians ---')
  for (const taskId of config.tasks) {
    for (const group of config.groups) {
      const subset = records.filter((r) => r.task === taskId && r.group === group)
      if (subset.length === 0) continue
      const tokens = dispersion(subset.map((r) => r.total_tokens))
      const wall = dispersion(subset.map((r) => r.wall_seconds))
      const quality = dispersion(subset.map((r) => r.quality_score).filter((v): v is number => v !== null))
      const costs = subset.map((r) => r.est_cost_usd).filter((v): v is number => v !== null)
      const cost = costs.length === subset.length ? dispersion(costs) : null
      console.log(
        `${taskId} ${group}: n=${subset.length} tokens=${tokens?.median ?? '-'} `
        + `[${tokens?.min ?? '-'}, ${tokens?.max ?? '-'}] wall=${wall?.median ?? '-'}s `
        + `quality=${quality ? quality.median.toFixed(2) : 'n/a'} `
        + `cost=${cost ? `$${cost.median.toFixed(4)}` : 'not priced'}`,
      )
    }
  }

  const totalCosts = records.map((r) => r.est_cost_usd)
  if (totalCosts.every((value): value is number => value !== null)) {
    const total = totalCosts.reduce((sum, value) => sum + value, 0)
    console.log(`\nMeasured spend for this invocation (target models only): $${total.toFixed(4)}`)
    console.log(`Per repetition: $${(total / config.repetitions).toFixed(4)}`)
  } else {
    console.log('\nCost not computed: bench/config.json has null prices for at least one model.')
  }
  if (judgeCalls > 0) {
    console.log(
      `Judge: ${judgeCalls} call(s), ${judgeInputTokens} input + ${judgeOutputTokens} output tokens `
      + '(priced separately by the judge vendor).',
    )
  }
  if (judgeFailures > 0) {
    console.error(
      `\n${judgeFailures} judge pair(s) did not score. The runs themselves are complete and saved; `
      + `finish scoring with:\n  npx tsx bench/src/judge-missing.mts --date ${stamp}`,
    )
    // A partially judged invocation is not a successful one.
    process.exitCode = 1
  }
}

await main()
