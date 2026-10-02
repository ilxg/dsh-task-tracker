/**
 * Dump the raw bytes around the Electron fuse wire so the fuse array can be
 * aligned by inspection (the array is a run of 0x30/0x31/0x32 bytes).
 *
 * Usage: node tools/fuse-dump.mjs <executable>
 */

import { readFileSync } from 'node:fs'

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
const [, , executable] = process.argv
if (executable === undefined) {
  console.error('usage: node tools/fuse-dump.mjs <executable>')
  process.exit(2)
}

const buffer = readFileSync(executable)
const at = buffer.indexOf(Buffer.from(SENTINEL, 'utf8'))
if (at < 0) {
  console.log('fuse wire not found')
  process.exit(0)
}

console.log('sentinel at ' + at + ' (length ' + SENTINEL.length + ')')
const window = buffer.subarray(at + SENTINEL.length, at + SENTINEL.length + 40)
console.log('bytes after sentinel:')
for (let index = 0; index < window.length; index += 1) {
  const value = window[index]
  const tag = value === 0x30 ? 'DISABLED' : value === 0x31 ? 'ENABLED' : value === 0x32 ? 'UNSET' : ''
  console.log('  +' + String(index).padStart(2, ' ') + '  0x' + value.toString(16).padStart(2, '0') + '  ' + tag)
}
