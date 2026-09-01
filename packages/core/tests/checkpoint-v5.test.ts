import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Checkpoint } from '../src/memory/checkpoint.js'
import { InMemoryStore } from '../src/memory/store.js'
import { InMemoryRunJournal } from '../src/journal/journal.js'
import { foldJournalTail, journalTailReadFrom } from '../src/journal/tail-replay.js'
import type { RunEvent } from '../src/journal/events.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { Team } from '../src/team/team.js'
import { defineTool } from '../src/tool/framework.js'
import type {
  AgentConfig,
  CheckpointSnapshot,
  InFlightTaskCheckpoint,
  LLMAdapter,
  LLMResponse,
  MemoryEntry,
  MemoryStore,
  OrchestratorEvent,
  RunTaskSpec,
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

function toolUseResponse(id: string, label: string): LLMResponse {
  return {
    id: `resp-${id}`,
    content: [{ type: 'tool_use', id, name: 'commit_effect', input: { label } }],
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function sequencedAdapter(steps: LLMResponse[]) {
  let calls = 0
  const adapter: LLMAdapter = {
    name: 'checkpoint-v5-fixture',
    async chat(): Promise<LLMResponse> {
      const step = steps[Math.min(calls, steps.length - 1)]!
      calls += 1
      return step
    },
    async *stream() {
      yield { type: 'done' as const, data: textResponse('stream-unused') }
    },
  }
  return { adapter, calls: () => calls }
}

/** A checkpoint store that stops accepting writes once the crash is armed. */
class CrashingStore implements MemoryStore {
  private readonly inner = new InMemoryStore()
  crashed = false

  async get(key: string): Promise<MemoryEntry | null> {
    return this.inner.get(key)
  }

  async set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void> {
    if (this.crashed) throw new Error('checkpoint store unavailable')
    return this.inner.set(key, value, metadata)
  }

  async setWithExpiry(
    key: string,
    value: string,
    expiresAtTurn: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (this.crashed) throw new Error('checkpoint store unavailable')
    return this.inner.setWithExpiry(key, value, expiresAtTurn, metadata)
  }

  async list(prefix?: string): Promise<MemoryEntry[]> {
    return this.inner.list(prefix)
  }

  async delete(key: string): Promise<void> {
    return this.inner.delete(key)
  }

  async clear(): Promise<void> {
    return this.inner.clear()
  }
}

const tasks: RunTaskSpec[] = [
  { title: 'only', description: 'commit the effect', assignee: 'worker' },
]

/**
 * Runs a task whose tool commits a side effect and then takes the checkpoint
 * store down with it, so the last durable snapshot predates the commit while
 * the journal already holds it.
 */
async function crashAfterCommit() {
  const store = new CrashingStore()
  const journal = new InMemoryRunJournal()
  const abort = new AbortController()
  const commits: string[] = []
  const scripted = sequencedAdapter([
    toolUseResponse('tu-1', 'B'),
    textResponse('done'),
  ])
  const tool = defineTool({
    name: 'commit_effect',
    description: 'Commit a labelled side effect to an external system.',
    inputSchema: z.object({ label: z.string() }),
    execute: async ({ label }) => {
      commits.push(label)
      // The process dies here: the effect landed, the journal batch landed, and
      // the checkpoint that would have recorded the commit never will.
      store.crashed = true
      abort.abort()
      return { data: `committed:${label}`, isError: false }
    },
  })
  const worker: AgentConfig = {
    name: 'worker',
    model: 'mock-model',
    adapter: scripted.adapter,
    customTools: [tool],
  }
  const buildTeam = (): Team => new Team({
    name: 'team',
    agents: [worker],
    sharedMemoryStore: new InMemoryStore(),
  })

  await new OpenMultiAgent().runTasks(buildTeam(), tasks, {
    abortSignal: abort.signal,
    checkpoint: { store },
    journal,
  })
  expect(commits).toEqual(['B'])

  const persisted = await new Checkpoint(store, {}).loadLatest()
  expect(persisted?.version).toBe(5)
  if (persisted?.version !== 5) throw new Error('expected checkpoint v5')
  // The snapshot really does predate the commit — this is what restore starts from.
  const entry = persisted.inFlightTasks[0]
  expect(entry?.pendingToolCalls?.[0]?.commit).toBeUndefined()
  // The entry carries its own mark, and it can only lag the snapshot-wide one.
  expect(entry?.journalSeq).toBeGreaterThan(0)
  expect(entry!.journalSeq!).toBeLessThanOrEqual(persisted.journalWatermarkSeq)

  store.crashed = false
  return { store, journal, commits, scripted, buildTeam, snapshot: persisted }
}

function baseEvent(seq: number, taskId = 'task-1'): Omit<RunEvent, 'type'> & { type: never } {
  return {
    seq,
    timestampUnixMs: 1_700_000_000_000 + seq,
    runId: 'run-1',
    attempt: 1,
    taskId,
    agentName: 'worker',
  } as Omit<RunEvent, 'type'> & { type: never }
}

function inFlight(overrides: Partial<InFlightTaskCheckpoint> = {}): InFlightTaskCheckpoint {
  return {
    taskId: 'task-1',
    assignee: 'worker',
    phase: 'executing_tools',
    conversationMessages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'echo', input: {} }] },
    ],
    messages: [],
    tokenUsage: { input_tokens: 1, output_tokens: 1 },
    toolCalls: [],
    turns: 1,
    pendingToolCalls: [{ call: { type: 'tool_use', id: 'tu-1', name: 'echo', input: {} } }],
    ...overrides,
  }
}

const commitEvent = (seq: number, taskId = 'task-1'): RunEvent => ({
  ...baseEvent(seq, taskId),
  type: 'tool/result',
  toolCallId: 'tu-1',
  result: { type: 'tool_result', tool_use_id: 'tu-1', content: 'echo:hi' },
  record: { toolName: 'echo', input: {}, output: 'echo:hi', duration: 1 },
} as RunEvent)

const assistantToolUseEvent = (seq: number): RunEvent => ({
  ...baseEvent(seq),
  type: 'assistant/message',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu-1', name: 'echo', input: {} }],
  },
  origin: 'response',
  usage: { input_tokens: 2, output_tokens: 3 },
} as RunEvent)

const callEvent = (seq: number): RunEvent => ({
  ...baseEvent(seq),
  type: 'tool/call',
  call: { type: 'tool_use', id: 'tu-1', name: 'echo', input: {} },
} as RunEvent)

const toolResultsMessageEvent = (seq: number): RunEvent => ({
  ...baseEvent(seq),
  type: 'user/message',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'echo:hi' }],
  },
  origin: 'tool_results',
} as RunEvent)

/** An entry refreshed before its task's assistant turn was ever journaled. */
function staleInFlight(overrides: Partial<InFlightTaskCheckpoint> = {}): InFlightTaskCheckpoint {
  return inFlight({
    phase: 'awaiting_model',
    conversationMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    pendingToolCalls: undefined,
    turns: 1,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkpoint v5', () => {
  it('writes v5 with a watermark when journaling is on and v4 when it is off', async () => {
    const build = (journal?: InMemoryRunJournal) => ({
      store: new InMemoryStore(),
      team: new Team({
        name: 'team',
        agents: [{
          name: 'worker',
          model: 'mock-model',
          adapter: sequencedAdapter([textResponse('done')]).adapter,
        }],
        sharedMemoryStore: new InMemoryStore(),
      }),
      journal,
    })

    const off = build()
    await new OpenMultiAgent().runTasks(off.team, tasks, { checkpoint: { store: off.store } })
    const v4 = await new Checkpoint(off.store, {}).loadLatest()
    expect(v4?.version).toBe(4)
    expect(v4).not.toHaveProperty('journalWatermarkSeq')
    expect(v4).not.toHaveProperty('journalRef')

    const on = build(new InMemoryRunJournal())
    await new OpenMultiAgent().runTasks(on.team, tasks, {
      checkpoint: { store: on.store },
      journal: on.journal,
    })
    const v5 = await new Checkpoint(on.store, {}).loadLatest()
    expect(v5?.version).toBe(5)
    if (v5?.version !== 5) throw new Error('expected checkpoint v5')
    expect(v5.journalWatermarkSeq).toBeGreaterThan(0)
    expect(v5.journalRef).toEqual({ kind: 'InMemoryRunJournal' })
    // Everything a v4 snapshot carried is still there, under the same names.
    expect(Object.keys(v4!).every((key) => key in v5)).toBe(true)

    // The persisted watermark and the event that announces it describe the same
    // build, and both name a sequence the snapshot could actually have folded.
    const saves = (await on.journal!.readFrom(0))
      .filter((event) => event.type === 'checkpoint/saved')
    expect(saves.at(-1)).toMatchObject({ version: 5, watermarkSeq: v5.journalWatermarkSeq })
    expect(v5.journalWatermarkSeq).toBeLessThan(saves.at(-1)!.seq)
  })

  it('keeps loading v1 through v4 snapshots', async () => {
    const store = new InMemoryStore()
    const manager = new Checkpoint(store, {})
    const identity = {
      runId: 'run-1',
      attempt: 1,
      lastTraceId: 'trace-1',
      lastRootSpanId: 'span-1',
    }
    const queue = { version: 1 as const, tasks: [], inProgress: [], completed: [], failed: [] }
    const legacy: CheckpointSnapshot[] = [
      { version: 1, mode: 'runTasks', createdAt: '2026-01-01T00:00:00.000Z', queue, completedTaskResults: [] },
      { version: 2, mode: 'runTasks', createdAt: '2026-01-01T00:00:00.000Z', identity, queue, completedTaskResults: [] },
      { version: 3, mode: 'runTasks', createdAt: '2026-01-01T00:00:00.000Z', identity, queue, completedTaskResults: [], inFlightTasks: [] },
      {
        version: 4,
        mode: 'runTasks',
        createdAt: '2026-01-01T00:00:00.000Z',
        identity,
        queue,
        completedTaskResults: [],
        inFlightTasks: [],
        pendingApprovals: [],
        approvalDecisions: [],
      },
    ]
    for (const snapshot of legacy) {
      await manager.save(snapshot)
      expect((await manager.loadLatest())?.version).toBe(snapshot.version)
    }
  })

  it('rejects a v5 snapshot whose lineage does not line up with its conversation', async () => {
    const store = new InMemoryStore()
    const manager = new Checkpoint(store, {})
    const state = inFlight({
      phase: 'awaiting_model',
      pendingToolCalls: undefined,
      conversationLineage: [[[1]]],
    })
    await store.set(new Checkpoint(store, {}).key, JSON.stringify({
      version: 5,
      mode: 'runTasks',
      createdAt: '2026-01-01T00:00:00.000Z',
      identity: { runId: 'run-1', attempt: 1, lastTraceId: 't', lastRootSpanId: 's' },
      queue: { version: 1, tasks: [], inProgress: [], completed: [], failed: [] },
      completedTaskResults: [],
      // Two messages, one lineage entry: corruption, not an older schema.
      inFlightTasks: [state],
      pendingApprovals: [],
      approvalDecisions: [],
      journalWatermarkSeq: 4,
    }))
    await expect(manager.loadLatest()).rejects.toThrow(/not a checkpoint snapshot/)
  })

  it('does not re-execute a tool whose result reached the journal but not the checkpoint', async () => {
    const crashed = await crashAfterCommit()

    const result = await new OpenMultiAgent().restore(crashed.buildTeam(), {
      checkpoint: { store: crashed.store },
      journal: crashed.journal,
    })

    expect(result.tasks?.every((record) => record.status === 'completed')).toBe(true)
    // The side effect the snapshot never saw is replayed as data, not re-run.
    expect(crashed.commits).toEqual(['B'])
    // The resumed model call still saw the tool result the crash lost.
    const conversation = JSON.stringify([...result.agentResults.values()])
    expect(conversation).toContain('committed:B')
    // One resumed turn, not a repeat of the tool round.
    expect(crashed.scripted.calls()).toBe(2)
  })

  it('re-executes the same tool when the journal is not supplied', async () => {
    const crashed = await crashAfterCommit()

    const result = await new OpenMultiAgent().restore(crashed.buildTeam(), {
      checkpoint: { store: crashed.store },
    })

    expect(result.tasks?.every((record) => record.status === 'completed')).toBe(true)
    // Same snapshot, no tail: the commit boundary is repeated. This is the
    // behavior the journal upgrades, and it stays exactly as it was.
    expect(crashed.commits).toEqual(['B', 'B'])
  })

  it('restores per-block lineage so a resumed run satisfies enforceLineage', async () => {
    const crashed = await crashAfterCommit()

    const result = await new OpenMultiAgent().restore(crashed.buildTeam(), {
      checkpoint: { store: crashed.store },
      journal: { journal: crashed.journal, enforceLineage: true },
    })

    expect(result.tasks?.every((record) => record.status === 'completed')).toBe(true)
    const events = await crashed.journal.readFrom(0)
    const requests = events.filter((event) => event.type === 'llm/request')
    // The resumed attempt made a request, and every block in it names an event.
    const resumed = requests.at(-1)
    expect(resumed).toBeDefined()
    expect(resumed!.seq).toBeGreaterThan(crashed.snapshot.journalWatermarkSeq)
    expect(resumed!.blocks.every((block) => block.sourceEventSeqs !== null)).toBe(true)
  })

  it('reports a discarded tail and resumes from the snapshot alone', async () => {
    const crashed = await crashAfterCommit()
    // A journal whose tail commits a call this snapshot never announced.
    const foreign = new InMemoryRunJournal()
    await foreign.append([{
      ...commitEvent(
        crashed.snapshot.journalWatermarkSeq + 1,
        crashed.snapshot.inFlightTasks[0]!.taskId,
      ),
      toolCallId: 'tu-foreign',
    } as RunEvent])

    const warnings: OrchestratorEvent[] = []
    const result = await new OpenMultiAgent({
      onProgress: (event) => {
        if (event.type === 'warning') warnings.push(event)
      },
    }).restore(crashed.buildTeam(), {
      checkpoint: { store: crashed.store },
      journal: foreign,
    })

    expect(result.tasks?.every((record) => record.status === 'completed')).toBe(true)
    expect(warnings.map((event) => (event.data as { code: string }).code))
      .toContain('JOURNAL_TAIL_DISCARDED')
    // Snapshot-only recovery, identical to a run with no journal at all.
    expect(crashed.commits).toEqual(['B', 'B'])
  })
})

describe('journal tail fold', () => {
  it('attaches a commit the snapshot is missing', () => {
    const fold = foldJournalTail([inFlight()], [commitEvent(5)], 4)

    expect(fold.discardReason).toBeUndefined()
    expect(fold.foldedEvents).toBe(1)
    expect(fold.tasks[0]!.pendingToolCalls?.[0]?.commit).toMatchObject({
      result: { tool_use_id: 'tu-1' },
      record: { toolName: 'echo' },
    })
  })

  it('carries delegation usage into the commit it rebuilds', () => {
    const event = {
      ...commitEvent(5),
      delegationUsage: { input_tokens: 7, output_tokens: 3 },
    } as RunEvent
    const fold = foldJournalTail([inFlight()], [event], 4)

    expect(fold.tasks[0]!.pendingToolCalls?.[0]?.commit?.delegationUsage)
      .toEqual({ input_tokens: 7, output_tokens: 3 })
  })

  it('skips an event the entry already folded rather than discarding the tail', () => {
    const fold = foldJournalTail([inFlight({ journalSeq: 6 })], [commitEvent(5)], 4)

    // Below this entry's own mark: already reflected, so it is not re-applied
    // and the rest of the tail is still usable.
    expect(fold.discardReason).toBeUndefined()
    expect(fold.foldedEvents).toBe(0)
    expect(fold.tasks[0]!.pendingToolCalls?.[0]?.commit).toBeUndefined()
  })

  it('discards a tail whose sequences do not increase', () => {
    const fold = foldJournalTail([inFlight()], [commitEvent(6), commitEvent(6)], 4)

    expect(fold.discardReason).toMatch(/append-only/)
    expect(fold.foldedEvents).toBe(0)
  })

  it('discards a commit for a call the snapshot never announced', () => {
    const event = { ...commitEvent(5), toolCallId: 'tu-other' } as RunEvent
    const fold = foldJournalTail([inFlight()], [event], 4)

    expect(fold.discardReason).toMatch(/not pending/)
    expect(fold.foldedEvents).toBe(0)
  })

  it('discards a fold that would send an assistant message back to the model', () => {
    const assistant = {
      ...baseEvent(5),
      type: 'assistant/message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      origin: 'response',
    } as RunEvent
    const fold = foldJournalTail(
      [inFlight({ phase: 'awaiting_model', pendingToolCalls: undefined })],
      [assistant],
      4,
    )

    expect(fold.discardReason).toMatch(/cannot resume from/)
    expect(fold.foldedEvents).toBe(0)
  })

  it('ignores events belonging to another task or a delegated child', () => {
    const otherTask = commitEvent(5, 'task-2')
    const delegated = { ...commitEvent(6), agentName: 'helper' } as RunEvent
    const fold = foldJournalTail([inFlight()], [otherTask, delegated], 4)

    expect(fold.discardReason).toBeUndefined()
    expect(fold.foldedEvents).toBe(0)
    expect(fold.tasks[0]!.pendingToolCalls?.[0]?.commit).toBeUndefined()
  })

  it('rebuilds a whole round for an entry staler than the snapshot watermark', () => {
    // Another task checkpointed at 105 while this one was mid-round, so the
    // snapshot's own watermark is far ahead of what this entry reflects.
    const state = staleInFlight({ journalSeq: 100 })
    const events = [
      assistantToolUseEvent(101),
      callEvent(106),
      commitEvent(107),
      toolResultsMessageEvent(108),
      { ...baseEvent(109), type: 'turn/end', turn: 2, outcome: 'tool_use' } as RunEvent,
    ]
    expect(journalTailReadFrom([state], 105)).toBe(101)

    const fold = foldJournalTail([state], events, 105)

    expect(fold.discardReason).toBeUndefined()
    const [folded] = fold.tasks
    // The assistant turn the snapshot never captured is folded back in, so the
    // tool result has the tool_use block it belongs to.
    expect(folded!.conversationMessages.map((message) => message.role))
      .toEqual(['user', 'assistant', 'user'])
    expect(folded!.conversationMessages[1]!.content[0]).toMatchObject({ type: 'tool_use', id: 'tu-1' })
    expect(folded!.conversationMessages[2]!.content[0]).toMatchObject({ type: 'tool_result' })
    expect(folded!.phase).toBe('awaiting_model')
    expect(folded!.pendingToolCalls).toBeUndefined()
    expect(folded!.turns).toBe(2)
    expect(folded!.toolCalls).toHaveLength(1)
    expect(folded!.tokenUsage).toEqual({ input_tokens: 3, output_tokens: 4 })
    // The folded entry now carries a mark that is true of it.
    expect(folded!.journalSeq).toBe(109)
  })

  it('discards an unanchored tool round when the entry predates per-task marks', () => {
    // A v5 entry written before `journalSeq` existed: the window falls back to
    // the snapshot watermark, so the assistant turn at 101 is out of reach.
    const state = staleInFlight()
    const events = [callEvent(106), commitEvent(107)]
    expect(journalTailReadFrom([state], 105)).toBe(106)

    const fold = foldJournalTail([state], events, 105)

    expect(fold.discardReason).toMatch(/no assistant turn requesting it/)
    expect(fold.foldedEvents).toBe(0)
    expect(fold.tasks).toEqual([state])
  })

  it('discards tool results assembled with no round open', () => {
    const fold = foldJournalTail([staleInFlight()], [toolResultsMessageEvent(106)], 105)

    expect(fold.discardReason).toMatch(/no tool round open/)
    expect(fold.foldedEvents).toBe(0)
  })

  it('leaves task status, memory, and approval events to their own records', () => {
    const status = { ...baseEvent(5), type: 'task/status', status: 'completed' } as RunEvent
    const memory = { ...baseEvent(6), type: 'memory/set', agent: 'worker', key: 'k' } as RunEvent
    const fold = foldJournalTail([inFlight()], [status, memory], 4)

    expect(fold.discardReason).toBeUndefined()
    expect(fold.tasks).toEqual([inFlight()])
  })
})
