import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  buildStructuredOutputInstruction,
  extractJSON,
  validateOutput,
} from '../src/agent/structured-output.js'
import { Agent } from '../src/agent/agent.js'
import { AgentRunner } from '../src/agent/runner.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { StructuredOutputValidationError } from '../src/errors.js'
import type { AgentConfig, ContentBlock, LLMAdapter, LLMResponse } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock LLM adapter factory
// ---------------------------------------------------------------------------

function mockAdapter(responses: string[]): LLMAdapter {
  let callIndex = 0
  return {
    name: 'mock',
    async chat() {
      const text = responses[callIndex++] ?? ''
      return {
        id: `mock-${callIndex}`,
        content: [{ type: 'text' as const, text }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      } satisfies LLMResponse
    },
    async *stream() {
      /* unused in these tests */
    },
  }
}

function mockContentAdapter(responses: ContentBlock[][]): LLMAdapter {
  let callIndex = 0
  return {
    name: 'mock',
    async chat() {
      const content = responses[callIndex++] ?? []
      return {
        id: `mock-${callIndex}`,
        content,
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      } satisfies LLMResponse
    },
    async *stream() {
      /* unused in these tests */
    },
  }
}

// ---------------------------------------------------------------------------
// extractJSON
// ---------------------------------------------------------------------------

describe('extractJSON', () => {
  it('parses clean JSON', () => {
    expect(extractJSON('{"a":1}')).toEqual({ a: 1 })
  })

  it('parses JSON wrapped in ```json fence', () => {
    const raw = 'Here is the result:\n```json\n{"a":1}\n```\nDone.'
    expect(extractJSON(raw)).toEqual({ a: 1 })
  })

  it('parses JSON wrapped in bare ``` fence', () => {
    const raw = '```\n{"a":1}\n```'
    expect(extractJSON(raw)).toEqual({ a: 1 })
  })

  it('extracts embedded JSON object from surrounding text', () => {
    const raw = 'The answer is {"summary":"hello","score":5} as shown above.'
    expect(extractJSON(raw)).toEqual({ summary: 'hello', score: 5 })
  })

  it('extracts JSON array', () => {
    expect(extractJSON('[1,2,3]')).toEqual([1, 2, 3])
  })

  it('extracts embedded JSON array from surrounding text', () => {
    const raw = 'Here: [{"a":1},{"a":2}] end'
    expect(extractJSON(raw)).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('throws on non-JSON text', () => {
    expect(() => extractJSON('just plain text')).toThrow('Failed to extract JSON')
  })

  it('throws on empty string', () => {
    expect(() => extractJSON('')).toThrow('Failed to extract JSON')
  })
})

// ---------------------------------------------------------------------------
// validateOutput
// ---------------------------------------------------------------------------

describe('validateOutput', () => {
  const schema = z.object({
    summary: z.string(),
    score: z.number().min(0).max(10),
  })

  it('returns validated data on success', () => {
    const data = { summary: 'hello', score: 5 }
    expect(validateOutput(schema, data)).toEqual(data)
  })

  it('throws on missing field', () => {
    expect(() => validateOutput(schema, { summary: 'hello' })).toThrow(
      'Output validation failed',
    )
  })

  it('throws on wrong type', () => {
    expect(() =>
      validateOutput(schema, { summary: 'hello', score: 'not a number' }),
    ).toThrow('Output validation failed')
  })

  it('throws on value out of range', () => {
    expect(() =>
      validateOutput(schema, { summary: 'hello', score: 99 }),
    ).toThrow('Output validation failed')
  })

  it('applies Zod transforms', () => {
    const transformSchema = z.object({
      name: z.string().transform(s => s.toUpperCase()),
    })
    const result = validateOutput(transformSchema, { name: 'alice' })
    expect(result).toEqual({ name: 'ALICE' })
  })

  it('strips unknown keys with strict schema', () => {
    const strictSchema = z.object({ a: z.number() }).strict()
    expect(() =>
      validateOutput(strictSchema, { a: 1, b: 2 }),
    ).toThrow('Output validation failed')
  })

  it('shows (root) for root-level errors', () => {
    const stringSchema = z.string()
    expect(() => validateOutput(stringSchema, 42)).toThrow('(root)')
  })
})

// ---------------------------------------------------------------------------
// buildStructuredOutputInstruction
// ---------------------------------------------------------------------------

describe('buildStructuredOutputInstruction', () => {
  it('includes the JSON Schema representation', () => {
    const schema = z.object({
      summary: z.string(),
      score: z.number(),
    })
    const instruction = buildStructuredOutputInstruction(schema)

    expect(instruction).toContain('Output Format (REQUIRED)')
    expect(instruction).toContain('"type": "object"')
    expect(instruction).toContain('"summary"')
    expect(instruction).toContain('"score"')
    expect(instruction).toContain('ONLY valid JSON')
  })

  it('includes description from Zod schema', () => {
    const schema = z.object({
      name: z.string().describe('The person name'),
    })
    const instruction = buildStructuredOutputInstruction(schema)
    expect(instruction).toContain('The person name')
  })
})

// ---------------------------------------------------------------------------
// Agent integration (mocked LLM)
// ---------------------------------------------------------------------------

/**
 * Build an Agent with a mocked LLM adapter by injecting an AgentRunner
 * directly into the Agent's private `runner` field, bypassing `createAdapter`.
 */
function buildMockAgent(config: AgentConfig, responses: string[]): Agent {
  return buildMockAgentWithAdapter(config, mockAdapter(responses))
}

function buildMockAgentWithAdapter(config: AgentConfig, adapter: LLMAdapter): Agent {
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry)
  const agent = new Agent(config, registry, executor)

  // Inject a pre-built runner so `getBackend()` returns it without calling createAdapter.
  const runner = new AgentRunner(adapter, registry, executor, {
    model: config.model,
    systemPrompt: config.systemPrompt,
    maxTurns: config.maxTurns,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    agentName: config.name,
  })
  ;(agent as any).backend = runner

  return agent
}

describe('Agent structured output (end-to-end)', () => {
  const schema = z.object({
    summary: z.string(),
    sentiment: z.enum(['positive', 'negative', 'neutral']),
    confidence: z.number().min(0).max(1),
  })

  const baseConfig: AgentConfig = {
    name: 'test-agent',
    model: 'mock-model',
    systemPrompt: 'You are a test agent.',
    outputSchema: schema,
  }

  it('happy path: valid JSON on first attempt', async () => {
    const validJSON = JSON.stringify({
      summary: 'Great product',
      sentiment: 'positive',
      confidence: 0.95,
    })

    const agent = buildMockAgent(baseConfig, [validJSON])
    const result = await agent.run('Analyze this review')

    expect(result.success).toBe(true)
    expect(result.structured).toEqual({
      summary: 'Great product',
      sentiment: 'positive',
      confidence: 0.95,
    })
  })

  it('retry: invalid first attempt, valid second attempt', async () => {
    const invalidJSON = JSON.stringify({
      summary: 'Great product',
      sentiment: 'INVALID_VALUE',
      confidence: 0.95,
    })
    const validJSON = JSON.stringify({
      summary: 'Great product',
      sentiment: 'positive',
      confidence: 0.95,
    })

    const agent = buildMockAgent(baseConfig, [invalidJSON, validJSON])
    const result = await agent.run('Analyze this review')

    expect(result.success).toBe(true)
    expect(result.structured).toEqual({
      summary: 'Great product',
      sentiment: 'positive',
      confidence: 0.95,
    })
    // Token usage should reflect both attempts
    expect(result.tokenUsage.input_tokens).toBe(20) // 10 + 10
    expect(result.tokenUsage.output_tokens).toBe(40) // 20 + 20
  })

  it('both attempts fail: success=false, structured=undefined', async () => {
    const bad1 = '{"summary": "ok", "sentiment": "WRONG"}'
    const bad2 = '{"summary": "ok", "sentiment": "ALSO_WRONG"}'

    const agent = buildMockAgent(baseConfig, [bad1, bad2])
    const result = await agent.run('Analyze this review')

    expect(result.success).toBe(false)
    expect(result.structured).toBeUndefined()
    expect(result.error).toBeInstanceOf(StructuredOutputValidationError)
    expect(result.errorInfo).toMatchObject({
      kind: 'validation',
      retryable: false,
    })
  })

  it('does not report structured success after the whole-run deadline fires', async () => {
    const validJSON = JSON.stringify({
      summary: 'Late result',
      sentiment: 'neutral',
      confidence: 0.5,
    })
    const lateAdapter: LLMAdapter = {
      name: 'mock',
      async chat(_messages, options) {
        await new Promise<void>((resolve) => {
          if (options.abortSignal?.aborted) resolve()
          else options.abortSignal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return {
          id: 'late-response',
          content: [{ type: 'text', text: validJSON }],
          model: 'mock-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 },
        }
      },
      async *stream() {
        /* unused in these tests */
      },
    }

    const agent = buildMockAgentWithAdapter(
      { ...baseConfig, timeoutMs: 5 },
      lateAdapter,
    )
    const result = await agent.run('Analyze this review')

    expect(result.success).toBe(false)
    expect(result.status?.code).toBe('timeout')
    expect(result.errorInfo).toMatchObject({ kind: 'timeout', retryable: true })
    expect(result.structured).toBeUndefined()
    expect(result.error).toBeInstanceOf(Error)
  })

  it('does not report structured success when caller cancellation fires during correction', async () => {
    const controller = new AbortController()
    let call = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat() {
        call += 1
        if (call === 2) controller.abort()
        return {
          id: `cancel-${call}`,
          content: [{
            type: 'text',
            text: call === 1
              ? '{"summary":"invalid"}'
              : '{"summary":"ok","sentiment":"neutral","confidence":0.5}',
          }],
          model: 'mock-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 },
        }
      },
      async *stream() {
        /* unused in these tests */
      },
    }
    const agent = buildMockAgentWithAdapter(baseConfig, adapter)

    const result = await agent.run('Analyze', { abortSignal: controller.signal })

    expect(result.success).toBe(false)
    expect(result.status?.code).toBe('cancelled')
    expect(result.errorInfo).toMatchObject({ kind: 'cancellation', retryable: false })
    expect(result.structured).toBeUndefined()
  })

  it('applies the token budget across both structured-output attempts', async () => {
    const agent = buildMockAgent(
      { ...baseConfig, maxTokenBudget: 40 },
      [
        '{"summary":"invalid"}',
        '{"summary":"ok","sentiment":"neutral","confidence":0.5}',
      ],
    )

    const result = await agent.run('Analyze')

    expect(result.success).toBe(false)
    expect(result.status?.code).toBe('budget_exhausted')
    expect(result.errorInfo).toMatchObject({ kind: 'budget', retryable: false })
    expect(result.budgetExceeded).toBe(true)
    expect(result.structured).toBeUndefined()
  })

  it('no outputSchema: original behavior, structured is undefined', async () => {
    const configNoSchema: AgentConfig = {
      name: 'plain-agent',
      model: 'mock-model',
      systemPrompt: 'You are a test agent.',
    }

    const agent = buildMockAgent(configNoSchema, ['Just plain text output'])
    const result = await agent.run('Hello')

    expect(result.success).toBe(true)
    expect(result.output).toBe('Just plain text output')
    expect(result.structured).toBeUndefined()
  })

  it('handles JSON wrapped in markdown fence', async () => {
    const fenced = '```json\n{"summary":"ok","sentiment":"neutral","confidence":0.5}\n```'

    const agent = buildMockAgent(baseConfig, [fenced])
    const result = await agent.run('Analyze')

    expect(result.success).toBe(true)
    expect(result.structured).toEqual({
      summary: 'ok',
      sentiment: 'neutral',
      confidence: 0.5,
    })
  })

  it('ignores reasoning blocks when validating structured output', async () => {
    const agent = buildMockAgentWithAdapter(
      baseConfig,
      mockContentAdapter([[
        { type: 'reasoning', text: 'scratchpad with misleading { partial json' },
        { type: 'text', text: '{"summary":"ok","sentiment":"neutral","confidence":0.5}' },
      ]]),
    )

    const result = await agent.run('Analyze')

    expect(result.success).toBe(true)
    expect(result.output).toBe('{"summary":"ok","sentiment":"neutral","confidence":0.5}')
    expect(result.structured).toEqual({
      summary: 'ok',
      sentiment: 'neutral',
      confidence: 0.5,
    })
  })

  it('non-JSON output triggers retry, valid JSON on retry succeeds', async () => {
    const nonJSON = 'I am not sure how to analyze this.'
    const validJSON = JSON.stringify({
      summary: 'Uncertain',
      sentiment: 'neutral',
      confidence: 0.1,
    })

    const agent = buildMockAgent(baseConfig, [nonJSON, validJSON])
    const result = await agent.run('Analyze this review')

    expect(result.success).toBe(true)
    expect(result.structured).toEqual({
      summary: 'Uncertain',
      sentiment: 'neutral',
      confidence: 0.1,
    })
  })

  it('non-JSON output on both attempts: success=false', async () => {
    const agent = buildMockAgent(baseConfig, [
      'Sorry, I cannot do that.',
      'Still cannot do it.',
    ])
    const result = await agent.run('Analyze this review')

    expect(result.success).toBe(false)
    expect(result.structured).toBeUndefined()
  })

  it('token usage on first-attempt success reflects single call only', async () => {
    const validJSON = JSON.stringify({
      summary: 'Good',
      sentiment: 'positive',
      confidence: 0.9,
    })

    const agent = buildMockAgent(baseConfig, [validJSON])
    const result = await agent.run('Analyze')

    expect(result.tokenUsage.input_tokens).toBe(10)
    expect(result.tokenUsage.output_tokens).toBe(20)
  })
})
