import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { Team } from '../src/team/team.js'
import { InMemoryStore } from '../src/memory/store.js'
import { defineTool } from '../src/tool/framework.js'
import { InMemoryRunJournal } from '../src/journal/journal.js'
import type { RunEvent } from '../src/journal/events.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMResponse,
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
    usage: { input_tokens: 3, output_tokens: 5 },
  }
}

function toolResponse(id: string, name: string, input: Record<string, unknown>): LLMResponse {
  return {
    id: `resp-${id}`,
    content: [{ type: 'tool_use', id, name, input }],
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 2, output_tokens: 4 },
  }
}

/** Serves one scripted response per chat call, repeating the last one. */
function sequencedAdapter(steps: LLMResponse[]): LLMAdapter {
  let calls = 0
  return {
    name: 'journal-fixture',
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

function throwingAdapter(message: string): LLMAdapter {
  return {
    name: 'journal-fixture-throwing',
    async chat(): Promise<LLMResponse> {
      throw new Error(message)
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

function worker(name: string, adapter: LLMAdapter, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name, model: 'mock-model', adapter, ...overrides }
}

function types(events: readonly RunEvent[]): string[] {
  return events.map((event) => event.type)
}

function only<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Array<Extract<RunEvent, { type: T }>> {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run journal emission', () => {
  it('records a tool-using runTasks run as one linked event stream', async () => {
    const journal = new InMemoryRunJournal()
    const store = new InMemoryStore()
    const team = new Team({
      name: 'team',
      agents: [worker('worker', sequencedAdapter([
        toolResponse('tu-1', 'echo', { value: 'hi' }),
        textResponse('all done'),
      ]), { customTools: [echoTool], tools: ['echo'] })],
      sharedMemoryStore: store,
    })
    const tasks: RunTaskSpec[] = [{ title: 'only', description: 'do it', assignee: 'worker' }]

    const result = await new OpenMultiAgent().runTasks(team, tasks, { journal })
    expect(result.success).toBe(true)

    const events = await journal.readFrom(0)
    expect(types(events)).toEqual([
      'run/start',
      'plan/set',
      'task/status',
      'user/message',
      'turn/start',
      'llm/request',
      'assistant/message',
      'tool/call',
      'tool/result',
      'user/message',
      'turn/end',
      'turn/start',
      'llm/request',
      'assistant/message',
      'turn/end',
      'memory/set',
      'task/status',
      'run/end',
    ])

    const byType = new Map(events.map((event) => [`${event.type}:${event.seq}`, event]))
    expect(byType.size).toBe(events.length)

    const [taskId] = only(events, 'plan/set')[0]!.tasks.map((task) => task.taskId)
    expect(only(events, 'run/start')[0]).toMatchObject({ mode: 'runTasks' })
    expect(only(events, 'task/status').map((event) => event.status))
      .toEqual(['in_progress', 'completed'])
    expect(only(events, 'run/end')[0]!.status).toEqual({ code: 'ok' })
    expect(only(events, 'memory/set')[0]).toMatchObject({
      agent: 'worker',
      key: `task:${taskId}:result`,
    })

    // Lineage links: assistant → its request, tool/call → that assistant
    // message, tool/result → its call, tool-result user message → the results.
    const request = only(events, 'llm/request')[0]!
    const assistant = only(events, 'assistant/message')[0]!
    const call = only(events, 'tool/call')[0]!
    const toolResult = only(events, 'tool/result')[0]!
    const resultMessage = only(events, 'user/message')
      .find((event) => event.origin === 'tool_results')!
    expect(assistant.sourceEventSeqs).toEqual([request.seq])
    expect(call.sourceEventSeqs).toEqual([assistant.seq])
    expect(toolResult.sourceEventSeqs).toEqual([call.seq])
    expect(toolResult.toolCallId).toBe('tu-1')
    expect(resultMessage.sourceEventSeqs).toEqual([toolResult.seq])

    // Every runner event is scoped to the task and the agent that produced it.
    for (const event of events.filter((candidate) => candidate.type === 'llm/request')) {
      expect(event).toMatchObject({ taskId, agentName: 'worker' })
    }
  })

  it('assigns strictly increasing sequences starting at 1', async () => {
    const journal = new InMemoryRunJournal()
    const team = new Team({
      name: 'team',
      agents: [worker('a', sequencedAdapter([textResponse('a done')])),
        worker('b', sequencedAdapter([textResponse('b done')]))],
      sharedMemory: true,
    })
    await new OpenMultiAgent().runTasks(team, [
      { title: 'first', description: 'one', assignee: 'a' },
      { title: 'second', description: 'two', assignee: 'b' },
    ], { journal })

    const seqs = (await journal.readFrom(0)).map((event) => event.seq)
    expect(seqs[0]).toBe(1)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
    }
  })

  it('records checkpoint saves with the recorder watermark', async () => {
    const journal = new InMemoryRunJournal()
    const store = new InMemoryStore()
    const team = new Team({
      name: 'team',
      agents: [worker('worker', sequencedAdapter([textResponse('done')]))],
      sharedMemoryStore: store,
    })
    await new OpenMultiAgent().runTasks(
      team,
      [{ title: 'only', description: 'do it', assignee: 'worker' }],
      { journal, checkpoint: { store } },
    )

    const events = await journal.readFrom(0)
    const saves = only(events, 'checkpoint/saved')
    expect(saves.length).toBeGreaterThan(0)
    for (const save of saves) {
      // A journaled run writes v5, which is the schema carrying the watermark.
      expect(save).toMatchObject({ mode: 'runTasks', version: 5 })
      // The watermark names the last event the snapshot folds, which is the
      // event before this one — the save record itself is not folded into it.
      expect(save.watermarkSeq).toBe(save.seq - 1)
    }
  })

  it('covers a standalone runAgent run', async () => {
    const journal = new InMemoryRunJournal()
    const orchestrator = new OpenMultiAgent()
    const result = await orchestrator.runAgent(
      worker('solo', sequencedAdapter([textResponse('answered')])),
      'a question',
      { journal },
    )
    expect(result.success).toBe(true)

    const events = await journal.readFrom(0)
    expect(types(events)).toEqual([
      'run/start',
      'user/message',
      'turn/start',
      'llm/request',
      'assistant/message',
      'turn/end',
      'run/end',
    ])
    expect(only(events, 'run/start')[0]).toMatchObject({ mode: 'runAgent' })
    expect(only(events, 'turn/end')[0]).toMatchObject({ turn: 1, outcome: 'completed' })
    expect(only(events, 'assistant/message')[0]).toMatchObject({
      origin: 'response',
      model: 'mock-model',
      stopReason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 5 },
    })
    // No task scoping outside an orchestrated task.
    expect(only(events, 'llm/request')[0]!.taskId).toBeUndefined()
  })

  it('records a failed run with the failing status and closes the open turn', async () => {
    const journal = new InMemoryRunJournal()
    const result = await new OpenMultiAgent().runAgent(
      worker('solo', throwingAdapter('provider exploded')),
      'a question',
      { journal },
    )
    expect(result.success).toBe(false)

    const events = await journal.readFrom(0)
    expect(only(events, 'turn/end')[0]).toMatchObject({ turn: 1, outcome: 'error' })
    const end = only(events, 'run/end')[0]!
    expect(end.status.code).not.toBe('ok')
    expect(end.error?.message).toContain('provider exploded')
  })

  it('records cascaded task failures the dispatch loop never sees', async () => {
    const journal = new InMemoryRunJournal()
    const team = new Team({
      name: 'team',
      agents: [worker('worker', throwingAdapter('boom'), { maxRetries: 0 })],
      sharedMemory: true,
    })
    await new OpenMultiAgent().runTasks(team, [
      { title: 'first', description: 'one', assignee: 'worker', maxRetries: 0 },
      { title: 'second', description: 'two', assignee: 'worker', dependsOn: ['first'], maxRetries: 0 },
    ], { journal })

    const events = await journal.readFrom(0)
    const statuses = only(events, 'task/status')
    // The cascaded dependent never dispatches, so only the queue can report it.
    expect(statuses.filter((event) => event.status === 'failed')).toHaveLength(2)
    expect(statuses.filter((event) => event.status === 'in_progress')).toHaveLength(1)
    for (const failure of statuses.filter((event) => event.status === 'failed')) {
      expect(typeof failure.reason).toBe('string')
    }
  })

  it('journals delegated child conversations under their own agent name', async () => {
    const journal = new InMemoryRunJournal()
    const team = new Team({
      name: 'team',
      agents: [
        worker('lead', sequencedAdapter([
          toolResponse('tu-d', 'delegate_to_agent', {
            target_agent: 'helper',
            prompt: 'do the sub-task',
          }),
          textResponse('lead done'),
        ]), { tools: ['delegate_to_agent'] }),
        worker('helper', sequencedAdapter([textResponse('helper done')])),
      ],
      sharedMemory: true,
    })
    await new OpenMultiAgent().runTasks(
      team,
      [{ title: 'only', description: 'delegate', assignee: 'lead' }],
      { journal },
    )

    const events = await journal.readFrom(0)
    const agents = new Set(only(events, 'llm/request').map((event) => event.agentName))
    expect(agents).toEqual(new Set(['lead', 'helper']))
    // Both conversations share one ordered stream and one task scope.
    const taskIds = new Set(only(events, 'llm/request').map((event) => event.taskId))
    expect(taskIds.size).toBe(1)
  })

  it('records the coordinator plan and its own conversation in runTeam', async () => {
    const journal = new InMemoryRunJournal()
    const plan = JSON.stringify([
      { title: 'step', description: 'do the step', assignee: 'worker' },
    ])
    const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = new Team({
      name: 'team',
      agents: [worker('worker', sequencedAdapter([textResponse('step done')]))],
      sharedMemory: true,
    })

    const result = await orchestrator.runTeam(team, 'ship the thing', {
      mode: 'team',
      journal,
      coordinator: {
        model: 'mock-model',
        adapter: sequencedAdapter([textResponse(plan), textResponse('synthesised')]),
      },
    })
    expect(result.success).toBe(true)

    const events = await journal.readFrom(0)
    expect(only(events, 'run/start')[0]).toMatchObject({
      mode: 'runTeam',
      goal: 'ship the thing',
    })
    const planSet = only(events, 'plan/set')
    expect(planSet).toHaveLength(1)
    expect(planSet[0]).toMatchObject({ source: 'initial', revision: 0 })
    expect(planSet[0]!.tasks[0]).toMatchObject({ assignee: 'worker' })
    // The coordinator's decomposition precedes the plan it produced.
    const coordinatorRequests = only(events, 'llm/request')
      .filter((event) => event.agentName === 'coordinator')
    expect(coordinatorRequests.length).toBeGreaterThanOrEqual(1)
    expect(coordinatorRequests[0]!.seq).toBeLessThan(planSet[0]!.seq)
  })

  it('emits nothing when the journal is disabled for one run', async () => {
    const journal = new InMemoryRunJournal()
    const team = new Team({
      name: 'team',
      agents: [worker('worker', sequencedAdapter([textResponse('done')]))],
      sharedMemory: true,
    })
    const orchestrator = new OpenMultiAgent({ journal })

    await orchestrator.runTasks(
      team,
      [{ title: 'only', description: 'do it', assignee: 'worker' }],
      { journal: false },
    )
    expect(journal.size).toBe(0)

    // The same orchestrator default still journals a run that does not opt out.
    await orchestrator.runTasks(
      team,
      [{ title: 'only', description: 'do it', assignee: 'worker' }],
    )
    expect(journal.size).toBeGreaterThan(0)
  })

  it('records the request config digests without the config itself', async () => {
    const journal = new InMemoryRunJournal()
    await new OpenMultiAgent().runAgent(
      worker('solo', sequencedAdapter([textResponse('done')]), {
        systemPrompt: 'You are terse.',
        customTools: [echoTool],
        tools: ['echo'],
      }),
      'hello',
      { journal },
    )

    const request = only(await journal.readFrom(0), 'llm/request')[0]!
    expect(request.systemPromptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(request.toolsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(request)).not.toContain('You are terse.')
  })
})
