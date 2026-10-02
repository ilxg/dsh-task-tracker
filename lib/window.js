/**
 * dsh-task-tracker — window service (host half).
 *
 * The browser half cannot open a real OS window here: the desktop shell denies
 * `window.open` outright (its `setWindowOpenHandler` returns `deny`) and
 * Electron rejects the Document Picture-in-Picture request. So the HOST opens
 * the window instead:
 *
 *   1. A loopback-only HTTP service (`127.0.0.1`, ports 17777+) answers
 *      `/ping`, accepts the browser half's `/state` snapshots, and serves the
 *      window page on `/`.
 *   2. `/toggle` launches a real Windows application window — Edge or Chrome in
 *      `--app=` mode with its own user-data-dir — pointing at that page, and
 *      kills it again on the next toggle.
 *
 * The window page is a dumb renderer: the browser half already computes the
 * whole view (progress, todo list, background jobs with their workspace title,
 * other sessions), so no formatting logic is duplicated here. The service binds
 * to loopback only and serves nothing but this plugin's own page and snapshot.
 *
 * This file is mounted by TWO profile rows on purpose: the package entry
 * (`dsh-task-tracker` → `lib/index.js`) and its own subpath
 * (`dsh-task-tracker/window`). A freshly added row is imported at a fresh module
 * URL even while the package entry is still the Node-cached copy from an earlier
 * start, so the subpath row lets the service come up without restarting DSH. One
 * service per process is all that is wanted, so `apply` is guarded: whichever
 * row mounts second reuses the running service instead of starting a twin.
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

//#region client version
/** The last `client.js` this process read, so a poll does not re-read 96 KB a second. */
let clientHalf = { mtimeMs: -1, size: -1, version: undefined }

/**
 * The version stamp of the browser half sitting next to this file.
 *
 * This is how the page learns that the bundle on disk is no longer the one it is
 * running. It used to ask the boot graph for its own bundle URL and fetch that — which
 * fails on the desktop page, whose origin is the app's own custom scheme: the fetch
 * answers **404**, so the self-reload never fired and the page only ever picked a new
 * bundle up through DSH's own rebuild. The host reads the file directly instead, and
 * the page already polls the host once a second.
 *
 * Re-read on mtime/size change only: `/ping` is polled every second.
 * @returns the version, or undefined when the file cannot be read.
 */
export function clientHalfVersion() {
  try {
    const file = fileURLToPath(new URL('./client.js', import.meta.url))
    const stat = statSync(file)
    if (stat.size !== clientHalf.size || stat.mtimeMs !== clientHalf.mtimeMs) {
      const match = /var VERSION = "([^"]+)"/u.exec(readFileSync(file, 'utf8'))
      clientHalf = { mtimeMs: stat.mtimeMs, size: stat.size, version: match === null ? undefined : match[1] }
    }
    return clientHalf.version
  } catch (error) {
    return undefined
  }
}
//#endregion

/** Plugin name (diagnostics and loader identity). */
export const name = 'dsh-task-tracker'

/** Process-global flag: the service is up, so a second mount is a no-op. */
const MOUNTED = '__dshTaskTrackerWindowMounted'

/** Magic the browser half uses to recognise this service during discovery. */
export const SERVICE_ID = 'dsh-task-tracker'

/** Loopback ports tried in order; the browser half probes the same list. */
export const PORTS = [17777, 17778, 17779, 17780, 17781, 17782, 17783, 17784, 17785, 17786]

/** Largest snapshot the service accepts, in bytes. */
const MAX_BODY = 512 * 1024

/** Smallest gap between two toast requests, in milliseconds. */
const TOAST_MIN_GAP_MS = 250

/** How much of the end of a session log is read when looking for its last turn. */
const TURN_LOG_TAIL_BYTES = 1024 * 1024

/** The zstd frame magic: every append to a session log is its own frame. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * Service version, reported by `/ping`. Keep in step with the browser half's
 * `VERSION` and `package.json`; `tools/selfcheck.mjs` asserts all three agree.
 */
export const VERSION = '0.1.1'

/** Loopback host names this service answers to. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]']

/**
 * Reject a request whose `Host` header is not this loopback service. A public
 * hostname that resolves to 127.0.0.1 (DNS rebinding) still sends its own name,
 * so this closes that door before any route runs.
 * @param request - the incoming request.
 * @param port - the bound port, when known.
 * @returns whether the request may proceed.
 */
function hostAllowed(request, port) {
  const header = request.headers.host
  if (typeof header !== 'string' || header === '') return false
  const lower = header.toLowerCase()
  const suffix = port === undefined ? '' : `:${String(port)}`
  return LOOPBACK_HOSTS.some((host) => lower === host + suffix || (suffix !== '' && lower === host) || (suffix === '' && lower.startsWith(host + ':')))
}

/**
 * Reject a request coming from a web page that is not ours. Requests without an
 * `Origin` (curl, the host's own fetch, tests) pass; the app's own page
 * (`dsh-app://app`) and the service's own window page pass; anything else — an
 * ordinary website the user happens to have open — is refused, which also keeps
 * it from POSTing /notify or /toggle and from reading /state.
 * @param request - the incoming request.
 * @param port - the bound port, when known.
 * @returns whether the request may proceed.
 */
function originAllowed(request, port) {
  const origin = request.headers.origin
  if (origin === undefined || origin === '') return true
  // Electron presents the app page's custom scheme as `dsh-app://app`, and some
  // builds send an opaque `null` instead; both are the app talking to itself.
  if (origin === 'null') return true
  try {
    const parsed = new URL(origin)
    if (parsed.protocol === 'dsh-app:') return true
    if (parsed.protocol !== 'http:') return false
    if (!LOOPBACK_HOSTS.includes(parsed.hostname)) return false
    return port === undefined || parsed.port === '' || parsed.port === String(port)
  } catch (error) {
    return false
  }
}

/** The window's own browser profile, kept apart from the user's browsing data. */
function profileDirectory() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'task-tracker-window')
}

/** Chromium executables to try, in preference order. */
function browserCandidates() {
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env['LOCALAPPDATA'] ?? ''
  return [
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    localAppData === '' ? '' : join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter((candidate) => candidate !== '')
}

/** The first installed Chromium browser, or undefined. */
function findBrowser() {
  for (const candidate of browserCandidates()) {
    try {
      if (existsSync(candidate)) return candidate
    } catch (error) {
      /* an unreadable candidate is simply skipped */
    }
  }
  return undefined
}

//#region turn history
/**
 * Why a turn ended — read from the session's own log.
 *
 * The page cannot answer this. `useSessionStatus` hands out exactly
 * `{ running, pendingInteraction, completionUnread }` (dsh-client-ui-session), so
 * "you pressed stop" and "the work finished" look identical from there: that is why
 * an interruption used to be announced as 「任务已完成」. The session log is not
 * ambiguous — every turn closes with `turn/end { data: { reason: { kind } } }` —
 * and the kinds that actually occur on this machine are `completed`, `error`,
 * `max-tokens` and `aborted` (96 / 5 / 3 / 3 across 24 logs).
 *
 * The log is an append-only zstd stream: ONE FRAME PER WRITE. A single
 * `zstdDecompressSync` call therefore returns only the first frame — the header —
 * and the transcript looks empty, which is exactly the trap this reader avoids by
 * splitting on the frame magic.
 */

/** Where session logs live. */
function sessionsRoot() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
}

/**
 * The log file of one session, or undefined.
 *
 * The directory is the session id (`session-<uuid>`); older logs on this machine
 * predate the prefix, so both spellings are tried.
 * @param sessionId - the id the page knows the session by.
 * @returns the path, or undefined.
 */
function sessionLogPath(sessionId) {
  const candidates = [sessionId]
  if (sessionId.startsWith('session-')) candidates.push(sessionId.slice('session-'.length))
  let workspaces
  try {
    workspaces = readdirSync(sessionsRoot(), { withFileTypes: true })
  } catch (error) {
    return undefined
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    for (const candidate of candidates) {
      const file = join(sessionsRoot(), workspace.name, candidate, 'session.v4.jsonl.zstd')
      if (existsSync(file)) return file
    }
  }
  return undefined
}

/**
 * Decode as much of an append-only zstd stream as is intact.
 *
 * Frames are delimited by the zstd magic. A frame still being written (or a magic
 * that appears inside compressed data) simply fails and is skipped: the caller only
 * needs the END of the log, and everything after such a gap still decodes.
 * @param buffer - raw file bytes, possibly starting mid-frame.
 * @returns the decoded text.
 */
function decodeZstdFrames(buffer) {
  const offsets = []
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1]
      && buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) offsets.push(index)
  }
  let text = ''
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(offsets[index], end)).toString('utf8')
    } catch (error) {
      /* a frame that is still being appended */
    }
  }
  return text
}

/** The last `bytes` of a file, without reading the whole thing. */
function readTail(path, bytes) {
  let handle
  try {
    handle = openSync(path, 'r')
    const size = statSync(path).size
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    if (buffer.length > 0) readSync(handle, buffer, 0, buffer.length, start)
    return buffer
  } catch (error) {
    return undefined
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch (error) {
        /* already gone */
      }
    }
  }
}

/**
 * The newest turn of one session log: how it ended, and when it began.
 *
 * Both facts come from the same pair of events, so they are read in one pass. The
 * page needs the start time as well as the reason: "任务运行时间" cannot be measured
 * from `running` (a boolean that says nothing about when the run began), and a
 * stopwatch started when the page first noticed would undercount a run that was
 * already in flight. `turn/start.time` is an epoch millisecond, directly comparable
 * to the page's own clock.
 * @param path - the log file.
 * @returns `{ state: 'ended' | 'running' | 'none' | 'unknown', reason, startedAt, endedAt }`.
 */
function lastTurn(path) {
  const buffer = readTail(path, TURN_LOG_TAIL_BYTES)
  if (buffer === undefined) return { state: 'unknown' }
  const lines = decodeZstdFrames(buffer).split('\n')
  let end
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line === '' || line.indexOf('"turn/') < 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      continue
    }
    if (event.type === 'turn/end') {
      if (end === undefined) end = event
      continue
    }
    if (event.type !== 'turn/start') continue
    if (end === undefined) {
      // The newest turn is still open: this is when it started.
      return { state: 'running', startedAt: epochOf(event) }
    }
    // The start that opened the turn we just closed.
    return {
      state: 'ended',
      reason: String(end.data?.reason?.kind ?? 'unknown'),
      startedAt: epochOf(event),
      endedAt: epochOf(end),
    }
  }
  return end === undefined
    ? { state: 'none' }
    : { state: 'ended', reason: String(end.data?.reason?.kind ?? 'unknown'), endedAt: epochOf(end) }
}

/** The epoch-millisecond stamp of one log event, when it carries a usable one. */
function epochOf(event) {
  const value = event?.time
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** What the newest turn of one session did, resolving the log by session id. */
function turnOf(sessionId) {
  const file = sessionLogPath(sessionId)
  return file === undefined ? { state: 'unknown' } : lastTurn(file)
}
//#endregion

/**
 * The window page. Opaque by design (the panel colours arrive in the snapshot),
 * it only renders what the browser half pushed and polls `/state` once a second.
 *
 * Exported so `tools/selfcheck.mjs` can execute this exact script against a stub DOM:
 * the host half cannot be hot-reloaded (Node caches a module by URL), so a mistake
 * here is only visible after a full restart, which makes a unit gate worth having.
 * @returns the page document as a string.
 */
export function pageHtml() {
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="color-scheme" content="dark light">',
    '<title>任务追踪</title>',
    '<style>',
    'html,body{margin:0;padding:0;height:100%;overflow:hidden}',
    'body{background:var(--dstt-base,#1d1d20);color:var(--dstt-fg,#ececf1);',
    'font:13px/20px "Segoe UI","Microsoft YaHei",system-ui,sans-serif;color-scheme:dark}',
    '*{scrollbar-color:var(--dstt-scroll-thumb,rgba(255,255,255,.18)) transparent}',
    '.frame::-webkit-scrollbar{width:10px}',
    '.frame::-webkit-scrollbar-track{background:0 0}',
    '.frame::-webkit-scrollbar-thumb{background:var(--dstt-scroll-thumb,rgba(255,255,255,.18));border-radius:5px}',
    '#app{display:flex;flex-direction:column;height:100vh}',
    '.head{display:flex;align-items:center;gap:8px;padding:9px 12px 7px;flex:none}',
    '.headline{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px}',
    '.title{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sub{font-size:11px;color:var(--dstt-muted,#9a9aa2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.close{border:0;background:0 0;color:var(--dstt-muted,#9a9aa2);cursor:pointer;border-radius:6px;height:24px;font-size:12px;line-height:24px;padding:0 8px;flex:none}',
    '.close:hover{background:var(--dstt-hover,rgba(255,255,255,.08));color:var(--dstt-fg,#ececf1)}',
    '.frame{flex:1;min-height:0;overflow:auto;padding:0 12px 10px;display:flex;justify-content:center}',
    '.body{width:100%;max-width:560px;display:flex;flex-direction:column}',
    // The progress bar is a hairline rule under the header, not a block: it carries
    // the same information without competing with the rows for attention.
    '.progress{display:flex;align-items:center;gap:8px;flex:none;padding:0 12px 8px}',
    '.bar{flex:1;min-width:0;height:3px;border-radius:2px;background:var(--dstt-group,rgba(255,255,255,.06));overflow:hidden}',
    '.fill{height:100%;border-radius:2px;background:var(--dstt-accent,#4d6bfe)}',
    '.figures{flex:none;font-size:11px;color:var(--dstt-muted,#9a9aa2);font-variant-numeric:tabular-nums}',
    '.section{display:flex;flex-direction:column}',
    '.sechead{font-size:11px;color:var(--dstt-muted,#9a9aa2);margin:12px 0 4px}',
    // The values of one section are one group, so the GROUP carries the surface and the
    // rows carry nothing: a hairline under every value read as a table of frames.
    '.group{display:flex;flex-direction:column;gap:1px;border-radius:8px;background:var(--dstt-group,rgba(255,255,255,.04))}',
    '.row{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:6px}',
    '.row:hover{background:var(--dstt-hover,rgba(255,255,255,.08))}',
    '.dot{flex:none;width:7px;height:7px;border-radius:50%;margin-top:6px;background:var(--dstt-muted,#9a9aa2)}',
    '.dot[data-status=completed]{background:var(--dstt-success,#2aa96b)}',
    '.dot[data-status=in_progress],.dot[data-status=running]{background:var(--dstt-accent,#4d6bfe)}',
    '.dot[data-status=waiting]{background:var(--dstt-warn,#d29922)}',
    '.dot[data-status=failed],.dot[data-status=killed]{background:var(--dstt-danger,#e5534b)}',
    '.dot[data-status=stopping]{background:var(--dstt-warn,#d29922)}',
    '.main{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px}',
    '.name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.name[data-done]{color:var(--dstt-muted,#9a9aa2);text-decoration:line-through}',
    '.meta{flex:none;font-size:11px;color:var(--dstt-muted,#9a9aa2);font-variant-numeric:tabular-nums}',
    '.row[data-clickable]{cursor:pointer}',
    '.empty{color:var(--dstt-muted,#9a9aa2);font-size:12px;padding:6px 4px}',
    '.foot{flex:none;padding:6px 12px;border-top:1px solid var(--dstt-border,rgba(255,255,255,.16));font-size:11px;color:var(--dstt-muted,#9a9aa2)}',
    '</style></head><body><div id="app"></div><script>',
    '(function () {',
    '  var root = document.getElementById("app")',
    '  function node(tag, cls, text) {',
    '    var element = document.createElement(tag)',
    '    if (cls) element.className = cls',
    '    if (text !== undefined && text !== null) element.textContent = String(text)',
    '    return element',
    '  }',
    '  var lastView = null',
    '  var COLOR_PATTERN = /^(#[0-9a-f]{3,8}|rgba?\\([0-9., %]+\\)|hsla?\\([0-9., %]+\\)|[a-z]{3,20})$/i',
    '  function applyTheme(theme) {',
    '    if (!theme) return',
    '    // `color-scheme` is set explicitly rather than derived: a document with no',
    '    // declared scheme gets the UA default, and on this shell that paints form',
    '    // controls and the scrollbar track light — the white box that showed up in an',
    '    // otherwise dark pane.',
    '    document.documentElement.style.colorScheme = theme.dark ? "dark" : "light"',
    '    var pairs = [["--dstt-base", theme.base], ["--dstt-panel", theme.panel], ["--dstt-fg", theme.fg],',
    '      ["--dstt-muted", theme.muted], ["--dstt-border", theme.border], ["--dstt-hover", theme.hover],',
    '      ["--dstt-group", theme.group], ["--dstt-accent", theme.accent], ["--dstt-success", theme.success],',
    '      ["--dstt-danger", theme.danger], ["--dstt-warn", theme.warn]]',
    '    for (var index = 0; index < pairs.length; index += 1) {',
    '      var value = pairs[index][1]',
    '      // Only colour literals: a custom property accepts url(...) too, and a',
    '      // pushed snapshot must never make this page fetch a remote resource.',
    '      if (typeof value === "string" && COLOR_PATTERN.test(value)) {',
    '        document.documentElement.style.setProperty(pairs[index][0], value)',
    '      }',
    '    }',
    '    // Scrollbars are themed by the document too: `color-scheme` alone leaves the',
    '    // track light on some builds.',
    '    document.documentElement.style.setProperty("--dstt-scroll-thumb", theme.dark ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.22)")',
    '  }',
    '  function row(item) {',
    '    var wrap = node("div", "row")',
    '    var dot = node("span", "dot")',
    '    dot.setAttribute("data-status", item.status || "pending")',
    '    var main = node("div", "main")',
    '    var name = node("div", "name", item.name)',
    '    // Rows are one line: the value sits at the end of the name, not under it.',
    '    if (item.done) name.setAttribute("data-done", "")',
    '    main.appendChild(name)',
    '    if (item.meta) main.appendChild(node("span", "meta", item.meta))',
    '    wrap.appendChild(dot); wrap.appendChild(main)',
    '    return wrap',
    '  }',
    '  function section(entry) {',
    '    var wrap = node("section", "section")',
    '    if (entry.title) wrap.appendChild(node("div", "sechead", entry.title))',
    '    if (!entry.rows || entry.rows.length === 0) {',
    '      if (entry.empty) wrap.appendChild(node("div", "empty", entry.empty))',
    '      return wrap',
    '    }',
    '    var group = node("div", "group")',
    '    for (var index = 0; index < entry.rows.length; index += 1) {',
    '      var item = entry.rows[index]',
    '      // A note is a full sentence, not a status row: it gets no bullet, so it reads',
    '      // as an explanation instead of a list item.',
    '      if (item.note) group.appendChild(node("div", "empty", item.name))',
    '      else group.appendChild(row(item))',
    '    }',
    '    wrap.appendChild(group)',
    '    return wrap',
    '  }',
    '  /** Report one navigation request to the host; the plugin applies it. */',
    '  function sendNav(payload) {',
    '    fetch("/nav", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(function () {})',
    '  }',
    '  /** Make the rows of the compact box clickable: index -> target. */',
    '  function wireRows() {',
    '    var panel = root.querySelector("[data-compact-rows]")',
    '    if (!panel || !lastView || !lastView.compact) return',
    '    var rows = lastView.compact.rows || []',
    '    var nodes = panel.querySelectorAll("[data-row-index]")',
    '    for (var i = 0; i < nodes.length; i += 1) {',
    '      (function (element) {',
    '        var entry = rows[Number(element.getAttribute("data-row-index"))]',
    '        if (!entry || !entry.target) return',
    '        element.setAttribute("role", "button")',
    '        element.setAttribute("tabindex", "0")',
    '        element.addEventListener("click", function () { sendNav({ target: entry.target }) })',
    '      })(nodes[i])',
    '    }',
    '    var back = root.querySelector("[data-navback]")',
    '    if (back) back.addEventListener("click", function () { sendNav({ back: true }) })',
    '  }',
    '  function render(payload) {',
    '    var view = payload.view',
    '    if (!view) {',
    '      root.textContent = ""',
    '      root.appendChild(node("div", "empty", "等待 DeepSeek Harness 推送任务状态…"))',
    '      return',
    '    }',
    '    applyTheme(view.theme)',
    '    lastView = view',
    '    // The pane is rebuilt from scratch once a second, so the scroll offset has to',
    '    // survive the rebuild: without this, a poll that lands while the reader is',
    '    // scrolled down snaps the new content back to the top.',
    '    var previous = root.querySelector("[data-scroll]")',
    '    var scrollTop = previous ? previous.scrollTop : 0',
    '    var head = node("div", "head")',
    '    if (view.compact && view.compact.back === true) {',
    '      var back = node("button", "close", "\\u2039 \\u8fd4\\u56de")',
    '      back.setAttribute("data-navback", "")',
    '      back.setAttribute("aria-label", "back")',
    '      head.appendChild(back)',
    '    }',
    '    var headline = node("div", "headline")',
    '    headline.appendChild(node("div", "title", view.header.title))',
    '    if (view.header.subtitle) headline.appendChild(node("div", "sub", view.header.subtitle))',
    '    head.appendChild(headline)',
    '    // No close button here on purpose: this document has a system title bar with',
    '    // its own close control, and a second one inside the pane only adds a frame.',
    '    var bar = node("div", "progress")',
    '    var track = node("div", "bar")',
    '    var fill = node("div", "fill")',
    '    fill.style.width = String(view.progress.percent) + "%"',
    '    track.appendChild(fill)',
    '    bar.appendChild(track)',
    '    bar.appendChild(node("span", "figures", (view.progress.text || "") + (view.progress.detail ? " \\u00b7 " + view.progress.detail : "")))',
    '    var body = node("div", "body")',
    '    body.setAttribute("data-scroll", "")',
    '    var compactMode = view.mode === "list" && view.compact',
    '    if (compactMode) {',
    '      // The compact monitor state: exactly one box of conversations, and its',
    '      // rows are clickable (the index maps back to the row target).',
    '      var box = node("section", "section")',
    '      box.setAttribute("data-compact-rows", "")',
    '      box.appendChild(node("div", "sechead", view.compact.title))',
    '      var boxRows = view.compact.rows || []',
    '      for (var r = 0; r < boxRows.length; r += 1) {',
    '        var rowNode = row(boxRows[r])',
    '        if (boxRows[r] && boxRows[r].target) {',
    '          rowNode.setAttribute("data-row-index", String(r))',
    '          rowNode.setAttribute("data-clickable", "")',
    '        }',
    '        box.appendChild(rowNode)',
    '      }',
    '      body.appendChild(box)',
    '    } else {',
    '      for (var index = 0; index < view.sections.length; index += 1) body.appendChild(section(view.sections[index]))',
    '    }',
    '    var foot = node("div", "foot", compactMode ? view.compact.hint : view.footer)',
    '    root.textContent = ""',
    '    // The reading column is centred and bounded: full width on a wide window makes',
    '    // a name and its value sit absurdly far apart.',
    '    var frame = node("div", "frame")',
    '    frame.appendChild(body)',
    '    root.appendChild(head)',
    '    if (view.mode === "detail") root.appendChild(bar)',
    '    root.appendChild(frame); root.appendChild(foot)',
    '    body.scrollTop = scrollTop',
    '    wireRows()',
    '  }',
    '  function poll() {',
    '    fetch("/state", { cache: "no-store" }).then(function (response) { return response.json() })',
    '      .then(function (payload) {',
    '        // The host cannot always kill this window (Chromium forwards --app= to',
    '        // an existing profile instance and the launcher process exits), so a',
    '        // close request travels in the snapshot and the page closes itself.',
    '        if (payload && payload.closeRequested === true) { try { window.close() } catch (error) {} }',
    '        render(payload)',
    '      })',
    '      .catch(function () {})',
    '  }',
    '  document.addEventListener("click", function (event) {',
    '    var target = event.target',
    '    // No close button is drawn any more, but an old window may still be running the',
    '    // previous page, so the handler stays.',
    '    if (target && target.getAttribute && target.getAttribute("data-close") !== null) {',
    '      fetch("/close", { method: "POST" }).catch(function () {})',
    '      setTimeout(function () { try { window.close() } catch (error) {} }, 60)',
    '    }',
    '  })',
    '  poll()',
    '  setInterval(poll, 1000)',
    '})()',
    '</script></body></html>',
  ].join('\n')
}

/** Escape the five XML entities a toast payload can contain. */
function escapeXml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}

/** The AUMID the desktop app registers its toasts under. */
const TOAST_APP_ID = 'electron.app.DeepSeek Harness'

/** The PowerShell program that hands one toast to Windows (5.1 projects WinRT). */
const TOAST_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$xml.LoadXml($env:DSH_TT_TOAST_XML)',
  '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:DSH_TT_TOAST_APPID).Show($toast)',
].join('\n')

/** Where the helper script is staged (written once, then reused). */
let toastScriptPath

/** The outcome of the most recent toast, kept for diagnostics. */
let lastToast = { at: undefined, ok: undefined, exit: undefined, error: undefined, stderr: '' }

/** The last toast attempt, for `/notify` to report back. */
export function toastStatus() {
  return lastToast
}

/**
 * Show one native Windows toast.
 *
 * The browser-side `Notification` API turned out to be unreliable here: the
 * shell grants the permission and the constructor accepts the call, yet nothing
 * reaches the Windows notification centre. A short-lived PowerShell 5.1 process
 * posts a WinRT toast attributed to the app's own AUMID instead — that is the
 * channel that actually shows up while the user works in another application.
 *
 * The payload travels through the environment and the script through a staged
 * file: an inline `-Command` string proved unable to deliver it. The child's
 * output is captured so a failure is diagnosable instead of silent.
 * @param title - headline (the task status).
 * @param body - detail line.
 * @returns whether the toast process was started.
 */
function showToast(title, body) {
  if (process.platform !== 'win32') return false
  try {
    // The script is staged fresh for every toast under the plugin's OWN profile
    // directory, with a random name. A predictable file in the shared temp
    // directory would let any same-user process drop its own script there and
    // have it executed with -ExecutionPolicy Bypass on the next notification.
    const directory = join(profileDirectory(), 'toast')
    mkdirSync(directory, { recursive: true })
    const scriptPath = join(directory, `toast-${randomUUID()}.ps1`)
    writeFileSync(scriptPath, TOAST_SCRIPT, { encoding: 'utf8', mode: 0o600 })
    const xml = '<toast><visual><binding template="ToastGeneric"><text>'
      + escapeXml(title) + '</text><text>' + escapeXml(body === undefined ? '' : body)
      + '</text></binding></visual></toast>'
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        env: { ...process.env, DSH_TT_TOAST_XML: xml, DSH_TT_TOAST_APPID: TOAST_APP_ID },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    const stderr = []
    if (child.stderr !== null) {
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 8) stderr.push(String(chunk))
      })
    }
    /** Remove the staged script once its process is gone. */
    const cleanup = () => {
      try {
        unlinkSync(scriptPath)
      } catch (error) {
        /* already gone, or locked by a slow scanner */
      }
    }
    child.on('error', (error) => {
      lastToast = { at: new Date().toISOString(), ok: false, exit: undefined, error: String(error.message), stderr: '' }
      cleanup()
    })
    child.on('close', (code) => {
      lastToast = {
        at: new Date().toISOString(),
        ok: code === 0,
        exit: code,
        error: undefined,
        stderr: stderr.join('').trim().slice(0, 400),
      }
      cleanup()
    })
    child.unref()
    return true
  } catch (error) {
    lastToast = { at: new Date().toISOString(), ok: false, exit: undefined, error: String(error.message), stderr: '' }
    return false
  }
}

/** Read one request body up to the cap. */
function readBody(request) {  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        request.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => resolve(undefined))
  })
}

/** CORS headers for one accepted caller; `*` is never used. */
function corsHeaders(origin) {
  if (origin === undefined || origin === '') return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin',
  }
}

/** Answer one request with JSON and CORS limited to the accepted caller. */
function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...corsHeaders(response.allowedOrigin),
  })
  response.end(body)
}

/** Answer one request with the window page. */
function sendPage(response, html) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // The page is ours and self-contained: no remote loads, and it must never be
    // framed (a page that framed it could click its close button).
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  })
  response.end(html)
}

/**
 * Mount the window service. It owns one loopback HTTP server, the latest view
 * snapshot, and at most one browser window.
 * @param ctx - host Cordis context.
 */
export function apply(ctx) {
  if (globalThis[MOUNTED] === true) return
  globalThis[MOUNTED] = true
  const state = {
    view: undefined,
    child: undefined,
    server: undefined,
    port: undefined,
    browser: undefined,
    lastError: undefined,
    /** Set by /close so the served page can close itself; cleared by /open. */
    closeRequested: false,
    lastToastRequestAt: 0,
    /** The most recent turn lookup, for `/ping`. */
    lastTurn: undefined,
  }
  const html = pageHtml()

  const log = (level, message) => {
    try {
      const logger = ctx?.logger
      if (logger !== undefined && typeof logger[level] === 'function') logger[level](message)
      else console[level === 'warn' ? 'warn' : 'log'](`[task-tracker] ${message}`)
    } catch (error) {
      /* logging must never break the service */
    }
  }

  /** Kill the window process, if one is tracked. */
  const closeWindow = () => {
    const child = state.child
    state.child = undefined
    if (child === undefined) return false
    try {
      child.kill()
    } catch (error) {
      /* already gone */
    }
    return true
  }

  /** Launch the real Windows window showing the pushed view. */
  const openWindow = () => {
    if (state.child !== undefined) return { open: true, launched: false }
    const browser = state.browser ?? findBrowser()
    state.browser = browser
    if (browser === undefined) {
      state.lastError = 'no-chromium-browser'
      return { open: false, launched: false, error: state.lastError }
    }
    const profile = profileDirectory()
    try {
      mkdirSync(profile, { recursive: true })
    } catch (error) {
      /* an existing profile directory is fine */
    }
    const url = `http://127.0.0.1:${String(state.port)}/`
    try {
      const child = spawn(browser, [
        `--app=${url}`,
        '--window-size=440,920',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-features=Translate',
      ], { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('exit', () => {
        if (state.child === child) state.child = undefined
      })
      child.on('error', (error) => {
        state.lastError = String(error?.message ?? error)
        if (state.child === child) state.child = undefined
      })
      child.unref()
      state.child = child
      state.lastError = undefined
      log('info', `window launched via ${browser} on port ${String(state.port)}`)
      return { open: true, launched: true }
    } catch (error) {
      state.lastError = String(error?.message ?? error)
      return { open: false, launched: false, error: state.lastError }
    }
  }

  /** Route one request. */
  const handle = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    // Two gates before any route runs. `hostAllowed` defeats DNS rebinding (a
    // public name that resolves to 127.0.0.1 still sends its own Host header),
    // and `originAllowed` keeps ordinary web pages out: without it any site the
    // user visits could read /state (session titles, project paths) and post
    // /notify or /toggle.
    if (!hostAllowed(request, state.port)) {
      log('warn', `rejected request with host ${String(request.headers.host)}`)
      sendJson(response, 403, { ok: false, error: 'bad-host' })
      return
    }
    const origin = request.headers.origin
    if (!originAllowed(request, state.port)) {
      log('warn', `rejected request from origin ${String(origin)}`)
      sendJson(response, 403, { ok: false, error: 'bad-origin' })
      return
    }
    // Echo only the caller we accepted, never `*`.
    response.allowedOrigin = origin
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...corsHeaders(origin),
        'access-control-max-age': '600',
      })
      response.end()
      return
    }
    if (path === '/ping') {
      sendJson(response, 200, {
        app: SERVICE_ID,
        version: VERSION,
        port: state.port,
        browser: state.browser ?? findBrowser() ?? null,
        open: state.child !== undefined,
        toast: process.platform === 'win32',
        // The outcome of the most recent native toast. `/notify` answers with the
        // state as of that call, which is usually still `pending`; this is the
        // settled answer, so "did the toast reach Windows?" is one GET away.
        lastToast: toastStatus(),
        // The version stamp of the browser half ON DISK. A page whose own version
        // differs is running a bundle that has since been replaced, and reloads itself.
        clientVersion: clientHalfVersion() ?? null,
        // The most recent turn lookup: how the newest turn ended, and when it began.
        // This is what makes the interruption rule and the run timer auditable from
        // outside.
        lastTurn: state.lastTurn ?? null,
        // The browser half's last self-report, so one GET answers "is the client
        // alive, and did its slot cells ever render?" without touching storage.
        health: state.health ?? null,
        healthAt: state.healthAt ?? null,
        nav: state.nav ?? null,
        navAt: state.navAt ?? null,
      })
      return
    }
    // State-changing routes are POST-only. This is not stylistic: browsers send
    // no `Origin` on a no-cors GET, so `<img src="http://127.0.0.1:PORT/toggle">`
    // on any page the user visits would otherwise open or kill the window.
    const wantsWrite = path === '/notify' || path === '/toggle' || path === '/open' || path === '/close' || path === '/health' || path === '/nav' || path === '/turn'
    if (wantsWrite && request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (path === '/nav') {
      // The served page has no React and no plugin context, so a row click is
      // reported here; the browser half picks it up on its next tick.
      const raw = await readBody(request)
      try {
        state.nav = raw === undefined ? undefined : JSON.parse(raw)
        state.navAt = new Date().toISOString()
      } catch (error) {
        sendJson(response, 400, { ok: false, error: 'bad-json' })
        return
      }
      sendJson(response, 200, { ok: true, nav: state.nav ?? null })
      return
    }
    if (path === '/health') {
      const raw = await readBody(request)
      let payload
      try {
        payload = raw === undefined ? undefined : JSON.parse(raw)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: 'bad-json' })
        return
      }
      state.health = payload
      state.healthAt = new Date().toISOString()
      // Retire a click the plugin has confirmed applying. The plugin cannot be asked
      // "have you seen this one?" — it only polls — so without this the host keeps
      // answering `/ping` with the last click for the rest of its life, and a page
      // that loads later applies it as though the user had just clicked: the pane
      // opened on a conversation's detail instead of the project list it was opened
      // for. A newer click leaves the retirement undone, so it still gets applied.
      if (payload !== undefined && payload !== null && payload.mode === 'nav'
        && payload.navStamp !== undefined && state.navAt !== undefined
        && String(payload.navStamp) === String(state.navAt)) {
        state.nav = undefined
        state.navAt = undefined
      }
      sendJson(response, 200, { ok: true, health: state.health ?? null, healthAt: state.healthAt })
      return
    }
    if (path === '/turn') {
      // "What is this session's newest turn doing?" — the page cannot answer it (its
      // session status is only `{ running, pendingInteraction, completionUnread }`),
      // so it asks here and the session's own log answers. Two callers: one that wants
      // to know WHY a run ended (and sets `settled`, because the closing event lands
      // just after the status flips), and one that wants to know WHEN the current run
      // began. This is a query, not a toast: the wording belongs to the page, which
      // owns the locale.
      const raw = await readBody(request)
      let payload
      try {
        payload = raw === undefined ? undefined : JSON.parse(raw)
      } catch (error) {
        payload = undefined
      }
      if (payload === undefined || payload === null || typeof payload.sessionId !== 'string' || payload.sessionId === '') {
        sendJson(response, 400, { ok: false, error: 'bad-request' })
        return
      }
      let outcome = turnOf(payload.sessionId)
      // The status turns "not running" the instant the turn closes, and the closing
      // event is appended just after it, so a caller that says it is asking about a
      // FINISHED run is given a moment before "still running" is taken as the answer.
      // A caller asking about the run in flight is not kept waiting for that.
      for (let attempt = 0; attempt < 4 && payload.settled === true && outcome.state === 'running'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        outcome = turnOf(payload.sessionId)
      }
      state.lastTurn = {
        at: new Date().toISOString(),
        sessionId: payload.sessionId,
        state: outcome.state,
        reason: outcome.reason ?? null,
        startedAt: outcome.startedAt ?? null,
      }
      sendJson(response, 200, {
        ok: true,
        state: outcome.state,
        reason: outcome.reason ?? null,
        startedAt: outcome.startedAt ?? null,
        endedAt: outcome.endedAt ?? null,
      })
      return
    }
    if (path === '/notify') {
      // Native Windows toast: the browser-side Notification API accepts the call
      // here but nothing reaches the notification centre, so the host posts it.
      // A local page could still loop on POST, so the toast rate stays sane.
      const now = Date.now()
      if (now - state.lastToastRequestAt < TOAST_MIN_GAP_MS) {
        sendJson(response, 429, { ok: false, error: 'too-many-requests' })
        return
      }
      state.lastToastRequestAt = now
      const raw = await readBody(request)
      let payload
      try {
        payload = raw === undefined ? undefined : JSON.parse(raw)
      } catch (error) {
        payload = undefined
      }
      if (payload === undefined || typeof payload.title !== 'string') {
        sendJson(response, 400, { ok: false, error: 'bad-request' })
        return
      }
      const shown = showToast(payload.title, typeof payload.body === 'string' ? payload.body : '')
      state.lastToastAt = new Date().toISOString()
      // Report the last known outcome, not just "spawned": the helper runs
      // asynchronously, so the first call answers `pending` on purpose.
      sendJson(response, 200, { ok: shown, toast: shown, result: lastToast })
      return
    }
    if (path === '/state') {
      if (request.method === 'POST') {
        const body = await readBody(request)
        if (body === undefined) {
          sendJson(response, 413, { ok: false, error: 'body-too-large' })
          return
        }
        try {
          state.view = JSON.parse(body)
          sendJson(response, 200, { ok: true })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: 'bad-json' })
        }
        return
      }
      sendJson(response, 200, {
        open: state.child !== undefined,
        view: state.view ?? null,
        // The pane's own navigation state, echoed on every poll: it is the only way to
        // answer "did my click in the pane land?" from outside the app.
        debug: state.view?.debug ?? null,
        // The page closes itself when asked; see the poll handler it runs.
        closeRequested: state.closeRequested === true,
      })
      return
    }
    if (path === '/toggle' || path === '/open' || path === '/close') {
      const wantsOpen = path === '/close' ? false : path === '/open' ? true : state.child === undefined
      if (wantsOpen) {
        state.closeRequested = false
        const result = openWindow()
        sendJson(response, 200, { ok: result.open, open: result.open, error: result.error ?? null })
      } else {
        const killed = closeWindow()
        state.closeRequested = true
        sendJson(response, 200, { ok: true, open: false, error: null, killed: killed })
      }
      return
    }
    if (path === '/' || path === '/index.html') {
      sendPage(response, html)
      return
    }
    sendJson(response, 404, { ok: false, error: 'not-found' })
  }

  /** Bind the first free port from the shared list. */
  const listen = (index) => {
    if (index >= PORTS.length) {
      log('warn', 'no free loopback port; the browser half will use its own window modes')
      return
    }
    const port = PORTS[index]
    const server = createServer((request, response) => {
      handle(request, response).catch((error) => {
        try {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
        } catch (nested) {
          /* the response is already gone */
        }
      })
    })
    // A stuck client must not pin a socket for ever.
    server.headersTimeout = 10000
    server.requestTimeout = 15000
    server.on('error', () => {
      try {
        server.close()
      } catch (error) {
        /* nothing to close */
      }
      listen(index + 1)
    })
    server.listen(port, '127.0.0.1', () => {
      state.server = server
      state.port = port
      log('info', `service listening on 127.0.0.1:${String(port)}`)
    })
  }

  ctx.effect(() => {
    listen(0)
    return () => {
      closeWindow()
      globalThis[MOUNTED] = false
      const server = state.server
      state.server = undefined
      state.port = undefined
      if (server !== undefined) {
        try {
          server.close()
        } catch (error) {
          /* already closed */
        }
      }
    }
  }, 'dsh-task-tracker: window service')
}
