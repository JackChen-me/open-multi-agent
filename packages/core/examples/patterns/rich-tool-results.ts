/**
 * Rich Tool Results
 *
 * Keep an application-owned artifact record while returning an image preview
 * to the model without converting either value to a JSON/text blob.
 *
 * Run:
 *   npx tsx packages/core/examples/patterns/rich-tool-results.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { z } from 'zod'
import { defineTool, OpenMultiAgent } from '../../src/index.js'
import type { AgentConfig } from '../../src/types.js'

// A one-pixel PNG keeps the example self-contained. Real tools usually obtain
// bytes from a renderer, camera, document service, or object store.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

const renderPreview = defineTool({
  name: 'render_preview',
  description: 'Render an image preview for a named artifact.',
  inputSchema: z.object({ label: z.string() }),
  outputSchema: z.object({
    previewId: z.string(),
    byteLength: z.number().int().positive(),
  }),
  execute: async ({ label }) => ({
    // Application-owned data is available to onToolResult, but is not guessed
    // into the model transcript.
    data: {
      previewId: `preview-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      byteLength: Buffer.from(PNG_BASE64, 'base64').byteLength,
    },
    // modelOutput is copied, validated, and converted by the selected adapter.
    modelOutput: [
      { type: 'text', text: `Preview rendered for ${label}.` },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: PNG_BASE64,
        },
      },
    ],
  }),
})

const agent: AgentConfig = {
  name: 'preview-reviewer',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  tools: ['render_preview'],
  customTools: [renderPreview],
  systemPrompt: 'Call render_preview once, inspect the returned image, then describe it briefly.',
}

const orchestrator = new OpenMultiAgent({
  onProgress(event) {
    if (event.type === 'agent_complete') console.log('Agent completed.')
  },
})

const result = await orchestrator.runAgent(agent, 'Render the sample artifact and inspect its preview.')
console.log(result.output)
