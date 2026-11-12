import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import mongoose from 'mongoose'
import cron from 'node-cron'
import { PORT, MONGO_URI, SERVICE_NAME, INGEST_CRON, DEPARTURES_CRON } from './config.js'
import { buildApp } from './app.js'
import { runIngest, shouldIngestOnStartup } from './ingest/runner.js'
import { ensureIndexes } from './models.js'

const envPath = resolve(process.cwd(), '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

await mongoose.connect(process.env.MONGO_URI || MONGO_URI)
await ensureIndexes()

const app = await buildApp()
app.log.info('Connected to MongoDB')

cron.schedule(INGEST_CRON, () => {
  app.log.info({ cron: INGEST_CRON }, 'Cron: full GTFS ingest')
  runIngest('full', app.log)
    .then((r) => app.log.info({ r }, 'Full ingest complete'))
    .catch((err) => app.log.error({ err }, 'Full ingest failed'))
}, { timezone: 'Europe/Lisbon' })

cron.schedule(DEPARTURES_CRON, () => {
  app.log.info({ cron: DEPARTURES_CRON }, 'Cron: roll GTFS departure window')
  runIngest('departures', app.log)
    .then((r) => app.log.info({ r }, 'Departure roll complete'))
    .catch((err) => app.log.error({ err }, 'Departure roll failed'))
}, { timezone: 'Europe/Lisbon' })

await app.listen({ port: Number(process.env.PORT || PORT), host: '0.0.0.0' })
app.log.info(`${SERVICE_NAME} listening on port ${process.env.PORT || PORT}`)

if (await shouldIngestOnStartup()) {
  app.log.info('Data older than 24h (or empty) — starting ingest child')
  runIngest('full', app.log)
    .then((r) => app.log.info({ r }, 'Startup ingest complete'))
    .catch((err) => app.log.error({ err }, 'Startup ingest failed'))
} else {
  app.log.info('Recent data present — skipping startup ingest')
}
