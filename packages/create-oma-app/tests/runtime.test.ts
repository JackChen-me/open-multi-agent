import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveRuntime } from '../template/src/runtime.js'

const original = {
  runtime: process.env.OMA_RUNTIME,
  model: process.env.OMA_MODEL,
  host: process.env.OLLAMA_HOST,
  key: process.env.OPENAI_API_KEY,
  base: process.env.OPENAI_BASE_URL,
}

afterEach(() => {
  vi.restoreAllMocks()
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore('OMA_RUNTIME', original.runtime)
  restore('OMA_MODEL', original.model)
  restore('OLLAMA_HOST', original.host)
  restore('OPENAI_API_KEY', original.key)
  restore('OPENAI_BASE_URL', original.base)
})

beforeEach(() => {
  delete process.env.OMA_MODEL
})

describe('resolveRuntime', () => {
  it('uses cloud environment settings and requires a key', async () => {
    delete process.env.OMA_RUNTIME
    delete process.env.OPENAI_API_KEY
    await expect(resolveRuntime()).rejects.toThrow('Missing OPENAI_API_KEY')
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OMA_MODEL = 'test-model'
    process.env.OPENAI_BASE_URL = 'https://example.test/v1'
    await expect(resolveRuntime()).resolves.toMatchObject({ runtime: 'cloud', model: 'test-model', baseURL: 'https://example.test/v1' })
  })

  it('prefers OMA_MODEL and otherwise selects Ollamas first model', async () => {
    process.env.OMA_RUNTIME = 'ollama'
    process.env.OLLAMA_HOST = 'http://localhost:11434/'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ models: [{ name: 'first-model' }, { name: 'second-model' }] }), { status: 200 }),
    )
    await expect(resolveRuntime()).resolves.toMatchObject({ runtime: 'ollama', model: 'first-model', baseURL: 'http://localhost:11434/v1' })
    process.env.OMA_MODEL = 'chosen-model'
    await expect(resolveRuntime()).resolves.toMatchObject({ model: 'chosen-model' })
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/tags', expect.any(Object))
  })

  it('reports unavailable Ollama and empty model lists', async () => {
    process.env.OMA_RUNTIME = 'ollama'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'))
    await expect(resolveRuntime()).rejects.toThrow('Ollama is unavailable')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), { status: 200 }))
    await expect(resolveRuntime()).rejects.toThrow('no installed models')
  })
})
