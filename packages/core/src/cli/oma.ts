#!/usr/bin/env node
/**
 * Thin shell/CI wrapper over OpenMultiAgent — no interactive session, approvals,
 * or persistence. The filesystem-tool sandbox root is configurable through the
 * orchestrator/agent JSON (`defaultCwd` / `cwd`).
 *
 * Exit codes:
 *   0 — finished; team run succeeded
 *   1 — finished; run, eval targets, or an eval gate reported failure
 *   2 — invalid usage, I/O, or JSON validation
 *   3 — unexpected runtime error (including LLM errors)
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { OpenMultiAgent } from '../orchestrator/orchestrator.js'
import { renderRunViewer } from '../dashboard/render-run-viewer.js'
import {
  loadEvalReport,
  loadEvalSet,
  loadGatePolicy,
  writeEvalReport,
  type EvalReportFormat,
} from '../eval/file.js'
import { evaluateGate, type GateVerdict } from '../eval/gate.js'
import { runEvalSet } from '../eval/runner.js'
import type { Scorer } from '../eval/scorer.js'
import type { EvalTarget } from '../eval/target.js'
import { materializeRun } from '../observability/materialize.js'
import type { TraceRecord } from '../observability/records.js'
import type { StoredRun } from '../observability/store.js'
import { FileTraceStore, FileTraceStoreError } from '../observability/file-store.js'
import { emptyTraceSinkStats, type FlushResult, type TraceSink } from '../observability/sink.js'
import type { SupportedProvider } from '../llm/adapter.js'
import { validateTaskMetadata } from '../task/metadata.js'
import type {
  AgentRunResult,
  CoordinatorConfig,
  OrchestratorConfig,
  TaskMetadata,
  TeamConfig,
  TeamRunResult,
} from '../types.js'

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const EXIT = {
  SUCCESS: 0,
  RUN_FAILED: 1,
  USAGE: 2,
  INTERNAL: 3,
} as const

class OmaValidationError extends Error {
  override readonly name = 'OmaValidationError'
  constructor(message: string) {
    super(message)
  }
}

export type DashboardCliErrorCode =
  | 'trace_store_not_found'
  | 'run_not_found'
  | 'dashboard_output_exists'
  | 'trace_store_close_failed'

export class DashboardCliError extends Error {
  readonly name = 'DashboardCliError'

  constructor(
    readonly code: DashboardCliErrorCode,
    message: string,
    readonly exit: number = EXIT.USAGE,
  ) {
    super(message)
  }
}

export class DashboardTraceCaptureSink implements TraceSink {
  private readonly captured: TraceRecord[] = []
  private closed = false

  emit(record: TraceRecord): void {
    if (!this.closed) this.captured.push(record)
  }

  records(): readonly TraceRecord[] {
    return [...this.captured]
  }

  forceFlush(): Promise<FlushResult> {
    return Promise.resolve(this.flushResult())
  }

  shutdown(): Promise<FlushResult> {
    this.closed = true
    return Promise.resolve(this.flushResult())
  }

  getStats() {
    return { ...emptyTraceSinkStats(), accepted: this.captured.length, exported: this.captured.length }
  }

  private flushResult(): FlushResult {
    return {
      status: 'ok',
      accepted: this.captured.length,
      exported: this.captured.length,
      dropped: 0,
      failed: 0,
    }
  }
}

export function renderCapturedRunDashboard(
  result: TeamRunResult,
  records: readonly TraceRecord[],
): { readonly html: string; readonly captureWarning?: string } {
  let run: StoredRun | null = null
  let captureWarning: string | undefined
  try {
    if (!result.identity?.runId) {
      captureWarning = 'DASHBOARD_TRACE_CAPTURE_FAILED: run identity was not recorded; using result-only data.'
    } else {
      run = materializeRun(records.filter((record) => record.runId === result.identity!.runId), true)
      if (!run) {
        captureWarning = 'DASHBOARD_TRACE_CAPTURE_FAILED: no trace records were captured; using result-only data.'
      }
    }
  } catch (error) {
    captureWarning = `DASHBOARD_TRACE_CAPTURE_FAILED: ${error instanceof Error ? error.message : String(error)}; using result-only data.`
  }
  return {
    html: renderRunViewer({ result, ...(run ? { run } : {}) }),
    ...(captureWarning ? { captureWarning } : {}),
  }
}

export async function exportCurrentRunDashboard(
  result: TeamRunResult,
  records: readonly TraceRecord[],
  dependencies: {
    readonly render?: typeof renderCapturedRunDashboard
    readonly write?: typeof writeDashboardFile
  } = {},
): Promise<{ readonly dashboard?: string; readonly warnings: readonly string[] }> {
  const warnings: string[] = []
  let html: string
  try {
    const rendered = (dependencies.render ?? renderCapturedRunDashboard)(result, records)
    html = rendered.html
    if (rendered.captureWarning) warnings.push(rendered.captureWarning)
  } catch (error) {
    warnings.push(`DASHBOARD_RENDER_FAILED: ${error instanceof Error ? error.message : String(error)}`)
    return { warnings }
  }

  try {
    const dashboard = await (dependencies.write ?? writeDashboardFile)(html)
    return { dashboard, warnings }
  } catch (error) {
    warnings.push(`DASHBOARD_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`)
    return { warnings }
  }
}

// ---------------------------------------------------------------------------
// Provider helper (static reference data)
// ---------------------------------------------------------------------------

export const PROVIDER_REFERENCE: ReadonlyArray<{
  id: SupportedProvider
  apiKeyEnv: readonly string[]
  baseUrlSupported: boolean
  notes?: string
}> = [
  { id: 'anthropic', apiKeyEnv: ['ANTHROPIC_API_KEY'], baseUrlSupported: true },
  { id: 'azure-openai', apiKeyEnv: ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT'], baseUrlSupported: true, notes: 'Azure OpenAI requires endpoint URL (e.g., https://my-resource.openai.azure.com) and API key. Optional: AZURE_OPENAI_API_VERSION (defaults to 2024-10-21). Prefer setting deployment on agent.model; AZURE_OPENAI_DEPLOYMENT is a fallback when model is blank.' },
  { id: 'openai', apiKeyEnv: ['OPENAI_API_KEY'], baseUrlSupported: true, notes: 'Set baseURL for Ollama / vLLM / LM Studio; apiKey may be a placeholder.' },
  { id: 'gemini', apiKeyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], baseUrlSupported: false },
  { id: 'grok', apiKeyEnv: ['XAI_API_KEY'], baseUrlSupported: true },
  { id: 'minimax', apiKeyEnv: ['MINIMAX_API_KEY'], baseUrlSupported: true, notes: 'Global endpoint: https://api.minimax.io/v1 (default). China endpoint: https://api.minimaxi.com/v1. Set MINIMAX_BASE_URL to choose, or pass baseURL in agent config.' },
  { id: 'mimo', apiKeyEnv: ['MIMO_API_KEY', 'MIMO_BASE_URL'], baseUrlSupported: true, notes: 'OpenAI-compatible endpoint at https://api.xiaomimimo.com/v1 by default. Token Plan keys (tp-...) require the cluster base URL from your subscription page; set MIMO_BASE_URL or pass baseURL in agent config.' },
  { id: 'deepseek', apiKeyEnv: ['DEEPSEEK_API_KEY'], baseUrlSupported: true, notes: 'OpenAI-compatible endpoint at https://api.deepseek.com/v1. Models: deepseek-v4-flash (DeepSeek-V4-Flash-0731, default), deepseek-v4-pro (DeepSeek-V4-Pro-0813); both support 1M context and enable thinking by default. Legacy deepseek-chat/deepseek-reasoner were retired on 2026-07-24.' },
  { id: 'doubao', apiKeyEnv: ['ARK_API_KEY'], baseUrlSupported: true, notes: 'OpenAI-compatible Volcengine Ark endpoint at https://ark.cn-beijing.volces.com/api/v3. Set provider to doubao and choose a model available to your Ark key.' },
  { id: 'hunyuan', apiKeyEnv: ['HUNYUAN_API_KEY', 'HUNYUAN_BASE_URL'], baseUrlSupported: true, notes: 'OpenAI-compatible. Defaults to the current Tencent MaaS / TokenHub endpoint https://tokenhub.tencentmaas.com/v1 (sk-... keys, models like hy3-preview). The legacy Tencent Cloud endpoint https://api.hunyuan.cloud.tencent.com/v1 (models like hunyuan-turbos-latest) is being retired by Tencent (shutdown 2026-09-30); target it via HUNYUAN_BASE_URL until then. Tool calling verified on hy3-preview / hunyuan-turbos / hunyuan-functioncall.' },
  { id: 'qiniu', apiKeyEnv: ['QINIU_API_KEY'], baseUrlSupported: true, notes: 'OpenAI-compatible endpoint at https://api.qnaigc.com/v1. Set provider to qiniu and choose a model available to your key.' },
  {
    id: 'copilot',
    apiKeyEnv: ['GITHUB_COPILOT_TOKEN', 'GITHUB_TOKEN'],
    baseUrlSupported: false,
    notes: 'If no token env is set, Copilot adapter may start an interactive OAuth device flow (avoid in CI).',
  },
  {
    id: 'bedrock',
    apiKeyEnv: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    baseUrlSupported: false,
    notes: 'No API key. Credentials via AWS SDK default provider chain (env vars, shared config, IAM role). Set AWS_REGION or pass region as the fourth arg to createAdapter; defaults to us-east-1. Requires npm install @aws-sdk/client-bedrock-runtime.',
  },
]

// ---------------------------------------------------------------------------
// argv / JSON helpers
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): {
  _: string[]
  flags: Set<string>
  kv: Map<string, string>
} {
  const _ = argv.slice(2)
  const flags = new Set<string>()
  const kv = new Map<string, string>()
  let i = 0
  while (i < _.length) {
    const a = _[i]!
    if (a === '--') {
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        kv.set(a.slice(2, eq), a.slice(eq + 1))
        i++
        continue
      }
      const key = a.slice(2)
      const next = _[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        kv.set(key, next)
        i += 2
      } else {
        flags.add(key)
        i++
      }
      continue
    }
    i++
  }
  return { _, flags, kv }
}

function getOpt(
  kv: ReadonlyMap<string, string>,
  flags: ReadonlySet<string>,
  key: string,
): string | undefined {
  if (flags.has(key)) return ''
  return kv.get(key)
}

function getRepeatedOpts(args: readonly string[], key: string): readonly string[] {
  const option = `--${key}`
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!
    if (token === '--') break
    if (token === option) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new OmaValidationError(`${option} requires a value`)
      }
      values.push(value)
      index += 1
    } else if (token.startsWith(`${option}=`)) {
      values.push(token.slice(option.length + 1))
    }
  }
  return values
}

function positiveIntegerOption(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new OmaValidationError(`${option} must be a positive integer`)
  }
  return Number(value)
}

function evalMetadata(values: readonly string[]): Readonly<Record<string, string>> {
  const metadata: Record<string, string> = {}
  for (const entry of values) {
    const separator = entry.indexOf('=')
    if (separator < 1) throw new OmaValidationError('--meta must use key=value')
    metadata[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return Object.freeze(metadata)
}

function evalReportFormats(values: readonly string[]): readonly EvalReportFormat[] {
  const requested = values.length === 0 ? ['json'] : values
  const formats: EvalReportFormat[] = []
  for (const value of requested) {
    if (value !== 'json' && value !== 'markdown' && value !== 'junit') {
      throw new OmaValidationError('--report must be one of json, markdown, or junit')
    }
    if (!formats.includes(value)) formats.push(value)
  }
  return formats
}

function asScorers(value: unknown, label: string): readonly Scorer[] {
  if (!Array.isArray(value)) throw new OmaValidationError(`${label} must default-export a Scorer[]`)
  for (const scorer of value) {
    if (!isObject(scorer) || typeof scorer['name'] !== 'string' || scorer['name'].trim().length === 0
      || typeof scorer['score'] !== 'function') {
      throw new OmaValidationError(`${label} contains an invalid Scorer`)
    }
  }
  return value as unknown as readonly Scorer[]
}

async function importDefault(modulePath: string, label: string): Promise<unknown> {
  const absolutePath = resolve(modulePath)
  try {
    const imported = await import(pathToFileURL(absolutePath).href) as { readonly default?: unknown }
    if (!('default' in imported)) {
      throw new Error('module has no default export')
    }
    return imported.default
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new OmaValidationError(`Unable to load ${label} module ${absolutePath}: ${message}`)
  }
}

async function loadEvalTarget(modulePath: string): Promise<{
  readonly target: EvalTarget
  readonly scorers: readonly Scorer[]
}> {
  const exported = await importDefault(modulePath, 'target')
  if (typeof exported === 'function') {
    return { target: exported as EvalTarget, scorers: [] }
  }
  if (!isObject(exported) || typeof exported['target'] !== 'function') {
    throw new OmaValidationError(
      'Target module must default-export an EvalTarget function or { target, scorers? }',
    )
  }
  const scorers = exported['scorers'] === undefined
    ? []
    : asScorers(exported['scorers'], 'target module scorers')
  return { target: exported['target'] as EvalTarget, scorers }
}

function mergeEvalScorers(
  embedded: readonly Scorer[],
  explicit: readonly Scorer[],
): readonly Scorer[] {
  const merged: Scorer[] = []
  const names = new Set<string>()
  for (const scorer of [...embedded, ...explicit]) {
    if (names.has(scorer.name)) {
      throw new OmaValidationError(`Duplicate scorer name: ${scorer.name}`)
    }
    names.add(scorer.name)
    merged.push(scorer)
  }
  if (merged.length === 0) throw new OmaValidationError('At least one scorer is required')
  return merged
}

const EVAL_REPORT_FILENAMES: Readonly<Record<EvalReportFormat, string>> = {
  json: 'report.json',
  markdown: 'report.md',
  junit: 'report.junit.xml',
}

export async function runEvalCli(argv: {
  readonly _: readonly string[]
  readonly flags: ReadonlySet<string>
  readonly kv: ReadonlyMap<string, string>
}): Promise<{ readonly exit: number; readonly summary: Readonly<Record<string, unknown>> }> {
  const setPath = getOpt(argv.kv, argv.flags, 'set')
  const targetPath = getOpt(argv.kv, argv.flags, 'target')
  const scorersPath = getOpt(argv.kv, argv.flags, 'scorers')
  const tags = getOpt(argv.kv, argv.flags, 'tags')
  const out = getOpt(argv.kv, argv.flags, 'out')
  const gatePath = getOpt(argv.kv, argv.flags, 'gate')
  const baselinePath = getOpt(argv.kv, argv.flags, 'baseline')
  if (!setPath || !targetPath) {
    throw new OmaValidationError('oma eval run requires --set and --target')
  }
  if (scorersPath === '') throw new OmaValidationError('--scorers requires a non-empty path')
  if (tags === '') throw new OmaValidationError('--tags requires a comma-separated value')
  if (out === '') throw new OmaValidationError('--out requires a non-empty path')
  if (gatePath === '') throw new OmaValidationError('--gate requires a non-empty path')
  if (baselinePath === '') throw new OmaValidationError('--baseline requires a non-empty path')
  if (baselinePath !== undefined && gatePath === undefined) {
    throw new OmaValidationError('--baseline requires --gate')
  }

  let set
  try {
    set = await loadEvalSet(setPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EACCES') throw error
    throw new OmaValidationError(error instanceof Error ? error.message : String(error))
  }
  const gatePolicy = gatePath === undefined
    ? undefined
    : await loadEvalCliFile(gatePath, loadGatePolicy)
  const baseline = baselinePath === undefined
    ? undefined
    : await loadEvalCliFile(baselinePath, loadEvalReport)
  const targetModule = await loadEvalTarget(targetPath)
  const explicitScorers = scorersPath === undefined
    ? []
    : asScorers(await importDefault(scorersPath, 'scorers'), 'Scorers module')
  const scorers = mergeEvalScorers(targetModule.scorers, explicitScorers)
  const repeats = positiveIntegerOption(
    getOpt(argv.kv, argv.flags, 'repeats'),
    '--repeats',
  )
  const concurrency = positiveIntegerOption(
    getOpt(argv.kv, argv.flags, 'concurrency'),
    '--concurrency',
  )
  const filterTags = tags === undefined
    ? undefined
    : tags.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0)
  if (tags !== undefined && filterTags?.length === 0) {
    throw new OmaValidationError('--tags requires at least one non-empty tag')
  }
  const metadata = evalMetadata(getRepeatedOpts(argv._, 'meta'))
  const formats = evalReportFormats(getRepeatedOpts(argv._, 'report'))
  const report = await runEvalSet(set, targetModule.target, {
    scorers,
    ...(repeats !== undefined ? { repeats } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(filterTags !== undefined ? { filterTags } : {}),
    metadata,
  })

  const outputDirectory = resolve(out ?? 'eval-results', report.evalRunId)
  const reports = Object.fromEntries(formats.map((format) => [
    format,
    join(outputDirectory, EVAL_REPORT_FILENAMES[format]),
  ])) as Partial<Record<EvalReportFormat, string>>
  await Promise.all(formats.map((format) =>
    writeEvalReport(report, { format, path: reports[format]! })))
  const verdict = gatePolicy === undefined
    ? undefined
    : evaluateGate(report, gatePolicy, baseline)
  const verdictPath = verdict === undefined ? undefined : join(outputDirectory, 'verdict.json')
  if (verdict !== undefined) {
    await writeFile(verdictPath!, JSON.stringify(verdict, null, 2), 'utf8')
  }
  const sampleCount = report.caseCount * report.repeats
  return {
    exit: verdict?.pass === false
      || (sampleCount > 0 && report.totals.targetErrors === sampleCount)
      ? EXIT.RUN_FAILED
      : EXIT.SUCCESS,
    summary: {
      command: 'eval',
      subcommand: 'run',
      evalRunId: report.evalRunId,
      caseCount: report.caseCount,
      repeats: report.repeats,
      targetErrors: report.totals.targetErrors,
      scorers: report.aggregates.map((aggregate) => ({
        name: aggregate.scorer.name,
        ...(aggregate.scorer.version !== undefined ? { version: aggregate.scorer.version } : {}),
        avg: aggregate.avg,
        ...(aggregate.passRate !== undefined ? { passRate: aggregate.passRate } : {}),
        errorCount: aggregate.errorCount,
      })),
      reports,
      ...(verdict !== undefined ? { verdict, verdictPath } : {}),
    },
  }
}

async function loadEvalCliFile<T>(
  filePath: string,
  loader: (path: string) => Promise<T>,
): Promise<T> {
  try {
    return await loader(filePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EACCES') throw error
    throw new OmaValidationError(error instanceof Error ? error.message : String(error))
  }
}

export async function runEvalGateCli(argv: {
  readonly _: readonly string[]
  readonly flags: ReadonlySet<string>
  readonly kv: ReadonlyMap<string, string>
}): Promise<{ readonly exit: number; readonly verdict: GateVerdict }> {
  const reportPath = getOpt(argv.kv, argv.flags, 'report')
  const gatePath = getOpt(argv.kv, argv.flags, 'gate')
  const baselinePath = getOpt(argv.kv, argv.flags, 'baseline')
  if (!reportPath || !gatePath) {
    throw new OmaValidationError('oma eval gate requires --report and --gate')
  }
  if (baselinePath === '') throw new OmaValidationError('--baseline requires a non-empty path')

  const report = await loadEvalCliFile(reportPath, loadEvalReport)
  const gatePolicy = await loadEvalCliFile(gatePath, loadGatePolicy)
  const baseline = baselinePath === undefined
    ? undefined
    : await loadEvalCliFile(baselinePath, loadEvalReport)
  const verdict = evaluateGate(report, gatePolicy, baseline)
  return {
    exit: verdict.pass ? EXIT.SUCCESS : EXIT.RUN_FAILED,
    verdict,
  }
}

function readJson(path: string): unknown {
  const abs = resolve(path)
  const raw = readFileSync(abs, 'utf8')
  try {
    return JSON.parse(raw) as unknown
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${abs}: ${e.message}`)
    }
    throw e
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asTeamConfig(v: unknown, label: string): TeamConfig {
  if (!isObject(v)) throw new OmaValidationError(`${label}: expected a JSON object`)
  const name = v['name']
  const agents = v['agents']
  if (typeof name !== 'string' || !name) throw new OmaValidationError(`${label}.name: non-empty string required`)
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new OmaValidationError(`${label}.agents: non-empty array required`)
  }
  for (const a of agents) {
    if (!isObject(a)) throw new OmaValidationError(`${label}.agents[]: each agent must be an object`)
    if (typeof a['name'] !== 'string' || !a['name']) throw new OmaValidationError(`agent.name required`)
    if (typeof a['model'] !== 'string' || !a['model']) {
      throw new OmaValidationError(`agent.model required for "${String(a['name'])}"`)
    }
  }
  // `sharedMemoryStore` is a runtime MemoryStore instance and cannot survive
  // JSON round-tripping. Reject it here with a clear pointer to the SDK path,
  // otherwise the plain object would reach `new SharedMemory(...)` and crash on
  // the first read/write.
  if ('sharedMemoryStore' in v) {
    throw new OmaValidationError(
      `${label}.sharedMemoryStore: SDK-only; cannot be set from JSON config. ` +
        'Use `sharedMemory: true` for the default in-memory store, or wire a ' +
        'custom MemoryStore in TypeScript via `orchestrator.createTeam()`.',
    )
  }
  return v as unknown as TeamConfig
}

function asOrchestratorPartial(v: unknown, label: string): OrchestratorConfig {
  if (!isObject(v)) throw new OmaValidationError(`${label}: expected a JSON object`)
  return v as OrchestratorConfig
}

function asCoordinatorPartial(v: unknown, label: string): CoordinatorConfig {
  if (!isObject(v)) throw new OmaValidationError(`${label}: expected a JSON object`)
  return v as CoordinatorConfig
}

function asTaskSpecs(v: unknown, label: string): ReadonlyArray<{
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
  memoryScope?: 'dependencies' | 'all'
  dependencyPayload?: 'output' | 'structured' | 'both'
  role?: string
  priority?: 'low' | 'normal' | 'high' | 'critical'
  metadata?: TaskMetadata
  maxRetries?: number
  retryDelayMs?: number
  retryBackoff?: number
}> {
  if (!Array.isArray(v)) throw new OmaValidationError(`${label}: expected a JSON array`)
  const out: Array<{
    title: string
    description: string
    assignee?: string
    dependsOn?: string[]
    memoryScope?: 'dependencies' | 'all'
    dependencyPayload?: 'output' | 'structured' | 'both'
    role?: string
    priority?: 'low' | 'normal' | 'high' | 'critical'
    metadata?: TaskMetadata
    maxRetries?: number
    retryDelayMs?: number
    retryBackoff?: number
  }> = []
  let i = 0
  for (const item of v) {
    if (!isObject(item)) throw new OmaValidationError(`${label}[${i}]: object expected`)
    if (typeof item['title'] !== 'string' || typeof item['description'] !== 'string') {
      throw new OmaValidationError(`${label}[${i}]: title and description strings required`)
    }
    const row: (typeof out)[0] = {
      title: item['title'],
      description: item['description'],
    }
    if (typeof item['assignee'] === 'string') row.assignee = item['assignee']
    if (Array.isArray(item['dependsOn'])) {
      row.dependsOn = item['dependsOn'].filter((x): x is string => typeof x === 'string')
    }
    if (item['memoryScope'] === 'all' || item['memoryScope'] === 'dependencies') {
      row.memoryScope = item['memoryScope']
    }
    if (
      item['dependencyPayload'] === 'output'
      || item['dependencyPayload'] === 'structured'
      || item['dependencyPayload'] === 'both'
    ) {
      row.dependencyPayload = item['dependencyPayload']
    }
    if (typeof item['role'] === 'string') row.role = item['role']
    if (
      item['priority'] === 'low'
      || item['priority'] === 'normal'
      || item['priority'] === 'high'
      || item['priority'] === 'critical'
    ) {
      row.priority = item['priority']
    }
    if (item['metadata'] !== undefined) {
      if (!isObject(item['metadata'])) {
        throw new OmaValidationError(`${label}[${i}].metadata: object expected`)
      }
      try {
        row.metadata = validateTaskMetadata(item['metadata'] as TaskMetadata)!
      } catch (error) {
        throw new OmaValidationError(
          `${label}[${i}].metadata: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (typeof item['maxRetries'] === 'number') row.maxRetries = item['maxRetries']
    if (typeof item['retryDelayMs'] === 'number') row.retryDelayMs = item['retryDelayMs']
    if (typeof item['retryBackoff'] === 'number') row.retryBackoff = item['retryBackoff']
    out.push(row)
    i++
  }
  return out
}

export interface CliJsonOptions {
  readonly pretty: boolean
  readonly includeMessages: boolean
}

export function serializeAgentResult(r: AgentRunResult, includeMessages: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    success: r.success,
    output: r.output,
    tokenUsage: r.tokenUsage,
    toolCalls: r.toolCalls,
    structured: r.structured,
    loopDetected: r.loopDetected,
    budgetExceeded: r.budgetExceeded,
  }
  if (includeMessages) base['messages'] = r.messages
  return base
}

export function serializeTeamRunResult(result: TeamRunResult, opts: CliJsonOptions): Record<string, unknown> {
  const agentResults: Record<string, unknown> = {}
  for (const [k, v] of result.agentResults) {
    agentResults[k] = serializeAgentResult(v, opts.includeMessages)
  }
  const taskResults: Record<string, unknown> | undefined = result.taskResults === undefined
    ? undefined
    : Object.fromEntries(
        [...result.taskResults].map(([k, v]) => [
          k,
          serializeAgentResult(v, opts.includeMessages),
        ]),
      )
  return {
    success: result.success,
    goal: result.goal,
    tasks: result.tasks,
    routingDecision: result.routingDecision,
    totalTokenUsage: result.totalTokenUsage,
    agentResults,
    ...(taskResults !== undefined ? { taskResults } : {}),
  }
}

function printJson(data: unknown, pretty: boolean): void {
  const s = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)
  process.stdout.write(`${s}\n`)
}

function help(): string {
  return [
    'open-multi-agent CLI (oma)',
    '',
    'Usage:',
    '  oma run --goal <text> --team <team.json> [--orchestrator <orch.json>] [--coordinator <coord.json>]',
    '  oma task --file <tasks.json> [--team <team.json>]',
    '  oma dashboard --trace-store <traces.ndjson> --run-id <id> [--output <run.html>]',
    '  oma eval run --set <evalset.json> --target <target.mjs> [--scorers <scorers.mjs>]',
    '               [--repeats <n>] [--concurrency <n>] [--tags <a,b>]',
    '               [--report <json|markdown|junit>]... [--out <dir>] [--meta key=value]...',
    '               [--gate <gate.json>] [--baseline <report.json>]',
    '  oma eval gate --report <report.json> --gate <gate.json> [--baseline <report.json>]',
    '  oma provider [list | template <provider>]',
    '',
    'Flags:',
    '  --pretty              Pretty-print JSON to stdout',
    '  --include-messages    Include full LLM message arrays in run output (large)',
    '  --dashboard           Write a current-run HTML Viewer to oma-dashboards/',
    '  --trace-store <path>  Existing FileTraceStore used by `oma dashboard`',
    '  --run-id <id>         Logical run to export from FileTraceStore',
    '  --output <path>       Explicit HTML destination (must not already exist)',
    '',
    'team.json may be a TeamConfig object, or { "team": TeamConfig, "orchestrator": { ... } }.',
    'tasks.json: { "team": TeamConfig, "tasks": [ ... ], "orchestrator"?: { ... } }.',
    '  Optional --team overrides the embedded team object.',
    '',
    'Exit codes: 0 success, 1 run/eval gate failed, 2 usage/validation, 3 internal',
  ].join('\n')
}

const DEFAULT_MODEL_HINT: Record<SupportedProvider, string> = {
  anthropic: 'claude-opus-4-6',
  'azure-openai': 'gpt-4',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  grok: 'grok-2-latest',
  copilot: 'gpt-4o',
  minimax: 'MiniMax-M3',
  mimo: 'mimo-v2.5-pro',
  deepseek: 'deepseek-v4-flash',
  doubao: 'doubao-seed-1-8-251228',
  hunyuan: 'hy3-preview',
  qiniu: 'deepseek-v3',
  bedrock: 'anthropic.claude-3-5-haiku-20241022-v1:0',
}

async function cmdProvider(sub: string | undefined, arg: string | undefined, pretty: boolean): Promise<number> {
  if (sub === undefined || sub === 'list') {
    printJson({ providers: PROVIDER_REFERENCE }, pretty)
    return EXIT.SUCCESS
  }
  if (sub === 'template') {
    const id = arg as SupportedProvider | undefined
    const row = PROVIDER_REFERENCE.find((p) => p.id === id)
    if (!id || !row) {
      printJson(
        {
          error: {
            kind: 'usage',
            message: `usage: oma provider template <${PROVIDER_REFERENCE.map((p) => p.id).join('|')}>`,
          },
        },
        pretty,
      )
      return EXIT.USAGE
    }
    printJson(
      {
        orchestrator: {
          defaultProvider: id,
          defaultModel: DEFAULT_MODEL_HINT[id],
        },
        agent: {
          name: 'worker',
          model: DEFAULT_MODEL_HINT[id],
          provider: id,
          systemPrompt: 'You are a helpful assistant.',
        },
        env: Object.fromEntries(row.apiKeyEnv.map((k) => [k, `<set ${k} in environment>`])),
        notes: row.notes,
      },
      pretty,
    )
    return EXIT.SUCCESS
  }
  printJson({ error: { kind: 'usage', message: `unknown provider subcommand: ${sub}` } }, pretty)
  return EXIT.USAGE
}

function mergeOrchestrator(base: OrchestratorConfig, ...partials: OrchestratorConfig[]): OrchestratorConfig {
  let o: OrchestratorConfig = { ...base }
  for (const p of partials) {
    o = { ...o, ...p }
  }
  return o
}

export async function writeDashboardFile(
  html: string,
  options: { readonly output?: string; readonly prefix?: string; readonly directory?: string } = {},
): Promise<string> {
  const explicit = options.output !== undefined
  const directory = explicit
    ? dirname(resolve(options.output!))
    : resolve(options.directory ?? join(process.cwd(), 'oma-dashboards'))
  await mkdir(directory, { recursive: true })
  if (explicit) {
    const filePath = resolve(options.output!)
    try {
      await writeFile(filePath, html, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      throw new DashboardCliError(
        'dashboard_output_exists',
        `dashboard_output_exists: destination already exists: ${filePath}`,
      )
    }
    return filePath
  }

  const stamp = new Date().toISOString().replaceAll(':', '-').replace('.', '-')
  const baseName = `${options.prefix ?? 'runTeam'}-${stamp}`
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const filePath = join(directory, `${baseName}${suffix ? `-${suffix}` : ''}.html`)
    try {
      await writeFile(filePath, html, { encoding: 'utf8', flag: 'wx' })
      return filePath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Unable to allocate a collision-free dashboard output path after 100 attempts.')
}

function withDashboardCapture(
  config: OrchestratorConfig,
  capture: DashboardTraceCaptureSink,
): OrchestratorConfig {
  return {
    ...config,
    observability: {
      ...config.observability,
      sinks: [...(config.observability?.sinks ?? []), capture],
    },
  }
}

async function existingFile(path: string): Promise<void> {
  try {
    await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DashboardCliError(
        'trace_store_not_found',
        `trace_store_not_found: FileTraceStore does not exist: ${path}`,
      )
    }
    throw error
  }
}

export async function exportStoredRunDashboard(options: {
  readonly traceStore: string
  readonly runId: string
  readonly output?: string
}, dependencies: {
  readonly ensureExisting?: (path: string) => Promise<void>
  readonly openStore?: (path: string) => Promise<Pick<FileTraceStore, 'getRun' | 'close'>>
  readonly render?: (run: StoredRun) => string
  readonly write?: (
    html: string,
    options: { readonly output?: string; readonly prefix?: string },
  ) => Promise<string>
} = {}): Promise<{ readonly runId: string; readonly dashboard: string }> {
  const traceStore = resolve(options.traceStore)
  await (dependencies.ensureExisting ?? existingFile)(traceStore)
  let store: Pick<FileTraceStore, 'getRun' | 'close'> | undefined
  let value: { readonly runId: string; readonly dashboard: string } | undefined
  let failure: unknown
  try {
    store = await (dependencies.openStore ?? FileTraceStore.open)(traceStore)
    const run = await store.getRun(options.runId, { includeRecords: true })
    if (!run) {
      throw new DashboardCliError('run_not_found', `run_not_found: ${options.runId}`)
    }
    const html = dependencies.render ? dependencies.render(run) : renderRunViewer({ run })
    const dashboard = await (dependencies.write ?? writeDashboardFile)(html, {
      ...(options.output !== undefined ? { output: options.output } : {}),
      prefix: 'run',
    })
    value = { runId: run.runId, dashboard }
  } catch (error) {
    failure = error
  }
  if (store) {
    try {
      await store.close()
    } catch (error) {
      if (!failure) {
        failure = new DashboardCliError(
          'trace_store_close_failed',
          'trace_store_close_failed: FileTraceStore did not close cleanly.',
          EXIT.INTERNAL,
        )
      }
    }
  }
  if (failure) throw failure
  return value!
}

async function main(): Promise<number> {
  const argv = parseArgs(process.argv)
  const cmd = argv._[0]
  const pretty = argv.flags.has('pretty')
  const includeMessages = argv.flags.has('include-messages')
  const dashboard = argv.flags.has('dashboard')

  if (cmd === undefined || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    process.stdout.write(`${help()}\n`)
    return EXIT.SUCCESS
  }

  if (cmd === 'provider') {
    return cmdProvider(argv._[1], argv._[2], pretty)
  }

  const jsonOpts: CliJsonOptions = { pretty, includeMessages }

  try {
    if (cmd === 'eval') {
      if (argv._[1] === 'run') {
        const evaluated = await runEvalCli(argv)
        printJson(evaluated.summary, pretty)
        return evaluated.exit
      }
      if (argv._[1] === 'gate') {
        const gated = await runEvalGateCli(argv)
        printJson(gated.verdict, pretty)
        return gated.exit
      }
      if (argv._[1] !== 'run' && argv._[1] !== 'gate') {
        printJson({
          error: {
            kind: 'usage',
            message: argv._[1] === undefined
              ? 'usage: oma eval <run|gate>'
              : `unknown eval subcommand: ${argv._[1]}`,
          },
        }, pretty)
        return EXIT.USAGE
      }
    }

    if (cmd === 'dashboard') {
      const traceStore = getOpt(argv.kv, argv.flags, 'trace-store')
      const runId = getOpt(argv.kv, argv.flags, 'run-id')
      const output = getOpt(argv.kv, argv.flags, 'output')
      if (!traceStore || !runId) {
        throw new OmaValidationError('oma dashboard requires --trace-store and --run-id')
      }
      if (output === '') throw new OmaValidationError('--output requires a non-empty path')
      const exported = await exportStoredRunDashboard({
        traceStore,
        runId,
        ...(output !== undefined ? { output } : {}),
      })
      printJson({ command: 'dashboard', ...exported }, pretty)
      return EXIT.SUCCESS
    }

    if (cmd === 'run') {
      const goal = getOpt(argv.kv, argv.flags, 'goal')
      const teamPath = getOpt(argv.kv, argv.flags, 'team')
      const orchPath = getOpt(argv.kv, argv.flags, 'orchestrator')
      const coordPath = getOpt(argv.kv, argv.flags, 'coordinator')
      if (!goal || !teamPath) {
        printJson({ error: { kind: 'usage', message: '--goal and --team are required' } }, pretty)
        return EXIT.USAGE
      }

      const teamRaw = readJson(teamPath)
      let teamCfg: TeamConfig
      let orchParts: OrchestratorConfig[] = []
      if (isObject(teamRaw) && teamRaw['team'] !== undefined) {
        teamCfg = asTeamConfig(teamRaw['team'], 'team')
        if (teamRaw['orchestrator'] !== undefined) {
          orchParts.push(asOrchestratorPartial(teamRaw['orchestrator'], 'orchestrator'))
        }
      } else {
        teamCfg = asTeamConfig(teamRaw, 'team')
      }
      if (orchPath) {
        orchParts.push(asOrchestratorPartial(readJson(orchPath), 'orchestrator file'))
      }

      const capture = dashboard ? new DashboardTraceCaptureSink() : undefined
      const mergedConfig = mergeOrchestrator({}, ...orchParts)
      const orchestrator = new OpenMultiAgent(capture
        ? withDashboardCapture(mergedConfig, capture)
        : mergedConfig)
      const team = orchestrator.createTeam(teamCfg.name, teamCfg)
      let coordinator: CoordinatorConfig | undefined
      if (coordPath) {
        coordinator = asCoordinatorPartial(readJson(coordPath), 'coordinator file')
      }
      const result = await orchestrator.runTeam(team, goal, coordinator ? { coordinator } : undefined)
      if (dashboard) {
        const exported = await exportCurrentRunDashboard(result, capture?.records() ?? [])
        for (const warning of exported.warnings) process.stderr.write(`oma: ${warning}\n`)
        if (exported.dashboard) process.stderr.write(`oma: dashboard written to ${exported.dashboard}\n`)
      }
      await orchestrator.shutdown()
      const payload = { command: 'run' as const, ...serializeTeamRunResult(result, jsonOpts) }
      printJson(payload, pretty)
      return result.success ? EXIT.SUCCESS : EXIT.RUN_FAILED
    }

    if (cmd === 'task') {
      const file = getOpt(argv.kv, argv.flags, 'file')
      const teamOverride = getOpt(argv.kv, argv.flags, 'team')
      if (!file) {
        printJson({ error: { kind: 'usage', message: '--file is required' } }, pretty)
        return EXIT.USAGE
      }
      const doc = readJson(file)
      if (!isObject(doc)) {
        throw new OmaValidationError('tasks file root must be an object')
      }
      const orchParts: OrchestratorConfig[] = []
      if (doc['orchestrator'] !== undefined) {
        orchParts.push(asOrchestratorPartial(doc['orchestrator'], 'orchestrator'))
      }
      const teamCfg = teamOverride
        ? asTeamConfig(readJson(teamOverride), 'team (--team)')
        : asTeamConfig(doc['team'], 'team')

      const tasks = asTaskSpecs(doc['tasks'], 'tasks')
      if (tasks.length === 0) {
        throw new OmaValidationError('tasks array must not be empty')
      }

      const orchestrator = new OpenMultiAgent(mergeOrchestrator({}, ...orchParts))
      const team = orchestrator.createTeam(teamCfg.name, teamCfg)
      const result = await orchestrator.runTasks(team, tasks)
      await orchestrator.shutdown()
      const payload = { command: 'task' as const, ...serializeTeamRunResult(result, jsonOpts) }
      printJson(payload, pretty)
      return result.success ? EXIT.SUCCESS : EXIT.RUN_FAILED
    }

    printJson({ error: { kind: 'usage', message: `unknown command: ${cmd}` } }, pretty)
    return EXIT.USAGE
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const { kind, exit } = classifyCliError(e, message)
    printJson({ error: { kind, message } }, pretty)
    return exit
  }
}

function classifyCliError(e: unknown, message: string): { kind: string; exit: number } {
  if (e instanceof DashboardCliError) return { kind: e.code, exit: e.exit }
  if (e instanceof FileTraceStoreError) return { kind: e.code.toLowerCase(), exit: EXIT.USAGE }
  if (e instanceof OmaValidationError) return { kind: 'validation', exit: EXIT.USAGE }
  if (message.includes('Invalid JSON')) return { kind: 'validation', exit: EXIT.USAGE }
  if (message.includes('ENOENT') || message.includes('EACCES')) return { kind: 'io', exit: EXIT.USAGE }
  return { kind: 'runtime', exit: EXIT.INTERNAL }
}

const isMain = (() => {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(argv1))
  } catch {
    return false
  }
})()

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      const message = e instanceof Error ? e.message : String(e)
      process.stdout.write(`${JSON.stringify({ error: { kind: 'internal', message } })}\n`)
      process.exit(EXIT.INTERNAL)
    })
}
