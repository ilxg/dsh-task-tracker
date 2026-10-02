/**
 * dsh-task-tracker host-half check.
 *
 * Mounts the host half in a plain Node process (the same code the DSH host
 * loads), then exercises the whole window service over loopback: discovery,
 * snapshot round-trip, the page, and — with `--open` — a real Edge/Chrome
 * application window that is opened and closed again.
 *
 * Usage:
 *   node tools/hostcheck.mjs           # service only, opens no window
 *   node tools/hostcheck.mjs --open    # also launches and closes the real window
 */

import { apply, PORTS, SERVICE_ID } from '../lib/host.js'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const withWindow = process.argv.includes('--open')
const failures = []
async function check(name, fn) {
  try {
    await fn()
    console.log('  ok   ' + name)
  } catch (error) {
    failures.push({ name, error })
    console.log('  FAIL ' + name + ' — ' + (error && error.message))
  }
}

async function request(port, path, options = {}) {
  const init = { method: options.method ?? 'GET' }
  if (options.body !== undefined) {
    init.headers = { 'content-type': 'text/plain;charset=UTF-8' }
    init.body = JSON.stringify(options.body)
  }
  if (options.headers !== undefined) init.headers = { ...(init.headers ?? {}), ...options.headers }
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init)
    if (!response.ok) return { status: response.status, body: undefined, headers: response.headers }
    const type = response.headers.get('content-type') ?? ''
    return {
      status: response.status,
      body: type.includes('json') ? await response.json() : await response.text(),
      headers: response.headers,
    }
  } catch (error) {
    return { status: 0, body: undefined, error }
  }
}

/**
 * One request through node:http, which (unlike fetch) lets the caller set the
 * `Host` header — the only way to test the DNS-rebinding gate.
 */
function rawRequest(port, path, headers) {
  return new Promise((resolve) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (response) => {
      response.resume()
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }))
    })
    request.on('error', () => resolve({ status: 0, headers: {} }))
    request.end()
  })
}

const effects = []
/** The port this run's own service bound, parsed from its log line. */
let boundPort
const ctx = {
  effect(factory) {
    effects.push(factory())
  },
  logger: {
    info(message) {
      console.log('  [host] ' + message)
      const match = /listening on 127\.0\.0\.1:(\d+)/u.exec(message)
      if (match !== null) boundPort = Number(match[1])
    },
    warn(message) {
      console.log('  [host:warn] ' + message)
    },
  },
}

console.log('dsh-task-tracker host check' + (withWindow ? ' (with window)' : ''))
apply(ctx)

/**
 * Wait for OUR service to bind. The port is taken from its own log line rather
 * than from a discovery sweep: a live DSH on this machine answers /ping on the
 * first candidate port too, and driving that instance would be wrong.
 */
const port = await (async () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (boundPort !== undefined) return boundPort
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return undefined
})()

await check('binds a loopback port and answers /ping', async () => {
  assert.ok(port !== undefined, 'the service never reported a bound port')
  const ping = await request(port, '/ping')
  assert.equal(ping.body?.app, SERVICE_ID)
  assert.equal(ping.body?.port, port, 'the service must report its own port')
  console.log('       port ' + port)
})

if (port === undefined) {
  console.error('\nthe service never came up')
  process.exit(1)
}

const demoView = {
  updatedAt: new Date().toISOString(),
  theme: { dark: true, base: 'rgb(29, 29, 32)', panel: 'rgb(38, 38, 41)', fg: 'rgb(236, 236, 241)', muted: 'rgb(150, 150, 158)', border: 'rgb(63, 63, 68)', hover: 'rgb(50, 50, 54)', accent: '#4d6bfe', success: '#2aa96b', danger: '#e5534b', warn: '#d29922' },
  header: { title: '任务追踪', subtitle: 'host 自检' },
  progress: { label: '任务清单进度', text: '1/2 已完成', percent: 50, detail: '1 进行中' },
  sections: [
    { key: 'todos', title: '任务清单', empty: '', rows: [{ key: 'a', status: 'completed', name: '第一步', meta: '已完成', done: true }, { key: 'b', status: 'in_progress', name: '第二步', meta: '进行中' }] },
    { key: 'jobs', title: '后台任务', empty: '没有后台任务', rows: [{ key: 'j', status: 'running', name: '运行命令 · npm run build', meta: '工作区：示例 · 运行中 · 60%' }] },
  ],
  footer: 'host 自检推送的示例视图',
}

await check('accepts and returns a pushed view', async () => {
  const posted = await request(port, '/state', { method: 'POST', body: demoView })
  assert.equal(posted.body?.ok, true, 'POST /state failed: ' + JSON.stringify(posted.body))
  const read = await request(port, '/state')
  assert.equal(read.body?.view?.header?.subtitle, 'host 自检')
  assert.equal(read.body?.view?.progress?.percent, 50)
  assert.equal(read.body?.open, false, 'nothing is open yet')
})

await check('retires a clicked navigation once the plugin acknowledges it', async () => {
  // The served page reports a row click through POST /nav and the plugin picks it up
  // from /ping on its next tick. The host cannot know the page saw it, so it used to
  // answer with that click for the rest of its life — and a page loading later applied
  // it as though the user had just clicked, which opened the pane on a conversation's
  // detail instead of the project list it was opened for.
  const posted = await request(port, '/nav', {
    method: 'POST',
    body: { target: { level: 'session', cwd: 'C:\\q', sessionId: 's9' } },
  })
  assert.equal(posted.body?.nav?.target?.sessionId, 's9', 'the click is recorded')
  const before = await request(port, '/ping')
  assert.equal(before.body?.nav?.target?.sessionId, 's9', 'and keeps being answered until it is applied')

  // The plugin applies it and acknowledges exactly that stamp.
  const ack = await request(port, '/health', {
    method: 'POST',
    body: { version: '0.0.0', mode: 'nav', navStamp: before.body.navAt },
  })
  assert.equal(ack.body?.ok, true, 'the acknowledgement is accepted')
  const after = await request(port, '/ping')
  assert.equal(after.body?.nav, null, 'the applied click is retired: ' + JSON.stringify(after.body?.nav))

  // A click that arrived after the acknowledgement must survive a stale one.
  await request(port, '/nav', { method: 'POST', body: { back: true } })
  await request(port, '/health', { method: 'POST', body: { version: '0.0.0', mode: 'nav', navStamp: 'not-the-latest' } })
  const kept = await request(port, '/ping')
  assert.equal(kept.body?.nav?.back, true, 'a newer click survives a stale acknowledgement')
  await request(port, '/health', { method: 'POST', body: { version: '0.0.0', mode: 'nav', navStamp: kept.body.navAt } })
  const clean = await request(port, '/ping')
  assert.equal(clean.body?.nav, null, 'and is retired once it has been applied')
})

await check('reports the last native toast outcome on /ping', async () => {
  const ping = await request(port, '/ping')
  assert.equal(typeof ping.body?.toast, 'boolean', 'the capability flag stays a boolean')
  assert.ok(ping.body?.lastToast !== undefined, '/ping must carry the settled toast result')
  assert.equal(typeof ping.body.lastToast, 'object', 'as an object: ' + JSON.stringify(ping.body.lastToast))
})

await check('reads why a turn ended, and when it began, out of the session log', async () => {
  // The page cannot tell "it finished" from "you stopped it" — its session status is
  // only `{ running, pendingInteraction, completionUnread }` — so this endpoint is what
  // makes "中断不弹、跑完才弹" possible at all. A SYNTHETIC log proves the reader: a
  // test that only read logs DSH wrote could not tell a working decoder from one that
  // happens to agree with itself.
  const realHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const realRoot = join(realHome, 'sessions')
  let realId
  try {
    for (const workspace of readdirSync(realRoot, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue
      for (const session of readdirSync(join(realRoot, workspace.name), { withFileTypes: true })) {
        if (session.isDirectory() && existsSync(join(realRoot, workspace.name, session.name, 'session.v4.jsonl.zstd'))) {
          realId = session.name
          break
        }
      }
      if (realId !== undefined) break
    }
  } catch (error) {
    /* this machine has no logs to read */
  }
  if (realId !== undefined) {
    const real = await request(port, '/turn', { method: 'POST', body: { sessionId: realId } })
    assert.equal(real.body?.state, 'ended', 'a real session log is readable: ' + realId)
    assert.ok(
      ['completed', 'error', 'max-tokens', 'aborted', 'unknown'].includes(real.body?.reason),
      'with a reason drawn from the observed vocabulary: ' + real.body?.reason,
    )
    // The run timer stands on this number, so it has to be an epoch stamp and not a
    // counter: a plausible past instant, and never in the future.
    assert.ok(typeof real.body?.startedAt === 'number', 'the turn start is an epoch stamp: ' + String(real.body?.startedAt))
    assert.ok(real.body.startedAt > Date.parse('2020-01-01'), 'which is a real instant, not a sequence number')
    assert.ok(real.body.startedAt <= Date.now(), 'and not in the future')
    console.log('       real session ' + realId + ' → ' + String(real.body.reason)
      + ', ran ' + String(Math.round((real.body.endedAt - real.body.startedAt) / 1000)) + 's')
  }

  const home = mkdtempSync(join(tmpdir(), 'dsh-tt-turn-'))
  const directory = join(home, 'sessions', '--C-Test--', 'session-fixture')
  mkdirSync(directory, { recursive: true })
  const frame = (event) => zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // Epoch stamps on purpose: the log's `time` is what the page measures a run against.
    const T1 = Date.parse('2026-05-01T10:00:00.000Z')
    writeFileSync(join(directory, 'session.v4.jsonl.zstd'), Buffer.concat([
      frame({ type: 'session', time: T1 - 1000, data: {} }),
      frame({ type: 'turn/start', time: T1, data: { turn: 't1' } }),
      frame({ type: 'turn/end', time: T1 + 9000, data: { turn: 't1', reason: { kind: 'completed' } } }),
      frame({ type: 'turn/start', time: T1 + 60000, data: { turn: 't2' } }),
      frame({ type: 'turn/end', time: T1 + 90000, data: { turn: 't2', reason: { kind: 'aborted' } } }),
    ]))
    const aborted = await request(port, '/turn', { method: 'POST', body: { sessionId: 'session-fixture' } })
    assert.equal(aborted.body?.state, 'ended', 'the newest turn is found')
    assert.equal(aborted.body?.reason, 'aborted', 'and its reason is the NEWEST one, not the first')
    assert.equal(aborted.body?.startedAt, T1 + 60000, 'with the start of THAT turn, not of the log')
    assert.equal(aborted.body?.endedAt, T1 + 90000, 'and its end')
    // The first turn's own length is what a "last run" reading needs, so the pairing
    // has to survive several turns in one log.
    assert.equal((aborted.body.endedAt - aborted.body.startedAt) / 1000, 30, 'so the length is the newest turn\'s')

    // The same session, still mid-turn: no reason yet, but the start IS the answer the
    // run timer wants, so it must not be held back.
    const T3 = T1 + 120000
    writeFileSync(join(directory, 'session.v4.jsonl.zstd'), Buffer.concat([
      frame({ type: 'turn/start', time: T3, data: { turn: 't3' } }),
    ]))
    const running = await request(port, '/turn', { method: 'POST', body: { sessionId: 'session-fixture' } })
    assert.equal(running.body?.state, 'running', 'a turn that has not closed is reported as such')
    assert.equal(running.body?.reason, null, 'with no reason')
    assert.equal(running.body?.startedAt, T3, 'and the start of the run in flight')
    // A caller that says it is asking about a FINISHED run waits for the closing event;
    // one asking about the run in flight is answered immediately.
    const settled = await request(port, '/turn', { method: 'POST', body: { sessionId: 'session-fixture', settled: true } })
    assert.equal(settled.body?.state, 'running', 'a settled question still answers honestly when nothing closed')

    // Older logs on this machine predate the `session-` prefix, so the directory may
    // be the bare uuid.
    const bare = join(home, 'sessions', '--C-Test--', 'fixture-bare')
    mkdirSync(bare, { recursive: true })
    writeFileSync(join(bare, 'session.v4.jsonl.zstd'), frame({ type: 'turn/end', time: T1 + 200000, data: { turn: 't4', reason: { kind: 'error' } } }))
    const stripped = await request(port, '/turn', { method: 'POST', body: { sessionId: 'session-fixture-bare' } })
    assert.equal(stripped.body?.reason, 'error', 'the prefix is dropped to find the directory')
    assert.equal(stripped.body?.startedAt, null, 'and a start that was never logged answers null, not a guess')

    const missing = await request(port, '/turn', { method: 'POST', body: { sessionId: 'session-does-not-exist' } })
    assert.equal(missing.body?.state, 'unknown', 'a session with no log says so')
    assert.equal(missing.body?.reason, null, 'instead of guessing a reason')
    assert.equal(missing.body?.startedAt, null, 'or a start')
    const bad = await request(port, '/turn', { method: 'POST', body: {} })
    assert.equal(bad.status, 400, 'a request without a session id is rejected')
    const readOnly = await request(port, '/turn')
    assert.equal(readOnly.status, 405, 'and it stays POST-only like the other write routes')
    const ping = await request(port, '/ping')
    assert.equal(ping.body?.lastTurn?.sessionId, 'session-does-not-exist', '/ping reports the last lookup')
  } finally {
    process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

await check('reports the browser half\'s version on disk', async () => {
  // This is what tells a page that the bundle it booted with has been replaced. The page
  // cannot find that out for itself: its own bundle URL lives on the app's custom scheme,
  // where the fetch answers 404. So it asks here, on the poll it already makes.
  const ping = await request(port, '/ping')
  const probe = join(root, 'lib', 'client.js')
  const original = readFileSync(probe, 'utf8')
  const expected = /var VERSION = "([^"]+)"/u.exec(original)?.[1]
  assert.ok(expected !== undefined, 'the browser half must stamp a version')
  assert.equal(ping.body?.clientVersion, expected, 'the host reports the stamp from lib/client.js')
  // Read fresh rather than at start-up: a rewritten file has to show up on its own.
  try {
    writeFileSync(probe, original.replace(/var VERSION = "[^"]+"/u, 'var VERSION = "9.9.9"'))
    const after = await request(port, '/ping')
    assert.equal(after.body?.clientVersion, '9.9.9', 'a rewritten bundle is reported without a restart')
  } finally {
    writeFileSync(probe, original)
  }
  const restored = await request(port, '/ping')
  assert.equal(restored.body?.clientVersion, expected, 'and the original comes back')
})

await check('serves the opaque window page', async () => {
  const page = await request(port, '/')
  assert.equal(page.status, 200)
  const html = String(page.body)
  assert.ok(html.includes('任务追踪'), 'the page title is missing')
  assert.ok(html.includes('--dstt-base'), 'the page has no opaque theme variables')
  assert.ok(html.includes('setInterval(poll, 1000)'), 'the page does not poll for state')
  assert.ok(!html.includes('backdrop-filter'), 'the page must stay opaque')
})

if (withWindow) {
  await check('opens a real application window', async () => {
    const opened = await request(port, '/toggle', { method: 'POST', body: { open: true } })
    assert.equal(opened.body?.open, true, 'the window did not open: ' + JSON.stringify(opened.body))
    const ping = await request(port, '/ping')
    assert.equal(ping.body?.open, true, '/ping does not report the window')
    assert.ok(ping.body?.browser !== null, 'no browser was found to launch')
    console.log('       browser ' + String(ping.body.browser))
  })

  await new Promise((resolve) => setTimeout(resolve, 2500))

  await check('closes the window again', async () => {
    const closed = await request(port, '/toggle', { method: 'POST', body: { open: false } })
    assert.equal(closed.body?.open, false)
    const ping = await request(port, '/ping')
    assert.equal(ping.body?.open, false, 'the window is still reported open')
  })
}

if (process.argv.includes('--notify')) {
  await check('posts a native Windows toast through the host', async () => {
    const sent = await request(port, '/notify', {
      method: 'POST',
      body: { title: '任务已完成（自检）', body: 'host 原生 toast 通道验证' },
    })
    assert.equal(sent.body?.ok, true, 'the host refused the toast: ' + JSON.stringify(sent.body))
    // Give the short-lived PowerShell process time to hand the toast to Windows.
    await new Promise((resolve) => setTimeout(resolve, 3000))
  })
}

// A page the user happens to have open must not be able to read the snapshot
// (session titles, project paths) or make the machine pop notifications.
await check('refuses a foreign web page origin', async () => {
  const read = await request(port, '/state', { headers: { origin: 'https://evil.example' } })
  assert.equal(read.status, 403, 'a cross-site page must not read the snapshot')
  const notify = await request(port, '/notify', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: { title: 'spam' },
  })
  assert.equal(notify.status, 403, 'a cross-site page must not post notifications')
  const toggle = await request(port, '/toggle', { method: 'POST', headers: { origin: 'https://evil.example' } })
  assert.equal(toggle.status, 403, 'a cross-site page must not open or close the window')
  const preflight = await request(port, '/state', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
  assert.equal(preflight.status, 403, 'a cross-site preflight must not be granted')
})

// A public name that resolves to 127.0.0.1 still sends its own Host header.
await check('refuses a rebound host header', async () => {
  const rebound = await rawRequest(port, '/state', { host: 'not-loopback.example' })
  assert.equal(rebound.status, 403, 'a public name pointing at loopback must not pass')
  const loopback = await rawRequest(port, '/state', { host: `127.0.0.1:${String(port)}` })
  assert.equal(loopback.status, 200, 'the real loopback name must still pass')
})

await check('keeps the app channel and grants CORS only to it', async () => {
  const app = await request(port, '/state', { headers: { origin: 'dsh-app://app' } })
  assert.equal(app.status, 200, 'the app itself keeps its channel')
  assert.equal(
    app.headers?.get('access-control-allow-origin'),
    'dsh-app://app',
    'CORS names the accepted caller instead of a wildcard',
  )
  const opaque = await request(port, '/state', { headers: { origin: 'null' } })
  assert.equal(opaque.status, 200, 'the app may present an opaque origin')
  const plain = await request(port, '/ping')
  assert.equal(plain.status, 200, 'a plain caller still works')
  assert.equal(
    plain.headers?.get('access-control-allow-origin'),
    null,
    'a caller with no origin gets no CORS grant at all',
  )
})

for (const dispose of effects.reverse()) {
  if (typeof dispose === 'function') await dispose()
}
await check('shuts the service down cleanly', async () => {
  await new Promise((resolve) => setTimeout(resolve, 300))
  const after = await request(port, '/ping')
  assert.equal(after.status, 0, 'the port still answers after dispose')
})

if (failures.length > 0) {
  console.error('\n' + failures.length + ' check(s) failed')
  process.exit(1)
}
console.log('\nall checks passed')
process.exit(0)
