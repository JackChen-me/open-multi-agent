/**
 * @fileoverview Core conversation loop engine for open-multi-agent.
 *
 * {@link AgentRunner} is the heart of the framework. It handles:
 *  - Sending messages to the LLM adapter
 *  - Extracting tool-use blocks from the response
 *  - Executing tool calls in parallel via {@link ToolExecutor}
 *  - Appending tool results and looping back until `end_turn`
 *  - Accumulating token usage and timing data across all turns
 *
 * The loop follows a standard agentic conversation pattern:
 * one outer `while (true)` that breaks on `end_turn` or maxTurns exhaustion.
 */

import type {
  LLMMessage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolCallRecord,
  TokenUsage,
  StreamEvent,
  ToolResult,
  ToolUseContext,
  TeamInfo,
  LLMAdapter,
  LLMChatOptions,
  LLMResponse,
  TraceEvent,
  LoopDetectionConfig,
  LoopDetectionInfo,
  LLMToolDef,
  ContextStrategy,
  ThinkingConfig,
  RunIdentity,
  ToolCallGate,
  InFlightTaskCheckpoint,
  PendingToolCallCheckpoint,
  ToolCallCommitCheckpoint,
  ApprovalDecisionRecord,
  ApprovalRequest,
  ToolCallApprovalContent,
} from '../types.js'
import { JournalLineageError, LLMCallTimeoutError, TokenBudgetExceededError } from '../errors.js'
import type {
  ContextStrategyKind,
  RequestBlockDescriptor,
  TurnOutcome,
} from '../journal/events.js'
import { canonicalJsonHash } from '../journal/hash.js'
import type { JournalRecorder } from '../journal/journal.js'
import { LoopDetector } from './loop-detector.js'
import { emitTrace, generateSpanId } from '../utils/trace.js'
import { mergeAbortSignals } from '../utils/abort.js'
import { estimateTokens } from '../utils/tokens.js'
import { redactSensitiveObject, redactSensitiveText } from '../utils/redaction.js'
import type { TraceRuntime, TraceSpan } from '../observability/runtime.js'
import { classifyRunFailure } from '../observability/status.js'
import type { ToolRegistry } from '../tool/framework.js'
import type { ToolExecutor } from '../tool/executor.js'
import type { ShellExecutor } from '../tool/shell/types.js'
import { RunScopedShellExecutor } from '../tool/shell/lifecycle.js'
import { defaultWorkspaceDir } from '../tool/built-in/path-safety.js'
import {
  AGENT_FRAMEWORK_DISALLOWED,
  resolveGrantedToolDefinitions,
  TOOL_PRESETS,
} from '../tool/grants.js'
import { createApprovalRequest, DurableApprovalError } from '../approval/durable.js'
import {
  copyToolResultContent,
  modelOutputFromToolResult,
  stripToolResultMedia,
  summarizeToolResultContent,
  toolResultContentSize,
  toolResultHasMedia,
} from '../tool/result.js'

// ---------------------------------------------------------------------------
// Tool presets
// ---------------------------------------------------------------------------

export { AGENT_FRAMEWORK_DISALLOWED, TOOL_PRESETS }

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Static configuration for an {@link AgentRunner} instance.
 * These values are constant across every `run` / `stream` call.
 */
export interface RunnerOptions {
  /** LLM model identifier, e.g. `'claude-opus-4-6'`. */
  readonly model: string
  /** Optional system prompt prepended to every conversation. */
  readonly systemPrompt?: string
  /**
   * Maximum number of tool-call round-trips before the runner stops.
   * Prevents unbounded loops. Defaults to `10`.
   */
  readonly maxTurns?: number
  /** Maximum output tokens per LLM response. */
  readonly maxTokens?: number
  /** Sampling temperature passed to the adapter. */
  readonly temperature?: number
  /** Nucleus sampling top_p. Forwarded to all adapters. */
  readonly topP?: number
  /**
   * Top-k sampling. Forwarded to Anthropic and OpenAI-compatible local
   * servers. Cloud OpenAI rejects this parameter.
   */
  readonly topK?: number
  /**
   * Min-p sampling. Only supported by OpenAI-compatible local servers.
   * Cloud OpenAI rejects this parameter; the Anthropic adapter ignores it.
   */
  readonly minP?: number
  /**
   * Whether the model may emit multiple tool calls in a single assistant
   * turn. Forwarded to OpenAI cloud and OpenAI-compatible local servers as
   * `parallel_tool_calls`. The Anthropic adapter ignores this field.
   */
  readonly parallelToolCalls?: boolean
  /**
   * Frequency penalty. Forwarded to OpenAI cloud and OpenAI-compatible local
   * servers. The Anthropic adapter ignores this field.
   */
  readonly frequencyPenalty?: number
  /**
   * Presence penalty. Forwarded to OpenAI cloud and OpenAI-compatible local
   * servers. The Anthropic adapter ignores this field.
   */
  readonly presencePenalty?: number
  /**
   * Adapter-specific escape hatch merged into the outgoing request payload.
   * See {@link AgentConfig.extraBody} for the override precedence contract.
   */
  readonly extraBody?: Record<string, unknown>
  /** See {@link AgentConfig.thinking}. */
  readonly thinking?: ThinkingConfig
  /** AbortSignal that cancels any in-flight adapter call and stops the loop. */
  readonly abortSignal?: AbortSignal
  /** See {@link AgentConfig.callTimeoutMs}. Per single `adapter.chat()` call. */
  readonly callTimeoutMs?: number
  /**
   * Tool access control configuration.
   * - `toolPreset`: Predefined tool sets for common use cases
   * - `allowedTools`: Whitelist of tool names (allowlist)
   * - `disallowedTools`: Blacklist of tool names (denylist)
   * Tools are resolved in order: preset → allowlist → denylist
   */
  readonly toolPreset?: 'readonly' | 'readwrite' | 'full'
  readonly allowedTools?: readonly string[]
  readonly disallowedTools?: readonly string[]
  /** Optional per-call tool gate inherited from agent or orchestrator config. */
  readonly onToolCall?: ToolCallGate
  /** Effective execution target for the granted `bash` built-in. */
  readonly shellExecutor?: ShellExecutor
  /**
   * Root directory passed to built-in filesystem tools via `ToolUseContext.cwd`.
   * `null` disables the sandbox; `undefined` falls back to
   * `<process.cwd()>/.agent-workspace`.
   */
  readonly cwd?: string | null
  /** Display name of the agent driving this runner (used in tool context). */
  readonly agentName?: string
  /** Short role description of the agent (used in tool context). */
  readonly agentRole?: string
  /** Per-agent scoped secrets exposed to tools via {@link ToolUseContext.credentials}. */
  readonly credentials?: Readonly<Record<string, string>>
  /** Loop detection configuration. When set, detects stuck agent loops. */
  readonly loopDetection?: LoopDetectionConfig
  /** Maximum cumulative tokens (input + output) allowed for this run. */
  readonly maxTokenBudget?: number
  /** Optional context compression strategy for long multi-turn runs. */
  readonly contextStrategy?: ContextStrategy
  /**
   * Compress tool results that the agent has already processed.
   * See {@link AgentConfig.compressToolResults} for details.
   */
  readonly compressToolResults?: boolean | { readonly minChars?: number }
  /** See {@link AgentConfig.preserveReasoningAsText}. */
  readonly preserveReasoningAsText?: boolean
  /** See {@link AgentConfig.compressReasoningText}. */
  readonly compressReasoningText?: boolean | { readonly minChars?: number }
}

/**
 * Per-call callbacks for observing tool execution in real time.
 * All callbacks are optional; unused ones are simply skipped.
 */
export interface RunOptions {
  /** Top-level run identity. Optional for custom backend compatibility. */
  readonly identity?: RunIdentity
  /** Internal OBS-1B runtime; public sink configuration arrives in OBS-2. */
  readonly traceRuntime?: TraceRuntime
  /** Current v2 agent span used as parent for LLM/tool operations. */
  readonly traceSpan?: TraceSpan
  /** One-based task attempt number for v2 agent hierarchy. */
  readonly traceAgentAttempt?: number
  /** Non-parent relationships attached to the v2 agent span. */
  readonly traceLinks?: readonly import('../types.js').TraceLink[]
  /** Stable low-cardinality phase attribute for agent operations. */
  readonly tracePhase?: string
  /** True when the current Agent created and therefore closes traceRuntime.root. */
  readonly traceRuntimeOwner?: boolean
  /** Fired just before each tool is dispatched. */
  readonly onToolCall?: (name: string, input: Record<string, unknown>) => void
  /** Fired after each tool result is received. */
  readonly onToolResult?: (name: string, result: ToolResult<any>) => void
  /** Fired after each complete {@link LLMMessage} is appended. */
  readonly onMessage?: (message: LLMMessage) => void
  /**
   * Internal per-run journal emitter. Present only when the caller configured a
   * journal; every emission site guards on it, so an unjournaled run allocates
   * nothing and behaves exactly as before. Custom backends may ignore it.
   */
  readonly journal?: JournalRecorder
  /**
   * Internal checkpoint state supplied by the orchestrator when resuming an
   * interrupted task. Custom backends may ignore it.
   */
  readonly resumeState?: InFlightTaskCheckpoint
  /**
   * Internal durable-boundary callback. The runner awaits it before crossing a
   * recoverable message/tool boundary; failures must be isolated by the caller.
   */
  readonly onCheckpoint?: (state: InFlightTaskCheckpoint) => void | Promise<void>
  /** Internal primary-ledger write after the pending runner state is durable. */
  readonly onApprovalRequest?: (request: ApprovalRequest) => void | Promise<void>
  /** Internal fail-fast check run before a pending approval enters the checkpoint. */
  readonly onApprovalPrepare?: () => void | Promise<void>
  /** Internal notification used to remove a reviewed request after commit. */
  readonly onApprovalConsumed?: (requestId: string) => void | Promise<void>
  /**
   * Fired when the runner detects a potential configuration issue.
   * For example, when a model appears to ignore tool definitions.
   */
  readonly onWarning?: (message: string) => void
  /** Trace callback for observability spans. Async callbacks are safe. */
  readonly onTrace?: (event: TraceEvent) => void | Promise<void>
  /** Run ID for trace correlation. */
  readonly runId?: string
  /** Task ID for trace correlation. */
  readonly taskId?: string
  /** Agent name for trace correlation (overrides RunnerOptions.agentName). */
  readonly traceAgent?: string
  /** Span ID for the current agent run; child LLM/tool spans point at it. */
  readonly traceSpanId?: string
  /** Parent span ID for the current agent run. */
  readonly traceParentId?: string
  /**
   * Per-call abort signal. When set, takes precedence over the static
   * {@link RunnerOptions.abortSignal}. Useful for per-run timeouts.
   */
  readonly abortSignal?: AbortSignal
  /**
   * Team context for built-in tools such as `delegate_to_agent`.
   * Injected by the orchestrator during `runTeam` / `runTasks` pool runs.
   */
  readonly team?: TeamInfo
}

/** The aggregated result returned when a full run completes. */
export interface RunResult {
  /** Optional identity echoed by custom backends. Agent supplies it when absent. */
  readonly identity?: RunIdentity
  /** All messages accumulated during this run (assistant + tool results). */
  readonly messages: LLMMessage[]
  /** The final text output from the last assistant turn. */
  readonly output: string
  /** All tool calls made during this run, in execution order. */
  readonly toolCalls: ToolCallRecord[]
  /** Aggregated token counts across every LLM call in this run. */
  readonly tokenUsage: TokenUsage
  /** Total number of LLM turns (including tool-call follow-ups). */
  readonly turns: number
  /** True when the run was terminated or warned due to loop detection. */
  readonly loopDetected?: boolean
  /** True when the run was terminated due to token budget limits. */
  readonly budgetExceeded?: boolean
  /** True when the runner stopped before its next LLM call because the signal was aborted. */
  readonly aborted?: boolean
  /** True when one or more tool invocations await durable approval. */
  readonly suspended?: boolean
  /** Exact requests that stopped this runner before tool execution. */
  readonly pendingApprovals?: readonly ApprovalRequest[]
}

/**
 * The execution seam behind every {@link Agent}: given a conversation, produce a
 * {@link RunResult} (and a matching {@link StreamEvent} stream). {@link AgentRunner}
 * is the LLM implementation; alternative backends (e.g. an external coding agent
 * over ACP — see `@open-multi-agent/core/acp`) implement the same contract so an
 * `Agent` can drive either without the orchestrator, pool, or team knowing which.
 *
 * The contract mirrors {@link AgentRunner.run} / {@link AgentRunner.stream}:
 * `stream()` yields incremental events and MUST end with a single
 * `{ type: 'done', data: RunResult }` (or `{ type: 'error', data }` on failure);
 * `run()` returns that same aggregated {@link RunResult}.
 */
export interface AgentBackend {
  /** Run the conversation to completion and return the aggregated result. */
  run(messages: LLMMessage[], options?: RunOptions): Promise<RunResult>
  /** Run the conversation and yield {@link StreamEvent}s, ending with `done`. */
  stream(messages: LLMMessage[], options?: RunOptions): AsyncIterable<StreamEvent>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract every TextBlock from a content array and join them. */
function extractText(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
}

/** Extract every ToolUseBlock from a content array. */
function extractToolUseBlocks(content: readonly ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
}

/**
 * Boundaries (`startIndex` inclusive, `endIndex` exclusive) of a single
 * atomic conversation turn within a flat message array.
 */
interface Turn {
  startIndex: number
  endIndex: number
}

/**
 * Group a flat message array into atomic turns so context-management
 * strategies can split on safe boundaries.
 *
 * A turn is one of:
 *   - a single user / assistant text message, or
 *   - an assistant message containing one or more `tool_use` blocks plus the
 *     immediately following user message containing the matching `tool_result`
 *     blocks (kept together so neither half can be dropped on its own).
 *
 * Splitting on turn boundaries — instead of slicing by raw message count —
 * prevents orphaned `tool_use_id` references that the Anthropic and OpenAI
 * APIs reject. Modelled on `groupIntoTurns` from the context-chef library.
 */
function groupIntoTurns(messages: LLMMessage[]): Turn[] {
  const turns: Turn[] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]!
    const hasToolUse =
      msg.role === 'assistant' && msg.content.some(b => b.type === 'tool_use')
    if (hasToolUse) {
      const start = i
      i++
      // Absorb the matching tool_result user message, when present.
      if (
        i < messages.length
        && messages[i]!.role === 'user'
        && messages[i]!.content.some(b => b.type === 'tool_result')
      ) {
        i++
      }
      turns.push({ startIndex: start, endIndex: i })
    } else {
      turns.push({ startIndex: i, endIndex: i + 1 })
      i++
    }
  }
  return turns
}

/**
 * Replace `image` blocks with text placeholders so binary attachment data
 * never leaks into the summarisation prompt.
 *
 * `summarizeMessages` flattens old turns via `JSON.stringify(message)` and
 * inlines the result into a text user-message it ships to the summary model.
 * For an `ImageBlock`, that serialisation includes the full base64 payload —
 * a 1MB image would balloon the "compression" call by ~250k tokens, defeating
 * its purpose and risking context-limit rejection.
 *
 * The placeholder still tells the summariser that media was present at this
 * turn, so the produced summary can reference it. Modelled on chef Janitor's
 * `stripAttachmentsForCompression`.
 */
function stripImageBlocksForSummary(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((msg) => {
    if (!msg.content.some(b =>
      b.type === 'image' || (b.type === 'tool_result' && toolResultHasMedia(b.content)))) return msg
    const newContent: ContentBlock[] = msg.content.map((block) => {
      if (block.type === 'image') {
        return { type: 'text', text: `[image: ${block.source.media_type}]` } satisfies TextBlock
      }
      if (block.type === 'tool_result' && toolResultHasMedia(block.content)) {
        return { ...block, content: stripToolResultMedia(block.content) }
      }
      return block
    })
    return { role: msg.role, content: newContent }
  })
}

/** Add two {@link TokenUsage} values together, returning a new object. */
function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }

/** Default minimum content length before tool result compression kicks in. */
const DEFAULT_MIN_COMPRESS_CHARS = 500

/** Scoping fields stamped on every journal event a runner emits. */
interface JournalScope {
  readonly taskId?: string
  readonly agentName?: string
  readonly spanId?: string
}

/**
 * What one context-strategy application derived, collected only when a journal
 * is attached.
 *
 * Strategies record the block objects they built and the blocks those came
 * from; the call site translates both into journal sequences, so no strategy
 * needs to know a recorder exists.
 */
interface ContextRewriteDraft {
  /** Blocks the rewrite removed without putting anything in their place. */
  readonly droppedBlocks: ContentBlock[]
  readonly replacements: Array<{
    readonly block: ContentBlock
    readonly sources: readonly ContentBlock[]
  }>
  detail?: Record<string, unknown>
  /**
   * Set when a memoized strategy rebuilt blocks an earlier `context/replace`
   * already recorded: the fresh objects inherit that event's lineage and
   * nothing new is emitted.
   */
  reuseEventSeq?: number
}

/** The block {@link prependSyntheticPrefixToFirstUser} derived, when asked. */
interface SyntheticPrefixRecord {
  block?: ContentBlock
  /** The user message the prefix was merged into, absent in the preamble case. */
  mergedInto?: LLMMessage
}

function newContextRewriteDraft(): ContextRewriteDraft {
  return { droppedBlocks: [], replacements: [] }
}

/** True when a strategy actually rewrote something worth an event. */
function hasContextRewrite(rewrite: ContextRewriteDraft): boolean {
  return rewrite.replacements.length > 0 || rewrite.droppedBlocks.length > 0
}

/** Union of the journal events that produced `blocks`, ascending and unique. */
function lineageOf(
  recorder: JournalRecorder,
  blocks: readonly ContentBlock[],
): number[] {
  const seqs = new Set<number>()
  for (const block of blocks) {
    for (const seq of recorder.lineageFor(block) ?? []) seqs.add(seq)
  }
  return [...seqs].sort((a, b) => a - b)
}

/**
 * Prepends synthetic framing text to the first user message so we never emit
 * consecutive `user` turns (Bedrock) and summaries do not concatenate onto
 * the original user prompt (direct API). If there is no user message yet,
 * inserts a single assistant text preamble.
 *
 * `derived` collects the one block this creates, which the journal records as
 * the model-visible product of the rewrite that called in here.
 */
function prependSyntheticPrefixToFirstUser(
  messages: LLMMessage[],
  prefix: string,
  derived?: SyntheticPrefixRecord,
): LLMMessage[] {
  const userIdx = messages.findIndex(m => m.role === 'user')
  if (userIdx < 0) {
    const preamble: TextBlock = { type: 'text', text: prefix.trimEnd() }
    if (derived) derived.block = preamble
    return [{ role: 'assistant', content: [preamble] }, ...messages]
  }
  const target = messages[userIdx]!
  const prefixBlock: TextBlock = { type: 'text', text: prefix }
  if (derived) {
    derived.block = prefixBlock
    derived.mergedInto = target
  }
  const merged: LLMMessage = {
    role: 'user',
    content: [prefixBlock, ...target.content],
  }
  return [...messages.slice(0, userIdx), merged, ...messages.slice(userIdx + 1)]
}

function loopWarningText(kind: 'tool_repetition' | 'text_repetition'): string {
  return kind === 'text_repetition'
    ? 'WARNING: You appear to be generating the same response repeatedly. ' +
        'This suggests you are stuck in a loop. Please try a different approach ' +
        'or provide new information.'
    : 'WARNING: You appear to be repeating the same tool calls with identical arguments. ' +
        'This suggests you are stuck in a loop. Please try a different approach, use different ' +
        'parameters, or explain what you are trying to accomplish.'
}

interface ToolExecution {
  readonly commit: ToolCallCommitCheckpoint
  /** Original result for callbacks; absent when replaying a persisted commit. */
  readonly result?: ToolResult
  /** False only when cancellation interrupted the call before a durable result. */
  readonly shouldCommit: boolean
  /** Present only when the gate requested a durable suspension. */
  readonly suspension?: {
    readonly content: ToolCallApprovalContent
    readonly reason?: string
  }
  /** Filled after the pending runner state and primary record are durable. */
  readonly approvalRequest?: ApprovalRequest
}

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

/**
 * Drives a full agentic conversation: LLM calls, tool execution, and looping.
 *
 * @example
 * ```ts
 * const runner = new AgentRunner(adapter, registry, executor, {
 *   model: 'claude-opus-4-6',
 *   maxTurns: 10,
 * })
 * const result = await runner.run(messages)
 * console.log(result.output)
 * ```
 */
export class AgentRunner implements AgentBackend {
  private readonly maxTurns: number
  private summarizeCache: {
    oldSignature: string
    summaryPrefix: string
    /**
     * The `context/replace` that first recorded this summary, kept with the
     * recorder that emitted it so a later run never inherits a foreign seq.
     */
    journalReplace?: { recorder: JournalRecorder; seq: number }
  } | null = null

  constructor(
    private readonly adapter: LLMAdapter,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutor: ToolExecutor,
    private readonly options: RunnerOptions,
  ) {
    this.maxTurns = options.maxTurns ?? 10
  }

  private serializeMessage(message: LLMMessage): string {
    return JSON.stringify(message)
  }

  private truncateToSlidingWindow(
    messages: LLMMessage[],
    maxTurns: number,
    rewrite?: ContextRewriteDraft,
  ): LLMMessage[] {
    if (maxTurns <= 0) {
      return messages
    }

    const firstUserIndex = messages.findIndex(m => m.role === 'user')
    const firstUser = firstUserIndex >= 0 ? messages[firstUserIndex]! : null
    const afterFirst = firstUserIndex >= 0
      ? messages.slice(firstUserIndex + 1)
      : messages.slice()

    // Walk turns from the tail, accumulating message count until we have at
    // least `maxTurns * 2` messages — preserving the historical "message-pair
    // count" semantics of `maxTurns` for plain conversations while never
    // splitting a tool_use/tool_result pair (see `groupIntoTurns`). The kept
    // slice may exceed the target by one message when the boundary lands
    // inside an atomic tool turn — that's the smallest safe slice.
    const target = maxTurns * 2
    if (afterFirst.length <= target) {
      return messages
    }

    const turns = groupIntoTurns(afterFirst)
    let cumulative = 0
    let cutoffTurnIdx = turns.length
    for (let i = turns.length - 1; i >= 0; i--) {
      cumulative += turns[i]!.endIndex - turns[i]!.startIndex
      cutoffTurnIdx = i
      if (cumulative >= target) break
    }

    const keptTurns = turns.slice(cutoffTurnIdx)
    const keepStartIdx = keptTurns[0]!.startIndex
    const kept = afterFirst.slice(keepStartIdx)
    const droppedTurns = turns.length - keptTurns.length

    const result: LLMMessage[] = []
    if (firstUser !== null) {
      result.push(firstUser)
    }

    if (droppedTurns > 0) {
      const notice =
        `[Earlier conversation history truncated — ${droppedTurns} turn(s) removed]\n\n`
      const derived: SyntheticPrefixRecord | undefined = rewrite ? {} : undefined
      result.push(...prependSyntheticPrefixToFirstUser(kept, notice, derived))
      if (rewrite && derived?.block !== undefined) {
        for (const message of afterFirst.slice(0, keepStartIdx)) {
          rewrite.droppedBlocks.push(...message.content)
        }
        rewrite.replacements.push({
          block: derived.block,
          sources: [
            ...(derived.mergedInto?.content ?? []),
            ...rewrite.droppedBlocks,
          ],
        })
        rewrite.detail = { droppedTurns }
      }
      return result
    }

    result.push(...kept)
    return result
  }

  /**
   * Send one `adapter.chat()` request bounded by an OMA-owned per-call timeout.
   *
   * When {@link RunnerOptions.callTimeoutMs} is set, a fresh
   * `AbortSignal.timeout()` is minted for THIS call and merged with any signal
   * already on `options`, so the per-call bound and the whole-run bound
   * ({@link RunnerOptions.abortSignal}) compose — whichever fires first wins.
   * A fresh signal per call is essential: baking one `AbortSignal.timeout()`
   * into the shared chat options would degrade it into a whole-run deadline.
   *
   * If our per-call deadline fires (and the caller's own signal did not), the
   * provider's abort rejection is translated into an {@link LLMCallTimeoutError}
   * so a stalled provider is observable and distinguishable from a deliberate
   * cancellation. Applied uniformly to every model call the runner owns (the
   * main agentic loop and summarize-based context compaction), so behavior no
   * longer depends on each vendor SDK's default request timeout.
   */
  private async chatWithCallTimeout(
    messages: LLMMessage[],
    options: LLMChatOptions,
  ): Promise<LLMResponse> {
    const timeoutMs = this.options.callTimeoutMs
    if (timeoutMs === undefined || timeoutMs <= 0) {
      return this.adapter.chat(messages, options)
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const base = options.abortSignal
    const abortSignal = base ? mergeAbortSignals(base, timeoutSignal) : timeoutSignal
    try {
      return await this.adapter.chat(messages, { ...options, abortSignal })
    } catch (err) {
      // Only claim a per-call timeout when our deadline fired and the caller's
      // own signal did not — otherwise surface the original abort/error as-is.
      if (timeoutSignal.aborted && base?.aborted !== true) {
        throw new LLMCallTimeoutError(timeoutMs, this.options.agentName)
      }
      throw err
    }
  }

  /** Execute one model call with OBS-1B closure and legacy completion mapping. */
  private async tracedChat(
    messages: LLMMessage[],
    chatOptions: LLMChatOptions,
    options: RunOptions,
    phase: 'turn' | 'summary',
    turn: number,
  ): Promise<LLMResponse> {
    if (!options.traceRuntime || !options.traceSpan) {
      const startMs = options.onTrace ? Date.now() : 0
      const response = await this.chatWithCallTimeout(messages, chatOptions)
      if (options.onTrace) {
        const endMs = Date.now()
        emitTrace(options.onTrace, {
          type: 'llm_call',
          runId: options.runId ?? '',
          spanId: generateSpanId(),
          ...(options.traceSpanId ? { parentId: options.traceSpanId } : {}),
          taskId: options.taskId,
          agent: options.traceAgent ?? this.options.agentName ?? 'unknown',
          model: chatOptions.model,
          phase,
          turn,
          tokens: response.usage,
          startMs,
          endMs,
          durationMs: endMs - startMs,
        })
      }
      return response
    }

    const span = options.traceRuntime.startSpan({
      kind: 'llm',
      name: 'chat',
      parent: options.traceSpan,
      attributes: {
        'oma.agent.name': options.traceAgent ?? this.options.agentName ?? 'unknown',
        'oma.llm.model': chatOptions.model,
        'oma.llm.provider': this.adapter.name,
        'oma.phase': phase,
        'oma.llm.turn': turn,
        ...(options.taskId ? { 'oma.task.id': options.taskId } : {}),
      },
    })
    const classifyCallFailure = (error: unknown) => {
      const reason = chatOptions.abortSignal?.reason
      const timedOut = chatOptions.abortSignal?.aborted
        && reason instanceof Error
        && reason.name === 'TimeoutError'
      const cancelled = chatOptions.abortSignal?.aborted && !timedOut
      return classifyRunFailure(error, {
        provider: this.adapter.name,
        ...(timedOut ? { kind: 'timeout' as const, statusCode: 'timeout' as const } : {}),
        ...(cancelled ? { kind: 'cancellation' as const, statusCode: 'cancelled' as const } : {}),
      })
    }
    try {
      const response = await this.chatWithCallTimeout(messages, chatOptions)
      if (chatOptions.abortSignal?.aborted) {
        const reason = chatOptions.abortSignal.reason ?? new Error('Model call aborted.')
        const classified = classifyCallFailure(reason)
        span.end({ status: classified.status, error: classified.errorInfo })
        return response
      }
      const endMs = Date.now()
      const legacyEvent: TraceEvent | undefined = options.onTrace ? {
        type: 'llm_call',
        runId: options.runId ?? '',
        spanId: generateSpanId(),
        ...(options.traceSpanId ? { parentId: options.traceSpanId } : {}),
        taskId: options.taskId,
        agent: options.traceAgent ?? this.options.agentName ?? 'unknown',
        model: chatOptions.model,
        phase,
        turn,
        tokens: response.usage,
        startMs: span.startUnixMs,
        endMs,
        durationMs: Math.max(0, endMs - span.startUnixMs),
      } : undefined
      span.end({
        status: { code: 'ok' },
        attributes: {
          'oma.usage.input_tokens': response.usage.input_tokens,
          'oma.usage.output_tokens': response.usage.output_tokens,
        },
        ...(legacyEvent ? { legacyEvent } : {}),
      })
      return response
    } catch (error) {
      const classified = classifyCallFailure(error)
      span.end({ status: classified.status, error: classified.errorInfo })
      throw error
    } finally {
      span.ensureEnded()
    }
  }

  private async summarizeMessages(
    messages: LLMMessage[],
    maxTokens: number,
    summaryModel: string | undefined,
    baseChatOptions: LLMChatOptions,
    turns: number,
    options: RunOptions,
    rewrite?: ContextRewriteDraft,
  ): Promise<{ messages: LLMMessage[]; usage: TokenUsage }> {
    const estimated = estimateTokens(messages)
    if (estimated <= maxTokens || messages.length < 4) {
      return { messages, usage: ZERO_USAGE }
    }

    const firstUserIndex = messages.findIndex(m => m.role === 'user')
    if (firstUserIndex < 0 || firstUserIndex === messages.length - 1) {
      return { messages, usage: ZERO_USAGE }
    }

    const firstUser = messages[firstUserIndex]!
    const rest = messages.slice(firstUserIndex + 1)
    if (rest.length < 2) {
      return { messages, usage: ZERO_USAGE }
    }

    // Split on an even boundary so we never separate a tool_use assistant turn
    // from its tool_result user message (rest is user/assistant pairs).
    const splitAt = Math.max(2, Math.floor(rest.length / 4) * 2)
    const oldPortion = rest.slice(0, splitAt)
    const recentPortion = rest.slice(splitAt)

    // Strip image attachments before serialising — JSON.stringify on an
    // ImageBlock would inline the entire base64 payload into the summary
    // prompt, so a 1MB image would defeat the very purpose of compression.
    // The placeholder still flags that media existed at this turn so the
    // summariser can mention it. recentPortion is untouched (returned to
    // the caller verbatim, never serialised here).
    const oldPortionForSummary = stripImageBlocksForSummary(oldPortion)
    const oldSignature = oldPortionForSummary.map(m => this.serializeMessage(m)).join('\n')
    if (this.summarizeCache !== null && this.summarizeCache.oldSignature === oldSignature) {
      const derived: SyntheticPrefixRecord | undefined = rewrite ? {} : undefined
      const mergedRecent = prependSyntheticPrefixToFirstUser(
        recentPortion,
        `${this.summarizeCache.summaryPrefix}\n\n`,
        derived,
      )
      if (rewrite && derived?.block !== undefined) {
        const recorded = this.summarizeCache.journalReplace
        if (recorded !== undefined && recorded.recorder === options.journal) {
          // Same summary, rebuilt as a fresh object: point it at the event that
          // already carries those bytes instead of recording them twice.
          rewrite.reuseEventSeq = recorded.seq
          rewrite.replacements.push({ block: derived.block, sources: [] })
        } else {
          rewrite.replacements.push({
            block: derived.block,
            sources: oldPortion.flatMap((message) => message.content),
          })
          rewrite.detail = {
            summaryModel: summaryModel ?? this.options.model,
            cached: true,
          }
        }
      }
      return { messages: [firstUser, ...mergedRecent], usage: ZERO_USAGE }
    }

    const summaryPrompt = [
      'Summarize the following conversation history for an LLM.',
      '- Preserve user goals, constraints, and decisions.',
      '- Keep key tool outputs and unresolved questions.',
      '- Use concise bullets.',
      '- Do not fabricate details.',
    ].join('\n')

    const summaryInput: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: summaryPrompt },
          { type: 'text', text: `\n\nConversation:\n${oldSignature}` },
        ],
      },
    ]

    const summaryOptions: LLMChatOptions = {
      ...baseChatOptions,
      model: summaryModel ?? this.options.model,
      tools: undefined,
    }

    const summaryResponse = await this.tracedChat(
      summaryInput, summaryOptions, options, 'summary', turns,
    )

    const summaryText = extractText(summaryResponse.content).trim()
    const summaryPrefix = summaryText.length > 0
      ? `[Conversation summary]\n${summaryText}`
      : '[Conversation summary unavailable]'

    this.summarizeCache = { oldSignature, summaryPrefix }
    const derived: SyntheticPrefixRecord | undefined = rewrite ? {} : undefined
    const mergedRecent = prependSyntheticPrefixToFirstUser(
      recentPortion,
      `${summaryPrefix}\n\n`,
      derived,
    )
    if (rewrite && derived?.block !== undefined) {
      rewrite.replacements.push({
        block: derived.block,
        sources: oldPortion.flatMap((message) => message.content),
      })
      rewrite.detail = {
        summaryModel: summaryOptions.model,
        usage: { ...summaryResponse.usage },
      }
    }
    return {
      messages: [firstUser, ...mergedRecent],
      usage: summaryResponse.usage,
    }
  }

  private async applyContextStrategy(
    messages: LLMMessage[],
    strategy: ContextStrategy,
    baseChatOptions: LLMChatOptions,
    turns: number,
    options: RunOptions,
    rewrite?: ContextRewriteDraft,
  ): Promise<{ messages: LLMMessage[]; usage: TokenUsage }> {
    if (strategy.type === 'sliding-window') {
      return {
        messages: this.truncateToSlidingWindow(messages, strategy.maxTurns, rewrite),
        usage: ZERO_USAGE,
      }
    }

    if (strategy.type === 'summarize') {
      return this.summarizeMessages(
        messages,
        strategy.maxTokens,
        strategy.summaryModel,
        baseChatOptions,
        turns,
        options,
        rewrite,
      )
    }

    if (strategy.type === 'compact') {
      return { messages: this.compactMessages(messages, strategy, rewrite), usage: ZERO_USAGE }
    }

    const estimated = estimateTokens(messages)
    const compressed = await strategy.compress(messages, estimated)
    if (!Array.isArray(compressed) || compressed.length === 0) {
      throw new Error('contextStrategy.custom.compress must return a non-empty LLMMessage[]')
    }
    if (rewrite) {
      // A custom function is opaque, so a block it invented is recorded
      // verbatim with the whole input as its lineage: storing the bytes is what
      // makes it reproducible. Blocks it passed through keep their own lineage.
      const inputBlocks = new Set<ContentBlock>()
      for (const message of messages) {
        for (const block of message.content) inputBlocks.add(block)
      }
      const sources = [...inputBlocks]
      for (const message of compressed) {
        for (const block of message.content) {
          if (!inputBlocks.has(block)) rewrite.replacements.push({ block, sources })
        }
      }
    }
    return { messages: compressed, usage: ZERO_USAGE }
  }

  // -------------------------------------------------------------------------
  // Tool resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve the final set of tools available to this agent based on the
   * three-layer configuration: preset → allowlist → denylist → framework safety.
   *
   * Returns LLMToolDef[] for direct use with LLM adapters.
   */
  private resolveTools(): LLMToolDef[] {
    const grantedTools = resolveGrantedToolDefinitions(this.toolRegistry, {
      toolPreset: this.options.toolPreset,
      allowedTools: this.options.allowedTools,
      disallowedTools: this.options.disallowedTools,
    })
    const definitionsByName = new Map(
      this.toolRegistry.toToolDefs().map((tool) => [tool.name, tool]),
    )
    return grantedTools.map((tool) => definitionsByName.get(tool.name)!)
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run a complete conversation starting from `messages`.
   *
   * The call may internally make multiple LLM requests (one per tool-call
   * round-trip). It returns only when:
   *  - The LLM emits `end_turn` with no tool-use blocks, or
   *  - `maxTurns` is exceeded, or
   *  - The abort signal is triggered.
   */
  async run(
    messages: LLMMessage[],
    options: RunOptions = {},
  ): Promise<RunResult> {
    // Collect everything yielded by the internal streaming loop.
    const accumulated: RunResult = {
      messages: [],
      output: '',
      toolCalls: [],
      tokenUsage: ZERO_USAGE,
      turns: 0,
    }

    for await (const event of this.stream(messages, options)) {
      if (event.type === 'done') {
        Object.assign(accumulated, event.data)
      } else if (event.type === 'error') {
        throw event.data
      }
    }

    return accumulated
  }

  /**
   * Run the conversation and yield {@link StreamEvent}s incrementally.
   *
   * Callers receive:
   *  - `{ type: 'text', data: string }` for each text delta
   *  - `{ type: 'tool_use', data: ToolUseBlock }` when the model requests a tool
   *  - `{ type: 'tool_result', data: ToolResultBlock }` after each execution
 *  - `{ type: 'budget_exceeded', data: TokenBudgetExceededError }` on budget trip
   *  - `{ type: 'done', data: RunResult }` at the very end
   *  - `{ type: 'error', data: Error }` on unrecoverable failure
   */
  async *stream(
    initialMessages: LLMMessage[],
    options: RunOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const restored = options.resumeState
    // Working copy of the conversation — mutated as turns progress.
    let conversationMessages: LLMMessage[] = restored
      ? [...restored.conversationMessages]
      : [...initialMessages]
    const newMessages: LLMMessage[] = restored ? [...restored.messages] : []

    // Accumulated state across all turns.
    let totalUsage: TokenUsage = restored?.tokenUsage ?? ZERO_USAGE
    const allToolCalls: ToolCallRecord[] = restored ? [...restored.toolCalls] : []
    let finalOutput = restored?.finalOutput ?? ''
    let turns = restored?.turns ?? 0
    let budgetExceeded = restored?.budgetExceeded ?? false
    let aborted = false
    let suspended = false
    let loopDetected = restored?.loopDetected ?? false
    let phase: InFlightTaskCheckpoint['phase'] = restored?.phase ?? 'awaiting_model'
    let pendingToolCalls: PendingToolCallCheckpoint[] = restored?.pendingToolCalls
      ? [...restored.pendingToolCalls]
      : []
    let pendingToolResultText = restored?.pendingToolResultText
    let loopWarned = restored?.loopWarned ?? false

    // --- Run journal (absent unless the caller configured one) -------------
    const journal = options.journal
    const journalScope = journal ? this.journalScope(options) : undefined
    /** Turn awaiting a `turn/end`, so every exit path closes exactly one. */
    let journalOpenTurn: number | undefined
    let journalAssistantSeq: number | undefined
    const journalToolResultSeqs = new Map<string, number>()
    const emitTurnEnd = (outcome: TurnOutcome): void => {
      if (!journal || journalOpenTurn === undefined) return
      journal.emit({ type: 'turn/end', ...journalScope, turn: journalOpenTurn, outcome })
      journalOpenTurn = undefined
    }
    if (journal && restored === undefined) {
      // A restored run's conversation was already journaled by the attempt that
      // built it; re-emitting it here would duplicate the events its seqs point
      // at. Its blocks therefore carry no lineage until checkpoint-restored
      // lineage lands.
      for (const message of conversationMessages) {
        const seq = message.role === 'user'
          ? journal.emit({
              type: 'user/message', ...journalScope, message, origin: 'input',
            })
          : journal.emit({
              type: 'assistant/message', ...journalScope, message, origin: 'seed',
            })
        journal.registerMessage(message, [seq])
      }
    }

    // Build the stable LLM options once; model / tokens / temp don't change.
    // resolveTools() returns LLMToolDef[] with default-deny + filtering applied.
    const toolDefs = this.resolveTools()
    // The single source of truth for what this agent may execute. The model is
    // only offered `toolDefs`, but a confused model (or prompt injection) can
    // still emit a tool_use for an ungranted name; gate execution on this set
    // so a registered-but-ungranted tool can never run silently.
    const grantedToolNames = new Set(toolDefs.map((t) => t.name))

    // Per-call abortSignal takes precedence over the static one.
    const effectiveAbortSignal = options.abortSignal ?? this.options.abortSignal

    const persistCheckpoint = async (strict = false): Promise<void> => {
      if (!options.onCheckpoint || !options.taskId) return
      const assignee = options.traceAgent ?? this.options.agentName
      if (!assignee) return
      const state: InFlightTaskCheckpoint = {
        taskId: options.taskId,
        assignee,
        phase,
        conversationMessages: [...conversationMessages],
        // Block identity does not survive serialization, so the lineage the
        // tracker holds is flattened positionally for a later restore.
        //
        // `journalSeq` is this task's own high-water mark, read here rather
        // than after the save: every event this runner emits precedes the state
        // mutation it describes, so the value at build time is exactly the
        // boundary between the task's events this entry already reflects and
        // the ones a tail replay still has to fold.
        ...(journal
          ? {
              conversationLineage: conversationMessages.map((message) =>
                message.content.map((block) => journal.lineageFor(block))),
              journalSeq: journal.lastSeq,
            }
          : {}),
        messages: [...newMessages],
        tokenUsage: totalUsage,
        toolCalls: [...allToolCalls],
        turns,
        ...(phase === 'executing_tools'
          ? { pendingToolCalls: [...pendingToolCalls] }
          : {}),
        ...(phase === 'executing_tools' && pendingToolResultText !== undefined
          ? { pendingToolResultText }
          : {}),
        ...(phase === 'completed' ? { finalOutput } : {}),
        ...(loopWarned ? { loopWarned: true } : {}),
        ...(loopDetected ? { loopDetected: true } : {}),
        ...(budgetExceeded ? { budgetExceeded: true } : {}),
      }
      try {
        await options.onCheckpoint(state)
      } catch (error) {
        if (strict) throw error
        // Checkpoint delivery is best-effort and must never fail the agent run.
      }
    }

    const baseChatOptions: LLMChatOptions = {
      model: this.options.model,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      maxTokens: this.options.maxTokens,
      temperature: this.options.temperature,
      topP: this.options.topP,
      topK: this.options.topK,
      minP: this.options.minP,
      parallelToolCalls: this.options.parallelToolCalls,
      frequencyPenalty: this.options.frequencyPenalty,
      presencePenalty: this.options.presencePenalty,
      extraBody: this.options.extraBody,
      thinking: this.options.thinking,
      preserveReasoningAsText: this.options.preserveReasoningAsText,
      compressReasoningText: this.options.compressReasoningText,
      systemPrompt: this.options.systemPrompt,
      abortSignal: effectiveAbortSignal,
    }

    // The system prompt and tool definitions are caller-supplied config, not
    // conversation state, so `llm/request` records digests of them once rather
    // than their bytes on every turn.
    const journalRequestConfig = journal
      ? {
          ...(this.options.systemPrompt !== undefined
            ? { systemPromptHash: canonicalJsonHash(this.options.systemPrompt) }
            : {}),
          ...(toolDefs.length > 0 ? { toolsHash: canonicalJsonHash(toolDefs) } : {}),
        }
      : undefined

    // Loop detection state — only allocated when configured.
    const detector = this.options.loopDetection
      ? new LoopDetector(this.options.loopDetection)
      : null
    if (detector !== null) {
      for (const message of conversationMessages) {
        if (message.role !== 'assistant') continue
        const historicalToolUseBlocks = extractToolUseBlocks(message.content)
        if (historicalToolUseBlocks.length > 0) {
          detector.recordToolCalls(historicalToolUseBlocks)
        }
        const historicalText = extractText(message.content)
        if (historicalText.length > 0) {
          detector.recordText(historicalText)
        }
      }
    }
    const loopAction = this.options.loopDetection?.onLoopDetected ?? 'warn'
    const runShellExecutor = this.options.shellExecutor === undefined
      ? undefined
      : new RunScopedShellExecutor(this.options.shellExecutor)
    let streamError: Error | undefined

    try {
      // -----------------------------------------------------------------
      // Main agentic loop — `while (true)` until end_turn or maxTurns
      // -----------------------------------------------------------------
      while (true) {
        if (phase === 'completed') break

        if (phase === 'executing_tools') {
          const toolContext: ToolUseContext = this.buildToolContext(
            options,
            runShellExecutor,
          )
          if (journal) {
            for (const pending of pendingToolCalls) {
              // Restored commits already happened, and a re-entered round
              // (an uncommitted sibling) must not announce a call twice.
              if (pending.commit) continue
              if (journal.toolCallSeq(pending.call.id) !== undefined) continue
              const callSeq = journal.emit({
                type: 'tool/call',
                ...journalScope,
                call: pending.call,
                ...(journalAssistantSeq !== undefined
                  ? { sourceEventSeqs: [journalAssistantSeq] }
                  : {}),
              })
              journal.recordToolCallSeq(pending.call.id, callSeq)
            }
          }
          const executions = await Promise.all(pendingToolCalls.map(async (pending, index) => {
            if (pending.commit) {
              return { commit: pending.commit, shouldCommit: true } satisfies ToolExecution
            }

            if (pending.approvalRequest && !pending.approvalDecision) {
              return {
                commit: this.suspendedToolCommit(pending.call),
                shouldCommit: false,
                approvalRequest: pending.approvalRequest,
                suspension: {
                  content: pending.approvalRequest.content as ToolCallApprovalContent,
                  ...(pending.approvalRequest.reason !== undefined
                    ? { reason: pending.approvalRequest.reason }
                    : {}),
                },
              } satisfies ToolExecution
            }

            const execution = await this.executeToolCall(
              pending.call,
              grantedToolNames,
              toolContext,
              options,
              pending.approvalRequest && pending.approvalDecision
                ? {
                    request: pending.approvalRequest,
                    decision: pending.approvalDecision,
                  }
                : undefined,
            )
            if (execution.suspension) {
              const request = createApprovalRequest({
                runId: options.runId!,
                scope: 'tool_call',
                boundary: `${options.taskId!}:${pending.call.id}`,
                content: execution.suspension.content,
                ...(execution.suspension.reason !== undefined
                  ? { reason: execution.suspension.reason }
                  : {}),
              })
              await options.onApprovalPrepare!()
              pendingToolCalls[index] = { ...pending, approvalRequest: request }
              // A suspension is not reported until its exact in-flight state
              // is durable. Unlike ordinary recovery snapshots, failure here
              // must fail closed rather than pretending the run can resume.
              await persistCheckpoint(true)
              await options.onApprovalRequest!(request)
              return { ...execution, shouldCommit: false, approvalRequest: request }
            }
            if (execution.shouldCommit) {
              if (pending.approvalRequest) {
                await options.onApprovalConsumed?.(pending.approvalRequest.id)
              }
              pendingToolCalls[index] = { call: pending.call, commit: execution.commit }
              if (journal) {
                const callSeq = journal.toolCallSeq(pending.call.id)
                journalToolResultSeqs.set(pending.call.id, journal.emit({
                  type: 'tool/result',
                  ...journalScope,
                  toolCallId: pending.call.id,
                  result: execution.commit.result,
                  record: execution.commit.record,
                  ...(execution.commit.delegationUsage !== undefined
                    ? { delegationUsage: execution.commit.delegationUsage }
                    : {}),
                  ...(callSeq !== undefined ? { sourceEventSeqs: [callSeq] } : {}),
                }))
              }
              // Await the checkpoint before any fallible result callback so a
              // callback failure cannot turn a returned side effect into a
              // missing commit that restore would execute again.
              await persistCheckpoint()
            }
            if (execution.result !== undefined) {
              options.onToolResult?.(pending.call.name, execution.result)
            }
            return execution
          }))

          const suspendedExecutions = executions.filter(
            (execution): execution is ToolExecution & { readonly approvalRequest: ApprovalRequest } =>
              execution.approvalRequest !== undefined,
          )
          if (suspendedExecutions.length > 0) {
            suspended = true
            emitTurnEnd('suspended')
            await persistCheckpoint(true)
            break
          }

          let delegationTurnUsage: TokenUsage | undefined
          for (const execution of executions) {
            const usage = execution.commit.delegationUsage
            if (usage !== undefined) {
              totalUsage = addTokenUsage(totalUsage, usage)
              delegationTurnUsage = delegationTurnUsage === undefined
                ? usage
                : addTokenUsage(delegationTurnUsage, usage)
            }
          }

          const toolResultBlocks: ContentBlock[] = executions.map(
            execution => execution.commit.result,
          )
          for (const execution of executions) {
            allToolCalls.push(execution.commit.record)
            yield {
              type: 'tool_result',
              data: execution.commit.result,
            } satisfies StreamEvent
          }
          if (pendingToolResultText !== undefined) {
            toolResultBlocks.push({ type: 'text', text: pendingToolResultText })
          }

          const toolResultMessage: LLMMessage = {
            role: 'user',
            content: toolResultBlocks,
          }
          if (journal) {
            // One event on the assembled message, so the injected
            // `pendingToolResultText` warning block is recorded verbatim too.
            const sourceEventSeqs = executions
              .map((execution) => journalToolResultSeqs.get(execution.commit.result.tool_use_id))
              .filter((seq): seq is number => seq !== undefined)
            const messageSeq = journal.emit({
              type: 'user/message',
              ...journalScope,
              message: toolResultMessage,
              origin: 'tool_results',
              ...(sourceEventSeqs.length > 0 ? { sourceEventSeqs } : {}),
            })
            journal.registerMessage(toolResultMessage, [messageSeq])
          }
          conversationMessages.push(toolResultMessage)
          newMessages.push(toolResultMessage)
          options.onMessage?.(toolResultMessage)

          const hasUncommittedCall = executions.some(execution => !execution.shouldCommit)
          if (hasUncommittedCall) {
            // Keep the last durable state at `executing_tools`. The current
            // cancelled result remains well-formed for this process, while a
            // later restore re-executes only the call that never committed.
            if (effectiveAbortSignal?.aborted) {
              aborted = true
              emitTurnEnd('aborted')
              break
            }
            continue
          }

          pendingToolCalls = []
          pendingToolResultText = undefined

          if (delegationTurnUsage !== undefined && this.options.maxTokenBudget !== undefined) {
            const totalAfterDelegation = totalUsage.input_tokens + totalUsage.output_tokens
            if (totalAfterDelegation > this.options.maxTokenBudget) {
              budgetExceeded = true
              yield {
                type: 'budget_exceeded',
                data: new TokenBudgetExceededError(
                  this.options.agentName ?? 'unknown',
                  totalAfterDelegation,
                  this.options.maxTokenBudget,
                ),
              } satisfies StreamEvent
            }
          }

          phase = budgetExceeded ? 'completed' : 'awaiting_model'
          emitTurnEnd(budgetExceeded ? 'budget_exceeded' : 'tool_use')
          await persistCheckpoint()
          if (phase === 'completed') break
          continue
        }

        // Respect abort before each LLM call.
        if (effectiveAbortSignal?.aborted) {
          aborted = true
          break
        }

        // Guard against unbounded loops.
        if (turns >= this.maxTurns) {
          break
        }

        const nextTurn = turns + 1
        if (journal) {
          journalOpenTurn = nextTurn
          journal.emit({ type: 'turn/start', ...journalScope, turn: nextTurn })
        }

        // Compress consumed tool results before context strategy (lightweight,
        // no LLM calls) so the strategy operates on already-reduced messages.
        if (this.options.compressToolResults && nextTurn > 1) {
          const rewrite = journal ? newContextRewriteDraft() : undefined
          conversationMessages = this.compressConsumedToolResults(conversationMessages, rewrite)
          if (journal && rewrite && hasContextRewrite(rewrite)) {
            this.recordContextRewrite(journal, journalScope, 'compress-tool-results', rewrite)
          }
        }

        // Optionally compact context before each LLM call.
        if (this.options.contextStrategy) {
          const strategyKind = this.options.contextStrategy.type
          const rewrite = journal ? newContextRewriteDraft() : undefined
          const compacted = await this.applyContextStrategy(
            conversationMessages,
            this.options.contextStrategy,
            baseChatOptions,
            nextTurn,
            options,
            rewrite,
          )
          conversationMessages = compacted.messages
          totalUsage = addTokenUsage(totalUsage, compacted.usage)
          if (journal && rewrite && hasContextRewrite(rewrite)) {
            const seq = this.recordContextRewrite(journal, journalScope, strategyKind, rewrite)
            // The memo is keyed on the old portion, so a later cache hit rebuilds
            // equal blocks; remembering the event lets them reuse it.
            if (strategyKind === 'summarize' && this.summarizeCache !== null) {
              this.summarizeCache.journalReplace = { recorder: journal, seq }
            }
          }
        }

        // ------------------------------------------------------------------
        // Step 1: Call the LLM and collect the full response for this turn.
        // ------------------------------------------------------------------
        // The journal's model-visible boundary is this conversation, recorded
        // per block. Only the `'turn'` call is journaled: the summarize
        // strategy's own `'summary'` call is an implementation detail of the
        // rewrite it produces, not a turn of this conversation.
        const llmRequestSeq = journal
          ? journal.emit({
              type: 'llm/request',
              ...journalScope,
              turn: nextTurn,
              model: baseChatOptions.model,
              blocks: this.describeRequestBlocks(journal, conversationMessages),
              ...journalRequestConfig,
            })
          : undefined
        const response = await this.tracedChat(
          conversationMessages, baseChatOptions, options, 'turn', nextTurn,
        )

        totalUsage = addTokenUsage(totalUsage, response.usage)
        turns = nextTurn

        // ------------------------------------------------------------------
        // Step 2: Build the assistant message from the response content.
        // ------------------------------------------------------------------
        const assistantMessage: LLMMessage = {
          role: 'assistant',
          content: response.content,
        }
        if (journal) {
          journalAssistantSeq = journal.emit({
            type: 'assistant/message',
            ...journalScope,
            message: assistantMessage,
            origin: 'response',
            usage: response.usage,
            model: response.model,
            stopReason: response.stop_reason,
            ...(llmRequestSeq !== undefined ? { sourceEventSeqs: [llmRequestSeq] } : {}),
          })
          // `response.content` is pushed by reference, so registering these
          // block objects is what later requests match against.
          journal.registerBlocks(response.content, [journalAssistantSeq])
        }

        conversationMessages.push(assistantMessage)
        newMessages.push(assistantMessage)
        options.onMessage?.(assistantMessage)

        // Yield text deltas so streaming callers can display them promptly.
        const turnText = extractText(response.content)
        finalOutput = turnText
        if (turnText.length > 0) {
          yield { type: 'text', data: turnText } satisfies StreamEvent
        }

        const totalTokens = totalUsage.input_tokens + totalUsage.output_tokens
        // Defer the break to after tool_result is appended so we never leave
        // an unmatched tool_use block in conversationMessages (which would
        // cause a 400 on any subsequent API call that replays the history).
        if (this.options.maxTokenBudget !== undefined && totalTokens > this.options.maxTokenBudget) {
          budgetExceeded = true
          yield {
            type: 'budget_exceeded',
            data: new TokenBudgetExceededError(
              this.options.agentName ?? 'unknown',
              totalTokens,
              this.options.maxTokenBudget,
            ),
          } satisfies StreamEvent
        }

        // Extract tool-use blocks for detection and execution.
        const toolUseBlocks = extractToolUseBlocks(response.content)

        // ------------------------------------------------------------------
        // Step 2.5: Loop detection — check before yielding tool_use events
        // so that terminate mode doesn't emit orphaned tool_use without
        // matching tool_result.
        // ------------------------------------------------------------------
        let injectWarning = false
        let injectWarningKind: 'tool_repetition' | 'text_repetition' = 'tool_repetition'
        if (detector) {
          const toolInfo = toolUseBlocks.length > 0
            ? detector.recordToolCalls(toolUseBlocks)
            : null
          const textInfo = turnText.length > 0 ? detector.recordText(turnText) : null
          const info = toolInfo ?? textInfo

          if (info) {
            yield { type: 'loop_detected', data: info } satisfies StreamEvent
            options.onWarning?.(info.detail)

            const action = typeof loopAction === 'function'
              ? await loopAction(info)
              : loopAction

            if (action === 'terminate') {
              loopDetected = true
              finalOutput = turnText
              phase = 'completed'
              emitTurnEnd('loop_detected')
              await persistCheckpoint()
              break
            } else if (action === 'warn' || action === 'inject') {
              if (loopWarned) {
                // Second detection after a warning — force terminate.
                loopDetected = true
                finalOutput = turnText
                phase = 'completed'
                emitTurnEnd('loop_detected')
                await persistCheckpoint()
                break
              }
              loopWarned = true
              injectWarning = true
              injectWarningKind = info.kind
              // Fall through to execute tools, then inject warning.
            }
            // 'continue' — do nothing, let the loop proceed normally.
          } else {
            // No loop detected this turn — agent has recovered, so reset
            // the warning state. A future loop gets a fresh warning cycle.
            loopWarned = false
          }
        }

        // ------------------------------------------------------------------
        // Step 3: Decide whether to continue looping.
        // ------------------------------------------------------------------
        if (toolUseBlocks.length === 0) {
          if (budgetExceeded) {
            phase = 'completed'
            emitTurnEnd('budget_exceeded')
            await persistCheckpoint()
            break
          }
          if (injectWarning) {
            const warningMessage: LLMMessage = {
              role: 'user',
              content: [{ type: 'text', text: loopWarningText(injectWarningKind) }],
            }
            if (journal) {
              journal.registerMessage(warningMessage, [journal.emit({
                type: 'user/message',
                ...journalScope,
                message: warningMessage,
                origin: 'input',
                ...(journalAssistantSeq !== undefined
                  ? { sourceEventSeqs: [journalAssistantSeq] }
                  : {}),
              })])
            }
            conversationMessages.push(warningMessage)
            newMessages.push(warningMessage)
            options.onMessage?.(warningMessage)
            phase = 'awaiting_model'
            emitTurnEnd('loop_detected')
            await persistCheckpoint()
            continue
          }
          // Warn on first turn if tools were provided but model didn't use them.
          if (turns === 1 && toolDefs.length > 0 && options.onWarning) {
            const agentName = this.options.agentName ?? 'unknown'
            options.onWarning(
              `Agent "${agentName}" has ${toolDefs.length} tool(s) available but the model ` +
              `returned no tool calls. If using a local model, verify it supports tool calling ` +
              `(see https://ollama.com/search?c=tools).`,
            )
          }
          // No tools requested — this is the terminal assistant turn.
          finalOutput = turnText
          phase = 'completed'
          emitTurnEnd('completed')
          await persistCheckpoint()
          break
        }

        // Announce each tool-use block the model requested (after loop
        // detection, so terminate mode never emits unpaired events).
        for (const block of toolUseBlocks) {
          yield { type: 'tool_use', data: block } satisfies StreamEvent
        }
        pendingToolCalls = toolUseBlocks.map(call => ({ call }))
        pendingToolResultText = injectWarning
          ? loopWarningText(injectWarningKind)
          : undefined
        phase = 'executing_tools'
        // Persist the assistant turn before any side effect begins. Each tool
        // result then advances its own commit record from this baseline.
        await persistCheckpoint()
      }
    } catch (err) {
      streamError = err instanceof Error ? err : new Error(String(err))
      emitTurnEnd('error')
    } finally {
      try {
        await runShellExecutor?.release()
      } catch (err) {
        const cleanupError = err instanceof Error ? err : new Error(String(err))
        if (streamError !== undefined) {
          throw new AggregateError(
            [streamError, cleanupError],
            'Agent run failed and shell executor cleanup also failed.',
          )
        }
        throw cleanupError
      }
    }

    if (streamError !== undefined) {
      yield { type: 'error', data: streamError } satisfies StreamEvent
      return
    }

    // If the loop exited due to maxTurns, use whatever text was last emitted.
    if (finalOutput === '' && conversationMessages.length > 0) {
      const lastAssistant = [...conversationMessages]
        .reverse()
        .find(m => m.role === 'assistant')
      if (lastAssistant !== undefined) {
        finalOutput = extractText(lastAssistant.content)
      }
    }

    const runResult: RunResult = {
      // Return only the messages added during this run (not the initial seed).
      messages: newMessages,
      output: finalOutput,
      toolCalls: allToolCalls,
      tokenUsage: totalUsage,
      turns,
      ...(loopDetected ? { loopDetected: true } : {}),
      ...(budgetExceeded ? { budgetExceeded: true } : {}),
      ...(aborted ? { aborted: true } : {}),
      ...(suspended ? { suspended: true } : {}),
      ...(suspended
        ? {
            pendingApprovals: pendingToolCalls
              .map((pending) => pending.approvalRequest)
              .filter((request): request is ApprovalRequest => request !== undefined),
          }
        : {}),
    }

    yield { type: 'done', data: runResult } satisfies StreamEvent
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Emit one `context/replace` for a rewrite and give every block it derived a
   * lineage naming that event.
   *
   * Source blocks are translated into sequences here rather than inside the
   * strategies, which keeps every strategy free of journal knowledge.
   */
  private recordContextRewrite(
    recorder: JournalRecorder,
    scope: JournalScope | undefined,
    strategy: ContextStrategyKind,
    rewrite: ContextRewriteDraft,
  ): number {
    const derivedBlocks = rewrite.replacements.map((replacement) => replacement.block)
    if (rewrite.reuseEventSeq !== undefined) {
      recorder.registerBlocks(derivedBlocks, [rewrite.reuseEventSeq])
      return rewrite.reuseEventSeq
    }
    const seq = recorder.emit({
      type: 'context/replace',
      ...scope,
      strategy,
      ...(rewrite.droppedBlocks.length > 0
        ? { dropped: { sourceEventSeqs: lineageOf(recorder, rewrite.droppedBlocks) } }
        : {}),
      replacements: rewrite.replacements.map((replacement) => ({
        sourceEventSeqs: lineageOf(recorder, replacement.sources),
        block: replacement.block,
      })),
      ...(rewrite.detail !== undefined ? { detail: rewrite.detail } : {}),
    })
    recorder.registerBlocks(derivedBlocks, [seq])
    return seq
  }

  /** Scoping fields stamped on every journal event this runner emits. */
  private journalScope(options: RunOptions): JournalScope {
    const agentName = options.traceAgent ?? this.options.agentName
    return {
      ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
      ...(agentName !== undefined ? { agentName } : {}),
      ...(options.traceSpan ? { spanId: options.traceSpan.spanId } : {}),
    }
  }

  /**
   * Describe every block the model is about to see, with the journal event it
   * came from.
   *
   * A block with no recorded lineage is normally recorded as the gap it is
   * (`sourceEventSeqs: null`); under `enforceLineage` it throws instead, at the
   * exact request that would otherwise have hidden it.
   */
  private describeRequestBlocks(
    recorder: JournalRecorder,
    messages: readonly LLMMessage[],
  ): RequestBlockDescriptor[] {
    const descriptors: RequestBlockDescriptor[] = []
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const message = messages[messageIndex]!
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
        const block = message.content[blockIndex]!
        const sourceEventSeqs = recorder.lineageFor(block)
        if (sourceEventSeqs === null && recorder.enforceLineage) {
          throw new JournalLineageError(messageIndex, blockIndex, block.type)
        }
        descriptors.push({
          messageIndex,
          blockIndex,
          role: message.role,
          blockType: block.type,
          sourceEventSeqs,
          contentHash: recorder.hashFor(block),
        })
      }
    }
    return descriptors
  }

  private async executeToolCall(
    block: ToolUseBlock,
    grantedToolNames: ReadonlySet<string>,
    toolContext: ToolUseContext,
    options: RunOptions,
    durableApproval?: {
      readonly request: ApprovalRequest
      readonly decision: ApprovalDecisionRecord
    },
  ): Promise<ToolExecution> {
    options.onToolCall?.(block.name, block.input)

    const toolSpan = options.traceRuntime && options.traceSpan
      ? options.traceRuntime.startSpan({
          kind: 'tool',
          name: 'execute_tool',
          parent: options.traceSpan,
          attributes: {
            'oma.agent.name': options.traceAgent ?? this.options.agentName ?? 'unknown',
            'oma.tool.name': block.name,
            ...(options.taskId ? { 'oma.task.id': options.taskId } : {}),
          },
        })
      : undefined
    const startTime = toolSpan?.startUnixMs ?? Date.now()
    let result: ToolResult<any>

    if (!grantedToolNames.has(block.name)) {
      // Default-deny enforcement: the model asked for a tool that resolveTools()
      // did not grant. Surface a normal error result rather than executing it.
      result = {
        data:
          `Tool "${block.name}" is not granted to this agent. ` +
          'Built-in tools are opt-in: grant it via the agent\'s "tools" allowlist or ' +
          '"toolPreset" (or set the orchestrator\'s "defaultToolPreset").',
        isError: true,
        ...(durableApproval
          ? { metadata: { approvalError: 'The reviewed tool is no longer granted.' } }
          : {}),
      }
    } else {
      try {
        const callContext: ToolUseContext = {
          ...toolContext,
          toolCallId: block.id,
        }
        const executionContext: ToolUseContext = toolSpan && callContext.team?.runDelegatedAgent
          ? {
              ...callContext,
              team: {
                ...callContext.team,
                runDelegatedAgent: (targetAgent, prompt) =>
                  callContext.team!.runDelegatedAgent!(targetAgent, prompt, toolSpan),
              },
            }
          : callContext
        result = await this.toolExecutor.execute(
          block.name,
          block.input,
          executionContext,
          {
            onToolCall: this.options.onToolCall,
            ...(durableApproval ? { durableApproval } : {}),
          },
        )
      } catch (err) {
        // Tool executor errors become error results — the loop continues.
        const message = err instanceof Error ? err.message : String(err)
        result = { data: message, isError: true }
      }
    }

    const approvalContent = result.metadata?.approvalRequestContent
    const canSuspend = approvalContent !== undefined
      && options.onCheckpoint !== undefined
      && options.onApprovalPrepare !== undefined
      && options.onApprovalRequest !== undefined
      && options.taskId !== undefined
      && options.runId !== undefined
    if (approvalContent !== undefined && !canSuspend) {
      const { approvalRequestContent: _approvalRequestContent, ...metadata } = result.metadata ?? {}
      result = {
        data:
          `Tool "${block.name}" requested suspension, but durable tool approval requires ` +
          'an orchestrated task with checkpoint persistence and MemoryStore.compareAndSet.',
        isError: true,
        metadata,
      }
    }
    if (result.metadata?.approvalError) {
      const approvalError = typeof result.data === 'string'
        ? result.data
        : 'The reviewed tool returned a non-text approval error.'
      throw new DurableApprovalError('APPROVAL_STALE_DECISION', approvalError)
    }

    const endTime = Date.now()
    const duration = endTime - startTime
    // Keep callbacks/application consumers isolated from the transcript.
    // ToolExecutor already copied tool-owned input; this second copy means an
    // onToolResult callback cannot mutate what the model or checkpoint receives.
    const modelOutput = copyToolResultContent(modelOutputFromToolResult(result))
    const recordedOutput = result.modelOutput === undefined && typeof result.data === 'string'
      ? result.data
      : summarizeToolResultContent(modelOutput)
    const legacyEvent: TraceEvent | undefined = options.onTrace ? {
        type: 'tool_call',
        runId: options.runId ?? '',
        spanId: generateSpanId(),
        ...(options.traceSpanId ? { parentId: options.traceSpanId } : {}),
        taskId: options.taskId,
        agent: options.traceAgent ?? this.options.agentName ?? 'unknown',
        tool: block.name,
        isError: result.isError ?? false,
        ...(result.metadata?.toolCallGate
          ? {
              gated: true,
              gateAction: result.metadata.toolCallGate.action,
              ...(result.metadata.toolCallGate.reason
                ? { gateReason: redactSensitiveText(result.metadata.toolCallGate.reason) }
                : {}),
            }
          : {}),
        input: redactSensitiveObject(block.input),
        output: redactSensitiveText(summarizeToolResultContent(modelOutput)),
        startMs: startTime,
        endMs: endTime,
        durationMs: duration,
      } : undefined
    if (toolSpan) {
      const isError = result.isError ?? false
      const classified = isError
        ? classifyRunFailure(new Error(recordedOutput), { kind: 'tool' })
        : undefined
      toolSpan.end({
        status: classified?.status ?? { code: 'ok' },
        ...(classified ? { error: classified.errorInfo } : {}),
        attributes: { 'oma.tool.is_error': isError },
        ...(legacyEvent ? { legacyEvent } : {}),
      })
      toolSpan.ensureEnded()
    } else if (legacyEvent) {
      emitTrace(options.onTrace, legacyEvent)
    }

    const record: ToolCallRecord = {
      toolName: block.name,
      input: block.input,
      output: recordedOutput,
      duration,
    }
    const resultBlock: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: block.id,
      content: modelOutput,
      is_error: result.isError,
    }

    return {
      commit: {
        result: resultBlock,
        record,
        ...(result.metadata?.tokenUsage !== undefined
          ? { delegationUsage: result.metadata.tokenUsage }
          : {}),
      },
      result,
      // An error result is normally plain committed data. The one exception is
      // a cancellation that became visible during this call: it represents the
      // conservative "no commit record" path and must run again after restore.
      shouldCommit: !(result.isError === true && toolContext.abortSignal?.aborted === true),
      ...(canSuspend
        ? {
            suspension: {
              content: approvalContent,
              ...(result.metadata?.toolCallGate?.reason !== undefined
                ? { reason: result.metadata.toolCallGate.reason }
                : {}),
            },
          }
        : {}),
    }
  }

  private suspendedToolCommit(block: ToolUseBlock): ToolCallCommitCheckpoint {
    const output = `Tool "${block.name}" is awaiting durable approval.`
    return {
      result: {
        type: 'tool_result',
        tool_use_id: block.id,
        content: output,
        is_error: true,
      },
      record: {
        toolName: block.name,
        input: block.input,
        output,
        duration: 0,
      },
    }
  }

  /**
   * Rule-based selective context compaction (no LLM calls).
   *
   * Compresses old turns while preserving the conversation skeleton:
   * - tool_use blocks (decisions) are always kept
   * - Long tool_result content is replaced with a compact marker
   * - Long assistant text blocks are truncated with an excerpt
   * - Error tool_results are never compressed
   * - Recent turns (within `preserveRecentTurns`) are kept intact
   */
  private compactMessages(
    messages: LLMMessage[],
    strategy: Extract<ContextStrategy, { type: 'compact' }>,
    rewrite?: ContextRewriteDraft,
  ): LLMMessage[] {
    const estimated = estimateTokens(messages)
    if (estimated <= strategy.maxTokens) {
      return messages
    }

    const preserveRecent = strategy.preserveRecentTurns ?? 4
    const minToolResultChars = strategy.minToolResultChars ?? 200
    const minTextBlockChars = strategy.minTextBlockChars ?? 2000
    const textBlockExcerptChars = strategy.textBlockExcerptChars ?? 200

    // Find the first user message — it is always preserved as-is.
    const firstUserIndex = messages.findIndex(m => m.role === 'user')
    if (firstUserIndex < 0 || firstUserIndex === messages.length - 1) {
      return messages
    }

    // Walk backward to find the boundary between old and recent turns.
    // A "turn pair" is an assistant message followed by a user message.
    let boundary = messages.length
    let pairsFound = 0
    for (let i = messages.length - 1; i > firstUserIndex && pairsFound < preserveRecent; i--) {
      if (messages[i]!.role === 'user' && i > 0 && messages[i - 1]!.role === 'assistant') {
        pairsFound++
        boundary = i - 1
      }
    }

    // If all turns fit within the recent window, nothing to compact.
    if (boundary <= firstUserIndex + 1) {
      return messages
    }

    // Build a tool_use_id → tool name lookup from old assistant messages.
    const toolNameMap = new Map<string, string>()
    for (let i = firstUserIndex + 1; i < boundary; i++) {
      const msg = messages[i]!
      if (msg.role !== 'assistant') continue
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolNameMap.set(block.id, block.name)
        }
      }
    }

    // Process old messages (between first user and boundary).
    let anyChanged = false
    const result: LLMMessage[] = []

    for (let i = 0; i < messages.length; i++) {
      // First user message and recent messages: keep intact.
      if (i <= firstUserIndex || i >= boundary) {
        result.push(messages[i]!)
        continue
      }

      const msg = messages[i]!
      let msgChanged = false
      const newContent = msg.content.map((block): ContentBlock => {
        if (msg.role === 'assistant') {
          // tool_use blocks: always preserve (decisions).
          if (block.type === 'tool_use') return block
          // Long text blocks: truncate with excerpt.
          if (block.type === 'text' && block.text.length >= minTextBlockChars) {
            msgChanged = true
            const excerpt: TextBlock = {
              type: 'text',
              text: `${block.text.slice(0, textBlockExcerptChars)}... [truncated — ${block.text.length} chars total]`,
            }
            rewrite?.replacements.push({ block: excerpt, sources: [block] })
            return excerpt
          }
          // Image blocks in old turns: replace with marker.
          if (block.type === 'image') {
            msgChanged = true
            const marker: TextBlock = { type: 'text', text: '[Image compacted]' }
            rewrite?.replacements.push({ block: marker, sources: [block] })
            return marker
          }
          return block
        }

        // User messages in old zone.
        if (block.type === 'tool_result') {
          // Error results: always preserve.
          if (block.is_error) return block
          // Already compressed by compressToolResults or a prior compact pass.
          if (
            typeof block.content === 'string' &&
            (block.content.startsWith('[Tool output compressed') ||
              block.content.startsWith('[Tool result:'))
          ) {
            return block
          }
          // Short results: preserve.
          const contentSize = toolResultContentSize(block.content)
          if (contentSize < minToolResultChars) return block
          const toolName = toolNameMap.get(block.tool_use_id) ?? 'unknown'
          // Delegation results: preserve — parent agent may still reason over them.
          if (toolName === 'delegate_to_agent') return block
          // Compress.
          msgChanged = true
          const sizeDescription = typeof block.content === 'string'
            ? `${contentSize} chars`
            : `${contentSize} estimated chars`
          const compacted: ToolResultBlock = {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: `[Tool result: ${toolName} — ${sizeDescription}, compacted]`,
          }
          rewrite?.replacements.push({ block: compacted, sources: [block] })
          return compacted
        }
        return block
      })

      if (msgChanged) {
        anyChanged = true
        result.push({ role: msg.role, content: newContent } as LLMMessage)
      } else {
        result.push(msg)
      }
    }

    return anyChanged ? result : messages
  }

  /**
   * Replace consumed tool results with compact markers.
   *
   * A tool_result is "consumed" when the assistant has produced a response
   * after seeing it (i.e. there is an assistant message following the user
   * message that contains the tool_result).  The most recent user message
   * with tool results is always kept intact — the LLM is about to see it.
   *
   * Error results and results shorter than `minChars` are never compressed.
   */
  private compressConsumedToolResults(
    messages: LLMMessage[],
    rewrite?: ContextRewriteDraft,
  ): LLMMessage[] {
    const config = this.options.compressToolResults
    if (!config) return messages

    const minChars = typeof config === 'object'
      ? (config.minChars ?? DEFAULT_MIN_COMPRESS_CHARS)
      : DEFAULT_MIN_COMPRESS_CHARS

    // Find the last user message that carries tool_result blocks.
    let lastToolResultUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (
        messages[i]!.role === 'user' &&
        messages[i]!.content.some(b => b.type === 'tool_result')
      ) {
        lastToolResultUserIdx = i
        break
      }
    }

    // Nothing to compress if there's at most one tool-result user message.
    if (lastToolResultUserIdx <= 0) return messages

    // Build a tool_use_id → tool name map so we can exempt delegation results,
    // whose full output the parent agent may need to re-read in later turns.
    const toolNameMap = new Map<string, string>()
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      for (const block of msg.content) {
        if (block.type === 'tool_use') toolNameMap.set(block.id, block.name)
      }
    }

    let anyChanged = false
    const result = messages.map((msg, idx) => {
      // Only compress user messages that appear before the last one.
      if (msg.role !== 'user' || idx >= lastToolResultUserIdx) return msg

      const hasToolResult = msg.content.some(b => b.type === 'tool_result')
      if (!hasToolResult) return msg

      let msgChanged = false
      const newContent = msg.content.map((block): ContentBlock => {
        if (block.type !== 'tool_result') return block

        // Never compress error results — they carry diagnostic value.
        if (block.is_error) return block

        // Never compress delegation results — the parent agent relies on the full sub-agent output.
        if (toolNameMap.get(block.tool_use_id) === 'delegate_to_agent') return block

        // Skip already-compressed results — avoid re-compression with wrong char count.
        if (
          typeof block.content === 'string' &&
          block.content.startsWith('[Tool output compressed')
        ) return block

        // Skip short results — the marker itself has overhead.
        const contentSize = toolResultContentSize(block.content)
        if (contentSize < minChars) return block

        msgChanged = true
        const sizeDescription = typeof block.content === 'string'
          ? `${contentSize} chars`
          : `${contentSize} estimated chars`
        const compressed: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: `[Tool output compressed — ${sizeDescription}, already processed]`,
        }
        rewrite?.replacements.push({ block: compressed, sources: [block] })
        return compressed
      })

      if (msgChanged) {
        anyChanged = true
        return { role: msg.role, content: newContent } as LLMMessage
      }
      return msg
    })

    return anyChanged ? result : messages
  }

  /**
   * Build the {@link ToolUseContext} passed to every tool execution.
   * Identifies this runner as the invoking agent.
   */
  private buildToolContext(
    options: RunOptions = {},
    shellExecutor?: ShellExecutor,
  ): ToolUseContext {
    return {
      agent: {
        name: this.options.agentName ?? 'runner',
        role: this.options.agentRole ?? 'assistant',
        model: this.options.model,
      },
      abortSignal: options.abortSignal ?? this.options.abortSignal,
      ...(shellExecutor !== undefined
        ? { shellExecutor }
        : {}),
      cwd: this.options.cwd === undefined ? defaultWorkspaceDir() : this.options.cwd,
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
      ...(options.team !== undefined ? { team: options.team } : {}),
      ...(this.options.credentials !== undefined ? { credentials: this.options.credentials } : {}),
    }
  }
}
