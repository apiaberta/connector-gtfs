import { open as yauzlOpen } from 'yauzl'
import { parse } from 'csv-parse'

export function zipBasename(fileName) {
  return String(fileName || '').replace(/\\/g, '/').split('/').pop()
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzlOpen(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) reject(err)
      else resolve(zip)
    })
  })
}

function readNext(zip) {
  return new Promise((resolve, reject) => {
    const onEntry = (entry) => {
      cleanup()
      resolve(entry)
    }
    const onEnd = () => {
      cleanup()
      resolve(null)
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    const cleanup = () => {
      zip.off('entry', onEntry)
      zip.off('end', onEnd)
      zip.off('error', onError)
    }
    zip.once('entry', onEntry)
    zip.once('end', onEnd)
    zip.once('error', onError)
    zip.readEntry()
  })
}

function openReadStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) reject(err)
      else resolve(stream)
    })
  })
}

export async function listZipEntries(zipPath) {
  const zip = await openZip(zipPath)
  try {
    const names = []
    for (;;) {
      const entry = await readNext(zip)
      if (!entry) break
      names.push(entry.fileName)
    }
    return names
  } finally {
    zip.close()
  }
}

export function requiredGtfsFiles() {
  return ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt']
}

export function validateGtfsZip(entryNames) {
  const basenames = new Set(entryNames.map(zipBasename))
  const missing = requiredGtfsFiles().filter((f) => !basenames.has(f))
  if (missing.length) {
    throw new Error(`GTFS zip missing required files: ${missing.join(', ')}`)
  }
  if (!basenames.has('calendar.txt') && !basenames.has('calendar_dates.txt')) {
    throw new Error('GTFS zip needs calendar.txt or calendar_dates.txt')
  }
  return basenames
}

function csvParser() {
  return parse({
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: true,
    bom: true,
    skip_records_with_error: true
  })
}

/**
 * Stream one named CSV from the zip without extracting to disk
 * and without buffering the uncompressed file.
 */
export async function streamZipCsv(zipPath, fileName, onRow) {
  const wanted = zipBasename(fileName)
  const zip = await openZip(zipPath)
  let found = false
  try {
    for (;;) {
      const entry = await readNext(zip)
      if (!entry) break
      if (zipBasename(entry.fileName) !== wanted) continue
      if (/\/$/.test(entry.fileName)) continue
      found = true
      const stream = await openReadStream(zip, entry)
      const parser = csvParser()
      stream.pipe(parser)
      try {
        for await (const row of parser) {
          await onRow(row)
        }
      } finally {
        stream.destroy()
        parser.destroy()
      }
      break
    }
  } finally {
    zip.close()
  }
  return found
}

export async function collectZipCsv(zipPath, fileName) {
  const rows = []
  const found = await streamZipCsv(zipPath, fileName, (row) => {
    rows.push(row)
  })
  return found ? rows : []
}

export async function zipHasFile(zipPath, fileName) {
  const names = await listZipEntries(zipPath)
  return names.some((n) => zipBasename(n) === zipBasename(fileName))
}
