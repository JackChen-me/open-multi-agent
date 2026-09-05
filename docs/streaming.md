# Streaming

This page answers three questions: which APIs hand back incremental output
instead of one final result, what each `StreamEvent` carries and when it is
emitted, and which execution paths produce no stream at all.

One thing to settle first, because it changes what "streaming" means here.
The agent loop calls `adapter.chat()`, never `adapter.stream()`
(`packages/core/src/agent/runner.ts`, `chatWithCallTimeout`). Agent-level
streaming is therefore **turn-granular**: you see a turn's text as soon as that
turn's model call returns, plus each tool call and each tool result as they
happen. Token-by-token deltas exist one layer down, on the adapter itself.

## Streaming surfaces

| Surface | Shape | Granularity | `done` payload |
|---|---|---|---|
| `Agent.stream(input, runOptions?)` | `AsyncGenerator<StreamEvent>` | Per turn and per tool call | `AgentRunResult` |
| `OrchestratorConfig.onAgentStream` | `(agentName, event) => void` | Same events, pushed | `AgentRunResult` |
| `AgentBackend.stream(messages, options?)` | `AsyncIterable<StreamEvent>` | Backend-defined | `RunResult` |
| `LLMAdapter.stream(messages, options)` | `AsyncIterable<StreamEvent>` | Provider deltas | `LLMResponse` |

`AgentRunner` implements `AgentBackend`, and so do the process and ACP
backends, which is why the pool, scheduler, and budget accounting treat all
three identically. `Agent.stream()` wraps whichever backend the agent resolved
and replaces the runner's `RunResult` with an `AgentRunResult` on the `done`
event.

**`OpenMultiAgent.runAgent()` has no streaming form.** It always awaits a
single `AgentRunResult`, and it does not invoke `onAgentStream`. For a one-shot
streamed agent, construct an `Agent` directly.

```typescript
import {
  Agent,
  ToolExecutor,
  ToolRegistry,
  type AgentRunResult,
} from '@open-multi-agent/core'

const registry = new ToolRegistry()
const agent = new Agent(
  { name: 'explainer', provider: 'anthropic', model: 'claude-sonnet-4-6' },
  registry,
  new ToolExecutor(registry),
)

for await (const event of agent.stream('Explain generic constraints briefly.')) {
  if (event.type === 'text' && typeof event.data === 'string') {
    process.stdout.write(event.data)
  } else if (event.type === 'done') {
    const result = event.data as AgentRunResult
    console.log('\ntool calls:', result.toolCalls.length, 'tokens:', result.tokenUsage)
  } else if (event.type === 'error') {
    console.error('stream failed:', event.data)
  }
}
```

`stream()` is not `async`: input validation runs when you call it, before the
returned iterator produces anything. An invalid `LLMMessage[]` throws
`InvalidMessageError` at the call site rather than on the first `next()`. See
[structured agent input](structured-input.md#copying-and-validation).
A runnable version is [`basics/single-agent`](../packages/core/examples/basics/single-agent.ts).

## The `StreamEvent` union

```typescript
interface StreamEvent {
  readonly type:
    | 'text' | 'reasoning' | 'tool_use' | 'tool_result'
    | 'loop_detected' | 'budget_exceeded' | 'done' | 'error'
  readonly data: unknown
  readonly errorInfo?: StructuredTraceError
}
```

`data` is `unknown` by design, because its type depends on `type`. Narrow on
`type` before using it.

| `type` | `data` | Emitted by | When |
|---|---|---|---|
| `text` | `string` | Runner, both external backends, every adapter | Runner: the whole turn's text, once per turn, only when non-empty. Backends and adapters: an incremental chunk. |
| `reasoning` | `string` | Adapters only | A thinking or reasoning delta. The runner never emits this. |
| `tool_use` | `ToolUseBlock` | Runner and every built-in adapter | Runner: once per requested call, after loop detection and before execution. |
| `tool_result` | `ToolResultBlock` | Runner only | After each tool call commits, in request order. |
| `loop_detected` | `LoopDetectionInfo` | Runner only | The loop detector matched this turn, before any `tool_use` for it. |
| `budget_exceeded` | `TokenBudgetExceededError` | Runner only | The agent's cumulative tokens crossed `maxTokenBudget`. |
| `done` | `AgentRunResult` / `RunResult` / `LLMResponse` | All | Exactly one, last, on success. |
| `error` | `Error` | All | Exactly one, last, on failure. No `done` follows. |

`errorInfo` is populated on `error` events that pass through `Agent`, which
classifies the failure with `classifyRunFailure` before re-yielding. It tells a
consumer whether the failure was a provider error and whether it is retryable
without parsing the message text. Adapter-level `error` events carry no
`errorInfo`.

`budget_exceeded` is a notification, not a failure: the stream continues to a
normal `done` whose result has `budgetExceeded: true`. See
[budgets and limits](budgets-and-limits.md).

## Event order in an agent run

For each turn the runner performs, in this order:

1. The model call completes. `text` is emitted with that turn's full text, if
   any.
2. `budget_exceeded`, if the cumulative token total now exceeds the ceiling.
3. `loop_detected`, if a detector is configured and this turn repeated. Under
   `'terminate'` the run stops here, so no unpaired `tool_use` is emitted.
4. One `tool_use` per requested call.
5. The tools execute, then one `tool_result` per call, in request order. These
   arrive before the next turn's `text`.

The stream ends with exactly one `done` or one `error`. A tool that fails does
not end the stream: tool failures are values, so its `ToolResultBlock` carries
`is_error: true` and the loop continues.

Two consequences worth planning for:

- **`text` is not a token feed.** A slow turn produces nothing until the whole
  turn returns. `callTimeoutMs` is a wall-clock deadline over the entire
  response for the same reason.
- **`reasoning` never appears at this level.** Reasoning blocks still reach the
  result content and round-trip according to the adapter's declared
  `echoesReasoning` capability; they are just not surfaced as stream events by
  the runner. See [context management](context-management.md#preserving-reasoning-across-providers).

## Streaming from a team run

`OrchestratorConfig.onAgentStream` receives every event a task's worker agent
produces, tagged with the agent name:

```typescript
const orchestrator = new OpenMultiAgent({
  onAgentStream: (agentName, event) => {
    if (event.type === 'text' && typeof event.data === 'string') {
      process.stdout.write(`[${agentName}] ${event.data}`)
    }
  },
})
```

Configuring it switches worker execution from `agent.run()` to `agent.stream()`
for task agents in both `runTeam()` and `runTasks()`, which both dispatch
through the same task-execution path. It is **not** invoked for:

- `runAgent()`, which has no streaming form at all;
- coordinator decomposition and final synthesis, which call `agent.run()`;
- consensus proposers, judges, and revisions, and the per-task `verify` hook;
- `delegate_to_agent` sub-runs, which are dispatched without a stream callback.

Three behaviors matter when wiring a live UI to it:

- **A throwing callback cannot break the run.** `AgentPool` swallows callback
  exceptions, mirroring the observability contract, so a broken renderer does
  not burn a retry attempt.
- **An `error` event still fails the task.** The pool forwards the event first,
  then throws it, so your handler sees the error before task retry or model
  fallback decides what to do with it. The event's `errorInfo` is what that
  decision reads, which is why a retryable provider error can fail over to the
  next route with streaming enabled.
- **The callback is synchronous.** It returns `void`; there is no
  backpressure. Buffer or drop in your own handler if the consumer is slower
  than the run.

## Provider-level streaming

`LLMAdapter.stream()` is part of the adapter contract and every built-in
adapter implements it, but no framework path calls it. Use it when you drive an
adapter directly.

| Adapter | `text` | `reasoning` | `tool_use` |
|---|---|---|---|
| Anthropic | `text_delta` | `thinking_delta` | On `content_block_stop`, after the input JSON is assembled |
| OpenAI and the OpenAI-compatible adapters that extend it | `delta.content` | reasoning delta when the server sends one | After the stream ends, once per assembled call |
| Azure OpenAI | `delta.content` | Not emitted | After the stream ends |
| Copilot | `delta.content` | Not emitted | After the stream ends |
| Gemini | per part | thought summary parts | per part; arguments are not streamed |
| Bedrock | `contentBlockDelta` | `reasoningContent.text` deltas | On `contentBlockStop` |
| AI SDK | `text-delta` parts | `reasoning-delta` parts | `tool-call` parts |

Every implementation ends with exactly one `done` carrying a complete
`LLMResponse` assembled from the accumulated deltas, or one `error`. Because
tool arguments arrive in fragments, `tool_use` is always emitted after that
call's arguments are complete, never as a partial block.

Adapters that extend `OpenAIAdapter` inherit its `stream()` unchanged, so a new
OpenAI-compatible provider gets streaming without writing any. A from-scratch
adapter must implement both `chat()` and `stream()`. See
[providers](providers.md).

## External backends

Both external backends stream, but they emit a narrower set of events because
they own their own loop and never enter the runner.

| Backend | Emits | Does not emit |
|---|---|---|
| `process` | `text` per stdout chunk, then `done` or `error` | `reasoning`, `tool_use`, `tool_result`, `loop_detected`, `budget_exceeded` |
| `acp` | `text` per `agent_message_chunk`, then `done` or `error` | the same set |

ACP tool activity is reported, not streamed: `tool_call` and
`tool_call_update` notifications accumulate into `result.toolCalls` on the
`done` event rather than becoming `tool_use` / `tool_result` events. An ACP
stop reason of `max_tokens` or `max_turn_requests` sets `budgetExceeded: true`
on that result without emitting a `budget_exceeded` event; a `refusal` becomes
an `error`. A non-zero process exit becomes an `error` whose message is passed
through credential redaction first.

Structured `LLMMessage[]` input is rejected for both backends before a
subprocess is spawned or a session is opened. See
[external agents](external-agents.md).

## Relationship to traces, progress events, and the Run Viewer

Streaming is a delivery channel for one agent's output. It does not replace the
observability layers, and it is not where run state lives.

- **Progress events** (`onProgress`) stay lifecycle-shaped and orchestration-
  level: `task_start`, `agent_complete`, `budget_exceeded`, and so on. They fire
  whether or not `onAgentStream` is configured.
- **Traces.** When streaming is active in a team run, each forwarded event also
  produces a `stream_chunk` span event carrying `oma.stream.type`, and a legacy
  `agent_stream` trace event whose `streamType` is the same discriminant and
  whose `parentId` is the agent span. Under queue pressure `stream_chunk`
  records are the first thing a batching sink drops, precisely because they are
  the most redundant.
- **TTFT** is recorded only by a genuinely streaming provider path. The
  aggregated `chat()` path the runner uses never substitutes total latency for
  it.
- **The Run Viewer** is a post-run artifact built from results and stored
  traces. It never consumes a live stream.

See [observability](observability.md#progress-events) and
[Run Viewer](run-viewer.md).

## Related pages

- [Budgets and limits](budgets-and-limits.md) for `budget_exceeded`,
  `loop_detected`, and the ceilings behind them.
- [Structured agent input](structured-input.md) for what `stream()` accepts and
  when it validates.
- [External agents](external-agents.md) for process and ACP backend behavior.
- [Observability](observability.md) for progress events, trace spans, and sinks.
- [Providers](providers.md) for adapter selection and reasoning configuration.
