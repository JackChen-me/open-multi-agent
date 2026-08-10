import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { AgentRunner } from '../src/agent/runner.js'
import { Checkpoint, CHECKPOINT_KEY_PREFIX, isCheckpointKey } from '../src/memory/checkpoint.js'
import { defineTool, ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { InMemoryStore } from '../src/memory/store.js'
import { RedactingStore } from '../src/memory/redacting-store.js'
import { SharedMemory } from '../src/memory/shared.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { TaskQueue } from '../src/task/queue.js'
import { createTask } from '../src/task/task.js'
import { Team } from '../src/team/team.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  InFlightTaskCheckpoint,
  MemoryEntry,
  MemoryStore,
  OrchestratorEvent,
  RunTaskSpec,
} from '../src/types.js'

function textResponse(text: string, model: string): LLMResponse {
  return {
    id: `resp-${text}`,
    content: [{ type: 'text', text }],
    model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function scriptedAdapter(outputs: string[]) {
  const prompts: string[] = []
  let callCount = 0
  const adapter: LLMAdapter = {
    name: 'checkpoint-test',
    async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
      const prompt = [...messages].reverse()
        .find((message) => message.role === 'user')
        ?.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n') ?? ''
      prompts.push(prompt)
      const output = outputs[callCount] ?? `output-${callCount}`
      callCount++
      return textResponse(output, options.model)
    },
    async *stream() {
      yield { type: 'done' as const, data: textResponse('stream-unused', 'mock-model') }
    },
  }

  return {
    adapter,
    prompts,
    calls: () => callCount,
  }
}

function worker(name: string, adapter: LLMAdapter): AgentConfig {
  return { name, model: 'mock-model', adapter, systemPrompt: `You are ${name}.` }
}

function task(id: string, opts: { dependsOn?: string[]; assignee?: string } = {}) {
  const created = createTask({ title: id, description: `task ${id}`, assignee: opts.assignee })
  return { ...created, id, dependsOn: opts.dependsOn } as ReturnType<typeof createTask>
}

class AsyncMapStore implements MemoryStore {
  readonly data = new Map<string, MemoryEntry>()

  async get(key: string): Promise<MemoryEntry | null> {
    return this.data.get(key) ?? null
  }

  async set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void> {
    const existing = this.data.get(key)
    this.data.set(key, {
      key,
      value,
      metadata,
      createdAt: existing?.createdAt ?? new Date(),
    })
  }

  async setWithExpiry(
    key: string,
    value: string,
    expiresAtTurn: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const existing = this.data.get(key)
    this.data.set(key, {
      key,
      value,
      metadata,
      createdAt: existing?.createdAt ?? new Date(),
      expiresAtTurn,
    })
  }

  async list(): Promise<MemoryEntry[]> {
    return Array.from(this.data.values())
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }

  async clear(): Promise<void> {
    this.data.clear()
  }
}

async function deleteNonCheckpointEntries(store: MemoryStore): Promise<void> {
  for (const entry of await store.list()) {
    if (!isCheckpointKey(entry.key)) {
      await store.delete(entry.key)
    }
  }
}

describe('checkpoint snapshots', () => {
  it('TaskQueue snapshot round-trips pending, in-progress, and completed partitions', () => {
    const queue = new TaskQueue()
    queue.add(task('a'))
    queue.add(task('b'))
    queue.add(task('c', { dependsOn: ['a'] }))
    queue.update('b', { status: 'in_progress' })
    queue.complete('a', 'done a')

    const snapshot = queue.snapshot()
    const restored = TaskQueue.fromSnapshot(snapshot)

    expect(restored.snapshot().pending).toEqual(snapshot.pending)
    expect(restored.snapshot().inProgress).toEqual(snapshot.inProgress)
    expect(restored.snapshot().completed).toEqual(snapshot.completed)
    expect(restored.get('a')?.result).toBe('done a')
  })

  it('TaskQueue restore can make in-progress work runnable again', () => {
    const queue = new TaskQueue()
    queue.add(task('a'))
    queue.update('a', { status: 'in_progress' })

    const restored = TaskQueue.fromSnapshot(queue.snapshot(), { resetInProgress: true })
    expect(restored.get('a')?.status).toBe('pending')
  })

  it('SharedMemory snapshot/restore preserves entries and turn count', async () => {
    const memory = new SharedMemory()
    await memory.write('agent', 'plain', 'value', { source: 'test' })
    await memory.write('agent', 'structured', { ok: true, count: 2 })
    await memory.writeExpiring('agent', 'ttl', 'short', 3)
    memory.advanceTurn()

    const snapshot = await memory.snapshot()
    const restored = await SharedMemory.fromSnapshot(snapshot)

    expect(restored.getTurnCount()).toBe(1)
    expect((await restored.read('agent/plain'))?.value).toBe('value')
    expect((await restored.read('agent/plain'))?.metadata).toMatchObject({ source: 'test' })
    expect((await restored.read('agent/structured'))?.value).toEqual({ ok: true, count: 2 })
    expect((await restored.read('agent/ttl'))?.value).toBe('short')
  })

  it('Checkpoint persists and loads snapshots through MemoryStore only', async () => {
    const store = new AsyncMapStore()
    const checkpoint = new Checkpoint(store, { runId: 'custom' })
    const queue = new TaskQueue()
    queue.add(task('a'))
    queue.complete('a', 'done')

    await checkpoint.save({
      version: 1,
      mode: 'runTasks',
      createdAt: new Date().toISOString(),
      runId: 'custom',
      queue: queue.snapshot(),
      completedTaskResults: [{ taskId: 'a', result: 'done' }],
    })

    expect((await store.list()).map((entry) => entry.key)).toEqual([
      `${CHECKPOINT_KEY_PREFIX}custom/latest`,
    ])
    expect((await checkpoint.loadLatest())?.queue.completed).toEqual(['a'])
  })

  it('rejects a v3 tool commit that does not match its pending call', async () => {
    const store = new InMemoryStore()
    const checkpoint = new Checkpoint(store)
    const queue = new TaskQueue()
    queue.add(task('a', { assignee: 'worker' }))
    queue.update('a', { status: 'in_progress' })

    await store.set(checkpoint.key, JSON.stringify({
      version: 3,
      mode: 'runTasks',
      createdAt: new Date().toISOString(),
      identity: {
        runId: 'run-1',
        attempt: 1,
        lastTraceId: 'trace-1',
        lastRootSpanId: 'span-1',
      },
      queue: queue.snapshot(),
      completedTaskResults: [],
      inFlightTasks: [{
        taskId: 'a',
        assignee: 'worker',
        phase: 'executing_tools',
        conversationMessages: [],
        messages: [],
        tokenUsage: { input_tokens: 1, output_tokens: 1 },
        toolCalls: [],
        turns: 1,
        pendingToolCalls: [{
          call: { type: 'tool_use', id: 'call-1', name: 'echo', input: {} },
          commit: {
            result: {
              type: 'tool_result',
              tool_use_id: 'different-call',
              content: 'done',
            },
            record: { toolName: 'echo', input: {}, output: 'done', duration: 1 },
          },
        }],
      }],
    }))

    await expect(checkpoint.loadLatest()).rejects.toThrow('is not a checkpoint snapshot')
  })

  it('round-trips rich tool-result messages through task checkpoint restore', async () => {
    const store = new InMemoryStore()
    const queue = new TaskQueue()
    queue.add(task('first', { assignee: 'worker' }))
    queue.add(task('second', { assignee: 'worker', dependsOn: ['first'] }))
    queue.complete('first', 'first output')
    const richContent = [
      { type: 'text' as const, text: 'Rendered preview' },
      {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: 'image/png',
          data: 'aW1hZ2U=',
        },
      },
      {
        type: 'file' as const,
        filename: 'report.pdf',
        source: {
          type: 'url' as const,
          media_type: 'application/pdf',
          url: 'https://example.com/report.pdf',
        },
      },
    ]
    await new Checkpoint(store, {}).save({
      version: 1,
      mode: 'runTasks',
      createdAt: new Date().toISOString(),
      queue: queue.snapshot(),
      completedTaskResults: [{
        taskId: 'first',
        assignee: 'worker',
        result: 'first output',
        agentResult: {
          success: true,
          output: 'first output',
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call-1', name: 'render', input: {} }],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'call-1', content: richContent }],
            },
          ],
          tokenUsage: { input_tokens: 1, output_tokens: 1 },
          toolCalls: [{
            toolName: 'render',
            input: {},
            output: 'Rendered preview\n[image: image/png; inline data]\n[file: report.pdf; application/pdf; URL reference]',
            duration: 1,
          }],
        },
      }],
    })
    const pending = scriptedAdapter(['second output'])
    const team = new Team({ name: 'team', agents: [worker('worker', pending.adapter)] })

    const restored = await new OpenMultiAgent().restore(team, { checkpoint: { store } })

    expect(pending.calls()).toBe(1)
    const restoredResult = restored.taskResults?.get('first')
    expect(restoredResult?.messages[1]?.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: richContent,
    })
  })

  it('a RedactingStore-wrapped checkpoint masks secrets yet stays loadable', async () => {
    const inner = new AsyncMapStore()
    const checkpoint = new Checkpoint(new RedactingStore(inner), { runId: 'secret-run' })
    const queue = new TaskQueue()
    queue.add(task('a'))
    queue.complete('a', 'done')

    await checkpoint.save({
      version: 1,
      mode: 'runTasks',
      createdAt: new Date().toISOString(),
      runId: 'secret-run',
      queue: queue.snapshot(),
      sharedMemory: {
        version: 1,
        turnCount: 1,
        entries: [
          {
            key: 'alice/task:a:result',
            value: 'the api key is sk-abcdefghijklmnop',
            createdAt: new Date().toISOString(),
          },
        ],
      },
      completedTaskResults: [{ taskId: 'a', assignee: 'alice', result: 'password="hunter2"' }],
    })

    // Structurally valid after redaction: loadLatest parses + validates.
    const loaded = await checkpoint.loadLatest()
    expect(loaded).not.toBeNull()
    expect(loaded?.queue.completed).toEqual(['a'])

    // Secrets are masked in both persistence-bearing branches.
    expect(loaded?.completedTaskResults[0]?.result).toBe('password="[redacted]"')
    expect(loaded?.sharedMemory?.entries[0]?.value).toBe('the api key is [redacted]')

    // Raw backend never held the secret either.
    const rawValue = (await inner.get(`${CHECKPOINT_KEY_PREFIX}secret-run/latest`))?.value ?? ''
    expect(rawValue).not.toContain('sk-abcdefghijklmnop')
    expect(rawValue).not.toContain('hunter2')
  })

  it('one RedactingStore backing both shared memory and the checkpoint masks every sink', async () => {
    // The default reuse case: SharedMemory and Checkpoint share one wrapped store.
    const inner = new InMemoryStore()
    const store = new RedactingStore(inner)

    const mem = new SharedMemory(store)
    const secret = 'password="hunter2" and key sk-abcdefghijklmnop'
    await mem.write('alice', 'task:a:result', secret)

    const queue = new TaskQueue()
    queue.add(task('a', { assignee: 'alice' }))
    queue.complete('a', secret)

    const checkpoint = new Checkpoint(store, { runId: 'reuse' })
    await checkpoint.save({
      version: 1,
      mode: 'runTasks',
      createdAt: new Date().toISOString(),
      runId: 'reuse',
      queue: queue.snapshot(),
      turnCount: mem.getTurnCount(),
      completedTaskResults: [{ taskId: 'a', assignee: 'alice', result: secret }],
    })

    // Shared read and checkpoint reload are both masked and structurally intact.
    expect((await mem.read('alice/task:a:result'))?.value).not.toContain('hunter2')
    const loaded = await checkpoint.loadLatest()
    expect(loaded?.queue.completed).toEqual(['a'])
    expect(loaded?.completedTaskResults[0]?.result).toContain('[redacted]')
    expect(loaded?.completedTaskResults[0]?.result).not.toContain('hunter2')

    // No raw secret survives anywhere in the backend, under any key.
    const rawDump = JSON.stringify(await inner.list())
    expect(rawDump).not.toContain('hunter2')
    expect(rawDump).not.toContain('sk-abcdefghijklmnop')
  })
})

describe('OpenMultiAgent checkpoint/restore', () => {
  const tasks: RunTaskSpec[] = [
    { title: 'first', description: 'do first', assignee: 'worker' },
    { title: 'second', description: 'do second', assignee: 'worker', dependsOn: ['first'] },
  ]

  it('does not write checkpoint keys when checkpointing is not enabled', async () => {
    const store = new InMemoryStore()
    const scripted = scriptedAdapter(['done'])
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    const orchestrator = new OpenMultiAgent()

    await orchestrator.runTasks(team, [
      { title: 'only', description: 'do it', assignee: 'worker' },
    ])

    expect((await store.list()).some((entry) => isCheckpointKey(entry.key))).toBe(false)
  })

  it('restores after an aborted run, skips completed tasks, and rehydrates shared memory', async () => {
    // Separate checkpoint store: the embedded shared-memory snapshot is what
    // rehydrates `store` after it is wiped (simulating a non-durable shared
    // store across a restart). The reused-store path is covered separately.
    const store = new InMemoryStore()
    const checkpointStore = new InMemoryStore()
    const scripted = scriptedAdapter(['first output', 'second output'])
    const abort = new AbortController()
    const orchestrator = new OpenMultiAgent({
      onProgress(event) {
        if (event.type === 'task_complete') {
          abort.abort()
        }
      },
    })
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    await team.getSharedMemoryInstance()!.write('seed', 'note', { keep: true })

    await orchestrator.runTasks(team, tasks, {
      abortSignal: abort.signal,
      checkpoint: { store: checkpointStore },
    })
    expect(scripted.calls()).toBe(1)

    await deleteNonCheckpointEntries(store)

    const resumedTeam = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    const restored = await orchestrator.restore(resumedTeam, { checkpoint: { store: checkpointStore } })

    expect(scripted.calls()).toBe(2)
    expect(scripted.prompts[1]).toContain('first output')
    expect(restored.tasks?.map((record) => [record.title, record.status])).toEqual([
      ['first', 'completed'],
      ['second', 'completed'],
    ])
    expect((await resumedTeam.getSharedMemoryInstance()!.read('seed/note'))?.value).toEqual({ keep: true })
  })

  it('restores requirements and validates pending work against the resumed roster', async () => {
    const checkpointStore = new InMemoryStore()
    const scripted = scriptedAdapter(['first output', 'must not run'])
    const abort = new AbortController()
    const orchestrator = new OpenMultiAgent({
      onProgress(event) {
        if (event.type === 'task_complete') abort.abort()
      },
    })
    const initialTeam = new Team({
      name: 'team',
      agents: [{
        ...worker('worker', scripted.adapter),
        capabilities: ['typescript'],
      }],
    })
    const constrainedTasks: RunTaskSpec[] = [
      {
        title: 'first',
        description: 'do first',
        assignee: 'worker',
        requires: { requiredCapabilities: ['typescript'] },
      },
      {
        title: 'second',
        description: 'do second',
        assignee: 'worker',
        dependsOn: ['first'],
        requires: { requiredCapabilities: ['typescript'] },
      },
    ]

    await orchestrator.runTasks(initialTeam, constrainedTasks, {
      abortSignal: abort.signal,
      checkpoint: { store: checkpointStore },
    })
    expect(scripted.calls()).toBe(1)

    const resumedTeam = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
    })
    await expect(orchestrator.restore(resumedTeam, {
      checkpoint: { store: checkpointStore },
    })).rejects.toMatchObject({
      code: 'INVALID_TASK_REQUIREMENTS',
      issues: [
        expect.objectContaining({
          code: 'ASSIGNEE_REQUIREMENTS_MISMATCH',
          taskTitle: 'second',
        }),
      ],
    })
    expect(scripted.calls()).toBe(1)
  })

  it('restore against an empty store starts a fresh task run', async () => {
    const store = new InMemoryStore()
    const scripted = scriptedAdapter(['fresh output'])
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    const orchestrator = new OpenMultiAgent()

    const result = await orchestrator.restore(team, [
      { title: 'fresh', description: 'start fresh', assignee: 'worker' },
    ], { checkpoint: { store } })

    expect(scripted.calls()).toBe(1)
    expect(result.tasks?.[0]?.status).toBe('completed')
    expect((await store.list()).some((entry) => isCheckpointKey(entry.key))).toBe(true)
  })

  it('restore against an empty store preserves and validates task requirements', async () => {
    const store = new InMemoryStore()
    const scripted = scriptedAdapter(['must not run'])
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    const orchestrator = new OpenMultiAgent()

    await expect(orchestrator.restore(team, [{
      title: 'restricted',
      description: 'requires a missing capability',
      assignee: 'worker',
      requires: { requiredCapabilities: ['missing'] },
    }], { checkpoint: { store } })).rejects.toMatchObject({
      code: 'INVALID_TASK_REQUIREMENTS',
      issues: [
        expect.objectContaining({ code: 'ASSIGNEE_REQUIREMENTS_MISMATCH' }),
      ],
    })

    expect(scripted.calls()).toBe(0)
  })

  it('checkpoint/restore works with a custom async MemoryStore', async () => {
    const store = new AsyncMapStore()
    const scripted = scriptedAdapter(['first output', 'second output'])
    const abort = new AbortController()
    const orchestrator = new OpenMultiAgent({
      onProgress(event) {
        if (event.type === 'task_complete') abort.abort()
      },
    })
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })

    await orchestrator.runTasks(team, tasks, {
      abortSignal: abort.signal,
      checkpoint: { store },
    })

    const resumedTeam = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    const result = await orchestrator.restore(resumedTeam, { checkpoint: { store } })

    expect(result.tasks?.every((record) => record.status === 'completed')).toBe(true)
    expect(scripted.calls()).toBe(2)
  })

  it('restore after the final checkpoint is a no-op', async () => {
    const store = new InMemoryStore()
    const scripted = scriptedAdapter(['first output', 'second output'])
    const orchestrator = new OpenMultiAgent()
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })

    await orchestrator.runTasks(team, tasks, { checkpoint: { store } })
    expect(scripted.calls()).toBe(2)

    const resumedTeam = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    const result = await orchestrator.restore(resumedTeam, { checkpoint: { store } })

    expect(scripted.calls()).toBe(2)
    expect(result.tasks?.map((record) => record.status)).toEqual(['completed', 'completed'])
  })

  it('reused store omits the shared-memory snapshot but persists the turn counter', async () => {
    const store = new InMemoryStore()
    const scripted = scriptedAdapter(['first output', 'second output'])
    const abort = new AbortController()
    const orchestrator = new OpenMultiAgent({
      onProgress(event) {
        if (event.type === 'task_complete') abort.abort()
      },
    })
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    await team.getSharedMemoryInstance()!.writeExpiring('seed', 'ttl', 'short', 5)

    await orchestrator.runTasks(team, tasks, { abortSignal: abort.signal, checkpoint: { store } })

    // Checkpoint store === shared-memory store: the entries are already durable
    // in the store, so the snapshot omits them and records only the turn count.
    const persisted = await new Checkpoint(store, {}).loadLatest()
    expect(persisted?.sharedMemory).toBeUndefined()
    expect(persisted?.turnCount).toBe(1)

    // Resume restores the turn counter so TTL expiry continues correctly.
    const resumedTeam = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    await orchestrator.restore(resumedTeam, { checkpoint: { store } })
    expect(resumedTeam.getSharedMemoryInstance()!.getTurnCount()).toBe(2)
    expect((await resumedTeam.getSharedMemoryInstance()!.read('seed/ttl'))?.value).toBe('short')
  })

  it('separate checkpoint store still embeds the shared-memory snapshot', async () => {
    const sharedStore = new InMemoryStore()
    const checkpointStore = new InMemoryStore()
    const scripted = scriptedAdapter(['first output', 'second output'])
    const abort = new AbortController()
    const orchestrator = new OpenMultiAgent({
      onProgress(event) {
        if (event.type === 'task_complete') abort.abort()
      },
    })
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: sharedStore,
    })
    await team.getSharedMemoryInstance()!.write('seed', 'note', { keep: true })

    await orchestrator.runTasks(team, tasks, {
      abortSignal: abort.signal,
      checkpoint: { store: checkpointStore },
    })

    // Checkpoint store differs from the shared-memory store, so the snapshot must
    // embed the entries — the checkpoint store holds no other copy.
    const persisted = await new Checkpoint(checkpointStore, {}).loadLatest()
    expect(persisted?.sharedMemory?.entries.some((entry) => entry.key === 'seed/note')).toBe(true)
  })

  it('persists MessageBus messages and read state through checkpoint restore', async () => {
    const checkpointStore = new InMemoryStore()
    const scripted = scriptedAdapter(['only output'])
    const orchestrator = new OpenMultiAgent()
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
    })
    team.sendMessage('alice', 'worker', 'direct handoff')
    team.broadcast('alice', 'broadcast note')
    const [readMessage] = team.getUnreadMessages('worker')
    team.markMessagesRead('worker', [readMessage!.id])

    await orchestrator.runTasks(team, [
      { title: 'only', description: 'do it', assignee: 'worker' },
    ], { checkpoint: { store: checkpointStore } })

    const persisted = await new Checkpoint(checkpointStore, {}).loadLatest()
    expect(persisted?.messageBus?.messages.map((message) => message.content)).toEqual([
      'direct handoff',
      'broadcast note',
    ])

    const resumedTeam = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
    })
    await orchestrator.restore(resumedTeam, { checkpoint: { store: checkpointStore } })

    expect(resumedTeam.getMessages('worker').map((message) => message.content)).toEqual([
      'direct handoff',
      'broadcast note',
    ])
    expect(resumedTeam.getUnreadMessages('worker').map((message) => message.content)).toEqual([
      'broadcast note',
    ])
  })
})

/** A store whose writes always reject, to exercise best-effort checkpointing. */
class FailingSetStore implements MemoryStore {
  setCalls = 0

  async get(): Promise<MemoryEntry | null> {
    return null
  }

  async set(): Promise<void> {
    this.setCalls++
    throw new Error('checkpoint store offline')
  }

  async list(): Promise<MemoryEntry[]> {
    return []
  }

  async delete(): Promise<void> {}

  async clear(): Promise<void> {}
}

describe('checkpoint resilience and key safety', () => {
  const tasks: RunTaskSpec[] = [
    { title: 'first', description: 'do first', assignee: 'worker' },
    { title: 'second', description: 'do second', assignee: 'worker', dependsOn: ['first'] },
  ]

  it('keeps the run alive when checkpoint writes fail, surfacing them via onProgress', async () => {
    const store = new InMemoryStore()
    const checkpointStore = new FailingSetStore()
    const scripted = scriptedAdapter(['first output', 'second output'])
    const events: OrchestratorEvent[] = []
    const orchestrator = new OpenMultiAgent({
      onProgress(event) {
        events.push(event)
      },
    })
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })

    const result = await orchestrator.runTasks(team, tasks, {
      checkpoint: { store: checkpointStore },
    })

    // Both tasks ran to completion even though every checkpoint write rejected.
    expect(scripted.calls()).toBe(2)
    expect(result.tasks?.map((record) => record.status)).toEqual(['completed', 'completed'])
    expect(checkpointStore.setCalls).toBeGreaterThan(0)

    // The failure is reported through onProgress, not swallowed.
    const failures = events.filter(
      (event) =>
        event.type === 'error' &&
        (event.data as { kind?: string } | undefined)?.kind === 'checkpoint_save_failed',
    )
    expect(failures.length).toBeGreaterThan(0)
  })

  it('requires a runId or explicit store when the team has no shared-memory store', async () => {
    const scripted = scriptedAdapter(['only output'])
    const team = new Team({ name: 'team', agents: [worker('worker', scripted.adapter)] })
    const orchestrator = new OpenMultiAgent()

    await expect(
      orchestrator.runTasks(
        team,
        [{ title: 'only', description: 'do it', assignee: 'worker' }],
        { checkpoint: true },
      ),
    ).rejects.toThrow(/runId/)
    // Rejected before any agent work happened.
    expect(scripted.calls()).toBe(0)
  })

  it('accepts a runId without an explicit store and resumes from the fallback store', async () => {
    const scripted = scriptedAdapter(['first output', 'second output'])
    const abort = new AbortController()
    const orchestrator = new OpenMultiAgent({
      onProgress(event) {
        if (event.type === 'task_complete') abort.abort()
      },
    })
    const team = new Team({ name: 'team', agents: [worker('worker', scripted.adapter)] })

    await orchestrator.runTasks(team, tasks, {
      abortSignal: abort.signal,
      checkpoint: { runId: 'run-1' },
    })
    expect(scripted.calls()).toBe(1)

    // Same orchestrator instance, so the in-memory fallback store survives; the
    // runId-derived key lets the second run find the first run's checkpoint.
    const resumedTeam = new Team({ name: 'team', agents: [worker('worker', scripted.adapter)] })
    const result = await orchestrator.restore(resumedTeam, { checkpoint: { runId: 'run-1' } })

    expect(scripted.calls()).toBe(2)
    expect(result.tasks?.map((record) => record.status)).toEqual(['completed', 'completed'])
  })
})

describe('runTeam restore synthesis', () => {
  /** Persist a runTeam-mode checkpoint with `first` completed and `second` pending. */
  function saveRunTeamCheckpoint(store: MemoryStore, goal = 'achieve the goal') {
    const queue = new TaskQueue()
    queue.add(task('first', { assignee: 'worker' }))
    queue.add(task('second', { assignee: 'worker', dependsOn: ['first'] }))
    queue.complete('first', 'first output')
    return new Checkpoint(store, {}).save({
      version: 1,
      mode: 'runTeam',
      createdAt: new Date().toISOString(),
      goal,
      queue: queue.snapshot(),
      completedTaskResults: [{ taskId: 'first', assignee: 'worker', result: 'first output' }],
    })
  }

  it('re-runs the coordinator synthesis and returns the synthesized answer', async () => {
    const store = new InMemoryStore()
    const workerAdapter = scriptedAdapter(['second output'])
    const coordinator = scriptedAdapter(['SYNTHESIZED ANSWER'])
    const orchestrator = new OpenMultiAgent()
    const team = new Team({
      name: 'team',
      agents: [worker('worker', workerAdapter.adapter)],
      sharedMemoryStore: store,
    })
    await saveRunTeamCheckpoint(store)

    const restored = await orchestrator.restore(team, {
      checkpoint: { store },
      coordinator: { model: 'mock-model', adapter: coordinator.adapter },
    })

    expect(workerAdapter.calls()).toBe(1) // only the pending 'second' task ran
    expect(coordinator.calls()).toBe(1) // synthesis ran; restore does not re-decompose
    expect(restored.agentResults.get('coordinator')?.output).toBe('SYNTHESIZED ANSWER')
    expect(restored.tasks?.every((record) => record.status === 'completed')).toBe(true)
  })

  it('is best-effort when synthesis fails: raw outputs plus a synthesis_failed event', async () => {
    const store = new InMemoryStore()
    const workerAdapter = scriptedAdapter(['second output'])
    const throwingCoordinator: LLMAdapter = {
      name: 'throwing-coordinator',
      async chat() {
        throw new Error('synthesis boom')
      },
      async *stream() {
        yield { type: 'done' as const, data: textResponse('unused', 'mock-model') }
      },
    }
    const events: OrchestratorEvent[] = []
    const orchestrator = new OpenMultiAgent({ onProgress: (event) => events.push(event) })
    const team = new Team({
      name: 'team',
      agents: [worker('worker', workerAdapter.adapter)],
      sharedMemoryStore: store,
    })
    await saveRunTeamCheckpoint(store)

    const restored = await orchestrator.restore(team, {
      checkpoint: { store },
      coordinator: { model: 'mock-model', adapter: throwingCoordinator },
    })

    expect(restored.agentResults.has('coordinator')).toBe(false) // synthesis skipped
    expect(restored.tasks?.every((record) => record.status === 'completed')).toBe(true) // work preserved
    expect(
      events.some(
        (event) =>
          event.type === 'error' &&
          (event.data as { kind?: string } | undefined)?.kind === 'synthesis_failed',
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Mid-task recovery conformance (#312)
// ---------------------------------------------------------------------------
//
// End-to-end recovery cases from #312. The external commit log never
// deduplicates, so these tests prove which tool calls execute versus replay.

describe('mid-task recovery conformance (#312)', () => {
  const recoveryTasks: RunTaskSpec[] = [
    { title: 'first', description: 'do first', assignee: 'worker' },
    { title: 'second', description: 'do second', assignee: 'worker', dependsOn: ['first'] },
  ]

  let toolUseSeq = 0
  function toolUseResponse(name: string, input: Record<string, unknown>): LLMResponse {
    toolUseSeq += 1
    return {
      id: `resp-tool-${name}-${toolUseSeq}`,
      content: [{ type: 'tool_use', id: `tu-${name}-${toolUseSeq}`, name, input }],
      model: 'mock-model',
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  /** Serves `steps` one per chat call, across the initial run and the resume. */
  function sequencedAdapter(steps: LLMResponse[]) {
    let calls = 0
    const messageInputs: LLMMessage[][] = []
    const adapter: LLMAdapter = {
      name: 'recovery-fixture',
      async chat(messages): Promise<LLMResponse> {
        messageInputs.push(messages)
        const step = steps[Math.min(calls, steps.length - 1)]!
        calls += 1
        return step
      },
      async *stream() {
        yield { type: 'done' as const, data: textResponse('stream-unused', 'mock-model') }
      },
    }
    return { adapter, calls: () => calls, messageInputs: () => messageInputs }
  }

  /**
   * A tiny external system. Commits append and are never deduplicated, so the
   * commit log IS the idempotency verdict: each label should appear exactly
   * once in a correctly recovered world.
   */
  function externalWorld(onCommit?: (label: string, count: number) => void) {
    const commits: string[] = []
    const toolCallIds: Array<string | undefined> = []
    let crashBeforeNextCommit: (() => void) | null = null
    const tool = defineTool({
      name: 'commit_effect',
      description: 'Commit a labelled side effect to an external system.',
      inputSchema: z.object({ label: z.string() }),
      execute: async ({ label }, context) => {
        toolCallIds.push(context.toolCallId)
        if (crashBeforeNextCommit) {
          const crash = crashBeforeNextCommit
          crashBeforeNextCommit = null
          crash()
          // The process "died" before the effect committed: nothing appended.
          return { data: 'crashed before commit', isError: true }
        }
        commits.push(label)
        onCommit?.(label, commits.length)
        return { data: `committed:${label}`, isError: false }
      },
    })
    return {
      tool,
      commits,
      toolCallIds,
      crashBeforeNextCommit: (crash: () => void) => {
        crashBeforeNextCommit = crash
      },
    }
  }

  function toolWorker(name: string, adapter: LLMAdapter, tool: ReturnType<typeof externalWorld>['tool']): AgentConfig {
    return { ...worker(name, adapter), customTools: [tool] }
  }

  it('case 1 - clean resume: a completed task\'s committed effect replays as data, not by re-execution', async () => {
    const store = new InMemoryStore()
    const abort = new AbortController()
    const world = externalWorld()
    const scripted = sequencedAdapter([
      toolUseResponse('commit_effect', { label: 'A' }), // first: turn 1 commits A
      textResponse('first done', 'mock-model'), // first: turn 2 completes -> abort
      textResponse('second done', 'mock-model'), // second: runs only on resume
    ])
    const orchestrator = new OpenMultiAgent({
      onProgress(event) {
        if (event.type === 'task_complete') abort.abort()
      },
    })
    const team = new Team({
      name: 'team',
      agents: [toolWorker('worker', scripted.adapter, world.tool)],
      sharedMemoryStore: store,
    })

    await orchestrator.runTasks(team, recoveryTasks, {
      abortSignal: abort.signal,
      checkpoint: { store },
    })
    expect(world.commits).toEqual(['A'])

    const resumedTeam = new Team({
      name: 'team',
      agents: [toolWorker('worker', scripted.adapter, world.tool)],
      sharedMemoryStore: store,
    })
    const result = await orchestrator.restore(resumedTeam, { checkpoint: { store } })

    expect(result.tasks?.map((record) => [record.title, record.status])).toEqual([
      ['first', 'completed'],
      ['second', 'completed'],
    ])
    // Expected idempotency outcome: the effect committed by the completed task
    // is carried by the checkpoint as data; the external system never sees it
    // a second time.
    expect(world.commits).toEqual(['A'])
  })

  it('case 2 - committed effect: a finished tool call replays as data without re-execution', async () => {
    const store = new InMemoryStore()
    const abort = new AbortController()
    const world = externalWorld((label, count) => {
      // Crash immediately AFTER the commit lands, before the turn finishes.
      if (label === 'B' && count === 1) abort.abort()
    })
    const scripted = sequencedAdapter([
      textResponse('first done', 'mock-model'), // first completes -> checkpoint exists
      toolUseResponse('commit_effect', { label: 'B' }), // second: commits B, then "crash"
      textResponse('second done', 'mock-model'), // resume continues after the committed result
    ])
    const orchestrator = new OpenMultiAgent()
    const team = new Team({
      name: 'team',
      agents: [toolWorker('worker', scripted.adapter, world.tool)],
      sharedMemoryStore: store,
    })

    await orchestrator.runTasks(team, recoveryTasks, {
      abortSignal: abort.signal,
      checkpoint: { store },
    })
    expect(world.commits).toEqual(['B'])
    const persisted = await new Checkpoint(store).loadLatest()
    expect(persisted?.version).toBe(4)
    if (persisted?.version !== 4) throw new Error('expected checkpoint v4')
    expect(persisted.inFlightTasks).toHaveLength(1)
    expect(persisted.inFlightTasks[0]).toMatchObject({
      phase: 'awaiting_model',
      turns: 1,
      tokenUsage: { input_tokens: 1, output_tokens: 1 },
    })
    expect(JSON.stringify(persisted.inFlightTasks[0]?.conversationMessages))
      .toContain('committed:B')

    const resumedTeam = new Team({
      name: 'team',
      agents: [toolWorker('worker', scripted.adapter, world.tool)],
      sharedMemoryStore: store,
    })
    const result = await orchestrator.restore(resumedTeam, { checkpoint: { store } })

    expect(result.tasks?.every((record) => record.status === 'completed')).toBe(true)
    // The restored model input contains the committed result and starts at the
    // next turn. The external tool is not invoked a second time.
    expect(world.commits).toEqual(['B'])
    expect(world.toolCallIds).toHaveLength(1)
    expect(scripted.calls()).toBe(3)
    expect(JSON.stringify(scripted.messageInputs().at(-1))).toContain('committed:B')
    expect(result.tasks?.find(record => record.title === 'second')?.metrics?.tokenUsage)
      .toEqual({ input_tokens: 2, output_tokens: 2 })
  })

  it('case 3 - missing result: an in-flight call that never committed is safely re-run', async () => {
    const store = new InMemoryStore()
    const abort = new AbortController()
    const world = externalWorld()
    world.crashBeforeNextCommit(() => abort.abort())
    const scripted = sequencedAdapter([
      textResponse('first done', 'mock-model'), // first completes -> checkpoint exists
      toolUseResponse('commit_effect', { label: 'C' }), // second: "crash" before commit
      textResponse('second done', 'mock-model'), // resume runs missing call, then continues
    ])
    const orchestrator = new OpenMultiAgent()
    const team = new Team({
      name: 'team',
      agents: [toolWorker('worker', scripted.adapter, world.tool)],
      sharedMemoryStore: store,
    })

    await orchestrator.runTasks(team, recoveryTasks, {
      abortSignal: abort.signal,
      checkpoint: { store },
    })
    expect(world.commits).toEqual([])
    const persisted = await new Checkpoint(store).loadLatest()
    expect(persisted?.version).toBe(4)
    if (persisted?.version !== 4) throw new Error('expected checkpoint v4')
    expect(persisted.inFlightTasks[0]).toMatchObject({
      phase: 'executing_tools',
      turns: 1,
    })
    expect(persisted.inFlightTasks[0]?.pendingToolCalls).toHaveLength(1)
    expect(persisted.inFlightTasks[0]?.pendingToolCalls?.[0]?.commit).toBeUndefined()

    const resumedTeam = new Team({
      name: 'team',
      agents: [toolWorker('worker', scripted.adapter, world.tool)],
      sharedMemoryStore: store,
    })
    const result = await orchestrator.restore(resumedTeam, { checkpoint: { store } })

    expect(result.tasks?.every((record) => record.status === 'completed')).toBe(true)
    // Expected idempotency outcome: nothing committed before the crash, so the
    // conservative re-run is exactly correct - one commit, no loss. This
    // expectation should SURVIVE #312 unchanged: a call with no commit record
    // must still re-run.
    expect(world.commits).toEqual(['C'])
    expect(world.toolCallIds).toHaveLength(2)
    expect(world.toolCallIds[0]).toBe(world.toolCallIds[1])
    expect(scripted.calls()).toBe(3)
  })

  it('commits a returned tool result before invoking a fallible result callback', async () => {
    const world = externalWorld()
    const scripted = sequencedAdapter([
      toolUseResponse('commit_effect', { label: 'callback' }),
      textResponse('done after restore', 'mock-model'),
    ])
    const registry = new ToolRegistry()
    registry.register(world.tool)
    const executor = new ToolExecutor(registry)
    const makeRunner = () => new AgentRunner(scripted.adapter, registry, executor, {
      model: 'mock-model',
      agentName: 'worker',
      allowedTools: ['commit_effect'],
    })
    const initialMessages: LLMMessage[] = [{
      role: 'user',
      content: [{ type: 'text', text: 'do callback task' }],
    }]
    let runnerState: InFlightTaskCheckpoint | undefined
    const checkpointOptions = {
      taskId: 'callback-task',
      traceAgent: 'worker',
      onCheckpoint: (state: InFlightTaskCheckpoint) => {
        runnerState = state
      },
    }

    await expect(makeRunner().run(initialMessages, {
      ...checkpointOptions,
      onToolResult: () => {
        throw new Error('result callback failed')
      },
    })).rejects.toThrow('result callback failed')

    expect(world.commits).toEqual(['callback'])
    expect(runnerState?.phase).toBe('executing_tools')
    expect(runnerState?.pendingToolCalls?.[0]?.commit?.result.content)
      .toBe('committed:callback')
    if (!runnerState) throw new Error('expected a committed runner checkpoint')

    const replayedResultCallback = vi.fn()
    const resumed = await makeRunner().run(initialMessages, {
      ...checkpointOptions,
      resumeState: runnerState,
      onToolResult: replayedResultCallback,
    })

    expect(resumed.output).toBe('done after restore')
    expect(world.commits).toEqual(['callback'])
    expect(replayedResultCallback).not.toHaveBeenCalled()
    expect(scripted.calls()).toBe(2)
  })

  it('commits parallel tool calls independently and resumes only the missing call', async () => {
    const store = new InMemoryStore()
    const abort = new AbortController()
    const commits: string[] = []
    const tool = defineTool({
      name: 'commit_effect',
      description: 'Commit a labelled side effect to an external system.',
      inputSchema: z.object({ label: z.string() }),
      execute: async ({ label }) => {
        commits.push(label)
        if (label === 'P' && commits.length === 1) abort.abort()
        return { data: `committed:${label}`, isError: false }
      },
    })
    const parallelToolTurn: LLMResponse = {
      id: 'resp-parallel-tools',
      content: [
        { type: 'tool_use', id: 'tu-parallel-p', name: 'commit_effect', input: { label: 'P' } },
        { type: 'tool_use', id: 'tu-parallel-q', name: 'commit_effect', input: { label: 'Q' } },
      ],
      model: 'mock-model',
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    const scripted = sequencedAdapter([
      textResponse('first done', 'mock-model'),
      parallelToolTurn,
      textResponse('second done', 'mock-model'),
    ])
    const orchestrator = new OpenMultiAgent()
    const team = new Team({
      name: 'team',
      agents: [toolWorker('worker', scripted.adapter, tool)],
      sharedMemoryStore: store,
    })

    await orchestrator.runTasks(team, recoveryTasks, {
      abortSignal: abort.signal,
      checkpoint: { store },
    })
    expect(commits).toEqual(['P'])

    const persisted = await new Checkpoint(store).loadLatest()
    expect(persisted?.version).toBe(4)
    if (persisted?.version !== 4) throw new Error('expected checkpoint v4')
    const pending = persisted.inFlightTasks[0]?.pendingToolCalls
    expect(pending?.map(call => [call.call.id, call.commit?.result.content])).toEqual([
      ['tu-parallel-p', 'committed:P'],
      ['tu-parallel-q', undefined],
    ])

    const resumedTeam = new Team({
      name: 'team',
      agents: [toolWorker('worker', scripted.adapter, tool)],
      sharedMemoryStore: store,
    })
    const result = await orchestrator.restore(resumedTeam, { checkpoint: { store } })

    expect(result.tasks?.every(record => record.status === 'completed')).toBe(true)
    expect(commits).toEqual(['P', 'Q'])
    expect(scripted.calls()).toBe(3)
    expect(JSON.stringify(scripted.messageInputs().at(-1))).toContain('committed:P')
    expect(JSON.stringify(scripted.messageInputs().at(-1))).toContain('committed:Q')
  })

  it('case 4 - duplicate replay: restoring a final checkpoint twice performs no new work', async () => {
    const store = new InMemoryStore()
    const world = externalWorld()
    const scripted = sequencedAdapter([
      textResponse('first done', 'mock-model'),
      toolUseResponse('commit_effect', { label: 'D' }),
      textResponse('second done', 'mock-model'),
    ])
    const orchestrator = new OpenMultiAgent()
    const team = new Team({
      name: 'team',
      agents: [toolWorker('worker', scripted.adapter, world.tool)],
      sharedMemoryStore: store,
    })

    await orchestrator.runTasks(team, recoveryTasks, { checkpoint: { store } })
    const callsAfterRun = scripted.calls()
    expect(world.commits).toEqual(['D'])

    for (let replay = 0; replay < 2; replay += 1) {
      const resumedTeam = new Team({
        name: 'team',
        agents: [toolWorker('worker', scripted.adapter, world.tool)],
        sharedMemoryStore: store,
      })
      const result = await orchestrator.restore(resumedTeam, { checkpoint: { store } })
      expect(result.tasks?.every((record) => record.status === 'completed')).toBe(true)
    }

    // Expected idempotency outcome: replaying a final checkpoint is a pure
    // read. No model calls, no tool executions, no new commits - however many
    // times it happens.
    expect(scripted.calls()).toBe(callsAfterRun)
    expect(world.commits).toEqual(['D'])
  })

  it('persists the in-flight turn, tool commit, and queue boundary in checkpoint v4', async () => {
    const store = new InMemoryStore()
    const abort = new AbortController()
    const world = externalWorld((label, count) => {
      if (label === 'B' && count === 1) abort.abort()
    })
    const scripted = sequencedAdapter([
      textResponse('first done', 'mock-model'),
      toolUseResponse('commit_effect', { label: 'B' }),
    ])
    const orchestrator = new OpenMultiAgent()
    const team = new Team({
      name: 'team',
      agents: [toolWorker('worker', scripted.adapter, world.tool)],
      sharedMemoryStore: store,
    })
    await orchestrator.runTasks(team, recoveryTasks, {
      abortSignal: abort.signal,
      checkpoint: { store },
    })
    expect(world.commits).toEqual(['B'])

    // Checkpoint v3 keeps both the completed task and the safe in-flight runner
    // boundary, including the committed tool result that must be replayed.
    const persisted = await new Checkpoint(store, {}).loadLatest()
    expect(persisted).not.toBeNull()
    expect(persisted?.version).toBe(4)
    if (persisted?.version !== 4) throw new Error('expected checkpoint v4')
    const snapshotJson = JSON.stringify(persisted)
    expect(snapshotJson).toContain('first done') // preserved: completed result
    expect(snapshotJson).toContain('committed:B') // preserved: per-call commit
    expect(persisted.inFlightTasks).toHaveLength(1)
    const inFlight = persisted.inFlightTasks[0]!
    expect(inFlight).toMatchObject({
      assignee: 'worker',
      phase: 'awaiting_model',
      turns: 1,
    })
    expect(persisted.queue.inProgress).toContain(inFlight.taskId)
    expect(persisted.queue.completed).not.toContain(inFlight.taskId)
  })
})
