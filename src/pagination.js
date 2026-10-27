function toInt(value) {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : parseInt(String(value), 10)
  return Number.isFinite(n) ? n : null
}

export function parsePagination(query = {}, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limitRaw = toInt(query.limit)
  const offsetRaw = toInt(query.offset)
  const limit = Math.min(Math.max(limitRaw == null ? defaultLimit : limitRaw, 1), maxLimit)
  const offset = Math.max(offsetRaw == null ? 0 : offsetRaw, 0)
  return { limit, offset }
}

export function pageResult(rows, total) {
  return {
    count: rows.length,
    total,
    data: rows
  }
}
