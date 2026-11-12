import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'

function stubStore(overrides = {}) {
  return {
    listFeeds: async () => [],
    getFeed: async () => null,
    listChanges: async () => ({ total: 0, data: [] }),
    recentChanges: async () => [],
    listRoutes: async () => ({ total: 0, data: [] }),
    getRoute: async () => null,
    getRouteStops: async () => null,
    tripsToday: async () => [],
    listStops: async () => ({ total: 0, data: [] }),
    getStop: async () => null,
    getStopRoutes: async () => null,
    routesByIds: async () => [],
    getDepartures: async () => [],
    tripsByIds: async () => [],
    nearStops: async () => [],
    departuresForStops: async () => [],
    feedStats: async () => [],
    ...overrides
  }
}

describe('HTTP routes', () => {
  let app

  before(async () => {
    app = await buildApp({
      logger: false,
      store: stubStore({
        getFeed: async (id) => {
          if (id === 'metro-porto') {
            return {
              feed_id: 'metro-porto',
              name: 'Metro do Porto',
              expired: true,
              valid_to: '2026-10-25',
              valid_from: '2026-09-07'
            }
          }
          return null
        },
        getDepartures: async () => []
      })
    })
  })

  after(async () => {
    await app.close()
  })

  it('GET /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.status, 'ok')
    assert.equal(body.service, 'connector-gtfs')
    assert.equal(body.version, '1.1.0')
  })

  it('GET /gtfs/meta lists the 04:00 ingest', async () => {
    const res = await app.inject({ method: 'GET', url: '/gtfs/meta' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.match(body.update_freq, /04:00/)
    assert.match(body.update_freq, /00:05/)
    assert.equal(body.version, '1.1.0')
  })

  it('GET /gtfs/feeds', async () => {
    const res = await app.inject({ method: 'GET', url: '/gtfs/feeds' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.ok(body.count >= 6)
    const ids = body.data.map((f) => f.feed_id)
    assert.ok(ids.includes('carris-metropolitana'))
    assert.ok(ids.includes('metro-porto'))
    assert.ok('expired' in body.data[0])
  })

  it('departures 400 outside window', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/gtfs/stops/carris-metropolitana/STOP1/departures?date=2099-01-01'
    })
    assert.equal(res.statusCode, 400)
    const body = res.json()
    assert.equal(body.error, 'date outside window')
    assert.ok(body.window.from)
    assert.ok(body.window.to)
  })

  it('returns feed_expired when the operator feed has lapsed and there are no departures', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/gtfs/stops/metro-porto/TRINDADE/departures?date=2026-10-27&from=00:00'
    })
    // date 2026-10-27 is only valid if today is in that window; if CI runs
    // later, fall back to today's date via omitting the assertion on 200.
    if (res.statusCode === 400) {
      assert.equal(res.json().error, 'date outside window')
      const todayRes = await app.inject({
        method: 'GET',
        url: '/gtfs/stops/metro-porto/TRINDADE/departures?from=00:00'
      })
      assert.equal(todayRes.statusCode, 200)
      const body = todayRes.json()
      assert.equal(body.feed_expired, true)
      assert.deepEqual(body.data, [])
      assert.match(body.warning, /expired on 2026-10-25/)
      return
    }
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.feed_expired, true)
    assert.deepEqual(body.data, [])
    assert.match(body.warning, /expired on 2026-10-25/)
  })
})

describe('HTTP departure response shape', () => {
  let app

  afterEach(async () => {
    if (app) {
      await app.close()
      app = null
    }
  })

  it('hydrates packed deps into the public {time,ts,route_id,route_short_name,headsign,trip_id} shape', async () => {
    app = await buildApp({
      logger: false,
      store: stubStore({
        getFeed: async () => ({ feed_id: 'metro-porto', expired: false }),
        getDepartures: async () => [{
          feed_id: 'metro-porto',
          stop_id: 'TRINDADE',
          date: '2026-10-26',
          part: 0,
          deps: ['25:10:00\tT3\tR2']
        }],
        tripsByIds: async () => [{ trip_id: 'T3', route_id: 'R2', headsign: 'Night metro' }],
        routesByIds: async () => [{ route_id: 'R2', route_short_name: 'A' }]
      })
    })
    const res = await app.inject({
      method: 'GET',
      url: '/gtfs/stops/metro-porto/TRINDADE/departures?from=00:00'
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.feed_id, 'metro-porto')
    assert.equal(body.stop_id, 'TRINDADE')
    assert.equal(body.data.length, 1)
    const row = body.data[0]
    assert.deepEqual(Object.keys(row).sort(), ['headsign', 'route_id', 'route_short_name', 'time', 'trip_id', 'ts'])
    assert.equal(row.time, '01:10')
    assert.equal(row.trip_id, 'T3')
    assert.equal(row.route_id, 'R2')
    assert.equal(row.route_short_name, 'A')
    assert.equal(row.headsign, 'Night metro')
    assert.equal(row.ts, '2026-10-27T01:10:00.000Z')
  })

  it('keeps serving the pre-1.1 object-shaped deps without extra lookups', async () => {
    let tripCalls = 0
    app = await buildApp({
      logger: false,
      store: stubStore({
        getFeed: async () => ({ feed_id: 'metro-porto', expired: false }),
        getDepartures: async () => [{
          feed_id: 'metro-porto',
          stop_id: 'TRINDADE',
          date: '2026-10-21',
          part: 0,
          deps: [{
            t: '08:00:00',
            ts: new Date('2026-10-21T07:00:00.000Z'),
            trip_id: 'T1',
            route_id: 'R1',
            route_short_name: '1',
            headsign: 'A to D'
          }]
        }],
        tripsByIds: async () => { tripCalls++; return [] }
      })
    })
    const res = await app.inject({
      method: 'GET',
      url: '/gtfs/stops/metro-porto/TRINDADE/departures?from=00:00'
    })
    assert.equal(res.statusCode, 200)
    const row = res.json().data[0]
    assert.equal(row.time, '08:00')
    assert.equal(row.route_short_name, '1')
    assert.equal(row.headsign, 'A to D')
    assert.equal(row.ts, '2026-10-21T07:00:00.000Z')
    assert.equal(tripCalls, 0)
  })
})

