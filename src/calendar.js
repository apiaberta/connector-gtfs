import { weekdayName, yyyymmddToIso } from './time.js'

function asIso(value) {
  if (!value) return null
  const s = String(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  return yyyymmddToIso(s)
}

function dayFlag(cal, weekday) {
  const raw = cal[weekday]
  return raw === 1 || raw === '1' || raw === true
}

function exceptionType(row) {
  return Number(row.exception_type)
}

/**
 * Active GTFS service_ids for a civil date.
 * calendar.txt defines the weekly base; calendar_dates.txt adds (1)
 * or removes (2) services on that date.
 */
export function activeServices(date, calendars = [], calendarDates = []) {
  const ymd = asIso(date)
  if (!ymd) return new Set()
  const weekday = weekdayName(ymd)
  const active = new Set()

  for (const cal of calendars) {
    const start = asIso(cal.start_date)
    const end = asIso(cal.end_date)
    if (!start || !end) continue
    if (ymd < start || ymd > end) continue
    if (dayFlag(cal, weekday)) active.add(String(cal.service_id))
  }

  for (const row of calendarDates) {
    const d = asIso(row.date)
    if (d !== ymd) continue
    const sid = String(row.service_id)
    const type = exceptionType(row)
    if (type === 1) active.add(sid)
    else if (type === 2) active.delete(sid)
  }

  return active
}

export function servicesByDate(dates, calendars, calendarDates) {
  const map = new Map()
  for (const d of dates) map.set(d, activeServices(d, calendars, calendarDates))
  return map
}

export function unionServices(byDate) {
  const all = new Set()
  for (const set of byDate.values()) {
    for (const id of set) all.add(id)
  }
  return all
}
