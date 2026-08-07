/**
 * Parallel tool executor with concurrency control and error isolation.
 *
 * Validates input via Zod schemas, optionally validates tool output via
 * `tool.outputSchema`, enforces a maximum concurrency limit using a lightweight
 * semaphore, and surfaces any execution errors as ToolResult objects rather
 * than thrown exceptions.
 *
 * Types are imported from `../types` to ensure consistency with the rest of
 * the framework.
 */

import type {
  ApprovalDecisionRecord,
  ApprovalRequest,
  ToolCallApprovalContent,
  ToolCallGate,
  ToolCallGateMetadata,
  ToolResult,
  ToolResultMetadata,
  ToolUseContext,
} from '../types.js'
import type { ToolDefinition } from '../types.js'
import { ToolRegistry } from './framework.js'
import { Semaphore } from '../utils/semaphore.js'
import type { ZodSchema } from 'zod'
import {
  assertApprovalDecision,
  assertApprovalRequest,
  hashApprovalRequest,
} from '../approval/durable.js'

// ---------------------------------------------------------------------------
// ToolExecutor
// ---------------------------------------------------------------------------

export interface ToolExecutorOptions {
  /**
   * Maximum number of tool calls that may run in parallel.
   * Defaults to 4.
   */
  maxConcurrency?: number
  /**
   * Agent-level default for maximum tool output length in characters.
   * Per-tool `maxOutputChars` takes priority over this value.
   */
  maxToolOutputChars?: number
  /**
   * Optional per-call gate. Runs after input validation and before execution.
   * Returning `{ action: 'deny' }` produces an error ToolResult instead of
   * invoking the tool implementation.
   */
  onToolCall?: ToolCallGate
}

export interface ToolExecutorExecutionOptions {
  /** Per-execution gate override. Takes priority over the constructor option. */
  readonly onToolCall?: ToolCallGate
  /** Previously reviewed invocation supplied by checkpoint restore. */
  readonly durableApproval?: {
    readonly request: ApprovalRequest
    readonly decision: ApprovalDecisionRecord
  }
}

/** Describes one call in a batch. */
export interface BatchToolCall {
  /** Caller-assigned ID used as the key in the result map. */
  id: string
  /** Registered tool name. */
  name: string
  /** Raw (unparsed) input object from the LLM. */
  input: Record<string, unknown>
}

/**
 * Executes tools from a {@link ToolRegistry}, validating input against each
 * tool's Zod schema and enforcing a concurrency limit for batch execution.
 *
 * All errors — including unknown tool names, Zod validation failures, and
 * execution exceptions — are caught and returned as `ToolResult` objects with
 * `isError: true` so the agent runner can forward them to the LLM.
 */
export class ToolExecutor {
  private readonly registry: ToolRegistry
  private readonly semaphore: Semaphore
  private readonly maxToolOutputChars?: number
  private readonly onToolCall?: ToolCallGate

  constructor(registry: ToolRegistry, options: ToolExecutorOptions = {}) {
    this.registry = registry
    this.semaphore = new Semaphore(options.maxConcurrency ?? 4)
    this.maxToolOutputChars = options.maxToolOutputChars
    this.onToolCall = options.onToolCall
  }

  // -------------------------------------------------------------------------
  // Single execution
  // -------------------------------------------------------------------------

  /**
   * Execute a single tool by name.
   *
   * Errors are caught and returned as a {@link ToolResult} with
   * `isError: true` — this method itself never rejects.
   *
   * @param toolName  The registered tool name.
   * @param input     Raw input object (before Zod validation).
   * @param context   Execution context forwarded to the tool.
   */
  async execute(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolUseContext,
    options: ToolExecutorExecutionOptions = {},
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolName)
    if (tool === undefined) {
      return this.errorResult(
        `Tool "${toolName}" is not registered in the ToolRegistry.`,
      )
    }

    // Check abort before even starting
    if (context.abortSignal?.aborted === true) {
      return this.errorResult(
        `Tool "${toolName}" was aborted before execution began.`,
      )
    }

    return this.runTool(tool, input, context, options)
  }

  // -------------------------------------------------------------------------
  // Batch execution
  // -------------------------------------------------------------------------

  /**
   * Execute multiple tool calls in parallel, honouring the concurrency limit.
   *
   * Returns a `Map` from call ID to result.  Every call in `calls` is
   * guaranteed to produce an entry — errors are captured as results.
   *
   * @param calls    Array of tool calls to execute.
   * @param context  Shared execution context for all calls in this batch.
   */
  async executeBatch(
    calls: BatchToolCall[],
    context: ToolUseContext,
  ): Promise<Map<string, ToolResult>> {
    const results = new Map<string, ToolResult>()

    await Promise.all(
      calls.map(async (call) => {
        const result = await this.semaphore.run(() =>
          this.execute(call.name, call.input, context),
        )
        results.set(call.id, result)
      }),
    )

    return results
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Validate input with the tool's Zod schema, then call `execute`.
   *
   * When `tool.outputSchema` is configured and the tool returned a
   * **non-error** result, `result.data` is validated against the schema
   * before truncation is applied. Error results are forwarded as-is so the
   * LLM still sees the original failure message.
   *
   * Any synchronous or asynchronous error thrown by the tool is caught and
   * turned into an error {@link ToolResult} instead of propagating.
   */
  private async runTool(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: ToolDefinition<any>,
    rawInput: Record<string, unknown>,
    context: ToolUseContext,
    options: ToolExecutorExecutionOptions,
  ): Promise<ToolResult> {
    // --- Zod validation ---
    const inputParseResult = this.runZodSchema(tool.inputSchema, rawInput)
    if (!inputParseResult.success) {
      return this.errorResult(
        `Invalid input for tool "${tool.name}":\n${inputParseResult.issuesMessage}`,
        options.durableApproval
          ? { approvalError: 'The current tool schema no longer accepts the reviewed input.' }
          : undefined,
      )
    }

    // --- Abort check after parse (parse can be expensive for large inputs) ---
    if (this.isAbortSignalAborted(context.abortSignal)) {
      return this.errorResult(
        `Tool "${tool.name}" was aborted before execution began.`,
      )
    }

    const approvalContent = this.approvalContent(
      tool.name,
      rawInput,
      inputParseResult.data as Record<string, unknown>,
      tool.consequential === true,
      context,
    )
    const restoredApproval = options.durableApproval
    const gate = options.onToolCall ?? this.onToolCall
    let gateMetadata: ToolCallGateMetadata | undefined
    let approvalDecision: ApprovalDecisionRecord | undefined
    if (restoredApproval) {
      try {
        assertApprovalRequest(restoredApproval.request)
        assertApprovalDecision(restoredApproval.decision, restoredApproval.request)
        if (!approvalContent) {
          throw new Error('Current tool context has no task/tool-call identity.')
        }
        const currentHash = hashApprovalRequest(
          'tool_call',
          restoredApproval.request.boundary,
          approvalContent,
        )
        if (currentHash !== restoredApproval.request.requestHash) {
          throw new Error('Current validated tool invocation differs from the reviewed content.')
        }
      } catch (error) {
        return this.errorResult(
          `Tool "${tool.name}" durable approval is stale or tampered: ${this.errorMessage(error)}`,
          { approvalError: this.errorMessage(error) },
        )
      }
      approvalDecision = restoredApproval.decision
      if (approvalDecision.decision === 'rejected') {
        gateMetadata = {
          action: 'deny',
          reason: `Rejected by durable reviewer "${approvalDecision.reviewer.id}".`,
        }
        return this.errorResult(`Tool "${tool.name}" denied by durable approval.`, {
          toolCallGate: gateMetadata,
          approvalDecision,
        })
      }
      gateMetadata = { action: 'allow' }
    } else if (gate) {
      let decision: unknown
      try {
        decision = await gate({
          toolName: tool.name,
          input: inputParseResult.data as Record<string, unknown>,
          agentName: context.agent.name,
          ...(tool.consequential === true ? { consequential: true } : {}),
          ...(context.runId !== undefined ? { runId: context.runId } : {}),
          ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
          ...(context.toolCallId !== undefined ? { toolCallId: context.toolCallId } : {}),
        })
      } catch (err) {
        return this.errorResult(`Tool "${tool.name}" onToolCall hook threw an error: ${this.errorMessage(err)}`)
      }
      gateMetadata = this.gateMetadataFromDecision(decision)
      if (!gateMetadata) {
        return this.errorResult(
          `Tool "${tool.name}" onToolCall hook returned an invalid onToolCall decision.`,
        )
      }
      if (this.isAbortSignalAborted(context.abortSignal)) {
        return this.errorResult(
          `Tool "${tool.name}" was aborted before execution began.`,
          { toolCallGate: gateMetadata },
        )
      }
      if (gateMetadata.action === 'deny') {
        const suffix = gateMetadata.reason ? `: ${gateMetadata.reason}` : '.'
        return this.errorResult(`Tool "${tool.name}" denied by onToolCall${suffix}`, {
          toolCallGate: gateMetadata,
        })
      }
      if (gateMetadata.action === 'suspend') {
        if (!approvalContent) {
          return this.errorResult(
            `Tool "${tool.name}" cannot suspend outside an orchestrated checkpointed task.`,
            { toolCallGate: gateMetadata },
          )
        }
        return this.errorResult(`Tool "${tool.name}" is awaiting durable approval.`, {
          toolCallGate: gateMetadata,
          approvalRequestContent: approvalContent,
        })
      }
    }

    // --- Execute ---
    try {
      const result = await tool.execute(inputParseResult.data, context)
      if (!result.isError && tool.outputSchema) {
        const outputParseResult = this.runZodSchema(tool.outputSchema, result.data)
        if (!outputParseResult.success) {
          return this.errorResult(
            `Invalid output for tool "${tool.name}":\n${outputParseResult.issuesMessage}`,
            gateMetadata ? { toolCallGate: gateMetadata } : undefined,
          )
        }
      }
      const withApproval = approvalDecision === undefined
        ? result
        : {
            ...result,
            metadata: { ...result.metadata, approvalDecision },
          }
      return this.withGateMetadata(this.maybeTruncate(tool, withApproval), gateMetadata)
    } catch (err) {
      return this.maybeTruncate(
        tool,
        this.errorResult(`Tool "${tool.name}" threw an error: ${this.errorMessage(err)}`, gateMetadata
          ? { toolCallGate: gateMetadata }
          : undefined),
      )
    }
  }

  /** Run a Zod schema and return a flattened issue string on failure. */
  private runZodSchema<T>(schema: ZodSchema<T>, rawInput: T) {
    const parseResult = schema.safeParse(rawInput)
    if (!parseResult.success) {
      const issuesMessage = parseResult.error.issues
        .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')
      return {
        ...parseResult,
        issuesMessage,
      }
    }
    return parseResult
  }

  /**
   * Apply truncation to a tool result if a character limit is configured.
   * Priority: per-tool `maxOutputChars` > agent-level `maxToolOutputChars`.
   */
  private maybeTruncate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: ToolDefinition<any>,
    result: ToolResult,
  ): ToolResult {
    const maxChars = tool.maxOutputChars ?? this.maxToolOutputChars
    if (maxChars === undefined || maxChars <= 0 || result.data.length <= maxChars) {
      return result
    }
    return { ...result, data: truncateToolOutput(result.data, maxChars) }
  }

  private withGateMetadata(result: ToolResult, gateMetadata: ToolCallGateMetadata | undefined): ToolResult {
    if (!gateMetadata) return result
    return {
      ...result,
      metadata: {
        ...result.metadata,
        toolCallGate: gateMetadata,
      },
    }
  }

  private gateMetadataFromDecision(decision: unknown): ToolCallGateMetadata | undefined {
    if (decision === null || typeof decision !== 'object') return undefined
    const action = (decision as { readonly action?: unknown }).action
    if (action !== 'allow' && action !== 'deny' && action !== 'suspend') return undefined
    const reason = (decision as { readonly reason?: unknown }).reason
    if (reason !== undefined && typeof reason !== 'string') return undefined
    if ((action === 'deny' || action === 'suspend') && reason !== undefined) {
      return { action, reason }
    }
    return { action }
  }

  private isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : JSON.stringify(err)
  }

  private approvalContent(
    toolName: string,
    rawInput: Record<string, unknown>,
    input: Record<string, unknown>,
    consequential: boolean,
    context: ToolUseContext,
  ): ToolCallApprovalContent | undefined {
    if (!context.taskId || !context.toolCallId) return undefined
    return {
      kind: 'tool_call',
      toolName,
      rawInput,
      input,
      agentName: context.agent.name,
      taskId: context.taskId,
      toolCallId: context.toolCallId,
      consequential,
    }
  }

  /** Construct an error ToolResult. */
  private errorResult(message: string, metadata?: ToolResultMetadata): ToolResult {
    return {
      data: message,
      isError: true,
      ...(metadata ? { metadata } : {}),
    }
  }
}

// ---------------------------------------------------------------------------
// Truncation helper
// ---------------------------------------------------------------------------

/**
 * Truncate tool output to fit within `maxChars`, preserving the head (~70%)
 * and tail (~30%) with a marker indicating how many characters were removed.
 *
 * The marker itself is counted against the budget so the returned string
 * never exceeds `maxChars`. When `maxChars` is too small to fit any
 * content alongside the marker, a marker-only string is returned.
 */
export function truncateToolOutput(data: string, maxChars: number): string {
  if (data.length <= maxChars) return data

  // Estimate marker length (digit count may shrink after subtracting content,
  // but using data.length gives a safe upper-bound for the digit count).
  const markerTemplate = '\n\n[...truncated  characters...]\n\n'
  const markerOverhead = markerTemplate.length + String(data.length).length

  // When maxChars is too small to fit any content alongside the marker,
  // fall back to a hard slice so the result never exceeds maxChars.
  if (maxChars <= markerOverhead) {
    return data.slice(0, maxChars)
  }

  const available = maxChars - markerOverhead
  const headChars = Math.floor(available * 0.7)
  const tailChars = available - headChars
  const truncatedCount = data.length - headChars - tailChars

  return `${data.slice(0, headChars)}\n\n[...truncated ${truncatedCount} characters...]\n\n${data.slice(-tailChars)}`
}
