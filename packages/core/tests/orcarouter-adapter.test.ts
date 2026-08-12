import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock OpenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
const OpenAIMock = vi.hoisted(() => vi.fn())

vi.mock('openai', () => ({
  default: OpenAIMock,
}))

import { OrcaRouterAdapter } from '../src/llm/orcarouter.js'
import { createAdapter } from '../src/llm/adapter.js'

// ---------------------------------------------------------------------------
// OrcaRouterAdapter tests
// ---------------------------------------------------------------------------

describe('OrcaRouterAdapter', () => {
  beforeEach(() => {
    OpenAIMock.mockClear()
  })

  it('has name "orcarouter"', () => {
    const adapter = new OrcaRouterAdapter()
    expect(adapter.name).toBe('orcarouter')
  })

  it('uses ORCAROUTER_API_KEY by default', () => {
    const original = process.env['ORCAROUTER_API_KEY']
    process.env['ORCAROUTER_API_KEY'] = 'orca-test-key-123'

    try {
      new OrcaRouterAdapter()
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'orca-test-key-123',
          baseURL: 'https://api.orcarouter.ai/v1',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['ORCAROUTER_API_KEY']
      } else {
        process.env['ORCAROUTER_API_KEY'] = original
      }
    }
  })

  it('uses official OrcaRouter baseURL by default', () => {
    new OrcaRouterAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://api.orcarouter.ai/v1',
      })
    )
  })

  it('allows overriding apiKey and baseURL', () => {
    new OrcaRouterAdapter('custom-key', 'https://custom.endpoint/v1')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        baseURL: 'https://custom.endpoint/v1',
      })
    )
  })

  it('createAdapter("orcarouter") returns OrcaRouterAdapter instance', async () => {
    const adapter = await createAdapter('orcarouter')
    expect(adapter).toBeInstanceOf(OrcaRouterAdapter)
  })
})
