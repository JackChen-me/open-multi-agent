import { randomUUID } from 'node:crypto'
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_EVAL_STORE_FORMAT,
  FILE_EVAL_STORE_IO,
  FileEvalStore,
  FileEvalStoreError,
  type FileEvalStoreDiagnostic,
} from '../src/eval/file-store.js'
import type { EvalRecord } from '../src/eval/record.js'
import type {
  EvalDeleteQuery,
  EvalQuery,
  EvalRetentionPolicy,
  EvalStore,
} from '../src/eval/store.js'
import type { AppendResult, DeleteResult, Page } from '../src/observability/store.js'
import {
  evalRecord,
  runEvalStoreContractSuite,
  type EvalStoreContractFactoryOptions,
} from './helpers/eval-store-contract.js'

const temporaryRoots: string[] = []

async function temporaryPath(name = 'evaluations.ndjson'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oma-file-eval-store-'))
  temporaryRoots.push(root)
  return join(root, name)
}

class DeferredEvalStore implements EvalStore {
  constructor(private readonly pending: Promise<FileEvalStore>) {}

  append(records: readonly EvalRecord[]): Promise<AppendResult> {
    return this.pending.then((store) => store.append(records))
  }

  query(query?: EvalQuery): Promise<Page<EvalRecord>> {
    return this.pending.then((store) => store.query(query))
  }

  delete(query: EvalDeleteQuery): Promise<DeleteResult> {
    return this.pending.then((store) => store.delete(query))
  }

  applyRetention(policy: EvalRetentionPolicy): Promise<DeleteResult> {
    return this.pending.then((store) => store.applyRetention(policy))
  }
}

function contractStore(options: EvalStoreContractFactoryOptions = {}): EvalStore {
  const path = join(tmpdir(), `oma-file-eval-contract-${randomUUID()}.ndjson`)
  temporaryRoots.push(path)
  return new DeferredEvalStore(FileEvalStore.open(path, { now: options.now }))
}

runEvalStoreContractSuite('FileEvalStore', contractStore)

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

describe('FileEvalStore file format and recovery', () => {
  it('creates a versioned 0600 file with schema-bearing NDJSON and reopens identically', async () => {
    const path = await temporaryPath()
    const store = await FileEvalStore.open(path)
    await store.append([evalRecord({ recordId: 'reopen', status: 'scorer_error' })])
    const before = await store.query({ status: ['scorer_error'] })
    await store.flush()
    await store.close()

    const lines = (await readFile(path, 'utf8')).split('\n')
    expect(JSON.parse(lines[0]!)).toEqual({
      type: 'file_header',
      format: FILE_EVAL_STORE_FORMAT,
      formatVersion: 1,
      evalSchemaMajor: 1,
    })
    expect(lines.some((line) => line.includes('"schemaVersion":1'))).toBe(true)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)

    const reopened = await FileEvalStore.open(path)
    expect(await reopened.query({ status: ['scorer_error'] })).toEqual(before)
    await reopened.close()
  })

  it('serializes concurrent same-instance append batches in invocation order', async () => {
    const path = await temporaryPath()
    const store = await FileEvalStore.open(path)
    await Promise.all(['a', 'b', 'c', 'd'].map((recordId, index) =>
      store.append([evalRecord({ recordId, timestamp: 1_000 + index })])))
    expect((await store.query({ order: 'time_asc' })).items.map((record) => record.recordId))
      .toEqual(['a', 'b', 'c', 'd'])
    const loggedIds = (await readFile(path, 'utf8')).split('\n')
      .filter((line) => line.includes('"type":"batch_item"'))
      .map((line) => (JSON.parse(line) as { payload: { recordId: string } }).payload.recordId)
    expect(loggedIds).toEqual(['a', 'b', 'c', 'd'])
    await store.close()
  })

  it('hides an entire batch when the file ends midway through it', async () => {
    const path = await temporaryPath()
    const store = await FileEvalStore.open(path)
    await store.append([
      evalRecord({ recordId: 'half-a' }),
      evalRecord({ recordId: 'half-b' }),
    ])
    await store.close()
    const lines = (await readFile(path, 'utf8')).split('\n')
    await writeFile(path, `${lines.slice(0, 3).join('\n')}\n`, 'utf8')

    const diagnostics: FileEvalStoreDiagnostic[] = []
    const reopened = await FileEvalStore.open(path, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    expect((await reopened.query()).items).toHaveLength(0)
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'incomplete_batch' })])
    expect((await readFile(path, 'utf8')).split('\n')).toHaveLength(2)
    await reopened.close()
  })

  it('recovers a trailing partial line with a diagnostic and preserves prior commits', async () => {
    const path = await temporaryPath()
    const store = await FileEvalStore.open(path)
    await store.append([evalRecord({ recordId: 'committed' })])
    await store.close()
    const committed = await readFile(path, 'utf8')
    await appendFile(path, '{"type":"batch_start"', 'utf8')

    const diagnostics: FileEvalStoreDiagnostic[] = []
    const reopened = await FileEvalStore.open(path, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    expect((await reopened.query()).items.map((record) => record.recordId)).toEqual(['committed'])
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'trailing_partial_line' })])
    expect(await readFile(path, 'utf8')).toBe(committed)
    await reopened.close()
  })

  it('rejects complete corruption and unsupported file or evaluation schema versions', async () => {
    const corruptPath = await temporaryPath('corrupt.ndjson')
    await writeFile(corruptPath, `${JSON.stringify({
      type: 'file_header', format: FILE_EVAL_STORE_FORMAT,
      formatVersion: 1, evalSchemaMajor: 1,
    })}\n{invalid-json}\n`)
    await expect(FileEvalStore.open(corruptPath)).rejects.toMatchObject({ code: 'CORRUPT_FILE' })

    const formatPath = await temporaryPath('format.ndjson')
    await writeFile(formatPath, `${JSON.stringify({
      type: 'file_header', format: FILE_EVAL_STORE_FORMAT,
      formatVersion: 99, evalSchemaMajor: 1,
    })}\n`)
    await expect(FileEvalStore.open(formatPath)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_FORMAT' })

    const schemaPath = await temporaryPath('schema.ndjson')
    await writeFile(schemaPath, `${JSON.stringify({
      type: 'file_header', format: FILE_EVAL_STORE_FORMAT,
      formatVersion: 1, evalSchemaMajor: 99,
    })}\n`)
    await expect(FileEvalStore.open(schemaPath)).rejects.toMatchObject({ code: 'UNSUPPORTED_EVAL_SCHEMA' })
  })

  it('preserves deduplication, delete, and retention effects across reopen', async () => {
    const path = await temporaryPath()
    const store = await FileEvalStore.open(path, { now: () => 10_000 })
    const duplicate = evalRecord({
      recordId: 'dedupe-reopen', evalRunId: 'dedupe', timestamp: 9_500,
    })
    await store.append([
      duplicate,
      evalRecord({ recordId: 'delete-reopen', evalRunId: 'delete' }),
      evalRecord({ recordId: 'retention-reopen', evalRunId: 'retention', timestamp: 1_000 }),
      evalRecord({ recordId: 'keep-reopen', evalRunId: 'keep', timestamp: 9_000 }),
    ])
    await store.delete({ evalRunId: 'delete' })
    await store.applyRetention({ maxAgeMs: 5_000 })
    await store.close()

    const reopened = await FileEvalStore.open(path, { now: () => 10_000 })
    await expect(reopened.append([duplicate])).resolves.toMatchObject({ written: 0, deduplicated: 1 })
    expect((await reopened.query({ order: 'time_asc' })).items.map((record) => record.recordId))
      .toEqual(['keep-reopen', 'dedupe-reopen'])
    await reopened.close()
  })

  it('declares cursors instance-bound by rejecting them after reopen', async () => {
    const path = await temporaryPath()
    const store = await FileEvalStore.open(path)
    await store.append([
      evalRecord({ recordId: 'cursor-a', timestamp: 1_000 }),
      evalRecord({ recordId: 'cursor-b', timestamp: 2_000 }),
    ])
    const cursor = (await store.query({ limit: 1 })).nextCursor!
    await store.close()
    const reopened = await FileEvalStore.open(path)
    await expect(reopened.query({ limit: 1, cursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    await reopened.close()
  })
})

describe('FileEvalStore lifecycle and filesystem failures', () => {
  it('makes flush repeatable, close idempotent, and post-close operations structured errors', async () => {
    const path = await temporaryPath()
    const store = await FileEvalStore.open(path)
    await store.append([evalRecord({ recordId: 'lifecycle' })])
    await expect(store.flush()).resolves.toBeUndefined()
    await expect(store.flush()).resolves.toBeUndefined()
    const first = store.close()
    const second = store.close()
    expect(second).toBe(first)
    await expect(first).resolves.toBeUndefined()
    await expect(store.close()).resolves.toBeUndefined()
    await expect(store.query()).rejects.toMatchObject({ code: 'CLOSED' })
    await expect(store.append([evalRecord({ recordId: 'closed' })])).rejects.toMatchObject({ code: 'CLOSED' })
    await expect(store.delete({})).rejects.toMatchObject({ code: 'CLOSED' })
    await expect(store.applyRetention({ maxRecords: 1 })).rejects.toMatchObject({ code: 'CLOSED' })
    await expect(store.flush()).rejects.toMatchObject({ code: 'CLOSED' })
    await expect(store.compact()).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('rolls back memory and disk state when a write fails', async () => {
    const path = await temporaryPath()
    const store = await FileEvalStore.open(path)
    vi.spyOn(FILE_EVAL_STORE_IO, 'writeFile').mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    )
    await expect(store.append([evalRecord({ recordId: 'write-failed' })])).rejects.toMatchObject({
      code: 'WRITE_FAILED', causeCode: 'ENOSPC',
    })
    expect((await store.query()).items).toHaveLength(0)
    vi.restoreAllMocks()
    await store.append([evalRecord({ recordId: 'after-failure' })])
    await store.close()
    const reopened = await FileEvalStore.open(path)
    expect((await reopened.query()).items.map((record) => record.recordId)).toEqual(['after-failure'])
    await reopened.close()
  })

  it('keeps the original authoritative when compaction rename fails', async () => {
    const path = await temporaryPath()
    const store = await FileEvalStore.open(path)
    await store.append([evalRecord({ recordId: 'rename-safe' })])
    const before = await readFile(path, 'utf8')
    vi.spyOn(FILE_EVAL_STORE_IO, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('rename denied'), { code: 'EACCES' }),
    )
    await expect(store.compact()).rejects.toMatchObject({ code: 'RENAME_FAILED', causeCode: 'EACCES' })
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await store.query()).items.map((record) => record.recordId)).toEqual(['rename-safe'])
    vi.restoreAllMocks()
    await store.close()
  })

  it('keeps the original authoritative when compaction temp fsync fails', async () => {
    const path = await temporaryPath()
    const store = await FileEvalStore.open(path)
    await store.append([evalRecord({ recordId: 'sync-safe' })])
    const before = await readFile(path, 'utf8')
    vi.spyOn(FILE_EVAL_STORE_IO, 'sync').mockRejectedValueOnce(
      Object.assign(new Error('sync denied'), { code: 'EIO' }),
    )
    await expect(store.compact()).rejects.toMatchObject({ code: 'COMPACTION_FAILED', causeCode: 'EIO' })
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await store.query()).items.map((record) => record.recordId)).toEqual(['sync-safe'])
    vi.restoreAllMocks()
    await store.close()
  })
})

describe('FileEvalStore compaction', () => {
  it('preserves queries, removes deleted data, and is byte-deterministic', async () => {
    const path = await temporaryPath()
    const store = await FileEvalStore.open(path)
    await store.append([
      evalRecord({ recordId: 'deleted', evalRunId: 'deleted-run', timestamp: 1_000 }),
      evalRecord({ recordId: 'kept', evalRunId: 'kept-run', timestamp: 2_000 }),
    ])
    await store.delete({ evalRunId: 'deleted-run' })
    const before = await store.query({ order: 'time_asc' })
    const first = await store.compact()
    const compactedOnce = await readFile(path, 'utf8')
    expect(compactedOnce).not.toContain('"recordId":"deleted"')
    expect(await store.query({ order: 'time_asc' })).toEqual(before)
    const second = await store.compact()
    const compactedTwice = await readFile(path, 'utf8')
    expect(compactedTwice).toBe(compactedOnce)
    expect(second).toEqual(first)
    await store.close()

    const reopened = await FileEvalStore.open(path)
    expect(await reopened.query({ order: 'time_asc' })).toEqual(before)
    await reopened.close()
  })

  it('diagnoses a stale temp while keeping the target authoritative', async () => {
    const path = await temporaryPath()
    const store = await FileEvalStore.open(path)
    await store.append([evalRecord({ recordId: 'target-wins' })])
    await store.close()
    await writeFile(`${path}.compact.tmp`, 'interrupted compaction', 'utf8')

    const diagnostics: FileEvalStoreDiagnostic[] = []
    const reopened = await FileEvalStore.open(path, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    expect((await reopened.query()).items.map((record) => record.recordId)).toEqual(['target-wins'])
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'stale_compaction_file' })])
    await reopened.close()
  })

  it('fails loudly when only a stale compaction temp exists', async () => {
    const path = await temporaryPath()
    await writeFile(`${path}.compact.tmp`, 'possible committed data', 'utf8')
    await expect(FileEvalStore.open(path)).rejects.toMatchObject({ code: 'STALE_COMPACTION_FILE' })
  })
})

describe('FileEvalStore import boundary', () => {
  it('is exported only from the Node-only eval/file subpath module', async () => {
    const root = await import('../src/index.js')
    const evaluation = await import('../src/eval/index.js')
    const file = await import('../src/eval/file.js')
    expect(root).not.toHaveProperty('FileEvalStore')
    expect(evaluation).not.toHaveProperty('FileEvalStore')
    expect(file.FileEvalStore).toBe(FileEvalStore)
  })

  it('uses payload-free structured corruption errors', async () => {
    const path = await temporaryPath()
    const secret = 'secret-evaluation-payload'
    await writeFile(path, `${JSON.stringify({
      type: 'file_header', format: FILE_EVAL_STORE_FORMAT,
      formatVersion: 1, evalSchemaMajor: 1,
    })}\n{${secret}}\n`)
    const error = await FileEvalStore.open(path).catch((caught) => caught as FileEvalStoreError)
    expect(error).toBeInstanceOf(FileEvalStoreError)
    expect(error.code).toBe('CORRUPT_FILE')
    expect(error.message).not.toContain(secret)
  })
})
