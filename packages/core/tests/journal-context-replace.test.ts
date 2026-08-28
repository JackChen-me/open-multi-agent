import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AgentRunner } from '../src/agent/runner.js'
import { InMemoryRunJournal, JournalRecorder } from '../src/journal/journal.js'
import type { RunEvent } from '../src/journal/events.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { defineTool, ToolRegistry } from '../src/tool/framework.js'
import type {
  ContextStrategy,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ContextReplaceEvent = Extract<RunEvent, { type: 'context/replace' }>
type LLMRequestEvent = Extract<RunEvent, { type: 'llm/request' }>

function textResponse(text: string): LLMResponse {
  return {
    id: `resp-${text}`,
    content: [{ type: 'text', text }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function toolResponse(id: string): LLMResponse {
  return {
    id: `resp-${id}`,
    content: [{ type: 'tool_use', id, name: 'echo', input: { value: id } }],
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

const echoTool = defineTool({
  name: 'echo',
  description: 'Echo a value back.',
  inputSchema: z.object({ value: z.string() }),
  execute: async ({ value }) => ({ data: `echo:${value} padded with enough text to compress` }),
})

/**
 * Serves `steps` to the agentic loop and a fixed summary to the summarize
 * strategy, which is the only call the runner makes with no tools attached.
 * Records exactly what each main-loop request contained, so the journal's
 * claims can be checked against what the model actually saw.
 */
function strategyAdapter(steps: LLMResponse[]) {
  let calls = 0
  const requests: LLMMessage[][] = []
  const adapter: LLMAdapter = {
    name: 'context-replace-fixture',
    async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
      if (options.tools === undefined) return textResponse('condensed history')
      requests.push(messages.map((message) => ({ ...message, content: [...message.content] })))
      const step = steps[Math.min(calls, steps.length - 1)]!
      calls += 1
      return step
    },
    async *stream() {
      yield { type: 'done' as const, data: textResponse('stream-unused') }
    },
  }
  return { adapter, requests: () => requests }
}

function runnerWith(
  adapter: LLMAdapter,
  options: Partial<ConstructorParameters<typeof AgentRunner>[3]> = {},
): AgentRunner {
  const registry = new ToolRegistry()
  registry.register(echoTool)
  return new AgentRunner(adapter, registry, new ToolExecutor(registry), {
    model: 'mock-model',
    agentName: 'worker',
    allowedTools: ['echo'],
    ...options,
  })
}

const seed: LLMMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'investigate the deploy failure' }] },
]

function replaces(events: readonly RunEvent[]): ContextReplaceEvent[] {
  return events.filter((event): event is ContextReplaceEvent => event.type === 'context/replace')
}

function requestEvents(events: readonly RunEvent[]): LLMRequestEvent[] {
  return events.filter((event): event is LLMRequestEvent => event.type === 'llm/request')
}

/**
 * The reproducibility predicate PR 3 will enforce offline: every block the
 * model saw that names a `context/replace` is carried verbatim by that event,
 * matched on content rather than position.
 */
function expectDerivedBlocksReproduce(
  events: readonly RunEvent[],
  requests: readonly LLMMessage[][],
): number {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  let checked = 0
  requestEvents(events).forEach((request, index) => {
    const sent = requests[index]
    expect(sent).toBeDefined()
    for (const descriptor of request.blocks) {
      expect(descriptor.sourceEventSeqs).not.toBeNull()
      const named = descriptor.sourceEventSeqs!.map((seq) => bySeq.get(seq))
      if (!named.some((event) => event?.type === 'context/replace')) continue
      const block = sent![descriptor.messageIndex]!.content[descriptor.blockIndex]
      const carried = named
        .filter((event): event is ContextReplaceEvent => event?.type === 'context/replace')
        .flatMap((event) => event.replacements.map((replacement) => replacement.block))
      expect(carried).toContainEqual(block)
      checked += 1
    }
  })
  return checked
}

async function runWithJournal(
  runner: AgentRunner,
  messages: LLMMessage[] = seed,
  recorder?: JournalRecorder,
): Promise<{ journal: InMemoryRunJournal; recorder: JournalRecorder; events: RunEvent[] }> {
  const journal = new InMemoryRunJournal()
  const active = recorder ?? await JournalRecorder.open({ journal, runId: 'run-1', attempt: 1 })
  await runner.run(messages, { journal: active })
  await active.flush()
  return { journal, recorder: active, events: await journal.readFrom(0) }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('context/replace', () => {
  it('records what sliding-window dropped and what replaced it', async () => {
    const scripted = strategyAdapter([
      toolResponse('tu-1'),
      toolResponse('tu-2'),
      textResponse('done'),
    ])
    const runner = runnerWith(scripted.adapter, {
      contextStrategy: { type: 'sliding-window', maxTurns: 1 },
    })
    const { events } = await runWithJournal(runner)

    const [event, ...extra] = replaces(events)
    expect(extra).toEqual([])
    expect(event!.strategy).toBe('sliding-window')
    expect(event!.detail).toEqual({ droppedTurns: 1 })
    expect(event!.replacements).toHaveLength(1)
    const replacement = event!.replacements[0]!
    expect(replacement.block).toMatchObject({ type: 'text' })
    expect((replacement.block as { text: string }).text).toContain('1 turn(s) removed')

    // Everything dropped is named, and the notice names both the dropped turns
    // and the message it was merged into.
    const dropped = event!.dropped?.sourceEventSeqs ?? []
    expect(dropped.length).toBeGreaterThan(0)
    for (const seq of dropped) expect(replacement.sourceEventSeqs).toContain(seq)
    expect(replacement.sourceEventSeqs.length).toBeGreaterThan(dropped.length)
    expect(expectDerivedBlocksReproduce(events, scripted.requests())).toBe(1)
  })

  it('records the summary a summarize pass put in place of the old turns', async () => {
    const scripted = strategyAdapter([textResponse('done')])
    const runner = runnerWith(scripted.adapter, {
      contextStrategy: { type: 'summarize', maxTokens: 1, summaryModel: 'summary-model' },
    })
    const history: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'investigate the deploy failure' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reading the logs' }] },
      { role: 'user', content: [{ type: 'text', text: 'what did they say' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'auth refresh timed out' }] },
      { role: 'user', content: [{ type: 'text', text: 'summarise and continue' }] },
    ]
    const { events } = await runWithJournal(runner, history)

    const [event] = replaces(events)
    expect(event!.strategy).toBe('summarize')
    expect(event!.detail).toEqual({
      summaryModel: 'summary-model',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    expect(event!.replacements).toHaveLength(1)
    expect((event!.replacements[0]!.block as { text: string }).text)
      .toContain('[Conversation summary]')

    // The summarized old portion is exactly what the event names as its source.
    const seeded = events.filter((candidate) =>
      candidate.type === 'assistant/message' || candidate.type === 'user/message')
    expect(event!.replacements[0]!.sourceEventSeqs)
      .toEqual([seeded[1]!.seq, seeded[2]!.seq])
    // The summarize call itself is an implementation detail of the rewrite.
    expect(requestEvents(events)).toHaveLength(1)
    expect(expectDerivedBlocksReproduce(events, scripted.requests())).toBe(1)
  })

  it('reuses the first summarize event when the memo cache rebuilds the same summary', async () => {
    const scripted = strategyAdapter([textResponse('done')])
    const runner = runnerWith(scripted.adapter, {
      contextStrategy: { type: 'summarize', maxTokens: 1 },
    })
    const history: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'investigate the deploy failure' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reading the logs' }] },
      { role: 'user', content: [{ type: 'text', text: 'what did they say' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'auth refresh timed out' }] },
      { role: 'user', content: [{ type: 'text', text: 'summarise and continue' }] },
    ]

    const journal = new InMemoryRunJournal()
    const recorder = await JournalRecorder.open({ journal, runId: 'run-1', attempt: 1 })
    await runner.run(history, { journal: recorder })
    await runner.run(history, { journal: recorder })
    await recorder.flush()
    const events = await journal.readFrom(0)

    // Same old portion, same summary text: one event carries both rewrites.
    const summaries = replaces(events)
    expect(summaries).toHaveLength(1)
    const requests = requestEvents(events)
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      const derived = request.blocks.filter((block) =>
        block.sourceEventSeqs?.includes(summaries[0]!.seq))
      expect(derived).toHaveLength(1)
    }
    expect(expectDerivedBlocksReproduce(events, scripted.requests())).toBe(2)
  })

  it('records one replacement per block a compact pass rewrote', async () => {
    const scripted = strategyAdapter([
      toolResponse('tu-1'),
      toolResponse('tu-2'),
      textResponse('done'),
    ])
    const runner = runnerWith(scripted.adapter, {
      contextStrategy: {
        type: 'compact',
        maxTokens: 1,
        preserveRecentTurns: 1,
        minToolResultChars: 1,
      },
    })
    const { events } = await runWithJournal(runner)

    const compactions = replaces(events)
    expect(compactions.length).toBeGreaterThan(0)
    for (const event of compactions) {
      expect(event.strategy).toBe('compact')
      expect(event.dropped).toBeUndefined()
      expect(event.replacements.length).toBeGreaterThan(0)
      for (const replacement of event.replacements) {
        // Each rewritten block names exactly the block it was built from.
        expect(replacement.sourceEventSeqs).toHaveLength(1)
        expect(replacement.block).toMatchObject({ type: 'tool_result' })
        expect((replacement.block as { content: string }).content).toContain('compacted')
      }
    }
    expect(expectDerivedBlocksReproduce(events, scripted.requests()))
      .toBeGreaterThanOrEqual(compactions.length)
  })

  it('records only the results a compress pass newly compressed', async () => {
    const scripted = strategyAdapter([
      toolResponse('tu-1'),
      toolResponse('tu-2'),
      toolResponse('tu-3'),
      textResponse('done'),
    ])
    const runner = runnerWith(scripted.adapter, { compressToolResults: { minChars: 1 } })
    const { events } = await runWithJournal(runner)

    const compressions = replaces(events)
    expect(compressions).toHaveLength(2)
    for (const event of compressions) {
      expect(event.strategy).toBe('compress-tool-results')
      // Already-compressed results are prefix-match skipped, so a pass records
      // one result, not the whole history again.
      expect(event.replacements).toHaveLength(1)
      expect((event.replacements[0]!.block as { content: string }).content)
        .toContain('[Tool output compressed')
    }
    expect(expectDerivedBlocksReproduce(events, scripted.requests())).toBeGreaterThan(0)
  })

  it('records a custom strategy\'s invented block verbatim', async () => {
    const scripted = strategyAdapter([textResponse('done')])
    const custom: ContextStrategy = {
      type: 'custom',
      compress: (messages) => [
        messages[0]!,
        { role: 'user', content: [{ type: 'text', text: `[rewritten ${messages.length}]` }] },
      ],
    }
    const runner = runnerWith(scripted.adapter, { contextStrategy: custom })
    const { events } = await runWithJournal(runner)

    const [event] = replaces(events)
    expect(event!.strategy).toBe('custom')
    expect(event!.replacements).toHaveLength(1)
    expect(event!.replacements[0]!.block).toEqual({ type: 'text', text: '[rewritten 1]' })
    // The function is opaque, so the whole input conversation is the lineage.
    expect(event!.replacements[0]!.sourceEventSeqs).toHaveLength(1)
    expect(expectDerivedBlocksReproduce(events, scripted.requests())).toBe(1)
  })

  it('emits nothing when a configured strategy does not rewrite anything', async () => {
    const scripted = strategyAdapter([textResponse('done')])
    const runner = runnerWith(scripted.adapter, {
      contextStrategy: { type: 'sliding-window', maxTurns: 50 },
      compressToolResults: true,
    })
    const { events } = await runWithJournal(runner)

    expect(replaces(events)).toEqual([])
    expect(expectDerivedBlocksReproduce(events, scripted.requests())).toBe(0)
  })

  it('satisfies enforceLineage while summarizing', async () => {
    const scripted = strategyAdapter([textResponse('done')])
    const runner = runnerWith(scripted.adapter, {
      contextStrategy: { type: 'summarize', maxTokens: 1 },
    })
    const journal = new InMemoryRunJournal()
    const recorder = await JournalRecorder.open({
      journal,
      runId: 'run-1',
      attempt: 1,
      enforceLineage: true,
    })
    const history: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'investigate the deploy failure' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reading the logs' }] },
      { role: 'user', content: [{ type: 'text', text: 'what did they say' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'auth refresh timed out' }] },
      { role: 'user', content: [{ type: 'text', text: 'summarise and continue' }] },
    ]

    const result = await runner.run(history, { journal: recorder })
    expect(result.output).toBe('done')
    await recorder.flush()
    const events = await journal.readFrom(0)
    expect(replaces(events)).toHaveLength(1)
    expect(expectDerivedBlocksReproduce(events, scripted.requests())).toBe(1)
  })

  it('leaves an unjournaled run byte-identical', async () => {
    const withJournal = strategyAdapter([
      toolResponse('tu-1'),
      toolResponse('tu-2'),
      textResponse('done'),
    ])
    const strategy: ContextStrategy = { type: 'sliding-window', maxTurns: 1 }
    await runWithJournal(runnerWith(withJournal.adapter, { contextStrategy: strategy }))

    const without = strategyAdapter([
      toolResponse('tu-1'),
      toolResponse('tu-2'),
      textResponse('done'),
    ])
    const result = await runnerWith(without.adapter, { contextStrategy: strategy }).run(seed)

    expect(result.output).toBe('done')
    expect(without.requests()).toEqual(withJournal.requests())
  })
})
