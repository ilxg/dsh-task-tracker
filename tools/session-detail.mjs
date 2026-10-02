/**
 * Show what one session log actually is: where it ran, when it started, whether
 * it is a subagent child, its derived title, and the first user message — the
 * facts that explain why a row is in a project's list.
 *
 * Usage: node tools/session-detail.mjs <sessionIdOrPrefix> [...]
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const roots = join(home, 'sessions')
const wanted = process.argv.slice(2)
if (wanted.length === 0) {
  console.error('usage: node tools/session-detail.mjs <sessionIdOrPrefix> [...]')
  process.exit(2)
}

/** Every session log on disk: id → file path. */
function findLogs() {
  const found = new Map()
  for (const workspace of readdirSync(roots, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(roots, workspace.name)
    for (const session of readdirSync(workspacePath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const file = join(workspacePath, session.name, 'session.v4.jsonl.zstd')
      if (existsSync(file)) found.set(session.name, file)
    }
  }
  return found
}

/** First user message text in one decompressed log. */
function firstUserMessage(text) {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      continue
    }
    const data = event.data ?? event
    const kind = event.type ?? data.type ?? ''
    const source = data.source ?? {}
    const isUser = kind.includes('message') && (source.kind === 'user' || source.kind === 'prompt' || source.kind === undefined)
    if (!isUser) continue
    const content = data.content ?? data.message?.content
    if (typeof content === 'string' && content.trim() !== '') return content.trim().slice(0, 120)
    if (Array.isArray(content)) {
      const block = content.find((entry) => entry !== null && typeof entry === 'object' && entry.type === 'text')
      if (block !== undefined && typeof block.text === 'string') return block.text.trim().slice(0, 120)
    }
  }
  return '(未找到用户消息)'
}

const logs = findLogs()
for (const needle of wanted) {
  const matches = [...logs.entries()].filter(([id]) => id.includes(needle))
  if (matches.length === 0) {
    console.log('== ' + needle + ': 没有找到会话日志')
    continue
  }
  for (const [id, file] of matches) {
    const text = zstdDecompressSync(readFileSync(file)).toString('utf8')
    let header = {}
    try {
      header = JSON.parse(text.slice(0, text.indexOf('\n')))
    } catch (error) {
      header = {}
    }
    const data = header.data ?? header
    console.log('== ' + id)
    console.log('   cwd        : ' + String(data.cwd ?? '(未记录)'))
    console.log('   origin     : ' + String(data.origin ?? '(无)') + (data.parentSessionId === undefined ? '' : '  parent=' + String(data.parentSessionId)))
    console.log('   started    : ' + String(data.createdAt ?? data.time ?? '(未记录)'))
    console.log('   首条消息   : ' + firstUserMessage(text))
    console.log('')
  }
}
