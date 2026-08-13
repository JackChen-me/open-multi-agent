import { mkdir, open, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

export const pipelineTraceStageSchema = z.enum([
  'admission',
  'coding',
  'validation',
  'review',
  'proposal',
])

export const pipelineTraceStatusSchema = z.enum(['start', 'complete', 'failure'])
export const claudeCodeTokenUsageSchema = z.enum(['not_reported', 'not_applicable'])

const timestamp = z.string().datetime()
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

export const pipelineTraceEventSchema = z.object({
  stage: pipelineTraceStageSchema,
  status: pipelineTraceStatusSchema,
  at: timestamp,
}).strict()

export const pipelineTraceArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('oma-maintainer-pipeline-trace'),
  runKey: sha256,
  issueNumber: z.number().int().positive(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  claudeCodeTokenUsage: claudeCodeTokenUsageSchema,
  events: z.array(pipelineTraceEventSchema).max(10),
}).strict()

export type PipelineTraceStage = z.infer<typeof pipelineTraceStageSchema>
export type PipelineTraceStatus = z.infer<typeof pipelineTraceStatusSchema>
export type ClaudeCodeTokenUsage = z.infer<typeof claudeCodeTokenUsageSchema>
export type PipelineTraceArtifact = z.infer<typeof pipelineTraceArtifactSchema>

export class PipelineTraceWriter {
  readonly path: string
  private readonly artifact: PipelineTraceArtifact

  constructor(options: {
    readonly artifactDir: string
    readonly runKey: string
    readonly issueNumber: number
    readonly baseSha: string
    readonly claudeCodeTokenUsage: ClaudeCodeTokenUsage
  }) {
    this.path = resolve(options.artifactDir, `${options.runKey}.pipeline-trace.json`)
    this.artifact = pipelineTraceArtifactSchema.parse({
      schemaVersion: 1,
      kind: 'oma-maintainer-pipeline-trace',
      runKey: options.runKey,
      issueNumber: options.issueNumber,
      baseSha: options.baseSha,
      claudeCodeTokenUsage: options.claudeCodeTokenUsage,
      events: [],
    })
  }

  async record(stage: PipelineTraceStage, status: PipelineTraceStatus, now: () => Date): Promise<void> {
    const event = pipelineTraceEventSchema.parse({ stage, status, at: now().toISOString() })
    const prior = this.artifact.events.at(-1)
    if (status === 'start') {
      if (prior?.status === 'start') throw new Error('Pipeline trace cannot start a stage before the prior stage ends.')
    } else if (prior?.stage !== stage || prior.status !== 'start') {
      throw new Error('Pipeline trace completion must close the active stage.')
    }
    this.artifact.events.push(event)
    pipelineTraceArtifactSchema.parse(this.artifact)
    await atomicWriteJson(this.path, this.artifact)
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}
