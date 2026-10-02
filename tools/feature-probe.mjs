/**
 * Does this Electron build expose a browser feature?
 *
 * Chromium keeps feature and IDL names as strings in the binary, so a byte scan
 * of the executable answers "is this API compiled in?" without launching it.
 * Use it to predict which task-window mode an environment can offer.
 *
 * Usage: node tools/feature-probe.mjs <executable> <needle> [needle...]
 */

import { readFileSync, statSync } from 'node:fs'

const [executable, ...needles] = process.argv.slice(2)
if (executable === undefined || needles.length === 0) {
  console.error('usage: node tools/feature-probe.mjs <executable> <needle> [needle...]')
  process.exit(2)
}

const size = statSync(executable).size
const buffer = readFileSync(executable)
console.log('scanned ' + (size / 1048576).toFixed(1) + ' MiB: ' + executable)
for (const needle of needles) {
  const utf8 = buffer.indexOf(Buffer.from(needle, 'utf8'))
  const utf16 = buffer.indexOf(Buffer.from(needle, 'utf16le'))
  const found = utf8 >= 0 ? utf8 : utf16
  console.log((found >= 0 ? '  present ' : '  absent  ') + needle + (found >= 0 ? '  @' + found : ''))
}
