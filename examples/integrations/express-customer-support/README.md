# Express Customer Support

An Express REST API that wraps OMA's `runTasks()` explicit-DAG pipeline behind a single `POST /tickets` endpoint. A three-agent pipeline runs on every request:

1. **classifier** (`deepseek-v4-flash`) — categorises the ticket and assigns urgency
2. **drafter** (`deepseek-v4-pro`) — writes a polished customer-facing reply (depends on classifier)
3. **qa-reviewer** (`deepseek-v4-pro`) — reviews the draft for tone and accuracy (depends on classifier + drafter)

`runTasks()` is the right primitive here because the pipeline shape is fixed: a coordinator-decomposed `runTeam()` would re-derive the same DAG and pay for an extra synthesis call on every request. With `runTasks()` the dependency graph is declared once at the route handler and OMA executes it in topological order, writing each agent's output into the next agent's prompt via the `## Context from prerequisite tasks` block that `runTasks()` injects from each completed task's result.

Each agent uses a Zod `outputSchema`; the endpoint assembles the three structured results into one JSON response. Each agent's model **and** provider are independently swappable via env vars, so you can move any tier to another provider (see [Swapping providers](#swapping-providers) below).

## Setup

```bash
# From the repository root
npm install
cd examples/integrations/express-customer-support
npm install
export DEEPSEEK_API_KEY=sk-...    # default — all three agents use DeepSeek
```

## Start the server

```bash
npm start
# Support API listening on http://localhost:3000
```

## Send a ticket

```bash
curl -s -X POST http://localhost:3000/tickets \
  -H 'Content-Type: application/json' \
  -d '{"subject":"My order never arrived","body":"I placed order #12345 two weeks ago and it still has not shipped. Please help!"}' | jq .
```

Expected response shape:

```json
{
  "category":    "shipping",
  "urgency":     "high",
  "draft_reply": "Thank you for reaching out...",
  "qa_notes":    "Tone is empathetic and professional. Accuracy: ..."
}
```

## Smoke test

Runs a real request against a local server (requires `DEEPSEEK_API_KEY`):

```bash
npm run smoke
```

Exits 0 and prints the structured response on success, exits 1 on failure.

## HTTP error codes

| Status | Meaning |
|--------|---------|
| 200 | Pipeline completed; body matches the `SupportTicketResponse` schema |
| 400 | Invalid JSON body, or missing / non-string `subject` / `body` fields |
| 502 | Pipeline failed, an agent produced no structured output, or an LLM call threw |
| 504 | Pipeline exceeded the 60-second timeout (in-flight LLM calls are aborted) |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | *(required for default provider)* | DeepSeek API key |
| `ANTHROPIC_API_KEY` | — | Required if `anthropic` is selected for any agent |
| `OPENAI_API_KEY` | — | Required if `openai` is selected for any agent |
| `GEMINI_API_KEY` | — | Required if `gemini` is selected for any agent |
| `XAI_API_KEY` | — | Required if `grok` is selected for any agent |
| `GITHUB_TOKEN` | — | Required if `copilot` is selected for any agent |
| `MINIMAX_API_KEY` | — | Required if `minimax` is selected for any agent |
| `AZURE_OPENAI_API_KEY` | — | Required if `azure-openai` is selected for any agent |
| `CLASSIFIER_PROVIDER` | `deepseek` | Provider for the classifier agent |
| `CLASSIFIER_MODEL`    | `deepseek-v4-flash` | Model for the classifier agent |
| `DRAFTER_PROVIDER`    | `deepseek` | Provider for the drafter agent |
| `DRAFTER_MODEL`       | `deepseek-v4-pro` | Model for the drafter agent |
| `QA_PROVIDER`         | `deepseek` | Provider for the QA reviewer agent |
| `QA_MODEL`            | `deepseek-v4-pro` | Model for the QA reviewer agent |
| `PORT` | `3000` | Port the server listens on |

Supported `*_PROVIDER` values with startup key validation: `anthropic`, `openai`, `gemini`, `grok`, `deepseek`, `copilot`, `minimax`, `azure-openai`. Providers not in this list are supported by the framework but are not mapped in this file's startup check — a missing key will surface as a 502 mid-request rather than a startup error.

## Swapping providers

The defaults run the whole pipeline on DeepSeek — `deepseek-v4-flash` for the cheap classifier, `deepseek-v4-pro` for the drafter and QA reviewer — so one `DEEPSEEK_API_KEY` runs everything. Each agent's provider and model are independently overridable via env vars, so you can move any tier to another provider.

Keep the cheap classifier on DeepSeek but run the drafter and QA reviewer on Anthropic:

```bash
export DEEPSEEK_API_KEY=...
export ANTHROPIC_API_KEY=sk-ant-...
export DRAFTER_PROVIDER=anthropic DRAFTER_MODEL=claude-sonnet-4-6
export QA_PROVIDER=anthropic      QA_MODEL=claude-opus-4-8
npm start
```

Run the entire pipeline on OpenAI:

```bash
export OPENAI_API_KEY=sk-...
export CLASSIFIER_PROVIDER=openai CLASSIFIER_MODEL=gpt-4o-mini
export DRAFTER_PROVIDER=openai    DRAFTER_MODEL=gpt-4o
export QA_PROVIDER=openai         QA_MODEL=gpt-4o
npm start
```

If the API key for a chosen provider is missing, the server fails fast at startup with a clear message rather than erroring during a request.
