import { describe, expect, it, vi } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { InMemoryStore } from '../src/memory/store.js'
import type { AgentConfig, AgentRunResult } from '../src/types.js'

function structuredProcessAgent(afterRun: (result: AgentRunResult) => AgentRunResult): AgentConfig {
  return {
    name: 'worker',
    systemPrompt: 'Return the task sequence as JSON.',
    backend: {
      kind: 'process',
      command: process.execPath,
      args: ['-e', `
        process.stdin.setEncoding('utf8')
        let input = ''
        process.stdin.on('data', chunk => { input += chunk })
        process.stdin.on('end', () => {
          process.stdout.write(input.includes('# Task: First') ? '{"sequence":1}' : '{"sequence":2}')
        })
      `],
    },
    afterRun,
  }
}

describe('TeamRunResult taskResults', () => {
  it('keeps each task result when one agent executes multiple tasks without double-counting usage', async () => {
    const afterRun = vi.fn((result: AgentRunResult): AgentRunResult => {
      const structured = JSON.parse(result.output) as { sequence: number }
      return {
        ...result,
        structured,
        tokenUsage: {
          input_tokens: structured.sequence,
          output_tokens: structured.sequence * 2,
        },
        toolCalls: [{
          toolName: `tool-${structured.sequence}`,
          input: { sequence: structured.sequence },
          output: 'ok',
          duration: structured.sequence,
        }],
      }
    })
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('task-results', {
      name: 'task-results',
      agents: [structuredProcessAgent(afterRun)],
    })

    const result = await oma.runTasks(team, [
      { title: 'First', description: 'Return sequence 1.', assignee: 'worker' },
      {
        title: 'Second',
        description: 'Return sequence 2.',
        assignee: 'worker',
        dependsOn: ['First'],
      },
    ])

    const first = result.tasks?.find(task => task.title === 'First')
    const second = result.tasks?.find(task => task.title === 'Second')
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(result.taskResults?.get(first!.id)?.structured).toEqual({ sequence: 1 })
    expect(result.taskResults?.get(second!.id)?.structured).toEqual({ sequence: 2 })
    expect(result.taskResults?.get(first!.id)?.toolCalls[0]?.toolName).toBe('tool-1')
    expect(result.agentResults.get('worker')?.structured).toEqual({ sequence: 2 })
    expect(result.agentResults.get('worker')?.tokenUsage).toEqual({
      input_tokens: 3,
      output_tokens: 6,
    })
    expect(result.totalTokenUsage).toEqual({ input_tokens: 3, output_tokens: 6 })
  })

  it('rehydrates full task-scoped results from a checkpoint', async () => {
    const store = new InMemoryStore()
    const afterRun = vi.fn((result: AgentRunResult): AgentRunResult => {
      const structured = JSON.parse(result.output) as { sequence: number }
      return {
        ...result,
        structured,
        tokenUsage: { input_tokens: structured.sequence, output_tokens: 0 },
        toolCalls: [{
          toolName: `tool-${structured.sequence}`,
          input: {},
          output: 'ok',
          duration: 1,
        }],
      }
    })
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('checkpoint-task-results', {
      name: 'checkpoint-task-results',
      agents: [structuredProcessAgent(afterRun)],
    })

    const initial = await oma.runTasks(team, [
      { title: 'First', description: 'Return sequence 1.', assignee: 'worker' },
      {
        title: 'Second',
        description: 'Return sequence 2.',
        assignee: 'worker',
        dependsOn: ['First'],
      },
    ], { checkpoint: { store, runId: 'task-results-run' } })
    const restored = await oma.restore(team, {
      checkpoint: { store, runId: 'task-results-run' },
    })

    expect(afterRun).toHaveBeenCalledTimes(2)
    for (const task of initial.tasks ?? []) {
      expect(restored.taskResults?.get(task.id)).toMatchObject({
        success: true,
        output: initial.taskResults?.get(task.id)?.output,
        structured: initial.taskResults?.get(task.id)?.structured,
        tokenUsage: initial.taskResults?.get(task.id)?.tokenUsage,
        toolCalls: initial.taskResults?.get(task.id)?.toolCalls,
      })
    }
    expect(restored.totalTokenUsage).toEqual({ input_tokens: 3, output_tokens: 0 })
  })

  it('keeps checkpoints durable when a custom result is not JSON-serializable', async () => {
    const store = new InMemoryStore()
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('non-json-checkpoint-result', {
      name: 'non-json-checkpoint-result',
      agents: [structuredProcessAgent(result => ({
        ...result,
        structured: { count: 1n },
      }))],
    })

    const initial = await oma.runTasks(team, [
      { title: 'First', description: 'Return a non-JSON result.', assignee: 'worker' },
    ], { checkpoint: { store, runId: 'non-json-task-result' } })
    const restored = await oma.restore(team, {
      checkpoint: { store, runId: 'non-json-task-result' },
    })

    const taskId = initial.tasks?.[0]?.id
    expect(taskId).toBeDefined()
    const restoredTaskResult = restored.taskResults?.get(taskId!)
    expect(restoredTaskResult).toMatchObject({
      success: true,
      output: initial.taskResults?.get(taskId!)?.output,
      tokenUsage: { input_tokens: 0, output_tokens: 0 },
      toolCalls: [],
    })
    expect(restoredTaskResult).not.toHaveProperty('structured')
  })
})
