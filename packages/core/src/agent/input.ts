/**
 * @fileoverview Normalisation and defensive copying for public Agent inputs.
 */

import { InvalidMessageError } from '../errors.js'
import { assertValidMessages } from '../llm/validate.js'
import type {
  AgentPromptInput,
  AgentRunInput,
  ContentBlock,
  ExternalAgentBackendConfig,
  LLMMessage,
} from '../types.js'

export interface PreparedAgentRunInput {
  readonly messages: LLMMessage[]
  readonly structured: boolean
}

function cloneMessages(messages: readonly LLMMessage[]): LLMMessage[] {
  try {
    return structuredClone(messages) as LLMMessage[]
  } catch {
    throw new InvalidMessageError(
      'messages must contain cloneable structured data (strings, arrays, and plain data objects)',
    )
  }
}

function assertStructuredInputSupported(
  structured: boolean,
  backend: ExternalAgentBackendConfig | undefined,
): void {
  if (!structured || backend === undefined) return
  throw new InvalidMessageError(
    `The ${backend.kind} external backend accepts string prompts only; ` +
      'structured messages or content blocks cannot be forwarded without loss.',
  )
}

/** Validate, copy, and normalise a one-shot public run input. */
export function prepareAgentRunInput(
  input: AgentRunInput,
  backend?: ExternalAgentBackendConfig,
): PreparedAgentRunInput {
  if (typeof input === 'string') {
    return {
      structured: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
    }
  }

  assertValidMessages(input)
  assertStructuredInputSupported(true, backend)
  return { structured: true, messages: cloneMessages(input) }
}

/** Validate, copy, and normalise one persistent prompt turn. */
export function prepareAgentPromptInput(
  input: AgentPromptInput,
  backend?: ExternalAgentBackendConfig,
): { readonly message: LLMMessage } {
  if (typeof input === 'string') {
    return {
      message: { role: 'user', content: [{ type: 'text', text: input }] },
    }
  }

  const messages: LLMMessage[] = [{
    role: 'user',
    content: input as unknown as ContentBlock[],
  }]
  assertValidMessages(messages)
  assertStructuredInputSupported(true, backend)
  return {
    message: cloneMessages(messages)[0]!,
  }
}

/** Copy a validated message list before exposing or retaining it. */
export function copyMessages(messages: readonly LLMMessage[]): LLMMessage[] {
  return cloneMessages(messages)
}
