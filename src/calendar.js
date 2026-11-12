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
 * Fold one calendar.txt row into the per-date service sets.
 * Used while streaming so the 58k calendar_dates rows are never all held.
 */
export function addCalendarToServices(cal, dates, byDate) {
  for (const ymd of dates) {
    const set = byDate.get(ymd)
    if (!set) continue
    const start = asIso(cal.start_date)
    const end = asIso(cal.end_date)
    if (!start || !end) continue
    if (ymd < start || ymd > end) continue
    if (dayFlag(cal, weekdayName(ymd))) set.add(String(cal.service_id))
  }
}

/** Fold one calendar_dates.txt exception into the window map (add=1, remove=2). */
export function addCalendarDateToServices(row, byDate) {
  const d = asIso(row.date)
  const set = byDate.get(d)
  if (!set) return
  const sid = String(row.service_id)
  const type = exceptionType(row)
  if (type === 1) set.add(sid)
  else if (type === 2) set.delete(sid)
}

export function emptyByDate(dates) {
  const map = new Map()
  for (const d of dates) map.set(d, new Set())
  return map
}

/**
 * Active GTFS service_ids for a civil date.
 * calendar.txt defines the weekly base; calendar_dates.txt adds (1)
 * or removes (2) services on that date.
 */
export function activeServices(date, calendars = [], calendarDates = []) {
  const ymd = asIso(date)
  if (!ymd) return new Set()
  const dates = [ymd]
  const byDate = emptyByDate(dates)
  for (const cal of calendars) addCalendarToServices(cal, dates, byDate)
  for (const row of calendarDates) addCalendarDateToServices(row, byDate)
  return byDate.get(ymd)
}

export function servicesByDate(dates, calendars, calendarDates) {
  const byDate = emptyByDate(dates)
  for (const cal of calendars) addCalendarToServices(cal, dates, byDate)
  for (const row of calendarDates) addCalendarDateToServices(row, byDate)
  return byDate
}

export function unionServices(byDate) {
  const all = new Set()
  for (const set of byDate.values()) {
    for (const id of set) all.add(id)
  }
  return all
}
