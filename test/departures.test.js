import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { miniGtfsZip } from './helpers/zip.js'
import { collectZipCsv, listZipEntries, validateGtfsZip } from '../src/ingest/zip.js'
import {
  tripFromRow, indexActiveTrips, collectStopDepartures,
  iterStopDepartures, flushDepartureDocs, buildAndFlushDepartures
} from '../src/ingest/departures.js'
import { unpackDep } from '../src/departures-read.js'
import { servicesByDate } from '../src/calendar.js'
import { yyyymmddToIso } from '../src/time.js'
import { DEPARTURE_WRITE_BATCH } from '../src/config.js'

const zipPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mini-gtfs.zip')

function collectDocs(opts) {
  const docs = []
  let stopTimesWindow = 0
  for (const item of iterStopDepartures(opts)) {
    docs.push(...item.docs)
    stopTimesWindow += item.stopTimes
  }
  return { docs, stopTimesWindow }
}

function mockDeparture() {
  const inserted = []
  const batchSizes = []
  let live = 0
  let maxLive = 0
  return {
    inserted,
    batchSizes,
    maxLive: () => maxLive,
    deleteMany: async () => {},
    bulkWrite: async (ops) => {
      live += ops.length
      maxLive = Math.max(maxLive, live)
      batchSizes.push(ops.length)
      for (const op of ops) inserted.push(op.insertOne.document)
      live -= ops.length
    }
  }
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
    const { docs, stopTimesWindow } = collectDocs({
      feedId: 'mini',
      byStop
    })

    assert.equal(byStop.size, 0)
    assert.equal(stopTimesWindow, 2)
    const stopB = docs.find((d) => d.stop_id === 'B')
    assert.ok(stopB)
    const first = unpackDep(stopB.deps[0])
    assert.equal(first.t, '25:10:00')
    assert.equal(first.trip_id, 'T3')
    assert.equal(first.route_id, 'R2')
    assert.equal(typeof stopB.deps[0], 'string')
    assert.ok(routeStops.some((r) => r.route_id === 'R2' && r.stop_ids[0] === 'B'))
    assert.equal(routeRows.length, 2)
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
      byStop
    })
    const stopA = docs.find((d) => d.stop_id === 'A')
    assert.equal(unpackDep(stopA.deps[0]).t, '08:00:00')
    assert.equal(docs.find((d) => d.stop_id === 'B' && unpackDep(d.deps[0]).t === '25:10:00'), undefined)
  })
})

describe('departure flush memory bounds', () => {
  it('releases each stop and never bulkWrite-s more than the write batch', async () => {
    const stops = 1200
    const depsPerStop = 20
    const byStop = new Map()
    for (let i = 0; i < stops; i++) {
      const packed = []
      for (let j = 0; j < depsPerStop; j++) {
        packed.push(`08:${String(j).padStart(2, '0')}:00\tT${j}\tR1`)
      }
      byStop.set(`S${i}`, new Map([['2026-10-27', packed]]))
    }

    const Departure = mockDeparture()
    const heapBefore = process.memoryUsage().heapUsed
    const { stopTimesWindow, maxBatch } = await flushDepartureDocs({
      Departure,
      feedId: 'mini',
      dates: ['2026-10-27'],
      byStop,
      batchSize: DEPARTURE_WRITE_BATCH
    })
    const heapAfter = process.memoryUsage().heapUsed

    assert.equal(byStop.size, 0)
    assert.equal(stopTimesWindow, stops * depsPerStop)
    assert.ok(maxBatch <= DEPARTURE_WRITE_BATCH + 1)
    assert.ok(Departure.batchSizes.every((n) => n <= DEPARTURE_WRITE_BATCH + 1))
    assert.ok(Departure.maxLive() <= DEPARTURE_WRITE_BATCH + 1)
    assert.equal(typeof Departure.inserted[0].deps[0], 'string')
    const extraMB = (heapAfter - heapBefore) / 1024 / 1024
    assert.ok(extraMB < 40, `flush grew heap by ${extraMB.toFixed(1)}MB`)
  })

  it('iterStopDepartures deletes the stop before yielding the next', () => {
    const byStop = new Map([
      ['A', new Map([['2026-10-27', ['08:00:00\tT1\tR1']]])],
      ['B', new Map([['2026-10-27', ['08:10:00\tT1\tR1']]])]
    ])
    const seen = []
    for (const item of iterStopDepartures({
      feedId: 'mini',
      byStop
    })) {
      seen.push(item.stopId)
      assert.equal(byStop.has(item.stopId), false)
    }
    assert.deepEqual(seen.sort(), ['A', 'B'])
    assert.equal(byStop.size, 0)
  })

  it('continues part numbers across mid-stream flushes', async () => {
    const nextPart = new Map()
    const Departure = mockDeparture()
    await flushDepartureDocs({
      Departure,
      feedId: 'mini',
      dates: ['2026-10-27'],
      byStop: new Map([['A', new Map([['2026-10-27', ['08:00:00\tT1\tR1']]])]]),
      nextPart
    })
    await flushDepartureDocs({
      Departure,
      feedId: 'mini',
      dates: ['2026-10-27'],
      byStop: new Map([['A', new Map([['2026-10-27', ['09:00:00\tT2\tR1']]])]]),
      deleteDates: false,
      nextPart
    })
    const parts = Departure.inserted.filter((d) => d.stop_id === 'A').map((d) => d.part)
    assert.deepEqual(parts, [0, 1])
  })
})

describe('buildAndFlushDepartures periodic flush', () => {
  before(async () => {
    await mkdir(dirname(zipPath), { recursive: true })
    await writeFile(zipPath, miniGtfsZip())
  })

  it('flushes packed docs via the callback and returns stop-route lookups', async () => {
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
    const Departure = mockDeparture()
    const flushed = []
    const { stopTimesWindow, stopRouteAcc } = await buildAndFlushDepartures({
      zipPath,
      activeTrips: active,
      dates,
      replaceLookups: true,
      flush: async ({ byStop, deleteDates, nextPart }) => {
        flushed.push({ size: byStop.size, deleteDates })
        return flushDepartureDocs({
          Departure,
          feedId: 'mini',
          dates,
          byStop,
          deleteDates,
          nextPart
        })
      }
    })
    assert.ok(flushed.length >= 1)
    assert.equal(flushed[0].deleteDates, true)
    assert.ok(stopTimesWindow >= 1)
    assert.ok(stopRouteAcc.get('A')?.has('R1'))
    assert.equal(typeof Departure.inserted[0].deps[0], 'string')
  })
})
