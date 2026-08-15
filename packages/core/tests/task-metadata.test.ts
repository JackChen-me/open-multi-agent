import { describe, expect, it, vi } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { Checkpoint } from '../src/memory/checkpoint.js'
import { InMemoryStore } from '../src/memory/store.js'
import { buildExecutionReceipt } from '../src/observability/execution-receipt.js'
import { TRACE_RECORD_OBSERVER } from '../src/observability/runtime.js'
import type { TraceRecord } from '../src/observability/records.js'
import type {
  AgentConfig,
  AgentRunResult,
  OrchestratorConfig,
  TaskMetadata,
  TraceEvent,
} from '../src/types.js'

function worker(afterRun?: (result: AgentRunResult) => AgentRunResult): AgentConfig {
  return {
    name: 'supplier-reader-01',
    systemPrompt: 'Read one supplier document.',
    backend: {
      kind: 'process',
      command: process.execPath,
      args: ['-e', `process.stdout.write('read complete')`],
    },
    ...(afterRun ? { afterRun } : {}),
  }
}

describe('task role and metadata', () => {
  it('preserves bounded metadata through result, trace, checkpoint, restore, and receipt', async () => {
    const store = new InMemoryStore()
    const records: TraceRecord[] = []
    const legacyTrace: TraceEvent[] = []
    const config = {
      defaultModel: 'mock-model',
      onTrace(event: TraceEvent) {
        legacyTrace.push(event)
      },
      [TRACE_RECORD_OBSERVER](record: TraceRecord) {
        records.push(record)
      },
    } as OrchestratorConfig & {
      [TRACE_RECORD_OBSERVER]: (record: TraceRecord) => void
    }
    const oma = new OpenMultiAgent(config)
    const team = oma.createTeam('task-metadata', {
      name: 'task-metadata',
      agents: [worker()],
    })
    const metadata: TaskMetadata = {
      sourceFile: 'fixtures/supplier-01.json',
      supplierId: 'supplier-01',
      auditRef: 'reference sk-abcdefghijklmnopqrstuvwxyz',
      batch: 4,
    }

    const result = await oma.runTasks(team, [{
      title: 'Read supplier reply',
      description: 'Extract one simulated supplier reply.',
      assignee: 'supplier-reader-01',
      role: 'supplier-extraction',
      metadata,
    }], { checkpoint: { store, runId: 'task-metadata' } })

    const task = result.tasks?.[0]
    expect(task).toMatchObject({
      assignee: 'supplier-reader-01',
      role: 'supplier-extraction',
      metadata: {
        sourceFile: 'fixtures/supplier-01.json',
        supplierId: 'supplier-01',
        auditRef: 'reference [redacted]',
        batch: 4,
      },
    })
    expect(Object.isFrozen(task?.metadata)).toBe(true)

    const taskSpan = records.find(record =>
      record.recordType === 'span_start'
      && record.kind === 'task'
      && record.name === 'execute_task')
    expect(taskSpan?.attributes).toMatchObject({
      'oma.task.role': 'supplier-extraction',
      'oma.task.meta.sourceFile': 'fixtures/supplier-01.json',
      'oma.task.meta.supplierId': 'supplier-01',
      'oma.task.meta.auditRef': 'reference [redacted]',
      'oma.task.meta.batch': 4,
    })
    expect(legacyTrace.find(event => event.type === 'task')).toMatchObject({
      taskRole: 'supplier-extraction',
      taskMetadata: task?.metadata,
    })

    const snapshot = await new Checkpoint(store, { runId: 'task-metadata' }).loadLatest()
    expect(snapshot?.queue.tasks[0]).toMatchObject({
      role: 'supplier-extraction',
      metadata: task?.metadata,
    })

    const restoredOma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const restoredTeam = restoredOma.createTeam('task-metadata-restored', {
      name: 'task-metadata-restored',
      agents: [worker()],
    })
    const restored = await restoredOma.restore(restoredTeam, {
      checkpoint: { store, runId: 'task-metadata' },
    })
    expect(restored.tasks?.[0]).toMatchObject({
      role: 'supplier-extraction',
      metadata: task?.metadata,
    })

    expect(buildExecutionReceipt(result)).toMatchObject({
      rolesExecuted: ['supplier-reader-01'],
      workerInstancesExecuted: ['supplier-reader-01'],
      taskRolesExecuted: ['supplier-extraction'],
    })
  })

  it('rejects credential-like metadata keys before an agent runs', async () => {
    const afterRun = vi.fn((result: AgentRunResult) => result)
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('invalid-task-metadata', {
      name: 'invalid-task-metadata',
      agents: [worker(afterRun)],
    })

    await expect(oma.runTasks(team, [{
      title: 'Read supplier reply',
      description: 'Should not start.',
      assignee: 'supplier-reader-01',
      metadata: { apiKey: 'must-not-persist' },
    }])).rejects.toThrow('credential-like')
    expect(afterRun).not.toHaveBeenCalled()
  })
})
