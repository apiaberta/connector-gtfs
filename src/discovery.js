import { USER_AGENT, DOWNLOAD_TIMEOUT_MS } from './config.js'

export class DiscoveryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DiscoveryError'
  }
}

function parseNameDate(name, pattern) {
  const m = String(name || '').match(pattern)
  if (!m) return null
  const dd = Number(m[1])
  const mm = Number(m[2])
  const yyyy = Number(m[3])
  if (!yyyy || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  return Date.UTC(yyyy, mm - 1, dd)
}

function looksLikeZip(resource) {
  const format = String(resource.format || '').toLowerCase()
  const url = String(resource.url || resource.latest || '')
  const mime = String(resource.mimetype || resource.mime || '').toLowerCase()
  return (
    format === 'zip' ||
    format === 'gtfs' ||
    mime.includes('zip') ||
    url.toLowerCase().split('?')[0].endsWith('.zip')
  )
}

/**
 * CKAN resources are often migrated with identical `created` timestamps.
 * Pick the latest by DD-MM-YYYY parsed from `name`.
 */
export function pickCkanResource(resources, namePattern) {
  const pattern = namePattern instanceof RegExp ? namePattern : /(\d{2})-(\d{2})-(\d{4})/
  let best = null
  let bestTs = -1
  for (const r of resources || []) {
    if (!r?.url) continue
    const ts = parseNameDate(r.name, pattern)
    if (ts == null) continue
    if (!looksLikeZip(r) && !String(r.name || '').toUpperCase().includes('GTFS')) continue
    if (ts > bestTs) {
      bestTs = ts
      best = r
    }
  }
  return best
}

/**
 * dados.gov.pt (udata): zip resource (format=zip or URL ending .zip)
 * with the greatest last_modified.
 */
export function pickUdataResource(resources) {
  const zips = (resources || []).filter((r) => r && looksLikeZip(r))
  zips.sort((a, b) => {
    const ta = Date.parse(a.last_modified || a.last_update || 0)
    const tb = Date.parse(b.last_modified || b.last_update || 0)
    return tb - ta
  })
  return zips[0] || null
}

async function fetchJson(url, fetchFn, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const res = await fetchFn(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new DiscoveryError(`HTTP ${res.status} fetching ${url}`)
  return res.json()
}

export async function resolveFeedUrl(feed, { fetchFn = fetch } = {}) {
  const d = feed.discovery
  if (!d) throw new DiscoveryError(`Feed ${feed.id} has no discovery config`)

  if (d.type === 'fixed') {
    return { url: d.url, source_url: d.url, name: feed.name }
  }

  if (d.type === 'udata') {
    const api = `https://dados.gov.pt/api/1/datasets/${d.dataset}/`
    const data = await fetchJson(api, fetchFn)
    const resource = pickUdataResource(data.resources)
    if (!resource?.url) throw new DiscoveryError(`No zip resource on udata dataset ${d.dataset}`)
    return {
      url: resource.url,
      source_url: api,
      name: resource.title || resource.url,
      last_modified: resource.last_modified || null
    }
  }

  if (d.type === 'ckan') {
    const api = `${d.base.replace(/\/$/, '')}/api/3/action/package_show?id=${encodeURIComponent(d.package)}`
    const data = await fetchJson(api, fetchFn)
    const resources = data?.result?.resources || []
    const resource = pickCkanResource(resources, d.namePattern)
    if (!resource?.url) throw new DiscoveryError(`No dated GTFS resource on CKAN package ${d.package}`)
    return {
      url: resource.url,
      source_url: api,
      name: resource.name || resource.url,
      last_modified: resource.last_modified || null
    }
  }

  throw new DiscoveryError(`Unknown discovery type ${d.type}`)
}
