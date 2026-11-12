import { gtfsTimeToUtc } from './time.js'

/**
 * Compact on-disk departure: "HH:MM:SS\\ttrip_id\\troute_id".
 * Repeated field names and nested _id (Mongoose subdocs) dominate the
 * 13 KiB avgObjSize of the fat object shape; packed strings drop that BSON tax.
 * Old object-shaped deps remain readable until the next ingest rewrites them.
 */
export function packDep(t, tripId, routeId = '') {
  return `${t}\t${tripId}\t${routeId || ''}`
}

export function unpackDep(dep) {
  if (dep == null) return null
  if (typeof dep === 'string') {
    const tab1 = dep.indexOf('\t')
    if (tab1 < 0) return { t: dep, trip_id: '', route_id: '' }
    const t = dep.slice(0, tab1)
    const rest = dep.slice(tab1 + 1)
    const tab2 = rest.indexOf('\t')
    if (tab2 < 0) return { t, trip_id: rest, route_id: '' }
    return { t, trip_id: rest.slice(0, tab2), route_id: rest.slice(tab2 + 1) }
  }
  return {
    t: dep.t,
    ts: dep.ts,
    trip_id: dep.trip_id,
    route_id: dep.route_id,
    route_short_name: dep.route_short_name,
    headsign: dep.headsign,
    direction_id: dep.direction_id
  }
}

export function flattenDepartureDocs(docs) {
  const out = []
  for (const d of docs || []) {
    for (const raw of d.deps || []) {
      const dep = unpackDep(raw)
      if (!dep?.t) continue
      dep.feed_id = d.feed_id
      dep.stop_id = d.stop_id
      dep.date = d.date
      if (!dep.ts && d.date) dep.ts = gtfsTimeToUtc(d.date, dep.t)
      out.push(dep)
    }
  }
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
  return out
}

function needsLookup(dep) {
  return dep.route_short_name == null || dep.headsign == null
}

/**
 * Fill route_short_name / headsign from trips + routes when the stored dep
 * is packed (or an old object missing those denormalised fields).
 * Only the deps actually passed in are hydrated — filter/limit first.
 */
export async function hydrateFlat(deps, store) {
  if (!deps?.length) return deps || []

  const byFeed = new Map()
  for (const dep of deps) {
    if (!needsLookup(dep)) continue
    const feedId = dep.feed_id
    if (!feedId) continue
    let g = byFeed.get(feedId)
    if (!g) {
      g = { trips: new Set(), routes: new Set() }
      byFeed.set(feedId, g)
    }
    if (dep.trip_id) g.trips.add(dep.trip_id)
    if (dep.route_id) g.routes.add(dep.route_id)
  }

  if (!byFeed.size) return deps

  const tripMap = new Map()
  const routeMap = new Map()
  await Promise.all([...byFeed].map(async ([feedId, g]) => {
    const trips = g.trips.size && store.tripsByIds
      ? await store.tripsByIds(feedId, [...g.trips])
      : []
    for (const t of trips || []) {
      tripMap.set(`${feedId}:${t.trip_id}`, t)
      if (t.route_id) g.routes.add(t.route_id)
    }
  }))
  await Promise.all([...byFeed].map(async ([feedId, g]) => {
    const routes = g.routes.size && store.routesByIds
      ? await store.routesByIds(feedId, [...g.routes])
      : []
    for (const r of routes || []) routeMap.set(`${feedId}:${r.route_id}`, r)
  }))

  for (const dep of deps) {
    const feedId = dep.feed_id
    const trip = tripMap.get(`${feedId}:${dep.trip_id}`)
    if (!dep.route_id && trip?.route_id) dep.route_id = trip.route_id
    if (dep.headsign == null) dep.headsign = trip?.headsign || ''
    const route = routeMap.get(`${feedId}:${dep.route_id}`)
    if (dep.route_short_name == null) {
      dep.route_short_name = route?.route_short_name || ''
    }
  }
  return deps
}
