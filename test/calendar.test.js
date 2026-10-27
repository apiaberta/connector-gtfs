import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { activeServices } from '../src/calendar.js'

const calendars = [
  {
    service_id: 'WEEK',
    monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
    saturday: 0, sunday: 0,
    start_date: '2026-01-01',
    end_date: '2026-12-31'
  },
  {
    service_id: 'WEEKEND',
    monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0,
    saturday: 1, sunday: 1,
    start_date: '20260101',
    end_date: '20261231'
  }
]

const exceptions = [
  { service_id: 'WEEK', date: '20261026', exception_type: 2 },
  { service_id: 'SPECIAL', date: '2026-10-26', exception_type: 1 }
]

describe('activeServices', () => {
  it('includes weekday services on a Wednesday', () => {
    const s = activeServices('2026-10-21', calendars, exceptions)
    assert.deepEqual([...s].sort(), ['WEEK'])
  })

  it('includes weekend services on a Saturday', () => {
    const s = activeServices('2026-10-24', calendars, exceptions)
    assert.deepEqual([...s].sort(), ['WEEKEND'])
  })

  it('applies calendar_dates add/remove on 2026-10-26 (Monday)', () => {
    const s = activeServices('2026-10-26', calendars, exceptions)
    assert.equal(s.has('WEEK'), false)
    assert.equal(s.has('SPECIAL'), true)
    assert.equal(s.has('WEEKEND'), false)
  })

  it('ignores services outside their date range', () => {
    const s = activeServices('2025-12-31', calendars, [])
    assert.equal(s.size, 0)
  })
})
