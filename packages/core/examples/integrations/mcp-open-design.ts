/**
 * Open Design — Batch Landing-Page Variants (OMA driving an MCP server)
 *
 * Open Design (https://github.com/nexu-io/open-design) is a local-first design
 * app whose CLI exposes a stdio MCP server. Each `start_run` spawns a coding
 * agent that produces a design, but a run is ASYNCHRONOUS (returns a runId in
 * ~1s) and single: one run does one design, serially, over 5–30 minutes.
 *
 * This example shows OMA supplying the layer above that: it fans out N
 * landing-page variants in PARALLEL via `runTasks()`. Each variant's async OD
 * flow — create_project → start_run → poll get_run until a terminal status — is
 * driven by deterministic TypeScript (a custom tool), not by the LLM polling in
 * a turn loop. The worker model only does what a model should: turn a one-line
 * creative angle into a rich design brief. The centerpiece is the parallel
 * fan-out over async MCP jobs, not a single call.
 *
 * Run:
 *   npx tsx packages/core/examples/integrations/mcp-open-design.ts
 *
 * Prerequisites:
 *   - A worker-model API key. Defaults to ANTHROPIC_API_KEY (Claude); set
 *     AGENT_PROVIDER + AGENT_MODEL to use Gemini/OpenAI/DeepSeek instead.
 *   - @modelcontextprotocol/sdk installed
 *   - Open Design running, with its local daemon reachable (default 127.0.0.1:7456)
 *   - The OD MCP launch command. Open Design has no npm package and no CLI on
 *     PATH; its MCP server ships inside the desktop app. Open the app →
 *     Settings → "MCP server" to get your machine's exact command/args/env, and
 *     export them (values below are one machine's layout, yours will differ):
 *       export OPEN_DESIGN_MCP_COMMAND=".../Open Design Helper"
 *       export OPEN_DESIGN_MCP_ARGS='[".../daemon-cli.mjs","mcp","--daemon-url","http://127.0.0.1:7456"]'
 *       export OPEN_DESIGN_MCP_ENV='{"ELECTRON_RUN_AS_NODE":"1","OD_DATA_DIR":".../namespaces/release-stable/data"}'
 *
 * Optional env:
 *   VARIANT_COUNT           parallel variants (default 3, clamped 1–8)
 *   OD_AGENT / OD_MODEL     OD engine (default opencode / opencode/deepseek-v4-flash-free — FREE)
 *   AGENT_PROVIDER          OMA worker provider (default anthropic)
 *   AGENT_MODEL             OMA worker model (default claude-haiku-4-5; e.g. claude-sonnet-5)
 *   PRODUCT_BRIEF           what to sell (default: a sample SaaS)
 *   POLL_INTERVAL_SECONDS   status poll interval (default 60, clamped 5–120)
 *   VARIANT_TIMEOUT_MINUTES per-variant deadline (default 40, clamped 5–90)
 *
 * ⚠️ COST + TIME
 *   Each OD run takes 5–30 minutes. With a PAID engine (e.g. sonnet) each run
 *   costs roughly $2, so N variants ≈ N × $2. The OD daemon caps concurrent runs
 *   at 4. This example DEFAULTS to a FREE OD engine and 3 variants, so a smoke
 *   run is ~$0 — only the worker model (a little Claude Haiku) is billed. Point
 *   OD_MODEL at a paid engine only when you accept the per-run cost. Free OD
 *   engines are also less reliable: a run may report success yet write no files
 *   (the example flags those as `succeeded-no-output`). For dependable output
 *   use a paid engine, e.g. OD_AGENT=claude OD_MODEL=claude-haiku-4-5.
 */

import { z } from 'zod'
import { OpenMultiAgent, defineTool } from '../../src/index.js'
import { connectMCPTools } from '../../src/mcp.js'
import type {
  AgentConfig,
  OrchestratorEvent,
  RunTaskSpec,
  ToolDefinition,
  ToolResult,
  ToolUseContext,
} from '../../src/types.js'

// --- env helpers: the OD MCP launch is per-machine, so it must be env-driven --
function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    fail(
      `Missing ${name}. Open Design → Settings → "MCP server" prints your machine's exact command, args, and env.\n` +
        'Export them, for example:\n' +
        '  export OPEN_DESIGN_MCP_COMMAND=".../Open Design Helper"\n' +
        '  export OPEN_DESIGN_MCP_ARGS=\'[".../daemon-cli.mjs","mcp","--daemon-url","http://127.0.0.1:7456"]\'\n' +
        '  export OPEN_DESIGN_MCP_ENV=\'{"ELECTRON_RUN_AS_NODE":"1","OD_DATA_DIR":".../namespaces/release-stable/data"}\'',
    )
  }
  return value
}

function parseJsonArray(name: string): string[] {
  const parsed = ((): unknown => {
    try {
      return JSON.parse(requireEnv(name))
    } catch {
      return undefined
    }
  })()
  if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
    return parsed as string[]
  }
  return fail(`${name} must be a JSON array of strings, e.g. ["mcp","--daemon-url","http://127.0.0.1:7456"].`)
}

function parseJsonObjectOptional(name: string): Record<string, string> {
  const raw = process.env[name]?.trim()
  if (!raw) return {}
  const parsed = ((): unknown => {
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  })()
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, string>
  }
  return fail(`${name}, if set, must be a JSON object mapping string keys to string values.`)
}

function clampInt(raw: string | undefined, fallback: number, lo: number, hi: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, lo), hi) : fallback
}

// --- worker model: provider-agnostic, Claude by default ----------------------
type WorkerProvider = NonNullable<AgentConfig['provider']>
const workerProvider = (process.env.AGENT_PROVIDER?.trim() || 'anthropic') as WorkerProvider
const DEFAULT_WORKER_MODEL: Record<string, string> = {
  anthropic: 'claude-haiku-4-5',
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-5',
  deepseek: 'deepseek-v4-flash',
}
const workerModel = process.env.AGENT_MODEL?.trim() || DEFAULT_WORKER_MODEL[workerProvider] || 'claude-haiku-4-5'

// Fail fast when the worker provider's key is missing (covers the common
// providers; others fall through to the adapter's own error).
const WORKER_KEY_ENV: Record<string, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
}
const requiredKeys = WORKER_KEY_ENV[workerProvider]
if (requiredKeys && !requiredKeys.some((k) => process.env[k]?.trim())) {
  fail(
    `Missing ${requiredKeys.join(' or ')} for the OMA worker model (AGENT_PROVIDER=${workerProvider}). ` +
      'Set it, or pick a different AGENT_PROVIDER / AGENT_MODEL.',
  )
}

// --- run configuration --------------------------------------------------------
const variantCount = clampInt(process.env.VARIANT_COUNT, 3, 1, 8)
const maxConcurrency = Math.min(variantCount, 4) // never exceed OD daemon maxConcurrentRuns:4
const odAgent = process.env.OD_AGENT?.trim() || 'opencode'
const odModel = process.env.OD_MODEL?.trim() || 'opencode/deepseek-v4-flash-free'
const pollMs = clampInt(process.env.POLL_INTERVAL_SECONDS, 60, 5, 120) * 1000
const timeoutMs = clampInt(process.env.VARIANT_TIMEOUT_MINUTES, 40, 5, 90) * 60_000
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)

const PRODUCT =
  process.env.PRODUCT_BRIEF?.trim() ||
  [
    'Product: "Cadence" — an AI meeting assistant that turns calls into decisions.',
    'Audience: busy product teams. Value: automatic summaries, action items, follow-ups.',
    'Include a hero, three feature blocks, social proof, and a primary CTA "Start free".',
  ].join(' ')

// One seed angle per variant so the fan-out is meaningfully different, not N
// copies. The worker expands its assigned angle into a full brief.
const ANGLES = [
  'Bold and minimal: high-contrast hero, one primary CTA, lots of whitespace.',
  'Playful and colorful: rounded shapes, friendly microcopy, warm palette.',
  'Enterprise trust: testimonials, customer logos, security and compliance emphasis.',
  'Benefit-led long-form: feature grid plus a short FAQ.',
  'Developer-focused: code-sample hero, docs-style layout, dark theme.',
  'Conversion-first: tight above-the-fold, urgency, single email capture.',
  'Editorial: large type, story-driven sections, generous imagery.',
  'Data-driven: metrics and outcomes front and center, chart-style visuals.',
]

const TERMINAL = new Set(['succeeded', 'failed', 'canceled'])

interface VariantResult {
  projectName: string
  runId: string
  status: string
  artifact?: string
  detail?: string
}

// Authoritative results collected by CODE (not parsed back out of LLM prose).
const results = new Map<string, VariantResult>()

// --- connect to the OD MCP server (stdio, env-driven command) -----------------
const { tools, disconnect } = await connectMCPTools({
  command: requireEnv('OPEN_DESIGN_MCP_COMMAND'),
  args: parseJsonArray('OPEN_DESIGN_MCP_ARGS'),
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    ...parseJsonObjectOptional('OPEN_DESIGN_MCP_ENV'),
  },
  namePrefix: 'od', // → od_create_project, od_start_run, od_get_run, od_list_agents, …
  requestTimeoutMs: 120_000, // each MCP call is short; start_run returns a runId immediately
})

function od(name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === `od_${name}`)
  if (!tool) {
    throw new Error(`OD MCP tool "od_${name}" not found. Exposed tools: ${tools.map((t) => t.name).join(', ')}`)
  }
  return tool
}

// OD tool results are text blocks holding a JSON string on success; on failure
// they set isError and the text is a human-readable message with embedded JSON.
function parseOd(result: ToolResult, what: string): Record<string, unknown> {
  if (result.isError) {
    throw new Error(`OD ${what} failed: ${result.data}`)
  }
  try {
    return JSON.parse(result.data) as Record<string, unknown>
  } catch {
    throw new Error(`OD ${what} returned non-JSON output: ${result.data.slice(0, 200)}`)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

// --- the deterministic executor: one variant, code-driven polling ------------
async function runVariant(projectName: string, brief: string, ctx: ToolUseContext): Promise<VariantResult> {
  try {
    const created = parseOd(await od('create_project').execute({ name: projectName }, ctx), 'create_project')
    // OD assigns a suffixed id (e.g. "landing-…-v1-c110"). Use that exact id for
    // the run rather than re-matching on name — name lookup is a substring match
    // and races the create under concurrency ("no project matches …").
    const project = created.project as Record<string, unknown> | undefined
    const projectId = typeof project?.id === 'string' ? project.id : projectName

    // start_run can race create under concurrency: create returns an id, but the
    // project isn't queryable for a beat ("no project matches"). The project was
    // just created, so a transient miss is a timing window — retry with backoff.
    let started: Record<string, unknown> | undefined
    for (let attempt = 1; attempt <= 4 && !started; attempt++) {
      const res = await od('start_run').execute(
        { project: projectId, prompt: brief, agent: odAgent, model: odModel },
        ctx,
      )
      if (!res.isError) {
        started = JSON.parse(res.data) as Record<string, unknown>
      } else if (attempt === 4) {
        return { projectName, runId: '', status: 'start_failed', detail: res.data.slice(0, 160) }
      } else {
        await sleep(2000 * attempt, ctx.abortSignal) // 2s, 4s, 6s
      }
    }
    const runId = started && typeof started.runId === 'string' ? started.runId : ''
    if (!runId) return { projectName, runId: '', status: 'start_failed', detail: 'start_run returned no runId' }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (ctx.abortSignal?.aborted) {
        await od('cancel_run')
          .execute({ runId }, ctx)
          .catch(() => undefined)
        return { projectName, runId, status: 'aborted' }
      }
      await sleep(pollMs, ctx.abortSignal)
      const run = parseOd(await od('get_run').execute({ runId }, ctx), 'get_run')
      const status = typeof run.status === 'string' ? run.status : 'unknown'
      if (TERMINAL.has(status)) {
        const previewUrl = typeof run.previewUrl === 'string' ? run.previewUrl : undefined
        // A run can report `succeeded` yet write no files (some free engines do
        // this). Treat "succeeded but no previewable artifact" as a soft failure
        // so the batch report never overclaims a real design that isn't there.
        if (status === 'succeeded' && !previewUrl) {
          return { projectName, runId, status: 'succeeded-no-output' }
        }
        return { projectName, runId, status, artifact: previewUrl ?? 'none' }
      }
    }
    return { projectName, runId, status: 'timeout' }
  } catch (error) {
    return { projectName, runId: '', status: 'error', detail: error instanceof Error ? error.message : String(error) }
  }
}

// Each worker gets its OWN tool with projectName bound in code, so the LLM never
// invents or collides project names — it only supplies the creative brief.
function makeVariantTool(projectName: string): ToolDefinition {
  return defineTool({
    name: 'run_landing_variant',
    description:
      'Generate this variant\'s landing page in Open Design and block until the design run reaches a terminal ' +
      'status. Call this exactly once, passing your full design brief. Returns JSON {projectName, runId, status, artifact}.',
    inputSchema: z.object({
      designBrief: z.string().min(1).describe('A rich, self-contained landing-page design brief for this variant.'),
    }),
    execute: async ({ designBrief }, ctx) => {
      const result = await runVariant(projectName, designBrief, ctx)
      results.set(projectName, result)
      return { data: JSON.stringify(result), isError: result.status !== 'succeeded' }
    },
  })
}

// --- progress handler: makes the parallel fan-out visible --------------------
const startedAt = Date.now()
function elapsed(): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1).padStart(6)}s`
}
function handleProgress(event: OrchestratorEvent): void {
  if (event.type === 'agent_start') console.log(`[t+${elapsed()}] START  ${event.agent}`)
  if (event.type === 'agent_complete') console.log(`[t+${elapsed()}] DONE   ${event.agent}`)
  if (event.type === 'error') console.error(`[t+${elapsed()}] ERROR  ${event.agent ?? ''} ${String(event.data ?? '')}`)
}

const WORKER_SYSTEM_PROMPT = [
  'You design ONE landing-page variant.',
  'You are given a product and one creative angle. Expand the angle into a single, rich, self-contained design brief',
  '(layout, sections, tone, color direction, copy hints) for that product.',
  'Then call run_landing_variant EXACTLY ONCE with that brief as designBrief.',
  'That tool runs the full Open Design pipeline and blocks until it finishes — do not call it more than once,',
  'and do not try to poll or check status yourself; the tool already waited for the terminal result.',
  'When it returns, reply with one line: RESULT <the tool\'s JSON output>.',
].join(' ')

try {
  // --- preflight: deterministic reachability check + engine discovery --------
  const preflightCtx: ToolUseContext = { agent: { name: 'preflight', role: 'preflight', model: '-' } }
  const agentsProbe = await od('list_agents').execute({}, preflightCtx)
  if (agentsProbe.isError) {
    fail(
      'Could not reach the Open Design daemon via list_agents. Is Open Design running with its daemon ' +
        `reachable (default 127.0.0.1:7456)?\n${agentsProbe.data}`,
    )
  }
  console.log(`Open Design reachable. Worker: ${workerProvider} / ${workerModel}. OD engine: ${odAgent} / ${odModel}.`)
  console.log(`Generating ${variantCount} variant(s). Available OD engines:\n${agentsProbe.data.slice(0, 900)}\n`)

  // --- fan-out roster: N DISTINCT worker names → real parallelism ------------
  // (AgentPool holds a per-agent-name Semaphore(1); same-name tasks would serialize.)
  const projectNames = Array.from({ length: variantCount }, (_, i) => `landing-${stamp}-v${i + 1}`)
  const workers: AgentConfig[] = projectNames.map((projectName, i) => ({
    name: `variant-worker-${i + 1}`,
    provider: workerProvider,
    model: workerModel,
    maxTurns: 6,
    parallelToolCalls: false,
    customTools: [makeVariantTool(projectName)], // registration == grant; no `tools` allowlist needed
    systemPrompt: WORKER_SYSTEM_PROMPT,
  }))

  const orchestrator = new OpenMultiAgent({
    defaultProvider: workerProvider,
    defaultModel: workerModel,
    maxConcurrency, // concurrency comes from HERE; TeamConfig.maxConcurrency is inert
    onProgress: handleProgress,
  })
  const team = orchestrator.createTeam('landing-variants', {
    name: 'landing-variants',
    agents: workers,
    sharedMemory: false, // variants are independent; no cross-task context
  })

  // --- tasks: one per variant, distinct assignee, NO dependsOn → all parallel -
  const tasks: RunTaskSpec[] = workers.map((worker, i) => ({
    title: `variant-${i + 1}`,
    assignee: worker.name,
    maxRetries: 0, // never auto-retry a 5–30 min design run
    description: [
      `Design landing-page variant ${i + 1} for this product:`,
      PRODUCT,
      '',
      `Creative angle for THIS variant: ${ANGLES[i % ANGLES.length]}`,
      '',
      'Expand that angle into one rich design brief, then call run_landing_variant once with it.',
    ].join('\n'),
  }))

  console.log(`Fanning out ${variantCount} variant(s), up to ${maxConcurrency} running at once…\n`)
  const runResult = await orchestrator.runTasks(team, tasks)

  // --- report from the authoritative code-collected results ------------------
  console.log(`\n${'='.repeat(64)}`)
  console.log(`Batch complete. orchestrator success=${runResult.success}\n`)
  let succeeded = 0
  for (const projectName of projectNames) {
    const r = results.get(projectName)
    if (r?.status === 'succeeded') succeeded++
    const badge = r?.status === 'succeeded' ? 'OK  ' : 'FAIL'
    const detail = r ? `${r.status}${r.detail ? ` (${r.detail})` : ''} — ${r.artifact ?? 'no artifact'}` : 'no result recorded'
    console.log(`  [${badge}] ${projectName}: ${detail}`)
  }
  console.log(`\n${succeeded}/${variantCount} variant(s) succeeded.`)
  console.log(
    `Worker tokens — input: ${runResult.totalTokenUsage.input_tokens}, output: ${runResult.totalTokenUsage.output_tokens}`,
  )
  console.log('Open these projects in Open Design to preview the variants.')
} finally {
  // Tears down the stdio proxy only; any in-flight OD runs keep going in the
  // daemon and stay retrievable by runId via get_run.
  await disconnect()
}
