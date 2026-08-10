/**
 * @fileoverview High-level Agent class for open-multi-agent.
 *
 * {@link Agent} is the primary interface most consumers interact with.
 * It wraps {@link AgentRunner} with:
 *  - Persistent conversation history (`prompt()`)
 *  - Fresh-conversation semantics (`run()`)
 *  - Streaming support (`stream()`)
 *  - Dynamic tool registration at runtime
 *  - Full lifecycle state tracking (`idle → running → completed | error`)
 *
 * @example
 * ```ts
 * import { Agent, ToolRegistry, ToolExecutor, registerBuiltInTools } from '@open-multi-agent/core'
 *
 * const registry = new ToolRegistry()
 * registerBuiltInTools(registry)
 * const executor = new ToolExecutor(registry)
 *
 * const agent = new Agent(
 *   {
 *     name: 'researcher',
 *     model: 'claude-sonnet-4-6',
 *     systemPrompt: 'You are a rigorous research assistant.',
 *     tools: ['file_read', 'grep'],
 *   },
 *   registry,
 *   executor,
 * )
 *
 * const result = await agent.run('Summarise the project README.')
 * console.log(result.output)
 *
 * // For one-shot runs without managing the Agent instance, use
 * // `new OpenMultiAgent().runAgent(config, prompt)` instead.
 * ```
 */

import { isDeepStrictEqual } from 'node:util'

import type {
  ExternalAgentBackendConfig,
  AgentConfig,
  AgentPromptInput,
  AgentRunInput,
  AgentState,
  AgentRunResult,
  BeforeRunHookContext,
  BeforeRunHookResult,
  ContentBlock,
  LLMMessage,
  StreamEvent,
  TokenUsage,
  ToolUseContext,
  RunIdentity,
  RunStatus,
  TraceErrorKind,
} from '../types.js'
import { emitTrace, generateSpanId } from '../utils/trace.js'
import { mergeAbortSignals } from '../utils/abort.js'
import { createRunIdentity } from '../observability/identity.js'
import { classifyRunFailure, statusOnly } from '../observability/status.js'
import { DurableApprovalError } from '../approval/durable.js'
import { createTraceRuntime } from '../observability/runtime.js'
import {
  InvalidMessageError,
  StructuredOutputValidationError,
  TokenBudgetExceededError,
} from '../errors.js'
import { assertValidMessages } from '../llm/validate.js'
import type { ToolDefinition as FrameworkToolDefinition, ToolRegistry } from '../tool/framework.js'
import type { ToolExecutor } from '../tool/executor.js'
import { defaultWorkspaceDir } from '../tool/built-in/path-safety.js'
import { createAdapter } from '../llm/adapter.js'
import { normalizeEgressPolicy, rejectUnsupportedEgress } from '../llm/egress.js'
import { AgentRunner, type AgentBackend, type RunnerOptions, type RunOptions, type RunResult } from './runner.js'
import {
  buildStructuredOutputInstruction,
  extractJSON,
  validateOutput,
} from './structured-output.js'
import {
  copyMessages,
  prepareAgentPromptInput,
  prepareAgentRunInput,
} from './input.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/**
 * High-level wrapper around {@link AgentRunner} that manages conversation
 * history, state transitions, and tool lifecycle.
 */
export class Agent {
  readonly name: string
  readonly config: AgentConfig

  private backend: AgentBackend | null = null
  private state: AgentState
  private readonly _toolRegistry: ToolRegistry
  private readonly _toolExecutor: ToolExecutor
  private messageHistory: LLMMessage[] = []

  /**
   * @param config       - Static configuration for this agent.
   * @param toolRegistry - Registry used to resolve and manage tools.
   * @param toolExecutor - Executor that dispatches tool calls.
   *
   * `toolRegistry` and `toolExecutor` are injected rather than instantiated
   * internally so that teams of agents can share a single registry.
   */
  constructor(
    config: AgentConfig,
    toolRegistry: ToolRegistry,
    toolExecutor: ToolExecutor,
  ) {
    this.name = config.name
    // `model` is optional on AgentConfig so orchestrated agents can inherit
    // `OrchestratorConfig.defaultModel`. A standalone Agent has no orchestrator
    // to inherit from, so it must declare a model explicitly — unless it runs on
    // an external `backend` (e.g. an ACP coding CLI), which needs no LLM model.
    if (config.model === undefined && config.backend === undefined) {
      throw new Error(
        `Agent "${config.name}" has no model. Set 'model' in its config, or a 'backend', ` +
          `or run it through OpenMultiAgent to inherit 'defaultModel'.`,
      )
    }
    const egressPolicy = normalizeEgressPolicy(config.egressPolicy)
    this.config = egressPolicy === undefined
      ? config
      : { ...config, egressPolicy }
    this._toolRegistry = toolRegistry
    this._toolExecutor = toolExecutor
    if (config.history) assertValidMessages(config.history)
    this.messageHistory = config.history ? copyMessages(config.history) : []

    this.state = {
      status: 'idle',
      messages: [],
      tokenUsage: ZERO_USAGE,
    }
  }

  // -------------------------------------------------------------------------
  // Initialisation (async, called lazily)
  // -------------------------------------------------------------------------

  /**
   * Lazily create the {@link AgentBackend} that executes this agent's runs.
   *
   * Defaults to an {@link AgentRunner} (the LLM conversation loop). When
   * {@link AgentConfig.backend} is set, delegates to an external backend (e.g. an
   * ACP coding CLI) instead. Construction is async because it may lazy-import a
   * provider SDK or the optional ACP peer, so we defer it to the first
   * `run` / `prompt` / `stream` call.
   */
  private async getBackend(): Promise<AgentBackend> {
    if (this.backend !== null) {
      return this.backend
    }

    // External backend: it runs its own agentic loop, so none of the
    // LLM-specific configuration below applies.
    if (this.config.backend) {
      this.backend = await this.createExternalBackend(this.config.backend)
      return this.backend
    }

    const provider = this.config.provider ?? 'anthropic'
    let adapter = this.config.adapter
    if (adapter !== undefined) {
      rejectUnsupportedEgress(
        this.config.egressPolicy,
        adapter.name,
        'custom and AI SDK adapters do not expose an enforceable request transport or target contract to OMA.',
      )
    } else {
      adapter = this.config.egressPolicy === undefined
        ? await createAdapter(
            provider,
            this.config.apiKey,
            this.config.baseURL,
            this.config.region,
          )
        : await createAdapter(
            provider,
            this.config.apiKey,
            this.config.baseURL,
            this.config.region,
            this.config.egressPolicy,
          )
    }

    // Append structured-output instructions when an outputSchema is configured.
    let effectiveSystemPrompt = this.config.systemPrompt
    if (this.config.outputSchema) {
      const instruction = buildStructuredOutputInstruction(this.config.outputSchema)
      effectiveSystemPrompt = effectiveSystemPrompt
        ? effectiveSystemPrompt + '\n' + instruction
        : instruction
    }

    const runnerOptions: RunnerOptions = {
      // Non-null: the constructor rejects a missing model, so by the time a
      // runner is built `model` is guaranteed present.
      model: this.config.model!,
      systemPrompt: effectiveSystemPrompt,
      maxTurns: this.config.maxTurns,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      topP: this.config.topP,
      topK: this.config.topK,
      minP: this.config.minP,
      parallelToolCalls: this.config.parallelToolCalls,
      frequencyPenalty: this.config.frequencyPenalty,
      presencePenalty: this.config.presencePenalty,
      extraBody: this.config.extraBody,
      thinking: this.config.thinking,
      toolPreset: this.config.toolPreset,
      allowedTools: this.config.tools,
      disallowedTools: this.config.disallowedTools,
      ...(this.config.onToolCall !== undefined ? { onToolCall: this.config.onToolCall } : {}),
      ...(this.config.shellExecutor !== undefined
        ? { shellExecutor: this.config.shellExecutor }
        : {}),
      cwd: this.config.cwd,
      agentName: this.name,
      agentRole: this.config.systemPrompt?.slice(0, 50) ?? 'assistant',
      credentials: this.config.credentials,
      callTimeoutMs: this.config.callTimeoutMs,
      loopDetection: this.config.loopDetection,
      maxTokenBudget: this.config.maxTokenBudget,
      contextStrategy: this.config.contextStrategy,
      compressToolResults: this.config.compressToolResults,
      preserveReasoningAsText: this.config.preserveReasoningAsText,
      compressReasoningText: this.config.compressReasoningText,
    }

    this.backend = new AgentRunner(
      adapter,
      this._toolRegistry,
      this._toolExecutor,
      runnerOptions,
    )

    return this.backend
  }

  /**
   * Build a non-LLM {@link AgentBackend} from {@link AgentConfig.backend}.
   *
   * The backend module is loaded via dynamic `import()` so its optional peer SDK
   * (e.g. `@agentclientprotocol/sdk`) is only resolved when a backend is used.
   */
  private async createExternalBackend(backend: ExternalAgentBackendConfig): Promise<AgentBackend> {
    switch (backend.kind) {
      case 'acp': {
        const { createAcpBackend } = await import('./acp-backend.js')
        return createAcpBackend({
          command: backend.command,
          args: backend.args,
          env: backend.env,
          cwd: backend.cwd,
          permission: backend.permission,
          // ACP has no system-prompt field; the backend prepends this to the
          // agent's first turn so its configured role reaches the external CLI.
          systemPrompt: this.config.systemPrompt,
          agentName: this.name,
          model: this.config.model,
          callTimeoutMs: this.config.callTimeoutMs,
        })
      }
      case 'process': {
        const { createProcessBackend } = await import('./process-backend.js')
        return createProcessBackend({
          command: backend.command,
          args: backend.args,
          env: backend.env,
          cwd: backend.cwd,
          input: backend.input,
          systemPrompt: this.config.systemPrompt,
          agentName: this.name,
        })
      }
      default:
        throw new Error(
          `Agent "${this.name}": unknown backend kind "${(backend as { kind: string }).kind}".`,
        )
    }
  }

  // -------------------------------------------------------------------------
  // Primary execution methods
  // -------------------------------------------------------------------------

  /**
   * Run a string prompt or complete message list in a fresh conversation
   * (persistent history is NOT used).
   *
   * A string is shorthand for `[{ role:'user', content:[{ type:'text', … }] }]`.
   * A structured list is defensively copied before execution. The agent's
   * persistent history is not modified.
   *
   * Use this for one-shot queries where past context is irrelevant.
   */
  async run(input: AgentRunInput, runOptions?: Partial<RunOptions>): Promise<AgentRunResult> {
    const { messages } = prepareAgentRunInput(input, this.config.backend)
    return this.executeRun(messages, runOptions)
  }

  /**
   * Run a string or structured user turn as part of the ongoing conversation.
   *
   * A `ContentBlock[]` is appended as exactly one user message. The input and
   * resulting messages are defensively copied into persistent history for the
   * next call.
   *
   * Use this for multi-turn interactions.
   */
  // TODO(#18): accept optional RunOptions to forward trace context
  async prompt(input: AgentPromptInput): Promise<AgentRunResult> {
    const { message: userMessage } = prepareAgentPromptInput(input, this.config.backend)
    this.messageHistory.push(userMessage)

    const result = await this.executeRun(copyMessages(this.messageHistory))

    // Persist the new messages into history so the next `prompt` sees them.
    for (const msg of copyMessages(result.messages)) {
      this.messageHistory.push(msg)
    }

    return result
  }

  /**
   * Stream a fresh-conversation response from a string or complete message list,
   * yielding {@link StreamEvent}s.
   *
   * Like {@link run}, this does not use or update the persistent history.
   */
  stream(input: AgentRunInput, runOptions?: Partial<RunOptions>): AsyncGenerator<StreamEvent> {
    const { messages } = prepareAgentRunInput(input, this.config.backend)
    return this.executeStream(messages, runOptions)
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  /** Return a snapshot of the current agent state (does not clone nested objects). */
  getState(): AgentState {
    return { ...this.state, messages: [...this.state.messages] }
  }

  /** Return a copy of the persistent message history. */
  getHistory(): LLMMessage[] {
    return copyMessages(this.messageHistory)
  }

  /**
   * Clear the persistent conversation history and reset state to `idle`.
   * Does NOT discard the runner instance — the adapter connection is reused.
   */
  reset(): void {
    this.messageHistory = []
    this.state = {
      status: 'idle',
      messages: [],
      tokenUsage: ZERO_USAGE,
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic tool management
  // -------------------------------------------------------------------------

  /**
   * Register a new tool with this agent's tool registry at runtime.
   *
   * The tool becomes available to the next LLM call — no restart required.
   */
  addTool(tool: FrameworkToolDefinition): void {
    this._toolRegistry.register(tool, { runtimeAdded: true })
  }

  /**
   * Deregister a tool by name.
   * If the tool is not registered this is a no-op (no error is thrown).
   */
  removeTool(name: string): void {
    this._toolRegistry.deregister(name)
  }

  /** Return the names of all currently registered tools. */
  getTools(): string[] {
    return this._toolRegistry.list().map((t) => t.name)
  }

  // -------------------------------------------------------------------------
  // Private execution core
  // -------------------------------------------------------------------------

  /**
   * Shared execution path used by both `run` and `prompt`.
   * Handles state transitions and error wrapping.
   */
  private async executeRun(
    messages: LLMMessage[],
    callerOptions?: Partial<RunOptions>,
  ): Promise<AgentRunResult> {
    this.transitionTo('running')

    const agentStartMs = Date.now()
    let effectiveTraceOptions: Partial<RunOptions> | undefined = callerOptions
    const identity = callerOptions?.identity ?? createRunIdentity(
      callerOptions?.runId !== undefined ? { runId: callerOptions.runId } : {},
    )
    const traceRuntime = callerOptions?.traceRuntime
      ?? createTraceRuntime(identity, callerOptions?.onTrace)
    const traceRuntimeOwner = traceRuntime !== undefined && callerOptions?.traceRuntime === undefined
    const traceSpan = traceRuntime?.startSpan({
      kind: 'agent',
      name: 'invoke_agent',
      parent: callerOptions?.traceSpan ?? traceRuntime.root,
      links: callerOptions?.traceLinks,
      attributes: {
        'oma.agent.name': callerOptions?.traceAgent ?? this.name,
        ...(callerOptions?.tracePhase ? { 'oma.phase': callerOptions.tracePhase } : {}),
        ...(callerOptions?.traceAgentAttempt !== undefined
          ? { 'oma.agent.attempt': callerOptions.traceAgentAttempt }
          : {}),
        ...(callerOptions?.taskId ? { 'oma.task.id': callerOptions.taskId } : {}),
      },
    })
    let timeoutSignal: AbortSignal | undefined
    let callerAbort: AbortSignal | undefined
    let failureKind: TraceErrorKind | undefined

    try {
      // --- beforeRun hook ---
      if (this.config.beforeRun && callerOptions?.resumeState === undefined) {
        failureKind = 'callback'
        await this.applyBeforeRunHook(messages)
        failureKind = undefined
      }

      const backend = await this.getBackend()
      const internalOnMessage = (msg: LLMMessage) => {
        this.state.messages.push(msg)
        callerOptions?.onMessage?.(msg)
      }
      // Auto-generate trace identifiers when onTrace is provided but they are missing.
      const effectiveRunId = identity.runId
      const effectiveSpanId = callerOptions?.onTrace
        ? callerOptions.traceSpanId || generateSpanId()
        : callerOptions?.traceSpanId
      // Create a fresh timeout signal per run (not per runner) so that
      // each run() / prompt() call gets its own timeout window.
      timeoutSignal = this.config.timeoutMs !== undefined && this.config.timeoutMs > 0
        ? AbortSignal.timeout(this.config.timeoutMs)
        : undefined
      // Merge caller-provided abortSignal with the timeout signal so that
      // either cancellation source is respected.
      callerAbort = callerOptions?.abortSignal
      const effectiveAbort = timeoutSignal && callerAbort
        ? mergeAbortSignals(timeoutSignal, callerAbort)
        : timeoutSignal ?? callerAbort
      const runOptions: RunOptions = {
        ...callerOptions,
        identity,
        ...(traceRuntime ? { traceRuntime } : {}),
        ...(traceSpan ? { traceSpan } : {}),
        ...(traceRuntimeOwner ? { traceRuntimeOwner: true } : {}),
        onMessage: internalOnMessage,
        ...(effectiveRunId ? { runId: effectiveRunId } : undefined),
        ...(effectiveSpanId ? { traceSpanId: effectiveSpanId } : undefined),
        ...(effectiveAbort ? { abortSignal: effectiveAbort } : undefined),
      }
      effectiveTraceOptions = runOptions

      const result = await backend.run(messages, runOptions)
      this.state.tokenUsage = addUsage(this.state.tokenUsage, result.tokenUsage)

      if (result.suspended) {
        const suspendedResult = this.toAgentRunResult(
          result,
          false,
          undefined,
          identity,
          statusOnly('suspended', 'Durable approval required before execution can continue.'),
        )
        this.transitionTo('completed')
        this.emitAgentTrace(runOptions, agentStartMs, suspendedResult)
        return suspendedResult
      }

      if (result.budgetExceeded) {
        const budgetError = new TokenBudgetExceededError(
          this.name,
          result.tokenUsage.input_tokens + result.tokenUsage.output_tokens,
          this.config.maxTokenBudget ?? 0,
        )
        const classified = classifyRunFailure(budgetError)
        let budgetResult = this.toAgentRunResult(
          result,
          false,
          undefined,
          identity,
          classified.status,
          classified.errorInfo,
        )
        if (this.config.afterRun) {
          failureKind = 'callback'
          budgetResult = await this.config.afterRun(budgetResult)
          failureKind = undefined
        }
        budgetResult = this.ensureAgentOutcome(budgetResult, identity)
        this.transitionTo('completed')
        this.emitAgentTrace(runOptions, agentStartMs, budgetResult)
        return budgetResult
      }

      let agentResult: AgentRunResult
      if (timeoutSignal?.aborted) {
        const timeoutError = new Error(
          `Agent "${this.name}" exceeded whole-run timeout of ${this.config.timeoutMs}ms`,
        )
        timeoutError.name = 'TimeoutError'
        const classified = classifyRunFailure(timeoutError, {
          kind: 'timeout',
          statusCode: 'timeout',
        })
        agentResult = this.toAgentRunResult(
          result, false, undefined, identity, classified.status, classified.errorInfo,
        )
        agentResult = { ...agentResult, error: timeoutError }
      } else if (callerAbort?.aborted && result.aborted) {
        const abortError = new Error('Run cancelled by caller.')
        abortError.name = 'AbortError'
        const classified = classifyRunFailure(abortError)
        agentResult = this.toAgentRunResult(
          result, false, undefined, identity, classified.status, classified.errorInfo,
        )
        agentResult = { ...agentResult, error: abortError }
      } else if (this.config.outputSchema) {
        agentResult = await this.validateStructuredOutput(
          messages,
          result,
          backend,
          runOptions,
          identity,
        )

        // The schema retry uses the same whole-run signal. A backend may
        // return a late, valid response after that signal fires, so re-check
        // the deadline before reporting structured success.
        if (timeoutSignal?.aborted) {
          const timeoutError = new Error(
            `Agent "${this.name}" exceeded whole-run timeout of ${this.config.timeoutMs}ms`,
          )
          timeoutError.name = 'TimeoutError'
          const classified = classifyRunFailure(timeoutError, {
            kind: 'timeout',
            statusCode: 'timeout',
          })
          agentResult = {
            ...agentResult,
            success: false,
            status: classified.status,
            errorInfo: classified.errorInfo,
            structured: undefined,
            error: timeoutError,
          }
        } else if (callerAbort?.aborted) {
          const abortError = new Error('Run cancelled by caller.')
          abortError.name = 'AbortError'
          const classified = classifyRunFailure(abortError)
          agentResult = {
            ...agentResult,
            success: false,
            status: classified.status,
            errorInfo: classified.errorInfo,
            structured: undefined,
            error: abortError,
          }
        }
      } else {
        agentResult = this.toAgentRunResult(
          result, true, undefined, identity, statusOnly('ok'),
        )
      }

      // --- afterRun hook ---
      if (this.config.afterRun) {
        failureKind = 'callback'
        agentResult = await this.config.afterRun(agentResult)
        failureKind = undefined
      }
      agentResult = this.ensureAgentOutcome(agentResult, identity)

      this.transitionTo('completed')
      this.emitAgentTrace(runOptions, agentStartMs, agentResult)
      return agentResult
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.transitionToError(error)

      const classified = timeoutSignal?.aborted
        ? classifyRunFailure(error, { kind: 'timeout', statusCode: 'timeout' })
        : callerAbort?.aborted
          ? classifyRunFailure(error, { kind: 'cancellation', statusCode: 'cancelled' })
          : error instanceof DurableApprovalError
            ? classifyRunFailure(error, { kind: 'validation' })
          : classifyRunFailure(error, {
              ...(failureKind !== undefined ? { kind: failureKind } : {}),
              provider: this.config.provider,
            })

      const errorResult: AgentRunResult = {
        success: false,
        identity,
        status: classified.status,
        errorInfo: classified.errorInfo,
        output: error.message,
        messages: [],
        tokenUsage: ZERO_USAGE,
        toolCalls: [],
        structured: undefined,
        // Preserve the structured error (e.g. a provider APIError with `.status`)
        // so retry logic can classify it — the non-streaming path is the only
        // place this error object survives before it is stringified.
        error,
      }
      this.emitAgentTrace(effectiveTraceOptions, agentStartMs, errorResult)
      return errorResult
    }
  }

  /** Emit an `agent` trace event if `onTrace` is provided. */
  private emitAgentTrace(
    options: Partial<RunOptions> | undefined,
    startMs: number,
    result: AgentRunResult,
  ): void {
    const endMs = Date.now()
    const legacyEvent = options?.onTrace ? {
      type: 'agent',
      runId: options.runId ?? '',
      spanId: options.traceSpanId ?? generateSpanId(),
      ...(options.traceParentId ? { parentId: options.traceParentId } : {}),
      taskId: options.taskId,
      agent: options.traceAgent ?? this.name,
      turns: result.messages.filter(m => m.role === 'assistant').length,
      tokens: result.tokenUsage,
      toolCalls: result.toolCalls.length,
      startMs,
      endMs,
      durationMs: endMs - startMs,
    } as const : undefined
    if (options?.traceSpan) {
      options.traceSpan.end({
        status: result.status ?? statusOnly(result.success ? 'ok' : 'error'),
        ...(result.errorInfo ? { error: result.errorInfo } : {}),
        attributes: {
          'oma.agent.name': options.traceAgent ?? this.name,
          'oma.agent.turns': result.messages.filter(m => m.role === 'assistant').length,
          'oma.agent.tool_calls': result.toolCalls.length,
          'oma.usage.input_tokens': result.tokenUsage.input_tokens,
          'oma.usage.output_tokens': result.tokenUsage.output_tokens,
        },
        ...(legacyEvent ? { legacyEvent } : {}),
      })
      if (options.traceRuntimeOwner) {
        options.traceRuntime?.close({
          status: result.status ?? statusOnly(result.success ? 'ok' : 'error'),
          ...(result.errorInfo ? { error: result.errorInfo } : {}),
        })
      }
    } else if (legacyEvent) {
      emitTrace(options?.onTrace, legacyEvent)
    }
  }

  /**
   * Validate agent output against the configured `outputSchema`.
   * On first validation failure, retry once with error feedback.
   */
  private async validateStructuredOutput(
    originalMessages: LLMMessage[],
    result: RunResult,
    backend: AgentBackend,
    runOptions: RunOptions,
    identity: RunIdentity,
  ): Promise<AgentRunResult> {
    const schema = this.config.outputSchema!

    // First attempt
    let firstAttemptError: unknown
    try {
      const parsed = extractJSON(result.output)
      const validated = validateOutput(schema, parsed)
      this.transitionTo('completed')
      return this.toAgentRunResult(result, true, validated, identity, statusOnly('ok'))
    } catch (e) {
      firstAttemptError = e
    }

    // Retry: send full context + error feedback
    const errorMsg = firstAttemptError instanceof Error
      ? firstAttemptError.message
      : String(firstAttemptError)

    const errorFeedbackMessage: LLMMessage = {
      role: 'user' as const,
      content: [{
        type: 'text' as const,
        text: [
          'Your previous response did not produce valid JSON matching the required schema.',
          '',
          `Error: ${errorMsg}`,
          '',
          'Please try again. Respond with ONLY valid JSON, no other text.',
        ].join('\n'),
      }],
    }

    const retryMessages: LLMMessage[] = [
      ...originalMessages,
      ...result.messages,
      errorFeedbackMessage,
    ]

    const retryResult = await backend.run(retryMessages, runOptions)
    this.state.tokenUsage = addUsage(this.state.tokenUsage, retryResult.tokenUsage)

    const mergedTokenUsage = addUsage(result.tokenUsage, retryResult.tokenUsage)
    // Include the error feedback turn to maintain alternating user/assistant roles,
    // which is required by Anthropic's API for subsequent prompt() calls.
    const mergedMessages = [...result.messages, errorFeedbackMessage, ...retryResult.messages]
    const mergedToolCalls = [...result.toolCalls, ...retryResult.toolCalls]
    const mergedTokens = mergedTokenUsage.input_tokens + mergedTokenUsage.output_tokens
    const budgetExceeded = retryResult.budgetExceeded
      || (this.config.maxTokenBudget !== undefined && mergedTokens > this.config.maxTokenBudget)

    if (budgetExceeded) {
      this.transitionTo('completed')
      const budgetError = new TokenBudgetExceededError(
        this.name,
        mergedTokens,
        this.config.maxTokenBudget ?? 0,
      )
      const classified = classifyRunFailure(budgetError)
      return {
        success: false,
        identity,
        status: classified.status,
        errorInfo: classified.errorInfo,
        output: retryResult.output,
        messages: mergedMessages,
        tokenUsage: mergedTokenUsage,
        toolCalls: mergedToolCalls,
        structured: undefined,
        budgetExceeded: true,
        error: budgetError,
      }
    }

    try {
      const parsed = extractJSON(retryResult.output)
      const validated = validateOutput(schema, parsed)
      this.transitionTo('completed')
      return {
        success: true,
        identity,
        status: statusOnly('ok'),
        output: retryResult.output,
        messages: mergedMessages,
        tokenUsage: mergedTokenUsage,
        toolCalls: mergedToolCalls,
        structured: validated,
      }
    } catch (cause) {
      // Retry also failed
      this.transitionTo('completed')
      const validationError = new StructuredOutputValidationError(cause)
      const classified = classifyRunFailure(validationError, { kind: 'validation' })
      return {
        success: false,
        identity,
        status: classified.status,
        errorInfo: classified.errorInfo,
        output: retryResult.output,
        messages: mergedMessages,
        tokenUsage: mergedTokenUsage,
        toolCalls: mergedToolCalls,
        structured: undefined,
        error: validationError,
      }
    }
  }

  /**
   * Shared streaming path used by `stream`.
   * Handles state transitions and error wrapping.
   */
  private async *executeStream(messages: LLMMessage[], callerOptions?: Partial<RunOptions>): AsyncGenerator<StreamEvent> {
    this.transitionTo('running')
    const agentStartMs = Date.now()
    const identity = callerOptions?.identity ?? createRunIdentity(
      callerOptions?.runId !== undefined ? { runId: callerOptions.runId } : {},
    )
    const traceRuntime = callerOptions?.traceRuntime
      ?? createTraceRuntime(identity, callerOptions?.onTrace)
    const traceRuntimeOwner = traceRuntime !== undefined && callerOptions?.traceRuntime === undefined
    const traceSpan = traceRuntime?.startSpan({
      kind: 'agent',
      name: 'invoke_agent',
      parent: callerOptions?.traceSpan ?? traceRuntime.root,
      links: callerOptions?.traceLinks,
      attributes: {
        'oma.agent.name': callerOptions?.traceAgent ?? this.name,
        ...(callerOptions?.tracePhase ? { 'oma.phase': callerOptions.tracePhase } : {}),
        ...(callerOptions?.traceAgentAttempt !== undefined
          ? { 'oma.agent.attempt': callerOptions.traceAgentAttempt }
          : {}),
        ...(callerOptions?.taskId ? { 'oma.task.id': callerOptions.taskId } : {}),
      },
    })
    let agentTraceEmitted = false
    let effectiveTraceOptions: Partial<RunOptions> | undefined = callerOptions
    let timeoutSignal: AbortSignal | undefined
    let callerAbort: AbortSignal | undefined
    let failureKind: TraceErrorKind | undefined

    try {
      // --- beforeRun hook ---
      if (this.config.beforeRun && callerOptions?.resumeState === undefined) {
        failureKind = 'callback'
        await this.applyBeforeRunHook(messages)
        failureKind = undefined
      }

      const backend = await this.getBackend()
      // Fresh timeout per stream call, same as executeRun.
      timeoutSignal = this.config.timeoutMs !== undefined && this.config.timeoutMs > 0
        ? AbortSignal.timeout(this.config.timeoutMs)
        : undefined
      callerAbort = callerOptions?.abortSignal
      const effectiveAbort = timeoutSignal && callerAbort
        ? mergeAbortSignals(timeoutSignal, callerAbort)
        : timeoutSignal ?? callerAbort
      const effectiveRunId = identity.runId
      const effectiveSpanId = callerOptions?.onTrace
        ? callerOptions.traceSpanId || generateSpanId()
        : callerOptions?.traceSpanId
      const runOptions: RunOptions = {
        ...callerOptions,
        identity,
        ...(traceRuntime ? { traceRuntime } : {}),
        ...(traceSpan ? { traceSpan } : {}),
        ...(traceRuntimeOwner ? { traceRuntimeOwner: true } : {}),
        ...(effectiveRunId ? { runId: effectiveRunId } : undefined),
        ...(effectiveSpanId ? { traceSpanId: effectiveSpanId } : undefined),
        ...(effectiveAbort ? { abortSignal: effectiveAbort } : undefined),
      }
      effectiveTraceOptions = runOptions

      for await (const event of backend.stream(messages, runOptions)) {
        if (event.type === 'done') {
          const result = event.data as RunResult
          this.state.tokenUsage = addUsage(this.state.tokenUsage, result.tokenUsage)

          const status = result.budgetExceeded
            ? statusOnly('budget_exhausted')
            : result.suspended
              ? statusOnly('suspended', 'Durable approval required before execution can continue.')
            : timeoutSignal?.aborted
              ? statusOnly('timeout')
              : callerAbort?.aborted && result.aborted
                ? statusOnly('cancelled')
                : statusOnly('ok')
          let agentResult = this.toAgentRunResult(
            result, !result.budgetExceeded && !result.suspended, undefined, identity, status,
          )
          if (this.config.afterRun && !result.suspended) {
            failureKind = 'callback'
            agentResult = await this.config.afterRun(agentResult)
            failureKind = undefined
          }
          agentResult = this.ensureAgentOutcome(agentResult, identity)
          this.transitionTo('completed')
          this.emitAgentTrace(runOptions, agentStartMs, agentResult)
          agentTraceEmitted = true
          yield { type: 'done', data: agentResult } satisfies StreamEvent
          continue
        } else if (event.type === 'error') {
          const error = event.data instanceof Error
            ? event.data
            : new Error(String(event.data))
          // Backend stream errors originate from the configured provider. Keep
          // the source classification on the event so task retry can make an
          // explicit failover decision without reclassifying a raw Error.
          const classified = error instanceof DurableApprovalError
            ? classifyRunFailure(error, { kind: 'validation' })
            : classifyRunFailure(error, { provider: this.config.provider })
          this.transitionToError(error)
          this.emitAgentTrace(runOptions, agentStartMs, {
            success: false,
            identity,
            status: classified.status,
            errorInfo: classified.errorInfo,
            output: error.message,
            messages: [],
            tokenUsage: ZERO_USAGE,
            toolCalls: [],
            structured: undefined,
            error,
          })
          agentTraceEmitted = true
          yield { ...event, errorInfo: classified.errorInfo } satisfies StreamEvent
          continue
        }

        yield event
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.transitionToError(error)
      const classified = timeoutSignal?.aborted
        ? classifyRunFailure(error, { kind: 'timeout', statusCode: 'timeout' })
        : callerAbort?.aborted
          ? classifyRunFailure(error, { kind: 'cancellation', statusCode: 'cancelled' })
          : error instanceof DurableApprovalError
            ? classifyRunFailure(error, { kind: 'validation' })
          : classifyRunFailure(error, {
              ...(failureKind !== undefined ? { kind: failureKind } : {}),
              provider: this.config.provider,
            })
      if (!agentTraceEmitted) {
        this.emitAgentTrace(effectiveTraceOptions, agentStartMs, {
          success: false,
          identity,
          status: classified.status,
          errorInfo: classified.errorInfo,
          output: error.message,
          messages: [],
          tokenUsage: ZERO_USAGE,
          toolCalls: [],
          structured: undefined,
          error,
        })
      }
      yield { type: 'error', data: error, errorInfo: classified.errorInfo } satisfies StreamEvent
    }
  }

  // -------------------------------------------------------------------------
  // Hook helpers
  // -------------------------------------------------------------------------

  private async applyBeforeRunHook(messages: LLMMessage[]): Promise<void> {
    const hook = this.config.beforeRun
    if (!hook) return

    const hookCtx = this.buildBeforeRunHookContext(messages)
    const originalHookMessages = copyMessages(hookCtx.messages)
    const modified = await hook(hookCtx)

    if (
      this.config.backend !== undefined &&
      modified.messages !== undefined &&
      !isDeepStrictEqual(modified.messages, originalHookMessages)
    ) {
      throw new InvalidMessageError(
        `The ${this.config.backend.kind} external backend accepts beforeRun.prompt rewrites only; ` +
          'beforeRun.messages cannot be forwarded without loss.',
      )
    }

    this.applyHookContext(messages, modified, hookCtx)
  }

  /** Extract the prompt text from the last user message to build hook context. */
  private buildBeforeRunHookContext(messages: LLMMessage[]): BeforeRunHookContext {
    let prompt = ''
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        prompt = messages[i]!.content
          .filter((b): b is import('../types.js').TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('')
        break
      }
    }
    // Strip hook functions to avoid circular self-references in the context
    const { beforeRun, afterRun, ...agentInfo } = this.config
    return {
      prompt,
      messages: copyMessages(messages),
      agent: agentInfo as AgentConfig,
    }
  }

  /**
   * Apply a (possibly modified) hook context back to the messages array.
   *
   * A returned `messages` list replaces the complete run input first. A changed
   * `prompt` then replaces text blocks in the last user message; non-text blocks
   * retain their relative order. The caller's input and persistent prompt
   * history are separate defensive copies.
   */
  private applyHookContext(
    messages: LLMMessage[],
    ctx: BeforeRunHookResult,
    original: BeforeRunHookContext,
  ): void {
    if (typeof ctx.prompt !== 'string') {
      throw new InvalidMessageError('beforeRun.prompt must be a string')
    }

    if (ctx.messages !== undefined) {
      assertValidMessages(ctx.messages)
      messages.splice(0, messages.length, ...copyMessages(ctx.messages))
    }

    if (ctx.prompt === original.prompt) return

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        const content = messages[i]!.content
        const firstTextIndex = content.findIndex((block) => block.type === 'text')
        const replacement = { type: 'text' as const, text: ctx.prompt }
        const rewritten = firstTextIndex === -1
          ? [replacement, ...content]
          : content.reduce<ContentBlock[]>((blocks, block, index) => {
              if (block.type !== 'text') blocks.push(block)
              else if (index === firstTextIndex) blocks.push(replacement)
              return blocks
            }, [])
        messages[i] = {
          role: 'user',
          content: rewritten,
        }
        break
      }
    }
  }

  // -------------------------------------------------------------------------
  // State transition helpers
  // -------------------------------------------------------------------------

  private transitionTo(status: 'idle' | 'running' | 'completed' | 'error'): void {
    this.state = { ...this.state, status }
  }

  private transitionToError(error: Error): void {
    this.state = { ...this.state, status: 'error', error }
  }

  // -------------------------------------------------------------------------
  // Result mapping
  // -------------------------------------------------------------------------

  private toAgentRunResult(
    result: RunResult,
    success: boolean,
    structured?: unknown,
    identity: RunIdentity = result.identity ?? createRunIdentity(),
    status: RunStatus = statusOnly(success ? 'ok' : 'error'),
    errorInfo?: AgentRunResult['errorInfo'],
  ): AgentRunResult {
    return {
      success,
      identity,
      status,
      ...(errorInfo !== undefined ? { errorInfo } : {}),
      output: result.output,
      messages: result.messages,
      tokenUsage: result.tokenUsage,
      toolCalls: result.toolCalls,
      structured,
      ...(result.loopDetected ? { loopDetected: true } : {}),
      ...(result.budgetExceeded ? { budgetExceeded: true } : {}),
      ...(result.pendingApprovals ? { pendingApprovals: result.pendingApprovals } : {}),
    }
  }

  /** Restore runtime-required outcome fields after compatibility hooks run. */
  private ensureAgentOutcome(result: AgentRunResult, identity: RunIdentity): AgentRunResult {
    let status = result.status
    let errorInfo = result.errorInfo
    if (result.budgetExceeded) {
      const budgetError = new TokenBudgetExceededError(
        this.name,
        result.tokenUsage.input_tokens + result.tokenUsage.output_tokens,
        this.config.maxTokenBudget ?? 0,
      )
      const classified = classifyRunFailure(budgetError)
      status = classified.status
      errorInfo = errorInfo ?? classified.errorInfo
    } else if (result.success && status?.code !== 'ok') {
      status = statusOnly('ok')
      errorInfo = undefined
    } else if (!result.success && (status === undefined || status.code === 'ok')) {
      status = statusOnly('error', result.output)
    }
    status ??= statusOnly(result.success ? 'ok' : 'error', result.success ? undefined : result.output)
    return {
      ...result,
      success: status.code === 'ok',
      identity,
      status,
      ...(errorInfo !== undefined ? { errorInfo } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // ToolUseContext builder (for direct use by subclasses or advanced callers)
  // -------------------------------------------------------------------------

  /**
   * Build a {@link ToolUseContext} that identifies this agent.
   * Exposed so team orchestrators can inject richer context (e.g. `TeamInfo`).
   */
  buildToolContext(abortSignal?: AbortSignal): ToolUseContext {
    return {
      agent: {
        name: this.name,
        role: this.config.systemPrompt?.slice(0, 60) ?? 'assistant',
        model: this.config.model!,
      },
      abortSignal,
      ...(this.config.shellExecutor !== undefined
        ? { shellExecutor: this.config.shellExecutor }
        : {}),
      cwd: this.config.cwd === undefined ? defaultWorkspaceDir() : this.config.cwd,
      ...(this.config.credentials !== undefined ? { credentials: this.config.credentials } : {}),
    }
  }
}
