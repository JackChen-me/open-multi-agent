# Context management

Long-running agents can hit input token ceilings fast. Set `contextStrategy` on `AgentConfig` to control how the conversation shrinks as it grows:

```typescript
const agent: AgentConfig = {
  name: 'long-runner',
  model: 'claude-sonnet-4-6',
  // Pick one:
  contextStrategy: { type: 'sliding-window', maxTurns: 20 },
  // contextStrategy: { type: 'summarize', maxTokens: 80_000, summaryModel: 'claude-haiku-4-5' },
  // contextStrategy: { type: 'compact', maxTokens: 100_000, preserveRecentTurns: 4 },
  // contextStrategy: { type: 'custom', compress: (messages, estimatedTokens) => ... },
}
```

| Strategy | When to reach for it |
|----------|----------------------|
| `sliding-window` | Cheapest. Keep the last N turns, drop the rest. |
| `summarize` | Send old turns to a summary model; keep the summary in place of the originals. |
| `compact` | Rule-based: truncate large assistant text blocks and tool results, keep recent turns intact. No extra LLM call. |
| `custom` | Supply your own `compress(messages, estimatedTokens)` function. |

## Auditing what a strategy replaced

Every strategy above rewrites the conversation destructively: the messages it
produces are what the next request carries, and the originals are gone from the
working conversation. With a [run journal](run-journal.md) enabled, each
application also emits one `context/replace` event recording what was removed
and what took its place, so the conversation the model actually saw stays
reconstructable after the fact.

```typescript
const journal = new InMemoryRunJournal()
await orchestrator.runTasks(team, tasks, { journal })

for (const event of await journal.readFrom(0)) {
  if (event.type !== 'context/replace') continue
  console.log(event.strategy, event.replacements.length, event.dropped?.sourceEventSeqs)
}
```

| Strategy | `strategy` | What the event records |
|---|---|---|
| `sliding-window` | `'sliding-window'` | `dropped` names every block of every removed turn; one replacement carries the truncation notice, sourced from the dropped turns and the message it was merged into. `detail: { droppedTurns }`. |
| `summarize` | `'summarize'` | One replacement carrying the `[Conversation summary]` block, sourced from the old turns it condensed. `detail` names the summary model and its usage. The summary model call itself is not journaled as a turn — it is an implementation detail of this rewrite. |
| `compact` | `'compact'` | One replacement per rewritten block (truncated text, `[Image compacted]`, `[Tool result: …, compacted]`), each naming the single block it replaced. Untouched blocks keep their own lineage. |
| `compressToolResults` | `'compress-tool-results'` | One replacement per **newly** compressed result. Already-compressed markers are skipped, so a long run records one event per result, not one per request. |
| `custom` | `'custom'` | Any block your function invented, stored verbatim with the whole input conversation as its lineage. Blocks you passed through by reference keep theirs. |

Each derived block's lineage is the single sequence of the event that carries
it, and the block is stored as-is rather than as a description of how to rebuild
it — which is what makes `enforceLineage: true` pass with every built-in
strategy. A pass that changes nothing emits nothing, and `summarize`'s memo
cache reuses the event that first recorded a summary rather than writing it
twice.

## Compressing tool results

Tool outputs persist in the conversation history across turns even after the agent has acted on them. In long runs this can consume a significant portion of the context budget.

`compressToolResults` replaces already-consumed tool results (those followed by an assistant response) with a short marker before each new LLM call:

```typescript
const agent: AgentConfig = {
  name: 'long-runner',
  model: 'claude-sonnet-4-6',
  // Enable with the default threshold (500 chars):
  compressToolResults: true,
  // Or only compress results longer than N characters:
  // compressToolResults: { minChars: 2000 },
}
```

| Value | Behaviour |
|-------|-----------|
| `true` | Compress results longer than 500 characters (default threshold) |
| `{ minChars: N }` | Compress results longer than N characters |
| `false` / `undefined` | Disabled (default) |

**Notes:**
- Error tool results are never compressed.
- Delegation `tool_result` blocks (from `delegate_to_agent`) are exempt — the parent agent always retains the full sub-agent output.
- Rich image/file results use an estimated size for the threshold. Consumed
  rich results can become a text marker; the newest rich result stays intact.
- The `summarize` strategy replaces rich media bytes and URLs with descriptive
  placeholders before asking the summary model to compress old turns.
- Works alongside `contextStrategy`; combine both for maximum context headroom.

## Truncating tool output

`maxToolOutputChars` caps the raw output length for implicit string tool
results. Outputs longer than the limit are truncated to a head + tail excerpt
with a marker in between. Explicit rich `modelOutput` is not rewritten; resize
or bound it inside the tool. This applies at execution time, before the result
enters the conversation.

```typescript
const agent: AgentConfig = {
  name: 'long-runner',
  model: 'claude-sonnet-4-6',
  maxToolOutputChars: 10_000, // truncate any single tool output to 10 k chars
}
```

Per-tool `maxOutputChars` (set on `ToolDefinition`) takes priority over the agent-level `maxToolOutputChars`.

## Preserving reasoning across providers

Reasoning models (OpenAI o-series, DeepSeek reasoner, Anthropic extended thinking, Gemini thought summaries) emit intermediate reasoning that the framework extracts as `ReasoningBlock`s with a `provenance` field identifying the producing adapter. By default, only same-provider blocks with a valid signature are echoed back; everything else is silently dropped on outbound conversion to avoid the receiving model rejecting an unsigned thinking block or to keep prompt size predictable.

`preserveReasoningAsText` opts into a `<thinking>...</thinking>` text fallback: whenever an outbound conversion encounters a reasoning block the target adapter cannot natively echo, the block is downgraded to inline text and prepended to the next assistant message:

```typescript
const agent: AgentConfig = {
  name: 'cross-provider',
  model: 'gpt-5',
  provider: 'openai',
  // Enable text fallback for reasoning blocks the target adapter can't echo.
  preserveReasoningAsText: true,
  // Defaults to ON when preserveReasoningAsText is true; head+tail truncate
  // each block to 1200 chars. Override to tune, or set false to disable.
  // compressReasoningText: { minChars: 4000 },
}
```

When the fallback fires:

| Source provenance | Target adapter capability | Behaviour with `preserveReasoningAsText: true` |
|---|---|---|
| Matches target (`'anthropic'` → Anthropic) and has signature | `'own-issued'` | Native echo (unchanged) |
| Matches target but no signature | `'own-issued'` | Text fallback |
| Foreign (e.g. `'openai'` → Anthropic) | `'own-issued'` | Text fallback |
| Matches target (`'deepseek'` → DeepSeek) in a tool-calling conversation | `'tool-use-only'` | Native `reasoning_content` echo (per DeepSeek V4 spec, see #251) |
| Matches target but no `tool_use` anywhere in history | `'tool-use-only'` | Dropped (DeepSeek spec ignores non-tool reasoning) |
| Foreign (e.g. `'openai'` → DeepSeek) | `'tool-use-only'` | Text fallback |
| Matches target (`'bedrock'` → Bedrock) and has signature or is redacted | `'own-issued'` | Native echo via `reasoningContent.{reasoningText,redactedContent}` (see #223) |
| Any | `'never'` (OpenAI, Azure, Copilot, AI SDK, etc.) | Text fallback |

Redacted reasoning (Anthropic safety-filtered) emits the placeholder `<thinking>[redacted]</thinking>` to signal that reasoning occurred without leaking the opaque payload.

**Notes:**
- Disabled by default to avoid silently inflating prompt tokens.
- Default-on truncation (`compressReasoningText`) is mandatory for safety on long chain-of-thought; disable only when debugging.
- Some local OpenAI-compatible models may echo `<thinking>` text back into their assistant response, which can trip the loop detector. See [`examples/patterns/cross-provider-reasoning.ts`](../packages/core/examples/patterns/cross-provider-reasoning.ts) for the failure mode and mitigations.
- Bedrock has `capabilities.echoesReasoning === 'own-issued'`: signed reasoning blocks (`reasoningContent.reasoningText.signature`) and redacted blocks (`reasoningContent.redactedContent`) round-trip natively on both `chat()` and `stream()`, in both inbound extraction and outbound serialization (see #223).
- `'tool-use-only'` (DeepSeek V4) is the only capability where same-provider echo works **without** the user opting into `preserveReasoningAsText` — it's forced on internally because the DeepSeek API requires it.
