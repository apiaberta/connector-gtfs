import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { USER_AGENT, ZIP_MAX_BYTES, DOWNLOAD_TIMEOUT_MS } from '../config.js'

/** One stable cache path per feed. Never share a zip across operators. */
export function zipPathFor(tmpDir, feedId) {
  const safe = String(feedId || 'feed').replace(/[^A-Za-z0-9._-]+/g, '-')
  return join(tmpDir, `${safe}.zip`)
}

export function zipPartPath(destPath, pid = process.pid) {
  return `${destPath}.${pid}.part`
}

/**
 * Remove leftover `.part` files for this feed only. Never deletes the
 * cached `${feed}.zip` and never touches other feeds' files.
 */
export async function cleanupFeedParts(tmpDir, feedId, logger) {
  const destPath = zipPathFor(tmpDir, feedId)
  const destBase = basename(destPath)
  let names
  try {
    names = await readdir(tmpDir)
  } catch {
    return
  }
  for (const name of names) {
    if (name === destBase) continue
    if (!name.startsWith(`${destBase}.`) || !name.endsWith('.part')) continue
    const p = join(tmpDir, name)
    await unlink(p).catch(() => {})
    logger?.info({ p, feed: feedId }, 'Deleted leftover zip part')
  }
}

function headerBag(headers) {
  return {
    get(name) {
      if (!headers) return null
      if (typeof headers.get === 'function') return headers.get(name)
      const key = String(name).toLowerCase()
      for (const [k, v] of Object.entries(headers)) {
        if (String(k).toLowerCase() === key) return v
      }
      return null
    }
  }
}

/**
 * Stream a zip to disk. Honours If-None-Match / If-Modified-Since only when
 * the local cache file exists. Caps size at 150 MB and hashes while writing.
 * Writes to a per-pid `.part` and renames after 'finish' so readers never
 * see a partial file.
 */
export async function downloadZip(url, destPath, opts = {}) {
  const {
    etag,
    last_modified,
    fetchFn = fetch,
    logger,
    _retried = false
  } = opts
  await mkdir(dirname(destPath), { recursive: true })
  const existing = await stat(destPath).catch(() => null)
  const headers = { 'User-Agent': USER_AGENT }
  if (etag && existing) headers['If-None-Match'] = etag
  if (last_modified && existing) headers['If-Modified-Since'] = last_modified

  const res = await fetchFn(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  })
  const resHeaders = headerBag(res.headers)

  if (res.status === 304) {
    if (existing) {
      logger?.info({ destPath, bytes: existing.size }, '304 Not Modified, reusing cached zip')
      return { notModified: true, bytes: existing.size, etag, last_modified, destPath }
    }
    if (!_retried) {
      logger?.warn({ destPath }, '304 without cached zip, re-downloading')
      return downloadZip(url, destPath, { fetchFn, logger, _retried: true })
    }
    throw new Error(`Download HTTP 304 for ${url} without a local zip`)
  }

  if (!res.ok) {
    throw new Error(`Download HTTP ${res.status} for ${url}`)
  }

  const nextEtag = resHeaders.get('etag') || etag || null
  const nextLastMod = resHeaders.get('last-modified') || last_modified || null
  const hash = createHash('sha256')
  const partPath = zipPartPath(destPath)
  const bytes = await writeZipPart(res, partPath, hash, logger)
  await rename(partPath, destPath)

  logger?.info({ destPath, bytes }, 'Downloaded zip')
  return {
    notModified: false,
    bytes,
    sha256: hash.digest('hex'),
    etag: nextEtag,
    last_modified: nextLastMod,
    destPath
  }
}

async function writeZipPart(res, partPath, hash, logger) {
  if (!res.body) throw new Error('Empty response body')
  const file = createWriteStream(partPath)
  const whenDone = finished(file, { writable: true, readable: false })
  let bytes = 0
  try {
    for await (const chunk of res.body) {
      bytes += chunk.length
      if (bytes > ZIP_MAX_BYTES) {
        throw new Error(`Zip exceeds ${ZIP_MAX_BYTES} byte cap (${bytes} bytes)`)
      }
      hash.update(chunk)
      if (!file.write(chunk)) {
        await new Promise((resolve, reject) => {
          const onError = (err) => reject(err)
          file.once('error', onError)
          file.once('drain', () => {
            file.off('error', onError)
            resolve()
          })
        })
      }
    }
    file.end()
    await whenDone
    return bytes
  } catch (err) {
    file.destroy()
    await whenDone.catch(() => {})
    await unlink(partPath).catch(() => {})
    logger?.warn?.({ err, partPath }, 'Zip part write failed')
    throw err
  }
}

export async function sha256File(filePath) {
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}
