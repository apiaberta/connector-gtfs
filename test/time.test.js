import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { gtfsTimeToUtc, formatHhMm, addDaysYmd } from '../src/time.js'

describe('gtfsTimeToUtc', () => {
  it('converts WEST summer time (UTC+1)', () => {
    const d = gtfsTimeToUtc('2026-06-15', '08:15:00')
    assert.equal(d.toISOString(), '2026-06-15T07:15:00.000Z')
  })

  it('converts WET winter time (UTC+0)', () => {
    const d = gtfsTimeToUtc('2026-01-15', '08:15:00')
    assert.equal(d.toISOString(), '2026-01-15T08:15:00.000Z')
  })

  it('maps 25:10:00 onto the next civil day', () => {
    const d = gtfsTimeToUtc('2026-06-15', '25:10:00')
    assert.equal(d.toISOString(), '2026-06-16T00:10:00.000Z')
    assert.equal(formatHhMm('25:10:00'), '01:10')
  })

  it('handles 25:10:00 across the 2026-10-25 fall-back', () => {
    // 25:10 on 24 Oct = 01:10 on 25 Oct. 01:10 occurs twice that night;
    // the converter settles on the later (WET) occurrence.
    const d = gtfsTimeToUtc('2026-10-24', '25:10:00')
    assert.equal(d.toISOString(), '2026-10-25T01:10:00.000Z')
  })

  it('uses WET after the 2026-10-25 fall-back', () => {
    const morning = gtfsTimeToUtc('2026-10-25', '08:15:00')
    assert.equal(morning.toISOString(), '2026-10-25T08:15:00.000Z')
    const before = gtfsTimeToUtc('2026-10-25', '00:30:00')
    assert.equal(before.toISOString(), '2026-10-24T23:30:00.000Z')
  })

  it('uses WEST after the 2027-03-28 spring-forward', () => {
    const d = gtfsTimeToUtc('2027-03-28', '08:15:00')
    assert.equal(d.toISOString(), '2027-03-28T07:15:00.000Z')
  })

  it('resolves 25:10:00 into the 2027-03-28 DST gap as a valid instant', () => {
    const d = gtfsTimeToUtc('2027-03-27', '25:10:00')
    assert.ok(d instanceof Date)
    assert.equal(Number.isNaN(d.getTime()), false)
    assert.equal(d.toISOString().startsWith('2027-03-28T'), true)
    // 01:10 civil does not exist; converter lands on 00:10 or 01:10 UTC
    const hour = d.getUTCHours()
    assert.ok(hour === 0 || hour === 1)
    assert.equal(d.getUTCMinutes(), 10)
  })

  it('addDaysYmd is calendar arithmetic', () => {
    assert.equal(addDaysYmd('2026-10-25', 1), '2026-10-26')
    assert.equal(addDaysYmd('2027-03-28', -1), '2027-03-27')
  })
})
