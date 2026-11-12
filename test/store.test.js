import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createStore,
  FEED_PUBLIC_FIELDS,
  ROUTE_PUBLIC_FIELDS,
  STOP_PUBLIC_FIELDS,
  STOP_NEAR_FIELDS,
  TRIP_HYDRATE_FIELDS,
  DEPARTURE_FIELDS
} from '../src/store.js'

function chain() {
  const q = {
    sort() { return q },
    skip() { return q },
    limit() { return q },
    lean() { return Promise.resolve([]) }
  }
  return q
}

describe('store projections', () => {
  it('list/get queries project public fields only', async () => {
    const seen = []
    function record(coll) {
      return (filter, projection) => {
        seen.push({ coll, filter, projection })
        return chain()
      }
    }
    const models = {
      Feed: { find: record('Feed'), findOne: record('FeedOne') },
      Change: { find: record('Change'), countDocuments: async () => 0 },
      Route: { find: record('Route'), findOne: record('RouteOne'), countDocuments: async () => 0 },
      Stop: { find: record('Stop'), findOne: record('StopOne'), countDocuments: async () => 0 },
      Trip: {
        find: record('Trip'),
        countDocuments: async (filter) => {
          seen.push({ coll: 'TripCount', filter })
          return 4
        }
      },
      Departure: { find: record('Departure') },
      StopRoute: { findOne: record('StopRoute') },
      RouteStop: { findOne: record('RouteStop') }
    }
    const store = createStore(models)

    await store.listFeeds()
    await store.getFeed('carris-metropolitana')
    await store.listRoutes({ limit: 10, offset: 0 })
    await store.listStops({ limit: 10, offset: 0 })
    await store.nearStops(38.7, -9.1, 300, 25)
    await store.getDepartures('mini', 'A', '2026-10-21')
    await store.tripsByIds('mini', ['T1'])
    const n = await store.tripsToday('mini', 'R1')

    assert.equal(n, 4)
    assert.deepEqual(seen.find((s) => s.coll === 'Feed').projection, FEED_PUBLIC_FIELDS)
    assert.deepEqual(seen.find((s) => s.coll === 'Route').projection, ROUTE_PUBLIC_FIELDS)
    const stopCalls = seen.filter((s) => s.coll === 'Stop')
    assert.deepEqual(stopCalls[0].projection, STOP_PUBLIC_FIELDS)
    assert.deepEqual(stopCalls[1].projection, STOP_NEAR_FIELDS)
    assert.deepEqual(seen.find((s) => s.coll === 'Departure').projection, DEPARTURE_FIELDS)
    assert.deepEqual(seen.find((s) => s.coll === 'Trip').projection, TRIP_HYDRATE_FIELDS)
    assert.deepEqual(seen.find((s) => s.coll === 'TripCount').filter, { feed_id: 'mini', route_id: 'R1' })
  })
})
