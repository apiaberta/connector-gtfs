function indexBy(rows, key) {
  const map = new Map()
  for (const row of rows || []) map.set(String(row[key]), row)
  return map
}

function pctDelta(oldN, newN) {
  if (!oldN && !newN) return 0
  if (!oldN) return 1
  return Math.abs(newN - oldN) / oldN
}

/**
 * Compare two feed snapshots. First import → { initial: true }.
 * trips_per_route_delta keeps |delta| >= 10% only, max 200.
 */
export function diffFeed(prev, next) {
  if (!prev) {
    return {
      initial: true,
      stops_added: (next?.stops || []).length,
      stops_removed: 0,
      routes_added: [],
      routes_removed: [],
      routes_changed: [],
      trips_per_route_delta: [],
      valid_to_old: null,
      valid_to_new: next?.valid_to ?? null
    }
  }

  const prevStops = indexBy(prev.stops, 'stop_id')
  const nextStops = indexBy(next.stops, 'stop_id')
  let stops_added = 0
  let stops_removed = 0
  for (const id of nextStops.keys()) if (!prevStops.has(id)) stops_added++
  for (const id of prevStops.keys()) if (!nextStops.has(id)) stops_removed++

  const prevRoutes = indexBy(prev.routes, 'route_id')
  const nextRoutes = indexBy(next.routes, 'route_id')
  const routes_added = []
  const routes_removed = []
  const routes_changed = []

  for (const [id, route] of nextRoutes) {
    if (!prevRoutes.has(id)) {
      routes_added.push(id)
      continue
    }
    const old = prevRoutes.get(id)
    for (const field of ['route_short_name', 'route_long_name']) {
      if (String(old[field] || '') !== String(route[field] || '')) {
        routes_changed.push({
          route_id: id,
          field,
          old: old[field] ?? null,
          new: route[field] ?? null
        })
      }
    }
  }
  for (const id of prevRoutes.keys()) {
    if (!nextRoutes.has(id)) routes_removed.push(id)
  }

  const oldTrips = prev.trips_per_route || {}
  const newTrips = next.trips_per_route || {}
  const routeIds = new Set([...Object.keys(oldTrips), ...Object.keys(newTrips)])
  const trips_per_route_delta = []
  for (const route_id of routeIds) {
    const oldN = Number(oldTrips[route_id] || 0)
    const newN = Number(newTrips[route_id] || 0)
    if (pctDelta(oldN, newN) < 0.1) continue
    trips_per_route_delta.push({ route_id, old: oldN, new: newN })
    if (trips_per_route_delta.length >= 200) break
  }

  return {
    stops_added,
    stops_removed,
    routes_added,
    routes_removed,
    routes_changed,
    trips_per_route_delta,
    valid_to_old: prev.valid_to ?? null,
    valid_to_new: next?.valid_to ?? null
  }
}
