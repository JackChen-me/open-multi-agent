# with-vercel-ai-sdk

A Next.js demo showing **open-multi-agent** (OMA) and **Vercel AI SDK** working together:

- **OMA** orchestrates a research team (researcher agent + writer agent) via `runTeam()`
- **AI SDK** streams the result to a chat UI via `useChat` + `streamText`

## How it works

```
User message
  │
  ▼
API route (app/api/chat/route.ts)
  │
  ├─ Phase 1: OMA runTeam()
  │    coordinator decomposes goal → researcher gathers info → writer drafts article
  │
  └─ Phase 2: AI SDK streamText()
       streams the team's output to the browser
  │
  ▼
Chat UI (app/page.tsx) — useChat hook renders streamed response
```

## Setup

```bash
# 1. From the repository root, install OMA dependencies
npm install

# 2. Back to this example
cd examples/integrations/with-vercel-ai-sdk
npm install

# 3. Set your DeepSeek API key (the demo runs the team on DeepSeek)
export DEEPSEEK_API_KEY=sk-...

# 4. Run
npm run dev
```

`npm run dev` automatically builds OMA before starting Next.js (via the `predev` script).

Open [http://localhost:3000](http://localhost:3000), type a topic, and watch the research team work.

## Prerequisites

- Node.js >= 22 (Vercel AI SDK 7 requires Node 22+)
- `DEEPSEEK_API_KEY` environment variable (used by both OMA and AI SDK)

## Key files

| File | Role |
|------|------|
| `app/api/chat/route.ts` | Backend — OMA orchestration + AI SDK streaming |
| `app/page.tsx` | Frontend — chat UI with `useChat` hook |
| `package.json` | References OMA via `file:../../../packages/core` (local link) |
