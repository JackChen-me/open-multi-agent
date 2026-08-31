import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { BatchingTraceSink } from '../src/observability/batching.js'
import { InMemoryTraceStore } from '../src/observability/in-memory-store.js'
import { TraceStoreExporter } from '../src/observability/store-exporter.js'
import { defineTool } from '../src/tool/framework.js'
import type { LLMAdapter, LLMResponse } from '../src/types.js'

const PROMPT = 'private prompt obs5-privacy'
const COMPLETION = 'private completion obs5-privacy'
const TOOL_ARGUMENT = 'private tool argument obs5-privacy'
const TOOL_RESULT = 'private tool result obs5-privacy'
const REASONING = 'private chain of thought obs5-privacy'

function toolCall(): LLMResponse {
  return {
    id: 'tool-call',
    content: [{
      type: 'tool_use',
      id: 'tool-use-1',
      name: 'private_lookup',
      input: { query: TOOL_ARGUMENT },
    }],
    model: 'privacy-test',
    stop_reason: 'tool_use',
    usage: { input_tokens: 3, output_tokens: 2 },
  }
}

function completion(): LLMResponse {
  return {
    id: 'completion',
    content: [{ type: 'text', text: `${COMPLETION} <thinking>${REASONING}</thinking>` }],
    model: 'privacy-test',
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 4, reasoning_output_tokens: 2 },
  }
}

describe('Observability v2 default privacy boundary', () => {
  it('keeps prompt, completion, tool payloads, and reasoning out of sink/store records', async () => {
    let call = 0
    const adapter: LLMAdapter = {
      name: 'privacy-test',
      async chat() { return call++ === 0 ? toolCall() : completion() },
      async *stream() {},
    }
    const tool = defineTool({
      name: 'private_lookup',
      description: 'Privacy test tool.',
      inputSchema: z.object({ query: z.string() }),
      execute: async () => ({ data: TOOL_RESULT }),
    })
    const store = new InMemoryTraceStore()
    const sink = new BatchingTraceSink(new TraceStoreExporter(store), {
      diagnostics: 'silent',
      scheduledDelayMs: 60_000,
    })
    const result = await new OpenMultiAgent({ observability: { sinks: [sink] } }).runAgent({
      name: 'worker',
      model: 'privacy-test',
      adapter,
      customTools: [tool],
    }, PROMPT)

    expect(result.success).toBe(true)
    await expect(sink.forceFlush({ timeoutMs: 500 })).resolves.toMatchObject({ status: 'ok' })
    const stored = await store.getRun(result.identity!.runId, { includeRecords: true })
    const serialized = JSON.stringify(stored?.records)
    for (const secret of [PROMPT, COMPLETION, TOOL_ARGUMENT, TOOL_RESULT, REASONING]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).not.toContain('<thinking>')
    expect(stored?.tokens).toMatchObject({
      input_tokens: 8,
      output_tokens: 6,
    })
    await sink.shutdown({ timeoutMs: 500 })
  })

  it('admits tool input/output under an explicit capture policy without widening other content', async () => {
    let call = 0
    const adapter: LLMAdapter = {
      name: 'privacy-test',
      async chat() { return call++ === 0 ? toolCall() : completion() },
      async *stream() {},
    }
    const tool = defineTool({
      name: 'private_lookup',
      description: 'Privacy test tool.',
      inputSchema: z.object({ query: z.string() }),
      execute: async () => ({ data: TOOL_RESULT }),
    })
    const store = new InMemoryTraceStore()
    const sink = new BatchingTraceSink(new TraceStoreExporter(store), {
      diagnostics: 'silent',
      scheduledDelayMs: 60_000,
    })
    const result = await new OpenMultiAgent({
      observability: {
        sinks: [sink],
        capture: { toolInput: 'redacted', toolOutput: 'redacted' },
      },
    }).runAgent({
      name: 'worker',
      model: 'privacy-test',
      adapter,
      customTools: [tool],
    }, PROMPT)

    expect(result.success).toBe(true)
    await expect(sink.forceFlush({ timeoutMs: 500 })).resolves.toMatchObject({ status: 'ok' })
    const stored = await store.getRun(result.identity!.runId, { includeRecords: true })
    const toolEnd = stored?.records?.find((record) =>
      record.recordType === 'span_end' && record.attributes?.['oma.tool.name'] === 'private_lookup')

    // The opted-in fields arrive.
    expect(toolEnd?.attributes?.['oma.tool.input']).toContain(TOOL_ARGUMENT)
    expect(toolEnd?.attributes?.['oma.tool.output']).toContain(TOOL_RESULT)

    // Everything the policy did not name stays out, including reasoning, which
    // has no opt-in at all.
    const serialized = JSON.stringify(stored?.records)
    for (const secret of [PROMPT, COMPLETION, REASONING]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).not.toContain('<thinking>')
    await sink.shutdown({ timeoutMs: 500 })
  })

  it('leaves tool spans untouched when the capture policy names neither tool field', async () => {
    const adapter: LLMAdapter = {
      name: 'privacy-test',
      async chat() { return completion() },
      async *stream() {},
    }
    const store = new InMemoryTraceStore()
    const sink = new BatchingTraceSink(new TraceStoreExporter(store), {
      diagnostics: 'silent',
      scheduledDelayMs: 60_000,
    })
    // A policy that opts into unrelated fields must not switch tool capture on.
    const result = await new OpenMultiAgent({
      observability: { sinks: [sink], capture: { errorMessage: 'redacted' } },
    }).runAgent({ name: 'worker', model: 'privacy-test', adapter }, PROMPT)

    expect(result.success).toBe(true)
    await expect(sink.forceFlush({ timeoutMs: 500 })).resolves.toMatchObject({ status: 'ok' })
    const stored = await store.getRun(result.identity!.runId, { includeRecords: true })
    expect(JSON.stringify(stored?.records)).not.toContain('oma.tool.input')
    await sink.shutdown({ timeoutMs: 500 })
  })
})
