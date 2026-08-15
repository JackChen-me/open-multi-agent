import { open, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { assertTransition } from './admission.js'
import { hashJson } from './hash.js'
import { maintainerStateSchema, type MaintainerState } from './schema.js'

export const runRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runKey: z.string().regex(/^[0-9a-f]{64}$/),
  runId: z.string().min(1),
  repository: z.string().min(1),
  issueNumber: z.number().int().positive(),
  issueRevision: z.string().regex(/^[0-9a-f]{64}$/),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  status: maintainerStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  leaseExpiresAt: z.string(),
  contextManifestHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  proposalHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  detail: z.string().max(10_000).optional(),
})

export type RunRecord = z.infer<typeof runRecordSchema>

const leaseSchema = z.object({
  runId: z.string().min(1),
  expiresAt: z.string(),
})

export interface ClaimRunInput {
  readonly runId: string
  readonly repository: string
  readonly issueNumber: number
  readonly issueRevision: string
  readonly baseSha: string
  readonly leaseMs?: number
}

export type ClaimRunResult =
  | { readonly claimed: true; readonly record: RunRecord }
  | {
      readonly claimed: false
      readonly record: RunRecord
      readonly reason: 'duplicate' | 'concurrent' | 'stale-needs-human'
    }

export interface RunStateStore {
  claim(input: ClaimRunInput): Promise<ClaimRunResult>
  attachContext(runId: string, runKey: string, manifestHash: string): Promise<RunRecord>
  transition(
    runId: string,
    runKey: string,
    to: MaintainerState,
    detail?: string,
    proposalHash?: string,
  ): Promise<RunRecord>
  failStaleRun(runKey: string, expectedRunId: string, detail: string): Promise<RunRecord>
  get(runKey: string): Promise<RunRecord | null>
}

export class FileRunStateStore implements RunStateStore {
  readonly root: string
  private readonly now: () => Date

  constructor(root: string, options: { now?: () => Date } = {}) {
    this.root = resolve(root)
    this.now = options.now ?? (() => new Date())
  }

  async claim(input: ClaimRunInput): Promise<ClaimRunResult> {
    validateLeaseMs(input.leaseMs ?? 20 * 60_000)
    await mkdir(this.root, { recursive: true })
    const runKey = computeRunKey(input)
    const recordPath = this.recordPath(runKey)
    const leasePath = this.leasePath(runKey)
    const leaseMs = input.leaseMs ?? 20 * 60_000
    const expiresAt = new Date(this.now().getTime() + leaseMs).toISOString()
    const lease = await this.acquireLease(leasePath, input.runId, expiresAt)
    if (!lease.acquired) {
      const existing = await this.waitForRecord(recordPath)
      if (existing !== null) return { claimed: false, record: existing, reason: 'concurrent' }
      throw new Error('A concurrent run holds the issue lease before its state record became visible.')
    }

    try {
      const existing = await this.readRecord(recordPath)
      if (existing !== null) {
        if (existing.status === 'RUNNING') {
          const stale = await this.markRunningNeedsHuman(
            existing,
            'The prior process lost or exceeded its lease. Automatic takeover is forbidden; a maintainer must revalidate and issue a new revision/base authorization.',
          )
          await safeUnlink(leasePath)
          return { claimed: false, record: stale, reason: 'stale-needs-human' }
        }
        await safeUnlink(leasePath)
        return { claimed: false, record: existing, reason: 'duplicate' }
      }
      const timestamp = this.now().toISOString()
      const record = runRecordSchema.parse({
        schemaVersion: 1,
        runKey,
        runId: input.runId,
        repository: input.repository,
        issueNumber: input.issueNumber,
        issueRevision: input.issueRevision,
        baseSha: input.baseSha,
        status: 'RUNNING',
        createdAt: timestamp,
        updatedAt: timestamp,
        leaseExpiresAt: expiresAt,
      })
      await atomicWriteJson(recordPath, record, true)
      return { claimed: true, record }
    } catch (error) {
      await safeUnlink(leasePath)
      throw error
    }
  }

  async attachContext(runId: string, runKey: string, manifestHash: string): Promise<RunRecord> {
    if (!/^[0-9a-f]{64}$/.test(manifestHash)) throw new Error('Invalid context manifest hash.')
    const record = await this.requireOwnedRun(runId, runKey)
    if (record.status !== 'RUNNING') throw new Error('Context can be attached only to a RUNNING record.')
    const updated = runRecordSchema.parse({
      ...record,
      contextManifestHash: manifestHash,
      updatedAt: this.now().toISOString(),
    })
    await atomicWriteJson(this.recordPath(runKey), updated)
    return updated
  }

  async transition(
    runId: string,
    runKey: string,
    to: MaintainerState,
    detail?: string,
    proposalHash?: string,
  ): Promise<RunRecord> {
    const record = await this.requireOwnedRun(runId, runKey)
    assertTransition(record.status, to)
    const updated = runRecordSchema.parse({
      ...record,
      status: to,
      updatedAt: this.now().toISOString(),
      ...(detail === undefined ? {} : { detail }),
      ...(proposalHash === undefined ? {} : { proposalHash }),
    })
    await atomicWriteJson(this.recordPath(runKey), updated)
    if (to !== 'RUNNING') await safeUnlink(this.leasePath(runKey))
    return updated
  }

  async failStaleRun(runKey: string, expectedRunId: string, detail: string): Promise<RunRecord> {
    if (detail.trim().length < 10) throw new Error('Stale-run resolution requires an auditable detail.')
    const existing = await this.get(runKey)
    if (existing === null) throw new Error(`Run record does not exist: ${runKey}`)
    if (existing.runId !== expectedRunId) throw new Error('Stale-run resolution runId does not match.')
    if (existing.status !== 'RUNNING') throw new Error('Only a RUNNING record can be marked stale.')

    const leasePath = this.leasePath(runKey)
    const lease = await readLease(leasePath)
    if (lease !== null && Date.parse(lease.expiresAt) > this.now().getTime()) {
      throw new Error('The RUNNING record still has an active lease and cannot be marked stale.')
    }
    const marker = await this.acquireLease(
      leasePath,
      `human-stale-resolution:${expectedRunId}`,
      new Date(this.now().getTime() + 60_000).toISOString(),
    )
    if (!marker.acquired) throw new Error('Another process currently owns the stale-run resolution lease.')
    try {
      const current = await this.get(runKey)
      if (current === null || current.runId !== expectedRunId || current.status !== 'RUNNING') {
        throw new Error('Run record changed while stale resolution was being acquired.')
      }
      return await this.markRunningNeedsHuman(current, detail)
    } finally {
      await safeUnlink(leasePath)
    }
  }

  async get(runKey: string): Promise<RunRecord | null> {
    return this.readRecord(this.recordPath(runKey))
  }

  private async acquireLease(
    path: string,
    runId: string,
    expiresAt: string,
  ): Promise<{ acquired: boolean; replacedExpiredLease: boolean }> {
    let replacedExpiredLease = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await open(path, 'wx', 0o600)
        try {
          await handle.writeFile(`${JSON.stringify({ runId, expiresAt })}\n`, 'utf8')
        } finally {
          await handle.close()
        }
        return { acquired: true, replacedExpiredLease }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const lease = await readLease(path)
        if (lease !== null && Date.parse(lease.expiresAt) > this.now().getTime()) {
          return { acquired: false, replacedExpiredLease: false }
        }
        await safeUnlink(path)
        replacedExpiredLease = true
      }
    }
    return { acquired: false, replacedExpiredLease }
  }

  private async markRunningNeedsHuman(record: RunRecord, detail: string): Promise<RunRecord> {
    assertTransition(record.status, 'NEEDS_HUMAN')
    const updated = runRecordSchema.parse({
      ...record,
      status: 'NEEDS_HUMAN',
      updatedAt: this.now().toISOString(),
      detail,
    })
    await atomicWriteJson(this.recordPath(record.runKey), updated)
    return updated
  }

  private async requireOwnedRun(runId: string, runKey: string): Promise<RunRecord> {
    const record = await this.readRecord(this.recordPath(runKey))
    if (record === null) throw new Error(`Run record does not exist: ${runKey}`)
    if (record.runId !== runId) throw new Error('Run record is owned by a different runId.')
    return record
  }

  private async readRecord(path: string): Promise<RunRecord | null> {
    try {
      return runRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async waitForRecord(path: string): Promise<RunRecord | null> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const record = await this.readRecord(path)
      if (record !== null) return record
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    return null
  }

  private recordPath(runKey: string): string {
    assertRunKey(runKey)
    return join(this.root, `${runKey}.json`)
  }

  private leasePath(runKey: string): string {
    assertRunKey(runKey)
    return join(this.root, `${runKey}.lease`)
  }
}

export function computeRunKey(input: Pick<ClaimRunInput,
  'repository' | 'issueNumber' | 'issueRevision' | 'baseSha'>): string {
  return hashJson({
    repository: input.repository,
    issueNumber: input.issueNumber,
    issueRevision: input.issueRevision,
    baseSha: input.baseSha,
  })
}

async function readLease(path: string): Promise<z.infer<typeof leaseSchema> | null> {
  try {
    return leaseSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SyntaxError || error instanceof z.ZodError) return null
    throw error
  }
}

async function atomicWriteJson(path: string, value: unknown, createOnly = false): Promise<void> {
  if (createOnly) {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    return
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function assertRunKey(runKey: string): void {
  if (!/^[0-9a-f]{64}$/.test(runKey)) throw new Error('Invalid run key.')
}

function validateLeaseMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 24 * 60 * 60_000) {
    throw new Error('leaseMs must be an integer between 1000 and 86400000.')
  }
}
