/**
 * E2E tests for DeepSeekAdapter against the real API.
 *
 * Skipped by default. Run with: npm run test:e2e
 * Requires: DEEPSEEK_API_KEY environment variable
 * Optional: DEEPSEEK_E2E_MODEL (defaults to deepseek-v4-flash)
 */
import { beforeAll, describe, it, expect } from 'vitest'
import { z } from 'zod'
import { OpenMultiAgent } from '../../src/orchestrator/orchestrator.js'
import { DeepSeekAdapter } from '../../src/llm/deepseek.js'
import { defineTool } from '../../src/tool/framework.js'
import type { LLMResponse, StreamEvent } from '../../src/types.js'

const describeE2E = process.env['RUN_E2E'] && process.env['DEEPSEEK_API_KEY']
  ? describe
  : describe.skip

describeE2E('DeepSeekAdapter E2E', () => {
  let adapter: DeepSeekAdapter
  const model = process.env['DEEPSEEK_E2E_MODEL'] ?? 'deepseek-v4-flash'

  beforeAll(() => {
    adapter = new DeepSeekAdapter()
  })

  it('chat() returns a text response with usage', async () => {
    const result = await adapter.chat(
      [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly CHAT_OK.' }] }],
      {
        model,
        maxTokens: 256,
        thinking: { enabled: false },
      },
    )

    const text = result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')

    expect(result.id).toBeTruthy()
    expect(text).toContain('CHAT_OK')
    expect(result.content.some(block => block.type === 'reasoning')).toBe(false)
    expect(result.usage.input_tokens).toBeGreaterThan(0)
    expect(result.usage.output_tokens).toBeGreaterThan(0)
  }, 60_000)

  it('stream() yields text, reasoning, and one done event', async () => {
    const events: StreamEvent[] = []
    for await (const event of adapter.stream(
      [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly STREAM_OK.' }] }],
      {
        model,
        maxTokens: 256,
        thinking: { enabled: true, effort: 'max' },
      },
    )) {
      events.push(event)
    }

    const text = events
      .filter(event => event.type === 'text')
      .map(event => event.data)
      .join('')
    const reasoningEvents = events.filter(event => event.type === 'reasoning')
    const doneEvents = events.filter(event => event.type === 'done')

    expect(text).toContain('STREAM_OK')
    expect(reasoningEvents.length).toBeGreaterThan(0)
    expect(doneEvents).toHaveLength(1)
    expect((doneEvents[0].data as LLMResponse).usage.input_tokens).toBeGreaterThan(0)
  }, 60_000)

  it('runAgent completes a thinking-mode tool loop', async () => {
    let executions = 0
    const markerTool = defineTool({
      name: 'release_marker',
      description: 'Return a fixed marker for the provider E2E test.',
      inputSchema: z.object({ token: z.string() }),
      execute: async ({ token }) => {
        executions += 1
        return {
          data: token === 'probe' ? 'TOOL_OK' : 'BAD_TOKEN',
          isError: token !== 'probe',
        }
      },
    })
    const oma = new OpenMultiAgent({
      defaultProvider: 'deepseek',
      defaultModel: model,
      maxConcurrency: 1,
    })

    const result = await oma.runAgent(
      {
        name: 'deepseek-e2e',
        systemPrompt: 'Follow the user instruction exactly and use the provided tool when requested.',
        customTools: [markerTool],
        maxTurns: 4,
        maxTokens: 512,
        callTimeoutMs: 90_000,
        thinking: { enabled: true, effort: 'max' },
      },
      'Call release_marker exactly once with token probe, then answer with exactly TOOL_OK.',
    )

    expect(result.success).toBe(true)
    expect(result.status.code).toBe('ok')
    expect(executions).toBe(1)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].toolName).toBe('release_marker')
    expect(result.output).toContain('TOOL_OK')
  }, 120_000)
})
