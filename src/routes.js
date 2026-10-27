import { parsePagination, pageResult } from './pagination.js'
import { formatHhMm, lisbonHm, lisbonYmd } from './time.js'
import { isDateInWindow, windowRange } from './window.js'
import { enabledFeeds, getFeedDef } from './feeds.js'

export class QueryError extends Error {
  constructor(message, statusCode = 400, extra) {
    super(message)
    this.name = 'QueryError'
    this.statusCode = statusCode
    this.extra = extra
  }
}

function parseNear(value) {
  const parts = String(value || '').split(',')
  if (parts.length !== 2) throw new QueryError('Invalid near, expected lat,lon')
  const lat = Number(parts[0])
  const lon = Number(parts[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new QueryError('Invalid near, expected lat,lon')
  }
  return { lat, lon }
}

function publicFeed(doc, def) {
  if (!doc && !def) return null
  return {
    feed_id: doc?.feed_id || def?.id,
    name: doc?.name || def?.name,
    region: doc?.region || def?.region,
    license: doc?.license || def?.license,
    attribution: doc?.attribution || def?.attribution,
    valid_from: doc?.valid_from ?? null,
    valid_to: doc?.valid_to ?? null,
    expired: Boolean(doc?.expired),
    last_checked: doc?.last_checked ?? null,
    last_changed: doc?.last_changed ?? null,
    counts: doc?.counts ?? null
  }
}

function publicRoute(r) {
  if (!r) return null
  return {
    feed_id: r.feed_id,
    route_id: r.route_id,
    agency_id: r.agency_id,
    route_short_name: r.route_short_name,
    route_long_name: r.route_long_name,
    route_type: r.route_type,
    route_color: r.route_color,
    route_text_color: r.route_text_color
  }
}

function publicStop(s) {
  if (!s) return null
  return {
    feed_id: s.feed_id,
    stop_id: s.stop_id,
    stop_code: s.stop_code,
    stop_name: s.stop_name,
    lat: s.lat,
    lon: s.lon,
    parent_station: s.parent_station,
    location_type: s.location_type,
    wheelchair_boarding: s.wheelchair_boarding,
    municipality_name: s.municipality_name || undefined
  }
}

function flattenDeps(docs) {
  const out = []
  for (const d of docs || []) {
    for (const dep of d.deps || []) out.push(dep)
  }
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
  return out
}

function formatDep(dep) {
  return {
    time: formatHhMm(dep.t),
    ts: dep.ts instanceof Date ? dep.ts.toISOString() : dep.ts,
    route_id: dep.route_id,
    route_short_name: dep.route_short_name,
    headsign: dep.headsign,
    trip_id: dep.trip_id
  }
}

export async function gtfsRoutes(app) {
  const store = () => app.store

  app.get('/feeds', {
    schema: { description: 'Configured GTFS feeds and their ingest status', tags: ['GTFS'] }
  }, async () => {
    const rows = await store().listFeeds()
    const defs = enabledFeeds()
    const data = defs.map((def) => {
      const row = rows.find((r) => r.feed_id === def.id)
      return publicFeed(row, def)
    })
    return { count: data.length, data }
  })

  app.get('/feeds/:feed_id', {
    schema: { description: 'One feed plus the last 5 change summaries', tags: ['GTFS'] }
  }, async (req, reply) => {
    const def = getFeedDef(req.params.feed_id)
    const row = await store().getFeed(req.params.feed_id)
    if (!row && !def) return reply.code(404).send({ error: `Unknown feed ${req.params.feed_id}` })
    const changes = row ? await store().recentChanges(req.params.feed_id, 5) : []
    return {
      ...publicFeed(row, def),
      changes: changes.map((c) => ({
        version_hash: c.version_hash,
        detected_at: c.detected_at,
        summary: c.summary
      }))
    }
  })

  app.get('/changes', {
    schema: {
      description: 'Feed diffs (stops/routes/trips)',
      tags: ['GTFS'],
      querystring: {
        type: 'object',
        properties: {
          feed_id: { type: 'string' },
          since: { type: 'string' },
          limit: { type: 'integer' },
          offset: { type: 'integer' }
        }
      }
    }
  }, async (req) => {
    const { limit, offset } = parsePagination(req.query)
    const { total, data } = await store().listChanges({
      feed_id: req.query.feed_id,
      since: req.query.since,
      limit,
      offset
    })
    return pageResult(data, total)
  })

  app.get('/routes', {
    schema: {
      description: 'Routes',
      tags: ['GTFS'],
      querystring: {
        type: 'object',
        properties: {
          feed_id: { type: 'string' },
          q: { type: 'string' },
          route_type: { type: 'integer' },
          limit: { type: 'integer' },
          offset: { type: 'integer' }
        }
      }
    }
  }, async (req) => {
    const { limit, offset } = parsePagination(req.query)
    const { total, data } = await store().listRoutes({
      feed_id: req.query.feed_id,
      q: req.query.q,
      route_type: req.query.route_type,
      limit,
      offset
    })
    return pageResult(data.map(publicRoute), total)
  })

  app.get('/routes/:feed_id/:route_id', {
    schema: { description: 'Route, ordered stops and trips today', tags: ['GTFS'] }
  }, async (req, reply) => {
    const route = await store().getRoute(req.params.feed_id, req.params.route_id)
    if (!route) return reply.code(404).send({ error: 'Route not found' })
    const [pattern, tripRows] = await Promise.all([
      store().getRouteStops(req.params.feed_id, req.params.route_id),
      store().tripsToday(req.params.feed_id, req.params.route_id)
    ])
    let stops = []
    if (pattern?.stop_ids?.length) {
      const found = await Promise.all(
        pattern.stop_ids.map((id) => store().getStop(req.params.feed_id, id))
      )
      stops = found.filter(Boolean).map(publicStop)
    }
    return {
      ...publicRoute(route),
      stops,
      trips_today: tripRows.length
    }
  })

  app.get('/stops', {
    schema: {
      description: 'Stops (text and geo). Without feed_id, near searches all operators.',
      tags: ['GTFS'],
      querystring: {
        type: 'object',
        properties: {
          feed_id: { type: 'string' },
          q: { type: 'string' },
          near: { type: 'string' },
          radius: { type: 'number' },
          limit: { type: 'integer' },
          offset: { type: 'integer' }
        }
      }
    }
  }, async (req, reply) => {
    let near = null
    try {
      if (req.query.near) near = parseNear(req.query.near)
    } catch (err) {
      if (err instanceof QueryError) return reply.code(400).send({ error: err.message })
      throw err
    }
    let radius = req.query.radius == null || req.query.radius === '' ? 300 : Number(req.query.radius)
    if (!Number.isFinite(radius) || radius <= 0) return reply.code(400).send({ error: 'Invalid radius' })
    radius = Math.min(radius, 3000)
    const { limit, offset } = parsePagination(req.query)
    const { total, data } = await store().listStops({
      feed_id: req.query.feed_id,
      q: req.query.q,
      near,
      radius,
      limit,
      offset
    })
    return pageResult(data.map(publicStop), total)
  })

  app.get('/stops/:feed_id/:stop_id', {
    schema: { description: 'Stop plus routes that serve it', tags: ['GTFS'] }
  }, async (req, reply) => {
    const stop = await store().getStop(req.params.feed_id, req.params.stop_id)
    if (!stop) return reply.code(404).send({ error: 'Stop not found' })
    const sr = await store().getStopRoutes(req.params.feed_id, req.params.stop_id)
    const routes = await store().routesByIds(req.params.feed_id, sr?.route_ids || [])
    return {
      ...publicStop(stop),
      routes: routes.map((r) => ({
        route_id: r.route_id,
        short_name: r.route_short_name,
        long_name: r.route_long_name,
        color: r.route_color
      }))
    }
  })

  app.get('/stops/:feed_id/:stop_id/departures', {
    schema: {
      description: 'Departures for a stop on a window date',
      tags: ['GTFS'],
      querystring: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          from: { type: 'string' },
          limit: { type: 'integer' },
          route_id: { type: 'string' }
        }
      }
    }
  }, async (req, reply) => {
    const today = lisbonYmd()
    const date = req.query.date || today
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.code(400).send({ error: 'Invalid date, expected YYYY-MM-DD' })
    }
    if (!isDateInWindow(date)) {
      const window = windowRange()
      return reply.code(400).send({ error: 'date outside window', window: { from: window.from, to: window.to } })
    }
    const feed = await store().getFeed(req.params.feed_id)
    const def = getFeedDef(req.params.feed_id)
    if (!feed && !def) return reply.code(404).send({ error: `Unknown feed ${req.params.feed_id}` })

    const { limit } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 200 })
    let from = req.query.from
    if (!from && date === today) from = lisbonHm()
    if (from && /^\d{2}:\d{2}$/.test(from)) from = `${from}:00`

    const docs = await store().getDepartures(req.params.feed_id, req.params.stop_id, date)
    let deps = flattenDeps(docs)
    if (from) deps = deps.filter((d) => d.t >= from)
    if (req.query.route_id) deps = deps.filter((d) => d.route_id === req.query.route_id)
    deps = deps.slice(0, limit)

    const expired = Boolean(feed?.expired)
    const body = {
      feed_id: req.params.feed_id,
      stop_id: req.params.stop_id,
      date,
      feed_expired: expired,
      data: deps.map(formatDep)
    }
    if (expired && deps.length === 0) {
      body.warning = `Operator feed expired on ${feed.valid_to}; schedules unavailable`
    }
    return body
  })

  app.get('/departures/near', {
    schema: {
      description: 'Next departures at stops around a point, across feeds',
      tags: ['GTFS'],
      querystring: {
        type: 'object',
        properties: {
          lat: { type: 'number' },
          lon: { type: 'number' },
          radius: { type: 'number' },
          limit: { type: 'integer' }
        },
        required: ['lat', 'lon']
      }
    }
  }, async (req, reply) => {
    const lat = Number(req.query.lat)
    const lon = Number(req.query.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return reply.code(400).send({ error: 'lat and lon are required' })
    }
    let radius = req.query.radius == null || req.query.radius === '' ? 300 : Number(req.query.radius)
    if (!Number.isFinite(radius) || radius <= 0) return reply.code(400).send({ error: 'Invalid radius' })
    radius = Math.min(radius, 1000)
    const { limit } = parsePagination(req.query, { defaultLimit: 30, maxLimit: 30 })
    const date = lisbonYmd()
    const from = `${lisbonHm()}:00`
    const stops = await store().nearStops(lat, lon, radius, 25)
    const docs = await store().departuresForStops(stops, date)
    const stopMeta = new Map(stops.map((s) => [`${s.feed_id}:${s.stop_id}`, s]))
    const merged = []
    for (const doc of docs) {
      const stop = stopMeta.get(`${doc.feed_id}:${doc.stop_id}`)
      for (const dep of doc.deps || []) {
        if (dep.t < from) continue
        merged.push({
          feed_id: doc.feed_id,
          stop_id: doc.stop_id,
          stop_name: stop?.stop_name,
          lat: stop?.lat,
          lon: stop?.lon,
          ...formatDep(dep)
        })
      }
    }
    merged.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    return { count: Math.min(merged.length, limit), data: merged.slice(0, limit) }
  })
}
