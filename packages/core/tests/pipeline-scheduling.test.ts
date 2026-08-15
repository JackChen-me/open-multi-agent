import { describe, expect, it, vi } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { buildExecutionReceipt } from '../src/observability/execution-receipt.js'
import { Checkpoint } from '../src/memory/checkpoint.js'
import { InMemoryStore } from '../src/memory/store.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  OrchestratorEvent,
  Task,
  TeamRunResult,
  TraceEvent,
  TokenUsage,
} from '../src/types.js'

type TaskTitle = 'A' | 'B' | 'C'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

interface TimelineEntry {
  readonly type: OrchestratorEvent['type'] | 'approval'
  readonly taskId?: string
  readonly title?: string
  readonly agent?: string
  readonly data?: unknown
}

interface HarnessOptions {
  readonly maxConcurrency?: number
  readonly maxTokenBudget?: number
  readonly abortSignal?: AbortSignal
  readonly cAssignee?: string | null
  readonly usageByTask?: Partial<Record<TaskTitle, TokenUsage>>
  readonly onApproval?: (
    completedTasks: readonly Task[],
    nextTasks: readonly Task[],
  ) => Promise<boolean>
  readonly onTaskDispatch?: (task: Readonly<Task>) => boolean | Promise<boolean>
  readonly onTrace?: (event: TraceEvent) => void
  readonly checkpointStore?: InMemoryStore
}

const MAX_CONCURRENCY = 2
const TASK_TITLES: readonly TaskTitle[] = ['A', 'B', 'C']
const DEFAULT_USAGE: TokenUsage = { input_tokens: 1, output_tokens: 1 }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

function taskTitleFromMessages(messages: LLMMessage[]): TaskTitle {
  const prompt = [...messages]
    .reverse()
    .find((message) => message.role === 'user')
    ?.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n') ?? ''
  const title = prompt.match(/^# Task: (.+)$/m)?.[1]
  if (!TASK_TITLES.includes(title as TaskTitle)) {
    throw new Error(`Unexpected task prompt: ${prompt}`)
  }
  return title as TaskTitle
}

/**
 * Reusable adapter for DAG scheduling tests. Each task announces when its model
 * call starts and remains in flight until the test releases its deferred gate.
 */
class DeferredTaskAdapter implements LLMAdapter {
  readonly name = 'pipeline-scheduling-test'

  private readonly starts = new Map<TaskTitle, Deferred<void>>()
  private readonly releases = new Map<TaskTitle, Deferred<void>>()
  private readonly usageByTask: Partial<Record<TaskTitle, TokenUsage>>

  constructor(usageByTask: Partial<Record<TaskTitle, TokenUsage>> = {}) {
    this.usageByTask = usageByTask
    for (const title of TASK_TITLES) {
      this.starts.set(title, deferred<void>())
      this.releases.set(title, deferred<void>())
    }
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const title = taskTitleFromMessages(messages)
    this.starts.get(title)!.resolve(undefined)
    await this.releases.get(title)!.promise

    return {
      id: `response-${title}`,
      content: [{ type: 'text', text: `completed ${title}` }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: this.usageByTask[title] ?? DEFAULT_USAGE,
    }
  }

  async *stream() {
    yield { type: 'done' as const, data: {} }
  }

  waitForStart(title: TaskTitle): Promise<void> {
    return this.starts.get(title)!.promise
  }

  release(title: TaskTitle): void {
    this.releases.get(title)!.resolve(undefined)
  }
}

/**
 * Reusable progress collector that resolves event waiters without polling and
 * derives task-level in-flight concurrency from start/terminal event pairs.
 */
class SchedulingEventCollector {
  readonly timeline: TimelineEntry[] = []

  private readonly titlesByTaskId = new Map<string, string>()
  private readonly waiters = new Map<string, Array<Deferred<void>>>()

  readonly onProgress = (event: OrchestratorEvent): void => {
    const dataTitle = this.titleFromData(event.data)
    if (event.task && dataTitle) {
      this.titlesByTaskId.set(event.task, dataTitle)
    }
    const title = dataTitle ?? (event.task ? this.titlesByTaskId.get(event.task) : undefined)
    this.timeline.push({
      type: event.type,
      ...(event.task ? { taskId: event.task } : {}),
      ...(title ? { title } : {}),
      ...(event.agent ? { agent: event.agent } : {}),
      ...(event.data !== undefined ? { data: event.data } : {}),
    })
    if (title) this.resolveWaiters(event.type, title)
  }

  markApproval(): void {
    this.timeline.push({ type: 'approval' })
    this.resolveWaiters('approval')
  }

  waitFor(type: TimelineEntry['type'], title?: string): Promise<void> {
    if (this.indexOf(type, title) !== -1) return Promise.resolve()
    const key = this.waiterKey(type, title)
    const waiter = deferred<void>()
    const pending = this.waiters.get(key) ?? []
    pending.push(waiter)
    this.waiters.set(key, pending)
    return waiter.promise
  }

  has(type: TimelineEntry['type'], title?: string): boolean {
    return this.indexOf(type, title) !== -1
  }

  indexOf(type: TimelineEntry['type'], title?: string): number {
    return this.timeline.findIndex((entry) =>
      entry.type === type && (title === undefined || entry.title === title),
    )
  }

  get maxInFlight(): number {
    const inFlight = new Set<string>()
    let peak = 0

    for (const entry of this.timeline) {
      if (entry.type === 'task_start' && entry.taskId) {
        inFlight.add(entry.taskId)
        peak = Math.max(peak, inFlight.size)
      }
      if (
        entry.taskId
        && (
          entry.type === 'task_complete'
          || entry.type === 'task_skipped'
          || entry.type === 'error'
        )
      ) {
        inFlight.delete(entry.taskId)
      }
    }

    return peak
  }

  private titleFromData(data: unknown): string | undefined {
    if (data === null || typeof data !== 'object' || !('title' in data)) return undefined
    const title = (data as { title?: unknown }).title
    return typeof title === 'string' ? title : undefined
  }

  private resolveWaiters(type: TimelineEntry['type'], title?: string): void {
    const key = this.waiterKey(type, title)
    for (const waiter of this.waiters.get(key) ?? []) {
      waiter.resolve(undefined)
    }
    this.waiters.delete(key)
  }

  private waiterKey(type: TimelineEntry['type'], title?: string): string {
    return `${type}:${title ?? ''}`
  }
}

function createSchedulingHarness(options: HarnessOptions = {}) {
  const adapter = new DeferredTaskAdapter(options.usageByTask)
  const events = new SchedulingEventCollector()
  const orchestrator = new OpenMultiAgent({
    defaultModel: 'mock-model',
    maxConcurrency: options.maxConcurrency ?? MAX_CONCURRENCY,
    schedulingStrategy: 'round-robin',
    ...(options.maxTokenBudget !== undefined
      ? { maxTokenBudget: options.maxTokenBudget }
      : {}),
    ...(options.onApproval
      ? {
          onApproval: async (completedTasks: readonly Task[], nextTasks: readonly Task[]) => {
            events.markApproval()
            return options.onApproval!(completedTasks, nextTasks)
          },
        }
      : {}),
    ...(options.onTaskDispatch
      ? { onTaskDispatch: options.onTaskDispatch }
      : {}),
    ...(options.onTrace ? { onTrace: options.onTrace } : {}),
    onProgress: events.onProgress,
  })
  const agents: AgentConfig[] = ['worker-a', 'worker-b', 'worker-c'].map((name) => ({
    name,
    model: 'mock-model',
    systemPrompt: `You are ${name}.`,
    adapter,
  }))
  const team = orchestrator.createTeam('pipeline-scheduling', {
    name: 'pipeline-scheduling',
    agents,
    sharedMemory: false,
  })
  const cAssignee = options.cAssignee === undefined ? 'worker-c' : options.cAssignee
  const tasks = [
    { title: 'A', description: 'Fast root task A.', assignee: 'worker-a' },
    { title: 'B', description: 'Slow root task B.', assignee: 'worker-b' },
    {
      title: 'C',
      description: 'Task C depends only on A.',
      ...(cAssignee === null ? {} : { assignee: cAssignee }),
      dependsOn: ['A'],
    },
  ]

  return {
    adapter,
    events,
    run: () => orchestrator.runTasks(
      team,
      tasks,
      {
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options.checkpointStore
          ? { checkpoint: { store: options.checkpointStore } }
          : {}),
      },
    ),
  }
}

async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) {
    await Promise.resolve()
  }
}

async function runFastABeforeSlowB(
  harness: ReturnType<typeof createSchedulingHarness>,
): Promise<TeamRunResult> {
  // C may be released before it starts; its eventual model call will complete immediately.
  harness.adapter.release('C')
  const resultPromise = harness.run()
  await Promise.all([
    harness.adapter.waitForStart('A'),
    harness.adapter.waitForStart('B'),
  ])

  harness.adapter.release('A')
  await harness.events.waitFor('task_complete', 'A')
  await drainMicrotasks()
  harness.adapter.release('B')

  return resultPromise
}

function taskStatus(result: TeamRunResult, title: TaskTitle) {
  return result.tasks?.find((task) => task.title === title)?.status
}

function expectNoUnsettledTasks(result: TeamRunResult): void {
  expect(result.tasks?.some((task) =>
    task.status === 'pending'
    || task.status === 'blocked'
    || task.status === 'in_progress',
  )).toBe(false)
}

describe('executeQueue scheduling contracts', () => {
  it('starts C after A completes without waiting for unrelated slow B', async () => {
    const harness = createSchedulingHarness()

    const result = await runFastABeforeSlowB(harness)

    expect(taskStatus(result, 'A')).toBe('completed')
    expect(taskStatus(result, 'B')).toBe('completed')
    expect(taskStatus(result, 'C')).toBe('completed')
    expect(harness.events.indexOf('task_complete', 'A')).toBeLessThan(
      harness.events.indexOf('task_start', 'C'),
    )
    expect(harness.events.indexOf('task_start', 'C')).toBeLessThan(
      harness.events.indexOf('task_complete', 'B'),
    )
  })

  it('calls onApproval between rounds with the completed batch and next tasks', async () => {
    const onApproval = vi.fn(async (
      _completedTasks: readonly Task[],
      _nextTasks: readonly Task[],
    ) => true)
    const harness = createSchedulingHarness({ onApproval })

    await runFastABeforeSlowB(harness)

    expect(onApproval).toHaveBeenCalledTimes(1)
    const [completedTasks, nextTasks] = onApproval.mock.calls[0]!
    expect(completedTasks.map((task) => task.title).sort()).toEqual(['A', 'B'])
    expect(nextTasks.map((task) => task.title)).toEqual(['C'])
    expect(harness.events.indexOf('approval')).toBeGreaterThan(
      harness.events.indexOf('task_complete', 'B'),
    )
    expect(harness.events.indexOf('approval')).toBeLessThan(
      harness.events.indexOf('task_start', 'C'),
    )
  })

  it('auto-assigns a newly-unblocked task before the next round is approved', async () => {
    const onApproval = vi.fn(async (
      _completedTasks: readonly Task[],
      _nextTasks: readonly Task[],
    ) => true)
    const harness = createSchedulingHarness({
      cAssignee: null,
      onApproval,
    })

    const result = await runFastABeforeSlowB(harness)

    const nextTask = onApproval.mock.calls[0]![1][0]
    const cStart = harness.events.timeline.find((entry) =>
      entry.type === 'task_start' && entry.title === 'C',
    )
    expect(nextTask?.title).toBe('C')
    expect(nextTask?.assignee).toBeDefined()
    expect(cStart?.agent).toBe(nextTask?.assignee)
    expect(result.tasks?.find((task) => task.title === 'C')?.assignee).toBe(nextTask?.assignee)
  })

  it('stops new dispatch on budget overage, drains in-flight B, then skips C', async () => {
    const harness = createSchedulingHarness({
      maxTokenBudget: 10,
      usageByTask: {
        A: { input_tokens: 6, output_tokens: 5 },
        B: { input_tokens: 1, output_tokens: 1 },
      },
    })

    const result = await runFastABeforeSlowB(harness)

    expect(result.status?.code).toBe('budget_exhausted')
    expect(taskStatus(result, 'A')).toBe('completed')
    expect(taskStatus(result, 'B')).toBe('completed')
    expect(taskStatus(result, 'C')).toBe('skipped')
    expect(harness.events.has('task_start', 'C')).toBe(false)
    expect(harness.events.has('budget_exceeded')).toBe(true)
    expect(harness.events.indexOf('budget_exceeded')).toBeLessThan(
      harness.events.indexOf('task_complete', 'B'),
    )
    expect(harness.events.indexOf('task_complete', 'B')).toBeLessThan(
      harness.events.indexOf('task_skipped', 'C'),
    )
  })

  it('drains an in-flight task after abort without leaving in_progress state', async () => {
    const controller = new AbortController()
    const harness = createSchedulingHarness({ abortSignal: controller.signal })
    harness.adapter.release('C')
    const resultPromise = harness.run()
    await Promise.all([
      harness.adapter.waitForStart('A'),
      harness.adapter.waitForStart('B'),
    ])

    harness.adapter.release('A')
    await harness.events.waitFor('task_complete', 'A')
    controller.abort()
    harness.adapter.release('B')
    const result = await resultPromise

    expect(result.status?.code).toBe('cancelled')
    expect(taskStatus(result, 'A')).toBe('completed')
    expect(taskStatus(result, 'B')).toBe('completed')
    expect(taskStatus(result, 'C')).toBe('skipped')
    expect(result.tasks?.some((task) => task.status === 'in_progress')).toBe(false)
    expect(result.tasks?.some((task) =>
      task.status === 'pending' || task.status === 'blocked',
    )).toBe(false)
    expect(harness.events.indexOf('task_complete', 'B')).toBeLessThan(
      harness.events.indexOf('task_skipped', 'C'),
    )
  })
})

describe('pipeline interruption matrix', () => {
  it('handles abort with no in-flight task', async () => {
    const controller = new AbortController()
    controller.abort()
    const harness = createSchedulingHarness({ abortSignal: controller.signal })

    const result = await harness.run()

    expect(result.status?.code).toBe('cancelled')
    expect(result.tasks?.map((task) => task.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
    ])
    expect(harness.events.has('task_start')).toBe(false)
    expectNoUnsettledTasks(result)
  })

  it('handles budget exhaustion with no other in-flight task', async () => {
    const harness = createSchedulingHarness({
      maxConcurrency: 1,
      maxTokenBudget: 10,
      usageByTask: {
        A: { input_tokens: 6, output_tokens: 5 },
      },
    })
    const resultPromise = harness.run()
    await harness.adapter.waitForStart('A')
    harness.adapter.release('A')

    const result = await resultPromise

    expect(result.status?.code).toBe('budget_exhausted')
    expect(taskStatus(result, 'A')).toBe('completed')
    expect(taskStatus(result, 'B')).toBe('skipped')
    expect(taskStatus(result, 'C')).toBe('skipped')
    expect(harness.events.has('task_start', 'B')).toBe(false)
    expectNoUnsettledTasks(result)
  })

  it('handles per-task approval rejection with no in-flight task', async () => {
    const onTaskDispatch = vi.fn(() => false)
    const harness = createSchedulingHarness({
      onTaskDispatch,
      onTrace: () => {},
    })

    const result = await harness.run()

    expect(onTaskDispatch).toHaveBeenCalledTimes(1)
    expect(result.status?.code).toBe('rejected')
    expect(result.tasks?.map((task) => task.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
    ])
    expect(harness.events.has('task_start')).toBe(false)
    expectNoUnsettledTasks(result)
  })

  it('rechecks abort after an asynchronous per-task gate resolves', async () => {
    const controller = new AbortController()
    const gateEntered = deferred<void>()
    const gateDecision = deferred<boolean>()
    const harness = createSchedulingHarness({
      abortSignal: controller.signal,
      onTaskDispatch: async () => {
        gateEntered.resolve(undefined)
        return gateDecision.promise
      },
    })
    const resultPromise = harness.run()
    await gateEntered.promise

    controller.abort()
    gateDecision.resolve(false)
    const result = await resultPromise

    expect(result.status?.code).toBe('cancelled')
    expect(result.tasks?.map((task) => task.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
    ])
    expect(harness.events.has('task_start')).toBe(false)
    expectNoUnsettledTasks(result)
  })

  it('rechecks budget after an asynchronous per-task gate resolves', async () => {
    const gateEntered = deferred<void>()
    const gateDecision = deferred<boolean>()
    const harness = createSchedulingHarness({
      maxTokenBudget: 10,
      usageByTask: {
        A: { input_tokens: 6, output_tokens: 5 },
      },
      onTaskDispatch: (task) => {
        if (task.title !== 'B') return true
        gateEntered.resolve(undefined)
        return gateDecision.promise
      },
    })
    const resultPromise = harness.run()
    await Promise.all([
      harness.adapter.waitForStart('A'),
      gateEntered.promise,
    ])

    harness.adapter.release('A')
    await harness.events.waitFor('task_complete', 'A')
    gateDecision.resolve(false)
    const result = await resultPromise

    expect(result.status?.code).toBe('budget_exhausted')
    expect(taskStatus(result, 'A')).toBe('completed')
    expect(taskStatus(result, 'B')).toBe('skipped')
    expect(taskStatus(result, 'C')).toBe('skipped')
    expect(harness.events.has('task_start', 'B')).toBe(false)
    expectNoUnsettledTasks(result)
  })

  it('treats a per-task approval callback error as a drained callback failure', async () => {
    const harness = createSchedulingHarness({
      onTaskDispatch: () => {
        throw new Error('approval backend unavailable')
      },
      onTrace: () => {},
    })

    const result = await harness.run()

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({ kind: 'callback' })
    expectNoUnsettledTasks(result)
  })

  it('drains an in-flight task before applying per-task approval rejection', async () => {
    const onTaskDispatch = vi.fn((task: Readonly<Task>) => task.title !== 'B')
    const harness = createSchedulingHarness({ onTaskDispatch })
    const resultPromise = harness.run()
    await harness.adapter.waitForStart('A')

    expect(onTaskDispatch.mock.calls.map(([task]) => task.title)).toEqual(['A', 'B'])
    expect(harness.events.has('task_start', 'B')).toBe(false)
    harness.adapter.release('A')
    const result = await resultPromise

    expect(result.status?.code).toBe('rejected')
    expect(taskStatus(result, 'A')).toBe('completed')
    expect(taskStatus(result, 'B')).toBe('skipped')
    expect(taskStatus(result, 'C')).toBe('skipped')
    expect(harness.events.indexOf('task_complete', 'A')).toBeLessThan(
      harness.events.indexOf('task_skipped', 'B'),
    )
    expectNoUnsettledTasks(result)
  })

  it('rejects mutually exclusive round and per-task approval modes', () => {
    expect(() => new OpenMultiAgent({
      onApproval: async () => true,
      onTaskDispatch: async () => true,
    })).toThrow('onApproval and onTaskDispatch are mutually exclusive')
  })

  it('does not call the per-task gate before a task has an assignee', async () => {
    const onTaskDispatch = vi.fn(() => true)
    const orchestrator = new OpenMultiAgent({ onTaskDispatch })
    const team = orchestrator.createTeam('empty-pipeline-team', {
      name: 'empty-pipeline-team',
      agents: [],
      sharedMemory: false,
    })

    const result = await orchestrator.runTasks(team, [{
      title: 'unassigned',
      description: 'No agent can receive this task.',
    }])

    expect(onTaskDispatch).not.toHaveBeenCalled()
    expect(result.tasks?.[0]?.status).toBe('failed')
    expectNoUnsettledTasks(result)
  })
})

describe('target event-driven pipeline semantics', () => {
  it('starts C before slow B completes while respecting maxConcurrency', async () => {
    const harness = createSchedulingHarness({ maxConcurrency: MAX_CONCURRENCY })

    await runFastABeforeSlowB(harness)

    expect(harness.events.maxInFlight).toBeLessThanOrEqual(MAX_CONCURRENCY)
    expect(harness.events.indexOf('task_start', 'C')).toBeLessThan(
      harness.events.indexOf('task_complete', 'B'),
    )
  })

  it('keeps progress pairs, task traces, and execution receipt topology coherent', async () => {
    const traces: TraceEvent[] = []
    const harness = createSchedulingHarness({
      onTrace: (event) => traces.push(event),
    })

    const result = await runFastABeforeSlowB(harness)

    for (const title of TASK_TITLES) {
      const taskStarts = harness.events.timeline.filter((entry) =>
        entry.type === 'task_start' && entry.title === title)
      const taskCompletes = harness.events.timeline.filter((entry) =>
        entry.type === 'task_complete' && entry.title === title)
      const agentStarts = harness.events.timeline.filter((entry) =>
        entry.type === 'agent_start' && entry.title === title)
      const agentCompletes = harness.events.timeline.filter((entry) =>
        entry.type === 'agent_complete' && entry.title === title)
      expect(taskStarts).toHaveLength(1)
      expect(taskCompletes).toHaveLength(1)
      expect(agentStarts).toHaveLength(1)
      expect(agentCompletes).toHaveLength(1)
      expect(harness.events.indexOf('task_start', title)).toBeLessThan(
        harness.events.indexOf('task_complete', title),
      )
    }

    const taskTraces = traces.filter((event) => event.type === 'task')
    expect(taskTraces).toHaveLength(3)
    expect(taskTraces.every((event) => event.success)).toBe(true)

    const receipt = buildExecutionReceipt(result, traces)
    expect(receipt.executionOrder.indexOf('worker-a')).toBeLessThan(
      receipt.executionOrder.indexOf('worker-c'),
    )
    expect(receipt.dependencyEdges).toContainEqual({
      from: 'worker-a',
      to: 'worker-c',
    })
  })

  it('restores a mid-pipeline checkpoint without rerunning completed A', async () => {
    const checkpointStore = new InMemoryStore()
    const abort = new AbortController()
    const original = createSchedulingHarness({
      abortSignal: abort.signal,
      checkpointStore,
    })
    const originalResult = original.run()
    await Promise.all([
      original.adapter.waitForStart('A'),
      original.adapter.waitForStart('B'),
    ])

    original.adapter.release('A')
    await original.events.waitFor('task_complete', 'A')
    const midPipelineSnapshot = await new Checkpoint(checkpointStore, {}).loadLatest()
    expect(midPipelineSnapshot?.queue.completed).toHaveLength(1)
    expect(midPipelineSnapshot?.queue.inProgress).toHaveLength(1)

    abort.abort()
    original.adapter.release('B')
    original.adapter.release('C')
    await originalResult

    const restoreStore = new InMemoryStore()
    await new Checkpoint(restoreStore, {}).save(midPipelineSnapshot!)

    const adapter = new DeferredTaskAdapter()
    const events = new SchedulingEventCollector()
    const resumed = new OpenMultiAgent({
      defaultModel: 'mock-model',
      maxConcurrency: MAX_CONCURRENCY,
      onProgress: events.onProgress,
    })
    const team = resumed.createTeam('pipeline-scheduling-restored', {
      name: 'pipeline-scheduling-restored',
      agents: ['worker-a', 'worker-b', 'worker-c'].map((name) => ({
        name,
        model: 'mock-model',
        systemPrompt: `You are ${name}.`,
        adapter,
      })),
      sharedMemory: false,
    })
    const restoredResult = resumed.restore(team, {
      checkpoint: { store: restoreStore },
    })
    await Promise.all([
      adapter.waitForStart('B'),
      adapter.waitForStart('C'),
    ])
    adapter.release('B')
    adapter.release('C')

    const result = await restoredResult
    expect(events.has('task_start', 'A')).toBe(false)
    expect(result.tasks?.map((task) => [task.title, task.status])).toEqual([
      ['A', 'completed'],
      ['B', 'completed'],
      ['C', 'completed'],
    ])
  })
})
