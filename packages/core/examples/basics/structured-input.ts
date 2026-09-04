/**
 * Structured Multimodal Input
 *
 * Send an image and caller-owned message history through runAgent() without
 * bypassing OMA's hooks, tracing, budgets, progress, or evaluation path.
 *
 * Run:
 *   npx tsx packages/core/examples/basics/structured-input.ts ./photo.png
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set (default provider). To use any
 *   other built-in provider, set OMA_PROVIDER and OMA_MODEL plus that
 *   provider's key, for example:
 *     OMA_PROVIDER=deepseek OMA_MODEL=deepseek-chat DEEPSEEK_API_KEY=...
 *     OMA_PROVIDER=openai OMA_MODEL=gpt-5.4 OPENAI_API_KEY=...
 *   The model must accept image input. See docs/providers.md for the full
 *   provider and env var list.
 *   The image must be PNG, JPEG, GIF, or WebP.
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { OpenMultiAgent, type LLMMessage, type SupportedProvider } from '../../src/index.js'

// Defaults to Claude. Any built-in provider works: set OMA_PROVIDER and
// OMA_MODEL plus that provider's API key (see docs/providers.md).
const provider = (process.env.OMA_PROVIDER ?? 'anthropic') as SupportedProvider
const model = process.env.OMA_MODEL ?? 'claude-sonnet-4-6'

const imagePath = process.argv[2]
if (!imagePath) {
  throw new Error('Pass an image path: npx tsx packages/core/examples/basics/structured-input.ts ./photo.png')
}

const mediaTypes: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}
const mediaType = mediaTypes[extname(imagePath).toLowerCase()]
if (!mediaType) {
  throw new Error('Unsupported image extension. Use PNG, JPEG, GIF, or WebP.')
}

const imageData = (await readFile(imagePath)).toString('base64')
const messages: LLMMessage[] = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'When I share an image, describe only visible facts.' }],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Understood.' }],
  },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this image in three concise bullet points.' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: imageData,
        },
      },
    ],
  },
]

const oma = new OpenMultiAgent({
  defaultProvider: provider,
  defaultModel: model,
})
const result = await oma.runAgent({ name: 'vision-assistant' }, messages)

if (!result.success) throw new Error(result.output)
console.log(result.output)
