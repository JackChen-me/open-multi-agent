import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import OpenAI from 'openai'

import { UnsupportedToolCallError } from '../src/errors.js'
import { OpenAIAdapter } from '../src/llm/openai.js'
import { chatOpts, collectEvents, textMsg, toolDef } from './helpers/llm-fixtures.js'

let server: Server
let baseURL: string

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const body = await readJson(request)
    const model = body['model']

    if (model === 'sdk-error') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        error: { message: 'invalid test key', type: 'invalid_request_error' },
      }))
      return
    }

    if (model === 'sdk-abort') return

    if (body['stream'] === true) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-stream',
        model: 'sdk-stream',
        choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-stream',
        model: 'sdk-stream',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-stream',
        model: 'sdk-stream',
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }

    const toolCalls = model === 'sdk-custom'
      ? [{
          id: 'custom_1',
          type: 'custom',
          custom: { name: 'shell', input: 'echo unsupported' },
        }]
      : [{
          id: 'call_1',
          type: 'function',
          function: { name: 'search', arguments: '{"query":"sdk"}' },
        }]

    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      id: 'chatcmpl-boundary',
      object: 'chat.completion',
      created: 1,
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: toolCalls },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
    }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  baseURL = `http://127.0.0.1:${address.port}/v1`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
  })
})

describe('OpenAI SDK boundary', () => {
  it('maps a real SDK function-tool response and usage', async () => {
    const adapter = new OpenAIAdapter('test-key', baseURL)
    const response = await adapter.chat(
      [textMsg('user', 'search')],
      chatOpts({ model: 'sdk-function', tools: [toolDef('search')] }),
    )

    expect(response.content).toEqual([{
      type: 'tool_use',
      id: 'call_1',
      name: 'search',
      input: { query: 'sdk' },
    }])
    expect(response.stop_reason).toBe('tool_use')
    expect(response.usage).toEqual({ input_tokens: 7, output_tokens: 4 })
  })

  it('keeps usage from the final choice-less SSE chunk', async () => {
    const adapter = new OpenAIAdapter('test-key', baseURL)
    const events = await collectEvents(adapter.stream(
      [textMsg('user', 'stream')],
      chatOpts({ model: 'sdk-stream' }),
    ))

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      data: {
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    })
  })

  it('preserves SDK APIError status for retry classification', async () => {
    const adapter = new OpenAIAdapter('test-key', baseURL)

    await expect(adapter.chat(
      [textMsg('user', 'fail')],
      chatOpts({ model: 'sdk-error' }),
    )).rejects.toMatchObject({
      name: 'Error',
      status: 401,
    } satisfies Partial<OpenAI.APIError>)
  })

  it('rejects unsupported custom-tool response variants explicitly', async () => {
    const adapter = new OpenAIAdapter('test-key', baseURL)

    await expect(adapter.chat(
      [textMsg('user', 'custom')],
      chatOpts({ model: 'sdk-custom' }),
    )).rejects.toBeInstanceOf(UnsupportedToolCallError)
  })

  it('forwards AbortSignal through the real SDK request path', async () => {
    const adapter = new OpenAIAdapter('test-key', baseURL)
    const controller = new AbortController()
    const pending = adapter.chat(
      [textMsg('user', 'wait')],
      chatOpts({ model: 'sdk-abort', abortSignal: controller.signal }),
    )
    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(OpenAI.APIUserAbortError)
  })
})
