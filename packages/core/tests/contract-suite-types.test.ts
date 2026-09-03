import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * The reusable store contract suites describe a public contract, and they do it
 * using the public barrels so they stay honest about what an outside
 * implementer can reach. Nothing else enforces that: `tests/` is excluded from
 * both `tsconfig.json` and `tsconfig.lint.json`, and Vitest strips types
 * without checking them, so a suite can drift to a non-exported type or an
 * unsound cast and still go green.
 *
 * This closes that gap with the same in-test tsc idiom
 * `observability-doc-examples.test.ts` uses for the excluded example projects.
 */
describe('store contract suites', () => {
  it('typecheck against the public barrels', () => {
    const configPath = fileURLToPath(new URL('./helpers/tsconfig.json', import.meta.url))
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile)
    expect(loaded.error).toBeUndefined()
    const parsed = ts.parseJsonConfigFileContent(
      loaded.config,
      ts.sys,
      fileURLToPath(new URL('./helpers', import.meta.url)),
      undefined,
      configPath,
    )
    expect(parsed.fileNames.length).toBeGreaterThan(0)
    const program = ts.createProgram(parsed.fileNames, parsed.options)
    const diagnostics = ts.getPreEmitDiagnostics(program)
    const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => ts.sys.newLine,
    })
    expect(formatted).toBe('')
  })
})
