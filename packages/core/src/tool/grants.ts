/**
 * Shared tool-grant resolution used by both the runner and orchestration
 * preflight checks. Keeping one resolver prevents governance classification
 * from drifting away from the tools the model can actually call.
 */

import type { ToolDefinition } from '../types.js'
import type { ToolRegistry } from './framework.js'

/** Predefined tool sets for common agent use cases. */
export const TOOL_PRESETS = {
  readonly: ['file_read', 'grep', 'glob'],
  readwrite: ['file_read', 'file_write', 'file_edit', 'grep', 'glob'],
  full: ['file_read', 'file_write', 'file_edit', 'grep', 'glob', 'bash'],
} as const satisfies Record<string, readonly string[]>

/** Framework-level disallowed tools for safety rails. */
export const AGENT_FRAMEWORK_DISALLOWED: readonly string[] = [
  // Empty for now, infrastructure for future built-in tools.
]

export interface ToolGrantOptions {
  readonly toolPreset?: keyof typeof TOOL_PRESETS
  readonly allowedTools?: readonly string[]
  readonly disallowedTools?: readonly string[]
}

export interface ResolveToolGrantOptions {
  /** Preserve the runner's existing contradictory-config warnings. */
  readonly warnOnConflict?: boolean
}

/** Resolve the exact registered tool definitions granted to one agent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveGrantedToolDefinitions(
  registry: ToolRegistry,
  options: ToolGrantOptions,
  resolveOptions: ResolveToolGrantOptions = {},
): ToolDefinition<any, any>[] {
  const warnOnConflict = resolveOptions.warnOnConflict ?? true
  if (warnOnConflict && options.toolPreset && options.allowedTools) {
    console.warn(
      'AgentRunner: both toolPreset and allowedTools are set. ' +
      'Final tool access will be the intersection of both.',
    )
  }

  if (warnOnConflict && options.allowedTools && options.disallowedTools) {
    const overlap = options.allowedTools.filter((tool) =>
      options.disallowedTools!.includes(tool))
    if (overlap.length > 0) {
      console.warn(
        `AgentRunner: tools [${overlap.map((name) => `"${name}"`).join(', ')}] appear in both allowedTools and disallowedTools. ` +
        'This is contradictory and may lead to unexpected behavior.',
      )
    }
  }

  const allTools = registry.list()
  const runtimeNames = new Set(registry.toRuntimeToolDefs().map((tool) => tool.name))
  const runtimeTools = allTools.filter((tool) => runtimeNames.has(tool.name))
  let filteredTools = allTools.filter((tool) => !runtimeNames.has(tool.name))

  const hasPositiveGrant =
    options.toolPreset !== undefined || options.allowedTools !== undefined
  if (!hasPositiveGrant) filteredTools = []

  if (options.toolPreset) {
    const presetTools = new Set(TOOL_PRESETS[options.toolPreset] as readonly string[])
    filteredTools = filteredTools.filter((tool) => presetTools.has(tool.name))
  }

  if (options.allowedTools) {
    filteredTools = filteredTools.filter((tool) => options.allowedTools!.includes(tool.name))
  }

  const denied = options.disallowedTools
    ? new Set(options.disallowedTools)
    : undefined
  if (denied) filteredTools = filteredTools.filter((tool) => !denied.has(tool.name))

  const frameworkDenied = new Set(AGENT_FRAMEWORK_DISALLOWED)
  filteredTools = filteredTools.filter((tool) => !frameworkDenied.has(tool.name))

  const finalRuntime = denied
    ? runtimeTools.filter((tool) => !denied.has(tool.name))
    : runtimeTools
  return [...filteredTools, ...finalRuntime]
}
