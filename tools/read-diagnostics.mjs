/**
 * Read this plugin's live-page diagnostics out of Chromium's Local Storage
 * leveldb log.
 *
 * The desktop GUI stores localStorage as leveldb. Recent writes sit uncompressed
 * in the numbered `.log` file, and Chromium writes those string values as
 * UTF-16LE — reading the file as UTF-8 therefore yields one NUL byte between
 * every character. Every value this plugin writes is one JSON object, so the
 * record is decoded, brace-matched and PARSED, and the newest one is printed as
 * JSON. (The previous version printed a 1024-byte printable view instead, which
 * cut the record off halfway and garbled every field: `"version` came back as
 * `"·v·e·r·s·i·o·n·` and the tail of the record was simply missing, which cost
 * real time twice while diagnosing "the pane shows the wrong conversation".)
 *
 * Usage:
 *   node tools/read-diagnostics.mjs              # newest record, pretty JSON
 *   node tools/read-diagnostics.mjs --all        # every record found, oldest first
 *   node tools/read-diagnostics.mjs <userDataDir>
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const KEY = 'dsh-task-tracker.diagnostics.v1'
const args = process.argv.slice(2)
const showAll = args.includes('--all')
const directory = args.find((value) => !value.startsWith('--'))
  ?? join(process.env.APPDATA ?? '', '@deepseek-ai', 'dsh-desktop', 'Local Storage', 'leveldb')

/**
 * The JSON object that starts at or after `from`, brace-matched.
 * @param text - the decoded window.
 * @param from - where to start looking.
 * @returns the JSON text, or undefined when the window holds no complete object.
 */
function objectAt(text, from) {
  const start = text.indexOf('{', from)
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

const records = []
for (const name of readdirSync(directory)) {
  if (!/\.(log|ldb)$/u.test(name)) continue
  const path = join(directory, name)
  const buffer = readFileSync(path)
  const needle = Buffer.from(KEY, 'latin1')
  let index = buffer.indexOf(needle)
  while (index >= 0) {
    // After the ASCII key comes one byte of framing, then the value itself. Try
    // UTF-16LE first (what Chromium writes here) and fall back to UTF-8, so a
    // build that stores the value the other way still reads.
    for (const [encoding, offset] of [['utf16le', 1], ['utf8', 0]]) {
      const text = buffer.subarray(index + needle.length + offset, index + needle.length + offset + 65536).toString(encoding)
      const json = objectAt(text, 0)
      if (json === undefined) continue
      try {
        records.push({ path, index, encoding, value: JSON.parse(json) })
        break
      } catch (error) {
        /* not a complete value under this encoding: try the next one */
      }
    }
    index = buffer.indexOf(needle, index + 1)
  }
}

if (records.length === 0) {
  console.log('no diagnostics record found under ' + directory)
  console.log('(the plugin has not activated in this page yet)')
  process.exit(1)
}

/** Newest last: `appliedAt` moves forward with every activation in the page. */
const ordered = records.slice().sort((left, right) => String(left.value.appliedAt ?? '').localeCompare(String(right.value.appliedAt ?? '')))

if (showAll) {
  for (const record of ordered) {
    console.log('=== ' + record.path + '  @' + record.index + '  (' + record.encoding + ') ===')
    console.log(JSON.stringify(record.value, null, 2))
    console.log('')
  }
} else {
  const newest = ordered[ordered.length - 1]
  console.log('newest record: ' + newest.path + '  @' + newest.index + '  (' + newest.encoding + ')')
  console.log('records found: ' + records.length)
  console.log('')
  console.log(JSON.stringify(newest.value, null, 2))
}
