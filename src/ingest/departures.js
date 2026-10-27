import { HEAP_SOFT_LIMIT, DEPARTURE_SPLIT } from '../config.js'
import { unionServices } from '../calendar.js'
import { gtfsTimeToUtc } from '../time.js'
import { streamZipCsv } from './zip.js'

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
  if (activeTrips.size >= 40_000) return true
  return heapUsed() > 150 * 1024 * 1024
}

/**
 * Stream stop_times.txt once (or once per date if heap is tight).
 * Never materialises the file or a full stop_times array.
 *
 * Entries stay compact: Map(stop_id → Map(date → "t\\ttrip_id"[])).
 */
function representativeTrips(activeTrips) {
  const wanted = new Map()
  for (const [tripId, trip] of activeTrips) {
    if (trip.route_id && !wanted.has(trip.route_id)) wanted.set(trip.route_id, tripId)
  }
  return wanted
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

async function collectOnePass({ zipPath, activeTrips, wantedTrips, logger }) {
  const byStop = new Map()
  const routeSeq = wantedTrips ? new Map() : null
  let kept = 0
  let scanned = 0
  let lastLog = Date.now()

  const found = await streamZipCsv(zipPath, 'stop_times.txt', (row) => {
    scanned++
    const tripId = String(row.trip_id || '')
    if (routeSeq && wantedTrips.has(tripId)) {
      if (!routeSeq.has(tripId)) routeSeq.set(tripId, [])
      routeSeq.get(tripId).push({
        stop_id: String(row.stop_id || ''),
        seq: Number(row.stop_sequence || 0)
      })
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
    const packed = `${t}\t${tripId}`
    for (const date of trip.dates) {
      const list = byDate.get(date)
      if (list) list.push(packed)
      else byDate.set(date, [packed])
    }
    kept++

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
  })

  if (!found) throw new Error('stop_times.txt missing from zip')
  logger?.info({ scanned, kept, stops: byStop.size, heapMB: Math.round(heapUsed() / 1024 / 1024) }, 'stop_times streamed')
  return { byStop, routeSeq }
}

function routeStopsFromSeq(wanted, routeSeq) {
  const routeStops = []
  if (!routeSeq) return routeStops
  for (const [routeId, tripId] of wanted) {
    const stops = (routeSeq.get(tripId) || [])
      .sort((a, b) => a.seq - b.seq)
      .map((s) => s.stop_id)
      .filter(Boolean)
    routeStops.push({ route_id: routeId, stop_ids: stops })
  }
  return routeStops
}

export function materializeDepartureDocs({ feedId, byStop, activeTrips, routesById }) {
  const docs = []
  const stopRoutes = new Map()
  let stopTimesWindow = 0

  for (const [stopId, byDate] of byStop) {
    const routeSet = stopRoutes.get(stopId) || new Set()
    for (const [date, packed] of byDate) {
      const deps = []
      for (const item of packed) {
        const tab = item.indexOf('\t')
        const t = item.slice(0, tab)
        const tripId = item.slice(tab + 1)
        const trip = activeTrips.get(tripId)
        if (!trip) continue
        const route = routesById.get(trip.route_id)
        const ts = gtfsTimeToUtc(date, t)
        deps.push({
          t,
          ts,
          trip_id: tripId,
          route_id: trip.route_id,
          route_short_name: route?.route_short_name || '',
          headsign: trip.headsign || '',
          direction_id: trip.direction_id
        })
        if (trip.route_id) routeSet.add(trip.route_id)
      }
      deps.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
      stopTimesWindow += deps.length
      if (deps.length <= DEPARTURE_SPLIT) {
        docs.push({ feed_id: feedId, stop_id: stopId, date, part: 0, deps })
      } else {
        for (let i = 0, part = 0; i < deps.length; i += DEPARTURE_SPLIT, part++) {
          docs.push({
            feed_id: feedId,
            stop_id: stopId,
            date,
            part,
            deps: deps.slice(i, i + DEPARTURE_SPLIT)
          })
        }
      }
    }
    stopRoutes.set(stopId, routeSet)
  }

  return { docs, stopRoutes, stopTimesWindow }
}

export function tripsPerRoute(activeTrips, date) {
  const counts = {}
  for (const trip of activeTrips.values()) {
    if (date && !trip.dates.includes(date)) continue
    counts[trip.route_id] = (counts[trip.route_id] || 0) + 1
  }
  return counts
}
