import {
  CostBudgetExceededError,
  LLMCallTimeoutError,
  RoutingTimeoutError,
  TokenBudgetExceededError,
  isCancellationError,
  isRetryableError,
} from '../errors.js'
import type {
  RunStatus,
  StructuredTraceError,
  TraceErrorKind,
} from '../types.js'
import { redactSensitiveText } from '../utils/redaction.js'

const MAX_STATUS_MESSAGE = 256
const MAX_ERROR_MESSAGE = 1024

function safeMessage(value: unknown, limit: number): string | undefined {
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : undefined
  if (!raw) return undefined
  return redactSensitiveText(raw).slice(0, limit)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as { status?: unknown; statusCode?: unknown }
  const value = record.status ?? record.statusCode
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export interface FailureClassificationOptions {
  readonly kind?: TraceErrorKind
  readonly provider?: string
  readonly attempt?: number
  readonly statusCode?: RunStatus['code']
}

/** Convert a thrown/runtime failure into stable, JSON-safe outcome fields. */
export function classifyRunFailure(
  error: unknown,
  options: FailureClassificationOptions = {},
): { status: RunStatus; errorInfo: StructuredTraceError } {
  let statusCode: RunStatus['code'] = options.statusCode ?? 'error'
  let kind: TraceErrorKind = options.kind ?? 'unknown'

  if (error instanceof TokenBudgetExceededError || error instanceof CostBudgetExceededError) {
    statusCode = 'budget_exhausted'
    kind = 'budget'
  } else if (error instanceof LLMCallTimeoutError || error instanceof RoutingTimeoutError) {
    statusCode = 'timeout'
    kind = 'timeout'
  } else if (isCancellationError(error)) {
    statusCode = 'cancelled'
    kind = 'cancellation'
  } else if (
    options.kind === undefined
    && (httpStatus(error) !== undefined || options.provider !== undefined)
  ) {
    kind = 'provider'
  }

  const message = safeMessage(error, MAX_ERROR_MESSAGE)
  const statusMessage = safeMessage(error, MAX_STATUS_MESSAGE)
  const status: RunStatus = {
    code: statusCode,
    ...(statusMessage !== undefined ? { message: statusMessage } : {}),
  }
  const info: StructuredTraceError = {
    kind,
    ...(errorCode(error) !== undefined ? { code: errorCode(error) } : {}),
    ...(error instanceof Error ? { name: error.name } : {}),
    ...(message !== undefined ? { message } : {}),
    retryable: isRetryableError(error),
    ...(httpStatus(error) !== undefined ? { httpStatus: httpStatus(error) } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
  }
  return { status, errorInfo: info }
}

export function statusOnly(code: RunStatus['code'], message?: string): RunStatus {
  const safe = safeMessage(message, MAX_STATUS_MESSAGE)
  return { code, ...(safe !== undefined ? { message: safe } : {}) }
}
