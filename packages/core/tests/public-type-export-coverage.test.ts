import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Root-barrel coverage guard.
 *
 * `AgentConfig.thinking` shipped typed as `ThinkingConfig` while that interface
 * was missing from `src/index.ts`, so a consumer could hold the value but never
 * name its type without importing an internal source path. Type-only re-exports
 * are erased at runtime, so a runtime import smoke test cannot catch this — the
 * check has to run through the compiler.
 *
 * The invariant: every symbol exported from `src/types.ts` that is named in the
 * declaration of a public config surface must also be re-exported from
 * `src/index.ts`. Reachability is walked over type reference syntax rather than
 * resolved types, because that is the question a consumer actually faces (can I
 * write this name?) and because resolving generics transitively does not
 * terminate on recursive types such as `ZodSchema`.
 */

/** Public entry types whose declarations define what a consumer has to be able to name. */
const ANCHORS = [
  'AgentConfig',
  'TeamConfig',
  'OrchestratorConfig',
  'CoordinatorConfig',
  'ToolDefinition',
  'ToolResult',
  'LLMChatOptions',
  'LLMStreamOptions',
  'CheckpointSnapshotV4',
  'AgentRunResult',
  'TeamRunResult',
]

type NamedTypeDeclaration =
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.EnumDeclaration
  | ts.ClassDeclaration

describe('public type export coverage', () => {
  it('re-exports every types.ts symbol reachable from a public config declaration', () => {
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
    const indexPath = `${srcDir}index.ts`
    const typesPath = `${srcDir}types.ts`

    const program = ts.createProgram([indexPath, typesPath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    })
    const checker = program.getTypeChecker()
    const indexFile = program.getSourceFile(indexPath)
    const typesFile = program.getSourceFile(typesPath)
    expect(indexFile).toBeDefined()
    expect(typesFile).toBeDefined()

    const indexModule = checker.getSymbolAtLocation(indexFile!)
    expect(indexModule).toBeDefined()
    const rootExports = new Set(checker.getExportsOfModule(indexModule!).map((s) => s.getName()))

    // Every named type declared in types.ts, exported or not. Non-exported
    // declarations still have to be traversed: `CheckpointSnapshotBase` is
    // internal but contributes `MessageBusSnapshot` to the public snapshots.
    const declarations = new Map<string, NamedTypeDeclaration>()
    const exportedFromTypes = new Set<string>()
    for (const statement of typesFile!.statements) {
      if (
        !ts.isInterfaceDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement) &&
        !ts.isEnumDeclaration(statement) &&
        !ts.isClassDeclaration(statement)
      ) continue
      const name = statement.name?.text
      if (!name) continue
      declarations.set(name, statement)
      if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        exportedFromTypes.add(name)
      }
    }

    for (const anchor of ANCHORS) {
      // Guard the guard: a renamed anchor must fail loudly, not silently pass.
      expect(declarations.has(anchor)).toBe(true)
    }

    const referencedNames = (node: ts.Node): string[] => {
      const names: string[] = []
      const walk = (child: ts.Node): void => {
        if (ts.isTypeReferenceNode(child) && ts.isIdentifier(child.typeName)) {
          names.push(child.typeName.text)
        } else if (ts.isExpressionWithTypeArguments(child) && ts.isIdentifier(child.expression)) {
          names.push(child.expression.text)
        }
        ts.forEachChild(child, walk)
      }
      ts.forEachChild(node, walk)
      return names
    }

    const visited = new Set<string>()
    const queue = [...ANCHORS]
    while (queue.length > 0) {
      const name = queue.shift()!
      if (visited.has(name)) continue
      visited.add(name)
      const declaration = declarations.get(name)
      if (!declaration) continue
      for (const referenced of referencedNames(declaration)) {
        if (declarations.has(referenced) && !visited.has(referenced)) queue.push(referenced)
      }
    }

    const missing = [...visited]
      .filter((name) => exportedFromTypes.has(name) && !rootExports.has(name))
      .sort()
    expect(missing).toEqual([])
  })
})
