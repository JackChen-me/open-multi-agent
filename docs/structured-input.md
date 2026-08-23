# Structured Agent Input

`Agent.run()`, `Agent.stream()`, and `OpenMultiAgent.runAgent()` accept either a
string or a complete `LLMMessage[]`. The string form is unchanged shorthand for
one user text message. Use the message form when the application owns prior
conversation turns or needs content blocks such as images and videos:

```ts
import {
  OpenMultiAgent,
  type LLMMessage,
} from '@open-multi-agent/core'

const messages: LLMMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Keep answers concise.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Understood.' }] },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is shown here?' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: imageBytes.toString('base64'),
        },
      },
    ],
  },
]

const result = await new OpenMultiAgent().runAgent(
  { name: 'vision', model: 'claude-sonnet-4-6' },
  messages,
)
```

OpenAI-compatible adapters (including MiniMax) also accept a `video` block;
its source may be inline base64 bytes or an HTTP(S) URL and is sent as a
`video_url` content part.

The selected model/provider must support every supplied content block. OMA does
not infer a vision-capability flag or silently remove unsupported blocks;
provider errors follow the normal agent failure path.

## API boundaries

| API | String form | Structured form | Conversation behavior |
|---|---|---|---|
| `Agent.run(input)` | One user text message | Complete `readonly LLMMessage[]` | Fresh; does not read or update persistent history |
| `Agent.stream(input)` | One user text message | Complete `readonly LLMMessage[]` | Fresh; same input semantics as `run()` |
| `OpenMultiAgent.runAgent(config, input)` | One user text message | Complete `readonly LLMMessage[]` | Fresh one-off Agent with orchestration, tracing, progress, budgets, and evaluation |
| `Agent.prompt(input)` | One user text message | One user turn as `readonly ContentBlock[]` | Appends that turn and the response to persistent history |

`AgentConfig.history` restores earlier persistent turns for `prompt()`. Passing a
content-block list to `prompt()` does not replace that history and cannot insert
assistant turns; use `run(messages)` for a caller-owned complete conversation.
`runTeam()` goals and `runTasks()` task descriptions remain text-only.

## Copying and validation

Structured inputs are runtime-validated with the same `LLMMessage` shape guard
used at adapter boundaries, then defensively deep-copied before hooks, runners,
progress callbacks, evaluation, or persistent history retain them. Mutating the
caller's arrays, content blocks, image source, or tool input after calling an API
does not change that run. `Agent.getHistory()` also returns a deep copy.

Invalid message/content shapes or data that cannot be cloned throw
`InvalidMessageError` before `beforeRun`, provider/backend execution, progress,
or online evaluation. Invalid `prompt()` input is not appended to history.
For `stream()`, this validation happens when `stream()` is called, before the
returned iterator starts.

## `beforeRun` semantics

`beforeRun` receives both views of the effective input:

```ts
beforeRun(ctx) {
  return {
    ...ctx,
    messages: ctx.messages, // complete defensive message copy
    prompt: ctx.prompt,     // text blocks from the latest user message
  }
}
```

`ctx.prompt` remains the backwards-compatible concatenation of text blocks from
the latest user message. An image-only turn therefore has an empty `prompt` but
is fully available in `ctx.messages`.

Returning `messages` replaces the complete input. If the hook also changes
`prompt`, OMA applies the message replacement first, then replaces the latest
user message's text blocks with one text block. Non-text blocks keep their
relative order. Hook inputs and execution messages are copies, so a hook rewrite
does not mutate caller-owned data or the original user turn stored by
`Agent.prompt()`.

## Progress and online evaluation

String `runAgent()` calls retain the existing `agent_start` payload
`{ prompt: string }` and string evaluation input. Structured calls emit
`{ messages: LLMMessage[] }` and submit a separate message copy to online
evaluation. Progress callback mutations cannot affect execution or evaluation.
The evaluator's existing `storePayloads` policy still applies: `none` omits the
content, while `redacted` or `full` serializes a bounded payload according to the
documented privacy contract.

## External process and ACP backends

Process and ACP backends expose text prompt transports, not OMA's structured
message protocol. Supplying `LLMMessage[]` to `run()` / `stream()` / `runAgent()`,
or `ContentBlock[]` to `prompt()`, throws `InvalidMessageError` before a process
is spawned or an ACP session is opened. This fail-fast boundary prevents images
or caller-owned history from being silently discarded. Pass a string instead.

For the same reason, an external agent's `beforeRun` may rewrite `prompt` but may
not change `messages`. Existing string execution, including the process backend's
fresh-per-run behavior and ACP's protocol session behavior, is unchanged.
`AgentConfig.history` does not seed either external transport; it restores
messages only for LLM-backed `prompt()` conversations.
