import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  INGEST_CRON, DEPARTURES_CRON, VERSION, API_MAX_OLD_SPACE, CHILD_MAX_OLD_SPACE
} from '../src/config.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ecosystem = require('../ecosystem.config.cjs')

describe('cron and heap defaults', () => {
  it('runs full ingest at 04:00 Europe/Lisbon, not 03:30', () => {
    assert.equal(INGEST_CRON, '0 4 * * *')
    assert.equal(DEPARTURES_CRON, '5 0 * * *')
  })

  it('bumps the connector to 1.1.0', () => {
    assert.equal(VERSION, '1.1.0')
  })

  it('keeps API heap and NODE_OPTIONS at 192, ingest child at 384', () => {
    const app = ecosystem.apps[0]
    assert.equal(API_MAX_OLD_SPACE, 192)
    assert.equal(CHILD_MAX_OLD_SPACE, 384)
    assert.equal(app.node_args, '--max-old-space-size=192')
    assert.equal(app.env.NODE_OPTIONS, '--max-old-space-size=192')
    assert.equal(app.max_memory_restart, '250M')
  })
})
