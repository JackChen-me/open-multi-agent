import { describe, it, expect } from 'vitest'
import {
  TokenBudgetExceededError,
  InvalidMessageError,
  LLMCallTimeoutError,
  StructuredOutputValidationError,
  UnsupportedToolCallError,
  UnsupportedToolResultContentError,
  UnsupportedContentBlockError,
} from '../src/errors.js'

describe('TokenBudgetExceededError', () => {
  it('sets .name to TokenBudgetExceededError', () => {
    const err = new TokenBudgetExceededError('agent-1', 500, 400)
    expect(err.name).toBe('TokenBudgetExceededError')
  })

  it('sets .code to TOKEN_BUDGET_EXCEEDED', () => {
    const err = new TokenBudgetExceededError('agent-1', 500, 400)
    expect(err.code).toBe('TOKEN_BUDGET_EXCEEDED')
  })

  it('stores agent, tokensUsed, and budget as readonly properties', () => {
    const err = new TokenBudgetExceededError('worker-a', 1234, 1000)
    expect(err.agent).toBe('worker-a')
    expect(err.tokensUsed).toBe(1234)
    expect(err.budget).toBe(1000)
  })

  it('formats the message with agent name, tokens used, and budget', () => {
    const err = new TokenBudgetExceededError('analyst', 750, 500)
    expect(err.message).toBe('Agent "analyst" exceeded token budget: 750 tokens used (budget: 500)')
  })

  it('is an instance of TokenBudgetExceededError', () => {
    const err = new TokenBudgetExceededError('b', 1, 2)
    expect(err).toBeInstanceOf(TokenBudgetExceededError)
  })

  it('is an instance of Error (extends built-in Error)', () => {
    const err = new TokenBudgetExceededError('b', 1, 2)
    expect(err).toBeInstanceOf(Error)
  })
})

describe('InvalidMessageError', () => {
  it('sets .name to InvalidMessageError', () => {
    const err = new InvalidMessageError('bad content')
    expect(err.name).toBe('InvalidMessageError')
  })

  it('sets .code to INVALID_MESSAGE', () => {
    const err = new InvalidMessageError('some reason')
    expect(err.code).toBe('INVALID_MESSAGE')
  })

  it('uses the constructor argument as the message', () => {
    const err = new InvalidMessageError('content must be a ContentBlock[]')
    expect(err.message).toBe('content must be a ContentBlock[]')
  })

  it('is an instance of InvalidMessageError', () => {
    const err = new InvalidMessageError('test')
    expect(err).toBeInstanceOf(InvalidMessageError)
  })

  it('is an instance of Error (extends built-in Error)', () => {
    const err = new InvalidMessageError('test')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('StructuredOutputValidationError', () => {
  it('exposes a stable code, message, and validation cause', () => {
    const cause = new Error('schema mismatch')
    const err = new StructuredOutputValidationError(cause)
    expect(err.name).toBe('StructuredOutputValidationError')
    expect(err.code).toBe('STRUCTURED_OUTPUT_VALIDATION_FAILED')
    expect(err.message).toBe('Structured output validation failed after retry.')
    expect(err.cause).toBe(cause)
    expect(err).toBeInstanceOf(Error)
  })
})

describe('UnsupportedToolCallError', () => {
  it('identifies the provider and unsupported tool type', () => {
    const err = new UnsupportedToolCallError('openai', 'custom')
    expect(err.name).toBe('UnsupportedToolCallError')
    expect(err.code).toBe('UNSUPPORTED_TOOL_CALL')
    expect(err.provider).toBe('openai')
    expect(err.toolType).toBe('custom')
    expect(err.message).toBe('openai returned unsupported tool-call type "custom"')
  })
})

describe('UnsupportedToolResultContentError', () => {
  it('identifies the provider and unmappable content type', () => {
    const err = new UnsupportedToolResultContentError(
      'Anthropic Messages',
      'file:text/plain',
      'only PDF files are supported',
    )
    expect(err.name).toBe('UnsupportedToolResultContentError')
    expect(err.code).toBe('UNSUPPORTED_TOOL_RESULT_CONTENT')
    expect(err.provider).toBe('Anthropic Messages')
    expect(err.contentType).toBe('file:text/plain')
    expect(err.message).toContain('only PDF files are supported')
  })
})

describe('UnsupportedContentBlockError', () => {
  it('identifies the provider and the block it cannot map', () => {
    const err = new UnsupportedContentBlockError(
      'Anthropic Messages',
      'video',
      'OMA does not map video for this adapter yet',
    )
    expect(err.name).toBe('UnsupportedContentBlockError')
    expect(err.code).toBe('UNSUPPORTED_CONTENT_BLOCK')
    expect(err.provider).toBe('Anthropic Messages')
    expect(err.blockType).toBe('video')
    expect(err.message).toContain('Anthropic Messages')
    expect(err.message).toContain('video')
    expect(err.message).toContain('OMA does not map video for this adapter yet')
  })

  it('omits the detail clause when none is given', () => {
    const err = new UnsupportedContentBlockError('Google Gemini', 'video')
    expect(err.message).toBe('Google Gemini cannot represent the "video" content block')
  })
})

describe('LLMCallTimeoutError', () => {
  it('sets .name to LLMCallTimeoutError', () => {
    const err = new LLMCallTimeoutError(30_000, 'agent-1')
    expect(err.name).toBe('LLMCallTimeoutError')
  })

  it('sets .code to LLM_CALL_TIMEOUT', () => {
    const err = new LLMCallTimeoutError(30_000, 'agent-1')
    expect(err.code).toBe('LLM_CALL_TIMEOUT')
  })

  it('stores timeoutMs and agent as readonly properties', () => {
    const err = new LLMCallTimeoutError(15_000, 'worker-a')
    expect(err.timeoutMs).toBe(15_000)
    expect(err.agent).toBe('worker-a')
  })

  it('formats the message with agent name and timeout', () => {
    const err = new LLMCallTimeoutError(20_000, 'analyst')
    expect(err.message).toBe('Agent "analyst" LLM call exceeded per-call timeout of 20000ms')
  })

  it('omits the agent name from the message when unknown', () => {
    const err = new LLMCallTimeoutError(20_000)
    expect(err.agent).toBeUndefined()
    expect(err.message).toBe('LLM call exceeded per-call timeout of 20000ms')
  })

  it('is an instance of LLMCallTimeoutError and Error', () => {
    const err = new LLMCallTimeoutError(1000, 'b')
    expect(err).toBeInstanceOf(LLMCallTimeoutError)
    expect(err).toBeInstanceOf(Error)
  })
})
