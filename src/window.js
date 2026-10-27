import { windowDays } from './config.js'
import { addDaysYmd, lisbonYmd } from './time.js'

export function windowDates(now = new Date()) {
  const n = windowDays()
  const today = lisbonYmd(now)
  return Array.from({ length: n }, (_, i) => addDaysYmd(today, i))
}

export function windowRange(now = new Date()) {
  const dates = windowDates(now)
  return { from: dates[0], to: dates[dates.length - 1], dates }
}

export function isDateInWindow(ymd, now = new Date()) {
  const { from, to } = windowRange(now)
  return ymd >= from && ymd <= to
}
