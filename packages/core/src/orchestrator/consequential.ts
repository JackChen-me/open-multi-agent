import type {
  AgentConfig,
  RunFlag,
  RunOutcomeFields,
  ToolCallDecision,
} from '../types.js'
import { statusOnly } from '../observability/status.js'
import { resolveAgentToolDefinitions } from './agent-config.js'

export const CONSEQUENTIAL_NO_INDEPENDENCE_FLAG =
  'consequential-no-independence' as const satisfies RunFlag

const CONFIRMATION_REQUIRED_MESSAGE =
  'Consequential tool confirmation required before execution.'
const CONFIRMATION_REJECTED_MESSAGE =
  'Consequential tool confirmation rejected.'

/** Mutable state shared by every guarded agent participating in one run. */
export interface ConsequentialConfirmationState {
  planApproved: boolean
  confirmationRequired: boolean
  confirmationRejected: boolean
}

export function createConsequentialConfirmationState(): ConsequentialConfirmationState {
  return {
    planApproved: false,
    confirmationRequired: false,
    confirmationRejected: false,
  }
}

/** True only when the agent's final grant set contains marked tool metadata. */
export function hasGrantedConsequentialTool(
  config: AgentConfig,
  toolRegistration?: { readonly includeDelegateTool?: boolean },
): boolean {
  return resolveAgentToolDefinitions(config, toolRegistration)
    .some((tool) => tool.consequential === true)
}

/**
 * Compose the opt-in confirmation guard with the existing per-call gate.
 * Tool metadata is the only classification input; prompt and argument text are
 * deliberately unavailable to this decision.
 */
export function withConsequentialConfirmation(
  config: AgentConfig,
  state: ConsequentialConfirmationState,
): AgentConfig {
  const existingGate = config.onToolCall
  return {
    ...config,
    onToolCall: async (context): Promise<ToolCallDecision> => {
      if (context.consequential !== true) {
        return existingGate ? existingGate(context) : { action: 'allow' }
      }

      if (existingGate) {
        try {
          const decision = await existingGate(context)
          if (decision.action === 'deny') state.confirmationRejected = true
          return decision
        } catch (error) {
          state.confirmationRejected = true
          throw error
        }
      }

      if (state.planApproved) return { action: 'allow' }

      state.confirmationRequired = true
      return { action: 'deny', reason: CONFIRMATION_REQUIRED_MESSAGE }
    },
  }
}

type FlaggedRunResult = RunOutcomeFields & { readonly success: boolean }

/** Attach the fallback flag and normalise an unresolved/rejected confirmation. */
export function finalizeConsequentialRun<T extends FlaggedRunResult>(
  result: T,
  flagged: boolean,
  state: ConsequentialConfirmationState,
): T {
  if (!flagged) return result

  const flags = [...new Set([
    ...(result.flags ?? []),
    CONSEQUENTIAL_NO_INDEPENDENCE_FLAG,
  ])]
  const flaggedResult = { ...result, flags }

  if (state.confirmationRequired) {
    return {
      ...flaggedResult,
      success: false,
      confirmationRequired: true,
      status: statusOnly('rejected', CONFIRMATION_REQUIRED_MESSAGE),
    } as T
  }

  if (state.confirmationRejected) {
    return {
      ...flaggedResult,
      success: false,
      status: statusOnly('rejected', CONFIRMATION_REJECTED_MESSAGE),
    } as T
  }

  return flaggedResult as T
}
