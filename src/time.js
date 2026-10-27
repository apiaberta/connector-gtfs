import { TIMEZONE } from './config.js'

const LISBON_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

const LISBON_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
})

export function lisbonYmd(date = new Date()) {
  return LISBON_YMD.format(date)
}

export function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + Number(days)))
  return dt.toISOString().slice(0, 10)
}

export function yyyymmddToIso(value) {
  if (value == null || value === '') return null
  const v = String(value).trim().replace(/-/g, '')
  if (!/^\d{8}$/.test(v)) return null
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
}

export function isoToYyyymmdd(ymd) {
  return String(ymd).replace(/-/g, '')
}

export function weekdayName(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  return names[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

export function parseGtfsTime(hhmmss) {
  const parts = String(hhmmss || '').trim().split(':')
  if (parts.length < 2) return null
  const hours = Number(parts[0])
  const minutes = Number(parts[1])
  const seconds = Number(parts[2] || 0)
  if (![hours, minutes, seconds].every(Number.isFinite)) return null
  return { hours, minutes, seconds }
}

export function formatHhMm(hhmmss) {
  const t = parseGtfsTime(hhmmss)
  if (!t) return String(hhmmss || '').slice(0, 5)
  const h = String(t.hours % 24).padStart(2, '0')
  const m = String(t.minutes).padStart(2, '0')
  return `${h}:${m}`
}

function tzOffsetMs(instant) {
  const parts = Object.fromEntries(
    LISBON_PARTS.formatToParts(instant).map((p) => [p.type, p.value])
  )
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  )
  return asUtc - instant.getTime()
}

/**
 * Convert a civil Europe/Lisbon clock time to a UTC Date.
 * DST gaps (spring-forward) resolve to the post-transition instant.
 * DST overlaps (fall-back) settle on the later (standard-time) occurrence
 * after a short fixed-point iteration.
 */
export function civilLisbonToUtc(year, month, day, hour, minute, second) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second)
  let t = utcGuess
  for (let i = 0; i < 4; i++) {
    const offset = tzOffsetMs(new Date(t))
    const next = utcGuess - offset
    if (next === t) break
    t = next
  }
  return new Date(t)
}

/**
 * GTFS departure_time (may be ≥ 24:00:00) on a service date → UTC Date.
 * 25:10:00 on D is 01:10:00 civil time on D+1 in Europe/Lisbon.
 */
export function gtfsTimeToUtc(serviceDate, hhmmss, timeZone = TIMEZONE) {
  if (timeZone !== TIMEZONE) {
    throw new Error(`Unsupported timezone ${timeZone}`)
  }
  const t = parseGtfsTime(hhmmss)
  if (!t) return null
  const extraDays = Math.floor(t.hours / 24)
  const hour = ((t.hours % 24) + 24) % 24
  const ymd = extraDays ? addDaysYmd(serviceDate, extraDays) : serviceDate
  const [y, m, d] = ymd.split('-').map(Number)
  return civilLisbonToUtc(y, m, d, hour, t.minutes, t.seconds)
}

export function lisbonHm(date = new Date()) {
  const parts = Object.fromEntries(
    LISBON_PARTS.formatToParts(date).map((p) => [p.type, p.value])
  )
  return `${parts.hour}:${parts.minute}`
}
