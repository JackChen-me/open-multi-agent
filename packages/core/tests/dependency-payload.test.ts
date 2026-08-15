import { describe, expect, it, vi } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { InMemoryStore } from '../src/memory/store.js'
import type {
  AgentConfig,
  AgentRunResult,
  OrchestratorEvent,
} from '../src/types.js'

function processAgent(
  name: string,
  source: string,
  afterRun?: (result: AgentRunResult) => AgentRunResult,
): AgentConfig {
  return {
    name,
    systemPrompt: `${name} system prompt`,
    backend: {
      kind: 'process',
      command: process.execPath,
      args: ['-e', source],
    },
    ...(afterRun ? { afterRun } : {}),
  }
}

const PRODUCER_SOURCE = `
  process.stdin.resume()
  process.stdout.write('EXTRA-NARRATIVE\\n{"z":1,"a":{"d":4,"b":2}}')
`

const ECHO_SOURCE = `
  process.stdin.setEncoding('utf8')
  let input = ''
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', () => process.stdout.write(input))
`

function structuredProducer(name = 'producer'): AgentConfig {
  return processAgent(name, PRODUCER_SOURCE, result => ({
    ...result,
    structured: { z: 1, a: { d: 4, b: 2 } },
    tokenUsage: { input_tokens: 2, output_tokens: 1 },
  }))
}

function echoReviewer(afterRun?: (result: AgentRunResult) => AgentRunResult): AgentConfig {
  return processAgent('reviewer', ECHO_SOURCE, afterRun)
}

describe('structured dependency payloads', () => {
  it('injects only canonical validated JSON and preserves token accounting', async () => {
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('structured-handoff', {
      name: 'structured-handoff',
      agents: [
        structuredProducer(),
        echoReviewer(result => ({
          ...result,
          tokenUsage: { input_tokens: 3, output_tokens: 4 },
        })),
      ],
    })

    const result = await oma.runTasks(team, [
      { title: 'Extract', description: 'Extract a record.', assignee: 'producer' },
      {
        title: 'Review',
        description: 'Review the validated record.',
        assignee: 'reviewer',
        dependsOn: ['Extract'],
        dependencyPayload: 'structured',
      },
    ], { maxTokenBudget: 20 })

    const reviewer = result.agentResults.get('reviewer')
    expect(result.success).toBe(true)
    expect(reviewer?.output).toContain('#### Validated structured result')
    expect(reviewer?.output).toContain('{"a":{"b":2,"d":4},"z":1}')
    expect(reviewer?.output).not.toContain('EXTRA-NARRATIVE')
    expect(result.totalTokenUsage).toEqual({ input_tokens: 5, output_tokens: 5 })
  })

  it('labels raw and structured forms when both are requested', async () => {
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('both-handoff', {
      name: 'both-handoff',
      agents: [structuredProducer(), echoReviewer()],
    })

    const result = await oma.runTasks(team, [
      { title: 'Extract', description: 'Extract a record.', assignee: 'producer' },
      {
        title: 'Review',
        description: 'Compare both representations.',
        assignee: 'reviewer',
        dependsOn: ['Extract'],
        dependencyPayload: 'both',
      },
    ])

    const output = result.agentResults.get('reviewer')?.output ?? ''
    expect(output).toContain('#### Raw output\nEXTRA-NARRATIVE')
    expect(output).toContain('#### Validated structured result\n{"a":{"b":2,"d":4},"z":1}')
  })

  it('fails the dependent task with a machine-readable error when structured data is missing', async () => {
    const reviewerAfterRun = vi.fn((result: AgentRunResult) => result)
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('missing-structured', {
      name: 'missing-structured',
      agents: [
        processAgent('producer', `process.stdout.write('plain output')`),
        echoReviewer(reviewerAfterRun),
      ],
    })

    const result = await oma.runTasks(team, [
      { title: 'Extract', description: 'Return plain text.', assignee: 'producer' },
      {
        title: 'Review',
        description: 'Require structured data.',
        assignee: 'reviewer',
        dependsOn: ['Extract'],
        dependencyPayload: 'structured',
      },
    ])

    const reviewTask = result.tasks?.find(task => task.title === 'Review')
    expect(result.success).toBe(false)
    expect(reviewTask?.status).toBe('failed')
    expect(result.taskResults?.get(reviewTask!.id)?.errorInfo).toMatchObject({
      kind: 'validation',
      code: 'DEPENDENCY_STRUCTURED_RESULT_MISSING',
    })
    expect(reviewerAfterRun).not.toHaveBeenCalled()
  })

  it('rejects an oversized structured dependency before invoking the consumer', async () => {
    const reviewerAfterRun = vi.fn((result: AgentRunResult) => result)
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('large-structured', {
      name: 'large-structured',
      agents: [
        processAgent('producer', `process.stdout.write('ok')`, result => ({
          ...result,
          structured: { payload: 'x'.repeat(70_000) },
        })),
        echoReviewer(reviewerAfterRun),
      ],
    })

    const result = await oma.runTasks(team, [
      { title: 'Extract', description: 'Return a large record.', assignee: 'producer' },
      {
        title: 'Review',
        description: 'Consume the record.',
        assignee: 'reviewer',
        dependsOn: ['Extract'],
        dependencyPayload: 'structured',
      },
    ])

    const reviewTask = result.tasks?.find(task => task.title === 'Review')
    expect(result.taskResults?.get(reviewTask!.id)?.errorInfo?.code)
      .toBe('DEPENDENCY_PAYLOAD_TOO_LARGE')
    expect(reviewerAfterRun).not.toHaveBeenCalled()
  })

  it('reports non-JSON structured data without falling back to raw output', async () => {
    const reviewerAfterRun = vi.fn((result: AgentRunResult) => result)
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('non-json-structured', {
      name: 'non-json-structured',
      agents: [
        processAgent('producer', `process.stdout.write('raw fallback must not run')`, result => ({
          ...result,
          structured: { count: 1n },
        })),
        echoReviewer(reviewerAfterRun),
      ],
    })

    const result = await oma.runTasks(team, [
      { title: 'Extract', description: 'Return a non-JSON value.', assignee: 'producer' },
      {
        title: 'Review',
        description: 'Consume only validated JSON.',
        assignee: 'reviewer',
        dependsOn: ['Extract'],
        dependencyPayload: 'structured',
      },
    ])

    const reviewTask = result.tasks?.find(task => task.title === 'Review')
    expect(result.taskResults?.get(reviewTask!.id)?.errorInfo?.code)
      .toBe('DEPENDENCY_STRUCTURED_SERIALIZATION_FAILED')
    expect(result.taskResults?.get(reviewTask!.id)?.output)
      .not.toContain('raw fallback must not run')
    expect(reviewerAfterRun).not.toHaveBeenCalled()
  })

  it('restores structured dependency data from a checkpoint before resuming a consumer', async () => {
    const store = new InMemoryStore()
    const abort = new AbortController()
    const firstOma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      onProgress(event: OrchestratorEvent) {
        if (event.type === 'task_complete') abort.abort()
      },
    })
    const agents = [structuredProducer(), echoReviewer()]
    const firstTeam = firstOma.createTeam('checkpoint-handoff-first', {
      name: 'checkpoint-handoff-first',
      agents,
    })

    const interrupted = await firstOma.runTasks(firstTeam, [
      { title: 'Extract', description: 'Extract a record.', assignee: 'producer' },
      {
        title: 'Review',
        description: 'Review after restore.',
        assignee: 'reviewer',
        dependsOn: ['Extract'],
        dependencyPayload: 'structured',
      },
    ], {
      abortSignal: abort.signal,
      checkpoint: { store, runId: 'structured-handoff' },
    })
    expect(interrupted.success).toBe(false)

    const resumedOma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const resumedTeam = resumedOma.createTeam('checkpoint-handoff-resumed', {
      name: 'checkpoint-handoff-resumed',
      agents,
    })
    const restored = await resumedOma.restore(resumedTeam, {
      checkpoint: { store, runId: 'structured-handoff' },
    })

    expect(restored.success).toBe(true)
    expect(restored.agentResults.get('reviewer')?.output)
      .toContain('{"a":{"b":2,"d":4},"z":1}')
    expect(restored.agentResults.get('reviewer')?.output).not.toContain('EXTRA-NARRATIVE')
  })
})
