/**
 * Cross-provider reasoning preservation via `preserveReasoningAsText`
 *
 * When an `Agent.prompt()` conversation runs against a "reasoning" model that
 * emits `reasoning_content` (OpenAI o-series, DeepSeek reasoner, Anthropic
 * extended-thinking-via-Bedrock, etc.), the model's intermediate thought
 * stream is normally either:
 *
 *   (a) native-echoed back when the next turn targets the same provider with
 *       a valid signature (Anthropic, Gemini own-issued path), OR
 *   (b) silently dropped on the next outbound conversion (everyone else).
 *
 * Opt into {@link AgentConfig.preserveReasoningAsText} to replace (b) with a
 * downgrade — the prior reasoning is wrapped in `<thinking>...</thinking>`
 * text and prepended to the next assistant message, so the receiving model
 * has full context of what was previously considered. See #223 for design.
 *
 * Run:
 *   npx tsx packages/core/examples/patterns/cross-provider-reasoning.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY
 *   OPENAI_API_KEY (uses an o-series model for the reasoning emit)
 */

import { Agent, ToolExecutor, ToolRegistry } from '../../src/index.js'

// --- Caveat: loop-detector interaction --------------------------------------
//
// Some OpenAI-compatible local models (and a few hosted ones at low quality
// tiers) re-emit `<thinking>...</thinking>` text back into their assistant
// response as if the tag were an instruction template. When this happens
// across multiple turns, the framework's loop-detector may flag the agent as
// stuck because the assistant text matches turn-over-turn.
//
// Mitigation if you hit this:
//   - Set `loopDetection: { enabled: false }` on the AgentConfig (loses the
//     safety net for other genuine loop cases — use as a debug measure only).
//   - Switch to a model that ignores `<thinking>` text on input (most o-series
//     and Claude models do; problem is mostly with smaller local models).
//   - Disable `preserveReasoningAsText` entirely; accept reasoning loss.
//
// The example below does NOT trigger the issue against gpt-5 / Claude, but is
// included so contributors testing local models know what to watch for.
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env['ANTHROPIC_API_KEY'] || !process.env['OPENAI_API_KEY']) {
    console.log('Skip: ANTHROPIC_API_KEY and OPENAI_API_KEY both required.')
    process.exit(0)
  }

  // Step 1: a reasoning-capable OpenAI model produces a turn that includes
  // a `reasoning_content` chunk. The adapter extracts it into a ReasoningBlock
  // with `provenance: 'openai'`, stored in the agent's persistent history.
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry)

  const agent = new Agent(
    {
      name: 'cross-provider-demo',
      model: 'gpt-5',  // o-series-style reasoning model
      provider: 'openai',
      systemPrompt: 'You reason carefully then give a short final answer.',
      preserveReasoningAsText: true,
      // compressReasoningText defaults to `true` whenever preserve is true,
      // so long reasoning chains are head+tail truncated to 1200 chars by
      // default. Override with `{ minChars: N }` to tune, or `false` to disable
      // (footgun — long CoT will eat your prompt budget).
      compressReasoningText: { minChars: 1500 },
    },
    registry,
    executor,
  )

  const firstAnswer = await agent.prompt(
    'A train leaves Boston at 60 mph heading west. Another leaves NYC at 80 mph heading north. ' +
    'After 2 hours, what is the straight-line distance between them? Show your reasoning briefly.',
  )
  console.log('--- Turn 1 (OpenAI o-series) ---')
  console.log(firstAnswer.output.slice(0, 500))

  // Step 2: swap the model to Anthropic mid-conversation. Without
  // `preserveReasoningAsText`, the prior reasoning would be silently dropped
  // because Anthropic's outbound only round-trips its own-signed thinking
  // blocks. With opt-in on, the prior OpenAI reasoning is replayed as
  // `<thinking>` text so Claude sees the chain.
  //
  // (Note: in real code you'd construct a new Agent or use a per-call model
  // override. The Agent instance owns its adapter; this example keeps things
  // short and just illustrates the persistence model.)
  console.log('\n(Hypothetical: if you constructed a second Agent against ' +
    'Anthropic and replayed the same messageHistory, the prior OpenAI ' +
    'reasoning would arrive as `<thinking>` text on its first request.)')
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
