import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryRunJournal,
  JournalRecorder,
  resolveRunJournal,
  type RunJournal,
} from '../src/journal/journal.js'
import { JsonlRunJournal } from '../src/journal/jsonl-journal.js'
import { isRunEvent } from '../src/journal/events.js'
import type { RunEvent } from '../src/journal/events.js'

function event(seq: number, overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    type: 'turn/start',
    seq,
    timestampUnixMs: 1_700_000_000_000 + seq,
    runId: 'run-1',
    attempt: 1,
    turn: seq,
    ...overrides,
  } as RunEvent
}

const tempDirs: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oma-journal-'))
  tempDirs.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('InMemoryRunJournal', () => {
  it('retains the tail and evicts the oldest events past its bound', async () => {
    const journal = new InMemoryRunJournal({ maxEvents: 3 })
    await journal.append([event(1), event(2)])
    expect(journal.size).toBe(2)

    await journal.append([event(3), event(4), event(5)])
    expect(journal.size).toBe(3)

    const retained = await journal.readFrom(0)
    expect(retained.map((e) => e.seq)).toEqual([3, 4, 5])
  })

  it('readFrom returns only events at or above the requested sequence', async () => {
    const journal = new InMemoryRunJournal()
    await journal.append([event(1), event(2), event(3)])

    expect((await journal.readFrom(2)).map((e) => e.seq)).toEqual([2, 3])
    expect(await journal.readFrom(9)).toEqual([])
    expect(await journal.readFrom(0)).toHaveLength(3)
  })

  it('rejects a non-positive bound rather than silently retaining nothing', () => {
    expect(() => new InMemoryRunJournal({ maxEvents: 0 })).toThrow(/positive integer/)
    expect(() => new InMemoryRunJournal({ maxEvents: 1.5 })).toThrow(/positive integer/)
  })
})

describe('JsonlRunJournal', () => {
  it('round-trips appended events through the file', async () => {
    const path = await tempFile('run.jsonl')
    const journal = new JsonlRunJournal(path, { flushIntervalMs: 0 })
    await journal.append([event(1), event(2)])
    await journal.append([event(3)])
    await journal.close()

    const read = await new JsonlRunJournal(path).readFrom(2)
    expect(read.map((e) => e.seq)).toEqual([2, 3])
  })

  it('opens the batching window on the first pending event and does not reset it', async () => {
    const path = await tempFile('batched.jsonl')
    // Whether the window reset is a question about *when* the batch flushed.
    // Measuring that against the wall clock made this test ride on how promptly
    // a loaded runner fires a timer, and it failed twice on margins that looked
    // generous. Driving the clock instead makes the answer exact: the flush
    // either lands on the deadline the first append opened or it does not.
    const flushIntervalMs = 600
    const journal = new JsonlRunJournal(path, { flushIntervalMs })
    const readRaw = async (): Promise<string> => await readFile(path, 'utf8').catch(() => '')

    vi.useFakeTimers()
    try {
      const first = journal.append([event(1)])
      // A later append lands inside the window opened by the first one. A
      // window that reset here would move the deadline from 600ms to 900ms.
      await vi.advanceTimersByTimeAsync(flushIntervalMs / 2)
      const second = journal.append([event(2)])
      // Still inside the original window, so nothing can have been written yet.
      // This also fails loudly if the setup drifts the other way: had the first
      // window already fired, these would be two batches and the assertions
      // below would be measuring nothing.
      expect(await readRaw()).toBe('')
      expect(vi.getTimerCount()).toBe(1)

      // One tick short of the deadline the first append opened.
      await vi.advanceTimersByTimeAsync(flushIntervalMs / 2 - 1)
      expect(await readRaw()).toBe('')

      // Reaching that deadline flushes both appends. flushPending() clears the
      // timer before writing, so an empty queue afterwards is what rules out a
      // second, later deadline left behind by the reopened window.
      await vi.advanceTimersByTimeAsync(1)
      expect(vi.getTimerCount()).toBe(0)
      await Promise.all([first, second])
    } finally {
      vi.useRealTimers()
    }

    // One write, so both lines are in the file at the same instant.
    const raw = await readFile(path, 'utf8')
    expect(raw.split('\n').filter((line) => line.length > 0)).toHaveLength(2)
    await journal.close()
  })

  it('ignores a trailing partial line left by a crash mid-write', async () => {
    const path = await tempFile('torn.jsonl')
    const journal = new JsonlRunJournal(path, { flushIntervalMs: 0 })
    await journal.append([event(1), event(2)])
    await journal.close()

    const raw = await readFile(path, 'utf8')
    await writeFile(path, `${raw}{"type":"turn/start","seq":3,"run`, 'utf8')

    const read = await new JsonlRunJournal(path).readFrom(0)
    expect(read.map((e) => e.seq)).toEqual([1, 2])
  })

  it('rejects corruption that is not a trailing partial line', async () => {
    const path = await tempFile('corrupt.jsonl')
    await writeFile(path, 'not json\n{"type":"turn/start","seq":2,"timestampUnixMs":1,"runId":"r","attempt":1}\n', 'utf8')
    await expect(new JsonlRunJournal(path).readFrom(0)).rejects.toThrow(/line 1/)
  })

  it('treats a missing file as an empty journal', async () => {
    const path = await tempFile('absent.jsonl')
    expect(await new JsonlRunJournal(path).readFrom(0)).toEqual([])
  })

  it('redacts at write time, so readFrom returns what was persisted', async () => {
    const path = await tempFile('redacted.jsonl')
    const journal = new JsonlRunJournal(path, {
      flushIntervalMs: 0,
      redact: { patterns: [/hunter2/g] },
    })
    await journal.append([event(1, {
      type: 'user/message',
      origin: 'input',
      message: { role: 'user', content: [{ type: 'text', text: 'password is hunter2' }] },
    } as Partial<RunEvent>)])
    await journal.close()

    const [persisted] = await new JsonlRunJournal(path).readFrom(0)
    expect(persisted?.type).toBe('user/message')
    expect(JSON.stringify(persisted)).not.toContain('hunter2')
    expect(JSON.stringify(persisted)).toContain('[redacted]')
  })

  it('flushes the open batch on close', async () => {
    const path = await tempFile('closed.jsonl')
    const journal = new JsonlRunJournal(path, { flushIntervalMs: 10_000 })
    void journal.append([event(1)])
    expect(await readFile(path, 'utf8').catch(() => '')).toBe('')

    await journal.close()
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('refuses appends after close instead of dropping them silently', async () => {
    const path = await tempFile('after-close.jsonl')
    const journal = new JsonlRunJournal(path, { flushIntervalMs: 0 })
    await journal.close()
    await expect(journal.append([event(1)])).rejects.toThrow(/closed/)
  })
})

describe('isRunEvent', () => {
  it('accepts a well-formed event and rejects malformed envelopes', () => {
    expect(isRunEvent(event(1))).toBe(true)
    expect(isRunEvent({ ...event(1), type: 'not/a/type' })).toBe(false)
    expect(isRunEvent({ ...event(1), seq: 0 })).toBe(false)
    expect(isRunEvent({ ...event(1), seq: 1.5 })).toBe(false)
    expect(isRunEvent({ ...event(1), runId: 7 })).toBe(false)
    expect(isRunEvent(null)).toBe(false)
    expect(isRunEvent([event(1)])).toBe(false)
  })
})

describe('JournalRecorder', () => {
  it('assigns strictly increasing sequences and flushes them to the backend', async () => {
    const journal = new InMemoryRunJournal()
    const recorder = await JournalRecorder.open({ journal, runId: 'run-1', attempt: 1 })

    const first = recorder.emit({ type: 'turn/start', turn: 1 })
    const second = recorder.emit({ type: 'turn/end', turn: 1, outcome: 'completed' })
    expect([first, second]).toEqual([1, 2])
    expect(recorder.lastSeq).toBe(2)

    await recorder.flush()
    const written = await journal.readFrom(0)
    expect(written.map((e) => e.seq)).toEqual([1, 2])
    expect(written[0]).toMatchObject({ runId: 'run-1', attempt: 1, type: 'turn/start' })
  })

  it('continues the sequence when it re-attaches to a non-empty journal', async () => {
    const journal = new InMemoryRunJournal()
    const first = await JournalRecorder.open({ journal, runId: 'run-1', attempt: 1 })
    first.emit({ type: 'turn/start', turn: 1 })
    first.emit({ type: 'turn/end', turn: 1, outcome: 'completed' })
    await first.flush()

    const resumed = await JournalRecorder.open({ journal, runId: 'run-1', attempt: 2 })
    expect(resumed.emit({ type: 'turn/start', turn: 2 })).toBe(3)
    await resumed.flush()
    expect((await journal.readFrom(0)).map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('batches whatever accumulated while the previous append was in flight', async () => {
    const batches: number[][] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const journal: RunJournal = {
      async append(events) {
        batches.push(events.map((e) => e.seq))
        if (batches.length === 1) await gate
      },
      async readFrom() { return [] },
      async close() {},
    }
    const recorder = await JournalRecorder.open({ journal, runId: 'run-1', attempt: 1 })

    recorder.emit({ type: 'turn/start', turn: 1 })
    await Promise.resolve()
    recorder.emit({ type: 'turn/start', turn: 2 })
    recorder.emit({ type: 'turn/start', turn: 3 })
    release!()
    await recorder.flush()

    expect(batches).toEqual([[1], [2, 3]])
  })

  it('reports an append failure once and keeps recording', async () => {
    const errors: unknown[] = []
    let failNext = true
    const journal: RunJournal = {
      async append() {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
      },
      async readFrom() { return [] },
      async close() {},
    }
    const recorder = await JournalRecorder.open({
      journal,
      runId: 'run-1',
      attempt: 1,
      onError: (error) => errors.push(error),
    })

    recorder.emit({ type: 'turn/start', turn: 1 })
    await recorder.flush()
    expect(errors).toHaveLength(1)

    recorder.emit({ type: 'turn/start', turn: 2 })
    await expect(recorder.flush()).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  it('reports an unreadable tail and still records from a fresh sequence', async () => {
    const errors: unknown[] = []
    const journal: RunJournal = {
      async append() {},
      async readFrom() { throw new Error('unreadable') },
      async close() {},
    }
    const recorder = await JournalRecorder.open({
      journal,
      runId: 'run-1',
      attempt: 1,
      onError: (error) => errors.push(error),
    })
    expect(errors).toHaveLength(1)
    expect(recorder.emit({ type: 'turn/start', turn: 1 })).toBe(1)
  })

  it('tracks block lineage by identity and caches the content hash', async () => {
    const recorder = await JournalRecorder.open({
      journal: new InMemoryRunJournal(),
      runId: 'run-1',
      attempt: 1,
    })
    const tracked = { type: 'text', text: 'hello' } as const
    const untracked = { type: 'text', text: 'hello' } as const

    recorder.registerBlocks([tracked], [7])
    expect(recorder.lineageFor(tracked)).toEqual([7])
    expect(recorder.lineageFor(untracked)).toBeNull()
    // Structurally identical blocks hash identically; identity only decides lineage.
    expect(recorder.hashFor(tracked)).toBe(recorder.hashFor(untracked))
    expect(recorder.hashFor(tracked)).toMatch(/^[0-9a-f]{64}$/)
    // Hashing an unlineaged block must not invent lineage for it.
    expect(recorder.lineageFor(untracked)).toBeNull()
  })
})

describe('resolveRunJournal', () => {
  const journal = new InMemoryRunJournal()
  const other = new InMemoryRunJournal()

  it('accepts a bare journal instance as enabled with enforcement off', () => {
    expect(resolveRunJournal(undefined, journal)).toEqual({ journal, enforceLineage: false })
  })

  it('lets a per-call value override config and false disable one run', () => {
    expect(resolveRunJournal(journal, other)?.journal).toBe(other)
    expect(resolveRunJournal(journal, undefined)?.journal).toBe(journal)
    expect(resolveRunJournal(journal, false)).toBeUndefined()
  })

  it('honours enabled: false and enforceLineage on the options form', () => {
    expect(resolveRunJournal({ journal, enabled: false }, undefined)).toBeUndefined()
    expect(resolveRunJournal({ journal, enforceLineage: true }, undefined))
      .toEqual({ journal, enforceLineage: true })
  })

  it('returns undefined when nothing is configured', () => {
    expect(resolveRunJournal(undefined, undefined)).toBeUndefined()
  })
})
