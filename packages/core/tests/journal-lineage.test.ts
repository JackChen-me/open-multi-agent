import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AgentRunner } from '../src/agent/runner.js'
import { JournalLineageError } from '../src/errors.js'
import { InMemoryRunJournal, JournalRecorder } from '../src/journal/journal.js'
import type { RunEvent } from '../src/journal/events.js'
import type { RunJournal } from '../src/journal/journal.js'
import { canonicalContentHash } from '../src/journal/hash.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { InMemoryStore } from '../src/memory/store.js'
import { Team } from '../src/team/team.js'
import { defineTool, ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type {
  AgentConfig,
  ContextStrategy,
  InFlightTaskCheckpoint,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  OrchestratorEvent,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    content: [{ type: 'tool_use', id, name: 'echo', input: { value: 'hi' } }],
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function sequencedAdapter(steps: LLMResponse[]): LLMAdapter {
  let calls = 0
  return {
    name: 'lineage-fixture',
    async chat(): Promise<LLMResponse> {
      const step = steps[Math.min(calls, steps.length - 1)]!
      calls += 1
      return step
    },
    async *stream() {
      yield { type: 'done' as const, data: textResponse('stream-unused') }
    },
  }
}

const echoTool = defineTool({
  name: 'echo',
  description: 'Echo a value back.',
  inputSchema: z.object({ value: z.string() }),
  execute: async ({ value }) => ({ data: `echo:${value}` }),
})

/** Replaces the whole conversation with a block no journal event produced. */
const rewritingStrategy: ContextStrategy = {
  type: 'custom',
  compress: (messages) => [{
    role: 'user',
    content: [{ type: 'text', text: `[rewritten from ${messages.length} messages]` }],
  }],
}

function runnerWith(
  adapter: LLMAdapter,
  options: {
    contextStrategy?: ContextStrategy
    compressToolResults?: { minChars: number }
  } = {},
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

const seedMessages: LLMMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
]

function requestBlocks(events: readonly RunEvent[]) {
  return events
    .filter((event): event is Extract<RunEvent, { type: 'llm/request' }> =>
      event.type === 'llm/request')
    .flatMap((event) => event.blocks.map((block) => ({ ...block, requestSeq: event.seq })))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('journal lineage', () => {
  it('gives every model-visible block a lineage when no strategy rewrites the conversation', async () => {
    const journal = new InMemoryRunJournal()
    const recorder = await JournalRecorder.open({ journal, runId: 'run-1', attempt: 1 })
    const runner = runnerWith(sequencedAdapter([toolResponse('tu-1'), textResponse('done')]))

    await runner.run(seedMessages, { journal: recorder })
    await recorder.flush()

    const events = await journal.readFrom(0)
    const blocks = requestBlocks(events)
    expect(blocks.length).toBeGreaterThan(1)
    expect(blocks.filter((block) => block.sourceEventSeqs === null)).toEqual([])

    // Each named event exists and precedes the request that cites it.
    const bySeq = new Map(events.map((event) => [event.seq, event]))
    for (const block of blocks) {
      for (const seq of block.sourceEventSeqs!) {
        expect(bySeq.has(seq)).toBe(true)
        expect(seq).toBeLessThan(block.requestSeq)
      }
      expect(block.contentHash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('reproduces a request block from the event it names', async () => {
    const journal = new InMemoryRunJournal()
    const recorder = await JournalRecorder.open({ journal, runId: 'run-1', attempt: 1 })

    await runnerWith(sequencedAdapter([textResponse('done')])).run(seedMessages, {
      journal: recorder,
    })
    await recorder.flush()

    const events = await journal.readFrom(0)
    const [block] = requestBlocks(events)
    const source = events.find((event) => event.seq === block!.sourceEventSeqs![0])
    expect(source?.type).toBe('user/message')
    const hashes = (source as Extract<RunEvent, { type: 'user/message' }>).message.content
      .map(canonicalContentHash)
    expect(hashes).toContain(block!.contentHash)
  })

  it('points a strategy-derived block at the context/replace that produced it', async () => {
    const journal = new InMemoryRunJournal()
    const recorder = await JournalRecorder.open({ journal, runId: 'run-1', attempt: 1 })
    const runner = runnerWith(sequencedAdapter([textResponse('done')]), {
      contextStrategy: rewritingStrategy,
    })

    await runner.run(seedMessages, { journal: recorder })
    await recorder.flush()

    const events = await journal.readFrom(0)
    const blocks = requestBlocks(events)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.sourceEventSeqs).toHaveLength(1)
    const named = events.find((event) => event.seq === blocks[0]!.sourceEventSeqs![0])
    expect(named?.type).toBe('context/replace')
  })

  it('throws JournalLineageError under enforceLineage when a block names nothing', async () => {
    const recorder = await JournalRecorder.open({
      journal: new InMemoryRunJournal(),
      runId: 'run-1',
      attempt: 1,
      enforceLineage: true,
    })
    const runner = runnerWith(sequencedAdapter([textResponse('done')]))
    // A conversation restored from a snapshot with no persisted lineage is the
    // remaining gap: nothing in this attempt's journal produced those blocks.
    const resumeState: InFlightTaskCheckpoint = {
      taskId: 'task-1',
      assignee: 'worker',
      phase: 'awaiting_model',
      conversationMessages: [{ role: 'user', content: [{ type: 'text', text: 'resumed' }] }],
      messages: [],
      tokenUsage: { input_tokens: 0, output_tokens: 0 },
      toolCalls: [],
      turns: 1,
    }

    await expect(runner.run(seedMessages, { journal: recorder, resumeState }))
      .rejects.toThrow(JournalLineageError)
    await expect(runner.run(seedMessages, { journal: recorder, resumeState }))
      .rejects.toMatchObject({
        code: 'MISSING_CONTEXT_REPLACE',
        messageIndex: 0,
        blockIndex: 0,
        blockType: 'text',
      })
  })

  it('passes enforceLineage with every built-in context strategy', async () => {
    const strategies: ContextStrategy[] = [
      { type: 'sliding-window', maxTurns: 1 },
      { type: 'compact', maxTokens: 1, preserveRecentTurns: 1, minTextBlockChars: 1 },
      rewritingStrategy,
    ]
    for (const contextStrategy of strategies) {
      const journal = new InMemoryRunJournal()
      const recorder = await JournalRecorder.open({
        journal,
        runId: 'run-1',
        attempt: 1,
        enforceLineage: true,
      })
      const runner = runnerWith(
        sequencedAdapter([toolResponse('tu-1'), toolResponse('tu-2'), textResponse('done')]),
        { contextStrategy, compressToolResults: { minChars: 1 } },
      )

      const result = await runner.run(seedMessages, { journal: recorder })
      expect(result.output).toBe('done')
      await recorder.flush()
      expect(requestBlocks(await journal.readFrom(0)).every(
        (block) => block.sourceEventSeqs !== null,
      )).toBe(true)
    }
  })

  it('passes enforceLineage when no strategy is configured', async () => {
    const journal = new InMemoryRunJournal()
    const recorder = await JournalRecorder.open({
      journal,
      runId: 'run-1',
      attempt: 1,
      enforceLineage: true,
    })
    const runner = runnerWith(sequencedAdapter([toolResponse('tu-1'), textResponse('done')]))

    const result = await runner.run(seedMessages, { journal: recorder })
    expect(result.output).toBe('done')
    await recorder.flush()
    expect(requestBlocks(await journal.readFrom(0)).every(
      (block) => block.sourceEventSeqs !== null,
    )).toBe(true)
  })

  it('surfaces a failed append through onProgress and still completes the run', async () => {
    const failures: OrchestratorEvent[] = []
    const failing: RunJournal = {
      async append() {
        throw new Error('journal backend unavailable')
      },
      async readFrom() {
        return []
      },
      async close() {},
    }
    const worker: AgentConfig = {
      name: 'worker',
      model: 'mock-model',
      adapter: sequencedAdapter([textResponse('done')]),
    }
    const orchestrator = new OpenMultiAgent({
      onProgress: (event) => {
        if (event.type === 'error') failures.push(event)
      },
    })
    const team = new Team({
      name: 'team',
      agents: [worker],
      sharedMemoryStore: new InMemoryStore(),
    })

    const result = await orchestrator.runTasks(
      team,
      [{ title: 'only', description: 'do it', assignee: 'worker' }],
      { journal: failing },
    )

    expect(result.success).toBe(true)
    const appendFailures = failures.filter((event) =>
      (event.data as { kind?: string }).kind === 'journal_append_failed')
    expect(appendFailures.length).toBeGreaterThan(0)
    expect((appendFailures[0]!.data as { error: Error }).error.message)
      .toBe('journal backend unavailable')
  })
})
