import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PipelineTraceWriter,
  pipelineTraceArtifactSchema,
} from '../src/pipeline-trace.js'

const RUN_KEY = 'a'.repeat(64)
const BASE_SHA = 'b'.repeat(40)

describe('bounded pipeline trace artifact', () => {
  it('writes only fixed JSON-safe stage metadata and enforces its event limit', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'oma-pipeline-trace-'))
    const writer = new PipelineTraceWriter({
      artifactDir,
      runKey: RUN_KEY,
      issueNumber: 501,
      baseSha: BASE_SHA,
      claudeCodeTokenUsage: 'not_reported',
    })
    let tick = 0
    const now = () => new Date(`2026-08-14T00:00:${String(tick++).padStart(2, '0')}.000Z`)
    for (const stage of ['admission', 'coding', 'validation', 'review', 'proposal'] as const) {
      await writer.record(stage, 'start', now)
      await writer.record(stage, 'complete', now)
    }

    const raw = await readFile(writer.path, 'utf8')
    const artifact = pipelineTraceArtifactSchema.parse(JSON.parse(raw))
    expect(artifact.events.map(event => `${event.stage}:${event.status}`)).toEqual([
      'admission:start', 'admission:complete',
      'coding:start', 'coding:complete',
      'validation:start', 'validation:complete',
      'review:start', 'review:complete',
      'proposal:start', 'proposal:complete',
    ])
    expect(artifact.claudeCodeTokenUsage).toBe('not_reported')
    expect(raw).not.toMatch(/prompt|source|diff|token=|ghp_|sk-/i)
    expect(raw.length).toBeLessThan(4_000)
    expect(pipelineTraceArtifactSchema.safeParse({
      ...artifact,
      events: Array.from({ length: 11 }, () => artifact.events[0]),
    }).success).toBe(false)
    expect(pipelineTraceArtifactSchema.safeParse({ ...artifact, prompt: 'must not persist' }).success).toBe(false)
  })

  it('requires a failure to close the active stage', async () => {
    const writer = new PipelineTraceWriter({
      artifactDir: await mkdtemp(join(tmpdir(), 'oma-pipeline-trace-')),
      runKey: RUN_KEY,
      issueNumber: 501,
      baseSha: BASE_SHA,
      claudeCodeTokenUsage: 'not_applicable',
    })
    const now = () => new Date('2026-08-14T00:00:00.000Z')
    await writer.record('coding', 'start', now)
    await writer.record('coding', 'failure', now)
    await expect(writer.record('review', 'complete', now)).rejects.toThrow(/active stage/)
  })
})
