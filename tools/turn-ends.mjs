/**
 * Tally the `turn/end` reason kinds across every session log on disk.
 *
 * This is the ground truth behind the notification rule ("announce a finish, stay
 * silent about a stop"): the session log records `turn/end { data: { reason: { kind } } }`,
 * and the kinds that actually occur are whatever this prints. Run it before trusting
 * any list of them.
 *
 * It is also the shortest demonstration of the trap that makes these logs look empty:
 * a session log is an APPEND-ONLY ZSTD STREAM, one frame per write, so a single
 * `zstdDecompressSync` call returns only the FIRST frame — the session header — and
 * the transcript appears to have no events at all. Decoding frame by frame, splitting
 * on the zstd magic, recovers the whole thing.
 *
 * Usage:
 *   node tools/turn-ends.mjs                # every log, then a tally
 *   node tools/turn-ends.mjs <sessionIdPart>  # only logs whose directory matches
 *
 * `DSH_HOME` selects the harness home (default `~/.dsh`).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const roots = join(home, 'sessions')
const filter = process.argv[2]

/** The zstd frame magic: every append to a session log is its own frame. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * Decode an append-only zstd stream, frame by frame.
 *
 * A frame still being written (or a magic that appears inside compressed data) simply
 * fails and is skipped — everything after such a gap still decodes, and the caller
 * wants the end of the log anyway.
 * @param buffer - raw file bytes.
 * @returns `{ text, frames, failed }`.
 */
function decodeFrames(buffer) {
  const offsets = []
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1]
      && buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) offsets.push(index)
  }
  let text = ''
  let failed = 0
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(offsets[index], end)).toString('utf8')
    } catch (error) {
      failed += 1
    }
  }
  return { text, frames: offsets.length, failed }
}

if (!existsSync(roots)) {
  console.error('no sessions directory at ' + roots + ' (set DSH_HOME?)')
  process.exit(1)
}

const tally = new Map()
let sessions = 0
for (const workspace of readdirSync(roots, { withFileTypes: true })) {
  if (!workspace.isDirectory()) continue
  const workspacePath = join(roots, workspace.name)
  for (const session of readdirSync(workspacePath, { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    if (filter !== undefined && !session.name.includes(filter)) continue
    const file = join(workspacePath, session.name, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const { text, frames, failed } = decodeFrames(readFileSync(file))
    const ends = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch (error) {
        continue
      }
      if (event.type !== 'turn/end') continue
      const kind = event.data?.reason?.kind ?? '(no reason)'
      ends.push(kind)
      tally.set(kind, (tally.get(kind) ?? 0) + 1)
    }
    sessions += 1
    if (ends.length > 0) {
      console.log(session.name.slice(0, 24) + '  frames=' + String(frames).padStart(4)
        + ' failed=' + String(failed).padStart(2) + '  ' + ends.join(', '))
    }
  }
}

console.log('\nsessions scanned: ' + sessions)
console.log('=== turn/end reason kinds ===')
if (tally.size === 0) console.log('(none found)')
for (const [kind, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(String(count).padStart(6) + '  ' + kind)
}
