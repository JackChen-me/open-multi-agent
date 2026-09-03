import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('release bot package boundary', () => {
  it('remains a private internal workspace with no publish configuration', async () => {
    const manifest = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    )) as {
      private?: boolean
      publishConfig?: unknown
      dependencies?: Record<string, string>
    }
    expect(manifest.private).toBe(true)
    expect(manifest.publishConfig).toBeUndefined()
    expect(manifest.dependencies).toEqual({
      '@open-multi-agent/core': '*',
      zod: '3.25.76',
    })
  })
})
