import { describe, expect, it, vi } from 'vitest'
import { NodeCommandRunner } from '../src/command.js'

/** Records what the child wrote through, without swallowing the test reporter. */
function recordStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(
    ((chunk: unknown, ...rest: unknown[]) => {
      chunks.push(String(chunk))
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stdout.write,
  )
  return { chunks, restore: () => spy.mockRestore() }
}

describe('command output echo', () => {
  it('captures output and stays silent by default', async () => {
    const { chunks, restore } = recordStdout()
    try {
      const result = await new NodeCommandRunner().run(
        process.execPath,
        ['-e', 'console.log("release-bot-silent-sentinel")'],
      )
      expect(result.stdout.trim()).toBe('release-bot-silent-sentinel')
      expect(chunks.filter(chunk => chunk.includes('release-bot-silent-sentinel'))).toEqual([])
    } finally {
      restore()
    }
  })

  it('echoes to the parent stream while still capturing', async () => {
    const { chunks, restore } = recordStdout()
    try {
      const result = await new NodeCommandRunner().run(
        process.execPath,
        ['-e', 'console.log("release-bot-echo-sentinel")'],
        { echo: true },
      )
      expect(result.stdout.trim()).toBe('release-bot-echo-sentinel')
      expect(chunks.some(chunk => chunk.includes('release-bot-echo-sentinel'))).toBe(true)
    } finally {
      restore()
    }
  })
})
