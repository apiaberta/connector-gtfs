import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { miniGtfsZip } from './helpers/zip.js'
import { collectZipCsv, listZipEntries, validateGtfsZip } from '../src/ingest/zip.js'
import {
  tripFromRow, indexActiveTrips, collectStopDepartures,
  iterStopDepartures, flushDepartureDocs
} from '../src/ingest/departures.js'
import { servicesByDate } from '../src/calendar.js'
import { yyyymmddToIso } from '../src/time.js'
import { DEPARTURE_WRITE_BATCH } from '../src/config.js'

const zipPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mini-gtfs.zip')

function collectDocs(opts) {
  const docs = []
  const routeStops = []
  let stopTimesWindow = 0
  for (const item of iterStopDepartures(opts)) {
    docs.push(...item.docs)
    routeStops.push({ stop_id: item.stopId, route_ids: [...item.routeIds] })
    stopTimesWindow += item.stopTimes
  }
  return { docs, routeStops, stopTimesWindow }
}

describe('departures builder (mini GTFS)', () => {
  before(async () => {
    await mkdir(dirname(zipPath), { recursive: true })
    await writeFile(zipPath, miniGtfsZip())
  })

  it('lists required GTFS files in the fixture zip', async () => {
    const names = await listZipEntries(zipPath)
    validateGtfsZip(names)
    assert.ok(names.some((n) => n.endsWith('stop_times.txt')))
  })

  it('builds Monday 2026-10-26 from SPECIAL only, including 25:10:00', async () => {
    const [calRows, calDateRows, tripRows, routeRows] = await Promise.all([
      collectZipCsv(zipPath, 'calendar.txt'),
      collectZipCsv(zipPath, 'calendar_dates.txt'),
      collectZipCsv(zipPath, 'trips.txt'),
      collectZipCsv(zipPath, 'routes.txt')
    ])
    const calendars = calRows.map((r) => ({
      ...r,
      start_date: yyyymmddToIso(r.start_date),
      end_date: yyyymmddToIso(r.end_date)
    }))
    const calendarDates = calDateRows.map((r) => ({
      ...r,
      date: yyyymmddToIso(r.date),
      exception_type: Number(r.exception_type)
    }))
    const dates = ['2026-10-26']
    const byDate = servicesByDate(dates, calendars, calendarDates)
    assert.equal(byDate.get('2026-10-26').has('SPECIAL'), true)
    assert.equal(byDate.get('2026-10-26').has('WEEK'), false)

    const trips = tripRows.map(tripFromRow)
    const active = indexActiveTrips(trips, byDate)
    assert.deepEqual([...active.keys()], ['T3'])

    const { byStop, routeStops } = await collectStopDepartures({
      zipPath,
      activeTrips: active,
      dates
    })
    const routesById = new Map(routeRows.map((r) => [r.route_id, r]))
    const { docs, stopTimesWindow } = collectDocs({
      feedId: 'mini',
      byStop,
      activeTrips: active,
      routesById
    })

    assert.equal(byStop.size, 0)
    assert.equal(stopTimesWindow, 2)
    const stopB = docs.find((d) => d.stop_id === 'B')
    assert.ok(stopB)
    assert.equal(stopB.deps[0].t, '25:10:00')
    assert.equal(stopB.deps[0].trip_id, 'T3')
    assert.equal(stopB.deps[0].route_id, 'R2')
    assert.equal(stopB.deps[0].ts.toISOString(), '2026-10-27T01:10:00.000Z')
    assert.ok(routeStops.some((r) => r.route_id === 'R2' && r.stop_ids[0] === 'B'))
  })

  it('keeps WEEK trips on a Wednesday', async () => {
    const [calRows, tripRows] = await Promise.all([
      collectZipCsv(zipPath, 'calendar.txt'),
      collectZipCsv(zipPath, 'trips.txt')
    ])
    const calendars = calRows.map((r) => ({
      ...r,
      start_date: yyyymmddToIso(r.start_date),
      end_date: yyyymmddToIso(r.end_date)
    }))
    const dates = ['2026-10-21']
    const byDate = servicesByDate(dates, calendars, [])
    const active = indexActiveTrips(tripRows.map(tripFromRow), byDate)
    assert.deepEqual([...active.keys()], ['T1'])
    const { byStop } = await collectStopDepartures({ zipPath, activeTrips: active, dates })
    const { docs } = collectDocs({
      feedId: 'mini',
      byStop,
      activeTrips: active,
      routesById: new Map()
    })
    const stopA = docs.find((d) => d.stop_id === 'A')
    assert.equal(stopA.deps[0].t, '08:00:00')
    assert.equal(docs.find((d) => d.stop_id === 'B' && d.deps[0].t === '25:10:00'), undefined)
  })
})

describe('departure flush memory bounds', () => {
  it('releases each stop and never insertMany-s more than the write batch', async () => {
    const stops = 1200
    const depsPerStop = 20
    const byStop = new Map()
    const activeTrips = new Map()
    for (let j = 0; j < depsPerStop; j++) {
      activeTrips.set(`T${j}`, {
        route_id: 'R1',
        headsign: 'X',
        direction_id: 0,
        dates: ['2026-10-27']
      })
    }
    for (let i = 0; i < stops; i++) {
      const packed = []
      for (let j = 0; j < depsPerStop; j++) {
        packed.push(`08:${String(j).padStart(2, '0')}:00\tT${j}`)
      }
      byStop.set(`S${i}`, new Map([['2026-10-27', packed]]))
    }

    const batchSizes = []
    let live = 0
    let maxLive = 0
    const Departure = {
      deleteMany: async () => {},
      insertMany: async (docs) => {
        live += docs.length
        maxLive = Math.max(maxLive, live)
        batchSizes.push(docs.length)
        live -= docs.length
      }
    }
    const StopRoute = {
      deleteMany: async () => {},
      insertMany: async () => {}
    }

    const heapBefore = process.memoryUsage().heapUsed
    const { stopTimesWindow, maxBatch } = await flushDepartureDocs({
      Departure,
      StopRoute,
      feedId: 'mini',
      dates: ['2026-10-27'],
      byStop,
      activeTrips,
      routesById: new Map([['R1', { route_short_name: '1' }]]),
      batchSize: DEPARTURE_WRITE_BATCH
    })
    const heapAfter = process.memoryUsage().heapUsed

    assert.equal(byStop.size, 0)
    assert.equal(stopTimesWindow, stops * depsPerStop)
    assert.ok(maxBatch <= DEPARTURE_WRITE_BATCH + 1)
    assert.ok(batchSizes.every((n) => n <= DEPARTURE_WRITE_BATCH + 1))
    assert.ok(maxLive <= DEPARTURE_WRITE_BATCH + 1)
    // Expanding every stop at once would add tens of MB; a 500-doc batch must not.
    const extraMB = (heapAfter - heapBefore) / 1024 / 1024
    assert.ok(extraMB < 40, `flush grew heap by ${extraMB.toFixed(1)}MB`)
  })

  it('iterStopDepartures deletes the stop before yielding the next', () => {
    const byStop = new Map([
      ['A', new Map([['2026-10-27', ['08:00:00\tT1']]])],
      ['B', new Map([['2026-10-27', ['08:10:00\tT1']]])]
    ])
    const activeTrips = new Map([['T1', { route_id: 'R1', headsign: '', direction_id: 0, dates: ['2026-10-27'] }]])
    const seen = []
    for (const item of iterStopDepartures({
      feedId: 'mini',
      byStop,
      activeTrips,
      routesById: new Map()
    })) {
      seen.push(item.stopId)
      assert.equal(byStop.has(item.stopId), false)
    }
    assert.deepEqual(seen.sort(), ['A', 'B'])
    assert.equal(byStop.size, 0)
  })
})
