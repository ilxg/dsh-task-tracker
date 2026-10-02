/**
 * Classify session logs: an EMPTY session has only its header line and never
 * received a message, which is exactly the row a user does not recognise in a
 * task list. Prints bytes, line count, and the first text found.
 *
 * Usage: node tools/session-scan.mjs [idSubstring ...]
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const roots = join(home, 'sessions')
const wanted = process.argv.slice(2)

const logs = []
for (const workspace of readdirSync(roots, { withFileTypes: true })) {
  if (!workspace.isDirectory()) continue
  const workspacePath = join(roots, workspace.name)
  for (const session of readdirSync(workspacePath, { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    const file = join(workspacePath, session.name, 'session.v4.jsonl.zstd')
    if (existsSync(file)) logs.push({ id: session.name, file })
  }
}

/** First text block anywhere in the log, as a rough "was it used" probe. */
function firstText(lines) {
  for (const line of lines) {
    if (!line.includes('"text"')) continue
    try {
      const parsed = JSON.parse(line)
      const text = JSON.stringify(parsed.data ?? parsed)
      const match = /"text":"((?:[^"\\]|\\.){0,120})"/u.exec(text)
      if (match !== null) return match[1]
    } catch (error) {
      /* keep looking */
    }
  }
  return ''
}

for (const log of logs) {
  if (wanted.length > 0 && !wanted.some((needle) => log.id.includes(needle))) continue
  const buffer = readFileSync(log.file)
  const lines = zstdDecompressSync(buffer).toString('utf8').split('\n').filter((line) => line.trim() !== '')
  let header = {}
  try {
    header = JSON.parse(lines[0]).data ?? {}
  } catch (error) {
    header = {}
  }
  const text = firstText(lines)
  console.log(
    [
      log.id.replace('session-', '').slice(0, 8),
      String(statSync(log.file).size).padStart(8) + 'B',
      String(lines.length).padStart(5) + '行',
      lines.length <= 1 ? '空会话' : '有内容',
      (header.cwd ?? '').slice(-18).padEnd(18),
      text === '' ? '(无用户文本)' : text.slice(0, 40),
    ].join('  '),
  )
}
