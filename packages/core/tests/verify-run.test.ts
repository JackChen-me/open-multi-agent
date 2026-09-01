import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { canonicalContentHash } from '../src/journal/hash.js'
import { InMemoryRunJournal } from '../src/journal/journal.js'
import { JsonlRunJournal } from '../src/journal/jsonl-journal.js'
import { verifyRun } from '../src/journal/verify.js'
import type { RunEvent } from '../src/journal/events.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { InMemoryStore } from '../src/memory/store.js'
import { Team } from '../src/team/team.js'
import { defineTool } from '../src/tool/framework.js'
import type {
  AgentConfig,
  ContentBlock,
  LLMAdapter,
  LLMResponse,
  RunTaskSpec,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// The #527 acceptance fixture
// ---------------------------------------------------------------------------

const RUN_ID = 'deploy-failure'

function base(seq: number): {
  seq: number
  timestampUnixMs: number
  runId: string
  attempt: number
  taskId: string
  agentName: string
} {
  return {
    seq,
    timestampUnixMs: 1_700_000_000_000 + seq,
    runId: RUN_ID,
    attempt: 1,
    taskId: 'task-1',
    agentName: 'investigator',
  }
}

function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

const FIRST_USER_BLOCK = text('Investigate deploy failure')
const SUMMARY_BLOCK = text('Summary: auth refresh timed out; retry budget exhausted.')

/**
 * The fixture contributed by nanookclaw in the #527 thread, expressed in OMA's
 * event vocabulary.
 *
 * Sequences 1-4 fold cleanly: user message, assistant reply, tool call, tool
 * result. The request that follows then shows the model a summary block that
 * no journal event produced, while still naming a lineage — the request-level
 * `sourceEventSeqs: [1, 2]` from the issue, carried here on the block itself
 * because lineage moved from per-request to per-block.
 *
 * `summaryLineage` is the one knob: `[1, 2]` is the issue's "present but not
 * reproducible" case, `null` the simpler "names nothing" one.
 */
function acceptanceFixture(summaryLineage: readonly number[] | null): RunEvent[] {
  return [
    {
      ...base(1),
      type: 'user/message',
      origin: 'input',
      message: { role: 'user', content: [FIRST_USER_BLOCK] },
    },
    {
      ...base(2),
      type: 'assistant/message',
      origin: 'response',
      sourceEventSeqs: [1],
      message: { role: 'assistant', content: [text('I will inspect the logs')] },
    },
    {
      ...base(3),
      type: 'tool/call',
      sourceEventSeqs: [2],
      call: { type: 'tool_use', id: 'call-logs', name: 'logs', input: {} },
    },
    {
      ...base(4),
      type: 'tool/result',
      sourceEventSeqs: [3],
      toolCallId: 'call-logs',
      result: {
        type: 'tool_result',
        tool_use_id: 'call-logs',
        content: '[200 KB of raw logs]',
      },
    },
    {
      ...base(5),
      type: 'llm/request',
      turn: 2,
      model: 'mock-model',
      blocks: [
        {
          messageIndex: 0,
          blockIndex: 0,
          role: 'user',
          blockType: 'text',
          sourceEventSeqs: [1],
          contentHash: canonicalContentHash(FIRST_USER_BLOCK),
        },
        {
          messageIndex: 1,
          blockIndex: 0,
          role: 'assistant',
          blockType: 'text',
          sourceEventSeqs: summaryLineage,
          contentHash: canonicalContentHash(SUMMARY_BLOCK),
        },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Run fixtures
// ---------------------------------------------------------------------------

function textResponse(value: string): LLMResponse {
  return {
    id: `resp-${value}`,
    content: [{ type: 'text', text: value }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 2, output_tokens: 3 },
  }
}

function toolResponse(id: string): LLMResponse {
  return {
    id: `resp-${id}`,
    content: [{ type: 'tool_use', id, name: 'echo', input: { value: id } }],
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 2, output_tokens: 3 },
  }
}

/** Serves one scripted response per call, repeating the last one. */
function sequencedAdapter(steps: LLMResponse[]): LLMAdapter {
  let calls = 0
  return {
    name: 'verify-fixture',
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
  execute: async ({ value }) => ({ data: `echo:${value} padded so a rewrite has something to do` }),
})

function worker(adapter: LLMAdapter, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: 'worker', model: 'mock-model', adapter, ...overrides }
}

const toolUsingSteps = [toolResponse('tu-1'), toolResponse('tu-2'), textResponse('all done')]

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oma-verify-'))
  tempDirs.push(dir)
  return join(dir, name)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyRun', () => {
  // The #527 acceptance criterion, and deliberately the first test in this
  // file: "verification is not done until this negative case is covered,
  // ahead of any happy path test".
  it('rejects the #527 acceptance fixture: a summary block naming lineage that does not reproduce it', async () => {
    const result = await verifyRun({ events: acceptanceFixture([1, 2]) })

    expect(result.ok).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatchObject({
      code: 'MISSING_CONTEXT_REPLACE',
      reason: 'not-reproducible',
      seq: 5,
      messageIndex: 1,
      blockIndex: 0,
    })

    // Naming a lineage is not the same as being reproducible from it: the
    // first block reproduces verbatim from event 1 and passes, so the fixture
    // fails on the unexplained summary alone. Nothing here is unavailable, so
    // the verdict is a failure rather than an inconclusive window.
    expect(result.inconclusive).toEqual([])
    expect(result.stats).toEqual({ events: 5, requests: 1, blocksChecked: 2 })
  })

  it('rejects the same fixture under the simpler failure of naming no lineage at all', async () => {
    const result = await verifyRun({ events: acceptanceFixture(null) })

    expect(result.ok).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatchObject({
      code: 'MISSING_CONTEXT_REPLACE',
      reason: 'no-lineage',
      seq: 5,
      messageIndex: 1,
      blockIndex: 0,
    })
  })

  it('verifies a real tool-using run', async () => {
    const journal = new InMemoryRunJournal()
    const store = new InMemoryStore()
    const team = new Team({
      name: 'team',
      agents: [worker(sequencedAdapter(toolUsingSteps), {
        customTools: [echoTool],
        tools: ['echo'],
      })],
      sharedMemoryStore: store,
    })
    const tasks: RunTaskSpec[] = [{ title: 'only', description: 'do it', assignee: 'worker' }]

    const run = await new OpenMultiAgent().runTasks(team, tasks, { journal })
    expect(run.success).toBe(true)

    const result = await verifyRun(journal)
    expect(result.failures).toEqual([])
    expect(result.inconclusive).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.stats.requests).toBeGreaterThan(1)
    expect(result.stats.blocksChecked).toBeGreaterThan(result.stats.requests)
  })

  it('verifies a run whose conversation a context strategy rewrote', async () => {
    const journal = new InMemoryRunJournal()
    const store = new InMemoryStore()
    const team = new Team({
      name: 'team',
      agents: [worker(sequencedAdapter(toolUsingSteps), {
        customTools: [echoTool],
        tools: ['echo'],
        contextStrategy: { type: 'sliding-window', maxTurns: 1 },
      })],
      sharedMemoryStore: store,
    })

    await new OpenMultiAgent().runTasks(
      team,
      [{ title: 'only', description: 'do it', assignee: 'worker' }],
      { journal },
    )

    const events = await journal.readFrom(0)
    // Without a rewrite this test would only repeat the previous one.
    const replaces = events.filter((event) => event.type === 'context/replace')
    expect(replaces.length).toBeGreaterThan(0)

    const result = await verifyRun({ events })
    expect(result.failures).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('verifies a run whose second attempt resumed from a checkpoint', async () => {
    const journal = new InMemoryRunJournal()
    const store = new InMemoryStore()
    const abort = new AbortController()
    const commits: string[] = []
    const commit = defineTool({
      name: 'commit',
      description: 'Commit a labelled side effect.',
      inputSchema: z.object({ label: z.string() }),
      execute: async ({ label }) => {
        commits.push(label)
        // The process dies with the effect done and the turn unfinished.
        abort.abort()
        return { data: `committed:${label}` }
      },
    })
    const adapter = sequencedAdapter([
      {
        id: 'resp-commit',
        content: [{ type: 'tool_use', id: 'tu-c', name: 'commit', input: { label: 'B' } }],
        model: 'mock-model',
        stop_reason: 'tool_use',
        usage: { input_tokens: 2, output_tokens: 3 },
      },
      textResponse('resumed and done'),
    ])
    const config = worker(adapter, { customTools: [commit] })
    const buildTeam = (): Team => new Team({
      name: 'team',
      agents: [config],
      sharedMemoryStore: new InMemoryStore(),
    })
    const tasks: RunTaskSpec[] = [{ title: 'only', description: 'commit B', assignee: 'worker' }]

    await new OpenMultiAgent().runTasks(buildTeam(), tasks, {
      abortSignal: abort.signal,
      checkpoint: { store },
      journal,
    })
    expect(commits).toEqual(['B'])

    const resumed = await new OpenMultiAgent().restore(buildTeam(), {
      checkpoint: { store },
      journal,
    })
    expect(resumed.success).toBe(true)

    const events = await journal.readFrom(0)
    // One sequence stream, two attempts: the resumed attempt's request blocks
    // name events the first attempt wrote, re-attached from the snapshot's
    // persisted lineage. Resolution has to span the whole journal, not one
    // attempt, for those to reproduce.
    expect(new Set(events.map((event) => event.attempt)).size).toBeGreaterThan(1)
    const requests = events.filter((event) => event.type === 'llm/request')
    const last = requests.at(-1)!
    expect(last.attempt).toBeGreaterThan(1)
    expect(last.blocks.some((block) =>
      block.sourceEventSeqs?.some((seq) =>
        events.find((event) => event.seq === seq)!.attempt === 1))).toBe(true)

    const result = await verifyRun({ events })
    expect(result.failures).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('reports an evicted lineage window as inconclusive rather than a failure', async () => {
    const source = new InMemoryRunJournal()
    await new OpenMultiAgent().runAgent(
      worker(sequencedAdapter(toolUsingSteps), { customTools: [echoTool], tools: ['echo'] }),
      'a question',
      { journal: source },
    )
    const full = await source.readFrom(0)

    // Replay the same events through a ring buffer too small to hold them, so
    // the retained tail cites events the head already dropped.
    const evicting = new InMemoryRunJournal({ maxEvents: 4 })
    await evicting.append(full)
    expect((await evicting.readFrom(0)).length).toBe(4)

    const result = await verifyRun(evicting)
    // Nothing was disproven, so the run stays ok with the gaps recorded.
    expect(result.failures).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.inconclusive.length).toBeGreaterThan(0)
    for (const gap of result.inconclusive) {
      expect(gap.missingSeqs.length).toBeGreaterThan(0)
      for (const missing of gap.missingSeqs) expect(missing).toBeLessThan(gap.seq)
    }
  })

  it('flags a duplicated and an out-of-order sequence', async () => {
    const [first, second, third] = acceptanceFixture([1, 2])

    const duplicated = await verifyRun({ events: [first!, second!, { ...second! }] })
    expect(duplicated.ok).toBe(false)
    expect(duplicated.failures).toEqual([
      expect.objectContaining({ code: 'SEQ_NOT_MONOTONIC', reason: 'duplicate-sequence', seq: 2 }),
    ])

    const reordered = await verifyRun({ events: [first!, third!, second!] })
    expect(reordered.ok).toBe(false)
    expect(reordered.failures).toEqual([
      expect.objectContaining({
        code: 'SEQ_NOT_MONOTONIC',
        reason: 'out-of-order-sequence',
        seq: 2,
      }),
    ])
  })

  it('separates a gap the head dropped from a link that points the wrong way', async () => {
    const [, second, third, fourth] = acceptanceFixture([1, 2])

    // Event 2 names event 1, which this window never saw: unavailable, not wrong.
    const evicted = await verifyRun({ events: [second!, third!, fourth!] })
    expect(evicted.ok).toBe(true)
    expect(evicted.inconclusive).toEqual([
      expect.objectContaining({ seq: 2, missingSeqs: [1] }),
    ])

    // A source at or above the event citing it cannot be an eviction gap.
    const forward = await verifyRun({
      events: [second!, { ...third!, sourceEventSeqs: [9] }, fourth!],
    })
    expect(forward.ok).toBe(false)
    expect(forward.failures).toEqual([
      expect.objectContaining({ code: 'BROKEN_LINK', reason: 'forward-reference', seq: 3 }),
    ])
  })

  it('verifies a JSONL journal read cold from disk', async () => {
    const path = await tempFile('run.jsonl')
    const journal = new JsonlRunJournal(path)
    const store = new InMemoryStore()
    const team = new Team({
      name: 'team',
      agents: [worker(sequencedAdapter(toolUsingSteps), {
        customTools: [echoTool],
        tools: ['echo'],
      })],
      sharedMemoryStore: store,
    })

    try {
      const run = await new OpenMultiAgent().runTasks(
        team,
        [{ title: 'only', description: 'do it', assignee: 'worker' }],
        { journal, checkpoint: { store } },
      )
      expect(run.success).toBe(true)
    } finally {
      await journal.close()
    }

    // A fresh instance over the same path shares no state with the writer, so
    // this verifies the persisted bytes rather than anything held in memory.
    const cold = new JsonlRunJournal(path)
    try {
      const result = await verifyRun(cold)
      expect(result.failures).toEqual([])
      expect(result.inconclusive).toEqual([])
      expect(result.ok).toBe(true)
      expect(result.stats.events).toBeGreaterThan(result.stats.requests)
      expect(result.stats.requests).toBeGreaterThan(1)
    } finally {
      await cold.close()
    }
  })

  it('cannot reproduce a block that redaction rewrote on its way to disk', async () => {
    const path = await tempFile('redacted.jsonl')
    // `contentHash` is computed in process, before the backend redacts, so a
    // pattern that rewrites a block the model saw breaks the byte comparison
    // for content that was in fact recorded correctly. Documented as a limit of
    // verifying a redacted journal, and asserted here so it stays a known one.
    const journal = new JsonlRunJournal(path, { redact: { patterns: [/\bcust-\d+\b/g] } })
    try {
      await new OpenMultiAgent().runAgent(
        worker(sequencedAdapter([textResponse('looked it up')])),
        'please look up cust-4242 for me',
        { journal },
      )
    } finally {
      await journal.close()
    }

    const cold = new JsonlRunJournal(path)
    try {
      const result = await verifyRun(cold)
      expect(result.ok).toBe(false)
      expect(result.failures).toEqual([
        expect.objectContaining({
          code: 'MISSING_CONTEXT_REPLACE',
          reason: 'not-reproducible',
        }),
      ])
    } finally {
      await cold.close()
    }

    // Control: the identical run without the pattern verifies cleanly, so the
    // rewrite is what broke it rather than anything about this conversation.
    const control = new InMemoryRunJournal()
    await new OpenMultiAgent().runAgent(
      worker(sequencedAdapter([textResponse('looked it up')])),
      'please look up cust-4242 for me',
      { journal: control },
    )
    expect((await verifyRun(control)).ok).toBe(true)
  })

  it('accepts a journal with no requests in it at all', async () => {
    const result = await verifyRun({ events: [] })
    expect(result.ok).toBe(true)
    expect(result.stats).toEqual({ events: 0, requests: 0, blocksChecked: 0 })
  })
})
