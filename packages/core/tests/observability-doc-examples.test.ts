import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

describe('public Observability v2 examples', () => {
  it('typechecks every snippet through public package and subpath imports', () => {
    const configPath = fileURLToPath(new URL(
      '../../../examples/integrations/observability-v2/tsconfig.json',
      import.meta.url,
    ))
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile)
    expect(loaded.error).toBeUndefined()
    const parsed = ts.parseJsonConfigFileContent(
      loaded.config,
      ts.sys,
      fileURLToPath(new URL('../../../examples/integrations/observability-v2', import.meta.url)),
      undefined,
      configPath,
    )
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
