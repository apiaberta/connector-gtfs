import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bulkInsert, createBatchWriter, insertBatches } from '../src/ingest/swap.js'
import { WRITE_BATCH } from '../src/config.js'

describe('bulkWrite batches', () => {
  it('bulkInsert emits unordered insertOne ops', async () => {
    const opsSeen = []
    const Model = {
      bulkWrite: async (ops, opts) => {
        opsSeen.push({ ops, opts })
      }
    }
    await bulkInsert(Model, [{ a: 1 }, { a: 2 }])
    assert.equal(opsSeen[0].ops.length, 2)
    assert.deepEqual(opsSeen[0].ops[0], { insertOne: { document: { a: 1 } } })
    assert.equal(opsSeen[0].opts.ordered, false)
  })

  it('createBatchWriter flushes at WRITE_BATCH', async () => {
    const sizes = []
    const Model = {
      bulkWrite: async (ops) => { sizes.push(ops.length) }
    }
    const w = createBatchWriter(Model, 3)
    await w.push({ n: 1 })
    await w.push({ n: 2 })
    assert.deepEqual(sizes, [])
    await w.push({ n: 3 })
    assert.deepEqual(sizes, [3])
    await w.push({ n: 4 })
    await w.flush()
    assert.deepEqual(sizes, [3, 1])
  })

  it('insertBatches chunks at WRITE_BATCH', async () => {
    const sizes = []
    const Model = {
      bulkWrite: async (ops) => { sizes.push(ops.length) }
    }
    const docs = Array.from({ length: WRITE_BATCH + 2 }, (_, i) => ({ i }))
    await insertBatches(Model, docs)
    assert.deepEqual(sizes, [WRITE_BATCH, 2])
  })
})
