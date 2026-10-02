/**
 * dsh-task-tracker — desktop shell patch (B1).
 *
 * WHY: the shipped desktop shell denies every `window.open` from the main
 * window (`lib/main.js`, the main window's `setWindowOpenHandler`), and Electron
 * refuses the Document Picture-in-Picture request, so a plugin cannot create a
 * window owned by DeepSeek Harness. This patch allows exactly ONE popup — the
 * marker URL `about:blank#dsh-task-tracker` — so the Task_Tracker plugin can put
 * its panel in a real, app-owned window (same taskbar entry, closes with the
 * app) instead of a spawned browser window.
 *
 * HOW: the patch is surgical. It appends the patched `lib/main.js` at the END of
 * `app.asar` and redirects that one header entry at it. The header JSON is
 * rewritten to the SAME byte length (padded with spaces, which JSON ignores), so
 * the data section does not move and the other ~12 900 entries keep their exact
 * offsets and bytes. Nothing else in the archive is touched.
 *
 * Usage:
 *   node tools/shell-patch.mjs --status
 *   node tools/shell-patch.mjs --build            # writes app.asar.patched, verifies it
 *   node tools/shell-patch.mjs --apply [--wait]   # needs the app closed (or waits for it)
 *   node tools/shell-patch.mjs --revert
 *   node tools/shell-patch.mjs --verify <asar>
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { openAsar, closeAsar, readEntry, walkEntries, findEntry, readFileText } from './asar-lib.mjs'

/** Default install location of the Windows desktop build. */
const DEFAULT_ASAR = join(
  process.env.LOCALAPPDATA ?? '',
  'Programs',
  'DeepSeek Harness',
  'resources',
  'app.asar',
)

/** The desktop executable that sits next to `resources/`. */
const appExe = join(dirname(dirname(DEFAULT_ASAR)), 'DeepSeek Harness.exe')

/** Start the desktop app again after a successful swap. */
function launchApp() {
  try {
    const child = spawn(appExe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', () => {})
    child.unref()
    return true
  } catch (error) {
    return false
  }
}

/** The exact shipped handler this patch replaces. */
const ORIGINAL_HANDLER = `\twindow.webContents.setWindowOpenHandler(({ url }) => {
\t\tif (["http:", "https:"].includes(new URL(url).protocol)) shell.openExternal(url);
\t\treturn { action: "deny" };
\t});`

/** The replacement: one marker URL opens an app-owned window, everything else keeps the shipped policy. */
const PATCHED_HANDLER = `\twindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
\t\t// Task_Tracker (B1): allow ONLY the plugin's marker popup, so its panel can
\t\t// live in a window owned by this app. Every other target keeps the shipped
\t\t// policy below (external links open in the browser, everything else denied).
\t\tif (url === "about:blank#dsh-task-tracker") return {
\t\t\taction: "allow",
\t\t\toverrideBrowserWindowOptions: {
\t\t\t\twidth: 460,
\t\t\t\theight: 780,
\t\t\t\tminWidth: 340,
\t\t\t\tminHeight: 320,
\t\t\t\tautoHideMenuBar: true,
\t\t\t\ttitle: "任务追踪",
\t\t\t\tbackgroundColor: "#151517",
\t\t\t\t// Stay above other applications, so watching a run while working
\t\t\t\t// elsewhere does not mean losing the window behind them. Minimizing is
\t\t\t\t// still the user's own decision and behaves normally — a minimized
\t\t\t\t// window is not in anybody's way.
\t\t\t\talwaysOnTop: true
\t\t\t}
\t\t};
\t\tif (["http:", "https:"].includes(new URL(url).protocol)) shell.openExternal(url);
\t\treturn { action: "deny" };
\t});`

const MARKER = 'about:blank#dsh-task-tracker'

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(name + ' 需要一个值（例如 --asar "C:\\path\\to\\app.asar"）')
  }
  return value
}

const asarPath = argument('--asar', DEFAULT_ASAR)
const backupPath = asarPath + '.orig'
const patchedPath = asarPath + '.patched'

/** sha256 hex of one buffer. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Whether the running app currently holds the archive open. */
function isLocked(file) {
  try {
    const fd = openSync(file, 'r+')
    closeSync(fd)
    return false
  } catch (error) {
    return error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES'
  }
}

/**
 * Whether the desktop app is running at all. Windows lets a mapped archive be
 * opened for writing, so the write probe alone is not enough to decide that it
 * is safe to replace the file.
 */
function appRunning() {
  if (process.platform !== 'win32') return false
  try {
    const output = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8' })
    return /DeepSeek Harness\.exe/iu.test(output)
  } catch (error) {
    // Failing OPEN here would replace the archive while the app is using it; an
    // unanswerable probe therefore counts as "still running" and the caller waits
    // or refuses, which is always recoverable.
    return true
  }
}

/** Whether replacing the archive right now is unsafe. */
function isHeld(file) {
  return appRunning() || isLocked(file)
}

/** Apply the source patch to the main.js text, asserting it matched exactly once. */
function patchMainJs(text) {
  const occurrences = text.split(ORIGINAL_HANDLER).length - 1
  if (occurrences !== 1) {
    throw new Error(`expected exactly one shipped setWindowOpenHandler block, found ${occurrences}`)
  }
  if (text.includes(MARKER)) throw new Error('main.js already carries the marker')
  return text.replace(ORIGINAL_HANDLER, PATCHED_HANDLER)
}

/**
 * Build a patched archive next to the original.
 * @param source - archive to patch.
 * @param destination - archive to write.
 * @returns a summary of the rewrite.
 */
function build(source, destination) {
  const original = readFileSync(source)
  const archive = openAsar(source)
  try {
    if (archive.jsonStart !== 16) throw new Error('unexpected header layout (jsonStart !== 16)')
    const entry = findEntry(archive.header, 'lib/main.js')
    if (entry === undefined) throw new Error('lib/main.js not found in the archive')
    const mainJs = readEntry(archive, entry)
    const patchedText = patchMainJs(mainJs.toString('utf8'))
    const patchedBuffer = Buffer.from(patchedText, 'utf8')

    // Redirect that one entry at the appended copy.
    const appendedOffset = original.length - archive.dataStart
    entry.size = patchedBuffer.length
    entry.offset = String(appendedOffset)
    // Keep the entry self-consistent: the archive carries sha256 integrity data
    // (per file, and per 4 MiB block) even though the fuse that validates it is
    // disabled on this build.
    entry.integrity = { algorithm: 'SHA256', hash: sha256(patchedBuffer), blockSize: 4194304, blocks: [sha256(patchedBuffer)] }

    let json = JSON.stringify(archive.header)
    if (json.length > archive.jsonLen) {
      // The integrity record is the expensive part; drop it for this one entry
      // when the header would otherwise grow (the fuse does not check it).
      delete entry.integrity
      json = JSON.stringify(archive.header)
    }
    if (json.length > archive.jsonLen) {
      throw new Error(`patched header is ${json.length - archive.jsonLen} bytes too long`)
    }
    // Pad with spaces so the JSON keeps its exact byte length: JSON.parse ignores
    // them, and an unchanged length means the data section never moves.
    const padded = json + ' '.repeat(archive.jsonLen - json.length)
    const head = original.subarray(0, archive.jsonStart)
    const tail = original.subarray(archive.jsonStart + archive.jsonLen)
    const patched = Buffer.concat([head, Buffer.from(padded, 'utf8'), tail, patchedBuffer])
    writeFileSync(destination, patched)
    return {
      originalSize: original.length,
      patchedSize: patched.length,
      mainJsSize: patchedBuffer.length,
      appendedOffset,
      headerPadded: archive.jsonLen - json.length,
      integrity: entry.integrity === undefined ? 'dropped' : 'rewritten',
    }
  } finally {
    closeAsar(archive)
  }
}

/** Compare one archive against the source archive: everything but main.js must be identical. */
function verify(source, candidate) {
  const before = openAsar(source)
  const after = openAsar(candidate)
  try {
    const entriesBefore = walkEntries(before.header)
    const entriesAfter = walkEntries(after.header)
    if (entriesBefore.length !== entriesAfter.length) {
      throw new Error(`entry count changed: ${entriesBefore.length} → ${entriesAfter.length}`)
    }
    let compared = 0
    let changed = 0
    for (let index = 0; index < entriesBefore.length; index += 1) {
      const left = entriesBefore[index]
      const right = entriesAfter[index]
      if (left.path !== right.path) throw new Error(`entry order changed at ${index}: ${left.path} vs ${right.path}`)
      if (left.entry.unpacked === true || right.entry.unpacked === true) {
        if (left.entry.unpacked !== right.entry.unpacked) throw new Error(`unpacked flag changed for ${left.path}`)
        continue
      }
      const leftBytes = readEntry(before, left.entry)
      const rightBytes = readEntry(after, right.entry)
      if (leftBytes.equals(rightBytes)) {
        compared += 1
        continue
      }
      if (left.path !== 'lib/main.js') throw new Error(`unexpected change in ${left.path}`)
      if (!rightBytes.toString('utf8').includes(MARKER)) throw new Error('lib/main.js changed without the marker')
      changed += 1
    }
    if (changed !== 1) throw new Error(`expected exactly one changed entry, got ${changed}`)
    return { compared, changed, entries: entriesBefore.length }
  } finally {
    closeAsar(before)
    closeAsar(after)
  }
}

/** What the installed archive currently is. */
function status() {
  const installed = existsSync(asarPath)
  let marker = false
  let entries = 0
  if (installed) {
    const archive = openAsar(asarPath)
    try {
      const entry = findEntry(archive.header, 'lib/main.js')
      if (entry !== undefined) marker = readEntry(archive, entry).toString('utf8').includes(MARKER)
      entries = walkEntries(archive.header).length
    } finally {
      closeAsar(archive)
    }
  }
  console.log('archive        : ' + asarPath)
  console.log('installed      : ' + (installed ? statSync(asarPath).size + ' bytes, ' + entries + ' entries' : 'missing'))
  console.log('patched        : ' + (marker ? 'YES (marker present)' : 'no'))
  console.log('backup         : ' + (existsSync(backupPath) ? backupPath : 'none'))
  console.log('staged         : ' + (existsSync(patchedPath) ? patchedPath : 'none'))
  console.log('app running    : ' + (appRunning() ? 'YES (close DSH before applying)' : 'no'))
  console.log('archive held   : ' + (installed && isLocked(asarPath) ? 'YES' : 'no'))
}

/** Replace the installed archive with the staged one, keeping a backup. */
async function apply({ wait }) {
  const wasRunning = appRunning()
  console.log('')
  console.log('============================================================')
  console.log(' DeepSeek Harness 外壳补丁（Task_Tracker B1）')
  console.log('============================================================')
  console.log(' 做什么：允许插件开一个「属于 DSH 自己」的窗口（现在是 Edge 窗口）。')
  console.log(' 代价  ：只改 app.asar 里的一个条目，其余文件逐字节不变；')
  console.log('         原文件备份为 app.asar.orig，可用 revert 脚本一键还原。')
  if (wasRunning) {
    console.log('')
    console.log(' 【现在请从托盘退出 DeepSeek Harness】')
    console.log(' 本工具会自动等待它退出 → 备份 → 替换 → 校验 → 重新启动。')
    console.log(' 10 分钟内未退出则安全失败，不会改动任何文件。')
  }
  console.log('============================================================')
  console.log('')
  if (!existsSync(asarPath)) throw new Error('找不到归档：' + asarPath)
  if (!existsSync(patchedPath)) {
    console.log('还没有暂存的补丁，先生成一个…')
    console.log(JSON.stringify(build(asarPath, patchedPath), null, 1))
  }
  if (wait) {
    const startedAt = Date.now()
    const deadline = startedAt + 10 * 60 * 1000
    let reported = 0
    while (isHeld(asarPath) && Date.now() < deadline) {
      const waited = Math.round((Date.now() - startedAt) / 1000)
      if (waited - reported >= 10) {
        reported = waited
        console.log('  等待 DeepSeek Harness 退出… 已等待 ' + waited + ' 秒')
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  if (isHeld(asarPath)) throw new Error('应用仍在运行或仍占用归档；请退出 DeepSeek Harness 后重试')
  if (!existsSync(backupPath)) {
    copyFileSync(asarPath, backupPath)
    console.log('已备份原文件：' + backupPath)
  }
  const previous = asarPath + '.replaced'
  // Move the original aside rather than deleting it, then RENAME the staged file
  // into place: a rename is atomic, while the earlier "copy over" left a window
  // in which app.asar was truncated — an interrupt there bricks the app.
  renameSync(asarPath, previous)
  try {
    renameSync(patchedPath, asarPath)
  } catch (error) {
    renameSync(previous, asarPath)
    throw error
  }
  try {
    const result = verify(previous, asarPath)
    console.log('已替换并通过校验：' + JSON.stringify(result))
  } catch (error) {
    // A candidate that does not verify would leave the app unable to start: put
    // back the very file we moved aside (not the backup, which may itself be
    // stale or truncated) before reporting the failure.
    renameSync(asarPath, patchedPath)
    renameSync(previous, asarPath)
    throw new Error('补丁归档校验失败，已自动回滚原文件：' + (error && error.message))
  }
  rmSync(previous, { force: true })
  if (wasRunning && existsSync(appExe)) {
    console.log('正在重新启动 DeepSeek Harness…')
    launchApp()
  } else {
    console.log('请手动启动 DeepSeek Harness 以加载补丁后的外壳。')
  }
}

/** Put the backup back. */
async function revert({ wait }) {
  if (!existsSync(backupPath)) throw new Error('没有备份文件：' + backupPath)
  const wasRunning = appRunning()
  console.log('')
  console.log(' 还原 DeepSeek Harness 外壳（撤销 Task_Tracker B1 补丁）')
  console.log(' 备份：' + backupPath)
  if (wasRunning) console.log(' 【现在请从托盘退出 DeepSeek Harness】，本工具会自动等待。')
  if (wait) {
    const deadline = Date.now() + 10 * 60 * 1000
    while (isHeld(asarPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  if (isHeld(asarPath)) throw new Error('应用仍在运行或仍占用归档；请退出 DeepSeek Harness 后重试')
  copyFileSync(backupPath, asarPath)
  console.log('已从备份还原原文件。')
  if (wasRunning && existsSync(appExe)) {
    console.log('正在重新启动 DeepSeek Harness…')
    launchApp()
  }
}

/** Whether the INSTALLED archive already carries the patch. */
function installedIsPatched() {
  if (!existsSync(asarPath)) return false
  const archive = openAsar(asarPath)
  try {
    const entry = findEntry(archive.header, 'lib/main.js')
    return entry !== undefined && readEntry(archive, entry).toString('utf8').includes(MARKER)
  } finally {
    closeAsar(archive)
  }
}

/**
 * The archive to patch FROM.
 *
 * Re-patching needs the PRISTINE archive: the installed one already carries the previous
 * patch, so the shipped handler this patch matches on is gone and a build would fail with
 * "found 0". The backup the first apply made is exactly that pristine archive, so it is
 * the source whenever the installed one is patched — which is the normal state after any
 * change to this patch, or after an app update restored the archive.
 * @returns the path to read.
 */
function buildSource() {
  if (existsSync(backupPath) && installedIsPatched()) {
    console.log('source         : ' + backupPath + ' (the installed archive is already patched)')
    return backupPath
  }
  return asarPath
}

//#region command line
try {
  if (process.argv.includes('--status')) {
    status()
  } else if (process.argv.includes('--build')) {
    const source = buildSource()
    const summary = build(source, patchedPath)
    console.log('built: ' + patchedPath)
    console.log(JSON.stringify(summary, null, 1))
    console.log('verify: ' + JSON.stringify(verify(source, patchedPath)))
  } else if (process.argv.includes('--verify')) {
    const candidate = argument('--verify', patchedPath)
    console.log('verify: ' + JSON.stringify(verify(buildSource(), candidate === true ? patchedPath : candidate)))
  } else if (process.argv.includes('--apply')) {
    await apply({ wait: process.argv.includes('--wait') })
  } else if (process.argv.includes('--revert')) {
    await revert({ wait: process.argv.includes('--wait') })
  } else {
    console.log('usage: node tools/shell-patch.mjs --status | --build | --apply [--wait] | --revert | --verify <asar>')
    status()
  }
} catch (error) {
  console.error('error: ' + (error && error.message ? error.message : String(error)))
  process.exitCode = 1
}
//#endregion
