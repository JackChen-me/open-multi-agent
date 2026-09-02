/**
 * @fileoverview Framework-specific error classes.
 */

import type { ContentBlock, SemanticRoutingAssessment, TaskRequirementIssue } from './types.js'

/**
 * Raised before task execution when a task has no eligible agent or its
 * explicit assignee does not satisfy the task's hard requirements.
 */
export class InvalidTaskRequirementsError extends Error {
  readonly code = 'INVALID_TASK_REQUIREMENTS'

  constructor(readonly issues: readonly TaskRequirementIssue[]) {
    super(
      `Task requirements are unsatisfied: ${issues
        .map((issue) => `${issue.code} for "${issue.taskTitle}"`)
        .join(', ')}.`,
    )
    this.name = 'InvalidTaskRequirementsError'
  }
}

/**
 * Raised when an agent or orchestrator run exceeds its configured token budget.
 */
export class TokenBudgetExceededError extends Error {
  readonly code = 'TOKEN_BUDGET_EXCEEDED'

  constructor(
    readonly agent: string,
    readonly tokensUsed: number,
    readonly budget: number,
  ) {
    super(`Agent "${agent}" exceeded token budget: ${tokensUsed} tokens used (budget: ${budget})`)
    this.name = 'TokenBudgetExceededError'
  }
}

/**
 * Raised when an orchestrator run exceeds its configured estimated cost budget.
 */
export class CostBudgetExceededError extends Error {
  readonly code = 'COST_BUDGET_EXCEEDED'

  constructor(
    readonly agent: string,
    readonly costUsed: number,
    readonly budget: number,
  ) {
    super(`Agent "${agent}" exceeded cost budget: ${costUsed} estimated cost used (budget: ${budget})`)
    this.name = 'CostBudgetExceededError'
  }
}

/**
 * Raised when a single LLM call (one `adapter.chat()` request) exceeds the
 * per-call deadline configured via {@link AgentConfig.callTimeoutMs}.
 *
 * Distinct from a whole-run timeout ({@link AgentConfig.timeoutMs}) and from a
 * caller-supplied `abortSignal` cancellation: the runner only raises this when
 * its own per-call deadline fired and the caller's signal did not, so a stalled
 * provider is observable and tellable apart from a deliberate abort.
 */
export class LLMCallTimeoutError extends Error {
  readonly code = 'LLM_CALL_TIMEOUT'

  constructor(
    /** The per-call deadline, in milliseconds, that was exceeded. */
    readonly timeoutMs: number,
    /** Name of the agent whose call timed out, when known. */
    readonly agent?: string,
  ) {
    super(
      agent !== undefined
        ? `Agent "${agent}" LLM call exceeded per-call timeout of ${timeoutMs}ms`
        : `LLM call exceeded per-call timeout of ${timeoutMs}ms`,
    )
    this.name = 'LLMCallTimeoutError'
  }
}

/** Raised when routing infrastructure exceeds its configured deadline. */
export class RoutingTimeoutError extends Error {
  readonly code = 'ROUTING_TIMEOUT'

  constructor(
    readonly timeoutMs: number,
    readonly stage: 'router' | 'profiler',
  ) {
    super(`Execution routing ${stage} exceeded its timeout of ${timeoutMs}ms`)
    this.name = 'RoutingTimeoutError'
  }
}

/** Raised when the semantic profiler cannot produce a valid task profile. */
export class RoutingProfilerFailedError extends Error {
  readonly code = 'ROUTING_PROFILER_FAILED'

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = 'RoutingProfilerFailedError'
  }
}

/**
 * Raised before execution when inferred high-risk semantics need an explicit
 * governance topology rather than an automatic model-selected route.
 */
export class RoutingDeclarationRequiredError extends Error {
  readonly code = 'ROUTING_DECLARATION_REQUIRED'

  constructor(
    readonly reasons: readonly string[],
    readonly assessment?: SemanticRoutingAssessment,
  ) {
    super(
      'Hybrid execution routing requires an explicit governance declaration: '
      + reasons.join('; '),
    )
    this.name = 'RoutingDeclarationRequiredError'
  }
}

/**
 * Raised when structured input passed to a public Agent API or adapter violates
 * the {@link LLMMessage}[] contract (e.g. a `content` that isn't a
 * `ContentBlock[]`), cannot be copied safely, or crosses a text-only backend
 * boundary. Surfaced before provider-specific conversion or external execution.
 */
export class InvalidMessageError extends Error {
  readonly code = 'INVALID_MESSAGE'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidMessageError'
  }
}

/**
 * Raised when an agent cannot satisfy its configured structured-output schema
 * after the built-in corrective retry. Re-running the whole task with the same
 * prompt is not a transport recovery strategy, so this failure is terminal for
 * orchestrator-level retries.
 */
export class StructuredOutputValidationError extends Error {
  readonly code = 'STRUCTURED_OUTPUT_VALIDATION_FAILED'

  constructor(readonly cause?: unknown) {
    super(
      'Structured output validation failed after retry.',
      cause !== undefined ? { cause } : undefined,
    )
    this.name = 'StructuredOutputValidationError'
  }
}

/**
 * Raised when a provider returns a tool-call type that OMA cannot execute.
 *
 * OMA exposes JSON-schema function tools. Failing loudly keeps an upstream
 * custom-tool response from being mistaken for a successful empty turn.
 */
export class UnsupportedToolCallError extends Error {
  readonly code = 'UNSUPPORTED_TOOL_CALL'

  constructor(
    readonly provider: string,
    readonly toolType: string,
  ) {
    super(`${provider} returned unsupported tool-call type "${toolType}"`)
    this.name = 'UnsupportedToolCallError'
  }
}

export type EgressPolicyErrorReason =
  | 'invalid-policy'
  | 'denied'
  | 'unsupported'
  | 'unresolved-target'

/**
 * Raised before a framework-owned LLM transport opens a disallowed or
 * unenforceable network request.
 */
export class EgressPolicyError extends Error {
  readonly code: string

  constructor(
    readonly reason: EgressPolicyErrorReason,
    message: string,
    readonly provider?: string,
    readonly origin?: string,
  ) {
    super(message)
    this.name = 'EgressPolicyError'
    this.code = reason === 'invalid-policy'
      ? 'INVALID_EGRESS_POLICY'
      : reason === 'denied'
        ? 'EGRESS_POLICY_DENIED'
        : reason === 'unresolved-target'
          ? 'EGRESS_POLICY_TARGET_UNRESOLVED'
          : 'EGRESS_POLICY_UNSUPPORTED'
  }
}

/**
 * Raised before an SDK request when a built-in adapter cannot faithfully map a
 * model-visible tool-result part. This is terminal: retrying the same adapter
 * and content cannot add a missing wire-format capability.
 */
export class UnsupportedToolResultContentError extends Error {
  readonly code = 'UNSUPPORTED_TOOL_RESULT_CONTENT'

  constructor(
    readonly provider: string,
    readonly contentType: string,
    detail?: string,
  ) {
    super(
      `${provider} cannot represent tool-result content type "${contentType}"` +
        (detail ? `: ${detail}` : ''),
    )
    this.name = 'UnsupportedToolResultContentError'
  }
}

/**
 * Raised before an SDK request when a built-in adapter has no wire mapping for
 * a whole model-visible content block.
 *
 * Terminal for the same reason {@link UnsupportedToolResultContentError} is:
 * the block and the adapter are both fixed for the attempt, so a retry re-runs
 * the identical conversion and fails identically. A bare `Error` here would
 * instead fall through {@link isRetryableError}'s conservative default and
 * spend the whole backoff ladder — plus a checkpoint rewrite per attempt — on
 * a capability gap that cannot resolve itself.
 */
export class UnsupportedContentBlockError extends Error {
  readonly code = 'UNSUPPORTED_CONTENT_BLOCK'

  constructor(
    readonly provider: string,
    readonly blockType: ContentBlock['type'],
    detail?: string,
  ) {
    super(
      `${provider} cannot represent the "${blockType}" content block` +
        (detail ? `: ${detail}` : ''),
    )
    this.name = 'UnsupportedContentBlockError'
  }
}

/**
 * Raised before an adapter call when `enforceLineage` is on and a model-visible
 * block cannot name the journal event it came from.
 *
 * Failing here rather than at verification time turns "the model saw something
 * the journal cannot explain" into a run-time error at the exact request that
 * would have hidden it. Enforcement is off by default; see
 * `docs/run-journal.md` for which configurations currently satisfy it.
 */
export class JournalLineageError extends Error {
  readonly code = 'MISSING_CONTEXT_REPLACE'

  constructor(
    readonly messageIndex: number,
    readonly blockIndex: number,
    readonly blockType: ContentBlock['type'],
  ) {
    super(
      `Journal lineage is missing for the ${blockType} block at message ` +
        `${messageIndex}, block ${blockIndex}: it is model-visible but names no ` +
        'journal event that reproduces it.',
    )
    this.name = 'JournalLineageError'
  }
}

/**
 * Read an HTTP-style status code off an unknown error, if present. Provider
 * SDK errors (`Anthropic.APIError`, `OpenAI.APIError`) expose it as `.status`;
 * some libraries use `.statusCode`. Returns `undefined` for network/unknown
 * errors that carry no numeric status.
 */
function extractStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as { status?: unknown; statusCode?: unknown }
  const status = record.status ?? record.statusCode
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

/**
 * Detect caller-driven cancellation errors without importing a provider SDK.
 *
 * Standard aborts use `.name === 'AbortError'`. OpenAI SDK's
 * `APIUserAbortError` inherits the default `.name === 'Error'`, so its public
 * constructor name is the stable discriminator available at this boundary.
 */
export function isCancellationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError'
    || error.constructor.name === 'APIUserAbortError'
}

/**
 * Classify an error as retryable (transient — another attempt might succeed)
 * or terminal (a retry cannot help).
 *
 * Conservative by design: returns `true` (retryable) unless the error is
 * *provably* terminal, so turning retry on never silently stops retrying an
 * error class that was retried before — it only skips attempts that are
 * pointless. Terminal cases are exhausted-budget, malformed input, an aborted
 * call (including OpenAI SDK's `APIUserAbortError`), and 4xx client errors
 * other than 408/409/429. Everything else —
 * network blips (no status), request timeouts (408), conflicts (409), rate
 * limits (429), and all 5xx server errors — is retryable.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof InvalidTaskRequirementsError) return false
  if (error instanceof TokenBudgetExceededError) return false
  if (error instanceof CostBudgetExceededError) return false
  if (error instanceof InvalidMessageError) return false
  if (error instanceof StructuredOutputValidationError) return false
  if (error instanceof UnsupportedToolCallError) return false
  if (error instanceof EgressPolicyError) return false
  if (error instanceof UnsupportedToolResultContentError) return false
  if (error instanceof UnsupportedContentBlockError) return false
  // A lineage gap is a property of the conversation, not of the transport:
  // the same request would fail the same way on every attempt.
  if (error instanceof JournalLineageError) return false
  if (error instanceof LLMCallTimeoutError) return true
  if (error instanceof RoutingTimeoutError) return true
  if (error instanceof RoutingProfilerFailedError) return false
  if (error instanceof RoutingDeclarationRequiredError) return false
  if (isCancellationError(error)) return false
  const status = extractStatus(error)
  if (status === undefined) return true
  if (status === 408 || status === 409 || status === 429) return true
  if (status >= 400 && status < 500) return false
  return true
}
