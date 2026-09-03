import { describe, expect, it } from 'vitest'
import { InMemoryEvalStore } from '../src/eval/store.js'
import { evalRecord, runEvalStoreContractSuite } from './helpers/eval-store-contract.js'

runEvalStoreContractSuite(
  'InMemoryEvalStore',
  (options = {}) => new InMemoryEvalStore({ now: options.now }),
)

describe('InMemoryEvalStore capacity', () => {
  it('rejects a batch atomically when maxRecords would be exceeded', async () => {
    const store = new InMemoryEvalStore({ maxRecords: 2 })
    await store.append([evalRecord({ recordId: 'capacity-first' })])
    await expect(store.append([
      evalRecord({ recordId: 'capacity-second' }),
      evalRecord({ recordId: 'capacity-third' }),
    ])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', field: 'records' })
    expect((await store.query()).items.map((record) => record.recordId))
      .toEqual(['capacity-first'])
  })
})
