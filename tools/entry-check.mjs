/**
 * Extract one entry from an asar and syntax-check it.
 *
 * A patched `lib/main.js` that fails to parse would leave the desktop app
 * unable to start, so this runs before any archive is swapped in.
 *
 * Usage: node tools/entry-check.mjs <asar> <entry-path> [output]
 */

import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { openAsar, closeAsar, readEntry, findEntry } from './asar-lib.mjs'

const [asar, entryPath, output] = process.argv.slice(2)
if (asar === undefined || entryPath === undefined) {
  console.error('usage: node tools/entry-check.mjs <asar> <entry-path> [output]')
  process.exit(2)
}

const archive = openAsar(asar)
try {
  const entry = findEntry(archive.header, entryPath)
  if (entry === undefined) throw new Error('entry not found: ' + entryPath)
  const bytes = readEntry(archive, entry)
  const target = output ?? entryPath.replace(/[\\/]/gu, '_') + '.mjs'
  writeFileSync(target, bytes)
  console.log('extracted ' + entryPath + ' → ' + target + ' (' + bytes.length + ' bytes)')
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'inherit' })
    console.log('syntax: OK')
  } catch (error) {
    console.error('syntax: FAILED')
    process.exitCode = 1
  }
  const text = bytes.toString('utf8')
  console.log('marker present: ' + (text.includes('about:blank#dsh-task-tracker') ? 'yes' : 'no'))
} finally {
  closeAsar(archive)
}
