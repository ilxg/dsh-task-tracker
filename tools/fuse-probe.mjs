/**
 * Read the Electron fuse wire out of a packaged Electron executable.
 *
 * Electron stores its fuse values as a 32-byte sentinel followed by a version
 * byte and then one byte per fuse, in the order @electron/fuses declares them.
 * Reading it answers "would this app survive a modified app.asar?" before
 * anything is touched.
 *
 * Usage: node tools/fuse-probe.mjs <executable>
 */

import { readFileSync } from 'node:fs'

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
const [, , executable] = process.argv
if (executable === undefined) {
  console.error('usage: node tools/fuse-probe.mjs <executable>')
  process.exit(2)
}

/** Fuse order as @electron/fuses declares it. */
const FUSES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
]

const buffer = readFileSync(executable)
const at = buffer.indexOf(Buffer.from(SENTINEL, 'utf8'))
if (at < 0) {
  console.log('fuse wire not found (unsupported layout)')
  process.exit(0)
}

const version = buffer[at + SENTINEL.length]
console.log('sentinel at ' + at + ', schema version ' + version)
const bytes = []
for (let index = 0; index < FUSES.length; index += 1) bytes.push(buffer[at + SENTINEL.length + 1 + index])
for (let index = 0; index < FUSES.length; index += 1) {
  const value = bytes[index]
  // 0x30 = disabled, 0x31 = enabled, anything else = unset/default.
  const state = value === 0x31 ? 'ENABLED' : value === 0x30 ? 'disabled' : 'unset(0x' + value.toString(16) + ')'
  console.log('  ' + FUSES[index].padEnd(42) + ' ' + state)
}
console.log('raw: ' + bytes.map((value) => '0x' + value.toString(16)).join(' '))
