import { describe, it, before, after } from 'node:test'
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
