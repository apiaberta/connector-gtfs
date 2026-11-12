import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { packDep, unpackDep, flattenDepartureDocs, hydrateFlat } from '../src/departures-read.js'

describe('packed departure format', () => {
  it('round-trips t, trip_id, route_id', () => {
    const packed = packDep('25:10:00', 'T3', 'R2')
    assert.equal(packed, '25:10:00\tT3\tR2')
    assert.deepEqual(unpackDep(packed), { t: '25:10:00', trip_id: 'T3', route_id: 'R2' })
  })

  it('unpacks two-field strings and old object docs', () => {
    assert.equal(unpackDep('08:00:00\tT1').route_id, '')
    const old = {
      t: '08:00:00',
      ts: new Date('2026-10-21T07:00:00.000Z'),
      trip_id: 'T1',
      route_id: 'R1',
      route_short_name: '1',
      headsign: 'A to D',
      direction_id: 0
    }
    assert.equal(unpackDep(old).route_short_name, '1')
    assert.equal(unpackDep(old).headsign, 'A to D')
  })

  it('flattens mixed packed and object parts in time order', () => {
    const docs = [
      {
        feed_id: 'mini',
        stop_id: 'A',
        date: '2026-10-21',
        part: 1,
        deps: ['09:00:00\tT2\tR1']
      },
      {
        feed_id: 'mini',
        stop_id: 'A',
        date: '2026-10-21',
        part: 0,
        deps: [{ t: '08:00:00', trip_id: 'T1', route_id: 'R1', route_short_name: '1', headsign: 'A to D', ts: new Date('2026-10-21T07:00:00.000Z') }]
      }
    ]
    const flat = flattenDepartureDocs(docs)
    assert.equal(flat[0].t, '08:00:00')
    assert.equal(flat[0].route_short_name, '1')
    assert.equal(flat[1].t, '09:00:00')
    assert.equal(flat[1].trip_id, 'T2')
    assert.ok(flat[1].ts instanceof Date)
  })
})

describe('hydrateFlat', () => {
  it('skips lookups when the old object already has names', async () => {
    const calls = { trips: 0, routes: 0 }
    const store = {
      tripsByIds: async () => { calls.trips++; return [] },
      routesByIds: async () => { calls.routes++; return [] }
    }
    const deps = flattenDepartureDocs([{
      feed_id: 'mini',
      stop_id: 'A',
      date: '2026-10-21',
      deps: [{
        t: '08:00:00',
        ts: new Date('2026-10-21T07:00:00.000Z'),
        trip_id: 'T1',
        route_id: 'R1',
        route_short_name: '1',
        headsign: 'A to D'
      }]
    }])
    const out = await hydrateFlat(deps, store)
    assert.equal(calls.trips, 0)
    assert.equal(calls.routes, 0)
    assert.equal(out[0].headsign, 'A to D')
  })

  it('joins headsign and short name for packed deps', async () => {
    const store = {
      tripsByIds: async (feedId, ids) => {
        assert.equal(feedId, 'mini')
        assert.deepEqual(ids, ['T3'])
        return [{ trip_id: 'T3', route_id: 'R2', headsign: 'Night metro' }]
      },
      routesByIds: async (feedId, ids) => {
        assert.equal(feedId, 'mini')
        assert.deepEqual([...ids].sort(), ['R2'])
        return [{ route_id: 'R2', route_short_name: 'M' }]
      }
    }
    const deps = flattenDepartureDocs([{
      feed_id: 'mini',
      stop_id: 'B',
      date: '2026-10-26',
      deps: [packDep('25:10:00', 'T3', 'R2')]
    }])
    const out = await hydrateFlat(deps, store)
    assert.equal(out[0].headsign, 'Night metro')
    assert.equal(out[0].route_short_name, 'M')
    assert.equal(out[0].route_id, 'R2')
    assert.equal(out[0].ts.toISOString(), '2026-10-27T01:10:00.000Z')
  })
})
