/**
 * Built-in tool collection.
 *
 * Re-exports every built-in tool and provides a convenience function to
 * register them all with a {@link ToolRegistry} in one call.
 */

import type { ToolDefinition } from '../../types.js'
import { ToolRegistry } from '../framework.js'
import { bashTool } from './bash.js'
import { delegateToAgentTool } from './delegate.js'
import { fileEditTool } from './file-edit.js'
import { fileReadTool } from './file-read.js'
import { fileWriteTool } from './file-write.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'

export { bashTool, delegateToAgentTool, fileEditTool, fileReadTool, fileWriteTool, globTool, grepTool }

/** Options for {@link registerBuiltInTools}. */
export interface RegisterBuiltInToolsOptions {
  /**
   * When true, registers `delegate_to_agent` (team orchestration handoff).
   * Default false so standalone agents and `runAgent` do not expose a tool that always errors.
   */
  readonly includeDelegateTool?: boolean
}

/**
 * The ordered list of all built-in tools.  Import this when you need to
 * iterate over them without calling `registerBuiltInTools`.
 *
 * The array is typed as `ToolDefinition<unknown>[]` so it can be passed to
 * APIs that accept any ToolDefinition without requiring a union type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const BUILT_IN_TOOLS: ToolDefinition<any, any>[] = [
  bashTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  grepTool,
  globTool,
]

/** All built-ins including `delegate_to_agent` (for team registry setup). */
export const ALL_BUILT_IN_TOOLS_WITH_DELEGATE: ToolDefinition<any, any>[] = [
  ...BUILT_IN_TOOLS,
  delegateToAgentTool,
]

/**
 * Register all built-in tools with the given registry.
 *
 * @example
 * ```ts
 * import { ToolRegistry } from '../framework.js'
 * import { registerBuiltInTools } from './built-in/index.js'
 *
 * const registry = new ToolRegistry()
 * registerBuiltInTools(registry)
 * ```
 */
export function registerBuiltInTools(
  registry: ToolRegistry,
  options?: RegisterBuiltInToolsOptions,
): void {
  for (const tool of BUILT_IN_TOOLS) {
    registry.register(tool)
  }
  if (options?.includeDelegateTool) {
    registry.register(delegateToAgentTool)
  }
}
