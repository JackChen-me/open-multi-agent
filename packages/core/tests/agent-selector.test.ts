import { describe, expect, it } from 'vitest'

import {
  AgentSelector,
  validateTaskRequirements,
} from '../src/orchestrator/agent-selector.js'
import { Scheduler } from '../src/orchestrator/scheduler.js'
import { createTask } from '../src/task/task.js'
import type { AgentConfig, TaskRequirements } from '../src/types.js'

describe('AgentSelector', () => {
  it('hard-filters a high-keyword candidate that lacks a required tool', () => {
    const agents: AgentConfig[] = [
      {
        name: 'keyword-star',
        model: 'test',
        systemPrompt: 'TypeScript parser implementation and parser testing specialist',
        capabilities: ['typescript'],
        tools: ['file_read'],
      },
      {
        name: 'eligible-editor',
        model: 'test',
        systemPrompt: 'General software worker',
        capabilities: ['typescript'],
        tools: ['file_read', 'file_edit'],
      },
    ]

    const result = new AgentSelector().select({
      title: 'Implement the TypeScript parser',
      description: 'Patch and test the parser implementation.',
      requires: {
        requiredTools: ['file_edit'],
        requiredCapabilities: ['typescript'],
      },
    }, agents)

    expect(result.agent).toBe(agents[1])
    expect(result.eligible.map((entry) => entry.agent.name)).toEqual(['eligible-editor'])
    expect(result.reasons.join(' ')).toContain(
      'keyword-star excluded: missing required tools: file_edit.',
    )
  })

  it('prefers declared capability affinity over keyword-only affinity', () => {
    const agents: AgentConfig[] = [
      {
        name: 'keyword-agent',
        model: 'test',
        systemPrompt: '分析代码质量并生成评审报告',
      },
      {
        name: 'declared-agent',
        model: 'test',
        systemPrompt: '通用助手',
        capabilities: ['代码评审'],
      },
    ]

    const result = new AgentSelector().select('执行代码评审', agents)

    expect(result.agent).toBe(agents[1])
    expect(result.score).toBeGreaterThan(1)
  })

  it('returns a structured failure when no candidate is eligible', () => {
    const result = new AgentSelector().select({
      title: 'Edit',
      description: 'Edit a file',
      requires: { requiredTools: ['file_edit'] },
    }, [
      { name: 'reader', model: 'test', tools: ['file_read'] },
    ])

    expect(result.agent).toBeUndefined()
    expect(result.eligible).toEqual([])
    expect(result.error).toMatchObject({
      code: 'NO_ELIGIBLE_AGENT',
      message: 'No agent satisfies all explicit task requirements.',
    })
  })

  it.each<{
    requirements: TaskRequirements
    candidate: AgentConfig
    reason: string
  }>([
    {
      requirements: { requiredTools: ['file_edit'] },
      candidate: { name: 'reader', model: 'test', tools: ['file_read'] },
      reason: 'missing required tools',
    },
    {
      requirements: { requiredCapabilities: ['typescript'] },
      candidate: { name: 'generalist', model: 'test' },
      reason: 'missing required capabilities',
    },
    {
      requirements: { requiredBackend: 'process' },
      candidate: { name: 'llm-worker', model: 'test' },
      reason: 'does not satisfy required backend process',
    },
    {
      requirements: { requiredProvider: 'anthropic' },
      candidate: { name: 'openai-worker', model: 'test', provider: 'openai' },
      reason: 'does not satisfy required provider anthropic',
    },
  ])('hard-filters each requirement field independently', ({
    requirements,
    candidate,
    reason,
  }) => {
    const result = new AgentSelector().select({
      title: 'Restricted',
      description: 'Restricted task',
      requires: requirements,
    }, [candidate])

    expect(result.error?.code).toBe('NO_ELIGIBLE_AGENT')
    expect(result.error?.reasons.join(' ')).toContain(reason)
  })

  it('handles one candidate and empty requirements as pure soft scoring', () => {
    const solo: AgentConfig = {
      name: 'solo',
      model: 'test',
      systemPrompt: '分析代码质量并生成评审报告',
    }
    const result = new AgentSelector().select({
      title: '分析代码质量',
      description: '生成评审报告',
      requires: {},
    }, [solo])

    expect(result.agent).toBe(solo)
    expect(result.error).toBeUndefined()
    expect(result.score).toBeGreaterThan(0)
  })

  it('resolves orchestrator default tool presets before hard filtering', () => {
    const agent: AgentConfig = { name: 'defaulted-editor', model: 'test' }
    const result = new AgentSelector().select({
      title: 'Edit',
      description: 'Edit a file',
      requires: { requiredTools: ['file_edit'] },
    }, [agent], { defaultToolPreset: 'readwrite' })

    expect(result.agent).toBe(agent)
    expect(result.error).toBeUndefined()
  })
})

describe('Scheduler capability-match with AgentSelector', () => {
  it('uses resolved tool grants for task requirements', () => {
    const agents: AgentConfig[] = [
      {
        name: 'high-keyword-reader',
        model: 'test',
        systemPrompt: 'Implement TypeScript parser patches',
        tools: ['file_read'],
      },
      {
        name: 'editor',
        model: 'test',
        systemPrompt: 'Software worker',
        tools: ['file_edit'],
      },
    ]
    const task = createTask({
      title: 'Implement TypeScript parser patches',
      description: 'Edit the parser.',
      requires: { requiredTools: ['file_edit'] },
    })

    const assignments = new Scheduler('capability-match').schedule([task], agents)

    expect(assignments.get(task.id)).toBe('editor')
  })

  it('does not silently fall back when every agent is ineligible', () => {
    const task = createTask({
      title: 'Edit',
      description: 'Edit a file.',
      requires: { requiredTools: ['file_edit'] },
    })

    expect(() => new Scheduler('capability-match').schedule([task], [
      { name: 'reader', model: 'test', tools: ['file_read'] },
    ])).toThrow('NO_ELIGIBLE_AGENT')
  })
})

describe('task requirement preflight', () => {
  it('reports an explicit assignee that does not satisfy requirements', () => {
    const task = createTask({
      title: 'Edit',
      description: 'Edit a file.',
      assignee: 'reader',
      requires: { requiredTools: ['file_edit'] },
    })

    expect(validateTaskRequirements([task], [
      { name: 'reader', model: 'test', tools: ['file_read'] },
      { name: 'editor', model: 'test', tools: ['file_edit'] },
    ])).toEqual([
      expect.objectContaining({
        code: 'ASSIGNEE_REQUIREMENTS_MISMATCH',
        taskId: task.id,
        assignee: 'reader',
      }),
    ])
  })

  it('reports an unassigned task when the full roster is ineligible', () => {
    const task = createTask({
      title: 'Anthropic task',
      description: 'Use the required provider.',
      requires: { requiredProvider: 'anthropic' },
    })

    expect(validateTaskRequirements([task], [
      { name: 'openai-worker', model: 'test', provider: 'openai' },
    ])).toEqual([
      expect.objectContaining({
        code: 'NO_ELIGIBLE_AGENT',
        taskId: task.id,
      }),
    ])
  })
})
