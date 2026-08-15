/**
 * @fileoverview Agent construction and model-routing helpers.
 *
 * Builds a minimal {@link Agent} with its own registry/executor, applies the
 * orchestrator's default tool preset (default-deny grant), and resolves
 * per-phase model-routing overrides.
 */

import type {
  AgentConfig,
  ModelRouteConfig,
  ModelRoutingPolicy,
  OrchestratorConfig,
  Task,
} from '../types.js'
import { Agent } from '../agent/agent.js'
import { ToolRegistry } from '../tool/framework.js'
import { ToolExecutor } from '../tool/executor.js'
import { registerBuiltInTools } from '../tool/built-in/index.js'
import { resolveGrantedToolDefinitions } from '../tool/grants.js'
import { intersectEgressPolicies } from '../llm/egress.js'

export interface AgentDefaultsSource {
  readonly defaultModel?: OrchestratorConfig['defaultModel']
  readonly defaultProvider?: OrchestratorConfig['defaultProvider']
  readonly defaultBaseURL?: OrchestratorConfig['defaultBaseURL']
  readonly defaultApiKey?: OrchestratorConfig['defaultApiKey']
  readonly egressPolicy?: OrchestratorConfig['egressPolicy']
  readonly defaultCwd?: OrchestratorConfig['defaultCwd']
  readonly defaultShellExecutor?: OrchestratorConfig['defaultShellExecutor']
  readonly onToolCall?: OrchestratorConfig['onToolCall']
}

/** Apply the orchestrator-level defaults shared by ephemeral agent configs. */
export function applyAgentDefaults(config: AgentConfig, src: AgentDefaultsSource): AgentConfig {
  return {
    ...config,
    model: config.model ?? src.defaultModel,
    provider: config.provider ?? src.defaultProvider,
    baseURL: config.baseURL ?? src.defaultBaseURL,
    apiKey: config.apiKey ?? src.defaultApiKey,
    egressPolicy: intersectEgressPolicies(src.egressPolicy, config.egressPolicy),
    cwd: config.cwd === undefined ? src.defaultCwd : config.cwd,
    shellExecutor: config.shellExecutor ?? src.defaultShellExecutor,
    onToolCall: config.onToolCall ?? src.onToolCall,
  }
}

/**
 * Build a minimal {@link Agent} with its own fresh registry/executor.
 * Pool workers pass `includeDelegateTool` so `delegate_to_agent` is available during `runTeam` / `runTasks`.
 */
export function buildAgent(
  config: AgentConfig,
  toolRegistration?: { readonly includeDelegateTool?: boolean },
): Agent {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry, toolRegistration)
  if (config.customTools) {
    for (const tool of config.customTools) {
      registry.register(tool, { runtimeAdded: true })
    }
  }
  const executor = new ToolExecutor(registry, {
    ...(config.maxToolOutputChars !== undefined
      ? { maxToolOutputChars: config.maxToolOutputChars }
      : {}),
  })
  return new Agent(config, registry, executor)
}

/** Resolve the same final grants that {@link AgentRunner} will expose. */
export function resolveAgentToolDefinitions(
  config: AgentConfig,
  toolRegistration?: { readonly includeDelegateTool?: boolean },
) {
  if (config.backend !== undefined) return []
  const registry = new ToolRegistry()
  registerBuiltInTools(registry, toolRegistration)
  if (config.customTools) {
    for (const tool of config.customTools) {
      registry.register(tool, { runtimeAdded: true })
    }
  }
  return resolveGrantedToolDefinitions(registry, {
    toolPreset: config.toolPreset,
    allowedTools: config.tools,
    disallowedTools: config.disallowedTools,
  }, { warnOnConflict: false })
}

/**
 * Apply the orchestrator's {@link OrchestratorConfig.defaultToolPreset} as a
 * fallback grant for an agent that declares neither `tools` nor `toolPreset`.
 *
 * Built-in tools are opt-in (default-deny): an agent with no grant resolves to
 * zero built-in tools. This fills that gap when the orchestrator opts in to a
 * default. Per-agent grants always win — the default never widens an agent that
 * already declares `tools` or `toolPreset`.
 */
export function applyDefaultToolPreset(
  config: AgentConfig,
  defaultToolPreset: OrchestratorConfig['defaultToolPreset'],
): AgentConfig {
  if (
    defaultToolPreset === undefined
    || config.tools !== undefined
    || config.toolPreset !== undefined
  ) {
    return config
  }
  return { ...config, toolPreset: defaultToolPreset }
}

export interface ModelRoutingSelection {
  readonly phase: 'coordinator' | 'synthesis' | 'short-circuit' | 'worker' | 'delegated'
  readonly agent: string
  readonly task?: Task
  readonly leaf?: boolean
}

export function routeMatches(
  policy: ModelRoutingPolicy | undefined,
  selection: ModelRoutingSelection,
): ModelRouteConfig | undefined {
  if (!policy) return undefined
  const task = selection.task
  for (const rule of policy.rules) {
    const match = rule.match
    if (match.phase !== undefined && match.phase !== selection.phase) continue
    if (match.agent !== undefined && match.agent !== selection.agent) continue
    if (match.taskRole !== undefined && match.taskRole !== task?.role) continue
    if (match.taskPriority !== undefined && match.taskPriority !== task?.priority) continue
    if (match.leaf !== undefined && match.leaf !== selection.leaf) continue
    if (match.hasDependencies !== undefined && match.hasDependencies !== ((task?.dependsOn?.length ?? 0) > 0)) continue
    return rule.route
  }
  return undefined
}

export function withModelRoute(config: AgentConfig, route: ModelRouteConfig | undefined): AgentConfig {
  if (!route) return config
  return {
    ...config,
    model: route.model,
    provider: route.provider ?? config.provider,
    baseURL: route.baseURL ?? config.baseURL,
    apiKey: route.apiKey ?? config.apiKey,
    region: route.region ?? config.region,
  }
}

/** Return a route followed by its ordered fallback entries. */
export function routeChain(route: ModelRouteConfig | undefined): readonly ModelRouteConfig[] {
  return route ? [route, ...(route.fallback ?? [])] : []
}

export function isLeafTask(task: Task, tasks: readonly Task[]): boolean {
  for (const candidate of tasks) {
    if (candidate.dependsOn?.includes(task.id)) return false
  }
  return true
}
