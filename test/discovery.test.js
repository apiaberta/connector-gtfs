import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickCkanResource, pickUdataResource } from '../src/discovery.js'

const dir = dirname(fileURLToPath(import.meta.url))
const ckan = JSON.parse(readFileSync(join(dir, 'fixtures/ckan-metro-porto.json'), 'utf8'))
const udata = JSON.parse(readFileSync(join(dir, 'fixtures/udata-metro-lisboa.json'), 'utf8'))

describe('pickCkanResource', () => {
  it('picks Metro do Porto 07-09-2026 from identical created timestamps', () => {
    const picked = pickCkanResource(ckan.resources, /(\d{2})-(\d{2})-(\d{4})/)
    assert.ok(picked)
    assert.match(picked.name, /07-09-2026/)
    assert.match(picked.url, /07_09_2026\.zip$/)
  })

  it('ignores MM-YYYY-only names and the Fonte page', () => {
    const picked = pickCkanResource(ckan.resources)
    assert.notEqual(picked.name.includes('07-2022'), true)
    assert.notEqual(picked.url.includes('metrodoporto.pt'), true)
  })
})

describe('pickUdataResource', () => {
  it('picks the zip with the latest last_modified', () => {
    const picked = pickUdataResource(udata.resources)
    assert.ok(picked)
    assert.match(picked.url, /20261026-150924-d399cedf\/googletransit\.zip$/)
  })

  it('ignores non-zip resources even if newer', () => {
    const picked = pickUdataResource(udata.resources)
    assert.notEqual(picked.format, 'csv')
  })
})
