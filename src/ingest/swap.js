import { WRITE_BATCH } from '../config.js'

export async function bulkInsert(Model, docs) {
  if (!docs?.length) return
  const chunk = docs
  await Model.bulkWrite(
    chunk.map((document) => ({ insertOne: { document } })),
    { ordered: false }
  )
}

export function createBatchWriter(Model, batchSize = WRITE_BATCH) {
  let batch = []
  return {
    async push(doc) {
      batch.push(doc)
      if (batch.length >= batchSize) {
        const chunk = batch
        batch = []
        await bulkInsert(Model, chunk)
      }
    },
    async flush() {
      if (!batch.length) return
      const chunk = batch
      batch = []
      await bulkInsert(Model, chunk)
    }
  }
}

export async function replaceByFeed(Model, feedId, docs, extraFilter = {}) {
  await Model.deleteMany({ feed_id: feedId, ...extraFilter })
  await insertBatches(Model, docs)
}

export async function insertBatches(Model, docs) {
  for (let i = 0; i < docs.length; i += WRITE_BATCH) {
    const chunk = docs.slice(i, i + WRITE_BATCH)
    if (chunk.length) {
      await bulkInsert(Model, chunk)
    }
  }
}

export async function bulkUpsert(Model, docs, keys) {
  const ops = []
  for (const doc of docs) {
    const filter = {}
    for (const k of keys) filter[k] = doc[k]
    ops.push({
      updateOne: {
        filter,
        update: { $set: doc },
        upsert: true
      }
    })
    if (ops.length >= WRITE_BATCH) {
      await Model.bulkWrite(ops, { ordered: false })
      ops.length = 0
    }
  }
  if (ops.length) await Model.bulkWrite(ops, { ordered: false })
}

export async function pruneOlderThan(Model, feedId, keep) {
  const extra = await Model.find({ feed_id: feedId })
    .sort({ detected_at: -1 })
    .skip(keep)
    .select('_id')
    .lean()
  if (extra.length) {
    await Model.deleteMany({ _id: { $in: extra.map((d) => d._id) } })
  }
}
