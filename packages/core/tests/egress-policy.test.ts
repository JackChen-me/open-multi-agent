import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LanguageModel } from 'ai'
import { Agent } from '../src/agent/agent.js'
import { AISdkAdapter } from '../src/llm/ai-sdk.js'
import { createAdapter } from '../src/llm/adapter.js'
import {
  createEgressFetch,
  intersectEgressPolicies,
  normalizeEgressPolicy,
} from '../src/llm/egress.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { ToolRegistry } from '../src/tool/framework.js'
import type { EgressPolicy, LLMAdapter, StreamEvent } from '../src/types.js'

const originalOpenAIBaseURL = process.env['OPENAI_BASE_URL']
const originalAzureEndpoint = process.env['AZURE_OPENAI_ENDPOINT']

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function makeAgent(adapter: LLMAdapter, policy: EgressPolicy): Agent {
  const registry = new ToolRegistry()
  return new Agent(
    {
      name: 'policy-agent',
      model: 'test-model',
      adapter,
      egressPolicy: policy,
    },
    registry,
    new ToolExecutor(registry),
  )
}

afterEach(() => {
  restoreEnv('OPENAI_BASE_URL', originalOpenAIBaseURL)
  restoreEnv('AZURE_OPENAI_ENDPOINT', originalAzureEndpoint)
  vi.restoreAllMocks()
})

describe('egress policy validation and matching', () => {
  it('rejects malformed allowlist entries instead of silently broadening them', () => {
    expect(() => normalizeEgressPolicy({
      mode: 'allowlist',
      allowedOrigins: ['https://api.example.test/v1'],
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_EGRESS_POLICY',
      reason: 'invalid-policy',
    }))

    expect(() => normalizeEgressPolicy({
      mode: 'allowlist',
      allowedOrigins: ['https://user:secret@api.example.test'],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_EGRESS_POLICY' }))

    expect(() => normalizeEgressPolicy({
      mode: 'offline',
      allowedOrigins: ['https://api.example.test'],
    } as unknown as EgressPolicy)).toThrowError(expect.objectContaining({
      code: 'INVALID_EGRESS_POLICY',
    }))
  })

  it('allows loopback HTTP in offline mode and never calls fetch for a remote target', async () => {
    const implementation = vi.fn(async () => new Response('ok')) as typeof globalThis.fetch
    const guarded = createEgressFetch({ mode: 'offline' }, 'openai', implementation)

    await guarded('http://127.42.0.9:11434/v1/chat/completions', {
      method: 'POST',
      redirect: 'follow',
    })
    await guarded('http://worker.localhost:8080/v1/models')
    await guarded('http://[::1]:8000/v1/models')

    expect(implementation).toHaveBeenCalledTimes(3)
    expect(implementation).toHaveBeenNthCalledWith(
      1,
      'http://127.42.0.9:11434/v1/chat/completions',
      expect.objectContaining({ redirect: 'error' }),
    )

    await expect(guarded('https://api.openai.com/v1/chat/completions')).rejects.toMatchObject({
      code: 'EGRESS_POLICY_DENIED',
      reason: 'denied',
      provider: 'openai',
      origin: 'https://api.openai.com',
    })
    expect(implementation).toHaveBeenCalledTimes(3)
  })

  it('matches allowlist entries by exact origin, including the port', async () => {
    const implementation = vi.fn(async () => new Response('ok')) as typeof globalThis.fetch
    const guarded = createEgressFetch({
      mode: 'allowlist',
      allowedOrigins: ['https://api.example.test:8443'],
    }, 'test-provider', implementation)

    await guarded('https://api.example.test:8443/v1/chat')
    await expect(guarded('https://api.example.test/v1/chat')).rejects.toMatchObject({
      code: 'EGRESS_POLICY_DENIED',
      origin: 'https://api.example.test',
    })
    expect(implementation).toHaveBeenCalledTimes(1)
  })

  it('intersects scopes so a narrower run or agent policy cannot widen a parent', () => {
    expect(intersectEgressPolicies(
      {
        mode: 'allowlist',
        allowedOrigins: ['https://api.openai.com', 'http://localhost:11434'],
      },
      { mode: 'offline' },
    )).toEqual({
      mode: 'allowlist',
      allowedOrigins: ['http://localhost:11434'],
    })

    expect(intersectEgressPolicies(
      { mode: 'allowlist', allowedOrigins: ['https://one.example'] },
      { mode: 'allowlist', allowedOrigins: ['https://two.example'] },
    )).toEqual({ mode: 'allowlist', allowedOrigins: [] })
  })
})

describe('built-in adapter enforcement', () => {
  it('preserves legacy adapter construction when no policy is configured', async () => {
    const adapter = await createAdapter('openai', 'test-key')
    expect(adapter.name).toBe('openai')
  })

  it('allows an explicit local OpenAI-compatible baseURL in offline mode', async () => {
    const adapter = await createAdapter(
      'openai',
      'local-placeholder',
      'http://127.0.0.1:11434/v1',
      undefined,
      { mode: 'offline' },
    )
    expect(adapter.name).toBe('openai')
  })

  it('constructs every enforceable built-in adapter only for its allowed origin', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('test must not open a network connection'),
    )
    const cases = [
      ['anthropic', 'https://api.anthropic.com'],
      ['openai', 'https://api.openai.com/v1'],
      ['azure-openai', 'https://resource.openai.azure.com'],
      ['deepseek', 'https://api.deepseek.com/v1'],
      ['doubao', 'https://ark.cn-beijing.volces.com/api/v3'],
      ['grok', 'https://api.x.ai/v1'],
      ['hunyuan', 'https://tokenhub.tencentmaas.com/v1'],
      ['minimax', 'https://api.minimax.io/v1'],
      ['mimo', 'https://api.xiaomimimo.com/v1'],
      ['qiniu', 'https://api.qnaigc.com/v1'],
    ] as const

    for (const [provider, baseURL] of cases) {
      const adapter = await createAdapter(
        provider,
        'test-key',
        baseURL,
        undefined,
        { mode: 'allowlist', allowedOrigins: [new URL(baseURL).origin] },
      )
      expect(adapter.name).toBe(provider)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('denies every enforceable hosted adapter before SDK I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('test must not open a network connection'),
    )
    const cases = [
      ['anthropic', 'https://api.anthropic.com'],
      ['openai', 'https://api.openai.com/v1'],
      ['azure-openai', 'https://resource.openai.azure.com'],
      ['deepseek', 'https://api.deepseek.com/v1'],
      ['doubao', 'https://ark.cn-beijing.volces.com/api/v3'],
      ['grok', 'https://api.x.ai/v1'],
      ['hunyuan', 'https://tokenhub.tencentmaas.com/v1'],
      ['minimax', 'https://api.minimax.io/v1'],
      ['mimo', 'https://api.xiaomimimo.com/v1'],
      ['qiniu', 'https://api.qnaigc.com/v1'],
    ] as const

    for (const [provider, baseURL] of cases) {
      await expect(createAdapter(
        provider,
        'test-key',
        baseURL,
        undefined,
        { mode: 'offline' },
      )).rejects.toMatchObject({
        code: 'EGRESS_POLICY_DENIED',
        provider,
        origin: new URL(baseURL).origin,
      })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses explicit baseURL before environment configuration and denies before SDK construction', async () => {
    process.env['OPENAI_BASE_URL'] = 'http://localhost:11434/v1'

    await expect(createAdapter(
      'openai',
      'test-key',
      'https://api.openai.com/v1',
      undefined,
      { mode: 'offline' },
    )).rejects.toMatchObject({
      code: 'EGRESS_POLICY_DENIED',
      origin: 'https://api.openai.com',
    })
  })

  it('uses a provider endpoint environment variable when baseURL is omitted', async () => {
    process.env['OPENAI_BASE_URL'] = 'http://localhost:11434/v1'

    const adapter = await createAdapter(
      'openai',
      'local-placeholder',
      undefined,
      undefined,
      { mode: 'offline' },
    )
    expect(adapter.name).toBe('openai')
  })

  it('requires a resolvable Azure endpoint before loading the SDK', async () => {
    delete process.env['AZURE_OPENAI_ENDPOINT']

    await expect(createAdapter(
      'azure-openai',
      'test-key',
      undefined,
      undefined,
      { mode: 'allowlist', allowedOrigins: ['https://resource.openai.azure.com'] },
    )).rejects.toMatchObject({
      code: 'EGRESS_POLICY_TARGET_UNRESOLVED',
      reason: 'unresolved-target',
      provider: 'azure-openai',
    })
  })

  it('uses the checked Azure endpoint even when OPENAI_BASE_URL is set', async () => {
    process.env['OPENAI_BASE_URL'] = 'https://unrelated.example/v1'

    const adapter = await createAdapter(
      'azure-openai',
      'test-key',
      'https://resource.openai.azure.com',
      undefined,
      { mode: 'allowlist', allowedOrigins: ['https://resource.openai.azure.com'] },
    )
    expect(adapter.name).toBe('azure-openai')
  })

  it('fails closed for SDKs whose complete transport surface is not enforceable', async () => {
    for (const provider of ['gemini', 'bedrock'] as const) {
      await expect(createAdapter(
        provider,
        'test-key',
        undefined,
        undefined,
        { mode: 'offline' },
      )).rejects.toMatchObject({
        code: 'EGRESS_POLICY_UNSUPPORTED',
        reason: 'unsupported',
        provider,
      })
    }
  })
})

describe('run-level precedence and error contracts', () => {
  it('returns a rejected non-retryable LLM result when policy scopes have no common origin', async () => {
    const oma = new OpenMultiAgent({
      defaultModel: 'test-model',
      defaultProvider: 'openai',
      defaultApiKey: 'test-key',
      egressPolicy: {
        mode: 'allowlist',
        allowedOrigins: ['https://api.openai.com'],
      },
    })

    const result = await oma.runAgent({
      name: 'restricted',
      baseURL: 'https://api.openai.com/v1',
    }, 'hello', {
      egressPolicy: { mode: 'offline' },
    })

    expect(result.success).toBe(false)
    expect(result.status).toMatchObject({ code: 'rejected' })
    expect(result.errorInfo).toMatchObject({
      kind: 'validation',
      code: 'EGRESS_POLICY_DENIED',
      retryable: false,
    })
    expect(result.toolCalls).toEqual([])
  })

  it('applies the run policy to structured input before provider I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('test must not open a network connection'),
    )
    const oma = new OpenMultiAgent({
      defaultModel: 'test-model',
      defaultProvider: 'openai',
      defaultApiKey: 'test-key',
    })

    const result = await oma.runAgent({
      name: 'structured-restricted',
      baseURL: 'https://api.openai.com/v1',
    }, [{
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    }], {
      egressPolicy: { mode: 'offline' },
    })

    expect(result).toMatchObject({
      success: false,
      status: { code: 'rejected' },
      errorInfo: {
        kind: 'validation',
        code: 'EGRESS_POLICY_DENIED',
        retryable: false,
      },
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('lets an agent policy narrow an orchestrator allowlist', async () => {
    const oma = new OpenMultiAgent({
      defaultModel: 'test-model',
      defaultProvider: 'openai',
      defaultApiKey: 'test-key',
      egressPolicy: {
        mode: 'allowlist',
        allowedOrigins: ['https://api.openai.com'],
      },
    })

    const result = await oma.runAgent({
      name: 'agent-narrowed',
      baseURL: 'https://api.openai.com/v1',
      egressPolicy: { mode: 'offline' },
    }, 'hello')

    expect(result).toMatchObject({
      success: false,
      errorInfo: { code: 'EGRESS_POLICY_DENIED' },
    })
  })

  it('propagates the run policy through top-level consensus agents', async () => {
    const oma = new OpenMultiAgent({
      defaultModel: 'test-model',
      defaultProvider: 'openai',
      defaultApiKey: 'test-key',
      defaultBaseURL: 'https://api.openai.com/v1',
    })
    const team = oma.createTeam('consensus-egress', {
      name: 'consensus-egress',
      agents: [],
    })

    const result = await oma.runConsensus(team, 'hello', {
      proposer: { name: 'proposer' },
      judges: [{ name: 'judge' }],
      egressPolicy: { mode: 'offline' },
    })

    expect(result).toMatchObject({
      verdict: 'rejected',
      status: { code: 'rejected' },
      errorInfo: { code: 'EGRESS_POLICY_DENIED', retryable: false },
    })
  })

  it('rejects a custom adapter before invoking it when a policy is active', async () => {
    const chat = vi.fn()
    const customAdapter: LLMAdapter = {
      name: 'custom-http-adapter',
      chat,
      async *stream(): AsyncGenerator<StreamEvent> {
        throw new Error('must not run')
      },
    }

    const result = await makeAgent(customAdapter, { mode: 'offline' }).run('hello')

    expect(chat).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      success: false,
      status: { code: 'rejected' },
      errorInfo: {
        kind: 'validation',
        code: 'EGRESS_POLICY_UNSUPPORTED',
        retryable: false,
      },
    })
  })

  it('rejects the opaque AI SDK bridge before it can call the model', async () => {
    const dummyModel = { _brand: 'test' } as unknown as LanguageModel
    const result = await makeAgent(
      new AISdkAdapter(dummyModel),
      { mode: 'offline' },
    ).run('hello')

    expect(result).toMatchObject({
      success: false,
      status: { code: 'rejected' },
      errorInfo: { code: 'EGRESS_POLICY_UNSUPPORTED' },
    })
  })

  it('does not claim to constrain an external process backend', async () => {
    const registry = new ToolRegistry()
    const agent = new Agent({
      name: 'local-process',
      egressPolicy: { mode: 'offline' },
      backend: {
        kind: 'process',
        command: process.execPath,
        args: [
          '-e',
          "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('process-owned'))",
        ],
      },
    }, registry, new ToolExecutor(registry))

    const result = await agent.run('hello')

    expect(result.success).toBe(true)
    expect(result.output).toBe('process-owned')
  })

  it('leaves a custom semantic profiler application-owned and uncovered', async () => {
    const profile = vi.fn(async () => ({
      profile: {
        evidenceSources: 'single' as const,
        independentReview: 'none' as const,
        conflictingObjectives: false,
        sideEffectIntent: 'none' as const,
        permissionIsolation: 'none' as const,
        decomposable: false,
        parallelizable: false,
        complexity: 'low' as const,
        confidence: 0.95,
        reasons: ['Application-owned fixture.'],
        source: 'inferred' as const,
      },
    }))
    const oma = new OpenMultiAgent({
      defaultModel: 'test-model',
      egressPolicy: { mode: 'offline' },
      executionRouting: {
        strategy: 'hybrid',
        profiler: { version: 'application-profiler-v1', profile },
      },
    })
    const team = oma.createTeam('custom-profiler-egress', {
      name: 'custom-profiler-egress',
      agents: [{
        name: 'process-worker',
        backend: {
          kind: 'process',
          command: process.execPath,
          args: [
            '-e',
            "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('done'))",
          ],
        },
      }],
    })

    const result = await oma.runTeam(team, 'Say hello')

    expect(profile).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
  })
})
