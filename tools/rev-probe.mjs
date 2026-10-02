/**
 * List the bundle revisions this machine's GUI has actually fetched.
 *
 * Chromium's V8 code cache stores one entry per compiled script, and the asar
 * header/plugin URLs carry the revision. Reading those entries shows what the
 * page really loaded — the ground truth when "the file changed but the UI did
 * not".
 *
 * Usage: node tools/rev-probe.mjs [userDataDir]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2] ?? join(process.env.APPDATA ?? '', '@deepseek-ai', 'dsh-desktop', 'Code Cache', 'js')
const needle = Buffer.from('dsh-task-tracker/client.js', 'utf8')

const hits = []
for (const name of readdirSync(directory)) {
  const path = join(directory, name)
  let buffer
  let stat
  try {
    stat = statSync(path)
    if (!stat.isFile()) continue
    buffer = readFileSync(path)
  } catch (error) {
    continue
  }
  let index = buffer.indexOf(needle)
  while (index >= 0) {
    // The URL runs to the end of its NUL-terminated string.
    let end = index
    while (end < buffer.length && buffer[end] !== 0) end += 1
    const text = buffer.subarray(index, end).toString('utf8')
    const rev = /rev=([0-9a-f]+)/u.exec(text)
    hits.push({ at: stat.mtime.toISOString().slice(0, 19).replace('T', ' '), rev: rev === null ? '(none)' : rev[1], size: stat.size })
    index = buffer.indexOf(needle, index + 1)
  }
}

hits.sort((left, right) => (left.at < right.at ? -1 : 1))
console.log('fetched revisions of dsh-task-tracker/client.js (oldest first):')
for (const hit of hits) console.log('  ' + hit.at + '  rev=' + hit.rev + '  (' + hit.size + ' B cache entry)')
console.log('')
console.log('total ' + hits.length + ' entries; newest rev=' + (hits.length === 0 ? '-' : hits[hits.length - 1].rev))
