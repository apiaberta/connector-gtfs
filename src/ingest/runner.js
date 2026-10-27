import { fork } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import {
  LOCK_PATH, TMP_DIR, INGEST_TIMEOUT_MS, CHILD_MAX_OLD_SPACE, STARTUP_MAX_AGE_MS
} from '../config.js'
import { Feed } from '../models.js'

const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'worker.js')

let running = null

async function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function acquireLock() {
  await mkdir(TMP_DIR, { recursive: true })
  try {
    await writeFile(LOCK_PATH, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    const raw = await readFile(LOCK_PATH, 'utf8').catch(() => '')
    const pid = parseInt(raw, 10)
    const s = await stat(LOCK_PATH).catch(() => null)
    const stale = !(await pidAlive(pid)) || (s && Date.now() - s.mtimeMs > INGEST_TIMEOUT_MS + 60_000)
    if (!stale) return false
    await unlink(LOCK_PATH).catch(() => {})
    try {
      await writeFile(LOCK_PATH, String(process.pid), { flag: 'wx' })
      return true
    } catch {
      return false
    }
  }
}

export async function releaseLock() {
  await unlink(LOCK_PATH).catch(() => {})
}

export async function shouldIngestOnStartup() {
  const latest = await Feed.findOne().sort({ last_checked: -1 }).lean()
  if (!latest?.last_checked) return true
  return Date.now() - new Date(latest.last_checked).getTime() >= STARTUP_MAX_AGE_MS
}

export function runIngest(mode = 'full', logger) {
  if (running) {
    logger?.info({ mode }, 'Ingest already running — skip')
    return running.then((r) => ({ ...r, skipped: true }))
  }
  running = (async () => {
    const locked = await acquireLock()
    if (!locked) {
      logger?.info('Ingest lock held — skip')
      return { skipped: true }
    }
    try {
      return await forkWorker(mode, logger)
    } finally {
      await releaseLock()
    }
  })().finally(() => {
    running = null
  })
  return running
}

function forkWorker(mode, logger) {
  return new Promise((resolve, reject) => {
    if (!existsSync(workerPath)) {
      reject(new Error(`ingest worker missing: ${workerPath}`))
      return
    }
    const child = fork(workerPath, [mode], {
      execArgv: [`--max-old-space-size=${CHILD_MAX_OLD_SPACE}`],
      env: process.env
    })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`Ingest timed out after ${INGEST_TIMEOUT_MS}ms`))
    }, INGEST_TIMEOUT_MS)

    child.on('message', (msg) => {
      if (settled) return
      if (msg && msg.ok) {
        settled = true
        clearTimeout(timer)
        resolve(msg.result)
      } else if (msg && msg.ok === false) {
        settled = true
        clearTimeout(timer)
        reject(new Error(msg.error || 'Ingest worker failed'))
      }
    })

    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true })
      else reject(new Error(`Ingest worker exited ${code} signal=${signal}`))
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}
