import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { diffFeed } from '../src/diff.js'

const prev = {
  valid_to: '2026-09-23',
  stops: [{ stop_id: 'A' }, { stop_id: 'B' }, { stop_id: 'C' }],
  routes: [
    { route_id: 'R1', route_short_name: '1', route_long_name: 'Old' },
    { route_id: 'R2', route_short_name: '2', route_long_name: 'Two' }
  ],
  trips_per_route: { R1: 100, R2: 50, R3: 10 }
}

const next = {
  valid_to: '2027-03-14',
  stops: [{ stop_id: 'B' }, { stop_id: 'C' }, { stop_id: 'D' }],
  routes: [
    { route_id: 'R1', route_short_name: '1', route_long_name: 'New' },
    { route_id: 'R9', route_short_name: '9', route_long_name: 'Nine' }
  ],
  trips_per_route: { R1: 100, R2: 20, R9: 80 }
}

describe('diffFeed', () => {
  it('marks the first import as initial', () => {
    const s = diffFeed(null, next)
    assert.equal(s.initial, true)
    assert.equal(s.stops_added, 3)
    assert.equal(s.valid_to_new, '2027-03-14')
  })

  it('counts added and removed stops', () => {
    const s = diffFeed(prev, next)
    assert.equal(s.stops_added, 1)
    assert.equal(s.stops_removed, 1)
  })

  it('tracks added, removed and renamed routes', () => {
    const s = diffFeed(prev, next)
    assert.deepEqual(s.routes_added, ['R9'])
    assert.deepEqual(s.routes_removed, ['R2'])
    assert.deepEqual(s.routes_changed, [{
      route_id: 'R1',
      field: 'route_long_name',
      old: 'Old',
      new: 'New'
    }])
  })

  it('keeps trip deltas of at least 10 percent, max 200', () => {
    const s = diffFeed(prev, next)
    const ids = s.trips_per_route_delta.map((d) => d.route_id).sort()
    assert.deepEqual(ids, ['R2', 'R3', 'R9'])
    assert.equal(s.trips_per_route_delta.find((d) => d.route_id === 'R1'), undefined)
    assert.equal(s.valid_to_old, '2026-09-23')
    assert.equal(s.valid_to_new, '2027-03-14')
  })

  it('caps trips_per_route_delta at 200', () => {
    const manyOld = { trips_per_route: {} }
    const manyNew = { trips_per_route: {} }
    for (let i = 0; i < 250; i++) {
      manyOld.trips_per_route[`R${i}`] = 10
      manyNew.trips_per_route[`R${i}`] = 20
    }
    const s = diffFeed(manyOld, manyNew)
    assert.equal(s.trips_per_route_delta.length, 200)
  })
})
