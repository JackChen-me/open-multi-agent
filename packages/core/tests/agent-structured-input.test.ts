import { describe, expect, it, vi } from 'vitest'

import { Agent } from '../src/agent/agent.js'
import { InvalidMessageError } from '../src/errors.js'
import type { Scorer } from '../src/eval/scorer.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { ToolRegistry } from '../src/tool/framework.js'
import type {
  AgentConfig,
  ContentBlock,
  ExternalAgentBackendConfig,
  ImageBlock,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  OrchestratorEvent,
} from '../src/types.js'

const IMAGE: ImageBlock = {
  type: 'image',
  source: {
    type: 'base64',
    media_type: 'image/png',
    data: 'aW1hZ2U=',
  },
}

function response(text = 'ok'): LLMResponse {
  return {
    id: 'structured-input-response',
    content: [{ type: 'text', text }],
    model: 'test-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 2, output_tokens: 1 },
  }
}

function recordingAdapter(calls: LLMMessage[][], text = 'ok'): LLMAdapter {
  return {
    name: 'structured-input-test',
    async chat(messages) {
      calls.push(structuredClone(messages))
      return response(text)
    },
    async *stream() { /* AgentRunner streams through chat(). */ },
  }
}

function createAgent(
  config: Partial<AgentConfig> = {},
  calls: LLMMessage[][] = [],
): Agent {
  const registry = new ToolRegistry()
  return new Agent({
    name: 'structured-agent',
    model: 'test-model',
    adapter: recordingAdapter(calls),
    ...config,
  }, registry, new ToolExecutor(registry))
}

function callerHistory(): LLMMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'Earlier question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        structuredClone(IMAGE),
      ],
    },
  ]
}

describe('public structured Agent input', () => {
  it('run() and stream() accept caller history with images and copy it at call time', async () => {
    const calls: LLMMessage[][] = []
    const agent = createAgent({}, calls)

    const runInput = callerHistory()
    const expectedRunInput = structuredClone(runInput)
    const run = agent.run(runInput)
    ;(runInput[2]!.content[0] as { text: string }).text = 'caller mutation'
    runInput.splice(0, runInput.length)

    await expect(run).resolves.toMatchObject({ success: true, output: 'ok' })
    expect(calls[0]).toEqual(expectedRunInput)

    const streamInput = callerHistory()
    const expectedStreamInput = structuredClone(streamInput)
    const stream = agent.stream(streamInput)
    ;(streamInput[2]!.content[1] as { source: { data: string } }).source.data = 'mutated'
    streamInput.splice(0, 1)

    const events = []
    for await (const event of stream) events.push(event)

    expect(events.some((event) => event.type === 'done')).toBe(true)
    expect(calls[1]).toEqual(expectedStreamInput)
  })

  it('prompt() appends one structured user turn and keeps defensive persistent history', async () => {
    const calls: LLMMessage[][] = []
    const restoredHistory: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Stored question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Stored answer' }] },
    ]
    const expectedRestoredHistory = structuredClone(restoredHistory)
    const blocks: ContentBlock[] = [
      structuredClone(IMAGE),
      { type: 'text', text: 'Continue from the stored conversation.' },
    ]
    const expectedBlocks = structuredClone(blocks)
    const agent = createAgent({
      history: restoredHistory,
      beforeRun: (ctx) => ({ ...ctx, prompt: 'hook-rewritten turn' }),
    }, calls)

    const prompt = agent.prompt(blocks)
    ;(restoredHistory[0]!.content[0] as { text: string }).text = 'mutated history'
    ;(blocks[0] as { source: { data: string } }).source.data = 'mutated image'
    blocks.splice(0, blocks.length)
    const result = await prompt
    expect(result).toMatchObject({ success: true })

    expect(calls[0]).toEqual([
      ...expectedRestoredHistory,
      {
        role: 'user',
        content: [expectedBlocks[0]!, { type: 'text', text: 'hook-rewritten turn' }],
      },
    ])

    const history = agent.getHistory()
    expect(history).toEqual([
      ...expectedRestoredHistory,
      { role: 'user', content: expectedBlocks },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ])

    ;(history[0]!.content[0] as { text: string }).text = 'mutated snapshot'
    ;(result.messages[0]!.content[0] as { text: string }).text = 'mutated result'
    expect((agent.getHistory()[0]!.content[0] as { text: string }).text).toBe('Stored question')
    expect((agent.getHistory().at(-1)!.content[0] as { text: string }).text).toBe('ok')
  })

  it('beforeRun exposes full messages and applies messages before the prompt rewrite', async () => {
    const calls: LLMMessage[][] = []
    let receivedMessages: readonly LLMMessage[] | undefined
    let receivedPrompt: string | undefined
    const beforeImage = { ...structuredClone(IMAGE), source: { ...IMAGE.source, data: 'before' } }
    const afterImage = { ...structuredClone(IMAGE), source: { ...IMAGE.source, data: 'after' } }
    const agent = createAgent({
      beforeRun(ctx) {
        receivedMessages = ctx.messages
        receivedPrompt = ctx.prompt
        return {
          ...ctx,
          prompt: 'prompt replacement',
          messages: [
            { role: 'assistant', content: [{ type: 'text', text: 'caller history' }] },
            {
              role: 'user',
              content: [
                beforeImage,
                { type: 'text', text: 'message replacement one' },
                afterImage,
                { type: 'text', text: 'message replacement two' },
              ],
            },
          ],
        }
      },
    }, calls)
    const input: LLMMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'first' },
        structuredClone(IMAGE),
        { type: 'text', text: 'second' },
      ],
    }]

    await agent.run(input)

    expect(receivedPrompt).toBe('firstsecond')
    expect(receivedMessages).toEqual(input)
    expect(calls[0]).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'caller history' }] },
      {
        role: 'user',
        content: [
          beforeImage,
          { type: 'text', text: 'prompt replacement' },
          afterImage,
        ],
      },
    ])
    expect(input[0]!.content).toHaveLength(3)
  })

  it('rejects malformed input before hooks or state/history mutation', async () => {
    const calls: LLMMessage[][] = []
    const beforeRun = vi.fn((ctx) => ctx)
    const agent = createAgent({ beforeRun }, calls)
    const invalidMessages = [
      { role: 'user', content: 'not-blocks' },
    ] as unknown as LLMMessage[]

    await expect(agent.run(invalidMessages)).rejects.toBeInstanceOf(InvalidMessageError)
    expect(() => agent.stream(invalidMessages)).toThrow(InvalidMessageError)
    await expect(agent.prompt([null] as unknown as ContentBlock[]))
      .rejects.toBeInstanceOf(InvalidMessageError)
    await expect(agent.prompt(null as unknown as ContentBlock[]))
      .rejects.toBeInstanceOf(InvalidMessageError)

    const uncloneableMessages: LLMMessage[] = [{
      role: 'user',
      content: [{
        type: 'tool_use',
        id: 'uncloneable',
        name: 'test',
        input: { callback: () => undefined },
      }],
    }]
    await expect(agent.run(uncloneableMessages)).rejects.toThrow(/cloneable structured data/)

    expect(beforeRun).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
    expect(agent.getState().status).toBe('idle')
    expect(agent.getHistory()).toEqual([])
  })

  it('validates and copies AgentConfig.history when the Agent is constructed', () => {
    const history = callerHistory()
    const agent = createAgent({ history })
    ;(history[0]!.content[0] as { text: string }).text = 'mutated after construction'
    expect((agent.getHistory()[0]!.content[0] as { text: string }).text).toBe('Earlier question')

    const invalidHistory = [
      { role: 'user', content: 'not-blocks' },
    ] as unknown as LLMMessage[]
    expect(() => createAgent({ history: invalidHistory })).toThrow(InvalidMessageError)
  })
})

describe('structured input with text-only external backends', () => {
  const backends: ExternalAgentBackendConfig[] = [
    { kind: 'process', command: process.execPath },
    { kind: 'acp', command: 'unused-acp-command' },
  ]

  for (const backend of backends) {
    it(`${backend.kind} rejects structured arguments before hooks, spawn, or history mutation`, async () => {
      const beforeRun = vi.fn((ctx) => ctx)
      const registry = new ToolRegistry()
      const agent = new Agent({ name: backend.kind, backend, beforeRun }, registry, new ToolExecutor(registry))

      await expect(agent.run(callerHistory())).rejects.toThrow(/accepts string prompts only/)
      expect(() => agent.stream(callerHistory())).toThrow(/accepts string prompts only/)
      await expect(agent.prompt([{ type: 'text', text: 'structured text' }]))
        .rejects.toThrow(/accepts string prompts only/)

      expect(beforeRun).not.toHaveBeenCalled()
      expect(agent.getHistory()).toEqual([])
    })
  }

  it('retains beforeRun.prompt rewrites for string process runs', async () => {
    const registry = new ToolRegistry()
    const agent = new Agent({
      name: 'external-prompt-hook',
      backend: { kind: 'process', command: process.execPath },
      beforeRun: (ctx) => ({ ...ctx, prompt: 'console.log("rewritten")' }),
    }, registry, new ToolExecutor(registry))

    const result = await agent.run('console.log("original")')
    expect(result.success).toBe(true)
    expect(result.output.trim()).toBe('rewritten')
  })

  it('rejects beforeRun.messages changes before starting an external backend', async () => {
    const registry = new ToolRegistry()
    const agent = new Agent({
      name: 'external-hook',
      backend: { kind: 'process', command: process.execPath },
      beforeRun(ctx) {
        return {
          ...ctx,
          messages: [{ role: 'user', content: [structuredClone(IMAGE)] }],
        }
      },
    }, registry, new ToolExecutor(registry))

    const result = await agent.run('plain text')
    expect(result).toMatchObject({ success: false, status: { code: 'error' } })
    expect(result.output).toContain('beforeRun.messages cannot be forwarded without loss')
  })
})

describe('OpenMultiAgent structured run lifecycle', () => {
  it('preserves string progress data and isolates structured progress, evaluation, and execution copies', async () => {
    const calls: LLMMessage[][] = []
    const progressSnapshots: unknown[] = []
    const scoredInputs: unknown[] = []
    const scorer: Scorer = {
      name: 'capture-input',
      score({ evalCase }) {
        scoredInputs.push(evalCase.input)
        return { score: 1 }
      },
    }
    const oma = new OpenMultiAgent({
      defaultModel: 'test-model',
      onProgress(event: OrchestratorEvent) {
        if (event.type !== 'agent_start') return
        progressSnapshots.push(structuredClone(event.data))
        const messages = (event.data as { messages?: LLMMessage[] })?.messages
        const text = messages?.[0]?.content[0]
        if (text?.type === 'text') (text as { text: string }).text = 'progress mutation'
      },
      evaluation: {
        scorers: [scorer],
        sample: 1,
        storePayloads: 'full',
      },
    })
    const config: AgentConfig = {
      name: 'lifecycle-agent',
      model: 'test-model',
      adapter: recordingAdapter(calls),
    }

    await oma.runAgent(config, 'plain string')
    expect(progressSnapshots[0]).toEqual({ prompt: 'plain string' })

    const messages = callerHistory()
    const expected = structuredClone(messages)
    await oma.runAgent(config, messages)
    ;(messages[0]!.content[0] as { text: string }).text = 'post-run caller mutation'
    await oma.evaluation.forceFlush({ timeoutMs: 1_000 })

    expect(progressSnapshots[1]).toEqual({ messages: expected })
    expect(calls[1]).toEqual(expected)
    expect(JSON.parse(String(scoredInputs[1]))).toEqual(expected)
  })

  it('rejects invalid external structured input before progress or online evaluation', async () => {
    const onProgress = vi.fn()
    const scorer: Scorer = { name: 'unused', score: () => ({ score: 1 }) }
    const oma = new OpenMultiAgent({
      onProgress,
      evaluation: { scorers: [scorer], sample: 1 },
    })

    await expect(oma.runAgent({
      name: 'external',
      backend: { kind: 'process', command: process.execPath },
    }, callerHistory())).rejects.toBeInstanceOf(InvalidMessageError)

    expect(onProgress).not.toHaveBeenCalled()
    expect(oma.evaluation.getStats().sampled).toBe(0)
  })
})
