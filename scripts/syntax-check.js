#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

async function walk(dir) {
  const out = []
  for (const name of await readdir(dir)) {
    const p = join(dir, name)
    const s = await stat(p)
    if (s.isDirectory()) out.push(...await walk(p))
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

const files = (await walk(srcDir)).sort()
if (files.length === 0) {
  console.error('No src/*.js files found')
  process.exit(1)
}
const r = spawnSync(process.execPath, ['--check', ...files], { stdio: 'inherit' })
process.exit(r.status ?? 1)
