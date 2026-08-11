import { describe, expect, it } from 'vitest'
import { parseIssueMarkdown } from '../src/markdown.js'
import { ISSUE_BODY } from './helpers.js'

describe('strict Issue Markdown parser', () => {
  it('parses the #488-style single-file bug contract', () => {
    const parsed = parseIssueMarkdown(ISSUE_BODY)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected parsed issue')
    expect(parsed.value.targetPaths).toEqual(['packages/create-oma-app/tests/runtime.test.ts'])
    expect(parsed.value.acceptanceCriteria).toHaveLength(2)
    expect(parsed.value.reproductionSteps[0]).toContain('focused runtime test')
    expect(parsed.value.currentBehavior).toContain('ambient OMA_MODEL')
  })

  it('reports structured missing-field errors', () => {
    const parsed = parseIssueMarkdown('## Problem\n\nToo short.\n')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected parse failure')
    expect(parsed.errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'MISSING_EXPECTED_SECTION',
      'MISSING_ACCEPTANCE_SECTION',
      'MISSING_TARGETS_SECTION',
      'MISSING_OUTOFSCOPE_SECTION',
    ]))
  })

  it('rejects traversal, glob, duplicate, and conflicting semantic sections', () => {
    const unsafe = ISSUE_BODY
      .replace('- `packages/create-oma-app/tests/runtime.test.ts`', '- `../outside.ts`\n- `packages/**/other.ts`\n- `./packages/core/tests/example.test.ts`')
      .replace('## Expected behavior', '## Problem\n\nA second conflicting problem.\n\n## Expected behavior')
    const parsed = parseIssueMarkdown(unsafe)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected parse failure')
    expect(parsed.errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'CONFLICTING_PROBLEM_SECTIONS',
      'INVALID_TARGET_PATH',
    ]))
  })

  it('treats punctuated None values as empty optional decisions and blockers', () => {
    const parsed = parseIssueMarkdown(`${ISSUE_BODY}\n## Open decisions\n\nNone.\n\n## Blockers\n\nN/A.\n`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected parsed issue')
    expect(parsed.value.openDecisions).toEqual([])
    expect(parsed.value.blockers).toEqual([])
  })
})
