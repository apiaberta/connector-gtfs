import { HEAP_SOFT_LIMIT, DEPARTURE_SPLIT, DEPARTURE_WRITE_BATCH, DEPARTURE_FLUSH_ROWS } from '../config.js'
import { unionServices } from '../calendar.js'
import { packDep } from '../departures-read.js'
import { streamZipCsv } from './zip.js'
import { bulkInsert } from './swap.js'

function heapUsed() {
  return process.memoryUsage().heapUsed
}

export function tripFromRow(row) {
  return {
    trip_id: String(row.trip_id || ''),
    route_id: String(row.route_id || ''),
    service_id: String(row.service_id || ''),
    headsign: row.trip_headsign || row.headsign || '',
    direction_id: row.direction_id === '' || row.direction_id == null ? null : Number(row.direction_id),
    shape_id: row.shape_id || ''
  }
}

/**
 * Keep only trips whose service_id is active on at least one window date.
 * Returns a compact Map(trip_id → {route_id, headsign, direction_id, dates[]}).
 */
export function indexActiveTrips(trips, byDate) {
  const activeServices = unionServices(byDate)
  const map = new Map()
  for (const trip of trips) {
    if (!trip.trip_id || !activeServices.has(String(trip.service_id))) continue
    const dates = []
    for (const [ymd, set] of byDate) {
      if (set.has(String(trip.service_id))) dates.push(ymd)
    }
    if (!dates.length) continue
    map.set(String(trip.trip_id), {
      route_id: trip.route_id,
      headsign: trip.headsign || '',
      direction_id: trip.direction_id,
      dates
    })
  }
  return map
}

function shouldSplitPasses(activeTrips, dateCount) {
  if (dateCount <= 1) return false
  // Carris is ~22k trips/day; unique over 2 days can sit under 40k.
  if (activeTrips.size >= 20_000) return true
  return heapUsed() > 150 * 1024 * 1024
}

/** One representative trip_id per route — routeSeq stays bounded by route count. */
function representativeTrips(activeTrips) {
  const wanted = new Map()
  for (const [tripId, trip] of activeTrips) {
    if (trip.route_id && !wanted.has(trip.route_id)) wanted.set(trip.route_id, tripId)
  }
  return wanted
}

function noteStopRoute(acc, stopId, routeId) {
  if (!acc || !routeId) return
  let set = acc.get(stopId)
  if (!set) {
    set = new Set()
    acc.set(stopId, set)
  }
  set.add(routeId)
}

export async function collectStopDepartures({ zipPath, activeTrips, dates, logger }) {
  const wanted = representativeTrips(activeTrips)
  const perDate = shouldSplitPasses(activeTrips, dates.length)
  if (perDate) {
    logger?.info({ trips: activeTrips.size, dates }, 'stop_times: one pass per date (heap guard)')
    const all = new Map()
    let routeSeq = new Map()
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i]
      const slice = new Map()
      for (const [id, trip] of activeTrips) {
        if (trip.dates.includes(date)) slice.set(id, { ...trip, dates: [date] })
      }
      const part = await collectOnePass({
        zipPath,
        activeTrips: slice,
        wantedTrips: i === 0 ? new Set(wanted.values()) : null,
        logger
      })
      mergeStopMaps(all, part.byStop)
      if (part.routeSeq) routeSeq = part.routeSeq
      part.byStop.clear()
    }
    return { byStop: all, routeStops: routeStopsFromSeq(wanted, routeSeq) }
  }
  const one = await collectOnePass({
    zipPath,
    activeTrips,
    wantedTrips: new Set(wanted.values()),
    logger
  })
  return { byStop: one.byStop, routeStops: routeStopsFromSeq(wanted, one.routeSeq) }
}

function mergeStopMaps(target, extra) {
  for (const [stopId, byDate] of extra) {
    let dest = target.get(stopId)
    if (!dest) {
      dest = new Map()
      target.set(stopId, dest)
    }
    for (const [date, rows] of byDate) {
      const list = dest.get(date)
      if (list) list.push(...rows)
      else dest.set(date, rows)
    }
  }
}

async function collectOnePass({
  zipPath,
  activeTrips,
  wantedTrips,
  logger,
  onFlush,
  stopRouteAcc,
  flushEvery = DEPARTURE_FLUSH_ROWS
}) {
  const byStop = new Map()
  // trip_id → stop_id[] in encounter order (one trip per route, see wantedTrips)
  const routeSeq = wantedTrips ? new Map() : null
  let kept = 0
  let scanned = 0
  let sinceFlush = 0
  let lastLog = Date.now()

  const found = await streamZipCsv(zipPath, 'stop_times.txt', async (row) => {
    scanned++
    const tripId = String(row.trip_id || '')
    if (routeSeq && wantedTrips.has(tripId)) {
      if (!routeSeq.has(tripId)) routeSeq.set(tripId, [])
      const stopId = String(row.stop_id || '')
      if (stopId) routeSeq.get(tripId).push(stopId)
    }
    const trip = activeTrips.get(tripId)
    if (!trip) return
    const t = row.departure_time || row.arrival_time
    if (!t) return
    const stopId = String(row.stop_id || '')
    if (!stopId) return
    if (row.pickup_type === '1' && row.drop_off_type === '1') return

    let byDate = byStop.get(stopId)
    if (!byDate) {
      byDate = new Map()
      byStop.set(stopId, byDate)
    }
    const packed = packDep(t, tripId, trip.route_id)
    for (const date of trip.dates) {
      const list = byDate.get(date)
      if (list) list.push(packed)
      else byDate.set(date, [packed])
    }
    noteStopRoute(stopRouteAcc, stopId, trip.route_id)
    kept++
    sinceFlush++

    if (scanned % 250_000 === 0) {
      const used = heapUsed()
      if (Date.now() - lastLog > 10_000) {
        logger?.info({ scanned, kept, heapMB: Math.round(used / 1024 / 1024) }, 'stop_times progress')
        lastLog = Date.now()
      }
      if (used > HEAP_SOFT_LIMIT) {
        throw new Error(`Heap ${Math.round(used / 1024 / 1024)}MB exceeded soft limit while streaming stop_times`)
      }
    }

    if (onFlush && sinceFlush >= flushEvery) {
      await onFlush(byStop)
      sinceFlush = 0
    }
  })

  if (!found) throw new Error('stop_times.txt missing from zip')
  if (onFlush && byStop.size) await onFlush(byStop)
  logger?.info({ scanned, kept, stops: byStop.size, heapMB: Math.round(heapUsed() / 1024 / 1024) }, 'stop_times streamed')
  return { byStop, routeSeq, scanned, kept }
}

function routeStopsFromSeq(wanted, routeSeq) {
  const routeStops = []
  if (!routeSeq) return routeStops
  for (const [routeId, tripId] of wanted) {
    const stops = (routeSeq.get(tripId) || []).filter(Boolean)
    routeStops.push({ route_id: routeId, stop_ids: stops })
  }
  return routeStops
}

function partKey(stopId, date) {
  return `${stopId}\t${date}`
}

function chunkPacked({ feedId, stopId, date, packed, startPart = 0 }) {
  const deps = packed.splice(0, packed.length)
  if (!deps.length) return []
  if (deps.length <= DEPARTURE_SPLIT) {
    return [{ feed_id: feedId, stop_id: stopId, date, part: startPart, deps }]
  }
  const docs = []
  for (let i = 0, part = startPart; i < deps.length; i += DEPARTURE_SPLIT, part++) {
    docs.push({
      feed_id: feedId,
      stop_id: stopId,
      date,
      part,
      deps: deps.slice(i, i + DEPARTURE_SPLIT)
    })
  }
  return docs
}

/**
 * Yield one stop at a time and drop it from `byStop` immediately.
 * Never builds a whole-feed docs array. `deps` stay packed strings.
 * `nextPart` continues part numbers across mid-stream flushes so the
 * unique (feed_id, stop_id, date, part) index is not violated.
 */
export function* iterStopDepartures({ feedId, byStop, nextPart }) {
  const stopIds = [...byStop.keys()]
  for (const stopId of stopIds) {
    const byDate = byStop.get(stopId)
    byStop.delete(stopId)
    const docs = []
    let stopTimes = 0
    for (const [date, packed] of byDate) {
      const key = partKey(stopId, date)
      const startPart = nextPart?.get(key) || 0
      const partDocs = chunkPacked({ feedId, stopId, date, packed, startPart })
      if (nextPart) nextPart.set(key, startPart + partDocs.length)
      stopTimes += partDocs.reduce((n, d) => n + d.deps.length, 0)
      docs.push(...partDocs)
    }
    byDate.clear()
    yield { stopId, docs, stopTimes }
  }
}

/**
 * Write packed departure docs as they are produced, bulkWrite batches of ~500.
 * Releases each stop's packed rows before the next stop is expanded.
 */
export async function flushDepartureDocs({
  Departure,
  feedId,
  dates,
  byStop,
  deleteDates = true,
  batchSize = DEPARTURE_WRITE_BATCH,
  nextPart,
  onBatch
}) {
  if (deleteDates && dates?.length) {
    await Departure.deleteMany({ feed_id: feedId, date: { $in: dates } })
  }

  const depBatch = []
  let stopTimesWindow = 0
  let maxBatch = 0

  async function flushDeps() {
    if (!depBatch.length) return
    maxBatch = Math.max(maxBatch, depBatch.length)
    onBatch?.(depBatch.length)
    const chunk = depBatch.splice(0, depBatch.length)
    await bulkInsert(Departure, chunk)
  }

  for (const item of iterStopDepartures({ feedId, byStop, nextPart })) {
    stopTimesWindow += item.stopTimes
    if (depBatch.length >= batchSize) await flushDeps()
    depBatch.push(...item.docs)
  }
  await flushDeps()
  return { stopTimesWindow, maxBatch }
}

/**
 * Collect stop_times (optionally one date at a time) and flush each pass
 * in DEPARTURE_FLUSH_ROWS chunks so a Carris-sized day is never all resident.
 */
export async function buildAndFlushDepartures({
  zipPath,
  activeTrips,
  dates,
  logger,
  flush,
  replaceLookups = true
}) {
  const wanted = representativeTrips(activeTrips)
  const perDate = shouldSplitPasses(activeTrips, dates.length)
  const groups = perDate ? dates.map((d) => [d]) : [dates]
  let routeStops = []
  let stopTimesWindow = 0
  let first = true
  const stopRouteAcc = replaceLookups ? new Map() : null
  const nextPart = new Map()

  for (const group of groups) {
    const slice = perDate
      ? filterTripsForDate(activeTrips, group[0])
      : activeTrips
    if (perDate) {
      logger?.info({ trips: slice.size, date: group[0] }, 'stop_times: one pass per date (heap guard)')
    }
    let deleteDates = true
    const part = await collectOnePass({
      zipPath,
      activeTrips: slice,
      wantedTrips: first ? new Set(wanted.values()) : null,
      logger,
      stopRouteAcc,
      onFlush: async (byStop) => {
        const r = await flush({
          byStop,
          dates: group,
          deleteDates,
          nextPart
        })
        stopTimesWindow += r.stopTimesWindow
        deleteDates = false
      }
    })
    if (part.routeSeq) routeStops = routeStopsFromSeq(wanted, part.routeSeq)
    part.byStop.clear()
    first = false
  }

  return { stopTimesWindow, routeStops, stopRouteAcc }
}

export function filterTripsForDate(activeTrips, date) {
  const slice = new Map()
  for (const [id, trip] of activeTrips) {
    if (trip.dates.includes(date)) slice.set(id, { ...trip, dates: [date] })
  }
  return slice
}

export function tripsPerRoute(activeTrips, date) {
  const counts = {}
  for (const trip of activeTrips.values()) {
    if (date && !trip.dates.includes(date)) continue
    counts[trip.route_id] = (counts[trip.route_id] || 0) + 1
  }
  return counts
}

export function stopRouteDocs(feedId, stopRouteAcc) {
  if (!stopRouteAcc?.size) return []
  const docs = []
  for (const [stop_id, ids] of stopRouteAcc) {
    docs.push({ feed_id: feedId, stop_id, route_ids: [...ids] })
  }
  return docs
}
