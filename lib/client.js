/**
 * dsh-task-tracker — browser half, v0.1.1.
 *
 * What this file is: a hand-written client bundle in the same shape the shipped
 * client plugins use (`window.__ModuleLoader__.load({ id, factory })`). It runs in
 * the DSH web page and does four things:
 *
 *   1. ONE button on the LEFT of the composer's tool row — the
 *      `conversation.input.left` list slot, whose shipped occupants are the
 *      permission and plan chips, so a fresh cell `id` ADDS a button instead of
 *      replacing one. The button carries a live `done/total` badge and a dot while
 *      a session is running.
 *   2. A task window. It is opened by that button, and it is a REAL window owned by
 *      the app: the desktop shell carries a one-URL `setWindowOpenHandler` patch
 *      (see `tools/shell-patch.mjs`) that allows exactly
 *      `about:blank#dsh-task-tracker`. When that patch is absent the app answers
 *      `null`, and the host service's browser window is used instead.
 *   3. The window's content. The plugin PUSHES a composed, serializable view to the
 *      host service (`POST /state`) once a second; the host serves the window page
 *      and that page renders the view. Pushing is what makes the window live even
 *      when the composer's cell is remounted, and it is the ONLY feed the host page
 *      has — without it the window shows "waiting for state" forever.
 *   4. Notifications. A frame-wide cell (`shell.overlay`, root scope) watches every
 *      session and announces a task that finished, or a moment that waits for the
 *      user (question / plan review / approval). A run the user stopped themselves
 *      is silent. The toast itself is delivered by the host service (`POST /notify`
 *      → native Windows toast); the browser Notification API is the fallback.
 *
 * Everything above is state that lives in `globalThis.__dshTaskTrackerShared`, so a
 * hot reload (a new copy of this module while the old one is still registered)
 * keeps the same navigation position, the same window handle and the same toasts.
 */

window.__ModuleLoader__.load({
  id: "dsh-task-tracker",
  factory: (require) => {
    const module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    var React = require("react")
    var jsxRuntime = require("react/jsx-runtime")
    var jsx = jsxRuntime.jsx
    var jsxs = jsxRuntime.jsxs

    var VERSION = "0.1.1"
    var NS = "task-tracker"
    var SLOT_LEFT = "conversation.input.left"
    var SLOT_OVERLAY = "shell.overlay"
    var SERVICE_ID = "dsh-task-tracker"
    var PORTS = [17777, 17778, 17779, 17780, 17781, 17782, 17783, 17784, 17785, 17786]
    var DETACHED_URL = "about:blank#dsh-task-tracker"
    var WINDOW_NAME = "dsh-task-tracker-window"
    var DIAGNOSTIC_KEY = "dsh-task-tracker.diagnostics.v1"
    // Which `/ping.nav` stamp this tab has already applied. Kept in sessionStorage
    // because the page reloads itself on a version change: without it, the first
    // tick after the reload re-applies the last click of the PREVIOUS page and the
    // pane opens on somebody's detail instead of the project list.
    var NAV_STAMP_KEY = "dsh-task-tracker:appliedNav"
    var ARCHIVED_CWD = "\u0000archived"
    var ONCE_MS = 4000
    /** How many notifications the diagnostics remember (newest last). */
    var NOTIFICATION_LOG_MAX = 6
    /** How long to wait before retrying a host toast the rate limiter refused. */
    var TOAST_RETRY_MS = 400

    var TEXT = {
      zh: {
        title: "任务追踪",
        projects: "项目",
        archived: "归档项目",
        sessions: "会话",
        back: "‹ 返回",
        empty: "暂无会话",
        tasksEmpty: "暂无任务",
        tasksElsewhere: "任务清单只在打开该会话时可见",
        noTasks: "当前没有任务清单",
        running: "运行中",
        idle: "空闲",
        close: "关闭",
        waiting: "等你回复",
        tasks: "任务",
        progress: "进度",
        todoDone: "已完成",
        todoActive: "进行中",
        todoPending: "待处理",
        tokens: "Token 用量",
        tokensTotal: "总量",
        tokensCache: "缓存命中",
        tokensIn: "输入",
        tokensOut: "输出",
        ownTokens: "本会话",
        state: "当前状态",
        session: "会话",
        elapsed: "已运行",
        // The same reading once the run is over, and the marker for a run whose real
        // start this page never saw (the log could not be read): "at least this long".
        ranFor: "上次运行",
        atLeast: "≥",
        // Each unit carries its own leading space ("1 分"), and the parts are separated
        // by one more; English units carry none and rely on the separator.
        durationUnits: { h: " 小时", m: " 分", s: " 秒" },
        durationJoin: " ",
        noElapsed: "未在运行",
        done: "任务已完成",
        failed: "任务失败",
        unfinished: "任务未跑完",
        question: "需要你的选择",
        windowHint: "点一行进入下一级",
        windowHintTop: "点一个项目查看它的会话",
        elsewhere: "这个会话的 token 用量与缓存命中来自它自己的会话行；任务清单与 goal 计数是分会话的投影，只有在本页打开它时才有",
        footer: "dsh-task-tracker",
      },
      en: {
        title: "Task tracker",
        projects: "Projects",
        archived: "Archived",
        sessions: "Sessions",
        back: "‹ Back",
        empty: "No sessions",
        tasksEmpty: "No tasks",
        tasksElsewhere: "Task list visible only for the open session",
        noTasks: "No task list in this session",
        running: "Running",
        idle: "Idle",
        close: "Close",
        waiting: "Waiting for you",
        tasks: "Tasks",
        progress: "Progress",
        todoDone: "Completed",
        todoActive: "In progress",
        todoPending: "Pending",
        tokens: "Tokens",
        tokensTotal: "Total",
        tokensCache: "Cache hit",
        tokensIn: "Input",
        tokensOut: "Output",
        ownTokens: "this session",
        state: "State",
        session: "Session",
        elapsed: "Running for",
        ranFor: "Last run",
        atLeast: "at least ",
        durationUnits: { h: "h", m: "m", s: "s" },
        durationJoin: " ",
        noElapsed: "Not running",
        done: "Task finished",
        failed: "Task failed",
        unfinished: "Task stopped early",
        question: "Waiting for your choice",
        windowHint: "Click a row to drill down",
        windowHintTop: "Click a project to see its sessions",
        elsewhere: "This conversation's token volume and cache rate come from its own session row; its task list and goal counter are session-scoped projections and exist only while this page has it open",
        footer: "dsh-task-tracker",
      },
    }
    var t = TEXT.zh

    /** The plugin context, kept so the heartbeat can read the slot registry back. */
    var ctx

    /**
     * Which host navigation stamp this tab has already applied.
     *
     * The host keeps answering `/ping` with the last click it was told about, so a
     * page that has just loaded would otherwise apply a click nobody made in THIS
     * page — which is what made the pane jump straight to a conversation's detail
     * (with empty projections, because the page had only just booted) instead of
     * showing the project list it was opened for.
     * @returns the stamp, or undefined.
     */
    function readAppliedNav() {
      try {
        return globalThis.sessionStorage.getItem(NAV_STAMP_KEY) ?? undefined
      } catch (error) {
        return undefined
      }
    }

    /** Remember a host navigation stamp for the lifetime of this tab. */
    function writeAppliedNav(stamp) {
      try {
        globalThis.sessionStorage.setItem(NAV_STAMP_KEY, String(stamp))
      } catch (error) {
        /* storage is optional */
      }
    }

    /** Cross-copy state: a hot reload must not lose the navigation or the window. */
    var shared = (globalThis.__dshTaskTrackerShared ??= {
      nav: { level: "projects", cwd: undefined, sessionId: undefined },
      view: null,
      state: null,
      stop: null,
      /** Which copy of this module owns the one-second tick. */
      tickOwner: undefined,
      popup: null,
      popupDoc: null,
      popupMode: undefined,
      navStamp: readAppliedNav(),
      running: {},
      notified: {},
      phase: {},
      /**
       * One entry per session whose run this page has watched:
       * `{ start, exact, end }` in epoch ms. `exact` means `start` came from the
       * session log (or from watching the run begin), so the reading can be stated
       * without a qualifier.
       */
      runs: {},
      /** The last few notifications, so "did one fire, and did it arrive" is readable. */
      notificationLog: [],
      windowOpen: false,
      lastError: undefined,
      /** The newest snapshot each rendered cell handed over, for the one-second tick. */
      snapshots: { sessions: undefined, status: undefined, workspaces: undefined, projections: {} },
      currentSessionId: undefined,
    })
    if (shared.running === undefined) shared.running = {}
    if (shared.notified === undefined) shared.notified = {}
    if (shared.phase === undefined) shared.phase = {}
    if (shared.runs === undefined) shared.runs = {}
    if (shared.notificationLog === undefined) shared.notificationLog = []
    if (shared.snapshots === undefined) shared.snapshots = { sessions: undefined, status: undefined, workspaces: undefined, projections: {} }
    if (shared.snapshots.projections === undefined) shared.snapshots.projections = {}

    //#region diagnostics
    /**
     * Store one diagnostic line, best effort. Storage writes can stop landing on a
     * long-lived page, so this is a debugging aid, never a control path.
     * @param patch - fields to merge into the record.
     */
    function noteDiagnostic(patch) {
      try {
        var current = {}
        try {
          current = JSON.parse(globalThis.localStorage.getItem(DIAGNOSTIC_KEY) ?? "{}")
        } catch (error) {
          current = {}
        }
        globalThis.localStorage.setItem(
          DIAGNOSTIC_KEY,
          JSON.stringify(Object.assign({}, current, patch, { version: VERSION })),
        )
      } catch (error) {
        /* storage is optional */
      }
    }
    //#endregion

    //#region transport
    /** The host service, once found. */
    var service = { port: undefined }

    /**
     * Find the host service on its port list. One GET answers it, and the plugin
     * reports liveness through the same channel, so this doubles as the
     * "is the browser half alive" probe.
     * @returns the port, or undefined when nothing answers.
     */
    async function ensureService() {
      if (service.port !== undefined) return service.port
      for (var index = 0; index < PORTS.length; index += 1) {
        try {
          var response = await fetch("http://127.0.0.1:" + PORTS[index] + "/ping", { method: "GET" })
          if (!response.ok) continue
          var payload = await response.json()
          if (payload !== null && payload !== undefined && payload.app === SERVICE_ID) {
            service.port = PORTS[index]
            return service.port
          }
        } catch (error) {
          /* this port is not ours */
        }
      }
      return undefined
    }

    /**
     * One request to the host service.
     * @param path - the route.
     * @param options - `{ method, body }`.
     * @returns the parsed payload, or undefined.
     */
    async function requestService(path, options) {
      var port = await ensureService()
      if (port === undefined) return undefined
      try {
        var init = { method: options.method }
        if (options.body !== undefined) {
          init.headers = { "content-type": "application/json" }
          init.body = JSON.stringify(options.body)
        }
        var response = await fetch("http://127.0.0.1:" + port + path, init)
        if (!response.ok) return undefined
        return await response.json()
      } catch (error) {
        return undefined
      }
    }

    /**
     * Report liveness — one HTTP GET from outside the app reads this back.
     * @param extra - extra fields (`mode`, `level`, `slot`, ...).
     */
    function beat(extra) {
      var payload = Object.assign(
        {
          version: VERSION,
          at: new Date().toISOString(),
          level: shared.nav.level,
          // Which copy owns the tick, so `/health` answers "is the running code the
          // code on disk?" — an updated bundle whose tick never took over used to be
          // indistinguishable from an update that never landed.
          owner: shared.tickOwner ?? null,
        },
        extra,
      )
      void requestService("/health", { method: "POST", body: payload })
    }

    /**
     * Append to the small notification log the diagnostics carry.
     *
     * `lastNotificationAt` alone could not answer the question the user actually
     * asks ("the task finished, why was there no toast?"): it does not say which
     * kind fired, why, nor whether the host accepted it. The log does — including
     * the turns that were deliberately NOT announced.
     * @param entry - the record to append.
     */
    function logNotification(entry) {
      var log = Array.isArray(shared.notificationLog) ? shared.notificationLog.slice() : []
      log.push(entry)
      shared.notificationLog = log.slice(-NOTIFICATION_LOG_MAX)
      noteDiagnostic({ notificationLog: shared.notificationLog })
      return entry
    }

    /**
     * Fill in how one log entry was delivered.
     *
     * Keyed by the ENTRY, not by "the newest": two notifications can be in flight at
     * once (one session finishing while another starts waiting for you) and delivery
     * resolves out of order, so patching the tail would credit the wrong one.
     * @param entry - the record {@link logNotification} returned.
     * @param patch - `{ channel, delivered, notified }`.
     */
    function patchNotification(entry, patch) {
      if (entry === undefined || entry === null) return
      Object.assign(entry, patch)
      shared.notificationLog = Array.isArray(shared.notificationLog) ? shared.notificationLog.slice() : []
      noteDiagnostic({ notificationLog: shared.notificationLog })
    }

    /**
     * Deliver a notification: the host's native toast first, the browser API as
     * the fallback. Both are recorded in the diagnostics.
     *
     * A refusal from the host is retried once rather than treated as "the service is
     * unavailable". The host rate-limits `/notify` to one toast per 250 ms and two
     * events easily land in the same tick (one session finishing while another starts
     * waiting for you), and the fallback CANNOT deliver anything on this desktop build
     * — the permission is granted, the constructor accepts the call, and nothing ever
     * reaches the notification centre. Quietly losing the second toast is exactly the
     * "任务完成了却没有系统通知" report.
     * @param title - the notification title (the task state).
     * @param body - the session name and progress.
     * @param entry - the diagnostics record to append for this notification.
     */
    function notify(title, body, entry) {
      var at = entry === undefined || entry.at === undefined ? new Date().toISOString() : entry.at
      var record = Object.assign({ at: at, title: title }, entry, { at: at })
      noteDiagnostic({ lastNotificationAt: at, lastNotificationTitle: title })
      logNotification(record)
      var payload = { title: title, body: body === undefined ? "" : body }
      void requestService("/notify", { method: "POST", body: payload })
        .then(function (answer) {
          if (answer !== undefined) return answer
          return new Promise(function (resolve) {
            globalThis.setTimeout(resolve, TOAST_RETRY_MS)
          }).then(function () {
            return requestService("/notify", { method: "POST", body: payload })
          })
        })
        .then(function (answer) {
          // "The host answered" is NOT "the toast went out". `/notify` reports what
          // happened in its BODY (`toast: true|false`) while answering 200 either way,
          // and `showToast` is Windows-only by design — on macOS and Linux the host
          // successfully does nothing. Reading a 200 as delivery would therefore leave
          // every non-Windows install with no notification at all, because the browser
          // API is the only channel there and the fallback below would never run.
          var delivered = answer !== undefined && answer !== null && answer.toast === true
          var channel = delivered ? "host" : "browser"
          noteDiagnostic({ lastNotificationChannel: channel, lastNotificationDelivered: delivered })
          patchNotification(record, { channel: channel, delivered: delivered, notified: true })
          if (delivered) return
          try {
            if (typeof globalThis.Notification !== "function") return
            if (globalThis.Notification.permission === "granted") new globalThis.Notification(title, { body: body })
            else if (globalThis.Notification.permission !== "denied") {
              void globalThis.Notification.requestPermission().then(function (permission) {
                if (permission === "granted") new globalThis.Notification(title, { body: body })
              })
            }
          } catch (error) {
            /* the notification API is optional */
          }
        })
    }

    /**
     * Announce that one session's run ended — unless the user is the one who ended it.
     *
     * `running` is a boolean, and the framework's session status carries no reason
     * (`{ running, pendingInteraction, completionUnread }`), so from the page "I
     * pressed stop" and "it finished" are the same event; announcing both as
     * 「任务已完成」 is what the user asked to stop. The session log DOES record why
     * (`turn/end { reason: { kind } }`), and the host half can read it, so the reason
     * is asked for before anything is announced:
     *
     *   - `aborted`  → silence, and the log says so;
     *   - `error`    → 「任务出错」;
     *   - `completed`→ 「任务已完成」;
     *   - anything else (`max-tokens`, or a reason that could not be read) → still
     *     announced, because losing a real completion is the worse failure.
     *
     * If the host cannot be reached at all, the completion is announced anyway: the
     * old behaviour is the safe default, and the browser fallback still applies.
     * @param entry - the session row whose run just stopped.
     */
    function announceTurnEnd(entry) {
      var at = new Date().toISOString()
      var sessionId = String(entry.id)
      // The same request also carries the log's own start/end stamps, so the run timer
      // ends up exact rather than bounded by when this page happened to notice.
      void requestTurn(shared.runs[sessionId], sessionId, true).then(function (answer) {
        var reason = answer === undefined || answer === null ? undefined : answer.reason
        if (reason === "aborted") {
          // The user stopped it on purpose. Nothing is shown, and the diagnostics
          // record the silence so "why was there no toast" has an answer.
          noteDiagnostic({ lastNotificationAt: at, lastNotificationTitle: "", lastTurnReason: reason })
          logNotification({ kind: "turn-end", at: at, sessionId: sessionId, reason: reason, notified: false })
          return
        }
        var title = reason === "error"
          ? t.failed
          : reason === undefined || reason === null || reason === "completed"
            ? t.done
            : t.unfinished
        notify(title, entry.title + " · " + t.idle, { kind: "turn-end", at: at, sessionId: sessionId, reason: reason ?? "unknown" })
      })
    }
    //#endregion

    //#region data
    /**
     * The session rows out of whatever shape the sessions snapshot uses.
     * @param snapshot - the `useSessions` snapshot.
     * @returns an array of rows.
     */
    function readSessions(snapshot) {
      if (snapshot === null || snapshot === undefined) return []
      if (Array.isArray(snapshot)) return snapshot
      if (snapshot.byId !== null && typeof snapshot.byId === "object") return Object.values(snapshot.byId)
      if (Array.isArray(snapshot.rows)) return snapshot.rows
      if (Array.isArray(snapshot.sessions)) return snapshot.sessions
      if (snapshot.sessions !== null && typeof snapshot.sessions === "object") return Object.values(snapshot.sessions)
      return []
    }

    /**
     * Look one session id up in the snapshot, whichever shape it has.
     * @param snapshot - the `useSessions` snapshot.
     * @param id - the session id.
     * @returns the row, or undefined.
     */
    function sessionOf(snapshot, id) {
      if (snapshot === null || snapshot === undefined || id === undefined) return undefined
      if (snapshot.byId !== null && typeof snapshot.byId === "object") return snapshot.byId[id]
      var rows = readSessions(snapshot)
      for (var index = 0; index < rows.length; index += 1) {
        if (rows[index] !== null && rows[index] !== undefined && rows[index].id === id) return rows[index]
      }
      return undefined
    }

    /**
     * The workspace rows out of whatever shape the workspaces snapshot uses.
     * @param snapshot - the `useWorkspaces` snapshot.
     * @returns an array of rows.
     */
    function readWorkspaces(snapshot) {
      if (snapshot === null || snapshot === undefined) return []
      if (Array.isArray(snapshot)) return snapshot
      if (Array.isArray(snapshot.items)) return snapshot.items
      if (Array.isArray(snapshot.rows)) return snapshot.rows
      if (Array.isArray(snapshot.workspaces)) return snapshot.workspaces
      if (snapshot.workspaces !== null && typeof snapshot.workspaces === "object") return Object.values(snapshot.workspaces)
      return []
    }

    /** The archived session ids of a workspaces snapshot. */
    function archivedIdsOf(snapshot) {
      if (snapshot === null || snapshot === undefined) return {}
      var ids = snapshot.archivedSessionIds
      var out = {}
      if (Array.isArray(ids)) ids.forEach(function (id) { out[String(id)] = true })
      return out
    }

    /**
     * One row's token usage, wherever the projection put it.
     * @param row - a session row.
     * @returns the usage object, or undefined.
     */
    function usageOf(row) {
      if (row === null || row === undefined) return undefined
      if (row.projectionValues !== undefined && row.projectionValues !== null && row.projectionValues.tokenUsage !== undefined) return row.projectionValues.tokenUsage
      if (row.tokenUsage !== undefined) return row.tokenUsage
      if (row.projection !== undefined && row.projection !== null && row.projection.tokenUsage !== undefined) return row.projection.tokenUsage
      return undefined
    }

    /**
     * Total and cached input tokens for a set of rows. The cache rate is cached
     * input over BILLED INPUT: output tokens are not input, and counting them made
     * the rate read low (66.7% where the truth is 70%).
     * @param rows - session rows.
     * @returns `{ tokens, cached, hit, has }`.
     */
    function sumUsage(rows) {
      var tokens = 0
      var cached = 0
      var billedInput = 0
      var output = 0
      var has = false
      rows.forEach(function (row) {
        var usage = usageOf(row)
        if (usage === undefined || usage === null) return
        has = true
        var input = Number(usage.uncachedInputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0) + Number(usage.cacheWriteTokens ?? 0)
        billedInput += input
        cached += Number(usage.cacheReadTokens ?? 0)
        output += Number(usage.outputTokens ?? 0)
        tokens += input + Number(usage.outputTokens ?? 0)
      })
      return {
        tokens: tokens,
        cached: cached,
        output: output,
        input: billedInput,
        has: has,
        hit: billedInput === 0 ? 0 : Math.min(99.9, (cached / billedInput) * 100),
      }
    }

    /**
     * Compact token text: 5.86亿 / 448万 / 1.2k.
     * @param value - a token count.
     * @returns the text.
     */
    function tokenText(value) {
      if (value >= 100000000) return (value / 100000000).toFixed(2) + "亿"
      if (value >= 10000) return Math.round(value / 10000) + "万"
      if (value >= 1000) return (value / 1000).toFixed(1) + "k"
      return String(value)
    }

    /** The last path segment of a project directory. */
    function projectName(cwd) {
      var parts = String(cwd ?? "").split(/[\\/]/u).filter(function (part) { return part !== "" })
      return parts.length === 0 ? String(cwd ?? "") : parts[parts.length - 1]
    }

    /**
     * A duration as words: `3 秒` / `1 分 23 秒` / `2 小时 5 分` (`3s` / `1m 23s` in English).
     *
     * Seconds are dropped past an hour and kept below it, because "2 小时 5 分" is what
     * a reader wants there while "1 分 23 秒" is the interesting part of a short run.
     * @param ms - milliseconds.
     * @returns the text.
     */
    function durationText(ms) {
      var total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
      var hours = Math.floor(total / 3600)
      var minutes = Math.floor((total % 3600) / 60)
      var seconds = total % 60
      var units = t.durationUnits
      var join = t.durationJoin
      if (hours > 0) return [hours + units.h, minutes + units.m].join(join)
      if (minutes > 0) return [minutes + units.m, seconds + units.s].join(join)
      return seconds + units.s
    }

    /**
     * The run-time reading for one session's own state row, or "" when there is none.
     *
     * A run in flight is measured against its start, an ended run against its length.
     * Where the start is this page's own first sighting rather than the session log's
     * `turn/start` — the host half not restarted yet, or a log that could not be read —
     * the reading is prefixed with `≥`, because a run that was already going when the
     * page loaded would otherwise be undercounted silently. Saying "at least 3 秒" is
     * honest; saying "3 秒" for a ten-minute run is not.
     * @param entry - a live session entry.
     * @param now - the current epoch ms.
     * @returns the text fragment, without a leading separator.
     */
    function runText(entry, now) {
      var run = shared.runs[entry.id]
      if (run === undefined || run === null) return ""
      var qualifier = run.certain === true ? "" : t.atLeast
      if (entry.running === true) {
        if (typeof run.start !== "number") return ""
        return t.elapsed + " " + qualifier + durationText(now - run.start)
      }
      if (typeof run.end !== "number" || typeof run.start !== "number") return ""
      if (run.end < run.start) return ""
      return t.ranFor + " " + qualifier + durationText(run.end - run.start)
    }

    /**
     * Ask the session log about one session's newest turn.
     *
     * Two callers share this: the run timer asks when a run BEGINS (it wants
     * `startedAt`), and `announceTurnEnd` asks when a run ENDS (it wants `reason`,
     * which needs `settled: true` because the closing event lands just after the
     * status flips). Both answers land on the same run record.
     * @param run - the session's run record, when there is one.
     * @param sessionId - the session to ask about.
     * @param settled - whether the caller is asking about a run that has finished.
     * @returns the answer, or undefined when the host could not be reached.
     */
    function requestTurn(run, sessionId, settled) {
      if (run !== undefined && run !== null) run.asked = true
      return requestService("/turn", {
        method: "POST",
        body: settled === true ? { sessionId: sessionId, settled: true } : { sessionId: sessionId },
      }).then(function (answer) {
        if (answer === undefined || answer === null) return undefined
        if (run !== undefined && run !== null) {
          var startedAt = answer.startedAt
          if (typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0) {
            run.start = startedAt
            // The log's own stamp: the reading can now be stated plainly, whatever this
            // page did or did not watch.
            run.certain = true
          }
          if (run.end !== undefined && typeof answer.endedAt === "number") run.end = answer.endedAt
        }
        return answer
      })
    }

    /**
     * Find out when one session's current run began.
     *
     * Asked ONCE per run (`asked` is the guard): the answer cannot change while the run
     * lasts, and asking every second would be a pointless poll of a file behind an HTTP
     * hop. A host that cannot answer — the host half needs a DSH restart to serve this
     * endpoint at all — leaves the page's own first sighting in place, which still
     * measures any run that begins while the page is open.
     * @param sessionId - the session whose run just started.
     * @param run - its run record.
     */
    function askRunStart(sessionId, run) {
      void requestTurn(run, sessionId, false)
    }

    /**
     * Keep the run record of one session up to date.
     *
     * Called from the one pass that already sees every session each second, so no extra
     * subscription is created. Watching the `running` edge here — rather than somewhere
     * that only sees the open session — is what lets the reading appear on any session's
     * detail, not just the one this page has open.
     *
     * `certain` is the whole point: it says whether the number may be stated plainly. A
     * run this page watched begin is `certain`; a run that was already going when the
     * page first looked at the session is not, until the session log answers with the
     * real `turn/start`. A stopwatch quietly started at first sighting would report a
     * ten-minute run as "3 秒".
     * @param entry - a live session entry.
     * @param now - the current epoch ms.
     */
    function trackRun(entry, now) {
      var run = shared.runs[entry.id]
      if (entry.running !== true) {
        // Remember the idle sighting: it is what makes the NEXT start one we watched.
        if (run === undefined) shared.runs[entry.id] = { start: undefined, certain: false, end: undefined, asked: false }
        else if (run.end === undefined && run.start !== undefined) run.end = now
        return
      }
      if (run !== undefined && (run.end !== undefined || run.start === undefined)) {
        // The session sat idle (or its previous run ended) and has now started.
        run.start = now
        run.certain = true
        run.end = undefined
        run.asked = false
        askRunStart(entry.id, run)
        return
      }
      if (run === undefined) {
        // First sighting, and the run is already in flight: only the log can say when it
        // began. Until it answers, the reading is qualified rather than wrong.
        shared.runs[entry.id] = { start: now, certain: false, end: undefined, asked: false }
        askRunStart(entry.id, shared.runs[entry.id])
        return
      }
      if (run.asked !== true) askRunStart(entry.id, run)
    }

    /**
     * Whether one version stamp is newer than another (`1.10.0` is newer than `1.9.0`).
     * Used for exactly one decision: which copy of this module owns the one-second
     * tick. Comparing the strings would put `1.9.0` above `1.10.0`, so the segments
     * are compared as numbers, and a missing segment counts as zero.
     * @param candidate - the version to test.
     * @param reference - the version to compare against.
     * @returns whether `candidate` is strictly newer.
     */
    function isNewerVersion(candidate, reference) {
      var left = String(candidate).split(".").map(Number)
      var right = String(reference).split(".").map(Number)
      var length = Math.max(left.length, right.length)
      for (var index = 0; index < length; index += 1) {
        var a = Number.isFinite(left[index]) ? left[index] : 0
        var b = Number.isFinite(right[index]) ? right[index] : 0
        if (a !== b) return a > b
      }
      return false
    }

    /**
     * Sessions that must not be listed or counted: child agents (a `task` tool can
     * spawn dozens at once, all with the same description) and blank shells (a
     * session created inside a project and never used; its title falls back to the
     * directory name, so it reads like a phantom project). Archived sessions are
     * reported separately by the caller.
     * @param row - a session row.
     * @returns whether the row is hidden.
     */
    function isHidden(row) {
      if (row === null || row === undefined) return true
      if (row.child === true || row.isChild === true) return true
      if (row.parentId !== undefined && row.parentId !== null) return true
      if (row.parentSessionId !== undefined && row.parentSessionId !== null) return true
      if (row.origin === "subagent") return true
      if (row.blank === true || row.isBlank === true) return true
      return false
    }

    /**
     * The todo projection, normalized.
     * @param todos - the raw projection.
     * @returns `{ items, total, done, active, pending }`.
     */
    function todoSummary(todos) {
      var items = Array.isArray(todos) ? todos.filter(function (item) { return item !== null && item !== undefined }) : []
      var done = items.filter(function (item) { return item.status === "completed" }).length
      var active = items.filter(function (item) { return item.status === "in_progress" }).length
      return { items: items, total: items.length, done: done, active: active, pending: items.length - done - active }
    }
    //#endregion

    //#region view model
    /**
     * Every visible session plus its live status, grouped by project directory.
     *
     * @param sessionsSnapshot - the `useSessions` snapshot.
     * @param statusSnapshot - the `useSessionStatus` snapshot (`{ get(id) }`).
     * @param workspacesSnapshot - the `useWorkspaces` snapshot.
     * @returns `{ projects, archived, rows, byCwd }`.
     */
    function collect(sessionsSnapshot, statusSnapshot, workspacesSnapshot) {
      var archived = archivedIdsOf(workspacesSnapshot)
      var statusOf = function (id) {
        if (statusSnapshot === null || statusSnapshot === undefined || typeof statusSnapshot.get !== "function") return undefined
        return statusSnapshot.get(id)
      }
      var rows = readSessions(sessionsSnapshot).filter(function (row) {
        return row !== null && row !== undefined && row.id !== undefined && !isHidden(row)
      })
      var live = rows.map(function (row) {
        var status = statusOf(row.id)
        return {
          id: String(row.id),
          row: row,
          title: String(row.title ?? row.summary ?? row.name ?? row.id),
          cwd: String(row.cwd ?? row.workspaceId ?? row.workspaceRoot ?? ""),
          running: status !== null && status !== undefined && status.running === true,
          pending: status === null || status === undefined ? null : status.pendingInteraction ?? null,
          updatedAt: Number(row.updatedAt ?? 0),
          archived: archived[String(row.id)] === true,
          usage: sumUsage([row]),
        }
      })
      var byCwd = new Map()
      live.filter(function (entry) { return entry.archived !== true }).forEach(function (entry) {
        var key = entry.cwd === "" ? "(unknown)" : entry.cwd
        if (!byCwd.has(key)) byCwd.set(key, [])
        byCwd.get(key).push(entry)
      })
      var named = new Map()
      readWorkspaces(workspacesSnapshot).forEach(function (workspace) {
        var cwd = String(workspace.cwd ?? workspace.root ?? workspace.path ?? "")
        var name = String(workspace.name ?? workspace.title ?? "")
        if (cwd !== "" && name !== "") named.set(cwd, name)
      })
      var projects = []
      byCwd.forEach(function (entries, cwd) {
        projects.push({
          cwd: cwd,
          name: named.get(cwd) ?? projectName(cwd),
          entries: entries.sort(function (a, b) { return b.updatedAt - a.updatedAt }),
          usage: sumUsage(entries.map(function (entry) { return entry.row })),
          running: entries.filter(function (entry) { return entry.running === true }).length,
          waiting: entries.filter(function (entry) { return entry.pending !== null && entry.pending !== undefined }).length,
        })
      })
      projects.sort(function (a, b) {
        if (a.running !== b.running) return b.running - a.running
        if (a.waiting !== b.waiting) return b.waiting - a.waiting
        return b.usage.tokens - a.usage.tokens
      })
      return { rows: live, projects: projects }
    }

    /**
     * One work-state dot/text for a row.
     * @param entry - a live session entry.
     * @param waiting - the "waiting for you" wording.
     * @returns `{ status, meta }`.
     */
    function stateOf(entry) {
      if (entry.pending !== null && entry.pending !== undefined) return { status: "waiting", running: false, waiting: true }
      if (entry.running === true) return { status: "running", running: true, waiting: false }
      return { status: "idle", running: false, waiting: false }
    }

    /**
     * Session-level description: `运行中 · 12.3万 tokens · 缓存 84%`.
     * @param entry - a live session entry.
     * @returns the text.
     */
    function sessionMeta(entry) {
      var state = stateOf(entry)
      var parts = []
      parts.push(state.waiting ? t.waiting : state.running ? t.running : t.idle)
      if (entry.usage.has) {
        parts.push(tokenText(entry.usage.tokens) + " tokens")
        parts.push(t.tokensCache + " " + entry.usage.hit.toFixed(1) + "%")
      }
      return parts.join(" · ")
    }

    /**
     * Project-level description: `3 个会话 · 1 个在跑 · 421万 tokens`.
     *
     * @param project - a collected project.
     * @returns the text.
     */
    function projectMeta(project) {
      var parts = [project.entries.length + " " + t.sessions]
      if (project.running > 0) parts.push(t.running + " " + project.running)
      if (project.waiting > 0) parts.push(t.waiting + " " + project.waiting)
      if (project.usage.has) parts.push(tokenText(project.usage.tokens) + " tokens")
      return parts.join(" · ")
    }

    /**
     * Resolve the palette the window should use: the app's own tokens, composited
     * onto an opaque base.
     *
     * The app's menu fill is translucent (`#f8f9fa94` / `#43454a73`), which is what
     * made the panel see-through; every colour below is blended against an opaque
     * backdrop before it is used, and no `backdrop-filter` is involved.
     * @param doc - the live document.
     * @returns the theme object the window page applies as CSS variables.
     */
    function paletteOf(doc) {
      var fallback = {
        base: "#1d1d20",
        panel: "#232326",
        fg: "#ececf1",
        muted: "#9a9aa2",
        border: "rgba(255,255,255,0.14)",
        hover: "rgba(255,255,255,0.08)",
        accent: "#4d6bfe",
        success: "#2aa96b",
        danger: "#e5534b",
        warn: "#d29922",
        group: "#ffffff0a",
        dark: true,
      }
      try {
        if (doc === null || doc === undefined || typeof getComputedStyle !== "function") return fallback
        var style = getComputedStyle(doc.documentElement)
        var read = function (name) { return String(style.getPropertyValue(name) ?? "").trim() }
        var base = read("--dsw-alias-bg-base") || read("--dsw-alias-bg-module-platform") || fallback.base
        var resolved = blend(base, null, fallback.base)
        var dark = luminanceOf(resolved) < 0.5
        return {
          base: resolved,
          panel: blend(read("--dsw-alias-bg-module-platform") || base, resolved, fallback.panel),
          fg: blend(read("--dsw-alias-label-primary") || fallback.fg, resolved, fallback.fg),
          muted: blend(read("--dsw-alias-label-tertiary") || fallback.muted, resolved, fallback.muted),
          // Strokes are derived, never taken verbatim: this build's border token is pure
          // white, so the colour is only used when it actually differs from the base.
          border: solid(read("--dsw-alias-border-l1"), resolved, 0.14),
          hover: solid(read("--dsw-alias-interactive-bg-hover"), resolved, 0.08),
          // The row group's surface: a barely-there fill, not a card.
          group: solid(read("--dsw-alias-interactive-bg-hover"), resolved, 0.045),
          accent: solid(read("--dsw-alias-state-business-primary") || fallback.accent, resolved, 1),
          success: solid(read("--dsw-alias-state-success-primary") || fallback.success, resolved, 1),
          danger: solid(read("--dsw-alias-state-error-primary") || fallback.danger, resolved, 1),
          warn: solid(read("--dsw-alias-state-warning-primary") || fallback.warn, resolved, 1),
          dark: dark,
        }
      } catch (error) {
        return fallback
      }
    }

    /** Parse `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()` into channels. */
    function parseColor(value) {
      if (typeof value !== "string") return null
      var text = value.trim()
      var hex = /^#([0-9a-f]{3,8})$/iu.exec(text)
      if (hex !== null) {
        var body = hex[1]
        if (body.length === 3 || body.length === 4) {
          return {
            r: parseInt(body[0] + body[0], 16),
            g: parseInt(body[1] + body[1], 16),
            b: parseInt(body[2] + body[2], 16),
            a: body.length === 4 ? parseInt(body[3] + body[3], 16) / 255 : 1,
          }
        }
        if (body.length === 6 || body.length === 8) {
          return {
            r: parseInt(body.slice(0, 2), 16),
            g: parseInt(body.slice(2, 4), 16),
            b: parseInt(body.slice(4, 6), 16),
            a: body.length === 8 ? parseInt(body.slice(6, 8), 16) / 255 : 1,
          }
        }
        return null
      }
      var fn = /^rgba?\(([^)]+)\)$/iu.exec(text)
      if (fn === null) return null
      var parts = fn[1].split(/[\s,/]+/u).filter(function (part) { return part !== "" })
      if (parts.length < 3) return null
      var channel = function (part) {
        if (part.endsWith("%")) return Math.round((parseFloat(part) / 100) * 255)
        return parseInt(part, 10)
      }
      return {
        r: channel(parts[0]),
        g: channel(parts[1]),
        b: channel(parts[2]),
        a: parts.length > 3 ? parseFloat(parts[3]) : 1,
      }
    }

    /** `#rrggbb` for one parsed colour. */
    function toHex(color) {
      var byte = function (value) {
        var clamped = Math.max(0, Math.min(255, Math.round(value)))
        return clamped.toString(16).padStart(2, "0")
      }
      return "#" + byte(color.r) + byte(color.g) + byte(color.b)
    }

    /**
     * Composite one colour onto an opaque base: the result is always fully opaque,
     * so nothing behind the window can show through.
     * @param value - the candidate colour.
     * @param base - the opaque backdrop (`#rrggbb` or a parsed colour).
     * @param fallback - the value to use when the candidate is unusable.
     * @returns an opaque `#rrggbb`.
     */
    function blend(value, base, fallback) {
      var color = parseColor(value)
      if (color === null) return fallback
      if (color.a >= 1) return toHex(color)
      var under = parseColor(base) ?? parseColor(fallback)
      if (under === null) return fallback
      return toHex({
        r: color.r * color.a + under.r * (1 - color.a),
        g: color.g * color.a + under.g * (1 - color.a),
        b: color.b * color.a + under.b * (1 - color.a),
        a: 1,
      })
    }

    /**
     * A stroke or hover colour that must stay subtle on the base.
     *
     * The app's own tokens cannot be trusted for a hairline: on this build
     * `--dsw-alias-border-l1` and `--dsw-alias-interactive-bg-hover` both resolve to
     * pure WHITE, which is what turned every separator into a bright line and every
     * panel edge into a white frame. A candidate is therefore rejected — and replaced
     * by a low-alpha neutral of the opposite tone — when it is either
     * indistinguishable from the background or extreme against it (white on a dark
     * theme, black on a light one). A hairline is a hint, not a highlight.
     * @param value - the candidate colour.
     * @param base - the opaque backdrop.
     * @param alpha - the alpha for the neutral stroke.
     * @returns an `rgba()` stroke or an opaque `#rrggbb`.
     */
    function solid(value, base, alpha) {
      var color = parseColor(value)
      var dark = luminanceOf(base) < 0.5
      var neutral = "rgba(" + (dark ? "255,255,255" : "0,0,0") + "," + String(alpha === undefined ? 0.14 : alpha) + ")"
      if (color === null) return neutral
      var under = parseColor(base)
      var luminance = luminanceOf(toHex(color))
      if (dark && luminance > 0.85) return neutral
      if (!dark && luminance < 0.15) return neutral
      if (under !== null) {
        var distance = (Math.abs(color.r - under.r) + Math.abs(color.g - under.g) + Math.abs(color.b - under.b)) / 765
        if (distance < 0.06) return neutral
      }
      if (color.a < 0.06) return neutral
      return toHex(color)
    }

    /** Relative luminance of an opaque colour, 0–1. */
    function luminanceOf(value) {
      var color = parseColor(value)
      if (color === null) return 0
      var channel = function (raw) {
        var v = raw / 255
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
    }
    //#endregion

    //#region navigation
    /** Apply one navigation step. */
    function navigate(target) {
      var level = target === null || target === undefined ? undefined : target.level
      if (level === "sessions") shared.nav = { level: "sessions", cwd: target.cwd, sessionId: undefined }
      else if (level === "session") shared.nav = { level: "session", cwd: target.cwd, sessionId: target.sessionId }
      else shared.nav = { level: "projects", cwd: undefined, sessionId: undefined }
    }

    /** One step back. */
    function goBack() {
      if (shared.nav.level === "session") navigate({ level: "sessions", cwd: shared.nav.cwd })
      else navigate({ level: "projects" })
    }
    //#endregion

    //#region view composition
    /**
     * Build the view the window renders.
     *
     * The host window page reads exactly these fields: `theme`, `header`,
     * `progress`, `compact`, `sections`, `footer` and `mode`. A view missing them
     * renders as an empty box, which is why the push and the schema live together
     * here.
     *
     * @param collected - the output of {@link collect}.
     * @param sessionId - the session whose detail the third level shows.
     * @param detail - the current session's projections (`todos`, `tokenUsage`, `sessionStats`).
     * @returns the serializable view.
     */
    function composeView(collected, sessionId, detail) {
      var theme = paletteOf(typeof document === "undefined" ? undefined : document)
      // The pane's own navigation wins over the session this page has open: the two are
      // usually the same, but the pane can be pointed at any conversation, and that is
      // the one its detail must describe. (Reading only `shared.currentSessionId` here
      // is what made a click on another conversation keep the open one's title and
      // numbers — the pane had moved, the view had not.)
      var detailSessionId = shared.nav.level === "session" && shared.nav.sessionId !== undefined
        ? shared.nav.sessionId
        : sessionId
      var current = collected.rows.filter(function (entry) { return entry.id === detailSessionId })[0]
      // The projections (todos, tokenUsage, sessionStats) belong to the session this
      // PAGE has open — they are session-scoped, and a session the page never opened
      // has none. Showing the open session's numbers under another conversation's name
      // is worse than showing nothing, so the detail says which case it is.
      var sameSession = detailSessionId !== undefined && detailSessionId !== null && String(detailSessionId) === String(shared.currentSessionId)
      var todos = detail.todos === null || detail.todos === undefined ? [] : detail.todos
      // The progress line IS the todo projection, so it obeys the same rule as the task
      // list below: it describes the session this page has OPEN. It used to be computed
      // unconditionally, which is how another conversation's detail came to show this
      // conversation's "7/7 已完成" — the count was the open session's while every other
      // line had already been switched to the visited one. Where the task list itself is
      // withheld, the progress line says why instead of borrowing a number.
      var summary = todoSummary(sameSession ? todos : [])
      var usage = detail.tokenUsage === undefined || detail.tokenUsage === null ? null : sumUsage([{ projectionValues: { tokenUsage: detail.tokenUsage } }])
      var stats = detail.sessionStats ?? null
      var percent = summary.total === 0 ? 0 : Math.round((summary.done / summary.total) * 100)
      var progressText = !sameSession
        ? t.tasksElsewhere
        : summary.total === 0 ? t.tasksEmpty : summary.done + "/" + summary.total + " " + t.todoDone
      var progressDetail = []
      if (summary.active > 0) progressDetail.push(t.todoActive + " " + summary.active)
      if (summary.pending > 0) progressDetail.push(t.todoPending + " " + summary.pending)
      var sections = []
      // 1. The visited session's own facts, which every session row carries: its run
      //    state and its token volume. The goal counter below is the page's session.
      var stateRows = []
      if (current !== undefined) {
        var ownState = stateOf(current)
        var ownMeta = [ownState.waiting ? t.waiting : ownState.running === true ? t.running : t.idle]
        // The run-time reading belongs next to the run state it describes, and it is
        // the one part of this row that is known for EVERY session — the session log is
        // on disk — not only for the one this page happens to have open.
        var runReading = runText(current, Date.now())
        if (runReading !== "") ownMeta.push(runReading)
        stateRows.push({
          name: String(current.title ?? current.id),
          meta: ownMeta.join(" · "),
          status: ownState.status,
        })
      }
      if (sameSession) {
        var stateMeta = []
        if (stats !== null && typeof stats === "object") {
          if (stats.turn !== undefined) stateMeta.push("第 " + stats.turn + " 轮")
          if (stats.steps !== undefined) stateMeta.push("累计 " + stats.steps + " 步")
        }
        if (stateMeta.length > 0) stateRows.push({ name: t.state, meta: stateMeta.join(" · "), status: "pending" })
      }
      sections.push({ key: "state", title: t.state, empty: "", rows: stateRows })
      // 2. Token accounting. It is ALWAYS the visited session's own figures:
      //    - the session this page has open uses the authoritative projections (total,
      //      input, output, cache hit);
      //    - any other session uses the figures its own session row carries (total and
      //      cache hit), which is exactly what the list row above shows. Printing the
      //      open session's numbers here was the "别的会话显示的还是本对话的" bug — the
      //      projections are session-scoped and simply do not exist for another session.
      var visitedUsage = sameSession && usage !== null && usage.has ? usage : current === undefined ? null : current.usage
      if (visitedUsage !== null && visitedUsage !== undefined && visitedUsage.has === true) {
        var totalMeta = sameSession && usage !== null && usage.has
          ? tokenText(visitedUsage.tokens) + " · " + t.tokensIn + " " + tokenText(visitedUsage.input) + " · " + t.tokensOut + " " + tokenText(visitedUsage.output)
          : t.ownTokens + " " + tokenText(visitedUsage.tokens)
        sections.push({
          key: "tokens",
          title: t.tokens,
          empty: "",
          rows: [
            { name: t.tokensTotal, meta: totalMeta, status: "pending" },
            { name: t.tokensCache, meta: visitedUsage.hit.toFixed(1) + "%", status: "completed" },
          ],
        })
      }
      if (!sameSession) {
        sections.push({ key: "note", title: "", empty: "", rows: [{ name: t.elsewhere, meta: "", status: "idle", note: true }] })
      }
      // 3. The task list belongs to the open session's projections only.
      if (sameSession) {
        sections.push({
          key: "todos",
          title: t.tasks,
          empty: t.noTasks,
          rows: summary.items.map(function (item) {
            return {
              name: String(item.content ?? item.title ?? item.id ?? ""),
              meta: item.status === "completed" ? t.todoDone : item.status === "in_progress" ? t.todoActive : t.todoPending,
              status: item.status ?? "pending",
              done: item.status === "completed",
            }
          }),
        })
      }
      // The rows of the list level, whatever the level is. Every string is forced
      // through String(): a row built from a DOM node or an object would otherwise
      // render as "[object HTMLSpanElement]" in the pane.
      var compact = { title: t.projects, hint: t.windowHintTop, back: false, rows: [] }
      if (shared.nav.level === "projects") {
        compact.title = t.projects
        compact.rows = collected.projects.map(function (project) {
          return {
            name: String(project.name ?? project.cwd),
            meta: projectMeta(project),
            status: project.running > 0 ? "running" : project.waiting > 0 ? "waiting" : "idle",
            target: { level: "sessions", cwd: project.cwd },
          }
        })
        if (compact.rows.length === 0) compact.hint = t.empty
      } else {
        // "sessions" with the archive sentinel, or a real project directory.
        var archived = shared.nav.cwd === ARCHIVED_CWD
        var project = collected.projects.filter(function (item) { return item.cwd === shared.nav.cwd })[0]
        var entries = archived
          ? collected.rows.filter(function (entry) { return entry.archived === true })
          : project === undefined ? [] : project.entries
        compact.title = archived ? t.archived : String(project === undefined ? projectName(shared.nav.cwd) : project.name ?? "")
        compact.back = true
        compact.hint = entries.length === 0 ? t.empty : t.windowHint
        compact.rows = entries.map(function (entry) {
          return {
            name: String(entry.title ?? entry.id),
            meta: sessionMeta(entry),
            status: stateOf(entry).status,
            target: { level: "session", cwd: shared.nav.cwd, sessionId: entry.id },
          }
        })
      }
      if (shared.nav.level === "projects") {
        var archivedRows = collected.rows.filter(function (entry) { return entry.archived === true })
        if (archivedRows.length > 0) {
          compact.rows.push({
            name: t.archived,
            meta: archivedRows.length + " " + t.sessions,
            status: "idle",
            target: { level: "sessions", cwd: ARCHIVED_CWD },
          })
        }
      }
      // The header names where you are: the open session, or the level above it.
      var headerTitle = shared.nav.level === "session"
        ? String((current === undefined ? undefined : current.title) ?? detailSessionId ?? t.title)
        : t.title
      var headerSub = shared.nav.level === "projects"
        ? collected.projects.length + " " + t.projects
        : shared.nav.level === "sessions"
          ? String(compact.title ?? "")
          : t.state
      return {
        version: VERSION,
        updatedAt: new Date().toISOString(),
        mode: shared.nav.level === "session" ? "detail" : "list",
        theme: theme,
        header: { title: headerTitle, subtitle: headerSub },
        progress: {
          label: t.progress,
          text: progressText,
          percent: percent,
          detail: progressDetail.join(" · "),
        },
        compact: compact,
        sections: shared.nav.level === "session" ? sections : [],
        footer: t.footer + " " + VERSION,
        // Where the pane's navigation actually is, and which session it resolved to.
        // Carried in the snapshot so `/state` answers "did my click land?" — the
        // pane is the only place that can ask, and it has no devtools here.
        debug: {
          level: shared.nav.level,
          cwd: shared.nav.cwd === undefined ? null : String(shared.nav.cwd),
          sessionId: detailSessionId === undefined ? null : String(detailSessionId),
          title: headerTitle,
          projects: collected.projects.map(function (project) { return { name: String(project.name), cwd: String(project.cwd), sessions: project.entries.length } }),
          rows: collected.rows.length,
        },
      }
    }
    //#endregion

    //#region window
    /** Create one element with inline styles, in the given document. */
    function el(doc, tag, style, text) {
      var node = doc.createElement(tag)
      if (style !== undefined) Object.keys(style).forEach(function (key) { node.style[key] = style[key] })
      if (text !== undefined) node.textContent = text
      return node
    }

    /**
     * Build the in-app panel: plain DOM with every style inline.
     *
     * The panel can live in a FOREIGN document when the app's popup window is used,
     * and in a foreign document a stylesheet-based rule can render black, so nothing
     * here depends on CSS classes.
     * @param view - the composed view.
     * @param doc - the document to build in.
     * @param options - `{ closable }`: the in-app panel has no system title bar, so it
     *   is the only surface that draws its own close control.
     * @returns the root element.
     */
    function buildPanel(view, doc, options) {
      var closable = options !== undefined && options.closable === true
      var theme = view.theme
      var root = el(doc, "div", {
        position: "fixed",
        inset: "0",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        background: theme.base,
        color: theme.fg,
        font: "13px/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif",
        overflow: "hidden",
      })
      var head = el(doc, "div", {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "9px 12px 7px",
      })
      if (view.compact !== undefined && view.compact.back === true) {
        var back = el(doc, "button", {
          border: "1px solid " + theme.border,
          background: "transparent",
          color: theme.fg,
          borderRadius: "6px",
          padding: "1px 8px",
          cursor: "pointer",
          font: "inherit",
          flex: "none",
        }, t.back)
        back.addEventListener("click", function () {
          goBack()
          void tick()
          renderWindow()
        })
        head.appendChild(back)
      }
      var headline = el(doc, "div", { display: "flex", alignItems: "baseline", gap: "8px", flex: "1", minWidth: "0" })
      headline.appendChild(el(doc, "span", { fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, view.header.title))
      if (view.header.subtitle !== "") headline.appendChild(el(doc, "span", { color: theme.muted, fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, view.header.subtitle))
      head.appendChild(headline)
      if (closable) {
        // Only the in-app panel draws this: the host window page and the app popup
        // both have a system title bar with its own close control, and a second one
        // inside the pane just adds a frame around nothing.
        var close = el(doc, "button", {
          border: "1px solid " + theme.border,
          background: "transparent",
          color: theme.muted,
          borderRadius: "6px",
          padding: "1px 8px",
          cursor: "pointer",
          font: "inherit",
          flex: "none",
        }, t.close)
        close.addEventListener("click", closeWindow)
        head.appendChild(close)
      }
      root.appendChild(head)
      var body = el(doc, "div", { flex: "1", overflow: "auto", padding: "4px 10px 12px" })
      body.setAttribute("data-scroll", "")
      if (view.mode === "detail") {
        // The same hairline progress rule the host window page draws: one small
        // caption line, no block, no bordered box.
        var bar = el(doc, "div", { display: "flex", alignItems: "center", gap: "8px", padding: "6px 2px 8px" })
        var track = el(doc, "div", { flex: "1", minWidth: "0", height: "3px", borderRadius: "2px", background: theme.group, overflow: "hidden" })
        track.appendChild(el(doc, "div", { height: "100%", width: String(view.progress.percent) + "%", background: theme.accent }))
        bar.appendChild(track)
        bar.appendChild(el(doc, "span", { color: theme.muted, fontSize: "11px" }, view.progress.text + (view.progress.detail === "" ? "" : " · " + view.progress.detail)))
        body.appendChild(bar)
        view.sections.forEach(function (section) {
          if (section.title !== "") body.appendChild(el(doc, "div", { color: theme.muted, fontSize: "11px", padding: "10px 2px 4px" }, section.title))
          var group = panelGroup(doc, theme)
          var painted = 0
          section.rows.forEach(function (row) {
            if (row.note === true) {
              group.appendChild(el(doc, "div", { padding: "6px 8px", color: theme.muted, fontSize: "12px" }, row.name))
              painted += 1
              return
            }
            group.appendChild(panelRow(doc, theme, row, undefined))
            painted += 1
          })
          if (painted === 0 && section.empty !== "") group.appendChild(el(doc, "div", { padding: "6px 8px", color: theme.muted }, section.empty))
          if (painted > 0 || section.empty !== "") body.appendChild(group)
        })
      } else {
        body.appendChild(el(doc, "div", { color: theme.muted, fontSize: "11px", padding: "8px 2px 4px" }, view.compact.title))
        var list = panelGroup(doc, theme)
        if (view.compact.rows.length === 0) list.appendChild(el(doc, "div", { padding: "6px 8px", color: theme.muted }, t.empty))
        view.compact.rows.forEach(function (row) { list.appendChild(panelRow(doc, theme, row, function () {
          navigate(row.target)
          void tick()
          renderWindow()
        })) })
        body.appendChild(list)
      }
      root.appendChild(body)
      root.appendChild(el(doc, "div", { padding: "6px 12px", borderTop: "1px solid " + theme.border, color: theme.muted, fontSize: "11px" }, view.footer))
      return root
    }

    /**
     * One row of the in-app panel: a single line inside a transparent group.
     *
     * Hairlines between values read as a table with five frames; the values belong to
     * one group, so the group carries the surface (a barely-there fill) and the rows
     * carry nothing but spacing.
     */
    function panelRow(doc, theme, row, onClick) {
      var item = el(doc, "div", {
        display: "flex",
        alignItems: "baseline",
        gap: "8px",
        width: "100%",
        textAlign: "left",
        boxSizing: "border-box",
        color: theme.fg,
        borderRadius: "6px",
        padding: "5px 8px",
        cursor: onClick === undefined ? "default" : "pointer",
        font: "inherit",
      })
      var tone = row.status === "running" ? theme.accent : row.status === "completed" ? theme.success : row.status === "waiting" ? theme.warn : theme.muted
      item.appendChild(el(doc, "span", { width: "7px", height: "7px", borderRadius: "50%", background: tone, flex: "0 0 auto", alignSelf: "center" }))
      item.appendChild(el(doc, "span", { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, row.name))
      item.appendChild(el(doc, "span", { flex: "none", color: theme.muted, fontSize: "11px" }, String(row.meta === undefined ? "" : row.meta)))
      if (onClick !== undefined) {
        item.addEventListener("click", onClick)
        item.addEventListener("mouseenter", function () { item.style.background = theme.hover })
        item.addEventListener("mouseleave", function () { item.style.background = "transparent" })
      }
      return item
    }

    /**
     * One group of rows: a transparent container, not a set of separators.
     * @param doc - the document to build in.
     * @param theme - the palette.
     * @returns the container element.
     */
    function panelGroup(doc, theme) {
      return el(doc, "div", {
        display: "flex",
        flexDirection: "column",
        gap: "1px",
        borderRadius: "8px",
        background: theme.group,
      })
    }

    /** Repaint the detached window / in-app panel from the current view. */
    function renderWindow() {
      var view = shared.view
      if (view === null || view === undefined) return
      if (shared.popupMode === "popup") {
        var doc = shared.popupDoc
        if (doc === null || doc === undefined) return
        try {
          if (shared.popup !== null && shared.popup.closed === true) {
            shared.popup = null
            shared.popupDoc = null
            shared.windowOpen = false
            return
          }
          doc.body.textContent = ""
          doc.body.style.margin = "0"
          doc.body.style.background = view.theme.base
          doc.body.style.color = view.theme.fg
          doc.body.appendChild(buildPanel(view, doc))
          doc.title = t.title
        } catch (error) {
          noteDiagnostic({ renderError: String((error && error.message) || error) })
        }
        return
      }
      if (shared.popupMode === "panel") {
        try {
          var host = document.getElementById("dsh-task-tracker-panel")
          if (host === null) {
            host = document.createElement("div")
            host.id = "dsh-task-tracker-panel"
            host.style.position = "fixed"
            host.style.zIndex = "2147483000"
            host.style.right = "16px"
            host.style.bottom = "16px"
            host.style.width = "380px"
            host.style.height = "min(560px, 70vh)"
            host.style.borderRadius = "12px"
            host.style.overflow = "hidden"
            host.style.border = "1px solid " + view.theme.border
            host.style.boxShadow = "0 12px 32px rgba(0,0,0,.35)"
            document.body.appendChild(host)
          }
          // The panel is rebuilt from scratch once a second, so the scroll offset has
          // to survive the rebuild — otherwise a poll that lands while the reader is
          // scrolled down snaps the content back to the top.
          var scrolled = host.querySelector("[data-scroll]")
          var offset = scrolled === null ? 0 : scrolled.scrollTop
          host.textContent = ""
          var panel = buildPanel(view, document, { closable: true })
          host.appendChild(panel)
          var next = panel.querySelector("[data-scroll]")
          if (next !== null) next.scrollTop = offset
        } catch (error) {
          noteDiagnostic({ renderError: String((error && error.message) || error) })
        }
      }
    }

    /**
     * Close whichever window mode is open.
     * @returns whether something was actually open.
     */
    function closeWindow() {
      var wasOpen = isWindowOpen()
      try {
        if (shared.popupMode === "popup" && shared.popup !== null) shared.popup.close()
        if (shared.popupMode === "panel") {
          var host = document.getElementById("dsh-task-tracker-panel")
          if (host !== null) host.remove()
        }
      } catch (error) {
        /* closing is best effort */
      }
      shared.popup = null
      shared.popupDoc = null
      shared.popupMode = undefined
      shared.windowOpen = false
      noteDiagnostic({ closedAt: new Date().toISOString() })
      return wasOpen
    }

    /**
     * Open or close the task window, depending on what is already showing.
     *
     * Order: the app-owned window the desktop shell patch allows, then the host
     * service's browser window, then the in-app panel. The first two are real OS
     * windows; the panel exists only so the tracker is never unreachable.
     *
     * The toggle matters: `window.open(url, "same-name")` returns a NEW blank window
     * when called again for a name that already exists, so opening on every click
     * stacked one empty window per click and left the real pane behind them.
     */
    function toggleWindow() {
      if (isWindowOpen() === true) {
        closeWindow()
        return false
      }
      openWindow()
      return true
    }
    /** Whether a window or panel is showing right now. */
    function isWindowOpen() {
      if (shared.popupMode === "popup") {
        var popup = shared.popup
        if (popup === null || popup === undefined || popup.closed === true) {
          shared.popup = null
          shared.popupDoc = null
          shared.popupMode = undefined
          shared.windowOpen = false
          return false
        }
        return true
      }
      if (shared.popupMode === "panel") return shared.windowOpen === true
      return false
    }

    /**
     * Open the task window.
     *
     * The app-owned popup comes first because it needs no extra process; the host's
     * browser window is the fallback when the shell denies it. A popup that opens but
     * is blank means the page was not reachable, so the panel is shown as well — a
     * click must never leave the user with an empty frame and no tracker.
     */
    function openWindow() {
      // A pane that is opened starts at the project list — which is what this window
      // says it does: "打开时是紧凑监控态，第一级是项目". Without this the pane reopened
      // wherever it was last left, i.e. on a conversation's detail from an earlier life
      // of the window, which reads as "点进去显示的不是该项目的详情" even though every
      // click after that behaves. Opening is also the one moment where forgetting the
      // old position costs nothing.
      navigate({ level: "projects" })
      try {
        var popup = globalThis.open(DETACHED_URL, WINDOW_NAME, "width=460,height=780")
        if (popup !== null && popup !== undefined) {
          shared.popup = popup
          shared.popupDoc = popup.document
          shared.popupMode = "popup"
          shared.windowOpen = true
          var usable = true
          try {
            popup.document.title = t.title
            usable = popup.document.body !== null && popup.document.body !== undefined
          } catch (error) {
            usable = false
          }
          if (usable) {
            renderWindow()
            noteDiagnostic({ openedAt: new Date().toISOString(), openMode: "popup" })
            beat({ mode: "window", slot: "popup" })
            return
          }
          noteDiagnostic({ popupError: "opened but blank" })
        }
      } catch (error) {
        noteDiagnostic({ popupError: String((error && error.message) || error) })
      }
      // The app denied the window: show the in-app panel (the click is never a
      // no-op), and ask the host for its own window at the same time.
      shared.popup = null
      shared.popupDoc = null
      shared.popupMode = "panel"
      shared.windowOpen = true
      void requestService("/open", { method: "POST", body: {} })
      renderWindow()
      noteDiagnostic({ openedAt: new Date().toISOString(), openMode: "panel" })
      beat({ mode: "window", slot: "panel" })
    }
    //#endregion

    //#region tick
    /**
     * One second of work:
     *
     *   1. read the live snapshots,
     *   2. compose the view,
     *   3. push it to the host service (this is what fills the window),
     *   4. repaint the in-app panel / app popup,
     *   5. apply a navigation request that came back from the host window,
     *   6. announce sessions that stopped running, and sessions that wait for you.
     */
    async function tick() {
      try {
        // The cells rendered by the framework hand their snapshots over on every
        // render. This timer never subscribes for itself: a second subscription
        // graph would be one more thing to keep alive across a remount, and the
        // composer cell is remounted on every turn.
        var snapshots = shared.snapshots ?? {}
        var sessionsSnapshot = snapshots.sessions
        var statusSnapshot = snapshots.status
        var workspacesSnapshot = snapshots.workspaces
        var sessionId = shared.currentSessionId
        var detail = { todos: undefined, tokenUsage: undefined, sessionStats: undefined }
        if (sessionId !== undefined && snapshots.projections !== undefined) {
          var projections = snapshots.projections
          detail.todos = projections.todos
          detail.tokenUsage = projections.tokenUsage
          detail.sessionStats = projections.sessionStats
        }
        var collected = collect(sessionsSnapshot, statusSnapshot, workspacesSnapshot)
        // Watch every session's run edge BEFORE composing, so this tick's view already
        // carries the reading instead of trailing it by a second.
        var now = Date.now()
        collected.rows.forEach(function (entry) { trackRun(entry, now) })
        var view = composeView(collected, sessionId, detail)
        shared.state = { collected: collected, detail: detail }
        shared.view = view
        renderWindow()
        // The window is fed ONLY from here: the host page polls /state once a second.
        if (shared.windowOpen === true) void requestService("/state", { method: "POST", body: view })
        // A click in the host window travels back through /ping.nav.
        var ping = await requestService("/ping", { method: "GET" })
        // The same poll says which version of this file is ON DISK. The page keeps
        // running the bundle it booted with (the module table rejects a second
        // registration for the same id), so a difference here is the one reliable signal
        // that a reload is due. Asking the host — rather than fetching our own bundle URL
        // out of the boot graph — is what makes it work at all: the app page's custom
        // scheme answers that fetch with 404.
        if (ping !== undefined && ping !== null && typeof ping.clientVersion === "string"
          && ping.clientVersion !== VERSION) {
          reloadFor(ping.clientVersion, { reloadReason: "host-reported", wasVersion: VERSION })
        }
        var nav = ping === null || ping === undefined ? undefined : ping.nav
        if (nav !== null && nav !== undefined) {
          var stamp = String(ping.navAt)
          if (stamp !== shared.navStamp) {
            shared.navStamp = stamp
            writeAppliedNav(stamp)
            if (nav.back === true) goBack()
            else if (nav.target !== undefined) navigate(nav.target)
            shared.view = composeView(collected, sessionId, detail)
            renderWindow()
            // One line per applied request, visible through /health: the pane has no
            // devtools, so this is how "my click landed" is confirmed from outside.
            // The stamp travels with it so the host can retire a click that has been
            // applied and stop answering /ping with it.
            beat({ mode: "nav", level: shared.nav.level, sessionId: shared.nav.sessionId ?? null, title: shared.view.header.title, navStamp: stamp })
            if (shared.windowOpen === true) void requestService("/state", { method: "POST", body: shared.view })
          }
        }
        announce(collected)
      } catch (error) {
        shared.lastError = String((error && error.stack) || (error && error.message) || error)
        noteDiagnostic({ tickError: shared.lastError })
      }
    }

    /**
     * Announce what changed since the last tick.
     *
     * Two events are worth a notification: a run that ended, and a moment that waits
     * for the user. Both fire ONCE per occurrence —
     *
     *   - a finished run is keyed by the session and only fires on a true→false edge of
     *     `running`, so a session that stays idle is silent afterwards. What the
     *     notification then SAYS depends on why the run ended, which the session log
     *     knows and this snapshot does not: see `announceTurnEnd`, where a stop the
     *     user asked for is deliberately silent;
     *   - a pending interaction is keyed by the interaction's OWN `key` (the framework
     *     stamps every pending interaction with a unique one) and remembered until that
     *     interaction is gone. A time-based cooldown is NOT enough here: the prompt is
     *     re-published while the user is deciding, and re-publishing changed the
     *     dedupe key, so a toast went out again and again — the "提示一直弹" bug.
     * @param collected - the freshly collected state.
     */
    function announce(collected) {
      var now = Date.now()
      var seen = {}
      var liveQuestions = {}
      collected.rows.forEach(function (entry) {
        seen[entry.id] = true
        var pending = entry.pending
        if (pending !== null && pending !== undefined) {
          var questionKey = interactionKey(entry.id, pending)
          liveQuestions[questionKey] = true
          if (shared.notified[questionKey] === undefined) {
            shared.notified[questionKey] = now
            notify(t.question, entry.title + " · " + t.waiting, { kind: "question", at: new Date().toISOString(), sessionId: entry.id })
          }
        }
        if (entry.running === true) {
          shared.running[entry.id] = true
          shared.phase[entry.id] = "running"
          return
        }
        if (shared.phase[entry.id] === "running") {
          shared.notified[entry.id + ":done"] = now
          // Whether to say anything at all depends on WHY the run stopped, which only
          // the session log knows; see `announceTurnEnd`.
          announceTurnEnd(entry)
        }
        shared.running[entry.id] = false
        shared.phase[entry.id] = "idle"
      })
      // Forget an interaction once it is answered: if the same question is asked again
      // later, that is a new moment and deserves its own notification. Completion marks
      // are aged out instead, so a session that flaps cannot announce repeatedly.
      Object.keys(shared.notified).forEach(function (key) {
        if (key.endsWith(":done")) {
          if (now - Number(shared.notified[key]) > ONCE_MS) delete shared.notified[key]
          return
        }
        if (liveQuestions[key] !== true) delete shared.notified[key]
      })
      Object.keys(shared.running).forEach(function (id) {
        if (seen[id] !== true) delete shared.running[id]
      })
      Object.keys(shared.runs).forEach(function (id) {
        if (seen[id] !== true) delete shared.runs[id]
      })
    }

    /**
     * A stable identity for one pending interaction.
     *
     * The framework stamps every pending interaction with a unique `key`; the fallbacks
     * keep an interaction that carries none announceable exactly once instead of on
     * every re-publish.
     * @param sessionId - the session that waits.
     * @param pending - the interaction object.
     * @returns the dedupe key.
     */
    function interactionKey(sessionId, pending) {
      var own = pending === null || pending === undefined ? undefined : pending.key ?? pending.requestId ?? pending.id
      if (own !== undefined && own !== null && String(own) !== "") return String(sessionId) + ":ask:" + String(own)
      return String(sessionId) + ":ask:" + String(pending.kind ?? pending.type ?? JSON.stringify(pending))
    }
    //#endregion

    //#region cells
    /** The button glyph: a small checklist. */
    function icon() {
      return jsx("svg", {
        width: 15,
        height: 15,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.4,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
        children: [
          jsx("path", { key: "a", d: "M2.5 4.5l1.6 1.6L7 3.2" }),
          jsx("path", { key: "b", d: "M2.5 11.3l1.6 1.6 2.9-2.9" }),
          jsx("path", { key: "c", d: "M9 5h4.5" }),
          jsx("path", { key: "d", d: "M9 11.8h4.5" }),
        ],
      })
    }

    /** The badge text of the composer button: `3/5`. */
    function badgeText(todos) {
      var summary = todoSummary(todos)
      if (summary.total === 0) return ""
      return summary.done + "/" + summary.total
    }

    /**
     * The composer button: the `conversation.input.left` cell.
     *
     * It matches the shipped neighbours' geometry (28px tall, `label-secondary`,
     * `radius-sm`, hover background) so it reads as part of the tool row, and it
     * carries the `done/total` badge plus a dot while the session is running.
     * @param props - the slot's framework props (session, hooks, translator).
     * @returns the button.
     */
    function TaskTrackerButton(props) {
      // HOOK ORDER IS THE CONTRACT.
      //
      // `props.useProjection` and `props.useSessionStatus` are
      // `useSyncExternalStore` selector hooks, and React counts the calls: a hook
      // that runs on one render and not the next throws "Rendered more hooks than
      // during the previous render" (minified #310), after which the framework
      // retires the whole cell and the button is gone for good. So every call below
      // happens on EVERY render, with no capability test in front of it. The slot
      // framework guarantees the existence of the sources a slot declares (a
      // missing one is a loud `SlotAssemblyError`, not a silent undefined), so a
      // fallback hook here would only add a way to change the call sequence.
      var todos = props.useProjection("todos")
      var tokenUsage = props.useProjection("tokenUsage")
      var sessionStats = props.useProjection("sessionStats")
      var statusMap = props.useSessionStatus(identity)
      var status = statusMap !== undefined && statusMap !== null && typeof statusMap.get === "function" && props.sessionId !== undefined
        ? statusMap.get(props.sessionId)
        : undefined
      var running = status !== null && status !== undefined && status.running === true
      var waiting = status !== null && status !== undefined && status.pendingInteraction !== null && status.pendingInteraction !== undefined
      var badge = badgeText(todos)
      React.useEffect(function () {
        noteDiagnostic({ entryInvokedAt: new Date().toISOString() })
      }, [])
      // Hand the newest snapshots to the one-second tick: it composes the view the
      // window renders, and it must keep doing that while this cell is unmounted.
      shared.currentSessionId = props.sessionId
      shared.snapshots.projections = { todos: todos, tokenUsage: tokenUsage, sessionStats: sessionStats }
      var tone = running ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-label-tertiary)"
      return jsxs("button", {
        type: "button",
        title: t.title,
        "aria-label": t.title,
        "data-dsh-task-tracker": "trigger",
        onClick: function () {
          // A second click closes what the first one opened: without the toggle,
          // `window.open` on an existing window name returns a NEW blank window, so
          // every click stacked another empty frame.
          toggleWindow()
          beat({ mode: "click", slot: "left", window: shared.popupMode })
        },
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          height: "28px",
          padding: "0 8px",
          border: "none",
          borderRadius: "var(--dsw-radius-sm, 6px)",
          background: "transparent",
          color: waiting ? "var(--dsw-alias-state-warning-primary)" : "var(--dsw-alias-label-secondary)",
          font: "inherit",
          fontSize: "13px",
          fontWeight: 500,
          lineHeight: "20px",
          cursor: "pointer",
          flex: "none",
          maxWidth: "160px",
        },
        onMouseEnter: function (event) { event.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover)" },
        onMouseLeave: function (event) { event.currentTarget.style.background = "transparent" },
        children: [
          jsx("span", { key: "glyph", style: { display: "inline-flex", flex: "none" }, children: icon() }),
          badge === ""
            ? null
            : jsx("span", { key: "badge", style: { fontVariantNumeric: "tabular-nums" }, children: badge }),
          running
            ? jsx("span", {
                key: "dot",
                style: { width: "6px", height: "6px", borderRadius: "50%", background: tone, flex: "none" },
              })
            : null,
        ],
      })
    }

    /**
     * The frame-wide monitor: root scope, so it sees every session.
     *
     * It renders nothing. Its jobs are to keep the overlay seat warm (a cell in a
     * seat that provably renders), to publish the root-scoped sources the one-second
     * tick reads, and to expose the live numbers to `/health` so "did it load, and
     * does the composer hold the button?" is answerable with one HTTP GET from
     * outside the app.
     * @param props - the overlay slot's framework props.
     * @returns null.
     */
    function TaskTrackerMonitor(props) {
      // Same rule as the composer cell: one fixed hook sequence, on every render.
      var sessionsSnapshot = props.useSessions(identity)
      var statusSnapshot = props.useSessionStatus(identity)
      var workspacesSnapshot = props.useWorkspaces(identity)
      // Root scope: this cell sees every session, so it is the one that keeps the
      // frame-wide sources fresh for the tick.
      shared.snapshots.sessions = sessionsSnapshot
      shared.snapshots.status = statusSnapshot
      shared.snapshots.workspaces = workspacesSnapshot
      var collected = collect(sessionsSnapshot, statusSnapshot, workspacesSnapshot)
      // Reported per render on purpose: a render update proves the outlet wired this
      // cell, and an effect keyed on the snapshots would miss a re-render with
      // unchanged data. It fires even with no sessions, so "the cell never rendered"
      // stays distinguishable from "there was nothing to report".
      beat({
        mode: "monitor",
        projects: collected.projects.length,
        sessions: collected.rows.length,
        running: collected.rows.filter(function (entry) { return entry.running === true }).length,
        window: shared.windowOpen === true,
        left: slotIds(SLOT_LEFT),
        overlay: slotIds(SLOT_OVERLAY),
        button: buttonProbe(),
      })
      React.useEffect(function () {
        noteDiagnostic({ monitorRenderedAt: new Date().toISOString(), visibleSessions: collected.rows.length })
      }, [sessionsSnapshot, statusSnapshot, workspacesSnapshot])
      React.useEffect(function () {
        void checkForNewerBundle()
      }, [])
      return null
    }

    /**
     * What the composer's button looks like from the DOM, for the heartbeat.
     *
     * The slot registry answers "is a cell registered"; this answers "is a button
     * actually in the composer tool row", which is the question a missing button
     * raises. The rect is included so the placement (left of the input, right of the
     * permission chip) can be checked from a health reading alone.
     * @returns `{ found, rect, composer }`.
     */
    function buttonProbe() {
      try {
        if (typeof document === "undefined") return { found: false }
        var node = document.querySelector('[data-dsh-task-tracker="trigger"]')
        if (node === null) return { found: false }
        var rect = node.getBoundingClientRect()
        var field = document.querySelector("textarea")
        var fieldRect = field === null ? null : field.getBoundingClientRect()
        // Hit test: a button can be painted and still be unreachable because
        // something transparent sits on top of it — which is exactly how a docked
        // overlay button used to behave.
        var hit = null
        try {
          hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2))
        } catch (error) {
          hit = null
        }
        return {
          found: true,
          rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
          input: fieldRect === null ? undefined : { left: Math.round(fieldRect.left), top: Math.round(fieldRect.top), width: Math.round(fieldRect.width) },
          leftOfInput: fieldRect === null ? undefined : rect.left < fieldRect.left + fieldRect.width,
          clickable: hit !== null && (hit === node || node.contains(hit)),
        }
      } catch (error) {
        return { found: false, error: String((error && error.message) || error) }
      }
    }

    /**
     * The version stamp of the bundle this page is actually being served.
     *
     * The page can be running an older copy than the one on disk (the module table
     * rejects a second registration for the same id), so the only way to know what is
     * really current is to fetch the bundle and read its stamp.
     * @returns the served version, or undefined when it cannot be read.
     */
    async function servedVersion() {
      try {
        var boot = globalThis.__DSH_BOOT__
        var entry = boot === undefined || boot === null || !Array.isArray(boot.entries)
          ? undefined
          : boot.entries.filter(function (row) { return row.id === "dsh-task-tracker" })[0]
        if (entry === undefined || typeof entry.url !== "string") {
          noteDiagnostic({ servedVersionError: "no boot entry" })
          return undefined
        }
        var response = await fetch("/" + entry.url, { cache: "no-store" })
        if (!response.ok) {
          noteDiagnostic({ servedVersionError: "http " + response.status })
          return undefined
        }
        var match = /var VERSION = "([^"]+)"/u.exec(await response.text())
        if (match === null) noteDiagnostic({ servedVersionError: "no version in the served body" })
        return match === null ? undefined : match[1]
      } catch (error) {
        // The app page lives on a custom scheme, and `fetch` there can be refused
        // outright; recording WHY is the only way to tell that apart from a bundle that
        // genuinely carries no version.
        noteDiagnostic({ servedVersionError: String((error && error.message) || error) })
        return undefined
      }
    }

    /**
     * Reload the page once, for a version we have already tried to reload for.
     *
     * A client bundle is loaded once per page and the module table rejects a second
     * registration for the same id, so after an update the page keeps running the old
     * copy — with its old timers and its old cells. The desktop build binds no reload
     * shortcut, so asking the document to reload itself is the only way to pick a new
     * version up. The `sessionStorage` marker holds it to one attempt per version, so a
     * bundle that keeps disagreeing cannot loop.
     * @param version - the version the reload is for.
     * @param note - the diagnostic fields to record.
     * @returns whether a reload was scheduled.
     */
    function reloadFor(version, note) {
      var marker = "dsh-task-tracker:reloadedFor"
      try {
        if (globalThis.sessionStorage.getItem(marker) === version) {
          noteDiagnostic(Object.assign({ reloadSkippedFor: version }, note))
          return false
        }
        globalThis.sessionStorage.setItem(marker, version)
        noteDiagnostic(Object.assign({ reloadingFor: version, wasVersion: VERSION }, note))
        // Give the write a moment to land before the document goes away.
        globalThis.setTimeout(function () { globalThis.location.reload() }, 250)
        return true
      } catch (error) {
        return false
      }
    }

    /**
     * Reload the page when the served bundle is no longer this one.
     * @returns a promise that settles when the check is done.
     */
    async function checkForNewerBundle() {
      var served = await servedVersion()
      if (served === undefined || served === VERSION) return
      reloadFor(served)
    }

    /** The identity selector every snapshot hook is called with. */
    function identity(snapshot) {
      return snapshot
    }
    //#endregion

    //#region plugin
    /** The services this entry needs — `slots` alone is enough to register cells. */
    var inject = ["slots"]

    /**
     * What the slot registry holds for one key, as seen by this plugin.
     *
     * A cell can be present in the ledger and still never be invoked (the composer's
     * outlet re-renders from the registry version, so the usual cause is an entry
     * that never won its cell). `entryInvokedAt` is the component's own proof that
     * it rendered; this is the registry's side of the same question, and both travel
     * in `/health` so one HTTP GET answers "is the button there?" from outside.
     * @param key - the slot key.
     * @returns `{ ids, error }`.
     */
    function slotIds(key) {
      try {
        if (ctx === undefined || ctx === null) return { ids: [] }
        var entries = ctx.slots.entriesOfSlot(key)
        return { ids: (entries ?? []).map(function (entry) { return String(entry.options.id ?? "?") }) }
      } catch (error) {
        return { ids: [], error: String((error && error.message) || error) }
      }
    }

    /**
     * Install the tracker.
     * @param ctx - the client plugin context (a guarded facade).
     */
    function apply(context) {
      ctx = context
      try {
        var current = context.locale === undefined || context.locale === null ? undefined : context.locale.current ?? context.locale.locale
        if (typeof current === "string" && current.toLowerCase().indexOf("en") === 0) t = TEXT.en
      } catch (error) {
        /* the default dictionary is Chinese */
      }
      context.slots.inject(SLOT_LEFT, function () {
        return context.slots.register(
          { name: SLOT_LEFT, id: "task-tracker", order: 30, locale: NS },
          TaskTrackerButton,
        )
      })
      context.slots.inject(SLOT_OVERLAY, function () {
        return context.slots.register(
          { name: SLOT_OVERLAY, id: "task-tracker-monitor", order: 40, locale: NS },
          TaskTrackerMonitor,
        )
      })
      // THE NEWEST ACTIVATION OWNS THE TICK.
      //
      // A bundle update is loaded into a page whose previous copy is still running,
      // and that previous copy's interval is what keeps composing the view. Leaving it
      // alone "so the tick is not lost" was exactly backwards: the pane then went on
      // showing the behaviour the update was written to replace — the file on disk was
      // fixed, the served bundle was fixed, and the window still showed the old logic,
      // so the same complaint came back after every fix. What has to survive a hot
      // reload is the shared state (navigation, window handle, notification marks),
      // never the timer.
      //
      // "Latest activation wins" is the ONLY rule that cannot wedge the page. An earlier
      // version of this code refused to take over from a copy whose stamp looked NEWER,
      // to keep an out-of-order activation from re-arming a stale timer — but that made
      // a stamp that moved BACKWARDS (a renumbering, or a rollback) lose to the code it
      // replaced, and
      // nothing could heal it: the old interval kept driving, which is the very failure
      // this block exists to prevent. An activation can only happen for what the loader
      // just loaded, and after an update that is always the newer file, so the arrival
      // order IS the freshness order.
      var previousOwner = shared.tickOwner
      if (shared.stop !== null && shared.stop !== undefined) globalThis.clearInterval(shared.stop)
      shared.tickOwner = VERSION
      shared.stop = globalThis.setInterval(function () {
        void tick()
      }, 1000)
      noteDiagnostic({
        appliedAt: new Date().toISOString(),
        version: VERSION,
        tickOwner: VERSION,
        ...previousOwner === undefined || previousOwner === VERSION
          ? {}
          : { tickTakenFrom: previousOwner, tickLooksNewer: isNewerVersion(VERSION, previousOwner) },
      })
      // The first beat reports the registry, so a page that loaded without rendering
      // a single cell is still diagnosable from outside the app.
      beat({ mode: "apply", left: slotIds(SLOT_LEFT), overlay: slotIds(SLOT_OVERLAY) })
    }

    exports.VERSION = VERSION
    exports.inject = inject
    exports.apply = apply
    /** Test hooks: the pure half of this file is exercised without a DOM. */
    exports.__test = {
      collect: collect,
      composeView: composeView,
      todoSummary: todoSummary,
      sumUsage: sumUsage,
      tokenText: tokenText,
      projectName: projectName,
      isNewerVersion: isNewerVersion,
      durationText: durationText,
      runText: runText,
      trackRun: trackRun,
      announceTurnEnd: announceTurnEnd,
      logNotification: logNotification,
      checkForNewerBundle: checkForNewerBundle,
      projectMeta: projectMeta,
      sessionMeta: sessionMeta,
      isHidden: isHidden,
      navigate: navigate,
      goBack: goBack,
      readSessions: readSessions,
      readWorkspaces: readWorkspaces,
      paletteOf: paletteOf,
      blend: blend,
      parseColor: parseColor,
      solid: solid,
      buildPanel: buildPanel,
      badgeText: badgeText,
      toggleWindow: toggleWindow,
      openWindow: openWindow,
      closeWindow: closeWindow,
      isWindowOpen: isWindowOpen,
      shared: shared,
      setSources: function (sources) { Object.assign(shared, sources) },
    }
    //#endregion

    return module.exports
  },
})
