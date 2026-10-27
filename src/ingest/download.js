import { createWriteStream } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { finished } from 'node:stream/promises'
import { USER_AGENT, ZIP_MAX_BYTES, DOWNLOAD_TIMEOUT_MS } from '../config.js'

export function zipPathFor(tmpDir, feedId) {
  return `${tmpDir}/${feedId}.zip`
}

/**
 * Stream a zip to disk. Honours If-None-Match / If-Modified-Since.
 * Caps size at 150 MB and hashes while writing — never buffers the body.
 */
export async function downloadZip(url, destPath, { etag, last_modified, fetchFn = fetch, logger } = {}) {
  await mkdir(dirname(destPath), { recursive: true })
  const headers = { 'User-Agent': USER_AGENT }
  if (etag) headers['If-None-Match'] = etag
  if (last_modified) headers['If-Modified-Since'] = last_modified

  const res = await fetchFn(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  })

  if (res.status === 304) {
    const existing = await stat(destPath).catch(() => null)
    if (existing) {
      logger?.info({ destPath, bytes: existing.size }, '304 Not Modified, reusing cached zip')
      return { notModified: true, bytes: existing.size, etag, last_modified, destPath }
    }
  }

  if (!res.ok) {
    throw new Error(`Download HTTP ${res.status} for ${url}`)
  }

  const nextEtag = res.headers.get('etag') || etag || null
  const nextLastMod = res.headers.get('last-modified') || last_modified || null
  const hash = createHash('sha256')
  let bytes = 0

  const file = createWriteStream(destPath)
  try {
    if (!res.body) throw new Error('Empty response body')
    for await (const chunk of res.body) {
      bytes += chunk.length
      if (bytes > ZIP_MAX_BYTES) {
        file.destroy()
        await unlink(destPath).catch(() => {})
        throw new Error(`Zip exceeds ${ZIP_MAX_BYTES} byte cap (${bytes} bytes)`)
      }
      hash.update(chunk)
      if (!file.write(chunk)) {
        await new Promise((resolve) => file.once('drain', resolve))
      }
    }
    file.end()
    await finished(file)
  } catch (err) {
    file.destroy()
    await unlink(destPath).catch(() => {})
    throw err
  }

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

export async function sha256File(filePath) {
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}
