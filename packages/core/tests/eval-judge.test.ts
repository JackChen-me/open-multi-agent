import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createJudgeScorer,
  type ScorerContext,
} from '../src/eval/index.js'
import { buildStructuredOutputInstruction } from '../src/agent/structured-output.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
} from '../src/types.js'

function userPrompt(messages: LLMMessage[]): string {
  const message = [...messages].reverse().find((candidate) => candidate.role === 'user')
  return (message?.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function responseAdapter(
  reply: string | ((prompt: string) => string),
  captures: string[] = [],
): LLMAdapter {
  return {
    name: 'mock',
    async chat(messages): Promise<LLMResponse> {
      const prompt = userPrompt(messages)
      captures.push(prompt)
      return {
        id: `response-${captures.length}`,
        content: [{ type: 'text', text: typeof reply === 'function' ? reply(prompt) : reply }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
    async *stream() {
      yield { type: 'done' as const, data: {} }
    },
  }
}

function judge(name: string, reply: string, model = `model-${name}`): AgentConfig {
  return { name, model, adapter: responseAdapter(reply) }
}

function context(overrides: Partial<ScorerContext> = {}): ScorerContext {
  return {
    evalCase: { id: 'case-1', input: 'What is 2 + 2?', expected: '4' },
    output: '4',
    metadata: { promptVersion: 'v2' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

const verdictWithPass = z.object({
  score: z.number().min(0).max(1),
  pass: z.boolean(),
  reason: z.string(),
})

describe('createJudgeScorer', () => {
  it('runs one judge with the default verdict and omits pass', async () => {
    const scorer = createJudgeScorer({
      name: 'relevancy',
      judges: [judge('judge-1', '{"score":0.8,"reason":"relevant"}')],
      quorum: 1,
    })

    const result = await scorer.score(context())
    expect(result.score).toBe(0.8)
    expect(result.pass).toBeUndefined()
    expect(result.reason).toBe('judge-1: relevant')
    expect(result.details).toEqual({
      judges: ['judge-1'],
      models: ['model-judge-1'],
      scores: [0.8],
    })
  })

  it('averages multiple judges and passes exactly at quorum', async () => {
    const scorer = createJudgeScorer({
      name: 'quality',
      judges: [
        judge('judge-a', '{"score":0.9,"pass":true,"reason":"strong"}'),
        judge('judge-b', '{"score":0.7,"pass":true,"reason":"adequate"}'),
        judge('judge-c', '{"score":0.2,"pass":false,"reason":"weak"}'),
      ],
      quorum: 2,
      verdictSchema: verdictWithPass,
    })

    const result = await scorer.score(context())
    expect(result.score).toBeCloseTo(0.6)
    expect(result.pass).toBe(true)
    expect(result.details?.['models']).toEqual([
      'model-judge-a',
      'model-judge-b',
      'model-judge-c',
    ])
    expect(result.details?.['scores']).toEqual([0.9, 0.7, 0.2])
  })

  it('fails the binary verdict when one vote short of quorum', async () => {
    const scorer = createJudgeScorer({
      name: 'quality',
      judges: [
        judge('judge-a', '{"score":0.8,"pass":true,"reason":"yes"}'),
        judge('judge-b', '{"score":0.6,"pass":false,"reason":"no"}'),
        judge('judge-c', '{"score":0.5,"pass":false,"reason":"no"}'),
      ],
      quorum: 2,
      verdictSchema: verdictWithPass,
    })

    await expect(scorer.score(context())).resolves.toMatchObject({ pass: false })
  })

  it('throws when a custom verdict fails Zod validation', async () => {
    const scorer = createJudgeScorer({
      name: 'strict',
      judges: [judge('judge-1', '{"score":"high","pass":true,"reason":"ok"}')],
      verdictSchema: verdictWithPass,
    })

    await expect(scorer.score(context())).rejects.toThrow(/validation/i)
  })

  it('throws when a judge Agent execution fails', async () => {
    const failing: LLMAdapter = {
      name: 'failing',
      async chat() {
        throw new Error('judge provider unavailable')
      },
      async *stream() {
        yield { type: 'done' as const, data: {} }
      },
    }
    const scorer = createJudgeScorer({
      name: 'execution-failure',
      judges: [{ name: 'judge-1', model: 'judge-model', adapter: failing }],
    })

    await expect(scorer.score(context())).rejects.toThrow('judge provider unavailable')
  })

  it('uses a context-aware judgePrompt without omitting case data', async () => {
    const captures: string[] = []
    const config: AgentConfig = {
      name: 'judge-1',
      model: 'judge-model',
      adapter: responseAdapter('{"score":1,"reason":"correct"}', captures),
    }
    let received: ScorerContext | undefined
    const ctx = context({ output: 'candidate answer' })
    const scorer = createJudgeScorer({
      name: 'custom-prompt',
      judges: [config],
      judgePrompt(value) {
        received = value
        return 'Apply the customer-specific rubric.'
      },
    })

    await scorer.score(ctx)
    expect(received).toBe(ctx)
    expect(captures[0]).toContain('Apply the customer-specific rubric.')
    expect(captures[0]).toContain('candidate answer')
    expect(captures[0]).toContain('What is 2 + 2?')
  })

  it('throws on an overall judge timeout', async () => {
    const hanging: LLMAdapter = {
      name: 'hanging',
      chat(_messages, options) {
        return new Promise((_resolve, reject) => {
          const onAbort = () => reject(options.abortSignal?.reason ?? new Error('aborted'))
          if (options.abortSignal?.aborted) onAbort()
          else options.abortSignal?.addEventListener('abort', onAbort, { once: true })
        })
      },
      async *stream() {
        yield { type: 'done' as const, data: {} }
      },
    }
    const scorer = createJudgeScorer({
      name: 'timeout',
      judges: [{ name: 'judge-1', model: 'slow-model', adapter: hanging }],
      timeoutMs: 20,
    })

    await expect(scorer.score(context())).rejects.toThrow(/timeout/i)
  })

  it('aborts judge work when the caller signal is cancelled', async () => {
    const controller = new AbortController()
    const hanging: LLMAdapter = {
      name: 'hanging',
      chat(_messages, options) {
        return new Promise((_resolve, reject) => {
          const onAbort = () => reject(options.abortSignal?.reason ?? new Error('aborted'))
          if (options.abortSignal?.aborted) onAbort()
          else options.abortSignal?.addEventListener('abort', onAbort, { once: true })
        })
      },
      async *stream() {
        yield { type: 'done' as const, data: {} }
      },
    }
    const scorer = createJudgeScorer({
      name: 'abortable',
      judges: [{ name: 'judge-1', model: 'slow-model', adapter: hanging }],
    })
    const scoring = scorer.score(context({ signal: controller.signal }))
    setTimeout(() => controller.abort(new Error('cancel evaluation')), 5)

    await expect(scoring).rejects.toThrow('cancel evaluation')
  })

  it('uses fresh Agent state and does not mutate the caller judge config', async () => {
    const captures: string[] = []
    const config = Object.freeze({
      name: 'judge-1',
      model: 'judge-model',
      systemPrompt: 'Judge carefully.',
      adapter: responseAdapter('{"score":1,"reason":"ok"}', captures),
    }) satisfies AgentConfig
    const scorer = createJudgeScorer({ name: 'isolated', judges: [config] })

    await scorer.score(context({ output: 'first' }))
    await scorer.score(context({ output: 'second' }))

    expect(captures).toHaveLength(2)
    expect(captures[0]).toContain('first')
    expect(captures[0]).not.toContain('second')
    expect(captures[1]).toContain('second')
    expect(captures[1]).not.toContain('first')
    expect('outputSchema' in config).toBe(false)
    expect(config.systemPrompt).toBe('Judge carefully.')
  })

  it('validates judge roster, quorum, and timeout configuration', () => {
    expect(() => createJudgeScorer({ name: 'empty', judges: [] })).toThrow(/judge/i)
    expect(() => createJudgeScorer({
      name: 'bad-quorum',
      judges: [judge('one', '{"score":1,"reason":"ok"}')],
      quorum: 2,
    })).toThrow(/quorum/i)
    expect(() => createJudgeScorer({
      name: 'bad-timeout',
      judges: [judge('one', '{"score":1,"reason":"ok"}')],
      timeoutMs: 0,
    })).toThrow(/timeout/i)
  })

  it('passes the current judge to a function judgePrompt', async () => {
    const seenJudges: string[] = []
    const scorer = createJudgeScorer({
      name: 'per-judge',
      judges: [
        judge('alpha', '{"score":0.5,"reason":"ok"}'),
        judge('beta', '{"score":0.5,"reason":"ok"}'),
      ],
      quorum: 1,
      judgePrompt(_context, judgeConfig) {
        seenJudges.push(judgeConfig.name)
        return `Instruction for ${judgeConfig.name}.`
      },
    })

    await scorer.score(context())

    expect(seenJudges).toEqual(['alpha', 'beta'])
  })

  it('passes a structured judgePrompt through and lets it own the output instruction', async () => {
    const capturedMessages: LLMMessage[][] = []
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages): Promise<LLMResponse> {
        // Snapshot at call time — `messages` is the runner's live working
        // array and keeps growing (e.g. the assistant reply gets appended)
        // after this call returns, so a bare reference would show stale data.
        capturedMessages.push(structuredClone(messages))
        const hasOutputInstruction = userPrompt(messages).includes('Output Format (REQUIRED)')
        return {
          id: 'response-1',
          content: [{
            type: 'text',
            text: hasOutputInstruction
              ? '{"score":1,"pass":true,"reason":"matches"}'
              : 'A verdict without the required JSON instruction.',
          }],
          model: 'mock-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
      async *stream() {
        yield { type: 'done' as const, data: {} }
      },
    }
    const visionJudge: AgentConfig = {
      name: 'vision',
      model: 'vision-model',
      adapter,
      capabilities: ['vision'],
    }
    const structuredInput: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What does this chart show?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
          { type: 'text', text: buildStructuredOutputInstruction(verdictWithPass) },
        ],
      },
    ]

    const scorer = createJudgeScorer({
      name: 'structured',
      judges: [visionJudge],
      quorum: 1,
      verdictSchema: verdictWithPass,
      judgePrompt: () => structuredInput,
    })

    await scorer.score(context())

    // Passed through unchanged — no "## Case input" / "## Candidate output"
    // template wrapping from buildPrompt. Structured callers supply their own
    // schema instruction, and the image block survives intact.
    expect(capturedMessages).toEqual([structuredInput])
  })

  it('lets judgePrompt branch per judge for a mixed vision/text quorum', async () => {
    const receivedByJudge: Record<string, 'image' | 'text'> = {}
    function makeAdapter(name: string): LLMAdapter {
      return {
        name: 'mock',
        async chat(messages): Promise<LLMResponse> {
          const hasImage = messages.some((message) => message.content.some((block) => block.type === 'image'))
          receivedByJudge[name] = hasImage ? 'image' : 'text'
          const hasOutputInstruction = userPrompt(messages).includes('Output Format (REQUIRED)')
          return {
            id: `response-${name}`,
            content: [{
              type: 'text',
              text: hasOutputInstruction
                ? '{"score":1,"reason":"ok"}'
                : 'A verdict without the required JSON instruction.',
            }],
            model: 'mock-model',
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        },
        async *stream() {
          yield { type: 'done' as const, data: {} }
        },
      }
    }
    const visionJudge: AgentConfig = {
      name: 'vision-judge',
      model: 'vision-model',
      adapter: makeAdapter('vision-judge'),
      capabilities: ['vision'],
    }
    const textJudge: AgentConfig = {
      name: 'text-judge',
      model: 'text-model',
      adapter: makeAdapter('text-judge'),
    }

    const scorer = createJudgeScorer({
      name: 'mixed-quorum',
      judges: [visionJudge, textJudge],
      quorum: 2,
      judgePrompt(_context, judgeConfig) {
        const supportsVision = judgeConfig.capabilities?.includes('vision') ?? false
        const outputInstruction = buildStructuredOutputInstruction(z.object({
          score: z.number().min(0).max(1),
          reason: z.string(),
        }))
        return supportsVision
          ? [{
              role: 'user',
              content: [
                { type: 'text', text: 'Rate this image.' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
                { type: 'text', text: outputInstruction },
              ],
            }]
          : [{
              role: 'user',
              content: [
                { type: 'text', text: 'Rate this: chart shows upward trend.' },
                { type: 'text', text: outputInstruction },
              ],
            }]
      },
    })

    const result = await scorer.score(context())

    expect(receivedByJudge).toEqual({ 'vision-judge': 'image', 'text-judge': 'text' })
    expect(result.score).toBe(1)
  })
})
