/**
 * Search inside every session log on this machine.
 *
 * A session log (`session.v4.jsonl.zstd`) is appended frame by frame, so a
 * one-shot `zstdDecompressSync` only returns the FIRST frame — the header. This
 * streams the whole file through the zstd decoder, which handles concatenated
 * frames, so message text is actually searchable.
 *
 * Usage:
 *   node tools/session-search.mjs <needle> [--max-bytes N]      find sessions
 *   node tools/session-search.mjs <needle> --dump [--lines N]   print context
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const roots = join(home, 'sessions')
const argv = process.argv.slice(2)
const needle = argv.find((value) => !value.startsWith('--'))
if (needle === undefined) {
  console.error('usage: node tools/session-search.mjs <needle> [--dump] [--lines N] [--max-bytes N]')
  process.exit(2)
}
const dump = argv.includes('--dump')
const transcript = argv.includes('--transcript')
const sessionIndex = argv.indexOf('--session')
const sessionFilter = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined
const linesIndex = argv.indexOf('--lines')
const lines = linesIndex >= 0 ? Number(argv[linesIndex + 1]) : 6
const maxIndex = argv.indexOf('--max-bytes')
const maxBytes = maxIndex >= 0 ? Number(argv[maxIndex + 1]) : 64 * 1024 * 1024

/** Every text message inside one parsed event, in order. */
function messagesOf(value, out = []) {
  if (value === null || value === undefined) return out
  if (Array.isArray(value)) {
    for (const item of value) messagesOf(item, out)
    return out
  }
  if (typeof value !== 'object') return out
  const role = value.role
  const content = value.content
  if (typeof role === 'string' && Array.isArray(content)) {
    const text = content
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (text.trim() !== '') out.push({ role, text })
    return out
  }
  for (const item of Object.values(value)) messagesOf(item, out)
  return out
}

/**
 * Decode one log completely.
 *
 * The file is a container of zstd frames (a length prefix between them), so
 * neither a one-shot decode (first frame only) nor a stream decode (`Unknown
 * frame descriptor`) reads the whole log. Every frame starts with the zstd
 * magic, and decoding from a frame's start stops at that frame's end, so the
 * frames are found by scanning for the magic and decoded one at a time.
 * @param file - absolute path of the log.
 * @returns the concatenated decoded text.
 */
function readLog(file) {
  let buffer
  try {
    buffer = readFileSync(file)
  } catch (error) {
    return ''
  }
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let at = buffer.indexOf(magic, 0)
  while (at >= 0 && starts.length < 20000) {
    starts.push(at)
    at = buffer.indexOf(magic, at + 4)
  }
  if (starts.length === 0) return ''
  const parts = []
  let total = 0
  for (const start of starts) {
    try {
      const text = zstdDecompressSync(buffer.subarray(start)).toString('utf8')
      parts.push(text)
      total += text.length
    } catch (error) {
      /* a corrupt frame loses only its own records */
    }
    if (total > maxBytes) break
  }
  return parts.join('')
}

/** Every session log on disk. */
function logs() {
  const found = []
  for (const workspace of readdirSync(roots, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(roots, workspace.name)
    for (const session of readdirSync(workspacePath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const file = join(workspacePath, session.name, 'session.v4.jsonl.zstd')
      if (existsSync(file)) found.push({ id: session.name, workspace: workspace.name, file })
    }
  }
  return found
}

const lower = needle.toLowerCase()
/**
 * Search one log line by line. Chinese text is stored JSON-escaped (`\u5c71…`),
 * so each line is parsed and re-serialized before matching: `JSON.stringify`
 * keeps non-ASCII literal, which is what makes a Chinese needle findable.
 */
function matchingLines(text) {
  const raw = text.split('\n')
  const out = []
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i]
    if (line.trim() === '') continue
    let readable = line
    if (!line.toLowerCase().includes(lower)) {
      try {
        readable = JSON.stringify(JSON.parse(line))
      } catch (error) {
        continue
      }
    }
    if (readable.toLowerCase().includes(lower)) out.push({ index: i, line, readable })
  }
  return out
}

let hits = 0
for (const log of logs()) {
  if (sessionFilter !== undefined && !log.id.includes(sessionFilter)) continue
  const text = await readLog(log.file)
  if (text === '') continue
  if (transcript) {
    console.log('=== transcript of ' + log.id + ' (' + log.workspace + ') ===')
    const grepIndex = argv.indexOf('--grep')
    const grep = grepIndex >= 0 ? String(argv[grepIndex + 1]).toLowerCase() : undefined
    let count = 0
    let shown = 0
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        continue
      }
      for (const message of messagesOf(parsed)) {
        count += 1
        if (grep !== undefined && !message.text.toLowerCase().includes(grep)) continue
        shown += 1
        const body = message.text.length > 900 ? message.text.slice(0, 900) + ' …[' + message.text.length + ' chars]' : message.text
        console.log('--- ' + count + ' [' + message.role + '] ---')
        console.log(body)
      }
    }
    console.log('(' + count + ' messages, ' + shown + ' shown)')
    continue
  }
  const matches = matchingLines(text)
  if (matches.length === 0) continue
  hits += 1
  console.log('=== ' + log.id + '  (' + log.workspace + ', ' + Math.round(statSync(log.file).size / 1024) + ' KB, ' + text.length + ' chars, ' + matches.length + ' hits)')
  if (!dump) {
    const first = matches[0]
    const at = first.readable.toLowerCase().indexOf(lower)
    console.log('    line ' + (first.index + 1) + ': ' + first.readable.slice(Math.max(0, at - 100), at + 160))
    continue
  }
  for (const match of matches.slice(0, lines)) {
    console.log('  --- line ' + (match.index + 1) + ' ---')
    console.log('  ' + match.readable.slice(0, 2000))
  }
}
console.log('')
console.log('sessions matching "' + needle + '": ' + hits)
