import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { miniGtfsZip } from './helpers/zip.js'
import { collectZipCsv, listZipEntries, validateGtfsZip } from '../src/ingest/zip.js'
import { tripFromRow, indexActiveTrips, collectStopDepartures, materializeDepartureDocs } from '../src/ingest/departures.js'
import { servicesByDate } from '../src/calendar.js'
import { yyyymmddToIso } from '../src/time.js'

const zipPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mini-gtfs.zip')

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
    const { docs, stopTimesWindow } = materializeDepartureDocs({
      feedId: 'mini',
      byStop,
      activeTrips: active,
      routesById
    })

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
    const { docs } = materializeDepartureDocs({
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
