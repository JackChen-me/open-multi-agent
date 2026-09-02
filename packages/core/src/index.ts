/**
 * @fileoverview open-multi-agent — public API surface.
 *
 * Import from `'@open-multi-agent/core'` to access everything you need:
 *
 * ```ts
 * import { OpenMultiAgent, Agent, Team, defineTool } from '@open-multi-agent/core'
 * ```
 *
 * ## Quickstart
 *
 * ### Single agent
 * ```ts
 * const orchestrator = new OpenMultiAgent({ defaultModel: 'claude-opus-4-6' })
 * const result = await orchestrator.runAgent(
 *   { name: 'assistant', model: 'claude-opus-4-6' },
 *   'Explain monads in one paragraph.',
 * )
 * console.log(result.output)
 * ```
 *
 * ### Multi-agent team (auto-orchestrated)
 * ```ts
 * const orchestrator = new OpenMultiAgent()
 * const team = orchestrator.createTeam('writers', {
 *   name: 'writers',
 *   agents: [
 *     { name: 'researcher', model: 'claude-opus-4-6', systemPrompt: 'You research topics thoroughly.' },
 *     { name: 'writer',     model: 'claude-opus-4-6', systemPrompt: 'You write clear documentation.' },
 *   ],
 *   sharedMemory: true,
 * })
 * const result = await orchestrator.runTeam(team, 'Write a guide on TypeScript generics.')
 * console.log(result.agentResults.get('coordinator')?.output)
 * ```
 *
 * ### Custom tools
 * ```ts
 * import { z } from 'zod'
 *
 * const myTool = defineTool({
 *   name: 'fetch_data',
 *   description: 'Fetch JSON data from a URL.',
 *   inputSchema: z.object({ url: z.string().url() }),
 *   execute: async ({ url }) => {
 *     const res = await fetch(url)
 *     return { data: await res.text() }
 *   },
 * })
 * ```
 */

// ---------------------------------------------------------------------------
// Orchestrator (primary entry point)
// ---------------------------------------------------------------------------

export {
  OpenMultiAgent,
  DeterministicRouter,
  executeWithRetry,
  computeRetryDelay,
} from './orchestrator/orchestrator.js'
export {
  evaluateSemanticRoutingPolicy,
  HYBRID_ROUTER_VERSION,
  LLMTaskProfiler,
  taskProfileSchema,
  TaskProfileValidationError,
  validateTaskProfilerResult,
} from './orchestrator/task-profiler.js'
export type {
  ExecutionRouter,
  ExecutionRoutingDecisionRecord,
  ExecutionRoutingDecisionSource,
  RoutingBudget,
  RoutingContext,
  RoutingDecision,
  RoutingDecisionStatus,
  RoutingFallbackCode,
  RosterSummaryEntry,
} from './orchestrator/execution-router.js'
export {
  evaluateGovernance,
  GOVERNANCE_OVERRIDDEN_FLAG,
  REVIEW_SKIPPED_DUE_TO_BUDGET_FLAG,
} from './orchestrator/governance.js'
export type { GovernanceDeclaration } from './orchestrator/governance.js'
export { CONSEQUENTIAL_NO_INDEPENDENCE_FLAG } from './orchestrator/consequential.js'
export {
  Scheduler,
  DEFAULT_SCHEDULING_WEIGHTS,
} from './orchestrator/scheduler.js'
export type {
  SchedulingStrategy,
  SchedulingWeights,
  SchedulerOptions,
  SchedulerWarning,
} from './orchestrator/scheduler.js'
export {
  AgentSelector,
  validateTaskRequirements,
} from './orchestrator/agent-selector.js'
export type {
  AgentSelectionFailure,
  AgentSelectionResult,
  AgentSelectionSubject,
  AgentSelectorContext,
  EligibleAgentScore,
} from './orchestrator/agent-selector.js'

export { renderTeamRunDashboard } from './dashboard/render-team-run-dashboard.js'
export { renderRunViewer } from './dashboard/render-run-viewer.js'
export { RunViewerInputError, buildRunViewerModel } from './dashboard/run-viewer-model.js'
export type {
  RunViewerDagLayout,
  RunViewerEvent,
  RunViewerFact,
  RunViewerInput,
  RunViewerInputErrorCode,
  RunViewerLink,
  RunViewerModel,
  RunViewerRoutingSummary,
  RunViewerOptions,
  RunViewerSourceMode,
  RunViewerSpan,
  RunViewerStatus,
  RunViewerSummary,
  RunViewerTask,
  RunViewerWarning,
} from './dashboard/run-viewer-model.js'

// ---------------------------------------------------------------------------
// Agent layer
// ---------------------------------------------------------------------------

export { Agent } from './agent/agent.js'
// The execution seam behind every Agent. `AgentRunner` (the LLM loop) implements
// it; the ACP backend (`@open-multi-agent/core/acp`) is an alternative impl.
export type { AgentBackend, RunOptions, RunResult } from './agent/runner.js'
export { LoopDetector } from './agent/loop-detector.js'
export { buildStructuredOutputInstruction, extractJSON, validateOutput } from './agent/structured-output.js'
export { AgentPool, Semaphore } from './agent/pool.js'
export type { PoolStatus } from './agent/pool.js'

// ---------------------------------------------------------------------------
// Team layer
// ---------------------------------------------------------------------------

export { Team } from './team/team.js'
export { MessageBus } from './team/messaging.js'
export type { Message } from './team/messaging.js'

// ---------------------------------------------------------------------------
// Task layer
// ---------------------------------------------------------------------------

export { TaskQueue } from './task/queue.js'
export { createTask, isTaskReady, getTaskDependencyOrder, validateTaskDependencies } from './task/task.js'
export type { TaskQueueEvent } from './task/queue.js'

// ---------------------------------------------------------------------------
// Tool system
// ---------------------------------------------------------------------------

export { defineTool, ToolRegistry, zodToJsonSchema } from './tool/framework.js'
export { ToolExecutor, truncateToolOutput } from './tool/executor.js'
export type { ToolExecutorExecutionOptions, ToolExecutorOptions, BatchToolCall } from './tool/executor.js'
export { LocalShellExecutor } from './tool/shell/local.js'
export type {
  ShellExecOptions,
  ShellExecResult,
  ShellExecutor,
} from './tool/shell/types.js'
export {
  registerBuiltInTools,
  BUILT_IN_TOOLS,
  ALL_BUILT_IN_TOOLS_WITH_DELEGATE,
  bashTool,
  delegateToAgentTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  globTool,
  grepTool,
} from './tool/built-in/index.js'
export type { RegisterBuiltInToolsOptions } from './tool/built-in/index.js'

// ---------------------------------------------------------------------------
// LLM adapters
// ---------------------------------------------------------------------------

export { createAdapter } from './llm/adapter.js'
export type { SupportedProvider } from './llm/adapter.js'
export {
  TokenBudgetExceededError,
  CostBudgetExceededError,
  InvalidMessageError,
  JournalLineageError,
  StructuredOutputValidationError,
  InvalidTaskRequirementsError,
  LLMCallTimeoutError,
  UnsupportedToolCallError,
  UnsupportedToolResultContentError,
  RoutingDeclarationRequiredError,
  RoutingProfilerFailedError,
  RoutingTimeoutError,
  EgressPolicyError,
  isRetryableError,
} from './errors.js'
export { createRunIdentity, createRestoreIdentity, validateRunId } from './observability/identity.js'
export { classifyRunFailure } from './observability/status.js'
export type {
  SpanEndRecord,
  SpanEventName,
  SpanEventRecord,
  SpanKind,
  SpanStartRecord,
  TraceRecord,
  TraceRecordBase,
} from './observability/records.js'
export {
  BatchingTraceSink,
  CompositeSink,
  DEFAULT_BATCHING_OPTIONS,
  DiagnosticReporter,
  FilteringSink,
  InMemoryTraceStore,
  LegacyCallbackTraceSink,
  SensitiveDataProcessor,
  TRACE_STORE_SCHEMA_MAJOR,
  TraceStoreError,
  TraceStoreExporter,
  buildExecutionReceipt,
  emptyTraceSinkStats,
  materializeRun,
} from './observability/index.js'
export type {
  AppendResult,
  BatchingTraceSinkOptions,
  DeleteResult,
  DiagnosticMode,
  DiagnosticOptions,
  ExportResult,
  ExecutionReceipt,
  ExecutionReceiptApprovalDecision,
  ExecutionReceiptDependencyEdge,
  FlushOptions,
  FlushResult,
  GetRunOptions,
  InMemoryTraceStoreOptions,
  MaterializedSpan,
  ObservabilityConfig,
  ObservabilityResource,
  Page,
  RetentionPolicy,
  RunAttemptSummary,
  RunCostSummary,
  RunSummary,
  RunTokenSummary,
  SensitiveDataProcessorOptions,
  TelemetryDiagnostic,
  TelemetryDiagnosticCode,
  TraceCapturePolicy,
  TraceDeleteQuery,
  TraceExporter,
  TraceFilter,
  TraceQuery,
  TraceSink,
  TraceSinkStats,
  TraceStore,
  TraceStoreDiagnostic,
  TraceStoreDiagnosticCode,
  TraceStoreErrorCode,
  StoredRun,
} from './observability/index.js'

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export { InMemoryStore } from './memory/store.js'
export { FileStore } from './memory/file-store.js'
export { RedactingStore } from './memory/redacting-store.js'
export type { RedactingStoreOptions } from './memory/redacting-store.js'
export { SharedMemory } from './memory/shared.js'
export {
  APPROVAL_KEY_PREFIX,
  DurableApprovalError,
  DurableApprovalLedger,
  approvalKey,
  createApprovalRequest,
  decideApproval,
  getApprovalRecord,
  hashApprovalRequest,
} from './approval/durable.js'
export type {
  CreateApprovalRequestInput,
  DurableApprovalErrorCode,
} from './approval/durable.js'
export {
  Checkpoint,
  CHECKPOINT_KEY_PREFIX,
  DEFAULT_CHECKPOINT_KEY,
  checkpointKey,
  isCheckpointKey,
} from './memory/checkpoint.js'

// ---------------------------------------------------------------------------
// Run journal
// ---------------------------------------------------------------------------

export { InMemoryRunJournal, resolveRunJournal } from './journal/journal.js'
export { JsonlRunJournal } from './journal/jsonl-journal.js'
export { canonicalContentHash, canonicalJsonHash } from './journal/hash.js'
export { isMessageEvent, isRunEvent, RUN_EVENT_TYPES } from './journal/events.js'
export { verifyRun } from './journal/verify.js'
export type {
  InMemoryRunJournalOptions,
  ResolvedRunJournal,
  RunJournal,
  RunJournalConfig,
  RunJournalOptions,
} from './journal/journal.js'
export type { JsonlRunJournalOptions } from './journal/jsonl-journal.js'
export type {
  ApprovalDecisionEvent,
  ApprovalRequestEvent,
  AssistantMessageEvent,
  CheckpointSavedEvent,
  ContextReplaceEvent,
  ContextReplacement,
  ContextStrategyKind,
  LLMRequestEvent,
  MemorySetEvent,
  PlanSetEvent,
  PlanSetTask,
  RequestBlockDescriptor,
  RunEndEvent,
  RunEvent,
  RunEventBase,
  RunJournalMode,
  RunStartEvent,
  TaskStatusEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnOutcome,
  TurnStartEvent,
  UserMessageEvent,
} from './journal/events.js'
export type {
  VerifyRunFailure,
  VerifyRunFailureCode,
  VerifyRunFailureReason,
  VerifyRunGap,
  VerifyRunResult,
  VerifyRunStats,
} from './journal/verify.js'

// ---------------------------------------------------------------------------
// Types — all public interfaces re-exported for consumer type-checking
// ---------------------------------------------------------------------------

export type {
  // Content blocks
  ReasoningBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolResultContent,
  ToolResultContentPart,
  ToolResultFilePart,
  ToolResultImagePart,
  ToolResultMediaSource,
  ToolResultTextPart,
  ImageBlock,
  VideoBlock,
  ContentBlock,

  // LLM
  LLMMessage,
  LLMResponse,
  LLMAdapter,
  LLMChatOptions,
  LLMStreamOptions,
  LLMToolDef,
  TokenUsage,
  StreamEvent,
  EgressPolicy,

  // Tools
  ToolDefinition,
  ToolResult,
  ToolResultMetadata,
  ToolUseContext,
  ToolCallContext,
  ToolCallDecision,
  ToolCallGate,
  ToolCallGateMetadata,
  AgentInfo,
  TeamInfo,
  DelegationPoolView,

  // Agent
  AgentConfig,
  AgentPromptInput,
  AgentRunInput,
  AgentState,
  AgentRunResult,
  RunAgentOptions,
  RunIdentity,
  RunIdentityLink,
  TraceLink,
  TraceAttributeValue,
  RunIdentityOptions,
  RunStatus,
  RunStatusCode,
  RunFlag,
  RunOutcomeFields,
  ApprovalScope,
  ApprovalRequestContent,
  PlanApprovalContent,
  TaskRoundApprovalContent,
  TaskDispatchApprovalContent,
  ToolCallApprovalContent,
  ApprovalRequest,
  ApprovalReviewer,
  ApprovalDecisionRecord,
  ApprovalRecord,
  ApprovalDecisionInput,
  ApprovalGateDecision,
  StructuredTraceError,
  TraceErrorKind,
  AgentBackendConfig,
  ExternalAgentBackendConfig,
  AcpAgentBackendConfig,
  AcpPermissionPolicy,
  AcpPermissionRequest,
  ProcessAgentBackendConfig,
  ProcessBackendInputMode,
  BeforeRunHookContext,
  BeforeRunHookResult,
  ToolCallRecord,
  LoopDetectionConfig,
  LoopDetectionInfo,
  ContextStrategy,
  ThinkingConfig,

  // Team
  TeamConfig,
  TeamRunResult,
  GovernanceConclusion,
  GovernanceUnsatisfiedReason,
  RunMetrics,
  RunTeamOptions,
  ExecutionRoutingConfig,
  ExecutionRoutingStrategy,
  RoutingFailurePolicy,
  SemanticRoutingAssessment,
  SemanticRoutingOutcome,
  SemanticRoutingRecommendation,
  TaskProfile,
  TaskProfiler,
  TaskProfilerContext,
  TaskProfilerResult,
  RunTasksOptions,
  RunTaskSpec,
  PlanPatchTaskSpec,
  PlanPatchRetarget,
  PlanPatch,
  PlanRevision,
  TaskVerificationOutcome,
  TaskOutcome,
  Replanner,
  RecoveryOptions,
  TaskMetadata,
  TaskRequirementIssue,
  TaskRequirements,
  RestoreOptions,
  ModelRouteConfig,
  ModelRoutingMatch,
  ModelRoutingRule,
  ModelRoutingPolicy,
  PlanArtifact,
  PlanTaskArtifact,

  // Consensus
  ConsensusOptions,
  ConsensusVerifyOptions,
  ConsensusResult,

  // Dashboard (static HTML)
  TaskExecutionMetrics,
  TaskExecutionRecord,

  // Task
  Task,
  TaskStatus,

  // Orchestrator
  OrchestratorConfig,
  OrchestratorEvent,
  CoordinatorConfig,
  CostEstimateContext,
  CheckpointOptions,
  CheckpointSnapshot,
  CheckpointSnapshotV1,
  CheckpointSnapshotV2,
  CheckpointSnapshotV3,
  CheckpointSnapshotV4,
  CheckpointSnapshotV5,
  CheckpointRunIdentity,
  RunJournalRef,
  CompletedTaskCheckpoint,
  InFlightTaskCheckpoint,
  PendingToolCallCheckpoint,
  ToolCallCommitCheckpoint,
  TaskQueueSnapshot,
  TaskQueueSnapshotV1,
  TaskQueueSnapshotV2,
  TaskSnapshot,
  MessageBusSnapshot,
  MessageSnapshot,
  MessageReadStateSnapshot,

  // Trace
  TraceEventType,
  TraceEventBase,
  TraceEvent,
  LLMCallTrace,
  ToolCallTrace,
  TaskTrace,
  AgentTrace,
  PlanReadyTrace,
  AgentStreamTrace,
  ConsensusTrace,
  RoutingDecisionTrace,

  // Memory
  MemoryEntry,
  MemoryStore,
  MemoryEntrySnapshot,
  SharedMemorySnapshot,
  SharedMemoryEntry,
  SharedMemoryValue,
  SharedMemoryWriteOptions,
} from './types.js'

export { generateRunId, generateSpanId } from './utils/trace.js'
