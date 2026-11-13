import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { miniGtfsZip } from './helpers/zip.js'
import {
  cleanupFeedParts, downloadZip, sha256File, zipPartPath, zipPathFor
} from '../src/ingest/download.js'
import { listZipEntries, validateGtfsZip } from '../src/ingest/zip.js'

const FEED_IDS = [
  'carris-metropolitana',
  'metro-lisboa',
  'cp',
  'fertagus',
  'metro-porto',
  'stcp'
]

function zipBody() {
  return miniGtfsZip()
}

function okResponse(buf, extraHeaders = {}) {
  const headers = { etag: '"v1"', 'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT', ...extraHeaders }
  return {
    status: 200,
    ok: true,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    body: (async function* () { yield buf })()
  }
}

function notModifiedResponse() {
  return {
    status: 304,
    ok: false,
    headers: { get: () => null },
    body: null
  }
}

describe('zipPathFor', () => {
  it('gives each feed a unique file under the tmp dir', () => {
    const dir = '/tmp/apiaberta-gtfs'
    const paths = FEED_IDS.map((id) => zipPathFor(dir, id))
    assert.equal(new Set(paths).size, FEED_IDS.length)
    for (const p of paths) {
      assert.equal(p.startsWith(`${dir}/`), true)
      assert.equal(p.endsWith('.zip'), true)
      assert.equal(p.includes('..'), false)
    }
    assert.equal(zipPathFor(dir, 'metro/lisboa'), join(dir, 'metro-lisboa.zip'))
  })
})

describe('downloadZip finish + 304 cache', () => {
  let dir

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gtfs-zip-'))
  })

  it('waits for write finish so the file is complete before return', async () => {
    const dest = zipPathFor(dir, 'finish-feed')
    const buf = zipBody()
    const result = await downloadZip('https://example.test/gtfs.zip', dest, {
      fetchFn: async () => okResponse(buf)
    })
    const onDisk = await stat(dest)
    assert.equal(onDisk.size, buf.length)
    assert.equal(result.bytes, buf.length)
    assert.equal(result.notModified, false)
    assert.ok(result.sha256)
    validateGtfsZip(await listZipEntries(dest))
  })

  it('does not send validators when the local zip is missing, so 304 is not requested', async () => {
    const dest = zipPathFor(dir, 'no-cache-feed')
    const seen = []
    await downloadZip('https://example.test/gtfs.zip', dest, {
      etag: '"stale"',
      last_modified: 'Wed, 01 Jan 2025 00:00:00 GMT',
      fetchFn: async (_url, opts) => {
        seen.push(opts.headers)
        return okResponse(zipBody())
      }
    })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]['If-None-Match'], undefined)
    assert.equal(seen[0]['If-Modified-Since'], undefined)
    assert.ok(await stat(dest))
  })

  it('retries a full GET when the server returns 304 but the zip is gone', async () => {
    const dest = zipPathFor(dir, 'stale-304')
    let calls = 0
    const result = await downloadZip('https://example.test/gtfs.zip', dest, {
      etag: '"abc"',
      fetchFn: async () => {
        calls++
        if (calls === 1) return notModifiedResponse()
        return okResponse(zipBody())
      }
    })
    assert.equal(calls, 2)
    assert.equal(result.notModified, false)
    assert.ok(await stat(dest))
    await sha256File(dest)
  })

  it('reuses the local zip on 304 when the file exists', async () => {
    const dest = zipPathFor(dir, 'have-cache')
    await writeFile(dest, zipBody())
    let calls = 0
    const result = await downloadZip('https://example.test/gtfs.zip', dest, {
      etag: '"abc"',
      last_modified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fetchFn: async (_url, opts) => {
        calls++
        assert.equal(opts.headers['If-None-Match'], '"abc"')
        return notModifiedResponse()
      }
    })
    assert.equal(calls, 1)
    assert.equal(result.notModified, true)
    assert.ok(result.bytes > 0)
  })
})

describe('several feeds in sequence', () => {
  let dir
  const payload = zipBody()

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gtfs-seq-'))
  })

  after(async () => {
    // leave the tmp dir; OS cleans it. Assert nothing threw.
  })

  it('keeps every feed zip after later downloads and per-feed part cleanup', async () => {
    // Mirrors tonight's 04:00 run: carris 200 (unchanged after hash),
    // cp 200 (updated), the others 304 with no local file — which used
    // to ENOENT when the shared cleanup had deleted their cache.
    const behaviour = {
      'carris-metropolitana': '200',
      'metro-lisboa': '304-missing',
      cp: '200',
      fertagus: '304-missing',
      'metro-porto': '304-missing',
      stcp: '304-missing'
    }
    const calls = Object.fromEntries(FEED_IDS.map((id) => [id, 0]))

    for (const feedId of FEED_IDS) {
      const dest = zipPathFor(dir, feedId)
      await cleanupFeedParts(dir, feedId)
      const mode = behaviour[feedId]
      const result = await downloadZip(`https://example.test/${feedId}.zip`, dest, {
        etag: '"prev"',
        last_modified: 'Tue, 01 Jan 2025 00:00:00 GMT',
        fetchFn: async () => {
          calls[feedId]++
          if (mode === '304-missing' && calls[feedId] === 1) return notModifiedResponse()
          return okResponse(payload)
        }
      })
      const local = await stat(dest)
      assert.ok(local.size > 0, `${feedId} zip missing after download`)
      await sha256File(dest)
      validateGtfsZip(await listZipEntries(dest))
      if (mode === '304-missing') {
        assert.equal(calls[feedId], 2, `${feedId} should retry after 304`)
        assert.equal(result.notModified, false)
      } else {
        assert.equal(calls[feedId], 1)
      }
      await cleanupFeedParts(dir, feedId)
    }

    for (const feedId of FEED_IDS) {
      assert.ok(await stat(zipPathFor(dir, feedId)), `${feedId} zip lost after later feeds`)
    }

    const victim = zipPathFor(dir, 'carris-metropolitana')
    const leftover = zipPartPath(victim, 99999)
    await writeFile(leftover, 'partial')
    await utimes(victim, new Date(Date.now() - 10 * 24 * 3600 * 1000), new Date(Date.now() - 10 * 24 * 3600 * 1000))
    await cleanupFeedParts(dir, 'carris-metropolitana')
    await assert.rejects(() => stat(leftover), { code: 'ENOENT' })
    assert.ok(await stat(victim), 'cleanup must not delete this feed zip')
    assert.ok(await stat(zipPathFor(dir, 'metro-lisboa')), 'cleanup must not delete sibling feeds')
    assert.ok(await stat(zipPathFor(dir, 'cp')))
    assert.ok(await stat(zipPathFor(dir, 'stcp')))
  })
})
