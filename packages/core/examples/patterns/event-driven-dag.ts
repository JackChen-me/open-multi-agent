/**
 * Event-Driven DAG Dispatch
 *
 * Demonstrates with controlled deferred promises that task C starts as soon as
 * its dependency A completes, without waiting for unrelated task B.
 *
 * Run:
 *   npx tsx packages/core/examples/patterns/event-driven-dag.ts
 *
 * Prerequisites:
 *   None. This example makes no model or network request.
 */

import { OpenMultiAgent } from '../../src/index.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  OrchestratorEvent,
  Task,
} from '../../src/types.js'

type Title = 'A' | 'B' | 'C'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

function titleFromMessages(messages: LLMMessage[]): Title {
  const prompt = [...messages]
    .reverse()
    .find((message) => message.role === 'user')
    ?.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n') ?? ''
  const title = prompt.match(/^# Task: (A|B|C)$/m)?.[1]
  if (!title) throw new Error(`Unexpected task prompt: ${prompt}`)
  return title as Title
}

class DeferredAdapter implements LLMAdapter {
  readonly name = 'event-driven-dag-example'

  private readonly started = new Map<Title, Deferred<void>>()
  private readonly released = new Map<Title, Deferred<void>>()

  constructor() {
    for (const title of ['A', 'B', 'C'] as const) {
      this.started.set(title, deferred<void>())
      this.released.set(title, deferred<void>())
    }
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const title = titleFromMessages(messages)
    this.started.get(title)!.resolve(undefined)
    await this.released.get(title)!.promise
    return {
      id: `response-${title}`,
      content: [{ type: 'text', text: `completed ${title}` }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async *stream() {
    yield { type: 'done' as const, data: {} }
  }

  waitForStart(title: Title): Promise<void> {
    return this.started.get(title)!.promise
  }

  release(title: Title): void {
    this.released.get(title)!.resolve(undefined)
  }
}

const adapter = new DeferredAdapter()
const timeline: string[] = []
const titlesById = new Map<string, string>()

function onProgress(event: OrchestratorEvent): void {
  if (event.task && event.type === 'task_start') {
    titlesById.set(event.task, (event.data as Task).title)
  }
  if (event.type === 'task_start' || event.type === 'task_complete') {
    timeline.push(`${event.type}:${titlesById.get(event.task ?? '') ?? event.task}`)
  }
}

const orchestrator = new OpenMultiAgent({
  defaultModel: 'deferred-local',
  maxConcurrency: 2,
  onProgress,
})

const agents: AgentConfig[] = ['worker-a', 'worker-b', 'worker-c'].map((name) => ({
  name,
  model: 'deferred-local',
  adapter,
}))
const team = orchestrator.createTeam('event-driven-dag', {
  name: 'event-driven-dag',
  agents,
  sharedMemory: false,
})

const resultPromise = orchestrator.runTasks(team, [
  { title: 'A', description: 'Fast root task.', assignee: 'worker-a' },
  { title: 'B', description: 'Controlled slow root task.', assignee: 'worker-b' },
  {
    title: 'C',
    description: 'Depends only on A.',
    assignee: 'worker-c',
    dependsOn: ['A'],
  },
])

await Promise.all([
  adapter.waitForStart('A'),
  adapter.waitForStart('B'),
])

adapter.release('A')
await adapter.waitForStart('C')
console.log('C started after A completed while B was still deferred.')

adapter.release('C')
adapter.release('B')
const result = await resultPromise

const cStart = timeline.indexOf('task_start:C')
const bComplete = timeline.indexOf('task_complete:B')
if (!result.success || cStart === -1 || bComplete === -1 || cStart >= bComplete) {
  throw new Error(`Unexpected event order: ${timeline.join(' -> ')}`)
}

console.log(timeline.join(' -> '))
