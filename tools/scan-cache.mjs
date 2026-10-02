/**
 * Byte-level forensic scan: does any Chromium/Electron cache under a directory
 * contain the given ASCII needles? Used to prove the running desktop GUI page
 * actually materialized this plugin's browser bundle.
 *
 * Usage: node tools/scan-cache.mjs <directory> <needle> [needle...]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const [directory, ...needles] = process.argv.slice(2)
if (directory === undefined || needles.length === 0) {
  console.error('usage: node tools/scan-cache.mjs <directory> <needle> [needle...]')
  process.exit(2)
}

const patterns = needles.map((needle) => ({
  needle,
  bytes: [Buffer.from(needle, 'utf8'), Buffer.from(needle, 'utf16le')],
}))
const hits = new Map(patterns.map((entry) => [entry.needle, []]))

/** Depth-first walk that survives unreadable entries. */
function walk(directory, visit) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    try {
      if (entry.isDirectory()) walk(path, visit)
      else if (entry.isFile()) visit(path, statSync(path).size)
    } catch (error) {
      /* skip */
    }
  }
}

let scanned = 0
let bytes = 0
walk(directory, (path, size) => {
  scanned += 1
  bytes += size
  let buffer
  try {
    buffer = readFileSync(path)
  } catch (error) {
    return
  }
  for (const { needle, bytes: encodings } of patterns) {
    const offset = encodings.map((pattern) => buffer.indexOf(pattern)).find((found) => found >= 0)
    if (offset !== undefined) hits.get(needle).push({ path, offset, size })
  }
})

console.log('scanned ' + scanned + ' files, ' + (bytes / 1048576).toFixed(1) + ' MiB under ' + directory)
for (const { needle } of patterns) {
  const found = hits.get(needle)
  console.log('\n' + needle + ': ' + found.length + ' hit(s)')
  for (const hit of found.slice(0, 8)) console.log('  ' + hit.path + '  @' + hit.offset + '  (' + hit.size + ' B)')
}
