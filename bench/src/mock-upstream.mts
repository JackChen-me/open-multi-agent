/**
 * Offline stand-in for the provider API.
 *
 * `--mock` exercises the whole harness — proxy accounting, DAG execution,
 * structured output, judging, CSV and cost math — without spending a token, so
 * a wiring bug is found before the paid pilot rather than during it. It is a
 * plumbing check only: nothing it produces is benchmark data.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'

const MARKDOWN_REPLY = [
  '## Summary',
  '',
  'Mock summary paragraph produced by the offline stand-in upstream.',
  '',
  '## Action Items',
  '',
  '| Task | Owner | Due |',
  '| --- | --- | --- |',
  '| Mock task | Mock owner | 2026-01-01 |',
  '',
  '## Sentiment',
  '',
  '- Mock participant: neutral',
  '',
  '## Next Steps',
  '',
  '1. Mock follow-up.',
].join('\n')

function replyFor(requestBody: string): string {
  // Structured-output agents receive their JSON schema in the prompt, so the
  // schema's distinctive key names identify which shape to return.
  if (requestBody.includes('output_1') && requestBody.includes('preferred')) {
    return JSON.stringify({
      output_1: { score: 0.7, reason: 'Mock verdict for output 1.' },
      output_2: { score: 0.6, reason: 'Mock verdict for output 2.' },
      preferred: '1',
    })
  }
  if (requestBody.includes('participants') && requestBody.includes('tone')) {
    return JSON.stringify({
      participants: [{ participant: 'Mock', tone: 'neutral', evidence: 'Mock evidence.' }],
    })
  }
  if (requestBody.includes('"items"') || requestBody.includes('due_date')) {
    return JSON.stringify({ items: [{ task: 'Mock task', owner: 'Mock owner', due_date: '2026-01-01' }] })
  }
  return MARKDOWN_REPLY
}

export interface MockUpstream {
  readonly origin: string
  stop(): Promise<void>
}

export async function startMockUpstream(latencyMs = 120): Promise<MockUpstream> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8')
      const content = replyFor(body)
      // Deterministic, obviously-fake token counts.
      const payload = {
        id: 'mock-completion',
        object: 'chat.completion',
        model: (JSON.parse(body || '{}') as { model?: string }).model ?? 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: Math.max(1, Math.round(body.length / 4)),
          completion_tokens: Math.max(1, Math.round(content.length / 4)),
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: Math.max(1, Math.round(body.length / 4)),
          total_tokens: Math.max(2, Math.round((body.length + content.length) / 4)),
        },
      }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }, latencyMs)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port

  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
