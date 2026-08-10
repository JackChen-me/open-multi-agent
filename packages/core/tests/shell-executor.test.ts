import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Agent } from '../src/agent/agent.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { bashTool, registerBuiltInTools } from '../src/tool/built-in/index.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { LocalShellExecutor } from '../src/shell.js'
import type {
  ShellExecOptions,
  ShellExecResult,
  ShellExecutor,
} from '../src/shell.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  ToolUseContext,
} from '../src/types.js'

function toolUse(
  id: string,
  command: string,
  options: { readonly timeout?: number; readonly cwd?: string } = {},
): LLMResponse {
  return {
    id: `response-${id}`,
    content: [{ type: 'tool_use', id, name: 'bash', input: { command, ...options } }],
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function parallelToolUse(commands: readonly string[]): LLMResponse {
  return {
    id: 'response-parallel',
    content: commands.map((command, index) => ({
      type: 'tool_use' as const,
      id: `parallel-${index}`,
      name: 'bash',
      input: { command },
    })),
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function text(value: string): LLMResponse {
  return {
    id: 'response-text',
    content: [{ type: 'text', text: value }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function scriptedAdapter(steps: LLMResponse[]): LLMAdapter {
  let index = 0
  return {
    name: 'mock',
    async chat(_messages: LLMMessage[], _options: LLMChatOptions): Promise<LLMResponse> {
      return steps[Math.min(index++, steps.length - 1)]!
    },
    async *stream() {
      /* unused */
    },
  }
}

function failingAdapter(error: Error): LLMAdapter {
  return {
    name: 'mock',
    async chat(): Promise<LLMResponse> {
      throw error
    },
    async *stream() {
      /* unused */
    },
  }
}

function toolThenFailure(first: LLMResponse, error: Error): LLMAdapter {
  let called = false
  return {
    name: 'mock',
    async chat(): Promise<LLMResponse> {
      if (!called) {
        called = true
        return first
      }
      throw error
    },
    async *stream() {
      /* unused */
    },
  }
}

function buildAgent(config: AgentConfig): Agent {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  return new Agent(config, registry, new ToolExecutor(registry))
}

function toolContext(overrides: Partial<ToolUseContext> = {}): ToolUseContext {
  return {
    agent: { name: 'test', role: 'test', model: 'mock-model' },
    ...overrides,
  }
}

function successfulExecutor(events: string[] = []): ShellExecutor {
  return {
    async start() {
      events.push('start')
    },
    async exec(command: string): Promise<ShellExecResult> {
      events.push(`exec:${command}`)
      return { stdout: command, stderr: '', exitCode: 0 }
    },
    async dispose() {
      events.push('dispose')
    },
  }
}

describe('ShellExecutor tool seam', () => {
  it('delegates command execution while preserving formatting and redaction', async () => {
    const exec = vi.fn(async (
      _command: string,
      _options: ShellExecOptions,
    ): Promise<ShellExecResult> => ({
      stdout: 'hello\nOPENAI_API_KEY=sk-outputsecretvalue1234567890',
      stderr: 'remote warning',
      exitCode: 7,
    }))
    const executor: ShellExecutor = { exec }

    const result = await bashTool.execute(
      { command: 'remote-command', cwd: '/remote/work', timeout: 234 },
      toolContext({ shellExecutor: executor }),
    )

    expect(exec).toHaveBeenCalledWith(
      'remote-command',
      expect.objectContaining({
        cwd: '/remote/work',
        timeoutMs: 234,
        abortSignal: expect.any(AbortSignal),
      }),
    )
    expect(result.isError).toBe(true)
    expect(result.data).toContain('hello')
    expect(result.data).toContain('--- stderr ---\nremote warning')
    expect(result.data).toContain('(exit code: 7)')
    expect(result.data).toContain('[redacted]')
    expect(result.data).not.toContain('sk-outputsecretvalue1234567890')
  })

  it('bounds an executor that ignores timeout and normalizes exit code 124', async () => {
    let receivedSignal: AbortSignal | undefined
    const executor: ShellExecutor = {
      exec: async (_command, options) => {
        receivedSignal = options.abortSignal
        return new Promise<ShellExecResult>(() => {})
      },
    }

    const result = await bashTool.execute(
      { command: 'hang', timeout: 5 },
      toolContext({ shellExecutor: executor }),
    )

    expect(receivedSignal?.aborted).toBe(true)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('124')
  })

  it('bounds an executor that ignores abort and normalizes exit code 130', async () => {
    const controller = new AbortController()
    const executor: ShellExecutor = {
      exec: async () => new Promise<ShellExecResult>(() => {}),
    }
    setTimeout(() => controller.abort(), 5)

    const result = await bashTool.execute(
      { command: 'hang', timeout: 5_000 },
      toolContext({ shellExecutor: executor, abortSignal: controller.signal }),
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('130')
  })

  it('maps executor rejection to redacted startup failure code 127', async () => {
    const executor: ShellExecutor = {
      async exec() {
        throw new Error('OPENAI_API_KEY=sk-rejectedsecretvalue1234567890')
      },
    }

    const result = await bashTool.execute(
      { command: 'cannot-start' },
      toolContext({ shellExecutor: executor }),
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('127')
    expect(result.data).toContain('[redacted]')
    expect(result.data).not.toContain('sk-rejectedsecretvalue1234567890')
  })
})

describe('LocalShellExecutor compatibility', () => {
  it('executes on the host and reports startup failure as 127', async () => {
    const executor = new LocalShellExecutor()
    const success = await executor.exec('printf local-ok', { timeoutMs: 1_000 })
    const startupFailure = await executor.exec('true', {
      cwd: join(tmpdir(), 'oma-shell-executor-directory-that-does-not-exist'),
      timeoutMs: 1_000,
    })

    expect(success).toEqual({ stdout: 'local-ok', stderr: '', exitCode: 0 })
    expect(startupFailure.exitCode).toBe(127)
  })

  it('preserves abort exit code 130', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)

    const result = await bashTool.execute(
      { command: 'sleep 5', timeout: 5_000 },
      toolContext({ abortSignal: controller.signal }),
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('130')
  })
})

describe('ShellExecutor lifecycle', () => {
  it('starts once, reuses the session across calls, and disposes on success', async () => {
    const events: string[] = []
    const agent = buildAgent({
      name: 'shell-agent',
      model: 'mock-model',
      adapter: scriptedAdapter([
        toolUse('tool-1', 'first'),
        toolUse('tool-2', 'second'),
        text('done'),
      ]),
      tools: ['bash'],
      shellExecutor: successfulExecutor(events),
    })

    const result = await agent.run('run both commands')

    expect(result.success).toBe(true)
    expect(events).toEqual(['start', 'exec:first', 'exec:second', 'dispose'])
  })

  it('disposes after provider failure', async () => {
    const events: string[] = []
    const agent = buildAgent({
      name: 'shell-agent',
      model: 'mock-model',
      adapter: toolThenFailure(
        toolUse('before-failure', 'started'),
        new Error('provider failed'),
      ),
      tools: ['bash'],
      shellExecutor: successfulExecutor(events),
    })

    const result = await agent.run('fail after start')

    expect(result.success).toBe(false)
    expect(result.output).toContain('provider failed')
    expect(events).toEqual(['start', 'exec:started', 'dispose'])
  })

  it('does not start a granted executor until bash is actually called', async () => {
    const events: string[] = []
    const agent = buildAgent({
      name: 'shell-agent',
      model: 'mock-model',
      adapter: failingAdapter(new Error('provider failed before tools')),
      tools: ['bash'],
      shellExecutor: successfulExecutor(events),
    })

    const result = await agent.run('fail before any tool call')

    expect(result.success).toBe(false)
    expect(events).toEqual([])
  })

  it('attempts disposal when start partially fails', async () => {
    const events: string[] = []
    const executor: ShellExecutor = {
      async start() {
        events.push('start')
        throw new Error('start failed')
      },
      async exec() {
        throw new Error('must not execute')
      },
      async dispose() {
        events.push('dispose')
      },
    }
    const agent = buildAgent({
      name: 'shell-agent',
      model: 'mock-model',
      adapter: scriptedAdapter([
        toolUse('start-failure', 'must-not-run'),
        text('handled'),
      ]),
      tools: ['bash'],
      shellExecutor: executor,
    })

    const result = await agent.run('fail during start')

    expect(result.success).toBe(true)
    expect(result.toolCalls[0]!.output).toContain('start failed')
    expect(events).toEqual(['start', 'dispose'])
  })

  it('surfaces disposal failure instead of reporting a clean run', async () => {
    const executor: ShellExecutor = {
      async start() {},
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      async dispose() {
        throw new Error('dispose failed')
      },
    }
    const agent = buildAgent({
      name: 'shell-agent',
      model: 'mock-model',
      adapter: scriptedAdapter([
        toolUse('before-dispose', 'run'),
        text('would have succeeded'),
      ]),
      tools: ['bash'],
      shellExecutor: executor,
    })

    const result = await agent.run('cleanup must count')

    expect(result.success).toBe(false)
    expect(result.output).toContain('dispose failed')
  })

  it('disposes the session after the tool-level timeout backstop fires', async () => {
    const events: string[] = []
    const executor: ShellExecutor = {
      async start() {
        events.push('start')
      },
      async exec() {
        events.push('exec')
        return new Promise<ShellExecResult>(() => {})
      },
      async dispose() {
        events.push('dispose')
      },
    }
    const agent = buildAgent({
      name: 'shell-agent',
      model: 'mock-model',
      adapter: scriptedAdapter([
        toolUse('timeout-tool', 'hang', { timeout: 5 }),
        text('recovered'),
      ]),
      tools: ['bash'],
      shellExecutor: executor,
    })

    const result = await agent.run('bound and clean up')

    expect(result.success).toBe(true)
    expect(result.toolCalls[0]!.output).toContain('124')
    expect(events).toEqual(['start', 'exec', 'dispose'])
  })

  it('does not dispatch a command when timeout fires during start', async () => {
    const events: string[] = []
    const executor: ShellExecutor = {
      async start() {
        events.push('start')
        await new Promise((resolve) => setTimeout(resolve, 20))
      },
      async exec() {
        events.push('exec')
        return { stdout: 'must not run', stderr: '', exitCode: 0 }
      },
      async dispose() {
        events.push('dispose')
      },
    }
    const agent = buildAgent({
      name: 'shell-agent',
      model: 'mock-model',
      adapter: scriptedAdapter([
        toolUse('start-timeout', 'late-command', { timeout: 5 }),
        text('recovered'),
      ]),
      tools: ['bash'],
      shellExecutor: executor,
    })

    const result = await agent.run('timeout while starting')

    expect(result.success).toBe(true)
    expect(result.toolCalls[0]!.output).toContain('124')
    expect(events).toEqual(['start', 'dispose'])
  })

  it('disposes when a streaming consumer stops early', async () => {
    const events: string[] = []
    const agent = buildAgent({
      name: 'shell-agent',
      model: 'mock-model',
      adapter: scriptedAdapter([
        toolUse('stream-tool', 'first'),
        text('streamed'),
      ]),
      tools: ['bash'],
      shellExecutor: successfulExecutor(events),
    })

    for await (const event of agent.stream('stop after the command')) {
      if (event.type === 'tool_result') break
    }

    expect(events).toEqual(['start', 'exec:first', 'dispose'])
  })

  it('shares one lifecycle window and permits concurrent exec calls', async () => {
    const start = vi.fn(async () => undefined)
    const dispose = vi.fn(async () => undefined)
    let entered = 0
    let release!: () => void
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve
    })
    const executor: ShellExecutor = {
      start,
      async exec(command) {
        entered++
        if (entered === 2) release()
        await bothEntered
        return { stdout: command, stderr: '', exitCode: 0 }
      },
      dispose,
    }
    const first = buildAgent({
      name: 'first',
      model: 'mock-model',
      adapter: scriptedAdapter([toolUse('first-tool', 'first'), text('done')]),
      tools: ['bash'],
      shellExecutor: executor,
    })
    const second = buildAgent({
      name: 'second',
      model: 'mock-model',
      adapter: scriptedAdapter([toolUse('second-tool', 'second'), text('done')]),
      tools: ['bash'],
      shellExecutor: executor,
    })

    const [firstResult, secondResult] = await Promise.all([
      first.run('first'),
      second.run('second'),
    ])

    expect(firstResult.success).toBe(true)
    expect(secondResult.success).toBe(true)
    expect(entered).toBe(2)
    expect(start).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('permits concurrent bash calls within one model turn', async () => {
    const events: string[] = []
    let entered = 0
    let release!: () => void
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve
    })
    const executor: ShellExecutor = {
      async start() {
        events.push('start')
      },
      async exec(command) {
        events.push(`exec:${command}`)
        entered++
        if (entered === 2) release()
        await bothEntered
        return { stdout: command, stderr: '', exitCode: 0 }
      },
      async dispose() {
        events.push('dispose')
      },
    }
    const agent = buildAgent({
      name: 'parallel-shell',
      model: 'mock-model',
      adapter: scriptedAdapter([
        parallelToolUse(['first', 'second']),
        text('done'),
      ]),
      tools: ['bash'],
      shellExecutor: executor,
    })

    const result = await agent.run('run in parallel')

    expect(result.success).toBe(true)
    expect(result.toolCalls).toHaveLength(2)
    expect(events[0]).toBe('start')
    expect(new Set(events.slice(1, 3))).toEqual(new Set(['exec:first', 'exec:second']))
    expect(events[3]).toBe('dispose')
  })
})

describe('ShellExecutor configuration precedence and grants', () => {
  it('uses an agent override before the orchestrator default', async () => {
    const defaultEvents: string[] = []
    const overrideEvents: string[] = []
    const oma = new OpenMultiAgent({
      defaultShellExecutor: successfulExecutor(defaultEvents),
    })

    const overridden = await oma.runAgent({
      name: 'overridden',
      model: 'mock-model',
      adapter: scriptedAdapter([toolUse('override-tool', 'override'), text('done')]),
      tools: ['bash'],
      shellExecutor: successfulExecutor(overrideEvents),
    }, 'use override')

    expect(overridden.success).toBe(true)
    expect(overrideEvents).toEqual(['start', 'exec:override', 'dispose'])
    expect(defaultEvents).toEqual([])

    const inherited = await oma.runAgent({
      name: 'inherited',
      model: 'mock-model',
      adapter: scriptedAdapter([toolUse('default-tool', 'default'), text('done')]),
      tools: ['bash'],
    }, 'use default')

    expect(inherited.success).toBe(true)
    expect(defaultEvents).toEqual(['start', 'exec:default', 'dispose'])
  })

  it('does not start the default executor when bash is not granted', async () => {
    const events: string[] = []
    const oma = new OpenMultiAgent({
      defaultShellExecutor: successfulExecutor(events),
    })

    const result = await oma.runAgent({
      name: 'no-shell',
      model: 'mock-model',
      adapter: scriptedAdapter([toolUse('ungranted-tool', 'must-not-run'), text('done')]),
    }, 'do not grant bash')

    expect(result.success).toBe(true)
    expect(result.toolCalls[0]!.output).toContain('not granted')
    expect(events).toEqual([])
  })

  it('does not start the executor when onToolCall denies bash', async () => {
    const events: string[] = []
    const agent = buildAgent({
      name: 'denied-shell',
      model: 'mock-model',
      adapter: scriptedAdapter([toolUse('denied-tool', 'must-not-run'), text('done')]),
      tools: ['bash'],
      onToolCall: async () => ({ action: 'deny', reason: 'blocked' }),
      shellExecutor: successfulExecutor(events),
    })

    const result = await agent.run('deny bash')

    expect(result.success).toBe(true)
    expect(result.toolCalls[0]!.output).toContain('blocked')
    expect(events).toEqual([])
  })
})
