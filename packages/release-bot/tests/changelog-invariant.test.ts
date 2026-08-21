import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractUnreleased } from '../src/evidence.js'

// The scheduled release bot resolves this header before it does any analysis,
// so a dropped `## Unreleased` surfaces as a failed Friday run instead of a
// failed pull request. RELEASING.md requires the section to stay at the top.
describe('repository changelog invariant', () => {
  it('keeps Unreleased as the first section the release bot anchors on', () => {
    const changelog = readFileSync(fileURLToPath(new URL('../../../CHANGELOG.md', import.meta.url)), 'utf8')

    expect(extractUnreleased(changelog)).toBeTypeOf('string')
    expect(/^## .*/m.exec(changelog)?.[0]).toBe('## Unreleased')
  })

  it('rejects a changelog whose Unreleased section was removed', () => {
    expect(() => extractUnreleased('# Changelog\n\n## 1.16.0 - 2026-08-16\n\n- Shipped.\n')).toThrow(
      /missing the "## Unreleased" section/,
    )
  })
})
