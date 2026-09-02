import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { ToolRegistry, defineTool } from '../src/tool/framework.js'
import { ToolExecutor, truncateToolOutput } from '../src/tool/executor.js'
import type { ToolCallDecision, ToolUseContext } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummyContext: ToolUseContext = {
  agent: { name: 'test-agent', role: 'tester', model: 'test-model' },
}

function echoTool() {
  return defineTool({
    name: 'echo',
    description: 'Echoes the message.',
    inputSchema: z.object({ message: z.string() }),
    execute: async ({ message }) => ({ data: message, isError: false }),
  })
}

function failTool() {
  return defineTool({
    name: 'fail',
    description: 'Always throws.',
    inputSchema: z.object({}),
    execute: async () => {
      throw new Error('intentional failure')
    },
  })
}

function makeExecutor(...tools: ReturnType<typeof defineTool>[]) {
  const registry = new ToolRegistry()
  for (const t of tools) registry.register(t)
  return { executor: new ToolExecutor(registry), registry }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function jsonPayloadStringSchema() {
  return z.string().superRefine((value, ctx) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Output must be valid JSON',
      })
      return
    }
    const shape = z.object({
      ok: z.boolean(),
      payload: z.object({
        id: z.string(),
      }),
      traceId: z.string(),
    })
    const result = shape.safeParse(parsed)
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: issue.path,
        })
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolExecutor', () => {
  // -------------------------------------------------------------------------
  // Single execution
  // -------------------------------------------------------------------------

  it('executes a tool and returns its result', async () => {
    const { executor } = makeExecutor(echoTool())
    const result = await executor.execute('echo', { message: 'hello' }, dummyContext)
    expect(result.data).toBe('hello')
    expect(result.isError).toBeFalsy()
  })

  it('returns an error result for an unknown tool', async () => {
    const { executor } = makeExecutor()
    const result = await executor.execute('ghost', {}, dummyContext)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('not registered')
  })

  it('returns an error result when Zod validation fails', async () => {
    const { executor } = makeExecutor(echoTool())
    // 'message' is required but missing
    const result = await executor.execute('echo', {}, dummyContext)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('Invalid input')
  })

  it('runs onToolCall after validation and returns an error result on deny', async () => {
    const execute = vi.fn(async () => ({ data: 'SHOULD_NOT_RUN', isError: false }))
    const gate = vi.fn(async () => ({ action: 'deny' as const, reason: 'requires human approval' }))
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'bash',
      description: 'Runs a shell command.',
      inputSchema: z.object({ command: z.string() }),
      execute,
    }))
    const executor = new ToolExecutor(registry, { onToolCall: gate })

    const result = await executor.execute(
      'bash',
      { command: 'rm -rf /tmp/demo' },
      { ...dummyContext, runId: 'run-1', taskId: 'task-1', toolCallId: 'call-1' },
    )

    expect(gate).toHaveBeenCalledWith({
      toolName: 'bash',
      input: { command: 'rm -rf /tmp/demo' },
      agentName: 'test-agent',
      runId: 'run-1',
      taskId: 'task-1',
      toolCallId: 'call-1',
    })
    expect(execute).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.data).toContain('requires human approval')
  })

  it('does not execute the tool when aborted while onToolCall is pending', async () => {
    const execute = vi.fn(async () => ({ data: 'SHOULD_NOT_RUN', isError: false }))
    const gateStarted = deferred<void>()
    const gateDecision = deferred<{ action: 'allow' }>()
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'slow_gate',
      description: 'Runs after a delayed gate.',
      inputSchema: z.object({}),
      execute,
    }))
    const executor = new ToolExecutor(registry, {
      onToolCall: vi.fn(() => {
        gateStarted.resolve()
        return gateDecision.promise
      }),
    })
    const controller = new AbortController()

    const resultPromise = executor.execute(
      'slow_gate',
      {},
      { ...dummyContext, abortSignal: controller.signal },
    )
    await gateStarted.promise
    controller.abort()
    gateDecision.resolve({ action: 'allow' })

    const result = await resultPromise

    expect(execute).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.data).toContain('aborted')
  })

  it.each([
    ['null', null],
    ['unknown action', { action: 'maybe' }],
  ])('returns an error result when onToolCall returns a malformed decision: %s', async (_name, decision) => {
    const execute = vi.fn(async () => ({ data: 'SHOULD_NOT_RUN', isError: false }))
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'malformed_gate',
      description: 'Uses a malformed gate decision.',
      inputSchema: z.object({}),
      execute,
    }))
    const executor = new ToolExecutor(registry, {
      onToolCall: vi.fn(async () => decision as unknown as ToolCallDecision),
    })

    const result = await executor.execute('malformed_gate', {}, dummyContext)

    expect(execute).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.data).toContain('invalid onToolCall decision')
  })

  it('catches tool execution errors and returns them as error results', async () => {
    const { executor } = makeExecutor(failTool())
    const result = await executor.execute('fail', {}, dummyContext)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('intentional failure')
  })

  it('returns an error result when aborted before execution', async () => {
    const { executor } = makeExecutor(echoTool())
    const controller = new AbortController()
    controller.abort()

    const result = await executor.execute(
      'echo',
      { message: 'hi' },
      { ...dummyContext, abortSignal: controller.signal },
    )
    expect(result.isError).toBe(true)
    expect(result.data).toContain('aborted')
  })

  // -------------------------------------------------------------------------
  // Batch execution
  // -------------------------------------------------------------------------

  it('executeBatch runs multiple tools and returns a map of results', async () => {
    const { executor } = makeExecutor(echoTool())
    const results = await executor.executeBatch(
      [
        { id: 'c1', name: 'echo', input: { message: 'a' } },
        { id: 'c2', name: 'echo', input: { message: 'b' } },
      ],
      dummyContext,
    )

    expect(results.size).toBe(2)
    expect(results.get('c1')!.data).toBe('a')
    expect(results.get('c2')!.data).toBe('b')
  })

  it('executeBatch isolates errors — one failure does not affect others', async () => {
    const { executor } = makeExecutor(echoTool(), failTool())
    const results = await executor.executeBatch(
      [
        { id: 'ok', name: 'echo', input: { message: 'fine' } },
        { id: 'bad', name: 'fail', input: {} },
      ],
      dummyContext,
    )

    expect(results.get('ok')!.isError).toBeFalsy()
    expect(results.get('bad')!.isError).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Concurrency control
  // -------------------------------------------------------------------------

  it('respects maxConcurrency limit', async () => {
    let peak = 0
    let running = 0

    const trackTool = defineTool({
      name: 'track',
      description: 'Tracks concurrency.',
      inputSchema: z.object({}),
      execute: async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 50))
        running--
        return { data: 'ok', isError: false }
      },
    })

    const registry = new ToolRegistry()
    registry.register(trackTool)
    const executor = new ToolExecutor(registry, { maxConcurrency: 2 })

    await executor.executeBatch(
      Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, name: 'track', input: {} })),
      dummyContext,
    )

    expect(peak).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

describe('ToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool())
    expect(registry.get('echo')).toBeDefined()
    expect(registry.has('echo')).toBe(true)
  })

  it('throws on duplicate registration', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool())
    expect(() => registry.register(echoTool())).toThrow('already registered')
  })

  it('unregister removes the tool', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool())
    registry.unregister('echo')
    expect(registry.has('echo')).toBe(false)
  })

  it('toToolDefs produces JSON schema representations', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool())
    const defs = registry.toToolDefs()
    expect(defs).toHaveLength(1)
    expect(defs[0].name).toBe('echo')
    expect(defs[0].inputSchema).toHaveProperty('properties')
  })

  it('marks nullable inputs as required when Zod rejects omission', () => {
    const inputSchema = z.object({
      requiredNullable: z.string().nullable(),
      optional: z.string().optional(),
    })
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'nullable_input',
      description: 'Accepts a required nullable value.',
      inputSchema,
      execute: async () => ({ data: 'ok' }),
    }))

    const [definition] = registry.toToolDefs()

    expect(inputSchema.safeParse({}).success).toBe(false)
    expect(inputSchema.safeParse({ requiredNullable: null }).success).toBe(true)
    expect(definition.inputSchema).toMatchObject({ required: ['requiredNullable'] })
  })
})

// ---------------------------------------------------------------------------
// truncateToolOutput
// ---------------------------------------------------------------------------

describe('truncateToolOutput', () => {
  it('returns data unchanged when under the limit', () => {
    const data = 'short output'
    expect(truncateToolOutput(data, 100)).toBe(data)
  })

  it('returns data unchanged when exactly at the limit', () => {
    const data = 'x'.repeat(100)
    expect(truncateToolOutput(data, 100)).toBe(data)
  })

  it('truncates data exceeding the limit with head/tail and marker', () => {
    const data = 'A'.repeat(300) + 'B'.repeat(700)
    const result = truncateToolOutput(data, 500)
    expect(result).toContain('[...truncated')
    expect(result.length).toBeLessThanOrEqual(500)
    // Head portion starts with As
    expect(result.startsWith('A')).toBe(true)
    // Tail portion ends with Bs
    expect(result.endsWith('B')).toBe(true)
  })

  it('result never exceeds maxChars', () => {
    const data = 'x'.repeat(10000)
    const result = truncateToolOutput(data, 1000)
    expect(result.length).toBeLessThanOrEqual(1000)
    expect(result).toContain('[...truncated')
  })

  it('handles empty string', () => {
    expect(truncateToolOutput('', 100)).toBe('')
  })

  it('handles very small maxChars gracefully', () => {
    const data = 'x'.repeat(100)
    // With maxChars=1, the marker alone exceeds the budget — falls back to hard slice
    const result = truncateToolOutput(data, 1)
    expect(result.length).toBeLessThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Tool output truncation (integration)
// ---------------------------------------------------------------------------

describe('ToolExecutor output truncation', () => {
  it('truncates output when agent-level maxToolOutputChars is set', async () => {
    const bigTool = defineTool({
      name: 'big',
      description: 'Returns large output.',
      inputSchema: z.object({}),
      execute: async () => ({ data: 'x'.repeat(5000) }),
    })
    const registry = new ToolRegistry()
    registry.register(bigTool)
    const executor = new ToolExecutor(registry, { maxToolOutputChars: 200 })

    const result = await executor.execute('big', {}, dummyContext)
    expect(result.data.length).toBeLessThan(5000)
    expect(result.data).toContain('[...truncated')
  })

  it('does not truncate when output is under the limit', async () => {
    const smallTool = defineTool({
      name: 'small',
      description: 'Returns small output.',
      inputSchema: z.object({}),
      execute: async () => ({ data: 'hello' }),
    })
    const registry = new ToolRegistry()
    registry.register(smallTool)
    const executor = new ToolExecutor(registry, { maxToolOutputChars: 200 })

    const result = await executor.execute('small', {}, dummyContext)
    expect(result.data).toBe('hello')
  })

  it('per-tool maxOutputChars overrides agent-level setting (smaller)', async () => {
    const toolWithLimit = defineTool({
      name: 'limited',
      description: 'Has its own limit.',
      inputSchema: z.object({}),
      maxOutputChars: 200,
      execute: async () => ({ data: 'y'.repeat(5000) }),
    })
    const registry = new ToolRegistry()
    registry.register(toolWithLimit)
    // Agent-level is 1000 but tool-level is 200 -- tool wins
    const executor = new ToolExecutor(registry, { maxToolOutputChars: 1000 })

    const result = await executor.execute('limited', {}, dummyContext)
    expect(result.data).toContain('[...truncated')
    expect(result.data.length).toBeLessThanOrEqual(200)
  })

  it('per-tool maxOutputChars overrides agent-level setting (larger)', async () => {
    const toolWithLimit = defineTool({
      name: 'limited',
      description: 'Has its own limit.',
      inputSchema: z.object({}),
      maxOutputChars: 2000,
      execute: async () => ({ data: 'y'.repeat(5000) }),
    })
    const registry = new ToolRegistry()
    registry.register(toolWithLimit)
    // Agent-level is 500 but tool-level is 2000 -- tool wins
    const executor = new ToolExecutor(registry, { maxToolOutputChars: 500 })

    const result = await executor.execute('limited', {}, dummyContext)
    expect(result.data).toContain('[...truncated')
    expect(result.data.length).toBeLessThanOrEqual(2000)
    expect(result.data.length).toBeGreaterThan(500)
  })

  it('per-tool maxOutputChars works without agent-level setting', async () => {
    const toolWithLimit = defineTool({
      name: 'limited',
      description: 'Has its own limit.',
      inputSchema: z.object({}),
      maxOutputChars: 300,
      execute: async () => ({ data: 'z'.repeat(5000) }),
    })
    const registry = new ToolRegistry()
    registry.register(toolWithLimit)
    const executor = new ToolExecutor(registry)

    const result = await executor.execute('limited', {}, dummyContext)
    expect(result.data).toContain('[...truncated')
    expect(result.data.length).toBeLessThanOrEqual(300)
  })

  it('truncates error results too', async () => {
    const errorTool = defineTool({
      name: 'errorbig',
      description: 'Throws a huge error.',
      inputSchema: z.object({}),
      execute: async () => { throw new Error('E'.repeat(5000)) },
    })
    const registry = new ToolRegistry()
    registry.register(errorTool)
    const executor = new ToolExecutor(registry, { maxToolOutputChars: 200 })

    const result = await executor.execute('errorbig', {}, dummyContext)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('[...truncated')
    expect(result.data.length).toBeLessThan(5000)
  })

  it('no truncation when maxToolOutputChars is 0', async () => {
    const bigTool = defineTool({
      name: 'big',
      description: 'Returns large output.',
      inputSchema: z.object({}),
      execute: async () => ({ data: 'x'.repeat(5000) }),
    })
    const registry = new ToolRegistry()
    registry.register(bigTool)
    const executor = new ToolExecutor(registry, { maxToolOutputChars: 0 })

    const result = await executor.execute('big', {}, dummyContext)
    expect(result.data.length).toBe(5000)
  })

  it('no truncation when maxToolOutputChars is negative', async () => {
    const bigTool = defineTool({
      name: 'big',
      description: 'Returns large output.',
      inputSchema: z.object({}),
      execute: async () => ({ data: 'x'.repeat(5000) }),
    })
    const registry = new ToolRegistry()
    registry.register(bigTool)
    const executor = new ToolExecutor(registry, { maxToolOutputChars: -100 })

    const result = await executor.execute('big', {}, dummyContext)
    expect(result.data.length).toBe(5000)
  })

  it('defineTool passes maxOutputChars to the ToolDefinition', () => {
    const tool = defineTool({
      name: 'test',
      description: 'test',
      inputSchema: z.object({}),
      maxOutputChars: 500,
      execute: async () => ({ data: 'ok' }),
    })
    expect(tool.maxOutputChars).toBe(500)
  })

  it('defineTool omits maxOutputChars when not specified', () => {
    const tool = defineTool({
      name: 'test',
      description: 'test',
      inputSchema: z.object({}),
      execute: async () => ({ data: 'ok' }),
    })
    expect(tool.maxOutputChars).toBeUndefined()
  })

  it('no truncation when neither limit is set', async () => {
    const bigTool = defineTool({
      name: 'big',
      description: 'Returns large output.',
      inputSchema: z.object({}),
      execute: async () => ({ data: 'x'.repeat(50000) }),
    })
    const registry = new ToolRegistry()
    registry.register(bigTool)
    const executor = new ToolExecutor(registry)

    const result = await executor.execute('big', {}, dummyContext)
    expect(result.data.length).toBe(50000)
  })
})

describe('ToolExecutor outputSchema validation', () => {
  it('valid output passes schema validation', async () => {
    const tool = defineTool({
      name: 'json-ok',
      description: 'Returns valid JSON output.',
      inputSchema: z.object({}),
      outputSchema: jsonPayloadStringSchema(),
      execute: async () => ({
        data: JSON.stringify({ ok: true, payload: { id: 'abc-123' }, traceId: 'trace-1' }),
      }),
    })
    const { executor } = makeExecutor(tool)
    const result = await executor.execute('json-ok', {}, dummyContext)
    expect(result.isError).toBeFalsy()
    expect(result.data).toBe(JSON.stringify({ ok: true, payload: { id: 'abc-123' }, traceId: 'trace-1' }))
  })

  it('truncated JSON fails output schema validation', async () => {
    const fullJson = JSON.stringify({
      ok: true,
      payload: { id: 'x'.repeat(200) },
      traceId: 'trace-2',
    })
    // Simulate "broken but deceptive" truncation: payload looks complete, but
    // the outer object is missing its final `}` and ends with punctuation.
    // Example shape: {"ok":...,"payload":{"id":"..." }
    const brokenButDeceptiveJson = fullJson
      .replace(/,"traceId":"[^"]*"/, '')
      .slice(0, -1)
    const tool = defineTool({
      name: 'json-truncated',
      description: 'Returns broken-but-deceptive JSON output.',
      inputSchema: z.object({}),
      outputSchema: jsonPayloadStringSchema(),
      execute: async () => ({ data: brokenButDeceptiveJson }),
    })
    const { executor } = makeExecutor(tool)
    const result = await executor.execute('json-truncated', {}, dummyContext)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('Invalid output for tool "json-truncated"')
  })

  it('preserves gate metadata when output schema validation fails', async () => {
    const tool = defineTool({
      name: 'json-gated-invalid',
      description: 'Returns invalid JSON output after the gate allows it.',
      inputSchema: z.object({}),
      outputSchema: jsonPayloadStringSchema(),
      execute: async () => ({ data: 'not-json' }),
    })
    const registry = new ToolRegistry()
    registry.register(tool)
    const executor = new ToolExecutor(registry, {
      onToolCall: async () => ({ action: 'allow' }),
    })

    const result = await executor.execute('json-gated-invalid', {}, dummyContext)

    expect(result.isError).toBe(true)
    expect(result.data).toContain('Invalid output for tool "json-gated-invalid"')
    expect(result.metadata?.toolCallGate).toEqual({ action: 'allow' })
  })

  it('missing outputSchema is a no-op', async () => {
    const tool = defineTool({
      name: 'no-schema',
      description: 'No output schema configured.',
      inputSchema: z.object({}),
      execute: async () => ({ data: 'not-json-but-valid-without-schema' }),
    })
    const { executor } = makeExecutor(tool)
    const result = await executor.execute('no-schema', {}, dummyContext)
    expect(result.isError).toBeFalsy()
    expect(result.data).toBe('not-json-but-valid-without-schema')
  })

  it('error result bypasses outputSchema validation and forwards original message', async () => {
    const originalErrorMessage = 'upstream service unavailable'
    const tool = defineTool({
      name: 'json-errored',
      description: 'Always fails with a non-JSON error message.',
      inputSchema: z.object({}),
      outputSchema: jsonPayloadStringSchema(),
      execute: async () => ({ data: originalErrorMessage, isError: true }),
    })
    const { executor } = makeExecutor(tool)

    // Should not throw; errors from execute are surfaced as ToolResult.
    const result = await executor.execute('json-errored', {}, dummyContext)

    expect(result.isError).toBe(true)
    expect(result.data).toBe(originalErrorMessage)
    // Ensure the error was NOT rewritten by the outputSchema validator.
    expect(result.data).not.toContain('Invalid output for tool')
  })
})
