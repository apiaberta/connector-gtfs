import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import mongoose from 'mongoose'
import { MONGO_URI } from '../config.js'
import { runPipeline } from './pipeline.js'

const envPath = resolve(process.cwd(), '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

const mode = process.argv[2] === 'departures' ? 'departures' : 'full'

const logger = {
  info(obj, msg) {
    if (typeof obj === 'string') console.log(`[gtfs-ingest] ${obj}`)
    else console.log(`[gtfs-ingest] ${msg || ''}`, JSON.stringify(obj))
  },
  warn(obj, msg) {
    if (typeof obj === 'string') console.warn(`[gtfs-ingest] ${obj}`)
    else console.warn(`[gtfs-ingest] ${msg || ''}`, JSON.stringify(obj))
  },
  error(obj, msg) {
    const err = obj?.err
    const extra = err ? { message: err.message, stack: err.stack } : obj
    console.error(`[gtfs-ingest] ${typeof obj === 'string' ? obj : (msg || 'error')}`, extra)
  }
}

try {
  await mongoose.connect(process.env.MONGO_URI || MONGO_URI)
  const result = await runPipeline({ mode, logger })
  if (process.send) process.send({ ok: true, result })
  await mongoose.disconnect()
  process.exit(0)
} catch (err) {
  logger.error({ err }, 'Worker failed')
  if (process.send) process.send({ ok: false, error: err.message })
  try { await mongoose.disconnect() } catch { /* ignore */ }
  process.exit(1)
}
