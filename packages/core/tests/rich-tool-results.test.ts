import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { AgentRunner, type RunResult } from '../src/agent/runner.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { defineTool, ToolRegistry } from '../src/tool/framework.js'
import type { Scorer } from '../src/eval/scorer.js'
import type {
  AgentRunResult,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  OrchestratorEvent,
  ToolResult,
  ToolResultContentPart,
  TraceEvent,
} from '../src/types.js'

const IMAGE_DATA = 'aW1hZ2U='

const context = {
  agent: { name: 'tester', role: 'test', model: 'test-model' },
}

function textResponse(text: string): LLMResponse {
  return {
    id: `response-${text}`,
    content: [{ type: 'text', text }],
    model: 'test-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

describe('rich ToolResult contract', () => {
  it('keeps existing string tools byte-for-byte compatible', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'legacy',
      description: 'legacy string tool',
      inputSchema: z.object({}),
      outputSchema: z.string(),
      execute: async () => ({ data: 'plain text' }),
    }))

    const result = await new ToolExecutor(registry).execute('legacy', {}, context)

    expect(result).toEqual({ data: 'plain text' })
  })

  it('validates application data, preserves its identity, and copies modelOutput', async () => {
    const applicationData = { artifactId: 'artifact-1', internalPath: '/srv/app/report.pdf' }
    const modelOutput: ToolResultContentPart[] = [
      { type: 'text', text: 'Rendered report' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA },
      },
    ]
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'render',
      description: 'render an artifact',
      inputSchema: z.object({}),
      outputSchema: z.object({ artifactId: z.string(), internalPath: z.string() }),
      execute: async () => ({ data: applicationData, modelOutput }),
    }))

    const result = await new ToolExecutor(registry).execute('render', {}, context)
    modelOutput[0] = { type: 'text', text: 'caller mutation' }
    ;(modelOutput[1] as { source: { data: string } }).source.data = 'bXV0YXRlZA=='

    expect(result.data).toBe(applicationData)
    expect(result.modelOutput).toEqual([
      { type: 'text', text: 'Rendered report' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA },
      },
    ])
  })

  it.each([
    {
      name: 'missing modelOutput',
      result: { data: { artifactId: 'x' } },
      message: 'non-string ToolResult.data requires modelOutput',
    },
    {
      name: 'unknown content part',
      result: { data: 'x', modelOutput: [{ type: 'audio', source: {} }] },
      message: 'type must be "text", "image", or "file"',
    },
    {
      name: 'malformed base64',
      result: {
        data: 'x',
        modelOutput: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'not base64!' },
        }],
      },
      message: 'must contain raw base64 data',
    },
    {
      name: 'local URL reference',
      result: {
        data: 'x',
        modelOutput: [{
          type: 'file',
          filename: 'report.pdf',
          source: { type: 'url', media_type: 'application/pdf', url: 'file:///tmp/report.pdf' },
        }],
      },
      message: 'must use HTTP or HTTPS',
    },
    {
      name: 'rich error result',
      result: {
        data: 'failed',
        isError: true,
        modelOutput: [{ type: 'text', text: 'failed' }],
      },
      message: 'error modelOutput must be a string',
    },
  ])('returns a text error for invalid $name', async ({ result, message }) => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'invalid',
      description: 'returns invalid output',
      inputSchema: z.object({}),
      execute: async () => result as unknown as ToolResult,
    }))

    const executed = await new ToolExecutor(registry).execute('invalid', {}, context)

    expect(executed.isError).toBe(true)
    expect(executed.data).toContain(message)
    expect(executed.modelOutput).toBeUndefined()
  })

  it('validates a non-string data schema before exposing model output', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'typed',
      description: 'typed application output',
      inputSchema: z.object({}),
      outputSchema: z.object({ artifactId: z.string() }),
      execute: async () => ({
        data: { artifactId: 42 } as unknown as { artifactId: string },
        modelOutput: 'not forwarded',
      }),
    }))

    const result = await new ToolExecutor(registry).execute('typed', {}, context)

    expect(result.isError).toBe(true)
    expect(result.data).toContain('Invalid output for tool "typed"')
    expect(result.data).toContain('artifactId')
  })
})

describe('AgentRunner rich tool-result propagation', () => {
  it('replays rich content without serializing application data and keeps traces media-safe', async () => {
    const secretUrl = 'https://example.com/report.pdf?token=not-for-traces'
    const modelOutput: ToolResultContentPart[] = [
      { type: 'text', text: 'Authorization: Bearer example-test-token-value-1234567890' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA },
      },
      {
        type: 'file',
        filename: 'report.pdf',
        source: { type: 'url', media_type: 'application/pdf', url: secretUrl },
      },
    ]
    const applicationData = {
      artifactId: 'artifact-1',
      internalPath: '/srv/app/application-owned/report.pdf',
    }
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'render',
      description: 'render a report',
      inputSchema: z.object({}),
      execute: async () => ({ data: applicationData, modelOutput }),
    }))
    const executor = new ToolExecutor(registry)
    const calls: LLMMessage[][] = []
    let call = 0
    const adapter: LLMAdapter = {
      name: 'rich-contract-test',
      async chat(messages) {
        calls.push(structuredClone(messages))
        call++
        if (call === 1) {
          return {
            id: 'tool-call',
            content: [{ type: 'tool_use', id: 'call-1', name: 'render', input: {} }],
            model: 'test-model',
            stop_reason: 'tool_use',
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        }
        return textResponse('verified')
      },
      async *stream() { /* AgentRunner uses chat(). */ },
    }
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'test-model',
      agentName: 'rich-agent',
      allowedTools: ['render'],
    })
    const traces: TraceEvent[] = []
    let callbackResult: ToolResult<any> | undefined
    const events = []

    for await (const event of runner.stream(
      [{ role: 'user', content: [{ type: 'text', text: 'render and inspect' }] }],
      {
        runId: 'rich-run',
        onTrace: event => { traces.push(event) },
        onToolResult: (_name, result) => {
          callbackResult = result
          // A callback may cast away readonly at runtime; it must not be able
          // to alter the transcript that is about to be sent to the model.
          if (Array.isArray(result.modelOutput)) {
            ;(result.modelOutput as ToolResultContentPart[])[0] = {
              type: 'text',
              text: 'callback mutation',
            }
          }
        },
      },
    )) events.push(event)

    expect(callbackResult?.data).toBe(applicationData)
    expect(calls).toHaveLength(2)
    const toolResult = calls[1]!.at(-1)!.content[0]
    expect(toolResult).toEqual({
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: modelOutput,
      is_error: undefined,
    })

    const streamResult = events.find(event => event.type === 'tool_result')
    expect(streamResult?.data).toEqual(toolResult)
    const done = events.find(event => event.type === 'done')!.data as RunResult
    expect(done.toolCalls[0]!.output).toContain('[image: image/png; inline data]')
    expect(done.toolCalls[0]!.output).toContain('[file: report.pdf; application/pdf; URL reference]')
    expect(done.toolCalls[0]!.output).not.toContain(IMAGE_DATA)
    expect(done.toolCalls[0]!.output).not.toContain(secretUrl)
    expect(done.toolCalls[0]!.output).not.toContain(applicationData.internalPath)

    const trace = traces.find(
      (event): event is Extract<TraceEvent, { type: 'tool_call' }> => event.type === 'tool_call',
    )!
    expect(trace.output).toContain('[redacted]')
    expect(trace.output).toContain('[image: image/png; inline data]')
    expect(trace.output).not.toContain(IMAGE_DATA)
    expect(trace.output).not.toContain(secretUrl)
    expect(trace.output).not.toContain(applicationData.internalPath)
  })

  it('compresses consumed rich results but preserves the newest rich result', async () => {
    const modelOutput: ToolResultContentPart[] = [
      { type: 'text', text: 'Rendered preview' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA },
      },
    ]
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'render',
      description: 'render a preview',
      inputSchema: z.object({}),
      execute: async () => ({ data: 'artifact-1', modelOutput }),
    }))
    const calls: LLMMessage[][] = []
    let turn = 0
    const adapter: LLMAdapter = {
      name: 'rich-context-test',
      async chat(messages) {
        calls.push(structuredClone(messages))
        turn++
        if (turn <= 2) {
          return {
            id: `tool-call-${turn}`,
            content: [{ type: 'tool_use', id: `call-${turn}`, name: 'render', input: {} }],
            model: 'test-model',
            stop_reason: 'tool_use',
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        }
        return textResponse('done')
      },
      async *stream() { /* AgentRunner uses chat(). */ },
    }
    const runner = new AgentRunner(adapter, registry, new ToolExecutor(registry), {
      model: 'test-model',
      allowedTools: ['render'],
      compressToolResults: { minChars: 1 },
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'render twice' }] }])

    const toolResults = calls[2]!.flatMap(message =>
      message.content.filter(
        (block): block is Extract<typeof block, { type: 'tool_result' }> => block.type === 'tool_result',
      ),
    )
    expect(toolResults).toHaveLength(2)
    expect(toolResults[0]!.content).toMatch(/^\[Tool output compressed/)
    expect(toolResults[1]!.content).toEqual(modelOutput)
  })
})

describe('rich results in progress and evaluation', () => {
  it('keeps full model-visible content in completed results observed by both surfaces', async () => {
    const modelOutput: ToolResultContentPart[] = [
      { type: 'text', text: 'Rendered preview' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA },
      },
    ]
    const render = defineTool({
      name: 'render',
      description: 'render a preview',
      inputSchema: z.object({}),
      execute: async () => ({ data: { artifactId: 'artifact-1' }, modelOutput }),
    })
    let turn = 0
    const adapter: LLMAdapter = {
      name: 'rich-lifecycle-test',
      async chat() {
        turn++
        if (turn === 1) {
          return {
            id: 'tool-call',
            content: [{ type: 'tool_use', id: 'call-1', name: 'render', input: {} }],
            model: 'test-model',
            stop_reason: 'tool_use',
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        }
        return textResponse('done')
      },
      async *stream() { /* OpenMultiAgent uses chat(). */ },
    }
    let progressResult: AgentRunResult | undefined
    let scoredResult: unknown
    const scorer: Scorer = {
      name: 'capture-rich-result',
      version: '1',
      score(context) {
        scoredResult = context.result
        return { score: 1 }
      },
    }
    const oma = new OpenMultiAgent({
      onProgress(event: OrchestratorEvent) {
        if (event.type === 'agent_complete') progressResult = event.data as AgentRunResult
      },
      evaluation: { scorers: [scorer], sample: 1, storePayloads: 'none' },
    })

    const result = await oma.runAgent({
      name: 'rich-agent',
      model: 'test-model',
      adapter,
      customTools: [render],
      tools: ['render'],
    }, 'render a preview')
    await oma.evaluation.forceFlush({ timeoutMs: 1_000 })

    const expected = {
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: modelOutput,
      is_error: undefined,
    }
    const richBlock = (run: AgentRunResult | undefined) => run?.messages
      .flatMap(message => message.content)
      .find(block => block.type === 'tool_result')
    expect(richBlock(progressResult)).toEqual(expected)
    expect(richBlock(scoredResult as AgentRunResult)).toEqual(expected)
    expect(richBlock(result)).toEqual(expected)
  })
})
