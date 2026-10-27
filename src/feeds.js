/**
 * Static feed catalogue. Adding an operator is a new entry here.
 * Optional GTFS_FEEDS=carris,metro-lisboa,... filters the list
 * (`carris` matches `carris-metropolitana`).
 */
export const FEEDS = [
  {
    id: 'carris-metropolitana',
    name: 'Carris Metropolitana',
    agency_label: 'TML / Carris Metropolitana',
    region: 'lisboa',
    discovery: { type: 'fixed', url: 'https://api.carrismetropolitana.pt/gtfs' },
    license: 'see operator',
    attribution: 'Carris Metropolitana / TML'
  },
  {
    id: 'metro-lisboa',
    name: 'Metropolitano de Lisboa',
    agency_label: 'Metropolitano de Lisboa',
    region: 'lisboa',
    discovery: { type: 'udata', dataset: 'gtfs-do-metropolitano-de-lisboa' },
    license: 'CC-BY',
    attribution: 'Metropolitano de Lisboa'
  },
  {
    id: 'cp',
    name: 'CP — Comboios de Portugal',
    agency_label: 'CP',
    region: 'nacional',
    discovery: { type: 'fixed', url: 'https://publico.cp.pt/gtfs/gtfs.zip' },
    license: 'NAP-PT',
    attribution: 'CP — Comboios de Portugal'
  },
  {
    id: 'fertagus',
    name: 'Fertagus',
    agency_label: 'Fertagus',
    region: 'lisboa',
    discovery: { type: 'fixed', url: 'https://www.fertagus.pt/GTFSTMLzip/Fertagus_GTFS.zip' },
    license: 'see operator',
    attribution: 'Fertagus'
  },
  {
    id: 'metro-porto',
    name: 'Metro do Porto',
    agency_label: 'Metro do Porto',
    region: 'porto',
    discovery: {
      type: 'ckan',
      base: 'https://dadosabertos.cm-porto.pt',
      package: 'horarios-paragens-e-rotas-metro-porto',
      namePattern: /(\d{2})-(\d{2})-(\d{4})/
    },
    license: 'see operator',
    attribution: 'Metro do Porto'
  },
  {
    id: 'stcp',
    name: 'STCP',
    agency_label: 'STCP',
    region: 'porto',
    discovery: {
      type: 'ckan',
      base: 'https://dadosabertos.cm-porto.pt',
      package: 'horarios-paragens-e-rotas-stcp',
      namePattern: /(\d{2})-(\d{2})-(\d{4})/
    },
    license: 'cc-zero',
    attribution: 'STCP'
  }
]

export function enabledFeeds() {
  const raw = process.env.GTFS_FEEDS
  if (!raw || !raw.trim()) return FEEDS
  const wanted = new Set(
    raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  )
  return FEEDS.filter((f) => {
    if (wanted.has(f.id)) return true
    const short = f.id.replace(/-metropolitana$/, '')
    return wanted.has(short)
  })
}

export function getFeedDef(id) {
  return FEEDS.find((f) => f.id === id) || null
}
