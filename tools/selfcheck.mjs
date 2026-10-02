/**
 * Self-check for the browser half.
 *
 * It loads the REAL bundle in a VM with the same globals the loader gives it, then
 * asserts the contract each part of the design depends on:
 *
 *   - the module-loader envelope (a bare module took the whole app down once:
 *     `Uncaught ReferenceError: require is not defined` → `web boot: 1 entry did
 *     not activate`),
 *   - the `inject` declaration stays a flat array of services the app provides,
 *   - the composer button registers into `conversation.input.left` — the seat the
 *     user asked for, whose shipped occupants are the permission and plan chips,
 *   - the root-scoped monitor that carries the frame-wide sources,
 *   - the view the host window page actually consumes (its schema, not a lookalike),
 *   - the two feeds that used to be missing: `POST /state` (the window) and
 *     `POST /notify` (the toast),
 *   - the notification rules: a finished run notifies, a subagent or a blank session
 *     never does, and the cooldown holds,
 *   - the window opens the app-owned marker URL first.
 *
 * Usage: node tools/selfcheck.mjs [--verbose]
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { pageHtml } from '../lib/window.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const windowSource = readFileSync(join(root, 'lib', 'window.js'), 'utf8')
const verbose = process.argv.includes('--verbose')

let passed = 0
const failures = []

/**
 * Run one check. Async bodies are awaited, so a rejected promise is a failure and
 * not an unhandled rejection.
 * @param name - what is being asserted.
 * @param body - the assertions.
 */
async function check(name, body) {
  try {
    await body()
    passed += 1
    console.log('  ok    ' + name)
  } catch (error) {
    failures.push({ name, error })
    console.log('  FAIL  ' + name + ' — ' + (error && error.message))
  }
}

//#region harness
/**
 * One fake element that remembers its children, attributes and classes.
 *
 * It answers the subset of the DOM the two halves actually use: `[attribute]`,
 * `.class` and `tag` selectors, `textContent`, `getBoundingClientRect`, and
 * `scrollTop` (the window page restores it across a rebuild).
 */
function element(tag) {
  let text = ''
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    attributes: {},
    listeners: {},
    className: '',
    scrollTop: 0,
    /** `textContent` replaces the children, exactly as it does in a real document. */
    get textContent() {
      return text
    },
    set textContent(value) {
      text = value === undefined || value === null ? '' : String(value)
      this.children = []
    },
    appendChild(child) {
      this.children.push(child)
      return child
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child)
      return child
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    getAttribute(name) {
      return this.attributes[name] ?? null
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler
    },
    remove() {},
    getBoundingClientRect() {
      return { left: 508, top: 753, width: 65, height: 28, right: 573, bottom: 781 }
    },
    /** Every descendant, in document order. */
    walk(out = []) {
      for (const child of this.children) {
        out.push(child)
        if (child.walk !== undefined) child.walk(out)
      }
      return out
    },
    /** Whether this element matches one simple selector. */
    matches(selector) {
      if (selector.startsWith('[') && selector.endsWith(']')) return Object.hasOwn(this.attributes, selector.slice(1, -1))
      if (selector.startsWith('.')) return String(this.className).split(/\s+/u).includes(selector.slice(1))
      if (selector.startsWith('#')) return this.attributes.id === selector.slice(1)
      return this.tagName === selector.toUpperCase()
    },
    /** The first descendant (or self) matching a simple selector. */
    querySelector(selector) {
      for (const candidate of [this, ...this.walk()]) if (candidate.matches?.(selector) === true) return candidate
      return null
    },
    /** Every descendant (and self) matching a simple selector. */
    querySelectorAll(selector) {
      return [this, ...this.walk()].filter((candidate) => candidate.matches?.(selector) === true)
    },
    /** All text under this node. */
    text() {
      return this.walk()
        .map((child) => child.textContent)
        .filter((value) => typeof value === 'string' && value !== '')
        .join(' ')
    },
  }
  return node
}

/** A document good enough for the panel builder and the palette reader. */
function fakeDocument() {
  const head = element('head')
  const body = element('body')
  const documentElement = element('html')
  const nodes = new Map()
  return {
    head,
    body,
    documentElement,
    title: '',
    createElement: (tag) => element(tag),
    getElementById: (id) => nodes.get(id) ?? null,
    setElement: (id, node) => nodes.set(id, node),
    querySelectorAll: () => [],
    addEventListener: () => {},
  }
}

/**
 * Load the bundle with the globals the plugin loader provides.
 * @returns the harness: the plugin exports, the registered cells, the requests, ...
 */
function loadBundle() {
  const cells = []
  const intervals = []
  const timeouts = []
  const requests = []
  const effects = []
  const notes = []
  const opened = []
  let nextIntervalId = 1
  // How many `/notify` calls the host should refuse before answering normally: the
  // service rate-limits toasts, and the client has to survive that.
  let notifyRefusals = 0
  // Whether the host reports having shown the toast. It answers 200 either way, which
  // is exactly the trap: `toast: false` is what a non-Windows host returns.
  let notifyDelivers = true
  // Every browser-API notification the client constructed, so the fallback is observable.
  const notifications = []
  // Every `location.reload()` the client asked for, and the version stamp of the bundle
  // this page is being served (the boot-graph fetch is what reads it).
  const reloads = []
  let servedBundleVersion
  // Refuse the boot-graph bundle fetch, the way a custom-scheme page can.
  let bundleFetchFails = false
  // What `/ping` reports as the version of the browser half on disk.
  let hostClientVersion
  // What `/turn` answers with. `reason: undefined` stands for "the host could not
  // tell", which the client must treat as a real finish rather than swallow;
  // `startedAt` is the log's own epoch stamp for the turn in flight.
  let turnReason = 'completed'
  let turnStartedAt
  const document = fakeDocument()
  // What `/ping` answers with. The nav section is the only way the pane can move, so
  // the tests drive it directly.
  let navReply
  // React counts hooks per render and throws when the count changes. The stub keeps
  // the same ledger so the self-check can assert it across renders — that failure
  // (minified error #310) retires the whole cell, so it has to be caught here.
  let hookLog = null
  const hookSignatures = []

  const runEffects = () => {
    const pending = effects.splice(0, effects.length)
    for (const effect of pending) {
      const cleanup = effect()
      if (typeof cleanup === 'function') notes.push(cleanup)
    }
    return pending.length
  }

  /** Run every timer callback that is waiting (the tests drive delays by hand). */
  const runTimeouts = () => {
    const pending = timeouts.splice(0, timeouts.length)
    for (const entry of pending) entry.fn()
    return pending.length
  }

  const record = (name) => {
    if (hookLog !== null) hookLog.push(name)
  }
  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => {
      record('useState')
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect: (fn) => {
      record('useEffect')
      effects.push(fn)
    },
    useMemo: (fn) => {
      record('useMemo')
      return fn()
    },
    useRef: (initial) => {
      record('useRef')
      return { current: initial }
    },
    useSyncExternalStore: (subscribe, getSnapshot) => {
      record('useSyncExternalStore')
      if (typeof subscribe === 'function') subscribe(() => {})
      return getSnapshot()
    },
  }
  const requireStub = (name) => {
    if (name === 'react') return ReactStub
    if (name === 'react/jsx-runtime') return { jsx: ReactStub.createElement, jsxs: ReactStub.createElement }
    if (name === 'react-dom') return { createRoot: () => ({ render: () => {} }) }
    if (name === 'react-dom/client') return { createRoot: () => ({ render: () => {} }) }
    throw new Error('unexpected require: ' + name)
  }

  let entry = null
  const context = {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          entry = value
        },
      },
    },
    console,
    JSON,
    Math,
    Date,
    Number,
    String,
    Object,
    Array,
    Boolean,
    Promise,
    Map,
    Set,
    Error,
    Symbol,
    parseInt,
    parseFloat,
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms })
      return timeouts.length
    },
    clearTimeout: () => {},
    setInterval: (fn, ms) => {
      const id = nextIntervalId
      nextIntervalId += 1
      intervals.push({ id, fn, ms })
      return id
    },
    clearInterval: (id) => {
      const index = intervals.findIndex((entry) => entry.id === id)
      if (index >= 0) intervals.splice(index, 1)
    },
    requestAnimationFrame: (fn) => {
      fn()
      return 1
    },
    fetch: (url, init) => {
      requests.push({ url: String(url), init })
      if (bundleFetchFails && String(url).includes('/plugins/')) {
        return Promise.reject(new Error('refused to fetch a dsh-app: URL'))
      }
      if (String(url).endsWith('/turn')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            ok: true,
            state: turnReason === undefined ? 'unknown' : 'ended',
            reason: turnReason ?? null,
            startedAt: turnStartedAt ?? null,
            endedAt: null,
          }),
        })
      }
      if (String(url).endsWith('/notify') && notifyRefusals > 0) {
        notifyRefusals -= 1
        return Promise.resolve({
          ok: false,
          status: 429,
          json: () => Promise.resolve({ ok: false, error: 'too-many-requests' }),
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        // The bundle fetch reads the served version out of the script body; without one
        // set, the body carries no stamp and the check reads "cannot tell".
        text: () => Promise.resolve(
          servedBundleVersion === undefined ? '/* unversioned */' : 'var VERSION = "' + servedBundleVersion + '"',
        ),
        json: () => Promise.resolve({
          app: 'dsh-task-tracker',
          version: '0.1.0',
          clientVersion: hostClientVersion,
          ok: true,
          toast: notifyDelivers,
          nav: navReply === undefined ? null : navReply.nav,
          navAt: navReply === undefined ? null : navReply.navAt,
        }),
      })
    },
    localStorage: {
      values: new Map(),
      getItem(key) {
        return this.values.get(key) ?? null
      },
      setItem(key, value) {
        this.values.set(key, String(value))
      },
    },
    sessionStorage: {
      values: new Map(),
      getItem(key) {
        return this.values.get(key) ?? null
      },
      setItem(key, value) {
        this.values.set(key, String(value))
      },
      removeItem(key) {
        this.values.delete(key)
      },
    },
    document,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    location: {
      reload: () => {
        reloads.push('reload')
      },
    },
    // The boot graph the page reads to find its own bundle URL.
    __DSH_BOOT__: { entries: [{ id: 'dsh-task-tracker', url: 'plugins/dsh-task-tracker/client.js' }] },
    Notification: Object.assign(
      function Notification(title, options) {
        notifications.push({ title: title, options: options })
      },
      {
        permission: 'granted',
        requestPermission: () => Promise.resolve('granted'),
      },
    ),
    open: (url, name, features) => {
      const popupDocument = fakeDocument()
      const handle = {
        document: popupDocument,
        closed: false,
        close() {
          this.closed = true
        },
      }
      opened.push({ url, name, features, window: handle })
      return handle
    },
    globalThis: undefined,
  }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'client.js' })
  if (entry === null) throw new Error('the bundle never called window.__ModuleLoader__.load')
  if (entry.id !== 'dsh-task-tracker') throw new Error('unexpected entry id: ' + entry.id)
  const exportsObject = entry.factory(requireStub)

  /** Install the tracker into a stub slot service. */
  const applyTo = () => {
    const injections = []
    const ctx = {
      locale: { current: 'zh' },
      slots: {
        inject: (key, callback) => {
          injections.push(key)
          callback()
          return () => {}
        },
        register: (options, component) => {
          cells.push({ options, component })
          return () => {}
        },
        entriesOfSlot: (key) => cells.filter((cell) => cell.options.name === key),
      },
    }
    exportsObject.apply(ctx)
    return injections
  }
  /**
   * Render one cell while recording its hook order.
   * @param slotName - the slot key.
   * @param props - the props the framework would pass.
   * @returns the produced element.
   */
  const renderCellTracked = (slotName, props) => {
    const cell = cells.find((candidate) => candidate.options.name === slotName)
    if (cell === undefined) throw new Error('no cell registered for ' + slotName)
    hookLog = []
    const node = cell.component(props)
    hookSignatures.push(hookLog.join(','))
    hookLog = null
    runEffects()
    return node
  }
  /**
   * Execute the real host window page against a stub document.
   *
   * The page is one inline `<script>`; this pulls it out of the generated HTML and
   * runs it with `document`, `fetch` and `setInterval` stubbed, so the assertions can
   * look at the tree it drew and at the scroll offset it preserved.
   * @returns `{ root, render, polls }`.
   */
  const renderWindowPage = () => {
    const html = pageHtml()
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'))
    const root = element('div')
    const polls = []
    const documentStub = {
      documentElement: { style: { setProperty() {}, colorScheme: '' } },
      getElementById: (id) => (id === 'app' ? root : null),
      createElement: (tag) => element(tag),
      addEventListener: () => {},
    }
    const context = {
      document: documentStub,
      window: { close: () => {} },
      fetch: (url) => {
        polls.push(String(url))
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ view: null }) })
      },
      setInterval: () => 1,
      setTimeout: () => 1,
      clearInterval: () => {},
      clearTimeout: () => {},
      console,
    }
    context.globalThis = context
    vm.createContext(context)
    // The page script is one IIFE that ends with `poll()` and `setInterval(poll, 1000)`.
    // Its `render` lives inside that closure, so the tail call is rewritten to hand the
    // two functions back instead — the stub then drives the real code.
    const tail = script.lastIndexOf('})()')
    if (tail < 0) throw new Error('the window page script has no IIFE tail to hook')
    const harnessed = script.slice(0, tail) + '  return { render: render, poll: poll }\n})()'
    const api = vm.runInContext(harnessed, context, { filename: 'window-page.js' })
    return { root, polls, render: api.render, poll: api.poll }
  }

  return {
    bundle: exportsObject,
    cells,
    intervals,
    timeouts,
    requests,
    document,
    opened,
    effects,
    runEffects,
    runTimeouts,
    applyTo,
    context,
    renderCellTracked,
    hookSignatures,
    renderWindowPage,
    /** Record one framework hook call the cell made through a prop. */
    record,
    /** Set what `/ping` answers with for the next tick (`{ nav, navAt }`). */
    setNavReply: (value) => {
      navReply = value
    },
    /** Refuse the next `count` toast requests the way the host's rate limiter does. */
    setNotifyRefusals: (count) => {
      notifyRefusals = count
    },
    /** Whether `/notify` reports that the native toast was shown. */
    setNotifyDelivers: (value) => {
      notifyDelivers = value
    },
    /** What version stamp the served bundle carries (`undefined` = cannot be read). */
    setServedVersion: (value) => {
      servedBundleVersion = value
    },
    /** Make the boot-graph bundle fetch fail, as a custom-scheme page can. */
    setBundleFetchFails: (value) => {
      bundleFetchFails = value
    },
    /** What `/ping` reports as the browser half's version on disk. */
    setHostClientVersion: (value) => {
      hostClientVersion = value
    },
    notifications,
    reloads,
    /** Set what `/turn` reports as the reason for the finished turn. */
    setTurnEndReason: (value) => {
      turnReason = value
    },
    /** Set the epoch stamp `/turn` reports for a turn's start (`undefined` = no answer). */
    setTurnStart: (value) => {
      turnStartedAt = value
    },
  }
}

const harness = loadBundle()
const injections = harness.applyTo()
const { bundle, cells, intervals, requests, document, opened } = harness
//#endregion

/** Run every check, then report. */
async function main() {
//#region envelope and declarations
  await check('wraps itself in the module-loader envelope', () => {
  assert.ok(source.includes('window.__ModuleLoader__.load('), 'the loader call must exist')
  assert.ok(source.includes('id: "dsh-task-tracker"'), 'with the plugin id')
  assert.ok(source.includes('factory: (require) =>'), 'and a factory that receives require')
  assert.ok(source.includes('return module.exports'), 'and it must return its exports')
  assert.ok(!source.slice(0, source.indexOf('factory:')).includes('= require'), 'nothing may require() at file scope')
})

  await check('declares a flat inject array of services the app provides', () => {
  assert.ok(Array.isArray(bundle.inject), 'inject must be an array')
  // Text comparison on purpose: the bundle runs in a VM realm, so its Array has a
  // different prototype and a strict deep comparison fails for the wrong reason.
  assert.equal(bundle.inject.join(','), 'slots', 'inject must stay the known-good minimal set')
  assert.ok(!/inject:\s*\{/u.test(source), 'inject must not be an object (that blocks web boot)')
  assert.ok(!source.includes('workspaceRegistry'), 'no host-side service may be declared or read')
})

  await check('keeps the three version stamps in step', () => {
  const inClient = /var VERSION = "([^"]+)"/u.exec(source)
  const inWindow = /export const VERSION = '([^']+)'/u.exec(windowSource)
  assert.ok(inClient !== null, 'the client must stamp a version')
  assert.ok(inWindow !== null, 'the host half must stamp a version')
  assert.equal(inClient[1], packageJson.version, 'client vs package.json')
  assert.equal(inWindow[1], packageJson.version, 'host half vs package.json')
})

  await check('makes exactly two registrations, once per slot', () => {
  assert.deepEqual(injections, ['conversation.input.left', 'shell.overlay'], 'injections: ' + injections.join(', '))
  assert.equal(cells.length, 2, 'expected two cells, got ' + cells.length)
})
//#endregion

//#region slot contract
  await check('puts the button in the composer tool row, left of the input', () => {
  const button = cells.find((cell) => cell.options.name === 'conversation.input.left')
  assert.ok(button !== undefined, 'the left slot must carry a cell')
  assert.equal(button.options.id, 'task-tracker', 'stable id: ' + button.options.id)
  assert.equal(button.options.order, 30, 'order before the permission and plan chips')
  assert.equal(button.options.locale, 'task-tracker', 'and the plugin locale')
  assert.equal(typeof button.component, 'function', 'the cell must render a component')
})

  await check('registers the frame-wide monitor in the overlay', () => {
  const monitor = cells.find((cell) => cell.options.name === 'shell.overlay')
  assert.ok(monitor !== undefined, 'the overlay must carry a cell')
  assert.equal(monitor.options.id, 'task-tracker-monitor', 'stable id: ' + monitor.options.id)
  assert.equal(typeof monitor.component, 'function', 'the monitor must be a component')
})

  await check('renders the trigger with a checklist glyph and a progress badge', () => {
  const todos = [
    { content: 'one', status: 'completed' },
    { content: 'two', status: 'in_progress' },
    { content: 'three', status: 'pending' },
  ]
  const node = renderCell('conversation.input.left', slotProps({
    useProjection: (key) => (key === 'todos' ? todos : undefined),
    useSessionStatus: (select) => select({ get: () => ({ running: true, pendingInteraction: null }) }),
  }))
  assert.equal(node.type, 'button', 'the cell renders a button')
  assert.equal(node.props.type, 'button', 'and it is a real button')
  assert.equal(node.props['data-dsh-task-tracker'], 'trigger', 'with the diagnostic hook')
  const flat = flatten(node)
  assert.ok(flat.some((item) => item.type === 'svg'), 'the glyph is a svg')
  const texts = textOf(node)
  assert.ok(texts.includes('1/3'), 'the badge shows done/total: ' + texts)
  assert.equal(typeof node.props.onClick, 'function', 'and it is clickable')
})

  await check('hands the newest snapshots to the one-second tick', () => {
  const todos = [{ content: 'one', status: 'completed' }]
  const sessions = { byId: { s1: { id: 's1', title: 'chat', cwd: 'C:\\p' } } }
  const status = { get: () => ({ running: true, pendingInteraction: null }) }
  const workspaces = { items: [], archivedSessionIds: [] }
  renderCell('conversation.input.left', slotProps({
    useProjection: (key) => (key === 'todos' ? todos : undefined),
    useSessionStatus: (select) => select(status),
  }))
  renderCell('shell.overlay', slotProps({
    useSessions: (select) => select(sessions),
    useSessionStatus: (select) => select(status),
    useWorkspaces: (select) => select(workspaces),
  }))
  const shared = bundle.__test.shared
  assert.equal(shared.currentSessionId, 's1', 'the current session id')
  assert.equal(shared.snapshots.projections.todos, todos, 'the todo projection')
  assert.equal(shared.snapshots.sessions, sessions, 'the sessions snapshot')
  assert.equal(shared.snapshots.status, status, 'the status snapshot')
  assert.equal(shared.snapshots.workspaces, workspaces, 'the workspaces snapshot')
})

  await check('keeps rendering when a source reports nothing yet', () => {
  // A page that just booted has empty snapshots: the cell must still draw, because
  // an entry that throws here is retired by the framework and never comes back.
  const node = renderCell('conversation.input.left', slotProps())
  assert.equal(node.type, 'button', 'the cell still renders a button')
  assert.equal(textOf(node), '', 'with no badge while there are no tasks: ' + textOf(node))
})

check('keeps the same hook order whether the data sources are there or not', () => {
  // React counts hooks per render: a cell that calls a hook on one render and skips
  // it on the next throws minified #310 and the framework then RETIRES the cell, so
  // the button disappears for good. This renders the same cell repeatedly and
  // compares the ledger of hook positions.
  //
  // Every shape below carries the six sources a shipped slot hands a cell, because
  // the cell now calls them directly: a slot that lacks one is a loud
  // `SlotAssemblyError` from the framework, not an undefined the cell could fall
  // back from. What this catches is a call sequence that depends on the DATA (a
  // memo keyed on a value that comes and goes, an early return in front of a hook),
  // and a real framework hook is recorded by name so a skipped position shows up.
  const todos = [{ content: 'one', status: 'completed' }]
  const status = { get: () => ({ running: true, pendingInteraction: null }) }
  // Every shape below carries the same six sources a shipped slot hands a cell,
  // with the data varying — that is what a real page does. The recorder names the
  // framework hook, so the ledger shows the call positions the cell used.
  const shape = (overrides = {}) => ({
    sessionId: 's1',
    useProjection: (key) => (key === 'todos' ? todos : undefined),
    useSessionStatus: (select) => { harness.record('framework-status'); return select(status) },
    useSessions: (select) => { harness.record('framework-sessions'); return select({ byId: {} }) },
    useWorkspaces: (select) => { harness.record('framework-workspaces'); return select({ items: [] }) },
    ...overrides,
  })
  const before = harness.hookSignatures.length
  harness.renderCellTracked('conversation.input.left', shape())
  harness.renderCellTracked('conversation.input.left', shape({ sessionId: 'other', useProjection: () => undefined }))
  harness.renderCellTracked('conversation.input.left', shape({ useSessionStatus: (select) => { harness.record('framework-status'); return select({ get: () => undefined }) } }))
  harness.renderCellTracked('conversation.input.left', shape())
  harness.renderCellTracked('shell.overlay', shape())
  harness.renderCellTracked('shell.overlay', shape({ useSessions: (select) => { harness.record('framework-sessions'); return select({ byId: { a: { id: 'a', cwd: 'C:\\p' } } }) } }))
  const seen = harness.hookSignatures.slice(before)
  const uniqueButton = [...new Set(seen.slice(0, 4))]
  const uniqueMonitor = [...new Set(seen.slice(4))]
  assert.equal(uniqueButton.length, 1, 'the composer cell must call one fixed hook sequence, got:\n  ' + uniqueButton.join('\n  '))
  assert.equal(uniqueMonitor.length, 1, 'the overlay cell must call one fixed hook sequence, got:\n  ' + uniqueMonitor.join('\n  '))
  assert.ok(uniqueButton[0].includes('framework-status'), 'the ledger must include the framework status hook: ' + uniqueButton[0])
  assert.ok(uniqueButton[0].includes('useEffect'), 'and the diagnostic effect')
  // The other half of the same rule: the sequence must not depend on the data
  // either. A `useMemo` keyed on a value that appears and disappears, or an early
  // return in front of a hook, would show up here as two different sequences.
  const dataShapes = [
    shape(),
    shape({ useProjection: (key) => (key === 'todos' ? [] : undefined) }),
    shape({ useProjection: () => ({ total: 0 }) }),
    shape(),
  ]
  const dataSignatures = []
  for (const props of dataShapes) {
    harness.hookSignatures.length = 0
    harness.renderCellTracked('conversation.input.left', props)
    dataSignatures.push(harness.hookSignatures[0])
  }
  assert.equal(new Set(dataSignatures).size, 1, 'the sequence must not depend on the data, got:\n  ' + [...new Set(dataSignatures)].join('\n  '))
  assert.equal(dataSignatures[0], uniqueButton[0], 'and it must equal the sequence measured above')
})
//#endregion

//#region view model
  await check('groups workspaces and sums tokens with a cache rate', () => {
  const sessions = {
    byId: {
      a: { id: 'a', title: 'a', cwd: 'C:\\one', projectionValues: { tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 100 } } },
      b: { id: 'b', title: 'b', cwd: 'C:\\one', projectionValues: { tokenUsage: { uncachedInputTokens: 500, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 0 } } },
      c: { id: 'c', title: 'c', cwd: 'C:\\two' },
      child: { id: 'child', title: 'child', cwd: 'C:\\one', parentId: 'a' },
      blank: { id: 'blank', title: 'blank', cwd: 'C:\\one', blank: true },
    },
  }
  const status = { get: (id) => ({ running: id === 'a', pendingInteraction: null }) }
  const collected = bundle.__test.collect(sessions, status, { items: [], archivedSessionIds: [] })
  assert.equal(collected.projects.length, 2, 'two projects: ' + collected.projects.map((project) => project.name).join(', '))
  assert.equal(collected.projects[0].name, 'one', 'the busiest project sorts first')
  assert.equal(collected.projects[0].entries.length, 2, 'the child and the blank session are hidden')
  assert.equal(collected.projects[0].running, 1, 'running sessions are counted')
  const usage = bundle.__test.sumUsage([sessions.byId.a, sessions.byId.b])
  assert.equal(usage.tokens, 2100, 'tokens are summed: ' + usage.tokens)
  assert.equal(usage.hit.toFixed(1), '70.0', 'cache hit uses cached / billed input')
  assert.equal(usage.input, 2000, 'billed input excludes output')
})

  await check('hides child agents and blank shells', () => {
  assert.equal(bundle.__test.isHidden({ id: 'x', parentId: 'p' }), true, 'a parent id hides')
  assert.equal(bundle.__test.isHidden({ id: 'x', parentSessionId: 'p' }), true, 'a parent session id hides')
  assert.equal(bundle.__test.isHidden({ id: 'x', origin: 'subagent' }), true, 'a subagent origin hides')
  assert.equal(bundle.__test.isHidden({ id: 'x', blank: true }), true, 'a blank session hides')
  assert.equal(bundle.__test.isHidden({ id: 'x' }), false, 'a plain session stays')
})

  await check('builds all three navigation levels', () => {
  const sessions = {
    byId: {
      a: { id: 'a', title: 'first', cwd: 'C:\\one', updatedAt: 2 },
      b: { id: 'b', title: 'second', cwd: 'C:\\one', updatedAt: 1 },
    },
  }
  const collected = bundle.__test.collect(sessions, undefined, { items: [], archivedSessionIds: [] })
  const test = bundle.__test
  test.navigate({ level: 'projects' })
  const projects = test.composeView(collected, 'a', {})
  assert.equal(projects.compact.rows.length, 1, 'one project row')
  assert.equal(projects.mode, 'list', 'the root level is the list')
  assert.equal(projects.compact.back, false, 'the root level has no back button')
  test.navigate(projects.compact.rows[0].target)
  const list = test.composeView(collected, 'a', {})
  assert.equal(list.compact.rows.length, 2, 'both sessions listed')
  assert.equal(list.compact.back, true, 'the session level goes back')
  const second = list.compact.rows.find((row) => row.target.sessionId === 'b')
  assert.ok(second !== undefined, 'the second session is listed')
  test.navigate(second.target)
  const detail = test.composeView(collected, 'b', {})
  assert.equal(detail.mode, 'detail', 'the third level is the detail')
  // The header names the SESSION that was opened; the project it belongs to is the
  // level you came from, and the `‹ 返回` target still points at it.
  assert.equal(detail.header.title, 'second', 'the detail names its session: ' + detail.header.title)
  assert.equal(detail.header.subtitle, '当前状态', 'with the section as the sub-line')
  const state = detail.sections.find((section) => section.key === 'state')
  assert.equal(state.rows.length, 1, 'one state row, not three: ' + JSON.stringify(state.rows))
  assert.equal(state.rows[0].name, 'second', 'and it is the session row')
  test.goBack()
  assert.equal(test.shared.nav.level, 'sessions', 'back returns one level')
  test.navigate({ level: 'projects' })
})

  await check('never shows the open session\'s numbers under another session', () => {
  // The projections (todos, tokenUsage, sessionStats) belong to the session the PAGE
  // has open. Opening another project's conversation must not print the open one's
  // task list and token box under its name — that was the "换一个项目点进去还是当前
  // 对话的详情" complaint.
  // The two sessions carry their own row-level token figures, which is exactly what a
  // real session list provides (`projectionValues.tokenUsage`).
  const sessions = {
    byId: {
      mine: { id: 'mine', title: 'my session', cwd: 'C:\\p' },
      other: {
        id: 'other',
        title: 'another session',
        cwd: 'C:\\q',
        projectionValues: { tokenUsage: { uncachedInputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 20 } },
      },
    },
  }
  const collected = bundle.__test.collect(sessions, undefined, { items: [], archivedSessionIds: [] })
  const detail = {
    todos: [{ content: 'a task of MY session', status: 'completed' }],
    // Deliberately different magnitudes, and a different cache rate, so a borrowed value
    // is unmistakable.
    tokenUsage: { uncachedInputTokens: 1500000, cacheReadTokens: 13500000, cacheWriteTokens: 0, outputTokens: 1000 },
    sessionStats: { turn: 7, steps: 318 },
  }
  const test = bundle.__test
  test.shared.currentSessionId = 'mine'

  // The session this page has open: full detail, progress line included.
  test.navigate({ level: 'session', cwd: 'C:\\p', sessionId: 'mine' })
  const own = test.composeView(collected, 'mine', detail)
  assert.equal(own.progress.text, '1/1 已完成', 'the open session states its own progress: ' + own.progress.text)
  assert.equal(own.progress.percent, 100, 'and its percentage')
  assert.ok(own.sections.some((section) => section.key === 'todos'), 'the open session shows its task list')
  assert.ok(own.sections.some((section) => section.key === 'tokens'), 'and its token box')
  assert.ok(!own.sections.some((section) => section.key === 'note'), 'with no note')

  // Another project's session: its own name and volume, and no borrowed numbers.
  test.navigate({ level: 'session', cwd: 'C:\\q', sessionId: 'other' })
  const visited = test.composeView(collected, 'other', detail)
  assert.equal(visited.header.title, 'another session', 'the header names the visited session')
  assert.ok(!visited.sections.some((section) => section.key === 'todos'), 'no borrowed task list')
  // The progress line is the SAME projection as the task list, so withholding the list
  // while still printing "1/1 已完成" would leak the open session's count anyway — which
  // is exactly the report: another project's detail showed THIS conversation's "7/7".
  assert.ok(
    !visited.progress.text.includes('已完成') || visited.progress.text.includes('只在'),
    'the progress line must not state another conversation\'s todo count: ' + visited.progress.text,
  )
  assert.equal(visited.progress.text, '任务清单只在打开该会话时可见', 'it says why instead: ' + visited.progress.text)
  assert.equal(visited.progress.percent, 0, 'and claims no percentage')
  assert.equal(visited.progress.detail, '', 'with no in-progress or pending counts either')
  // The token section stays — but it must show the VISITED session's own figures, never
  // the open session's. Printing the open session's numbers here was the
  // "别的会话显示的还是本对话的" bug: those projections simply do not exist for another
  // session, so the session row's own volume is what may be shown.
  const visitedTokens = visited.sections.find((section) => section.key === 'tokens')
  assert.ok(visitedTokens !== undefined, 'the visited session still gets a token section')
  const totals = visitedTokens.rows.find((row) => row.name === '总量')
  assert.ok(totals.meta.includes('本会话'), 'labelled as that session\'s own: ' + totals.meta)
  const openTotal = bundle.__test.tokenText(detail.tokenUsage.uncachedInputTokens + detail.tokenUsage.cacheReadTokens + detail.tokenUsage.outputTokens)
  assert.ok(!totals.meta.includes(openTotal), 'and it is not the open session\'s ' + openTotal + ': ' + totals.meta)
  const hit = visitedTokens.rows.find((row) => row.name === '缓存命中')
  assert.notEqual(hit.meta, '90.0%', 'the cache rate is not the open session\'s (90.0%): ' + hit.meta)
  const note = visited.sections.find((section) => section.key === 'note')
  assert.ok(note !== undefined, 'a note explains why')
  assert.equal(note.rows[0].note, true, 'and it is marked as a note, not a status row')
  const state = visited.sections.find((section) => section.key === 'state')
  assert.equal(state.rows.length, 1, 'the visited session keeps its own row')
  assert.equal(state.rows[0].name, 'another session', 'named correctly')
  // The snapshot carries where the pane's navigation landed, so a click's effect is
  // checkable from outside the app (`/state.debug`).
  assert.equal(visited.debug.level, 'session', 'the snapshot reports its level')
  assert.equal(visited.debug.sessionId, 'other', 'and the session it resolved to')
  assert.equal(visited.debug.title, 'another session', 'and the title it drew')
  test.navigate({ level: 'projects' })
  test.shared.currentSessionId = undefined
})

  await check('carries the schema the host window page renders', () => {
  const collected = bundle.__test.collect({ byId: {} }, undefined, { items: [], archivedSessionIds: [] })
  const view = bundle.__test.composeView(collected, undefined, {})
  // These are exactly the fields window.js reads; a missing one renders an empty box.
  for (const key of ['theme', 'header', 'progress', 'compact', 'sections', 'footer', 'mode']) {
    assert.ok(view[key] !== undefined, 'the view must carry ' + key)
  }
  assert.equal(typeof view.header.title, 'string', 'header.title')
  assert.equal(typeof view.progress.percent, 'number', 'progress.percent')
  assert.ok(Array.isArray(view.compact.rows), 'compact.rows')
  assert.ok(Array.isArray(view.sections), 'sections')
  for (const key of ['base', 'panel', 'fg', 'muted', 'border', 'hover', 'accent', 'success', 'danger', 'warn']) {
    assert.ok(typeof view.theme[key] === 'string' && view.theme[key] !== '', 'theme.' + key)
  }
  assert.equal(typeof view.theme.dark, 'boolean', 'theme.dark')
})

  await check('composites a translucent app palette onto opaque colours', () => {
  const test = bundle.__test
  // The app's own menu fill is the colour that made the panel see-through.
  assert.equal(test.blend('#f8f9fa94', '#1d1d20', '#000000'), '#9c9d9f', 'a 58% light fill over a dark base stays opaque')
  assert.equal(test.blend('rgba(0,0,0,0.5)', '#ffffff', '#000000'), '#808080', 'and so does a half-transparent black')
  assert.equal(test.blend('nonsense', '#ffffff', '#123456'), '#123456', 'an unusable value falls back')
  const palette = test.paletteOf(undefined)
  // The surfaces the panel paints must be opaque: a translucent one lets the app
  // show through, which is the bug this palette exists to prevent.
  for (const key of ['base', 'panel', 'fg', 'muted', 'accent', 'success', 'danger', 'warn']) {
    assert.ok(/^#[0-9a-f]{6}$/iu.test(palette[key]), key + ' must be an opaque hex colour, got ' + palette[key])
  }
})

  await check('composes todos, token usage and the run state into sections', () => {
  const sessions = { byId: { s1: { id: 's1', title: 'the session', cwd: 'C:\\p' } } }
  const collected = bundle.__test.collect(sessions, { get: () => ({ running: true, pendingInteraction: null }) }, { items: [], archivedSessionIds: [] })
  // The detail sections exist on the session level only, and only for the session the
  // page has open: the projections are session-scoped, so this has to name it.
  bundle.__test.shared.currentSessionId = 's1'
  bundle.__test.navigate({ level: 'session', cwd: 'C:\\p', sessionId: 's1' })
  const view = bundle.__test.composeView(collected, 's1', {
    todos: [
      { content: 'write it', status: 'completed' },
      { content: 'test it', status: 'in_progress' },
    ],
    tokenUsage: { uncachedInputTokens: 1000, cacheReadTokens: 3000, cacheWriteTokens: 0, outputTokens: 500 },
    sessionStats: { turn: 7, steps: 318 },
  })
  const keys = view.sections.map((section) => section.key)
  assert.ok(keys.includes('todos'), 'a todo section: ' + keys.join(', '))
  assert.ok(keys.includes('tokens'), 'a token section')
  assert.equal(view.progress.text, '1/2 已完成', 'the progress text: ' + view.progress.text)
  assert.equal(view.progress.percent, 50, 'the progress percent')
  const todo = view.sections.find((section) => section.key === 'todos')
  assert.equal(todo.rows.length, 2, 'one row per task')
  assert.equal(todo.rows[0].status, 'completed', 'the task keeps its status')
  assert.equal(todo.rows[0].done, true, 'and the done flag the window strikes through')
  const state = view.sections.find((section) => section.key === 'state')
  assert.ok(state.rows.some((row) => row.status === 'running'), 'the run state is reported')
  assert.ok(state.rows.some((row) => String(row.meta).includes('318')), 'and so are the session stats')
  const tokens = view.sections.find((section) => section.key === 'tokens')
  assert.ok(tokens.rows.some((row) => row.meta === '75.0%'), 'the cache rate is exact: ' + tokens.rows.map((row) => row.meta).join(' | '))
})

  await check('opens the app window on the marker URL the shell allows', () => {
  const node = renderCell('conversation.input.left', slotProps({
    useSessionStatus: (select) => select({ get: () => ({ running: false, pendingInteraction: null }) }),
  }))
  node.props.onClick()
  assert.equal(opened.length, 1, 'one window was requested')
  assert.equal(opened[0].url, 'about:blank#dsh-task-tracker', 'the marker URL: ' + opened[0].url)
  assert.equal(opened[0].name, 'dsh-task-tracker-window', 'with a stable window name')
})
//#endregion

//#region feeds
  await check('pushes the composed view to the host service', async () => {
  const shared = bundle.__test.shared
  bundle.__test.navigate({ level: 'projects' })
  shared.windowOpen = true
  const before = requests.length
  await tickOnce()
  const posted = requests.slice(before).filter((request) => request.url.endsWith('/state'))
  assert.equal(posted.length, 1, 'exactly one state push per tick')
  const body = JSON.parse(String(posted[0].init.body))
  assert.equal(body.mode, 'list', 'the pushed view carries the mode')
  assert.ok(body.theme !== undefined && body.compact !== undefined, 'and the window schema')
  // The window cannot open without this feed: the host page polls /state and shows
  // "waiting for state" forever when nothing was ever pushed.
  shared.windowOpen = false
})

  await check('announces a finished run once, and never a child or a blank session', async () => {
  const test = bundle.__test
  const shared = test.shared
  shared.notified = {}
  shared.phase = {}
  shared.running = {}
  const status = { get: () => ({ running: true, pendingInteraction: null }) }
  const running = {
    byId: { s1: { id: 's1', title: 'the session', cwd: 'C:\\p' } },
  }
  const before = requests.length
  feedSnapshots(running, status)
  await tickOnce()
  assert.equal(requests.slice(before).filter((request) => request.url.endsWith('/notify')).length, 0, 'a running session is not announced')

  const done = { get: () => ({ running: false, pendingInteraction: null }) }
  feedSnapshots(running, done)
  const mark = requests.length
  await tickOnce()
  const notices = requests.slice(mark).filter((request) => request.url.endsWith('/notify'))
  assert.equal(notices.length, 1, 'a finished run announces once')
  assert.equal(JSON.parse(String(notices[0].init.body)).title, '任务已完成', 'with the task state as the title')
  await tickOnce()
  assert.equal(requests.slice(mark).filter((request) => request.url.endsWith('/notify')).length, 1, 'and not again on the next tick')

  // A child agent finishing must stay silent: one `task` tool can spawn dozens.
  const children = { byId: { c1: { id: 'c1', title: 'child', cwd: 'C:\\p', parentId: 's1' } } }
  const watching = { get: () => ({ running: true, pendingInteraction: null }) }
  feedSnapshots(children, watching)
  await tickOnce()
  const childMark = requests.length
  feedSnapshots(children, { get: () => ({ running: false, pendingInteraction: null }) })
  await tickOnce()
  assert.equal(requests.slice(childMark).filter((request) => request.url.endsWith('/notify')).length, 0, 'a child session is never announced')

  // A blank session must stay silent for the same reason.
  const blanks = { byId: { b1: { id: 'b1', title: 'blank', cwd: 'C:\\p', blank: true } } }
  feedSnapshots(blanks, watching)
  await tickOnce()
  const blankMark = requests.length
  feedSnapshots(blanks, done)
  await tickOnce()
  assert.equal(requests.slice(blankMark).filter((request) => request.url.endsWith('/notify')).length, 0, 'a blank session is never announced')
})

  await check('announces a moment that waits for the user exactly once', async () => {
  // The prompt is re-published while the user is deciding, so a time-based cooldown let
  // a toast out on every re-publish ("提示一直弹"). The dedupe key is the interaction's
  // OWN key instead, and it is forgotten only when the interaction is answered.
  const shared = bundle.__test.shared
  resetNotifications()
  const sessions = { byId: { s2: { id: 's2', title: 'the session', cwd: 'C:\\p' } } }
  const question = { key: 'ask-1', kind: 'question' }
  feedSnapshots(sessions, { get: () => ({ running: true, pendingInteraction: question }) })
  const mark = requests.length
  await tickOnce()
  assert.equal(noticesSince(mark).length, 1, 'a question announces once')
  const notices = noticesSince(mark)
  assert.equal(JSON.parse(String(notices[0].init.body)).title, '需要你的选择', 'with the waiting title')

  // Same interaction, more ticks, and a re-published copy of it with different wording:
  // still nothing new.
  await tickOnce()
  await tickOnce()
  feedSnapshots(sessions, { get: () => ({ running: true, pendingInteraction: { key: 'ask-1', kind: 'question', title: 'rephrased' } }) })
  await tickOnce()
  assert.equal(noticesSince(mark).length, 1, 're-publishing the same interaction is silent')

  // A DIFFERENT interaction (the user answered the first one, then another appeared):
  // that is a new moment and must announce.
  feedSnapshots(sessions, { get: () => ({ running: true, pendingInteraction: null }) })
  await tickOnce()
  feedSnapshots(sessions, { get: () => ({ running: true, pendingInteraction: { key: 'ask-2', kind: 'approval' } }) })
  await tickOnce()
  assert.equal(noticesSince(mark).length, 2, 'a new interaction announces again')
})

  await check('stays silent when the user stopped the run, and says why', async () => {
  // "中断改为不弹，只有跑完一个任务才弹." The page cannot tell the two apart — its
  // session status is `{ running, pendingInteraction, completionUnread }` — so the
  // reason is read from the session log by the host. A stop the user asked for must
  // produce NO toast, and must still be visible in the diagnostics as a silence.
  resetNotifications()
  const test = bundle.__test
  const sessions = { byId: { s4: { id: 's4', title: 'the session', cwd: 'C:\\p' } } }
  const idle = { get: () => ({ running: false, pendingInteraction: null }) }
  feedSnapshots(sessions, { get: () => ({ running: true, pendingInteraction: null }) })
  await tickOnce()
  const mark = requests.length
  harness.setTurnEndReason('aborted')
  feedSnapshots(sessions, idle)
  await tickOnce()
  assert.equal(noticesSince(mark).length, 0, 'an interrupted run is not announced')
  const asked = requests.slice(mark).filter((request) => request.url.endsWith('/turn'))
  assert.equal(asked.length, 1, 'the reason is asked for exactly once: ' + asked.length)
  assert.equal(JSON.parse(String(asked[0].init.body)).sessionId, 's4', 'naming the session that ended')
  const newest = test.shared.notificationLog[test.shared.notificationLog.length - 1]
  assert.equal(newest.kind, 'turn-end', 'the silence is logged')
  assert.equal(newest.reason, 'aborted', 'with the reason that caused it')
  assert.equal(newest.notified, false, 'and the fact that nothing was shown')
})

  await check('words an error as a failure and an unfinished run as unfinished', async () => {
  // Only three endings deserve a toast, and they do not deserve the same words: a
  // failed run is not a finished one, and neither is a run that stopped early
  // (`max-tokens` happens: it is in this machine's logs).
  resetNotifications()
  const sessions = { byId: { s5: { id: 's5', title: 'the session', cwd: 'C:\\p' } } }
  const running = { get: () => ({ running: true, pendingInteraction: null }) }
  const idle = { get: () => ({ running: false, pendingInteraction: null }) }
  const titleFor = async (reason) => {
    feedSnapshots(sessions, running)
    await tickOnce()
    const mark = requests.length
    harness.setTurnEndReason(reason)
    feedSnapshots(sessions, idle)
    await tickOnce()
    const notices = noticesSince(mark)
    return notices.length === 0 ? undefined : JSON.parse(String(notices[0].init.body)).title
  }
  assert.equal(await titleFor('completed'), '任务已完成', 'a finished run says so')
  assert.equal(await titleFor('error'), '任务失败', 'a failed run says so')
  assert.equal(await titleFor('max-tokens'), '任务未跑完', 'a run that stopped early says so')
  // The host not being able to tell must NOT swallow the notification: losing a real
  // completion is the worse failure, and it is the bug this plugin was reported for.
  assert.equal(await titleFor(undefined), '任务已完成', 'an unknown reason still announces')
  harness.setTurnEndReason('completed')
})

  await check('never announces a completion twice for one run', async () => {
  resetNotifications()
  const sessions = { byId: { s3: { id: 's3', title: 'the session', cwd: 'C:\\p' } } }
  feedSnapshots(sessions, { get: () => ({ running: true, pendingInteraction: null }) })
  await tickOnce()
  const mark = requests.length
  const idle = { get: () => ({ running: false, pendingInteraction: null }) }
  feedSnapshots(sessions, idle)
  await tickOnce()
  assert.equal(noticesSince(mark).length, 1, 'the finish announces once')
  // Keep ticking while idle: a stale mark must not replay just because time passed.
  for (let index = 0; index < 3; index += 1) await tickOnce()
  assert.equal(noticesSince(mark).length, 1, 'staying idle is silent')
})

  await check('shows how long a run has been going, and how long the last one took', async () => {
  // "任务运行时间". `running` is a boolean and says nothing about when the run began, so
  // the reading comes from a run record watched here plus the session log's own
  // `turn/start`. The distinction that matters is `certain`: a stopwatch quietly started
  // when the page first noticed would report a ten-minute run as "3 秒".
  const test = bundle.__test
  assert.equal(test.durationText(0), '0 秒', 'zero')
  assert.equal(test.durationText(4500), '4 秒', 'seconds are floored, not rounded up')
  assert.equal(test.durationText(83000), '1 分 23 秒', 'minutes and seconds')
  assert.equal(test.durationText(3600000 + 5 * 60000 + 9000), '1 小时 5 分', 'seconds drop past an hour')

  const running = (id) => ({ id: id, running: true, title: 'a session' })
  const idle = (id) => ({ id: id, running: false, title: 'a session' })

  // A run this page watched begin, and then watched end.
  test.shared.runs = {}
  test.trackRun(idle('s1'), 1000000)
  test.trackRun(running('s1'), 1001000)
  assert.equal(test.runText(running('s1'), 1013000), '已运行 12 秒', 'a watched run needs no qualifier')
  test.trackRun(idle('s1'), 1060000)
  assert.equal(test.runText(idle('s1'), 9999999), '上次运行 59 秒', 'and it freezes once the run is over')

  // A run that was already in flight the first time this page looked at the session.
  test.shared.runs = {}
  test.trackRun(running('s2'), 1000000)
  assert.equal(test.runText(running('s2'), 1012000), '已运行 ≥12 秒', 'an unwatched run is qualified')

  // …until the session log answers with the real start, which is the log's number.
  harness.setTurnStart(990000)
  test.shared.runs = {}
  test.trackRun(running('s3'), 1000000)
  await settle()
  assert.equal(test.runText(running('s3'), 1012000), '已运行 22 秒', 'the log start replaces first sighting')
  harness.setTurnStart(undefined)

  // It reaches the line the user reads, in the 当前状态 section, next to 运行中.
  const sessions = {
    byId: {
      mine: { id: 'mine', title: 'my session', cwd: 'C:\\p' },
      other: { id: 'other', title: 'another session', cwd: 'C:\\p' },
    },
  }
  const status = { get: () => ({ running: true, pendingInteraction: null }) }
  const collected = test.collect(sessions, status, { items: [], archivedSessionIds: [] })
  test.shared.currentSessionId = 'mine'
  test.shared.runs = {
    mine: { start: Date.now() - 12000, certain: true, end: undefined },
    other: { start: Date.now() - 5000, certain: true, end: undefined },
  }
  test.navigate({ level: 'session', cwd: 'C:\\p', sessionId: 'mine' })
  const own = test.composeView(collected, 'mine', {})
  const ownState = own.sections.find((section) => section.key === 'state')
  assert.match(ownState.rows[0].meta, /^运行中 · 已运行 \d+ 秒$/u, 'the reading sits next to the run state: ' + ownState.rows[0].meta)
  // Another session's detail shows it too: this part is known for every session, not
  // only for the one this page has open (the projections are not).
  test.navigate({ level: 'session', cwd: 'C:\\p', sessionId: 'other' })
  const visited = test.composeView(collected, 'other', {})
  const visitedState = visited.sections.find((section) => section.key === 'state')
  assert.match(visitedState.rows[0].meta, /^运行中 · 已运行 \d+ 秒$/u, 'and for a session this page has not opened: ' + visitedState.rows[0].meta)
  test.shared.runs = {}
  test.navigate({ level: 'projects' })
})

  await check('uses the browser channel when the host could not show the toast', async () => {
  // "The host answered" is not "the toast went out": `/notify` reports that in its body
  // while answering 200 either way, and the native toast is Windows-only by design. A
  // client that read the 200 as delivery would leave every macOS and Linux install with
  // no notification at all — the browser API is the only channel there.
  resetNotifications()
  const test = bundle.__test
  test.closeWindow()
  harness.setTurnStart(undefined)
  harness.setTurnEndReason('completed')
  const sessions = { byId: { s6: { id: 's6', title: 'the session', cwd: 'C:\\p' } } }
  const running = { get: () => ({ running: true, pendingInteraction: null }) }
  const idle = { get: () => ({ running: false, pendingInteraction: null }) }

  harness.setNotifyDelivers(false)
  harness.notifications.length = 0
  feedSnapshots(sessions, running)
  await tickOnce()
  feedSnapshots(sessions, idle)
  await tickOnce()
  assert.equal(harness.notifications.length, 1, 'the browser channel is used: ' + harness.notifications.length)
  const refused = test.shared.notificationLog[test.shared.notificationLog.length - 1]
  assert.equal(refused.channel, 'browser', 'and recorded as the channel that carried it')
  assert.equal(refused.delivered, false, 'with delivery reported honestly')

  // When the host DOES show it, the browser channel stays out of it.
  harness.setNotifyDelivers(true)
  harness.notifications.length = 0
  feedSnapshots(sessions, running)
  await tickOnce()
  feedSnapshots(sessions, idle)
  await tickOnce()
  assert.equal(harness.notifications.length, 0, 'a delivered toast is not repeated through the browser')
  const shown = test.shared.notificationLog[test.shared.notificationLog.length - 1]
  assert.equal(shown.channel, 'host', 'the host channel is recorded')
  assert.equal(shown.delivered, true, 'as delivered')
})

  await check('runs a heartbeat and a one-second tick', async () => {
  const intervalsMs = intervals.map((interval) => interval.ms)
  assert.ok(intervalsMs.includes(1000), 'the tick interval is one second: ' + intervalsMs.join(', '))
  assert.ok(requests.some((request) => request.url.endsWith('/health')), 'the heartbeat reports to /health')
  assert.ok(requests.some((request) => request.url.endsWith('/ping')), 'and the tick polls the host window navigation')
})
//#endregion

  await check('draws the window page without a close button, keeps the scroll offset, and shows notes as notes', async () => {
  // The host window page is a plain script in a string, and the host half cannot be
  // hot-reloaded, so it gets its own gate: run the real page script against a stub
  // document and assert what it draws.
  const page = harness.renderWindowPage()
  const view = {
    version: '0.1.1',
    updatedAt: new Date().toISOString(),
    mode: 'detail',
    theme: { base: '#101014', panel: '#17171c', fg: '#ececf1', muted: '#9a9aa2', border: '#33333c', hover: '#22222a', accent: '#4d6bfe', success: '#2aa96b', danger: '#e5534b', warn: '#d29922', dark: true },
    header: { title: 'my session', subtitle: '当前状态' },
    progress: { label: '进度', text: '1/2 已完成', percent: 50, detail: '进行中 1' },
    compact: { title: 'example-project', hint: '', back: true, rows: [] },
    sections: [
      { key: 'state', title: '当前状态', empty: '', rows: [{ name: 'my session', meta: '运行中 · 1.2万 tokens', status: 'running' }] },
      { key: 'note', title: '', empty: '', rows: [{ name: '这个会话没在本页打开…', meta: '', status: 'idle', note: true }] },
      { key: 'todos', title: '任务', empty: '暂无任务', rows: [{ name: 'a task', meta: '已完成', status: 'completed', done: true }] },
    ],
    footer: 'dsh-task-tracker 0.1.1',
  }
  page.render({ view })
  const tree = page.root
  assert.ok(tree.querySelector('[data-close]') === null, 'the page draws no close button')
  assert.ok(tree.querySelector('[data-navback]') !== null, 'but it does draw the back button')
  assert.ok(tree.querySelector('[data-scroll]') !== null, 'and a scrollable body to keep the offset on')
  const note = tree.querySelector('.empty')
  assert.ok(note !== null && String(note.textContent).includes('这个会话没在本页打开'), 'the note renders as text: ' + (note && note.textContent))
  // The scroll offset has to survive the next poll: this is the "滚到下面自动回到最顶" bug.
  const body = tree.querySelector('[data-scroll]')
  body.scrollTop = 240
  page.render({ view: { ...view, updatedAt: new Date().toISOString() } })
  const next = tree.querySelector('[data-scroll]')
  assert.equal(next.scrollTop, 240, 'the rebuild restores the scroll offset')
  // The progress bar is a hairline plus figures — the detail mode draws NO boxed card.
  const framed = tree.walk().filter((node) => node.className === 'sumrow')
  assert.equal(framed.length, 0, 'the old progress block is gone')
})

  await check('treats a white border token as no stroke at all', () => {
  // The live app's own tokens are the reason the pane had white separator lines:
  // `--dsw-alias-border-l1` and `--dsw-alias-interactive-bg-hover` both resolve to
  // `#ffffff` there. A stroke that is indistinguishable from the background must be
  // replaced by a low-alpha neutral of the opposite tone, not painted as it is.
  const test = bundle.__test
  const darkBase = '#1d1d20'
  const border = test.solid('#ffffff', darkBase, 0.14)
  assert.ok(border.startsWith('rgba(255,255,255,'), 'a white stroke over a dark base becomes a faint light line: ' + border)
  const group = test.solid('#ffffff', darkBase, 0.045)
  assert.equal(group, 'rgba(255,255,255,0.045)', 'and the group surface stays barely there: ' + group)
  // A stroke that IS distinguishable keeps its colour.
  assert.equal(test.solid('#4d6bfe', darkBase, 0.14), '#4d6bfe', 'a real accent stroke survives')
  const palette = test.paletteOf(undefined)
  assert.ok(!/^#ffffff$/iu.test(palette.border) && !/^#ffffff$/iu.test(palette.group), 'the fallback palette keeps white out of both')
})

  await check('draws the in-app panel with a close button only when asked, and no hairlines', () => {
  // The panel is the only surface with no system title bar, so it is the only one that
  // draws a close control; the host page and the app popup must not add a second one.
  const doc = fakeDocument()
  const view = panelView()
  const closable = harness.bundle.__test.buildPanel(view, doc, { closable: true })
  const plain = harness.bundle.__test.buildPanel(view, doc, { closable: false })
  assert.ok(domText(closable).includes('关闭'), 'the panel draws its close button: ' + domText(closable).join('|'))
  assert.ok(!domText(plain).includes('关闭'), 'the popup and the host page draw none: ' + domText(plain).join('|'))
  // The rows belong to one transparent group: no per-ROW separator. The pane footer's
  // top edge is the only horizontal rule left in the panel.
  const flat = closable.walk()
  const bordered = flat.filter((node) => node.style?.borderTop === '1px solid ' + view.theme.border)
  assert.equal(bordered.length, 1, 'only the footer carries a rule, got ' + bordered.length)
  const groups = flat.filter((node) => node.style?.flexDirection === 'column' && typeof node.style?.background === 'string' && node.style.background !== '')
  assert.ok(groups.length > 0, 'the values are wrapped in a group container')
})

  await check('toggles the pane instead of stacking a blank window per click', () => {
  // `window.open(url, "same-name")` returns a NEW blank window for a name that already
  // exists, so opening on every click left one empty frame per click — and the user was
  // left looking at the fallback panel while those stacked behind it.
  const test = harness.bundle.__test
  test.closeWindow()
  opened.length = 0
  const first = test.toggleWindow()
  assert.equal(first, true, 'the first call opens')
  assert.equal(opened.length, 1, 'and requests exactly one window')
  const popup = opened[0].window
  const second = test.toggleWindow()
  assert.equal(second, false, 'the second call closes')
  assert.equal(opened.length, 1, 'without requesting another one')
  assert.equal(popup.closed, true, 'and it really closed the window it opened')
  const third = test.toggleWindow()
  assert.equal(third, true, 'and a third call opens again')
  assert.equal(opened.length, 2, 'one request per open')
  // Opening starts at the project list, whatever the pane was showing before: the
  // window says it opens as the two-level monitor, and reopening onto an old
  // conversation's detail is what "点进去显示的不是该项目的详情" described.
  test.navigate({ level: 'session', cwd: 'C:\\q', sessionId: 's9' })
  test.closeWindow()
  test.toggleWindow()
  assert.equal(test.shared.nav.level, 'projects', 'a reopened pane starts at the project list')
  assert.equal(test.shared.nav.sessionId, undefined, 'with no session carried over')
  test.closeWindow()
})

  await check('applies a navigation request that came back from the pane', async () => {
  // The pane has no plugin context: a click there travels to the host as `POST /nav`,
  // and the client picks it up from `/ping.nav` on its next tick. Nothing else moves
  // the pane, so this path has to work — it is how "点别的项目" reaches the detail view.
  resetNotifications()
  const test = harness.bundle.__test
  test.closeWindow()
  test.shared.currentSessionId = undefined
  feedSnapshots({ byId: { s9: { id: 's9', title: 'elsewhere', cwd: 'C:\\q' } } }, undefined)
  test.navigate({ level: 'projects' })
  await tickOnce()
  assert.equal(test.shared.nav.level, 'projects', 'the tick starts at the project list')

  // Now answer the next poll with a nav request, exactly as the host serves it.
  harness.setNavReply({ nav: { target: { level: 'session', cwd: 'C:\\q', sessionId: 's9' } }, navAt: 'stamp-1' })
  await tickOnce()
  assert.equal(test.shared.nav.level, 'session', 'the request moves the pane down a level')
  assert.equal(test.shared.nav.sessionId, 's9', 'to the session that was clicked')
  if (process.env.DSH_DEBUG === '1') {
    console.log('      [debug] nav=' + JSON.stringify(test.shared.nav) + ' rows=' + JSON.stringify(test.shared.state?.collected?.rows?.map((entry) => entry.id)) + ' title=' + test.shared.view.header.title)
  }
  assert.equal(test.shared.view.header.title, 'elsewhere', 'and the view names it')

  // The same request must not be applied twice (the host does not acknowledge it, so it
  // keeps answering with it until the next click).
  harness.setNavReply({ nav: { back: true }, navAt: 'stamp-1' })
  await tickOnce()
  assert.equal(test.shared.nav.level, 'session', 'an unchanged stamp is ignored')
  harness.setNavReply({ nav: { back: true }, navAt: 'stamp-2' })
  await tickOnce()
  assert.equal(test.shared.nav.level, 'sessions', 'a new stamp with back steps up')
  harness.setNavReply(undefined)
  test.navigate({ level: 'projects' })
  await tickOnce()
})

//#region hot reload and the click path
  await check('lets each activation own the one-second tick, and never leaves two', () => {
  // The bug this pins down: an updated bundle is loaded into a page whose PREVIOUS
  // copy is still running, and that copy's interval kept composing the view — so the
  // fix on disk was live in the file, live in the served bundle, and never live in the
  // window. The pane went on showing the replaced behaviour, which is exactly how the
  // same complaint survived several fixes.
  const test = harness.bundle.__test
  const ticks = () => intervals.filter((entry) => entry.ms === 1000)
  const cellCount = cells.length
  assert.equal(ticks().length, 1, 'exactly one tick is armed to begin with: ' + ticks().length)

  // Every activation takes the timer over and leaves exactly one behind.
  harness.applyTo()
  assert.equal(ticks().length, 1, 'a re-activation leaves exactly one tick: ' + ticks().length)
  assert.equal(test.shared.tickOwner, bundle.VERSION, 'and it is the owner now')

  // Even a previous owner whose stamp looks NEWER does not block it. What the loader
  // just loaded IS the newer file; refusing on a version comparison is what wedged the
  // page when the stamp moved backwards (a renumbering, or a rollback), leaving the old
  // interval
  // driving with nothing able to heal it.
  test.shared.tickOwner = '9.9.9'
  harness.applyTo()
  assert.equal(ticks().length, 1, 'an older-looking previous owner leaves one tick: ' + ticks().length)
  assert.equal(test.shared.tickOwner, bundle.VERSION, 'the newest activation owns the tick')
  cells.length = cellCount
})

  await check('records which copy it took the tick from', () => {
  // A page really can run two copies; which one drives has to be answerable from disk.
  const test = harness.bundle.__test
  const cellCount = cells.length
  test.shared.tickOwner = '0.0.1'
  harness.applyTo()
  cells.length = cellCount
  const record = JSON.parse(harness.context.localStorage.getItem('dsh-task-tracker.diagnostics.v1'))
  assert.equal(record.tickOwner, bundle.VERSION, 'the record names the owner: ' + record.tickOwner)
  assert.equal(record.tickTakenFrom, '0.0.1', 'and who held it before')
  assert.equal(record.tickLooksNewer, true, 'including whether the stamp moved forward')
  assert.equal(record.tickNotTakenBy, undefined, 'nothing is left claiming a refusal')
})

  await check('orders versions by number, not by text', () => {
  const test = bundle.__test
  assert.equal(test.isNewerVersion('0.10.0', '0.9.0'), true, '0.10.0 is newer than 0.9.0')
  assert.equal(test.isNewerVersion('0.9.0', '0.10.0'), false, '0.9.0 is older than 0.10.0')
  assert.equal(test.isNewerVersion('0.1', '0.1.0'), false, 'a missing segment counts as zero')
  assert.equal(test.isNewerVersion('0.1.1', '0.1'), true, 'and a longer version can still win')
})

  await check('reloads once when the bundle being served is not this one', async () => {
  // The desktop page binds no reload shortcut and the module table rejects a second
  // registration for the same id, so reloading itself is the only way a page picks up a
  // new bundle. It must fire once per version — and it must SAY WHY when it cannot even
  // read the served bundle, because a refused fetch on the app's custom scheme looks
  // exactly like a bundle that simply carries no version stamp.
  const test = bundle.__test
  const marker = 'dsh-task-tracker:reloadedFor'
  const diagnostics = () => JSON.parse(harness.context.localStorage.getItem('dsh-task-tracker.diagnostics.v1'))

  harness.context.localStorage.setItem('dsh-task-tracker.diagnostics.v1', '{}')
  harness.context.sessionStorage.removeItem(marker)
  harness.reloads.length = 0
  harness.setServedVersion('9.9.9')
  await test.checkForNewerBundle()
  harness.runTimeouts()
  assert.equal(harness.reloads.length, 1, 'a different served version reloads the page once')
  assert.equal(harness.context.sessionStorage.getItem(marker), '9.9.9', 'and the version is remembered')
  assert.equal(diagnostics().reloadingFor, '9.9.9', 'the reason is recorded')

  // The same version again: the page is already loading it.
  harness.reloads.length = 0
  await test.checkForNewerBundle()
  harness.runTimeouts()
  assert.equal(harness.reloads.length, 0, 'the same version is not reloaded twice')
  assert.equal(diagnostics().reloadSkippedFor, '9.9.9', 'and the skip is recorded')

  // Nothing readable at all: recorded rather than swallowed.
  harness.context.sessionStorage.removeItem(marker)
  harness.reloads.length = 0
  harness.setBundleFetchFails(true)
  await test.checkForNewerBundle()
  harness.runTimeouts()
  assert.equal(harness.reloads.length, 0, 'an unreadable bundle is not a reason to reload')
  assert.match(
    String(diagnostics().servedVersionError),
    /refused/u,
    'the failure is recorded: ' + String(diagnostics().servedVersionError),
  )
  harness.setBundleFetchFails(false)
  harness.setServedVersion(undefined)
  harness.context.sessionStorage.removeItem(marker)
})

  await check('reloads when the host reports a different bundle on disk', async () => {
  // The page keeps running the bundle it booted with (the module table rejects a second
  // registration for the same id), and the app page's custom scheme answers a fetch of
  // that bundle with 404 — so the host, which reads lib/client.js directly, is what can
  // tell the page that a reload is due.
  const test = bundle.__test
  const marker = 'dsh-task-tracker:reloadedFor'
  const diagnostics = () => JSON.parse(harness.context.localStorage.getItem('dsh-task-tracker.diagnostics.v1'))
  harness.context.localStorage.setItem('dsh-task-tracker.diagnostics.v1', '{}')
  harness.context.sessionStorage.removeItem(marker)
  harness.reloads.length = 0
  harness.setHostClientVersion('0.2.0')
  feedSnapshots({ byId: { s1: { id: 's1', title: 'a session', cwd: 'C:\\p' } } }, undefined)
  await tickOnce()
  assert.equal(harness.reloads.length, 0, 'nothing is reloaded before the timer runs')
  harness.runTimeouts()
  assert.equal(harness.reloads.length, 1, 'the tick reloads the page once: ' + harness.reloads.length)
  assert.equal(diagnostics().reloadReason, 'host-reported', 'and records why')
  assert.equal(harness.context.sessionStorage.getItem(marker), '0.2.0', 'remembering which version it reloaded for')

  // A host that reports the version this page is already running changes nothing.
  harness.reloads.length = 0
  harness.setHostClientVersion(bundle.VERSION)
  await tickOnce()
  harness.runTimeouts()
  assert.equal(harness.reloads.length, 0, 'a matching version reloads nothing')
  harness.setHostClientVersion(undefined)
  harness.context.sessionStorage.removeItem(marker)
})

  await check('does not replay a click the previous page already applied', async () => {
  // The host answers every `/ping` with the last click it was told about, because it
  // has no way to know the page saw it. A page that has just reloaded therefore used
  // to apply a click from BEFORE the reload: the pane opened on a conversation's
  // detail (with empty projections, the page having only just booted) instead of the
  // project list it was opened for.
  const test = bundle.__test
  harness.setNavReply(undefined)
  test.closeWindow()
  test.shared.tickOwner = bundle.VERSION
  feedSnapshots({ byId: { s9: { id: 's9', title: 'elsewhere', cwd: 'C:\\q' } } }, undefined)
  test.navigate({ level: 'projects' })
  await tickOnce()

  // Exactly what a reloaded page looks like: the host still holds the old click, and
  // the tab remembers having applied it.
  const stale = { nav: { target: { level: 'session', cwd: 'C:\\q', sessionId: 's9' } }, navAt: 'stamp-old' }
  harness.setNavReply(stale)
  harness.context.sessionStorage.setItem('dsh-task-tracker:appliedNav', 'stamp-old')
  test.shared.navStamp = 'stamp-old'
  await tickOnce()
  assert.equal(test.shared.nav.level, 'projects', 'a click this tab already applied is not applied again')

  // A click made while the page is open still lands, and is remembered.
  harness.setNavReply({ nav: { target: { level: 'session', cwd: 'C:\\q', sessionId: 's9' } }, navAt: 'stamp-new' })
  const mark = requests.length
  await tickOnce()
  assert.equal(test.shared.nav.level, 'session', 'a fresh click is applied')
  assert.equal(test.shared.nav.sessionId, 's9', 'to the session that was clicked')
  assert.equal(
    harness.context.sessionStorage.getItem('dsh-task-tracker:appliedNav'),
    'stamp-new',
    'and remembered, so the next reload does not replay it',
  )
  const beats = requests.slice(mark)
    .filter((request) => request.url.endsWith('/health'))
    .map((request) => JSON.parse(request.init.body))
    .filter((body) => body.mode === 'nav')
  assert.equal(beats.length, 1, 'one acknowledgement per applied click: ' + beats.length)
  assert.equal(beats[0].navStamp, 'stamp-new', 'carrying the stamp the host can retire')
  assert.equal(beats[0].owner, bundle.VERSION, 'and naming the copy that owns the tick')
  harness.setNavReply(undefined)
  test.navigate({ level: 'projects' })
  await tickOnce()
})

  await check('shows the clicked session, driving the pane the way a click does', async () => {
  // The existing level test calls `navigate()`/`composeView()` directly; this one goes
  // through the real handlers the app popup installs, because that is the path a user's
  // click takes and the one nothing covered.
  const test = bundle.__test
  harness.setNavReply(undefined)
  test.closeWindow()
  const sessions = {
    byId: {
      mine: { id: 'mine', title: 'THIS conversation', cwd: 'C:\\p' },
      other: {
        id: 'other',
        title: 'ANOTHER conversation',
        cwd: 'C:\\p',
        projectionValues: { tokenUsage: { uncachedInputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, outputTokens: 5 } },
      },
    },
  }
  feedSnapshots(sessions, { get: () => ({ running: false, pendingInteraction: null }) }, { items: [], archivedSessionIds: [] })
  test.shared.currentSessionId = 'mine'
  test.navigate({ level: 'projects' })
  await tickOnce()

  assert.equal(test.toggleWindow(), true, 'the button opens the pane')
  await tickOnce()
  const popupDoc = opened[opened.length - 1].window.document
  const projectRows = clickableRows(popupDoc)
  assert.equal(projectRows.length, 1, 'the project list has one clickable row: ' + projectRows.length)
  assert.ok(projectRows[0].text().includes('p'), 'and it is the project: ' + projectRows[0].text())

  projectRows[0].listeners.click()
  await settle()
  assert.equal(test.shared.nav.level, 'sessions', 'the project row drills into its sessions')
  assert.equal(test.shared.view.compact.title, 'p', 'naming the project it opened')

  const sessionRows = clickableRows(popupDoc)
  const target = test.shared.view.compact.rows.findIndex((row) => row.target.sessionId === 'other')
  assert.ok(target >= 0, 'the other session is listed')
  assert.equal(sessionRows.length, test.shared.view.compact.rows.length, 'every session row is clickable')
  sessionRows[target].listeners.click()
  await settle()
  assert.equal(test.shared.nav.level, 'session', 'the session row opens a detail')
  assert.equal(test.shared.nav.sessionId, 'other', 'for the session that was clicked')
  assert.equal(test.shared.view.mode, 'detail', 'the pane switches to the detail')
  assert.equal(test.shared.view.header.title, 'ANOTHER conversation', 'and names it: ' + test.shared.view.header.title)
  assert.ok(
    !test.shared.view.sections.some((section) => section.key === 'todos'),
    'with no task list borrowed from the open conversation',
  )
  const tokens = test.shared.view.sections.find((section) => section.key === 'tokens')
  assert.ok(tokens !== undefined, 'it still shows that session\'s own token volume')
  assert.ok(
    tokens.rows.find((row) => row.name === '总量').meta.includes('本会话'),
    'labelled as its own: ' + tokens.rows.find((row) => row.name === '总量').meta,
  )
  test.closeWindow()
  test.navigate({ level: 'projects' })
  await tickOnce()
})

  await check('retries a toast the host refused instead of losing it', async () => {
  // The host allows one toast per 250 ms and two events land in the same tick easily.
  // Treating that refusal as "the service is down" fell back to the browser API, which
  // cannot deliver anything on this desktop build — the notification was simply lost,
  // which is the "任务完成了却没有系统通知" report.
  resetNotifications()
  const test = bundle.__test
  test.closeWindow()
  const sessions = { byId: { s1: { id: 's1', title: 'mine', cwd: 'C:\\p' } } }
  feedSnapshots(sessions, { get: () => ({ running: true, pendingInteraction: null }) })
  await tickOnce()
  const mark = requests.length
  harness.setNotifyRefusals(1)
  feedSnapshots(sessions, { get: () => ({ running: false, pendingInteraction: null }) })
  await tickOnce()
  assert.equal(noticesSince(mark).length, 1, 'the completion is announced')
  assert.equal(test.shared.notificationLog[test.shared.notificationLog.length - 1].kind, 'turn-end', 'logged as a turn end')

  harness.runTimeouts()
  await settle()
  assert.equal(noticesSince(mark).length, 2, 'the refused toast is retried once: ' + noticesSince(mark).length)
  const newest = test.shared.notificationLog[test.shared.notificationLog.length - 1]
  assert.equal(newest.channel, 'host', 'and the retry is what carried it')
  assert.equal(newest.delivered, true, 'so it is recorded as delivered')
})
//#endregion

//#region helpers
/** Render one registered cell with the given props. */
function renderCell(slotName, props) {
  const cell = cells.find((candidate) => candidate.options.name === slotName)
  assert.ok(cell !== undefined, 'no cell registered for ' + slotName)
  const node = cell.component(props)
  harness.runEffects()
  return node
}

/**
 * The props a shipped slot hands a cell: the six framework sources the design
 * reads, with the data varying. A slot always carries them (a missing one is a
 * `SlotAssemblyError` from the framework, not an undefined), and the cell's hook
 * sequence depends on that, so every render in this file goes through here.
 * @param overrides - the sources a test wants to change.
 * @returns the props object.
 */
function slotProps(overrides = {}) {
  return {
    sessionId: 's1',
    useProjection: () => undefined,
    useSessionStatus: (select) => select({ get: () => undefined }),
    useSessions: (select) => select({ byId: {} }),
    useWorkspaces: (select) => select({ items: [] }),
    ...overrides,
  }
}

/** Every element in a returned React-element tree, depth first. */
function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  // Two shapes reach this: the harness's own `createElement` (children on the
  // element object) and `react/jsx-runtime`'s (children inside `props`).
  const direct = Array.isArray(node.children) && node.children.length > 0 ? node.children : undefined
  const children = direct ?? node.props?.children
  if (Array.isArray(children)) for (const child of children) flatten(child, out)
  else flatten(children, out)
  return out
}

/** All text in a returned React-element tree. */
function textOf(node) {
  return flatten(node)
    .map((item) => (item.props?.children !== undefined ? item.props.children : item.children))
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => typeof value === 'string')
    .join('|')
}

/** Publish snapshots the way the rendered cells do. */
function feedSnapshots(sessions, status, workspaces) {
  const shared = bundle.__test.shared
  shared.snapshots.sessions = sessions
  shared.snapshots.status = status
  shared.snapshots.workspaces = workspaces ?? { items: [], archivedSessionIds: [] }
}

/**
 * Run exactly one tick and let its awaits settle.
 *
 * The tick awaits `ensureService` → `fetch` → `json`, and possibly again for the second
 * `/state` push, so a handful of microtask turns is not enough: the loop below drains
 * generously before returning.
 */
async function tickOnce() {
  const interval = intervals.find((candidate) => candidate.ms === 1000)
  assert.ok(interval !== undefined, 'the tick interval must exist')
  interval.fn()
  await settle()
}

/** Let everything a tick or a click handler started settle. */
async function settle() {
  for (let index = 0; index < 64; index += 1) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  for (let index = 0; index < 64; index += 1) await Promise.resolve()
}

/**
 * The rows the pane made clickable, in the order they are drawn.
 *
 * The panel rows are plain divs with an inline click handler (the pane is built with
 * imperative DOM so it survives living in a foreign document), so this is how a test
 * reaches the same handler a user's click reaches.
 * @param popupDoc - the document the pane was drawn into.
 * @returns the clickable rows.
 */
function clickableRows(popupDoc) {
  return popupDoc.body
    .walk()
    .filter((node) => node.tagName === 'DIV' && typeof node.listeners.click === 'function')
}

/** Forget every notification mark, so a test starts from a clean slate. */
function resetNotifications() {
  const shared = bundle.__test.shared
  shared.notified = {}
  shared.phase = {}
  shared.running = {}
}

/** Only the notification requests sent since a mark. */
function noticesSince(mark) {
  return requests.slice(mark).filter((request) => request.url.endsWith('/notify'))
}

/** Every string in a plain (imperative) DOM tree. */
function domText(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (typeof node.textContent === 'string' && node.textContent !== '') out.push(node.textContent)
  if (Array.isArray(node.children)) for (const child of node.children) domText(child, out)
  return out
}

/** A representative view for the panel-shape assertions. */
function panelView() {
  return {
    version: '0.1.2',
    mode: 'detail',
    theme: {
      base: '#101014', panel: '#17171c', fg: '#ececf1', muted: '#9a9aa2', border: '#33333c',
      hover: '#22222a', group: '#1a1a20', accent: '#4d6bfe', success: '#2aa96b', danger: '#e5534b', warn: '#d29922', dark: true,
    },
    header: { title: 'my session', subtitle: '当前状态' },
    progress: { label: '进度', text: '暂无任务', percent: 0, detail: '' },
    compact: { title: 'example-project', hint: '点一行进入下一级', back: true, rows: [{ name: 'a project', meta: '3 个会话', status: 'idle', target: { level: 'sessions', cwd: 'C:\\p' } }] },
    sections: [
      { key: 'state', title: '当前状态', empty: '', rows: [{ name: 'my session', meta: '运行中 · 1.2万 tokens', status: 'running' }] },
      { key: 'tokens', title: 'Token 用量', empty: '', rows: [{ name: '总量', meta: '1.2亿 · 输入 1.2亿', status: 'pending' }, { name: '缓存命中', meta: '99.0%', status: 'completed' }] },
    ],
    footer: 'dsh-task-tracker 0.1.2',
  }
}
//#endregion
}

await main()

console.log('')
console.log(failures.length === 0 ? 'all checks passed (' + passed + ')' : failures.length + ' checks failed, ' + passed + ' passed')
if (failures.length > 0 && verbose) {
  for (const failure of failures) console.log('\n--- ' + failure.name + ' ---\n' + (failure.error && failure.error.stack))
}
process.exit(failures.length === 0 ? 0 : 1)
