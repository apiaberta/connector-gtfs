import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const envPath = resolve(process.cwd(), '.env')
if (existsSync(envPath)) {
  try { process.loadEnvFile(envPath) } catch { /* ignore */ }
}

export const SERVICE_NAME = 'connector-gtfs'
export const VERSION = '1.1.0'
export const USER_AGENT = 'apiaberta.pt/1.0 (open-data connector)'
export const TIMEZONE = 'Europe/Lisbon'

export const PORT = parseInt(process.env.PORT || '3018', 10)
export const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/apiaberta-gtfs'

export const TMP_DIR = process.env.GTFS_TMP_DIR || '/tmp/apiaberta-gtfs'
export const LOCK_PATH = `${TMP_DIR}/ingest.lock`
export const ZIP_MAX_BYTES = 150 * 1024 * 1024
export const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000
export const INGEST_TIMEOUT_MS = 20 * 60 * 1000
export const CHILD_MAX_OLD_SPACE = 384
export const API_MAX_OLD_SPACE = 192
export const WRITE_BATCH = 1000
export const DEPARTURE_WRITE_BATCH = 500
export const DEPARTURE_SPLIT = 5000
export const DEPARTURE_FLUSH_ROWS = 40_000
export const ZIP_RETENTION_MS = 3 * 24 * 60 * 60 * 1000
export const HEAP_SOFT_LIMIT = 280 * 1024 * 1024
export const STARTUP_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const FEED_VERSIONS_KEEP = 30

/** Full ingest. 04:00 so it does not overlap connector-geo at 03:30. */
export const INGEST_CRON = process.env.GTFS_INGEST_CRON || '0 4 * * *'
export const DEPARTURES_CRON = process.env.GTFS_DEPARTURES_CRON || '5 0 * * *'

export function windowDays() {
  const n = parseInt(process.env.GTFS_WINDOW_DAYS || '2', 10)
  if (!Number.isFinite(n) || n < 1) return 2
  return Math.min(n, 3)
}
