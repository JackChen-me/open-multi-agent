import { describe, it, expect } from 'vitest'
import OpenAI from 'openai'
import {
  isRetryableError,
  InvalidTaskRequirementsError,
  TokenBudgetExceededError,
  InvalidMessageError,
  LLMCallTimeoutError,
  UnsupportedToolCallError,
  UnsupportedToolResultContentError,
} from '../src/errors.js'
import { classifyRunFailure } from '../src/observability/status.js'

describe('isRetryableError', () => {
  it('treats terminal 4xx client errors as non-retryable', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableError({ status })).toBe(false)
    }
  })

  it('treats 408 / 409 / 429 as retryable', () => {
    for (const status of [408, 409, 429]) {
      expect(isRetryableError({ status })).toBe(true)
    }
  })

  it('treats 5xx server errors as retryable', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryableError({ status })).toBe(true)
    }
  })

  it('treats network / no-status errors as retryable', () => {
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true)
    expect(isRetryableError(new Error('socket hang up'))).toBe(true)
    expect(isRetryableError('some string')).toBe(true)
    expect(isRetryableError(undefined)).toBe(true)
  })

  it('reads status from `.statusCode` as well as `.status`', () => {
    expect(isRetryableError({ statusCode: 401 })).toBe(false)
    expect(isRetryableError({ statusCode: 503 })).toBe(true)
  })

  it('classifies budget, invalid-message, and task-requirement errors as terminal', () => {
    expect(isRetryableError(new TokenBudgetExceededError('a', 100, 50))).toBe(false)
    expect(isRetryableError(new InvalidMessageError('bad'))).toBe(false)
    expect(isRetryableError(new UnsupportedToolCallError('openai', 'custom'))).toBe(false)
    expect(isRetryableError(
      new UnsupportedToolResultContentError('openai', 'file-url'),
    )).toBe(false)
    expect(isRetryableError(new InvalidTaskRequirementsError([{
      code: 'NO_ELIGIBLE_AGENT',
      taskId: 'task-1',
      taskTitle: 'Restricted',
      reasons: ['worker excluded'],
    }]))).toBe(false)
  })

  it('classifies a per-call timeout as retryable', () => {
    expect(isRetryableError(new LLMCallTimeoutError(1000, 'agent'))).toBe(true)
  })

  it('classifies an AbortError as terminal', () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    expect(isRetryableError(err)).toBe(false)
  })

  it('classifies the OpenAI SDK APIUserAbortError as terminal', () => {
    const err = new OpenAI.APIUserAbortError()
    expect(isRetryableError(err)).toBe(false)
  })

  it('classifies the real OpenAI SDK abort as cancellation', () => {
    const err = new OpenAI.APIUserAbortError()
    expect(classifyRunFailure(err, { provider: 'openai' })).toMatchObject({
      status: { code: 'cancelled' },
      errorInfo: {
        kind: 'cancellation',
        retryable: false,
        provider: 'openai',
      },
    })
  })

  it('ignores a non-numeric status (defaults to retryable)', () => {
    expect(isRetryableError({ status: 'nope' })).toBe(true)
    expect(isRetryableError({ status: NaN })).toBe(true)
  })
})
