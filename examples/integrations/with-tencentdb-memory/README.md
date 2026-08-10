# OMA + TencentDB-Agent-Memory

Long-term memory for OMA teams, backed by
[TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
(TDAM) — Tencent Cloud's open-source agent memory system. TDAM distills raw
conversations through a layered pipeline (L0 conversations → L1 atomic facts →
L2 scenes → L3 persona), stores everything locally in SQLite + sqlite-vec, and
retrieves with BM25 + vector hybrid search.

TDAM has no general-purpose SDK; third-party frameworks integrate through its
**Hermes Gateway** — an HTTP sidecar (default `127.0.0.1:8420`) exposing
capture / search / recall endpoints. This example wires OMA to that Gateway:

| File | What it does |
|------|--------------|
| [`tdam-store.ts`](tdam-store.ts) | `MemoryStore` implementation for `TeamConfig.sharedMemoryStore`. Task results written to shared memory are auto-captured into TDAM; recall/search/flush helpers pull long-term memory back. |
| [`tdam-toolkit.ts`](tdam-toolkit.ts) | Two `defineTool()` tools (`tdam_search_memories`, `tdam_search_conversations`) so agents can query long-term memory mid-task. |
| [`team-with-memory.ts`](team-with-memory.ts) | Runnable demo: recall → `runTeam()` with auto-capture → flush extraction → search distilled memories. Run it twice to see cross-run persistence. |

## How the mapping works

OMA's `MemoryStore` is a key-value contract; the TDAM Gateway is a
distillation pipeline with **no read-a-value-back-by-key endpoint** (its
`/search/*` and `/recall` return formatted text, not raw records). Forcing KV
reads through search would corrupt the orchestrator's shared-memory plumbing,
so the store splits responsibilities:

- **Within a run** — `get` / `list` / `delete` / `clear` are served from a
  local in-process map, exactly like the default `InMemoryStore`. Task-result
  injection and team summaries behave identically.
- **Write-through capture** — every `set()` also `POST /capture`s the entry as
  a conversation turn, with the stored value spoken **user-side** by the
  writing agent. That phrasing matters: TDAM's L1 extractor is user-centric
  by design (it distills persona / episodic / instruction memories about the
  user and explicitly ignores assistant output), so team results reported as
  user content are what survive as long-term memories.
- **Across runs** — a fresh process starts with an empty local map, then
  `recall(topic)` pulls the distilled memories from previous runs and the
  example injects them into agent system prompts (the same prefetch pattern
  TDAM's own Hermes plugin uses).

Two consequences worth knowing before you build on it:

- Capture → searchable is **asynchronous**: TDAM records L0 immediately but
  extracts L1 facts on a schedule — every `memory.pipeline.everyNConversations`
  captures (default 5, with warm-up) or a 600s idle timer, whichever fires
  first. In TDAM v0.3.6, `POST /session/end` drains extraction already in
  flight but does **not** force extraction of turns still below the count
  threshold. This example therefore runs the Gateway with
  `everyNConversations: 1` (see below) so every capture extracts immediately
  and `endSession()` reliably means "everything captured is now searchable".
  Budget real LLM latency for it — extraction calls the Gateway's configured
  model.
- `delete()` / `clear()` only affect the local map. The Gateway has no delete
  endpoint; captured history stays in TDAM as pipeline raw material.

## Start the Gateway

The Gateway needs an LLM for its extraction pipeline — any OpenAI-compatible
endpoint works. This example is **verified against TDAM v0.3.6**
(`@tencentdb-agent-memory/memory-tencentdb@0.3.6`; endpoint schemas from its
`src/gateway/types.ts`).

### Option A — npm package, version-pinned (what this example is verified with)

The npm package ships the Gateway source; run it with `tsx` (Node ≥ 22):

```bash
mkdir tdam-gateway && cd tdam-gateway
npm install @tencentdb-agent-memory/memory-tencentdb@0.3.6 tsx

# Demo pipeline config: distill after every capture instead of batching
# every 5 conversations, so endSession() deterministically covers all writes.
cat > tdai-gateway.yaml << 'EOF'
memory:
  pipeline:
    everyNConversations: 1
EOF

# LLM used by TDAM's extraction pipeline (any OpenAI-compatible endpoint).
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"
export TDAI_LLM_API_KEY="sk-..."
export TDAI_LLM_MODEL="deepseek-v4-flash"
export TDAI_DATA_DIR="$PWD/tdai-data"     # where SQLite memories live

npx tsx node_modules/@tencentdb-agent-memory/memory-tencentdb/src/gateway/server.ts
```

The Gateway picks up `tdai-gateway.yaml` from the directory it starts in (or
from `TDAI_DATA_DIR`, or an explicit `TDAI_GATEWAY_CONFIG` path). Any
OpenAI-compatible `TDAI_LLM_*` endpoint works — `https://api.openai.com/v1`
with `gpt-4o`, a local Ollama server, etc. Note the Anthropic API is not
OpenAI-compatible, so an Anthropic key can drive your OMA agents but not the
Gateway's extraction pipeline.

Verify: `curl http://127.0.0.1:8420/health`. With the default SQLite backend
and no embedding service this returns
`{"status":"ok",...,"stores":{"vectorStore":true,"embeddingService":false}}` —
retrieval then runs on BM25 keyword search, which is enough for this example.
(`status:"degraded"` means the store failed to initialize; check the Gateway
log.)

### Option B — Docker (upstream's official image)

Upstream ships a combined Hermes-agent + Gateway image. From a clone of
[TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
at tag `v0.3.6`:

```bash
git clone --branch v0.3.6 --depth 1 \
  https://github.com/TencentCloud/TencentDB-Agent-Memory
cd TencentDB-Agent-Memory/docker/opensource

docker build -f Dockerfile.hermes -t hermes-memory .

docker run -d \
  --name hermes-memory \
  --restart unless-stopped \
  -p 8420:8420 \
  -e MODEL_API_KEY="your-api-key" \
  -e MODEL_BASE_URL="https://api.lkeap.cloud.tencent.com/v1" \
  -e MODEL_NAME="deepseek-v3.2" \
  -e MODEL_PROVIDER="custom" \
  -v hermes_data:/opt/data \
  hermes-memory

curl http://localhost:8420/health
```

`MODEL_*` is the LLM the Gateway extracts memories with — the defaults point
at Tencent Cloud's DeepSeek endpoint; any OpenAI-compatible
`MODEL_BASE_URL`/`MODEL_NAME` works. For the per-capture extraction this
example expects, drop the same `tdai-gateway.yaml` from Option A into the
volume's data directory (`/opt/data/tdai-memory/` — the image's
`TDAI_DATA_DIR`, one of the locations the Gateway's config loader checks).

Two caveats. The upstream Dockerfile installs the Gateway from npm `@latest`
at **build** time, so the image tracks whatever is newest even on a `v0.3.6`
checkout — for a strictly pinned Gateway, use Option A. And this example was
verified against the Option A Gateway (the image runs the same npm-package
server source, but the image build itself was not exercised here).

## Authentication

Gateway auth is opt-in Bearer token, off by default:

- **Gateway side** — set `TDAI_GATEWAY_API_KEY=<secret>` in the Gateway's
  environment (or `server.apiKey` in `tdai-gateway.yaml`). Every route except
  `GET /health` then requires `Authorization: Bearer <secret>` and returns
  `401` otherwise.
- **OMA side** — export the same `TDAI_GATEWAY_API_KEY` before running the
  example; `TdamMemoryStore` and `TdamToolkit` pick it up automatically (or
  pass `apiKey` to their constructors). When unset, no auth header is sent,
  matching the Gateway's open default.

Leave auth off only while the Gateway binds to `127.0.0.1` (its default).
Bind to anything wider and the Gateway itself logs a warning until a key is
set.

## Run the example

```bash
# Hosted provider (default: anthropic / claude-sonnet-4-6)
ANTHROPIC_API_KEY=sk-... npx tsx examples/integrations/with-tencentdb-memory/team-with-memory.ts

# Fully local (agents + Gateway extraction all on Ollama)
AGENT_PROVIDER=openai AGENT_MODEL=qwen3.5:9b-mlx AGENT_BASE_URL=http://localhost:11434/v1 \
  npx tsx examples/integrations/with-tencentdb-memory/team-with-memory.ts
```

| Env var | Default | Purpose |
|---------|---------|---------|
| `AGENT_PROVIDER` / `AGENT_MODEL` | `anthropic` / `claude-sonnet-4-6` | Provider + model for the agents and coordinator |
| `AGENT_BASE_URL` / `AGENT_API_KEY` | — / `local` | OpenAI-compatible server (Ollama, vLLM, …) with `AGENT_PROVIDER=openai` |
| `TDAM_GATEWAY_URL` | `http://127.0.0.1:8420` | Hermes Gateway address |
| `TDAM_SESSION_KEY` | `oma-memory-demo` | TDAM session the captures land in |
| `TDAI_GATEWAY_API_KEY` | unset | Bearer token, when the Gateway has auth enabled |

**Run it twice.** The first run starts with no long-term memory, captures the
team's task results, and flushes extraction. The second run recalls the
distilled facts and injects them into the agents' prompts.

### Verified run

Real output from the verification setup: TDAM v0.3.6 Gateway (npm package,
`everyNConversations: 1`, Bearer auth enabled end-to-end), agents and
extraction both on `deepseek-v4-flash`.

First run — no memories yet; captures distill into one episodic memory:

```text
[1/4] Recalling long-term memory for the topic...
  No long-term memories yet (first run against this Gateway).

[2/4] Running the team (shared-memory writes auto-capture into TDAM)...
  Team run succeeded.
  [... recommendation memo ...]

[3/4] Captured 2/2 shared-memory writes into TDAM (4 L0 records). Flushing L1 extraction...
  Flush complete in 0.0s.

[4/4] Searching distilled L1 memories...
  1 memories match (strategy: fts).

- **[episodic]** (priority: 80) [scene: Receiving analyst's completed work report on SQLite vs PostgreSQL comparison]
  The user (analyst) reported completed work comparing SQLite and PostgreSQL
  for agent memory stores, concluding that SQLite is preferable for real-time
  latency and simplicity, while PostgreSQL is better for multi-agent
  concurrency and scalability.
```

Second run — recall feeds the distilled memory forward, and TDAM merges the
new run's results into an upgraded memory:

```text
[1/4] Recalling long-term memory for the topic...
  Recalled 1 memories (strategy: hybrid) — injecting into agent prompts.

[2/4] Running the team (shared-memory writes auto-capture into TDAM)...
  Team run succeeded.
  [... memo now builds on the recalled findings instead of repeating them ...]

[3/4] Captured 2/2 shared-memory writes into TDAM (4 L0 records). Flushing L1 extraction...
  Flush complete in 49.9s.

[4/4] Searching distilled L1 memories...
  1 memories match (strategy: fts).

- **[episodic]** (priority: 85) [scene: Receiving writer's completed memorandum on storage choice for AI agent memory]
  The open-multi-agent team completed work on storage choice for AI agent
  memory: the analyst completed an analysis comparing SQLite and PostgreSQL
  [...] the writer completed a memorandum recommending SQLite for
  single-agent local workloads and PostgreSQL for multi-agent concurrent
  systems.
```

Timings and exact memory text vary by model. Note the flush asymmetry: in run
one extraction had already completed inline before `endSession()` (hence
0.0s); in run two the captures were still queued and the call genuinely
waited for the extraction LLM (49.9s).

## Troubleshooting

- **`Cannot reach the TDAM Gateway`** — the Gateway isn't running, or
  `TDAM_GATEWAY_URL` points elsewhere. `curl <url>/health` to check; the
  health route never needs auth.
- **`401 Unauthorized`** — the Gateway has `TDAI_GATEWAY_API_KEY` set but the
  example doesn't (or the values differ). Export the same secret on both ends.
- **`[4/4]` finds 0 memories** — extraction quality depends on the Gateway's
  `TDAI_LLM_MODEL`; very small local models occasionally produce no
  extractable facts from a single session. Re-run, or point the Gateway at a
  stronger model.
- **Flush is slow** — `endSession()` waits for real LLM extraction calls.
  On local models budget minutes, not seconds (`flushTimeoutMs` defaults to
  300s).
