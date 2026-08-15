import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('maintainer-bot authority boundary', () => {
  it('contains no GitHub client, PR creation, commit, push, release, or publish implementation', async () => {
    const files = (await readdir(join(packageRoot, 'src'))).filter(file => file.endsWith('.ts'))
    const content = (await Promise.all(files.map(file => readFile(join(packageRoot, 'src', file), 'utf8')))).join('\n')
    expect(content).not.toMatch(/Octokit|api\.github\.com|gh\s+pr\s+create|git['"],\s*\[['"](?:commit|push)|npm['"],\s*\[['"]publish/)
    expect(content).not.toContain('ready_for_review')
  })

  it('never exposes raw bash to an OMA role', async () => {
    const orchestrator = await readFile(join(packageRoot, 'src/orchestrator.ts'), 'utf8')
    expect(orchestrator).toContain("'bash'")
    expect(orchestrator).toContain('disallowedTools: DISALLOWED_TOOLS')
    expect(orchestrator).not.toContain("toolPreset: 'full'")
    expect(orchestrator).not.toContain("toolPreset: 'readwrite'")
  })
})
