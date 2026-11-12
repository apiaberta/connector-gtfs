import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  TMP_DIR, FEED_VERSIONS_KEEP, ZIP_RETENTION_MS
} from '../config.js'
import { enabledFeeds } from '../feeds.js'
import { resolveFeedUrl } from '../discovery.js'
import { lisbonYmd, yyyymmddToIso } from '../time.js'
import { windowDates } from '../window.js'
import {
  addCalendarToServices, addCalendarDateToServices, emptyByDate, unionServices
} from '../calendar.js'
import { diffFeed } from '../diff.js'
import {
  Feed, FeedVersion, Change, Agency, Route, Stop, Trip,
  Calendar, CalendarDate, Departure, StopRoute, RouteStop, ensureIndexes
} from '../models.js'
import { listZipEntries, validateGtfsZip, collectZipCsv, streamZipCsv, zipBasename } from './zip.js'
import { downloadZip, sha256File, zipPathFor } from './download.js'
import {
  tripFromRow, buildAndFlushDepartures,
  flushDepartureDocs, filterTripsForDate, tripsPerRoute, stopRouteDocs
} from './departures.js'
import { replaceByFeed, createBatchWriter, pruneOlderThan } from './swap.js'

function num(v, fallback = null) {
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function mapAgency(feedId, row) {
  return {
    feed_id: feedId,
    agency_id: String(row.agency_id || ''),
    agency_name: row.agency_name || '',
    agency_url: row.agency_url || '',
    agency_timezone: row.agency_timezone || 'Europe/Lisbon',
    agency_lang: row.agency_lang || ''
  }
}

function mapRoute(feedId, row) {
  return {
    feed_id: feedId,
    route_id: String(row.route_id || ''),
    agency_id: row.agency_id || '',
    route_short_name: row.route_short_name || '',
    route_long_name: row.route_long_name || '',
    route_type: num(row.route_type, 3),
    route_color: row.route_color || '',
    route_text_color: row.route_text_color || ''
  }
}

function mapStop(feedId, row) {
  const lat = num(row.stop_lat)
  const lon = num(row.stop_lon)
  const location = (lat != null && lon != null)
    ? { type: 'Point', coordinates: [lon, lat] }
    : undefined
  return {
    feed_id: feedId,
    stop_id: String(row.stop_id || ''),
    stop_code: row.stop_code || '',
    stop_name: row.stop_name || '',
    lat,
    lon,
    location,
    parent_station: row.parent_station || '',
    location_type: num(row.location_type, 0),
    wheelchair_boarding: num(row.wheelchair_boarding),
    municipality_name: row.municipality_name || row.municipality || ''
  }
}

function mapCalendar(feedId, row) {
  return {
    feed_id: feedId,
    service_id: String(row.service_id || ''),
    monday: num(row.monday, 0),
    tuesday: num(row.tuesday, 0),
    wednesday: num(row.wednesday, 0),
    thursday: num(row.thursday, 0),
    friday: num(row.friday, 0),
    saturday: num(row.saturday, 0),
    sunday: num(row.sunday, 0),
    start_date: yyyymmddToIso(row.start_date),
    end_date: yyyymmddToIso(row.end_date)
  }
}

function mapCalendarDate(feedId, row) {
  return {
    feed_id: feedId,
    service_id: String(row.service_id || ''),
    date: yyyymmddToIso(row.date),
    exception_type: num(row.exception_type, 1)
  }
}

function noteRange(d, acc) {
  if (!d) return
  if (!acc.from || d < acc.from) acc.from = d
  if (!acc.to || d > acc.to) acc.to = d
}

async function loadFeedInfo(zipPath, entries) {
  const has = entries.some((n) => zipBasename(n) === 'feed_info.txt')
  if (!has) return { valid_from: null, valid_to: null }
  const rows = await collectZipCsv(zipPath, 'feed_info.txt')
  return {
    valid_from: yyyymmddToIso(rows[0]?.feed_start_date),
    valid_to: yyyymmddToIso(rows[0]?.feed_end_date)
  }
}

async function streamReplace(Model, feedId, zipPath, fileName, mapRow, onDoc) {
  await Model.deleteMany({ feed_id: feedId })
  const writer = createBatchWriter(Model)
  let count = 0
  await streamZipCsv(zipPath, fileName, async (row) => {
    const doc = mapRow(row)
    if (!doc) return
    onDoc?.(doc)
    await writer.push(doc)
    count++
  })
  await writer.flush()
  return count
}

async function loadCalendars(zipPath, feedId, dates, persist, range) {
  const byDate = emptyByDate(dates)
  const calRange = { from: null, to: null }
  if (persist) await Calendar.deleteMany({ feed_id: feedId })
  const calWriter = persist ? createBatchWriter(Calendar) : null
  await streamZipCsv(zipPath, 'calendar.txt', async (row) => {
    if (!row.service_id) return
    const doc = mapCalendar(feedId, row)
    addCalendarToServices(doc, dates, byDate)
    noteRange(doc.start_date, calRange)
    noteRange(doc.end_date, calRange)
    if (calWriter) await calWriter.push(doc)
  })
  if (calWriter) await calWriter.flush()

  if (persist) await CalendarDate.deleteMany({ feed_id: feedId })
  const dateWriter = persist ? createBatchWriter(CalendarDate) : null
  await streamZipCsv(zipPath, 'calendar_dates.txt', async (row) => {
    if (!row.service_id) return
    const doc = mapCalendarDate(feedId, row)
    addCalendarDateToServices(doc, byDate)
    noteRange(doc.date, calRange)
    if (dateWriter) await dateWriter.push(doc)
  })
  if (dateWriter) await dateWriter.flush()
  if (!range.from) range.from = calRange.from
  if (!range.to) range.to = calRange.to
  return byDate
}

async function loadWindowTrips(zipPath, feedId, byDate) {
  const active = unionServices(byDate)
  const activeTrips = new Map()
  await Trip.deleteMany({ feed_id: feedId })
  const writer = createBatchWriter(Trip)
  await streamZipCsv(zipPath, 'trips.txt', async (row) => {
    const trip = tripFromRow(row)
    if (!trip.trip_id || !active.has(String(trip.service_id))) return
    const dates = []
    for (const [ymd, set] of byDate) {
      if (set.has(String(trip.service_id))) dates.push(ymd)
    }
    if (!dates.length) return
    activeTrips.set(String(trip.trip_id), {
      route_id: trip.route_id,
      headsign: trip.headsign || '',
      direction_id: trip.direction_id,
      dates
    })
    await writer.push({ feed_id: feedId, ...trip })
  })
  await writer.flush()
  return { activeTrips, tripCount: activeTrips.size }
}

function slimSnapshot({ stops, routes, trips_per_route, valid_from, valid_to }) {
  return {
    stops: stops.map((s) => ({ stop_id: s.stop_id })),
    routes: routes.map((r) => ({
      route_id: r.route_id,
      route_short_name: r.route_short_name,
      route_long_name: r.route_long_name
    })),
    trips_per_route,
    valid_from,
    valid_to
  }
}

async function writeDiffAndVersion(feed, hash, nextSnap, now) {
  const prev = await FeedVersion.findOne({ feed_id: feed.id }).sort({ detected_at: -1 }).lean()
  const summary = diffFeed(prev?.snapshot || null, nextSnap)
  await FeedVersion.create({
    feed_id: feed.id,
    version_hash: hash,
    detected_at: now,
    valid_from: nextSnap.valid_from,
    valid_to: nextSnap.valid_to,
    snapshot: nextSnap
  })
  await pruneOlderThan(FeedVersion, feed.id, FEED_VERSIONS_KEEP)
  await Change.create({
    feed_id: feed.id,
    version_hash: hash,
    detected_at: now,
    summary
  })
  return summary
}

export async function ingestFeed(feed, { mode = 'full', logger } = {}) {
  await mkdir(TMP_DIR, { recursive: true })
  const destPath = zipPathFor(TMP_DIR, feed.id)
  const prev = await Feed.findOne({ feed_id: feed.id }).lean()
  const today = lisbonYmd()
  const dates = windowDates()
  const now = new Date()

  const discovered = await resolveFeedUrl(feed)
  let download
  try {
    download = await downloadZip(discovered.url, destPath, {
      etag: prev?.etag,
      last_modified: prev?.last_modified,
      logger
    })
  } catch (err) {
    if (prev?.sha256) {
      logger?.warn({ err, feed: feed.id }, 'Download failed, using cached zip')
      download = { notModified: true, destPath, bytes: prev.bytes, etag: prev.etag, last_modified: prev.last_modified }
    } else {
      throw err
    }
  }

  const sha256 = download.sha256 || await sha256File(destPath)
  const unchanged = Boolean(prev?.sha256 && prev.sha256 === sha256)
  const entries = await listZipEntries(destPath)
  validateGtfsZip(entries)

  const reloadTables = !prev || (mode === 'full' && !unchanged)

  if (mode === 'full' && unchanged && prev) {
    const lastDate = dates[dates.length - 1]
    const haveWindow = await Departure.findOne({ feed_id: feed.id, date: lastDate }).select({ _id: 1 }).lean()
    if (haveWindow) {
      logger?.info({ feed: feed.id }, 'Zip unchanged')
      const expired = Boolean(prev.valid_to && prev.valid_to < today)
      await Feed.updateOne({ feed_id: feed.id }, {
        $set: {
          last_checked: now,
          expired,
          last_error: null,
          resolved_url: discovered.url,
          source_url: discovered.source_url || feed.discovery.url || discovered.url
        }
      })
      return { feed_id: feed.id, status: 'unchanged', expired }
    }
    logger?.info({ feed: feed.id, lastDate }, 'Zip unchanged but window incomplete — rebuilding departures')
  }

  const info = await loadFeedInfo(destPath, entries)
  const range = { from: info.valid_from, to: info.valid_to }

  const slimStops = []
  const slimRoutes = []
  let stopCount = prev?.counts?.stops ?? 0
  let routeCount = prev?.counts?.routes ?? 0

  if (reloadTables) {
    await streamReplace(Agency, feed.id, destPath, 'agency.txt', (row) => mapAgency(feed.id, row))
    stopCount = await streamReplace(
      Stop, feed.id, destPath, 'stops.txt',
      (row) => (row.stop_id ? mapStop(feed.id, row) : null),
      (doc) => slimStops.push({ stop_id: doc.stop_id })
    )
    routeCount = await streamReplace(
      Route, feed.id, destPath, 'routes.txt',
      (row) => (row.route_id ? mapRoute(feed.id, row) : null),
      (doc) => slimRoutes.push({
        route_id: doc.route_id,
        route_short_name: doc.route_short_name,
        route_long_name: doc.route_long_name
      })
    )
  }

  const byDate = await loadCalendars(destPath, feed.id, dates, reloadTables, range)
  const { activeTrips, tripCount } = await loadWindowTrips(destPath, feed.id, byDate)

  const valid_from = range.from
  const valid_to = range.to
  const nextSnap = reloadTables
    ? slimSnapshot({
      stops: slimStops,
      routes: slimRoutes,
      trips_per_route: tripsPerRoute(activeTrips, dates[0]),
      valid_from,
      valid_to
    })
    : null

  const incremental = mode === 'departures' && prev
  const targetDates = incremental ? [dates[dates.length - 1]] : dates
  const tripsForDates = incremental
    ? filterTripsForDate(activeTrips, targetDates[0])
    : activeTrips

  if (incremental) {
    await Departure.deleteMany({ feed_id: feed.id, date: { $lt: dates[0] } })
  }

  const { stopTimesWindow, routeStops, stopRouteAcc } = await buildAndFlushDepartures({
    zipPath: destPath,
    activeTrips: tripsForDates,
    dates: targetDates,
    logger,
    replaceLookups: reloadTables,
    flush: ({ byStop, dates: passDates, deleteDates, nextPart }) =>
      flushDepartureDocs({
        Departure,
        feedId: feed.id,
        dates: passDates,
        byStop,
        deleteDates,
        nextPart
      })
  })

  if (reloadTables && stopRouteAcc?.size) {
    await replaceByFeed(StopRoute, feed.id, stopRouteDocs(feed.id, stopRouteAcc))
  }
  if (reloadTables && routeStops.length) {
    await replaceByFeed(RouteStop, feed.id, routeStops.map((r) => ({ feed_id: feed.id, ...r })))
  }

  const counts = {
    stops: stopCount,
    routes: routeCount,
    trips: tripCount,
    stop_times_window: stopTimesWindow
  }

  let summary = { unchanged: true }
  if ((reloadTables || !prev) && nextSnap) {
    summary = await writeDiffAndVersion(feed, sha256, nextSnap, now)
  }

  const expired = Boolean(valid_to && valid_to < today)
  await Feed.findOneAndUpdate(
    { feed_id: feed.id },
    {
      $set: {
        feed_id: feed.id,
        name: feed.name,
        region: feed.region,
        license: feed.license,
        attribution: feed.attribution,
        source_url: discovered.source_url || feed.discovery.url || discovered.url,
        resolved_url: discovered.url,
        etag: download.etag || prev?.etag || null,
        last_modified: download.last_modified || prev?.last_modified || null,
        sha256,
        bytes: download.bytes || prev?.bytes || null,
        valid_from: valid_from ?? prev?.valid_from ?? null,
        valid_to: valid_to ?? prev?.valid_to ?? null,
        expired,
        counts,
        last_checked: now,
        last_changed: (reloadTables || !prev) ? now : prev?.last_changed || now,
        last_error: null
      }
    },
    { upsert: true }
  )

  return {
    feed_id: feed.id,
    status: unchanged ? 'unchanged' : 'updated',
    expired,
    counts,
    summary
  }
}

export async function cleanupOldZips(logger) {
  let names
  try {
    names = await readdir(TMP_DIR)
  } catch {
    return
  }
  const cutoff = Date.now() - ZIP_RETENTION_MS
  for (const name of names) {
    if (!name.endsWith('.zip')) continue
    const p = join(TMP_DIR, name)
    const s = await stat(p).catch(() => null)
    if (s && s.mtimeMs < cutoff) {
      await unlink(p).catch(() => {})
      logger?.info({ p }, 'Deleted old zip')
    }
  }
}

export async function runPipeline({ mode = 'full', logger } = {}) {
  await ensureIndexes()
  const feeds = enabledFeeds()
  const results = []
  for (const feed of feeds) {
    try {
      logger?.info({ feed: feed.id, mode }, 'Ingesting feed')
      const r = await ingestFeed(feed, { mode, logger })
      results.push(r)
      logger?.info({ r }, 'Feed ingest done')
    } catch (err) {
      logger?.error({ err, feed: feed.id }, 'Feed ingest failed — keeping previous data')
      await Feed.updateOne(
        { feed_id: feed.id },
        { $set: { last_error: err.message, last_checked: new Date() } }
      ).catch(() => {})
      results.push({ feed_id: feed.id, status: 'error', error: err.message })
    }
  }
  await cleanupOldZips(logger)
  return { mode, results }
}
