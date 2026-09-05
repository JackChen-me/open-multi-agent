import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { Agent } from '../src/agent/agent.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type {
  AgentConfig,
  AgentRunResult,
  CostEstimateContext,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  OrchestratorEvent,
  TeamConfig,
  TraceEvent,
} from '../src/types.js'
import type { SchedulingStrategy } from '../src/orchestrator/scheduler.js'

// ---------------------------------------------------------------------------
// Mock LLM adapter
// ---------------------------------------------------------------------------

/** A controllable fake LLM adapter for orchestrator tests. */
function createMockAdapter(responses: string[]): LLMAdapter {
  let callIndex = 0
  return {
    name: 'mock',
    async chat(_msgs: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
      const text = responses[callIndex] ?? 'no response configured'
      callIndex++
      return {
        id: `resp-${callIndex}`,
        content: [{ type: 'text', text }],
        model: options.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      }
    },
    async *stream() {
      yield { type: 'done' as const, data: {} }
    },
  }
}

function textResponse(text: string): LLMResponse {
  return {
    id: `resp-${text.slice(0, 8)}`,
    content: [{ type: 'text', text }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
  }
}

function toolUseResponse(toolName: string, input: Record<string, unknown>): LLMResponse {
  return {
    id: `resp-tool-${toolName}`,
    content: [{
      type: 'tool_use',
      id: `tool-${toolName}`,
      name: toolName,
      input,
    }],
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 20 },
  }
}

function extractUserPrompt(messages: LLMMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  return (lastUser?.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

/**
 * Mock the createAdapter factory to return our mock adapter.
 * We need to do this at the module level because Agent calls createAdapter internally.
 */
let mockAdapterResponses: string[] = []
let capturedChatOptions: LLMChatOptions[] = []
let capturedPrompts: string[] = []
let capturedAdapterProviders: string[] = []
let mockAdapterHandler: ((options: LLMChatOptions) => string | Error) | undefined

vi.mock('../src/llm/adapter.js', () => ({
  createAdapter: async (provider: string) => {
    capturedAdapterProviders.push(provider)
    let callIndex = 0
    return {
      name: 'mock',
      async chat(_msgs: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
        capturedChatOptions.push(options)
        const lastUser = [..._msgs].reverse().find((m) => m.role === 'user')
        const prompt = (lastUser?.content ?? [])
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
        capturedPrompts.push(prompt)
        const configuredResponse = mockAdapterHandler?.(options)
        if (configuredResponse instanceof Error) throw configuredResponse
        const text = configuredResponse ?? mockAdapterResponses[callIndex] ?? 'default mock response'
        callIndex++
        return {
          id: `resp-${callIndex}`,
          content: [{ type: 'text', text }],
          model: options.model ?? 'mock-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 },
        }
      },
      async *stream() {
        yield { type: 'done' as const, data: {} }
      },
    }
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentConfig(name: string): AgentConfig {
  return {
    name,
    model: 'mock-model',
    provider: 'openai',
    systemPrompt: `You are ${name}.`,
  }
}

function teamCfg(agents?: AgentConfig[]): TeamConfig {
  return {
    name: 'test-team',
    agents: agents ?? [agentConfig('worker-a'), agentConfig('worker-b')],
    sharedMemory: true,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenMultiAgent', () => {
  beforeEach(() => {
    mockAdapterResponses = []
    capturedChatOptions = []
    capturedPrompts = []
    capturedAdapterProviders = []
    mockAdapterHandler = undefined
  })

  describe('createTeam', () => {
    it('creates and registers a team', () => {
      const oma = new OpenMultiAgent()
      const team = oma.createTeam('my-team', teamCfg())
      expect(team.name).toBe('test-team')
      expect(oma.getStatus().teams).toBe(1)
    })

    it('throws on duplicate team name', () => {
      const oma = new OpenMultiAgent()
      oma.createTeam('my-team', teamCfg())
      expect(() => oma.createTeam('my-team', teamCfg())).toThrow('already exists')
    })
  })

  describe('shutdown', () => {
    it('clears teams and counters', async () => {
      const oma = new OpenMultiAgent()
      oma.createTeam('t1', teamCfg())
      await oma.shutdown()
      expect(oma.getStatus().teams).toBe(0)
      expect(oma.getStatus().completedTasks).toBe(0)
    })
  })

  describe('getStatus', () => {
    it('reports initial state', () => {
      const oma = new OpenMultiAgent()
      const status = oma.getStatus()
      expect(status).toEqual({ teams: 0, activeAgents: 0, completedTasks: 0 })
    })
  })

  describe('runAgent', () => {
    it('runs a single agent and returns result', async () => {
      mockAdapterResponses = ['Hello from agent!']

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const result = await oma.runAgent(
        agentConfig('solo'),
        'Say hello',
      )

      expect(result.success).toBe(true)
      expect(result.output).toBe('Hello from agent!')
      expect(oma.getStatus().completedTasks).toBe(1)
    })

    it('registers customTools so they are available to the LLM', async () => {
      mockAdapterResponses = ['used custom tool']

      const { z } = await import('zod')
      const { defineTool } = await import('../src/tool/framework.js')

      const myTool = defineTool({
        name: 'my_custom_tool',
        description: 'A custom tool for testing',
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ data: query }),
      })

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      await oma.runAgent(
        { ...agentConfig('solo'), customTools: [myTool] },
        'Use the custom tool',
      )

      const toolNames = capturedChatOptions[0]?.tools?.map(t => t.name) ?? []
      expect(toolNames).toContain('my_custom_tool')
    })

    it('customTools bypass tools allowlist and toolPreset filtering', async () => {
      mockAdapterResponses = ['done']

      const { z } = await import('zod')
      const { defineTool } = await import('../src/tool/framework.js')

      const myTool = defineTool({
        name: 'my_custom_tool',
        description: 'A custom tool for testing',
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ data: query }),
      })

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })

      // toolPreset 'readonly' only allows file_read, grep, glob — custom tool should still appear
      await oma.runAgent(
        { ...agentConfig('solo'), customTools: [myTool], toolPreset: 'readonly' },
        'test',
      )

      const toolNames = capturedChatOptions[0]?.tools?.map(t => t.name) ?? []
      expect(toolNames).toContain('my_custom_tool')
      // built-in tools outside the preset should be filtered
      expect(toolNames).not.toContain('bash')
    })

    it('customTools can be blocked by disallowedTools', async () => {
      mockAdapterResponses = ['done']

      const { z } = await import('zod')
      const { defineTool } = await import('../src/tool/framework.js')

      const myTool = defineTool({
        name: 'my_custom_tool',
        description: 'A custom tool for testing',
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ data: query }),
      })

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })

      await oma.runAgent(
        { ...agentConfig('solo'), customTools: [myTool], disallowedTools: ['my_custom_tool'] },
        'test',
      )

      const toolNames = capturedChatOptions[0]?.tools?.map(t => t.name) ?? []
      expect(toolNames).not.toContain('my_custom_tool')
    })

    it('fires onProgress events', async () => {
      mockAdapterResponses = ['done']

      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onProgress: (e) => events.push(e),
      })

      await oma.runAgent(agentConfig('solo'), 'test')

      const types = events.map(e => e.type)
      expect(types).toContain('agent_start')
      expect(types).toContain('agent_complete')
    })
  })

  describe('runTasks', () => {
    it('executes explicit tasks assigned to agents', async () => {
      // Each agent run produces one LLM call
      mockAdapterResponses = ['result-a', 'result-b']

      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onProgress: (e) => events.push(e),
      })
      const team = oma.createTeam('t', teamCfg())

      const result = await oma.runTasks(team, [
        { title: 'Task A', description: 'Do A', assignee: 'worker-a' },
        { title: 'Task B', description: 'Do B', assignee: 'worker-b' },
      ])

      expect(result.success).toBe(true)
      expect(result.agentResults.size).toBeGreaterThanOrEqual(1)
    })

    it('handles task dependencies sequentially', async () => {
      mockAdapterResponses = ['first done', 'second done']

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      const result = await oma.runTasks(team, [
        { title: 'First', description: 'Do first', assignee: 'worker-a' },
        { title: 'Second', description: 'Do second', assignee: 'worker-b', dependsOn: ['First'] },
      ])

      expect(result.success).toBe(true)
    })

    it('rejects cyclic task dependencies before dispatch', async () => {
      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      await expect(oma.runTasks(team, [
        { title: 'Task A', description: 'Do A', assignee: 'worker-a', dependsOn: ['Task B'] },
        { title: 'Task B', description: 'Do B', assignee: 'worker-b', dependsOn: ['Task A'] },
      ])).rejects.toThrow('Invalid task dependencies: Cyclic dependency detected')

      expect(capturedPrompts).toEqual([])
    })

    it('rejects an explicit assignee that does not satisfy hard requirements before dispatch', async () => {
      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onProgress: (event) => events.push(event),
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('reader'), tools: ['file_read'] },
        { ...agentConfig('editor'), tools: ['file_edit'] },
      ]))

      await expect(oma.runTasks(team, [{
        title: 'Edit',
        description: 'Edit a file.',
        assignee: 'reader',
        requires: { requiredTools: ['file_edit'] },
      }])).rejects.toMatchObject({
        code: 'INVALID_TASK_REQUIREMENTS',
        issues: [
          expect.objectContaining({
            code: 'ASSIGNEE_REQUIREMENTS_MISMATCH',
            assignee: 'reader',
          }),
        ],
      })

      expect(capturedPrompts).toEqual([])
      expect(events).toContainEqual(expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ code: 'INVALID_TASK_REQUIREMENTS' }),
      }))
    })

    it('rejects a plan with no eligible agent before dispatch', async () => {
      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      await expect(oma.runTasks(team, [
        {
          title: 'Unrestricted predecessor',
          description: 'Must not start before the full plan is validated.',
        },
        {
          title: 'Restricted',
          description: 'Requires a missing capability.',
          dependsOn: ['Unrestricted predecessor'],
          requires: { requiredCapabilities: ['missing'] },
        },
      ])).rejects.toMatchObject({
        code: 'INVALID_TASK_REQUIREMENTS',
        issues: [
          expect.objectContaining({ code: 'NO_ELIGIBLE_AGENT' }),
        ],
      })

      expect(capturedPrompts).toEqual([])
    })

    it.each<{
      strategy: SchedulingStrategy
      expected: Record<string, string>
    }>([
      {
        strategy: 'round-robin',
        expected: {
          'Implement TypeScript service': 'researcher',
          'Research market analysis': 'coder',
          'Summarize findings': 'researcher',
        },
      },
      {
        strategy: 'least-busy',
        expected: {
          'Implement TypeScript service': 'researcher',
          'Research market analysis': 'coder',
          'Summarize findings': 'researcher',
        },
      },
      {
        strategy: 'capability-match',
        expected: {
          'Implement TypeScript service': 'coder',
          'Research market analysis': 'researcher',
          'Summarize findings': 'researcher',
        },
      },
      {
        strategy: 'dependency-first',
        expected: {
          'Implement TypeScript service': 'coder',
          'Research market analysis': 'researcher',
          'Summarize findings': 'researcher',
        },
      },
    ])('applies the $strategy scheduling strategy from config', async ({ strategy, expected }) => {
      mockAdapterResponses = ['first done', 'second done', 'third done']

      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        schedulingStrategy: strategy,
        onProgress: (event) => events.push(event),
      })
      const team = oma.createTeam('t', teamCfg([
        {
          ...agentConfig('researcher'),
          systemPrompt: 'Research markets and analyze evidence.',
        },
        {
          ...agentConfig('coder'),
          systemPrompt: 'Implement TypeScript software services.',
        },
      ]))

      const result = await oma.runTasks(team, [
        { title: 'Implement TypeScript service', description: 'Implement software code' },
        { title: 'Research market analysis', description: 'Research and analyze market evidence' },
        {
          title: 'Summarize findings',
          description: 'Summarize the research',
          dependsOn: ['Research market analysis'],
        },
      ])

      const assignments = Object.fromEntries(
        events
          .filter((event) => event.type === 'task_start')
          .map((event) => [(event.data as { title: string }).title, event.agent]),
      )
      expect(result.success).toBe(true)
      expect(assignments).toEqual(expected)
    })

    it('defaults to dependency-first scheduling', async () => {
      mockAdapterResponses = ['first done', 'second done', 'third done']

      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onProgress: (event) => events.push(event),
      })
      const team = oma.createTeam('t', teamCfg())

      const result = await oma.runTasks(team, [
        { title: 'Independent', description: 'Independent work' },
        { title: 'Critical root', description: 'Start the pipeline' },
        { title: 'Dependent', description: 'Finish the pipeline', dependsOn: ['Critical root'] },
      ])

      const assignments = Object.fromEntries(
        events
          .filter((event) => event.type === 'task_start')
          .map((event) => [(event.data as { title: string }).title, event.agent]),
      )
      expect(result.success).toBe(true)
      expect(assignments).toEqual({
        Independent: 'worker-b',
        'Critical root': 'worker-a',
        Dependent: 'worker-a',
      })
    })

    it('uses a clean slate for tasks without dependencies', async () => {
      mockAdapterResponses = ['alpha done', 'beta done']

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      await oma.runTasks(team, [
        { title: 'Independent A', description: 'Do independent A', assignee: 'worker-a' },
        { title: 'Independent B', description: 'Do independent B', assignee: 'worker-b' },
      ])

      const workerPrompts = capturedPrompts.slice(0, 2)
      expect(workerPrompts[0]).toContain('# Task: Independent A')
      expect(workerPrompts[1]).toContain('# Task: Independent B')
      expect(workerPrompts[0]).not.toContain('## Shared Team Memory')
      expect(workerPrompts[1]).not.toContain('## Shared Team Memory')
      expect(workerPrompts[0]).not.toContain('## Context from prerequisite tasks')
      expect(workerPrompts[1]).not.toContain('## Context from prerequisite tasks')
    })

    it('injects only dependency results into dependent task prompts', async () => {
      mockAdapterResponses = ['first output', 'second output']

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      await oma.runTasks(team, [
        { title: 'First', description: 'Produce first', assignee: 'worker-a' },
        { title: 'Second', description: 'Use first', assignee: 'worker-b', dependsOn: ['First'] },
      ])

      const secondPrompt = capturedPrompts[1] ?? ''
      expect(secondPrompt).toContain('## Context from prerequisite tasks')
      expect(secondPrompt).toContain('### First (by worker-a)')
      expect(secondPrompt).toContain('first output')
      expect(secondPrompt).not.toContain('## Shared Team Memory')
    })

    it('supports memoryScope all opt-in for full shared memory visibility', async () => {
      mockAdapterResponses = ['writer output', 'reader output']

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      await oma.runTasks(team, [
        { title: 'Write', description: 'Write something', assignee: 'worker-a' },
        {
          title: 'Read all',
          description: 'Read everything',
          assignee: 'worker-b',
          memoryScope: 'all',
          dependsOn: ['Write'],
        },
      ])

      const secondPrompt = capturedPrompts[1] ?? ''
      expect(secondPrompt).toContain('## Shared Team Memory')
      expect(secondPrompt).toContain('task:')
      expect(secondPrompt).not.toContain('## Context from prerequisite tasks')
    })

    it('routes leaf worker tasks to an explicit cheaper model without mutating the team', async () => {
      mockAdapterResponses = ['worker output']

      const oma = new OpenMultiAgent({ defaultModel: 'premium-model' })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'default-worker-model' },
      ]))

      await oma.runTasks(team, [
        { title: 'Leaf', description: 'Do leaf work', assignee: 'worker-a' },
      ], {
        modelRouting: {
          rules: [{ match: { phase: 'worker', leaf: true }, route: { model: 'cheap-worker-model' } }],
        },
      })

      expect(capturedChatOptions[0]?.model).toBe('cheap-worker-model')
      expect(team.getAgents()[0]?.model).toBe('default-worker-model')
    })

    it('rejects a model route that overrides a required provider before dispatch', async () => {
      const oma = new OpenMultiAgent({ defaultModel: 'default-model' })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), provider: 'anthropic' },
      ]))

      await expect(oma.runTasks(team, [{
        title: 'Anthropic only',
        description: 'Run on the required provider.',
        assignee: 'worker-a',
        requires: { requiredProvider: 'anthropic' },
      }], {
        modelRouting: {
          rules: [{
            match: { phase: 'worker' },
            route: { model: 'routed-model', provider: 'openai' },
          }],
        },
      })).rejects.toMatchObject({
        code: 'INVALID_TASK_REQUIREMENTS',
      })

      expect(capturedPrompts).toEqual([])
    })

    it('routes critical dependent tasks to an explicit premium model', async () => {
      mockAdapterResponses = ['research output', 'review output']

      const oma = new OpenMultiAgent({ defaultModel: 'default-model' })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'default-worker-model' },
      ]))

      await oma.runTasks(team, [
        { title: 'Research', description: 'Gather facts', assignee: 'worker-a' },
        {
          title: 'Review',
          description: 'Check the result',
          assignee: 'worker-a',
          dependsOn: ['Research'],
          priority: 'critical',
        },
      ], {
        modelRouting: {
          rules: [
            { match: { phase: 'worker', taskPriority: 'critical', hasDependencies: true }, route: { model: 'premium-review-model' } },
            { match: { phase: 'worker', leaf: true }, route: { model: 'cheap-worker-model' } },
          ],
        },
      })

      expect(capturedChatOptions[0]?.model).toBe('default-worker-model')
      expect(capturedChatOptions[1]?.model).toBe('premium-review-model')
    })

    it('fails over to the next route after a retryable provider error', async () => {
      mockAdapterHandler = (options) => {
        if (options.model === 'primary-model') {
          return Object.assign(new Error('rate limited'), { status: 429 })
        }
        return 'backup output'
      }

      const oma = new OpenMultiAgent({ defaultModel: 'default-model' })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'default-worker-model' },
      ]))

      const result = await oma.runTasks(team, [
        {
          title: 'Fallback',
          description: 'Recover from a provider outage',
          assignee: 'worker-a',
          maxRetries: 1,
          retryDelayMs: 0,
        },
      ], {
        modelRouting: {
          rules: [{
            match: { phase: 'worker' },
            route: {
              model: 'primary-model',
              provider: 'anthropic',
              fallback: [{ model: 'backup-model', provider: 'openai' }],
            },
          }],
        },
      })

      expect(result.success).toBe(true)
      expect(result.agentResults.get('worker-a')?.output).toBe('backup output')
      expect(capturedChatOptions.map(options => options.model)).toEqual([
        'primary-model',
        'backup-model',
      ])
      expect(capturedAdapterProviders).toEqual(['anthropic', 'openai'])
    })

    it('does not use a fallback route that violates a required provider', async () => {
      mockAdapterHandler = () =>
        Object.assign(new Error('provider unavailable'), { status: 503 })

      const oma = new OpenMultiAgent({ defaultModel: 'default-model' })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), provider: 'anthropic' },
      ]))

      const result = await oma.runTasks(team, [{
        title: 'Anthropic fallback boundary',
        description: 'Do not cross the provider boundary.',
        assignee: 'worker-a',
        requires: { requiredProvider: 'anthropic' },
        maxRetries: 1,
        retryDelayMs: 0,
      }], {
        modelRouting: {
          rules: [{
            match: { phase: 'worker' },
            route: {
              model: 'primary-model',
              provider: 'anthropic',
              fallback: [{ model: 'backup-model', provider: 'openai' }],
            },
          }],
        },
      })

      expect(result.success).toBe(false)
      expect(capturedAdapterProviders).toEqual(['anthropic'])
      expect(capturedChatOptions.map(options => options.model)).toEqual([
        'primary-model',
        'primary-model',
      ])
    })

    it('fails over after a retryable provider error while onAgentStream is enabled', async () => {
      const streamedErrorKinds: Array<{ kind: string | undefined; retryable: boolean | undefined }> = []
      let defaultModelCalls = 0
      mockAdapterHandler = (options) => {
        if (options.model === 'primary-model') {
          return Object.assign(new Error('provider unavailable'), { status: 503 })
        }
        if (options.model === 'backup-model') return 'backup output'
        defaultModelCalls++
        return defaultModelCalls === 1
          ? '```json\n[{"title":"Fallback","description":"Recover from a provider outage","assignee":"worker-a","maxRetries":1,"retryDelayMs":0}]\n```'
          : 'final synthesis'
      }

      const oma = new OpenMultiAgent({
        defaultModel: 'default-model',
        onAgentStream: (_agentName, event) => {
          if (event.type === 'error') {
            streamedErrorKinds.push({
              kind: event.errorInfo?.kind,
              retryable: event.errorInfo?.retryable,
            })
          }
        },
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'default-worker-model' },
      ]))

      const result = await oma.runTeam(
        team,
        'First recover from the provider outage, then write a summary of the result',
        {
          modelRouting: {
            rules: [{
              match: { phase: 'worker' },
              route: {
                model: 'primary-model',
                provider: 'anthropic',
                fallback: [{ model: 'backup-model', provider: 'openai' }],
              },
            }],
          },
        },
      )

      expect(result.success).toBe(true)
      expect(capturedChatOptions
        .map(options => options.model)
        .filter(model => model === 'primary-model' || model === 'backup-model'))
        .toEqual(['primary-model', 'backup-model'])
      expect(streamedErrorKinds).toEqual([{ kind: 'provider', retryable: true }])
    })

    it('prices each fallback attempt with the route that handled it', async () => {
      const costContexts: CostEstimateContext[] = []
      mockAdapterHandler = (options) => {
        if (options.model === 'primary-model') {
          return Object.assign(new Error('rate limited'), { status: 429 })
        }
        return 'backup output'
      }

      const oma = new OpenMultiAgent({
        defaultModel: 'default-model',
        maxCostBudget: 100,
        estimateCost: (_usage, context) => {
          costContexts.push(context)
          return 1
        },
      })
      const team = oma.createTeam('t', teamCfg([
        agentConfig('worker-a'),
      ]))

      const result = await oma.runTasks(team, [
        {
          title: 'Fallback cost accounting',
          description: 'Price each attempt with its active route',
          assignee: 'worker-a',
          maxRetries: 1,
          retryDelayMs: 0,
        },
      ], {
        modelRouting: {
          rules: [{
            match: { phase: 'worker' },
            route: {
              model: 'primary-model',
              provider: 'anthropic',
              fallback: [{ model: 'backup-model', provider: 'openai' }],
            },
          }],
        },
      })

      expect(result.success).toBe(true)
      expect(costContexts.map(context => context.model)).toEqual([
        'primary-model',
        'backup-model',
      ])
      expect(costContexts.map(context => context.provider)).toEqual([
        'anthropic',
        'openai',
      ])
    })

    it('advances through ordered fallbacks and retries the final route after exhaustion', async () => {
      let finalRouteAttempts = 0
      mockAdapterHandler = (options) => {
        if (options.model === 'primary-model' || options.model === 'first-backup-model') {
          return Object.assign(new Error('provider unavailable'), { status: 503 })
        }
        finalRouteAttempts++
        return finalRouteAttempts === 1
          ? Object.assign(new Error('rate limited'), { status: 429 })
          : 'final backup output'
      }

      const oma = new OpenMultiAgent({ defaultModel: 'default-model' })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'default-worker-model' },
      ]))

      const result = await oma.runTasks(team, [
        {
          title: 'Multi-hop fallback',
          description: 'Use each backup route in order',
          assignee: 'worker-a',
          maxRetries: 3,
          retryDelayMs: 0,
        },
      ], {
        modelRouting: {
          rules: [{
            match: { phase: 'worker' },
            route: {
              model: 'primary-model',
              fallback: [
                { model: 'first-backup-model' },
                { model: 'final-backup-model' },
              ],
            },
          }],
        },
      })

      expect(result.success).toBe(true)
      expect(capturedChatOptions.map(options => options.model)).toEqual([
        'primary-model',
        'first-backup-model',
        'final-backup-model',
        'final-backup-model',
      ])
    })

    it('does not fail over after a terminal provider error', async () => {
      mockAdapterHandler = (options) => {
        if (options.model === 'primary-model') {
          return Object.assign(new Error('unauthorized'), { status: 401 })
        }
        return 'backup output'
      }

      const oma = new OpenMultiAgent({ defaultModel: 'default-model' })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'default-worker-model' },
      ]))

      const result = await oma.runTasks(team, [
        {
          title: 'Terminal error',
          description: 'Do not retry invalid credentials',
          assignee: 'worker-a',
          maxRetries: 1,
          retryDelayMs: 0,
        },
      ], {
        modelRouting: {
          rules: [{
            match: { phase: 'worker' },
            route: {
              model: 'primary-model',
              fallback: [{ model: 'backup-model' }],
            },
          }],
        },
      })

      expect(result.success).toBe(false)
      expect(capturedChatOptions.map(options => options.model)).toEqual(['primary-model'])
    })

    it('retries the current route when a task failure has no provider error', async () => {
      let afterRunCalls = 0
      const oma = new OpenMultiAgent({ defaultModel: 'default-model' })
      const team = oma.createTeam('t', teamCfg([
        {
          ...agentConfig('worker-a'),
          afterRun: (result) => {
            afterRunCalls++
            return afterRunCalls === 1 ? { ...result, success: false } : result
          },
        },
      ]))

      const result = await oma.runTasks(team, [
        {
          title: 'Unclassified failure',
          description: 'Retry without changing the active route',
          assignee: 'worker-a',
          maxRetries: 1,
          retryDelayMs: 0,
        },
      ], {
        modelRouting: {
          rules: [{
            match: { phase: 'worker' },
            route: {
              model: 'primary-model',
              fallback: [{ model: 'backup-model' }],
            },
          }],
        },
      })

      expect(result.success).toBe(true)
      expect(capturedChatOptions.map(options => options.model)).toEqual([
        'primary-model',
        'primary-model',
      ])
    })

    it('does not fail over after a retryable-looking beforeRun hook error', async () => {
      const hookModels: string[] = []
      let beforeRunCalls = 0
      const hookError = Object.assign(new Error('hook rate limited'), { status: 429 })
      const oma = new OpenMultiAgent({ defaultModel: 'default-model' })
      const team = oma.createTeam('t', teamCfg([
        {
          ...agentConfig('worker-a'),
          beforeRun: (context) => {
            hookModels.push(context.agent.model ?? '')
            beforeRunCalls++
            if (beforeRunCalls === 1) throw hookError
            return context
          },
        },
      ]))

      const result = await oma.runTasks(team, [
        {
          title: 'beforeRun hook error',
          description: 'Retry without changing the active route',
          assignee: 'worker-a',
          maxRetries: 1,
          retryDelayMs: 0,
        },
      ], {
        modelRouting: {
          rules: [{
            match: { phase: 'worker' },
            route: {
              model: 'primary-model',
              fallback: [{ model: 'backup-model' }],
            },
          }],
        },
      })

      expect(result.success).toBe(true)
      expect(hookModels).toEqual(['primary-model', 'primary-model'])
      expect(capturedChatOptions.map(options => options.model)).toEqual(['primary-model'])
    })

    it('does not fail over after a retryable-looking afterRun hook error', async () => {
      let afterRunCalls = 0
      const hookError = Object.assign(new Error('hook rate limited'), { status: 429 })
      const oma = new OpenMultiAgent({ defaultModel: 'default-model' })
      const team = oma.createTeam('t', teamCfg([
        {
          ...agentConfig('worker-a'),
          afterRun: (result) => {
            afterRunCalls++
            if (afterRunCalls === 1) throw hookError
            return result
          },
        },
      ]))

      const result = await oma.runTasks(team, [
        {
          title: 'afterRun hook error',
          description: 'Retry without changing the active route',
          assignee: 'worker-a',
          maxRetries: 1,
          retryDelayMs: 0,
        },
      ], {
        modelRouting: {
          rules: [{
            match: { phase: 'worker' },
            route: {
              model: 'primary-model',
              fallback: [{ model: 'backup-model' }],
            },
          }],
        },
      })

      expect(result.success).toBe(true)
      expect(capturedChatOptions.map(options => options.model)).toEqual([
        'primary-model',
        'primary-model',
      ])
    })
  })

  describe('defaultModel inheritance', () => {
    it('worker without its own model inherits OrchestratorConfig.defaultModel', async () => {
      mockAdapterResponses = ['worker output']

      const oma = new OpenMultiAgent({ defaultModel: 'inherited-default-model' })
      // Agent declares no model: it should inherit defaultModel, mirroring how
      // provider/baseURL/apiKey inherit their default* siblings.
      const team = oma.createTeam('t', teamCfg([
        { name: 'worker-a', provider: 'openai', systemPrompt: 'You are worker-a.' },
      ]))

      await oma.runTasks(team, [
        { title: 'Leaf', description: 'Do leaf work', assignee: 'worker-a' },
      ])

      expect(capturedChatOptions[0]?.model).toBe('inherited-default-model')
    })

    it('standalone Agent without a model throws at construction', () => {
      // No orchestrator to inherit defaultModel from, so model is mandatory.
      expect(
        () =>
          new Agent(
            { name: 'orphan', provider: 'openai', systemPrompt: 'x' },
            new ToolRegistry(),
            new ToolExecutor(new ToolRegistry()),
          ),
      ).toThrow(/has no model/)
    })
  })

  describe('runTeam', () => {
    it('runs coordinator decomposition + execution + synthesis', async () => {
      // Response 1: coordinator decomposition (returns JSON task array)
      // Response 2: worker-a executes task
      // Response 3: coordinator synthesis
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research the topic", "assignee": "worker-a"}]\n```',
        'Research results here',
        'Final synthesized answer based on research results',
      ]

      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onProgress: (e) => events.push(e),
      })
      const team = oma.createTeam('t', teamCfg())

      const result = await oma.runTeam(team, 'First research AI safety best practices, then write a comprehensive implementation guide')

      expect(result.success).toBe(true)
      // Should have coordinator result
      expect(result.agentResults.has('coordinator')).toBe(true)
    })

    it('repairs a coordinator-generated cyclic DAG before dispatch', async () => {
      mockAdapterResponses = [
        '```json\n[{"title":"Task A","description":"Do A","assignee":"worker-a","dependsOn":["Task B"]},{"title":"Task B","description":"Do B","assignee":"worker-b","dependsOn":["Task A"]}]\n```',
        '```json\n[{"title":"Research","description":"Research the topic","assignee":"worker-a"}]\n```',
        'research output',
        'final answer',
      ]
      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onProgress: (event) => events.push(event),
      })
      const team = oma.createTeam('t', teamCfg())

      const result = await oma.runTeam(
        team,
        'First research the topic, then produce a detailed report with recommendations.',
      )

      expect(result.success).toBe(true)
      expect(result.tasks).toHaveLength(1)
      expect(capturedPrompts).toHaveLength(4)
      expect(events.some((event) => event.type === 'error')).toBe(false)
    })

    it('fails closed when coordinator output remains unparseable after repair', async () => {
      mockAdapterResponses = [
        'I cannot produce JSON output', // invalid coordinator output
        'Still not JSON', // repair also fails
      ]

      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onProgress: (event) => events.push(event),
      })
      const team = oma.createTeam('t', teamCfg())

      const result = await oma.runTeam(team, 'First design the database schema, then implement the REST API endpoints')

      expect(result.success).toBe(false)
      expect(result.status?.code).toBe('error')
      expect(result.errorInfo).toMatchObject({ kind: 'validation', code: 'COORDINATOR_PLAN_INVALID' })
      expect(result.tasks).toEqual([])
      expect(capturedPrompts).toHaveLength(2)
      expect(events).toContainEqual(expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ code: 'COORDINATOR_PLAN_INVALID' }),
      }))
    })

    it('rejects a partially malformed coordinator plan instead of executing its valid subset', async () => {
      const malformedPlan = '```json\n[' +
        '{"title":"Research","description":"Research the topic","assignee":"worker-a"},' +
        '{"title":"Broken","assignee":"worker-b"}' +
        ']\n```'
      mockAdapterResponses = [malformedPlan, malformedPlan]

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      const result = await oma.runTeam(
        team,
        'First research the topic, then produce a detailed report with recommendations.',
      )

      expect(result.success).toBe(false)
      expect(result.tasks).toEqual([])
      expect(capturedPrompts).toHaveLength(2)
    })

    it('uses schedulingStrategy for unassigned coordinator tasks', async () => {
      mockAdapterResponses = [
        '```json\n[{"title":"Implement TypeScript service","description":"Implement software code"},{"title":"Research market analysis","description":"Research and analyze market evidence"}]\n```',
        'worker result',
        'worker result',
        'synthesis',
      ]

      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        schedulingStrategy: 'capability-match',
        onProgress: (event) => events.push(event),
      })
      const team = oma.createTeam('t', teamCfg([
        {
          ...agentConfig('researcher'),
          systemPrompt: 'Research markets and analyze evidence.',
        },
        {
          ...agentConfig('coder'),
          systemPrompt: 'Implement TypeScript software services.',
        },
      ]))

      const result = await oma.runTeam(
        team,
        'First implement the service, then research the market and synthesize both results.',
      )

      const assignments = Object.fromEntries(
        events
          .filter((event) => event.type === 'task_start')
          .map((event) => [(event.data as { title: string }).title, event.agent]),
      )
      expect(result.success).toBe(true)
      expect(assignments).toEqual({
        'Implement TypeScript service': 'coder',
        'Research market analysis': 'researcher',
      })
    })

    it('passes schedulingWeights from OrchestratorConfig into composite scheduling', async () => {
      mockAdapterResponses = [
        '```json\n[{"title":"Implement TypeScript","description":"Implement TypeScript service"}]\n```',
      ]
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        schedulingStrategy: 'composite',
        schedulingWeights: { fit: 0, load: 1 },
      })
      const team = oma.createTeam('t', teamCfg([
        agentConfig('aaa-idle'),
        {
          ...agentConfig('coder'),
          capabilities: ['typescript'],
        },
      ]))

      const result = await oma.runTeam(
        team,
        'First implement the TypeScript service, then document the result.',
        { planOnly: true },
      )

      expect(result.success).toBe(true)
      expect(result.tasks?.[0]?.assignee).toBe('aaa-idle')
    })

    it('rejects a coordinator plan with unsatisfied requirements before planOnly succeeds', async () => {
      mockAdapterResponses = [
        '```json\n[{"title":"Restricted","description":"Restricted task","requires":{"requiredCapabilities":["missing"]}}]\n```',
      ]
      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        schedulingStrategy: 'composite',
        onProgress: (event) => events.push(event),
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker-a')]))

      const result = await oma.runTeam(
        team,
        'First complete the restricted task, then document the outcome.',
        { planOnly: true },
      )

      expect(result.success).toBe(false)
      expect(result.errorInfo).toMatchObject({
        kind: 'validation',
        code: 'INVALID_TASK_REQUIREMENTS',
      })
      expect(result.tasks).toEqual([])
      expect(events).toContainEqual(expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({
          code: 'INVALID_TASK_REQUIREMENTS',
          issues: [
            expect.objectContaining({ code: 'NO_ELIGIBLE_AGENT' }),
          ],
        }),
      }))
      expect(capturedPrompts).toHaveLength(1)
    })

    it('rejects a coordinator assignee that conflicts with hard requirements', async () => {
      mockAdapterResponses = [
        '```json\n[{"title":"Edit","description":"Edit a file","assignee":"reader","requires":{"requiredTools":["file_edit"]}}]\n```',
      ]
      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('reader'), tools: ['file_read'] },
        { ...agentConfig('editor'), tools: ['file_edit'] },
      ]))

      const result = await oma.runTeam(
        team,
        'First edit the file, then review the result.',
        { planOnly: true },
      )

      expect(result.success).toBe(false)
      expect(result.errorInfo).toMatchObject({
        kind: 'validation',
        code: 'INVALID_TASK_REQUIREMENTS',
      })
      expect(capturedPrompts).toHaveLength(1)
    })

    it('warns and schedules a coordinator task with an invalid assignee only when legacy reassignment is explicit', async () => {
      mockAdapterResponses = [
        '```json\n[{"title":"Research","description":"Research the topic","assignee":"ghost"}]\n```',
      ]
      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        strictAssignees: false,
        onProgress: (event) => events.push(event),
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker-a')]))

      const result = await oma.runTeam(
        team,
        'First research the topic, then prepare a detailed implementation plan.',
        { planOnly: true },
      )

      expect(result.success).toBe(true)
      expect(result.tasks?.[0]?.assignee).toBe('worker-a')
      expect(events).toContainEqual({
        type: 'warning',
        task: 'Research',
        data: {
          code: 'INVALID_ASSIGNEE',
          assignee: 'ghost',
          taskTitle: 'Research',
          fallback: 'clear-and-schedule',
        },
      })
    })

    it('returns a structured validation error for an invalid assignee by default', async () => {
      mockAdapterResponses = [
        '```json\n[{"title":"Research","description":"Research the topic","assignee":"ghost"}]\n```',
        '```json\n[{"title":"Research","description":"Research the topic","assignee":"ghost"}]\n```',
      ]
      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onProgress: (event) => events.push(event),
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker-a')]))

      const result = await oma.runTeam(
        team,
        'First research the topic, then prepare a detailed implementation plan.',
        { planOnly: true },
      )

      expect(result.success).toBe(false)
      expect(result.status?.code).toBe('error')
      expect(result.errorInfo).toMatchObject({
        kind: 'validation',
        code: 'COORDINATOR_PLAN_INVALID',
      })
      expect(result.tasks).toEqual([])
      expect(events).toContainEqual(expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ code: 'COORDINATOR_PLAN_INVALID' }),
      }))
    })

    it('supports coordinator model override without affecting workers', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker-a"}]\n```',
        'worker output',
        'final synthesis',
      ]

      const oma = new OpenMultiAgent({
        defaultModel: 'expensive-model',
        defaultProvider: 'openai',
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'worker-model' },
      ]))

      const result = await oma.runTeam(team, 'First research the topic, then synthesize findings', {
        coordinator: { model: 'cheap-model' },
      })

      expect(result.success).toBe(true)
      expect(capturedChatOptions.length).toBe(3)
      expect(capturedChatOptions[0]?.model).toBe('cheap-model')
      expect(capturedChatOptions[1]?.model).toBe('worker-model')
      expect(capturedChatOptions[2]?.model).toBe('cheap-model')
    })

    it('appends coordinator.instructions to the default system prompt', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Plan", "description": "Plan", "assignee": "worker-a"}]\n```',
        'done',
        'final',
      ]

      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        defaultProvider: 'openai',
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'worker-model' },
      ]))

      await oma.runTeam(team, 'First implement, then verify', {
        coordinator: {
          instructions: 'Always create a testing task after implementation tasks.',
        },
      })

      const coordinatorPrompt = capturedChatOptions[0]?.systemPrompt ?? ''
      expect(coordinatorPrompt).toContain('You are a task coordinator responsible')
      expect(coordinatorPrompt).toContain('## Additional Instructions')
      expect(coordinatorPrompt).toContain('Always create a testing task after implementation tasks.')
    })

    it('uses coordinator.systemPrompt override while still appending required sections', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Plan", "description": "Plan", "assignee": "worker-a"}]\n```',
        'done',
        'final',
      ]

      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        defaultProvider: 'openai',
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'worker-model' },
      ]))

      await oma.runTeam(team, 'First implement, then verify', {
        coordinator: {
          systemPrompt: 'You are a custom coordinator for monorepo planning.',
        },
      })

      const coordinatorPrompt = capturedChatOptions[0]?.systemPrompt ?? ''
      expect(coordinatorPrompt).toContain('You are a custom coordinator for monorepo planning.')
      expect(coordinatorPrompt).toContain('## Team Roster')
      expect(coordinatorPrompt).toContain('## Output Format')
      expect(coordinatorPrompt).toContain('## When synthesising results')
      expect(coordinatorPrompt).not.toContain('You are a task coordinator responsible')
    })

    it('applies advanced coordinator options (maxTokens, temperature, tools, disallowedTools)', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Inspect", "description": "Inspect", "assignee": "worker-a"}]\n```',
        'worker output',
        'final synthesis',
      ]

      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        defaultProvider: 'openai',
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'worker-model' },
      ]))

      await oma.runTeam(team, 'First inspect project, then produce output', {
        coordinator: {
          maxTurns: 5,
          maxTokens: 1234,
          temperature: 0,
          tools: ['file_read', 'grep'],
          disallowedTools: ['grep'],
          timeoutMs: 1500,
          loopDetection: { maxRepetitions: 2, loopDetectionWindow: 3 },
        },
      })

      expect(capturedChatOptions[0]?.maxTokens).toBe(1234)
      expect(capturedChatOptions[0]?.temperature).toBe(0)
      expect(capturedChatOptions[0]?.tools).toBeDefined()
      expect(capturedChatOptions[0]?.tools?.map((t) => t.name)).toContain('file_read')
      expect(capturedChatOptions[0]?.tools?.map((t) => t.name)).not.toContain('grep')
    })

    it('supports coordinator.toolPreset and intersects with tools allowlist', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Inspect", "description": "Inspect", "assignee": "worker-a"}]\n```',
        'worker output',
        'final synthesis',
      ]

      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        defaultProvider: 'openai',
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'worker-model' },
      ]))

      await oma.runTeam(team, 'First inspect project, then produce output', {
        coordinator: {
          toolPreset: 'readonly',
          tools: ['file_read', 'bash'],
        },
      })

      const coordinatorToolNames = capturedChatOptions[0]?.tools?.map((t) => t.name) ?? []
      expect(coordinatorToolNames).toContain('file_read')
      expect(coordinatorToolNames).not.toContain('bash')
    })

    it('omits team-context block by default (revealCoordinator unset)', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research the topic", "assignee": "worker-a"}]\n```',
        'worker output',
        'final synthesis',
      ]

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      await oma.runTeam(team, 'First research the topic, then synthesize findings')

      // None of the captured prompts (coordinator decompose, worker run, coordinator synthesis)
      // should contain the team-context header when the option is unset.
      for (const prompt of capturedPrompts) {
        expect(prompt).not.toContain('## Team context')
      }
    })

    it('injects team-context block when revealCoordinator is true', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research the topic", "assignee": "worker-a"}]\n```',
        'worker output',
        'final synthesis',
      ]

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      const goal = 'First research the topic, then synthesize findings'
      await oma.runTeam(team, goal, { revealCoordinator: true })

      // The worker prompt (second captured prompt) should contain the full context block.
      // capturedPrompts[0] = coordinator decomposition, [1] = worker run, [2] = coordinator synthesis.
      const workerPrompt = capturedPrompts[1] ?? ''
      expect(workerPrompt).toContain('## Team context')
      expect(workerPrompt).toContain(`Goal: ${goal}`)
      expect(workerPrompt).toContain('Team: worker-a, worker-b')
      expect(workerPrompt).toContain('Your role in this team: worker-a')
      expect(workerPrompt).toContain('Assignment: You are responsible')
      expect(workerPrompt).not.toContain('Coordinator: selected you')
      // Defensive: the original task block must still be present after the context block.
      expect(workerPrompt).toContain('# Task: Research')

      // Defensive: coordinator's own prompts (decompose + synthesis) must NOT carry the
      // team-context block — they don't go through buildTaskPrompt today, and we want
      // a future refactor that changes that to break this test.
      expect(capturedPrompts[0]).not.toContain('## Team context')
      expect(capturedPrompts[2]).not.toContain('## Team context')
    })

    it('injects team-context block into delegated worker prompts when revealCoordinator is true', async () => {
      const goal = 'First coordinate worker-a, then have worker-a delegate details to worker-b'
      const delegatedPrompts: string[] = []
      let coordinatorCalls = 0
      let workerACalls = 0

      const coordinatorAdapter: LLMAdapter = {
        name: 'coordinator-mock',
        async chat(): Promise<LLMResponse> {
          coordinatorCalls++
          return coordinatorCalls === 1
            ? textResponse('```json\n[{"title": "Delegate detail", "description": "Ask worker-b for details", "assignee": "worker-a"}]\n```')
            : textResponse('final synthesis')
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }
      const workerAAdapter: LLMAdapter = {
        name: 'worker-a-mock',
        async chat(): Promise<LLMResponse> {
          workerACalls++
          return workerACalls === 1
            ? toolUseResponse('delegate_to_agent', {
                target_agent: 'worker-b',
                prompt: 'Inspect delegated detail',
              })
            : textResponse('worker-a done')
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }
      const workerBAdapter: LLMAdapter = {
        name: 'worker-b-mock',
        async chat(messages: LLMMessage[]): Promise<LLMResponse> {
          delegatedPrompts.push(extractUserPrompt(messages))
          return textResponse('worker-b delegated done')
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model', maxConcurrency: 3 })
      const team = oma.createTeam('t', teamCfg([
        {
          ...agentConfig('worker-a'),
          adapter: workerAAdapter,
          tools: ['delegate_to_agent'],
          maxTurns: 3,
        },
        { ...agentConfig('worker-b'), adapter: workerBAdapter },
      ]))

      await oma.runTeam(team, goal, {
        coordinator: { adapter: coordinatorAdapter },
        revealCoordinator: true,
      })

      expect(delegatedPrompts).toHaveLength(1)
      const delegatedPrompt = delegatedPrompts[0] ?? ''
      expect(delegatedPrompt).toContain('## Team context')
      expect(delegatedPrompt).toContain(`Goal: ${goal}`)
      expect(delegatedPrompt).toContain('Team: worker-a, worker-b')
      expect(delegatedPrompt).toContain('Your role in this team: worker-b')
      expect(delegatedPrompt).toContain('Assignment: You are responsible')
      expect(delegatedPrompt).toContain('Inspect delegated detail')
      expect(delegatedPrompt).not.toContain('Coordinator: selected you')
    })

    it('does not run final synthesis when abortSignal is aborted after task execution', async () => {
      const controller = new AbortController()
      let coordinatorCalls = 0
      const coordinatorAdapter: LLMAdapter = {
        name: 'coordinator-mock',
        async chat(): Promise<LLMResponse> {
          coordinatorCalls++
          return coordinatorCalls === 1
            ? textResponse('```json\n[{"title": "Work", "description": "Do work", "assignee": "worker"}]\n```')
            : textResponse('unexpected synthesis')
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }
      const workerAdapter: LLMAdapter = {
        name: 'worker-mock',
        async chat(): Promise<LLMResponse> {
          controller.abort()
          return textResponse('worker output')
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker'), adapter: workerAdapter },
      ]))

      const result = await oma.runTeam(team, 'First do the work, then synthesize the result', {
        coordinator: { adapter: coordinatorAdapter },
        abortSignal: controller.signal,
      })

      expect(coordinatorCalls).toBe(1)
      expect(result.tasks?.[0]?.status).toBe('completed')
      expect(result.agentResults.get('worker')?.output).toBe('worker output')
    })

    it('fails closed when coordinator dependencies remain unknown after repair', async () => {
      let coordinatorCalls = 0
      let workerCalls = 0
      const coordinatorAdapter: LLMAdapter = {
        name: 'coordinator-mock',
        async chat(): Promise<LLMResponse> {
          coordinatorCalls++
          return textResponse('```json\n[{"title": "Use missing", "description": "Use a missing result", "assignee": "worker", "dependsOn": ["Missing research"]}]\n```')
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }
      const workerAdapter: LLMAdapter = {
        name: 'worker-mock',
        async chat(): Promise<LLMResponse> {
          workerCalls++
          return textResponse('should not run')
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker'), adapter: workerAdapter },
      ]))

      const result = await oma.runTeam(team, 'First resolve dependencies, then produce output', {
        coordinator: { adapter: coordinatorAdapter },
      })

      expect(result.success).toBe(false)
      expect(result.tasks).toEqual([])
      expect(coordinatorCalls).toBe(2)
      expect(workerCalls).toBe(0)
    })

    it('fails closed when duplicate coordinator task titles remain ambiguous after repair', async () => {
      let coordinatorCalls = 0
      const coordinatorAdapter: LLMAdapter = {
        name: 'coordinator-mock',
        async chat(): Promise<LLMResponse> {
          coordinatorCalls++
          return textResponse([
                '```json',
                '[',
                '{"title": "Research", "description": "Research A", "assignee": "worker-a"},',
                '{"title": "Research", "description": "Research B", "assignee": "worker-b"},',
                '{"title": "Synthesize", "description": "Use research", "assignee": "worker-a", "dependsOn": ["Research"]}',
                ']',
                '```',
              ].join('\n'))
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      const result = await oma.runTeam(team, 'First research in parallel, then synthesize', {
        coordinator: { adapter: coordinatorAdapter },
      })

      expect(result.success).toBe(false)
      expect(result.tasks).toEqual([])
      expect(coordinatorCalls).toBe(2)
    })

    it('includes failed and skipped task sections in final synthesis prompt', async () => {
      let coordinatorCalls = 0
      let synthesisPrompt = ''
      const coordinatorAdapter: LLMAdapter = {
        name: 'coordinator-mock',
        async chat(messages: LLMMessage[]): Promise<LLMResponse> {
          coordinatorCalls++
          if (coordinatorCalls === 1) {
            return textResponse([
              '```json',
              '[',
              '{"title": "Failing task", "description": "This fails", "assignee": "worker-a"},',
              '{"title": "Successful task", "description": "This succeeds", "assignee": "worker-b"},',
              '{"title": "Later task", "description": "Runs after success", "assignee": "worker-b", "dependsOn": ["Successful task"]}',
              ']',
              '```',
            ].join('\n'))
          }
          synthesisPrompt = extractUserPrompt(messages)
          return textResponse('final with caveats')
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }
      const failingAdapter: LLMAdapter = {
        name: 'failing-worker',
        async chat(): Promise<LLMResponse> {
          throw new Error('worker failed')
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }
      const successAdapter: LLMAdapter = {
        name: 'success-worker',
        async chat(): Promise<LLMResponse> {
          return textResponse('success output')
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }

      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onApproval: async () => false,
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), adapter: failingAdapter },
        { ...agentConfig('worker-b'), adapter: successAdapter },
      ]))

      await oma.runTeam(team, 'First run independent work, then review the remaining step', {
        coordinator: { adapter: coordinatorAdapter },
      })

      expect(synthesisPrompt).toContain('## Failed Tasks')
      expect(synthesisPrompt).toContain('### Failing task (FAILED)')
      expect(synthesisPrompt).toContain('worker failed')
      expect(synthesisPrompt).toContain('## Skipped Tasks')
      expect(synthesisPrompt).toContain('### Later task (SKIPPED)')
      expect(synthesisPrompt).toContain('Skipped: approval rejected.')
    })

    it('computes run-level metrics from mixed completed and failed tasks', async () => {
      let coordinatorCalls = 0
      const coordinatorAdapter: LLMAdapter = {
        name: 'coordinator-mock',
        async chat(messages: LLMMessage[]): Promise<LLMResponse> {
          coordinatorCalls++
          if (coordinatorCalls === 1) {
            return textResponse([
              '```json',
              '[',
              '{"title": "Task A", "description": "Fails", "assignee": "worker-a"},',
              '{"title": "Task B", "description": "Succeeds", "assignee": "worker-b"}',
              ']',
              '```',
            ].join('\n'))
          }
          return textResponse('final synthesis')
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }
      const failingAdapter: LLMAdapter = {
        name: 'failing-worker',
        async chat(): Promise<LLMResponse> {
          throw new Error('task failed')
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }
      const successAdapter: LLMAdapter = {
        name: 'success-worker',
        async chat(): Promise<LLMResponse> {
          return textResponse('success output')
        },
        async *stream() { yield { type: 'done' as const, data: {} } },
      }

      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onApproval: async () => false,
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), adapter: failingAdapter },
        { ...agentConfig('worker-b'), adapter: successAdapter },
      ]))

      const result = await oma.runTeam(team, 'First run the failing task, then run the successful task', {
        coordinator: { adapter: coordinatorAdapter },
      })

      expect(result.metrics).toBeDefined()
      const m = result.metrics!
      expect(m.failureCount).toBe(1)
      expect(m.errorCount).toBeGreaterThanOrEqual(1)
      expect(m.completedCount).toBe(1)
      expect(m.totalRetries).toBe(0)
      expect(m.totalTokens.input_tokens).toBeGreaterThanOrEqual(0)
      expect(m.totalTokens.output_tokens).toBeGreaterThanOrEqual(0)
      expect(m.minTaskDurationMs).toBeDefined()
      expect(m.maxTaskDurationMs).toBeDefined()
      expect(typeof m.avgTaskDurationMs).toBe('number')
      expect(m.avgTaskDurationMs).toBeGreaterThanOrEqual(0)
      expect(m.totalDurationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('config defaults', () => {
    it('uses default model and provider', () => {
      const oma = new OpenMultiAgent()
      const status = oma.getStatus()
      expect(status).toBeDefined()
    })

    it('accepts custom config', () => {
      const oma = new OpenMultiAgent({
        maxConcurrency: 3,
        defaultModel: 'custom-model',
        defaultProvider: 'openai',
      })
      expect(oma.getStatus().teams).toBe(0)
    })
  })

  describe('onApproval gate', () => {
    it('skips remaining tasks when approval rejects', async () => {
      mockAdapterResponses = ['first done', 'should not run']

      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onApproval: async () => false, // reject all
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTasks(team, [
        { title: 'First', description: 'Do first', assignee: 'worker' },
        { title: 'Second', description: 'Do second', assignee: 'worker', dependsOn: ['First'] },
      ])

      // The first task succeeded; the second was skipped after an explicit
      // approval rejection. OBS-1A reports the top-level run as rejected.
      expect(result.success).toBe(false)
      expect(result.status?.code).toBe('rejected')
      // But we should have fewer agent results than tasks
      expect(result.agentResults.size).toBeLessThanOrEqual(1)
    })
  })

  describe('onPlanReady gate', () => {
    const complexGoal = 'First research the topic, then write a comprehensive guide based on the findings'

    it('emits plan_ready trace even when onPlanReady callback is not configured', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
        'worker output',
        'final synthesis',
      ]
      const traces: TraceEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onTrace: (event) => { traces.push(event) },
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal)

      expect(result.success).toBe(true)
      const planReadyTraces = traces.filter((t) => t.type === 'plan_ready')
      expect(planReadyTraces).toHaveLength(1)
      const planReady = planReadyTraces[0]!
      expect(planReady.type).toBe('plan_ready')
      expect(planReady.taskCount).toBe(1)
      expect(planReady.approved).toBe(true)
      expect(planReady.runId).toMatch(/.+/)
    })

    it('aborts when callback returns false, preserving coordinator token usage', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
      ]
      const onPlanReadySpy = vi.fn().mockResolvedValue(false)
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onPlanReady: onPlanReadySpy,
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal)

      expect(result.success).toBe(false)
      expect(result.agentResults.has('coordinator')).toBe(true)
      expect(result.totalTokenUsage.input_tokens).toBe(10)
      expect(result.totalTokenUsage.output_tokens).toBe(20)
      expect(onPlanReadySpy).toHaveBeenCalledTimes(1)
    })

    it('aborts when callback throws, treating it as a controlled abort', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
      ]
      const onPlanReadySpy = vi.fn().mockRejectedValue(new Error('boom'))
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onPlanReady: onPlanReadySpy,
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal)

      expect(result.success).toBe(false)
      expect(result.agentResults.has('coordinator')).toBe(true)
      expect(result.totalTokenUsage.input_tokens).toBe(10)
      expect(result.totalTokenUsage.output_tokens).toBe(20)
      expect(onPlanReadySpy).toHaveBeenCalledTimes(1)
    })

    it('proceeds when callback returns true, receiving the decomposed plan', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
        'worker output',
        'final synthesis',
      ]
      const onPlanReadySpy = vi.fn().mockResolvedValue(true)
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onPlanReady: onPlanReadySpy,
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal)

      expect(result.success).toBe(true)
      expect(result.agentResults.has('worker')).toBe(true)
      expect(result.agentResults.has('coordinator')).toBe(true)
      expect(onPlanReadySpy).toHaveBeenCalledTimes(1)
      const tasksArg = onPlanReadySpy.mock.calls[0]?.[0] as { title: string }[] | undefined
      expect(Array.isArray(tasksArg)).toBe(true)
      expect(tasksArg).toHaveLength(1)
      expect(tasksArg?.[0]?.title).toBe('Research')
    })

    it('emits plan_ready trace with approval decision', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
      ]
      const traces: TraceEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onTrace: (event) => { traces.push(event) },
        onPlanReady: async () => false,
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal)

      expect(result.success).toBe(false)
      const planReadyTraces = traces.filter((t) => t.type === 'plan_ready')
      expect(planReadyTraces).toHaveLength(1)
      const planReady = planReadyTraces[0]!
      expect(planReady.type).toBe('plan_ready')
      expect(planReady.agent).toBe('coordinator')
      expect(planReady.taskCount).toBe(1)
      expect(planReady.approved).toBe(false)
      expect(planReady.runId).toMatch(/.+/)
      expect(planReady.spanId).toMatch(/^[0-9a-f-]{36}$/)
      expect(planReady.durationMs).toBeGreaterThanOrEqual(0)
      expect(planReady.startMs).toBeLessThanOrEqual(planReady.endMs)

      const coordinatorTrace = traces.find((t) => t.type === 'agent' && t.agent === 'coordinator')
      expect(coordinatorTrace).toBeDefined()
      expect(planReady.parentId).toBe(coordinatorTrace!.spanId)
    })
  })

  describe('planOnly mode', () => {
    const complexGoal = 'First research the topic, then write a comprehensive guide based on the findings'

    it('returns the decomposed plan without executing tasks', async () => {
      mockAdapterResponses = [
        '```json\n[' +
          '{"title": "Research", "description": "Research the topic", "assignee": "worker"},' +
          '{"title": "Write", "description": "Write the guide", "assignee": "worker", "dependsOn": ["Research"]}' +
          ']\n```',
        'should-not-be-called-1',
        'should-not-be-called-2',
      ]
      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal, { planOnly: true })

      expect(result.success).toBe(true)
      expect(result.planOnly).toBe(true)
      expect(result.tasks).toBeDefined()
      expect(result.tasks!.length).toBe(2)

      // Plan artifacts expose every task as pending, including tasks whose
      // dependencies will block them once execution begins.
      for (const task of result.tasks!) {
        expect(task.status).toBe('pending')
        expect(task.metrics).toBeUndefined()
      }

      const taskIds = new Set(result.tasks!.map((t) => t.id))
      for (const task of result.tasks!) {
        for (const dep of task.dependsOn) {
          expect(taskIds.has(dep)).toBe(true)
        }
      }

      expect(result.agentResults.size).toBe(1)
      expect(result.agentResults.has('coordinator')).toBe(true)
      expect(result.totalTokenUsage.input_tokens).toBe(10)
      expect(result.totalTokenUsage.output_tokens).toBe(20)

      // Only the coordinator should have been called.
      expect(capturedChatOptions.length).toBe(1)
    })

    it('still fires onPlanReady when planOnly is true', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
      ]
      const onPlanReadySpy = vi.fn().mockResolvedValue(true)
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onPlanReady: onPlanReadySpy,
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal, { planOnly: true })

      expect(onPlanReadySpy).toHaveBeenCalledTimes(1)
      const tasksArg = onPlanReadySpy.mock.calls[0]?.[0] as { title: string }[] | undefined
      expect(Array.isArray(tasksArg)).toBe(true)
      expect(tasksArg).toHaveLength(1)
      expect(tasksArg?.[0]?.title).toBe('Research')
      expect(result.success).toBe(true)
      expect(result.planOnly).toBe(true)
    })

    it('honors onPlanReady rejection over planOnly', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
      ]
      const onPlanReadySpy = vi.fn().mockResolvedValue(false)
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onPlanReady: onPlanReadySpy,
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal, { planOnly: true })

      expect(result.success).toBe(false)
      expect(result.planOnly).toBeUndefined()
      expect(onPlanReadySpy).toHaveBeenCalledTimes(1)
    })

    it('bypasses simple-goal short-circuit when planOnly is true', async () => {
      const simpleGoal = 'summarize this document'
      mockAdapterResponses = [
        '```json\n[{"title": "Summarize", "description": "Summarize", "assignee": "worker"}]\n```',
      ]
      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, simpleGoal, { planOnly: true })

      expect(result.planOnly).toBe(true)
      expect(result.success).toBe(true)
      expect(result.tasks).toBeDefined()
      expect(result.tasks!.length).toBeGreaterThan(0)
      expect(result.agentResults.has('coordinator')).toBe(true)
      // Exactly one chat call — the coordinator. The simple-goal short-circuit
      // would have called the worker directly instead.
      expect(capturedChatOptions.length).toBe(1)
    })

    it('emits balanced agent_start / agent_complete for the coordinator when planOnly is true', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
      ]
      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onProgress: (e) => events.push(e),
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      await oma.runTeam(team, complexGoal, { planOnly: true })

      const coordinatorEvents = events.filter((e) => e.agent === 'coordinator')
      const types = coordinatorEvents.map((e) => e.type)
      expect(types).toContain('agent_start')
      expect(types).toContain('agent_complete')
      expect(types.filter((t) => t === 'agent_start').length).toBe(
        types.filter((t) => t === 'agent_complete').length,
      )
    })

    it('creates a serializable artifact from planOnly output and replays without coordinator', async () => {
      mockAdapterResponses = [
        '```json\n[' +
          '{"title": "Research", "description": "Research the topic", "assignee": "worker-a"},' +
          '{"title": "Write", "description": "Write the guide", "assignee": "worker-b", "dependsOn": ["Research"]}' +
          ']\n```',
      ]
      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      const planOnlyResult = await oma.runTeam(team, complexGoal, { planOnly: true })
      const plan = oma.createPlanArtifact(planOnlyResult)

      expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
      expect(plan.goal).toBe(complexGoal)
      expect(plan.tasks).toHaveLength(2)
      expect(plan.tasks[0]).toMatchObject({ title: 'Research', description: 'Research the topic', assignee: 'worker-a' })
      expect(plan.tasks[1]?.dependsOn).toEqual([plan.tasks[0]?.id])

      capturedChatOptions = []
      capturedPrompts = []
      mockAdapterResponses = ['research done', 'write done', 'coordinator should not be called']

      const replay = await oma.runFromPlan(team, plan)

      expect(replay.success).toBe(true)
      expect(replay.goal).toBe(complexGoal)
      expect(capturedChatOptions).toHaveLength(2)
      expect(replay.agentResults.has('coordinator')).toBe(false)
      expect(replay.tasks?.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        assignee: task.assignee,
        dependsOn: task.dependsOn,
      }))).toEqual(plan.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        assignee: task.assignee,
        dependsOn: task.dependsOn ?? [],
      })))
      expect(capturedPrompts[0]).toContain('# Task: Research')
      expect(capturedPrompts[1]).toContain('# Task: Write')
      expect(capturedPrompts[1]).toContain('### Research (by worker-a)')
      expect(capturedPrompts[1]).toContain('research done')
    })

    it('replays a persisted plan exactly without resolving dependencies by title', async () => {
      const executionOrder: string[] = []
      const adapter: LLMAdapter = {
        name: 'recording',
        async chat(messages) {
          const prompt = extractUserPrompt(messages)
          const title = prompt.includes('# Task: Second') ? 'second' : 'first'
          executionOrder.push(title)
          return textResponse(`${title} done`)
        },
        async *stream() {
          yield { type: 'done' as const, data: {} }
        },
      }
      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), adapter },
        { ...agentConfig('worker-b'), adapter },
      ]))
      const plan = {
        version: 1 as const,
        goal: 'persisted goal',
        tasks: [
          { id: 'stable-first-id', title: 'First', description: 'Do first', assignee: 'worker-a' },
          { id: 'stable-second-id', title: 'Second', description: 'Do second', assignee: 'worker-b', dependsOn: ['stable-first-id'] },
        ],
      }

      const replay = await oma.runFromPlan(team, plan)

      expect(replay.success).toBe(true)
      expect(executionOrder).toEqual(['first', 'second'])
      expect(replay.tasks?.map((task) => task.id)).toEqual(['stable-first-id', 'stable-second-id'])
      expect(replay.tasks?.[1]?.dependsOn).toEqual(['stable-first-id'])
      expect(replay.agentResults.has('coordinator')).toBe(false)
    })

    it('round-trips memoryScope and retry config through the plan artifact', async () => {
      mockAdapterResponses = [
        '```json\n[' +
          '{"title": "Deep dive", "description": "Investigate", "assignee": "worker-a", "memoryScope": "all", "maxRetries": 2, "retryDelayMs": 500, "retryBackoff": 3}' +
          ']\n```',
      ]
      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      const planOnlyResult = await oma.runTeam(team, complexGoal, { planOnly: true })
      const plan = oma.createPlanArtifact(planOnlyResult)

      // Execution config survives serialization into the artifact...
      expect(plan.tasks[0]).toMatchObject({
        memoryScope: 'all',
        maxRetries: 2,
        retryDelayMs: 500,
        retryBackoff: 3,
      })
      expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)

      // ...and replay applies it, surfacing it back on the task record.
      mockAdapterResponses = ['done']
      const replay = await oma.runFromPlan(team, plan)
      expect(replay.tasks?.[0]).toMatchObject({
        memoryScope: 'all',
        maxRetries: 2,
        retryDelayMs: 500,
        retryBackoff: 3,
      })
    })

    it('round-trips requirements and revalidates them before plan replay', async () => {
      mockAdapterResponses = [
        '```json\n[' +
          '{"title":"Typed work","description":"Implement TypeScript","assignee":"worker","requires":{"requiredCapabilities":["typescript"]}}' +
          ']\n```',
      ]
      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const planningTeam = oma.createTeam('planning', teamCfg([
        { ...agentConfig('worker'), capabilities: ['typescript'] },
      ]))

      const planOnlyResult = await oma.runTeam(planningTeam, complexGoal, { planOnly: true })
      const plan = oma.createPlanArtifact(planOnlyResult)
      expect(plan.tasks[0]?.requires).toEqual({
        requiredCapabilities: ['typescript'],
      })

      capturedPrompts = []
      const replayTeam = oma.createTeam('replay', teamCfg([
        agentConfig('worker'),
      ]))
      await expect(oma.runFromPlan(replayTeam, plan)).rejects.toMatchObject({
        code: 'INVALID_TASK_REQUIREMENTS',
      })
      expect(capturedPrompts).toEqual([])
    })
  })

  describe('stream trace events', () => {
    it('emits agent_stream trace events when onAgentStream is configured', async () => {
      const complexGoal = 'First research the topic, then write a comprehensive guide based on the findings'
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
        'worker output',
        'final synthesis',
      ]
      const traces: TraceEvent[] = []
      const streamedTypes: string[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onTrace: (event) => { traces.push(event) },
        onAgentStream: (_agentName, event) => { streamedTypes.push(event.type) },
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal)

      expect(result.success).toBe(true)
      expect(streamedTypes.length).toBeGreaterThan(0)

      const streamTraces = traces.filter((t) => t.type === 'agent_stream')
      expect(streamTraces.length).toBeGreaterThan(0)
      expect(streamTraces.some((t) => t.streamType === 'text')).toBe(true)
      expect(streamTraces.some((t) => t.streamType === 'done')).toBe(true)
      const workerAgentTrace = traces.find((t) => t.type === 'agent' && t.agent === 'worker' && t.taskId)
      expect(workerAgentTrace).toBeDefined()
      const taskTrace = traces.find((t) => t.type === 'task' && t.taskId === workerAgentTrace!.taskId)
      expect(taskTrace).toBeDefined()
      expect(workerAgentTrace!.parentId).toBe(taskTrace!.spanId)
      for (const trace of streamTraces) {
        expect(trace.agent).toBe('worker')
        expect(trace.taskId).toMatch(/.+/)
        expect(trace.runId).toMatch(/.+/)
        expect(trace.spanId).toMatch(/^[0-9a-f-]{36}$/)
        expect(trace.parentId).toBe(workerAgentTrace!.spanId)
        expect(trace.durationMs).toBe(0)
      }
    })

    it('invokes onAgentStream for runTasks, which shares runTeam\'s queue', async () => {
      mockAdapterResponses = ['worker output']
      const streamed: Array<{ agent: string; type: string }> = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onAgentStream: (agentName, event) => { streamed.push({ agent: agentName, type: event.type }) },
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTasks(team, [
        { title: 'Task A', description: 'Do A', assignee: 'worker' },
      ])

      expect(result.success).toBe(true)
      expect(streamed.length).toBeGreaterThan(0)
      expect(streamed.every((e) => e.agent === 'worker')).toBe(true)
      expect(streamed.some((e) => e.type === 'text')).toBe(true)
      expect(streamed.some((e) => e.type === 'done')).toBe(true)
    })

    it('does not invoke onAgentStream for runAgent, which never enters the queue', async () => {
      mockAdapterResponses = ['solo output']
      const streamed: string[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onAgentStream: (_agentName, event) => { streamed.push(event.type) },
      })

      const result = await oma.runAgent(agentConfig('solo'), 'Say hello')

      expect(result.success).toBe(true)
      expect(streamed).toEqual([])
    })
  })
})
