/**
 * Loopback recording proxy for OpenAI-compatible providers.
 *
 * Why this exists: OMA's `TokenUsage` is `{ input_tokens, output_tokens }` and
 * carries no cache or per-model breakdown, but the benchmark has to report
 * `cached_tokens` and has to price a group-A run whose tasks deliberately use
 * two different model tiers. Recording usage at the HTTP boundary gives both,
 * and doubles as an independent check on the framework's own accounting.
 *
 * Every request is forwarded verbatim; the proxy never rewrites a body.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface CallRecord {
  /** Label of the benchmark run that was in flight when the call started. */
  readonly label: string
  readonly model: string
  /** Total prompt tokens as reported by the provider (hit + miss). */
  readonly inputTokens: number
  readonly outputTokens: number
  /** Prompt tokens served from the provider's context cache. */
  readonly cachedInputTokens: number
  readonly reasoningTokens: number
  readonly status: number
  readonly startedAt: number
  readonly finishedAt: number
  readonly latencyMs: number
  readonly error?: string
}

interface UsagePayload {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  cached_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function extractCached(usage: UsagePayload): number {
  // DeepSeek reports `prompt_cache_hit_tokens`; the OpenAI shape nests
  // `prompt_tokens_details.cached_tokens`. Accept either, prefer DeepSeek's.
  if (typeof usage.prompt_cache_hit_tokens === 'number') return usage.prompt_cache_hit_tokens
  if (typeof usage.prompt_tokens_details?.cached_tokens === 'number') {
    return usage.prompt_tokens_details.cached_tokens
  }
  return readNumber(usage.cached_tokens)
}

export class RecordingProxy {
  private server: http.Server | undefined
  private port = 0
  private label = 'unlabelled'
  private readonly records: CallRecord[] = []

  private onRecord: ((record: CallRecord) => void) | undefined

  constructor(private readonly upstreamOrigin: string) {}

  /** Called once per provider call, as soon as its response is recorded. */
  observe(listener: (record: CallRecord) => void): void {
    this.onRecord = listener
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res)
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })
    this.port = (this.server!.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = undefined
  }

  /** Base URL to hand to `AgentConfig.baseURL`. */
  get baseURL(): string {
    return `http://127.0.0.1:${this.port}/v1`
  }

  /**
   * Attribute subsequent calls to `label`. Benchmark runs execute strictly one
   * at a time, so a single current label is unambiguous; tasks inside one run
   * may still be concurrent and all belong to that run.
   */
  setLabel(label: string): void {
    this.label = label
  }

  /** Records captured while `label` was current. */
  recordsFor(label: string): CallRecord[] {
    return this.records.filter((r) => r.label === label)
  }

  allRecords(): readonly CallRecord[] {
    return this.records
  }

  private push(record: CallRecord): void {
    this.records.push(record)
    this.onRecord?.(record)
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const label = this.label
    const startedAt = Date.now()
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value !== 'string') continue
      // `host` must not be forwarded: it would point at the loopback listener.
      if (key.toLowerCase() === 'host' || key.toLowerCase() === 'content-length') continue
      headers[key] = value
    }

    const target = `${this.upstreamOrigin}${req.url ?? '/'}`
    let requestedModel = 'unknown'
    try {
      const parsed = JSON.parse(body.toString('utf-8')) as { model?: unknown }
      if (typeof parsed.model === 'string') requestedModel = parsed.model
    } catch {
      // Non-JSON bodies are forwarded unchanged; model stays "unknown".
    }

    try {
      const upstream = await fetch(target, {
        method: req.method ?? 'POST',
        headers,
        ...(body.length > 0 ? { body } : {}),
      })
      const text = await upstream.text()
      const finishedAt = Date.now()

      let model = requestedModel
      let usage: UsagePayload = {}
      try {
        const parsed = JSON.parse(text) as { model?: unknown; usage?: UsagePayload }
        if (typeof parsed.model === 'string') model = parsed.model
        if (parsed.usage) usage = parsed.usage
      } catch {
        // Streaming or error bodies: token fields stay zero and are visible as such.
      }

      this.push({
        label,
        model,
        inputTokens: readNumber(usage.prompt_tokens),
        outputTokens: readNumber(usage.completion_tokens),
        cachedInputTokens: extractCached(usage),
        reasoningTokens: readNumber(usage.completion_tokens_details?.reasoning_tokens),
        status: upstream.status,
        startedAt,
        finishedAt,
        latencyMs: finishedAt - startedAt,
        ...(upstream.ok ? {} : { error: text.slice(0, 500) }),
      })

      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      })
      res.end(text)
    } catch (error) {
      const finishedAt = Date.now()
      const message = error instanceof Error ? error.message : String(error)
      this.push({
        label,
        model: requestedModel,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        status: 0,
        startedAt,
        finishedAt,
        latencyMs: finishedAt - startedAt,
        error: message,
      })
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `bench proxy: ${message}` } }))
    }
  }
}

/** Concurrency and timing facts derived from one run's HTTP calls. */
export interface CallStats {
  readonly llmCalls: number
  readonly failedCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens: number
  readonly reasoningTokens: number
  readonly maxConcurrentCalls: number
  /** Sum of per-call latency divided by the run's wall time. 1.0 means serial. */
  readonly parallelism: number
  readonly perModel: ReadonlyMap<string, { input: number; cached: number; output: number; calls: number }>
}

export function summarizeCalls(records: readonly CallRecord[], wallMs: number): CallStats {
  const perModel = new Map<string, { input: number; cached: number; output: number; calls: number }>()
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let reasoningTokens = 0
  let failedCalls = 0
  let latencySum = 0

  for (const record of records) {
    inputTokens += record.inputTokens
    outputTokens += record.outputTokens
    cachedInputTokens += record.cachedInputTokens
    reasoningTokens += record.reasoningTokens
    latencySum += record.latencyMs
    if (record.status !== 200) failedCalls += 1
    const entry = perModel.get(record.model) ?? { input: 0, cached: 0, output: 0, calls: 0 }
    entry.input += record.inputTokens
    entry.cached += record.cachedInputTokens
    entry.output += record.outputTokens
    entry.calls += 1
    perModel.set(record.model, entry)
  }

  // Max simultaneous in-flight calls, via a sweep over start/end events.
  const events: Array<{ at: number; delta: number }> = []
  for (const record of records) {
    events.push({ at: record.startedAt, delta: 1 })
    events.push({ at: record.finishedAt, delta: -1 })
  }
  events.sort((a, b) => (a.at === b.at ? a.delta - b.delta : a.at - b.at))
  let current = 0
  let maxConcurrentCalls = 0
  for (const event of events) {
    current += event.delta
    if (current > maxConcurrentCalls) maxConcurrentCalls = current
  }

  return {
    llmCalls: records.length,
    failedCalls,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    maxConcurrentCalls,
    parallelism: wallMs > 0 ? latencySum / wallMs : 0,
    perModel,
  }
}
