/**
 * List the local sessions with the facts the tracker list needs to tell them
 * apart: derived title, project directory, origin/parent (subagent children),
 * whether they are blank, and their last activity time.
 *
 * Session logs are Zstandard-compressed JSONL (`session.v4.jsonl.zstd`), so this
 * decompresses the head of each log and reads the durable header.
 *
 * Usage: node tools/sessions-probe.mjs [--filter <text>] [--limit N]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const roots = join(home, 'sessions')
const filterIndex = process.argv.indexOf('--filter')
const filter = filterIndex >= 0 ? String(process.argv[filterIndex + 1] ?? '').toLowerCase() : ''
const limitIndex = process.argv.indexOf('--limit')
const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : 40

/** Read the durable header out of one compressed session log. */
function readHeader(file) {
  const raw = readFileSync(file)
  // A Zstd frame is self-contained; decompressing a prefix fails, so decompress
  // the whole log but keep only the first line of JSON.
  let text
  try {
    text = zstdDecompressSync(raw).toString('utf8')
  } catch (error) {
    return undefined
  }
  const newline = text.indexOf('\n')
  const first = newline < 0 ? text : text.slice(0, newline)
  try {
    return JSON.parse(first)
  } catch (error) {
    return undefined
  }
}

const rows = []
let scanned = 0
for (const workspace of readdirSync(roots, { withFileTypes: true })) {
  if (!workspace.isDirectory()) continue
  const workspacePath = join(roots, workspace.name)
  for (const session of readdirSync(workspacePath, { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    const file = join(workspacePath, session.name, 'session.v4.jsonl.zstd')
    let size = 0
    try {
      size = statSync(file).size
    } catch (error) {
      continue
    }
    scanned += 1
    const header = readHeader(file)
    if (header === undefined) continue
    const data = header.data ?? header
    const title = typeof data.title === 'string' ? data.title : ''
    const cwd = typeof data.cwd === 'string' ? data.cwd : ''
    const parent = typeof data.parentSessionId === 'string' ? data.parentSessionId : typeof data.parent === 'string' ? data.parent : ''
    const origin = typeof data.origin === 'string' ? data.origin : ''
    const text = [title, cwd, session.name].join(' ').toLowerCase()
    if (filter !== '' && !text.includes(filter)) continue
    rows.push({
      title: title === '' ? '(无标题)' : title,
      cwd,
      parent: parent === '' ? '' : parent.slice(0, 18),
      origin,
      at: statSync(file).mtime.toISOString().slice(0, 16).replace('T', ' '),
      size,
      id: session.name,
    })
  }
}

rows.sort((left, right) => (left.at < right.at ? 1 : -1))
console.log('scanned ' + scanned + ' session logs under ' + roots)
console.log('matched ' + rows.length + (filter === '' ? '' : ' (filter: ' + filter + ')'))
console.log('')
const groups = new Map()
for (const row of rows) {
  const key = row.title
  groups.set(key, (groups.get(key) ?? 0) + 1)
}
for (const row of rows.slice(0, limit)) {
  console.log(
    [
      row.at,
      String(groups.get(row.title)).padStart(2) + 'x',
      row.origin === '' ? '     ' : row.origin.padEnd(5),
      row.parent === '' ? '         ' : 'p:' + row.parent,
      row.title.slice(0, 34).padEnd(34),
      row.cwd.slice(-28),
    ].join('  '),
  )
}
