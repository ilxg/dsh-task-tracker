/**
 * dsh-task-tracker installer.
 *
 * Mounts (or unmounts) this plugin in a DSH profile without touching the
 * profile's package.json or pnpm lockfile — the desktop profile is owned by the
 * Electron application, and `dsh plugin` refuses to manage it:
 *
 *   1. a directory junction  <profile>/node_modules/dsh-task-tracker  →  this package
 *   2. one `insert` row in   <profile>/cordis.patch.yml
 *
 * Profile configuration is live: DSH recomposes within a few seconds of the
 * patch edit, and an open page then needs a refresh to load the client bundle.
 *
 * Usage:
 *   node tools/install.mjs            # status of the default desktop profile
 *   node tools/install.mjs --install  # mount (idempotent; backs up the patch file)
 *   node tools/install.mjs --uninstall
 *   node tools/install.mjs --profile web --install
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-task-tracker'
const ROW_ID = 'task-tracker'
const MARKER = '# >>> dsh-task-tracker (managed by tools/install.mjs)'
const END_MARKER = '# <<< dsh-task-tracker'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const KNOWN_FLAGS = ['--install', '--uninstall', '--status', '--help', '-h']

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} 需要一个值（例如 --profile desktop）`)
  }
  return value
}

function usage() {
  console.log(`dsh-task-tracker 安装器

用法：node tools/install.mjs [--install | --uninstall | --status] [选项]

选项
  --profile <name>   profile 名（默认 desktop，也可用环境变量 DSH_PROFILE）
  --help, -h         显示这段说明

环境变量
  DSH_HOME           DSH 主目录（默认 %USERPROFILE%\\.dsh）
  DSH_PROFILE        默认 profile 名
  DSH_PROFILE_DIR    直接指定 profile 目录（优先于 DSH_HOME + DSH_PROFILE）

不带动作时等同于 --status。`)
}

const unknown = process.argv.slice(2).filter((value) => value.startsWith('-') && !KNOWN_FLAGS.includes(value) && value !== '--profile')
if (unknown.length > 0) {
  console.error('未知参数：' + unknown.join(' '))
  usage()
  process.exit(2)
}
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage()
  process.exit(0)
}

const profileName = argument('--profile', process.env.DSH_PROFILE ?? 'desktop')
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = process.env.DSH_PROFILE_DIR ?? join(home, 'profiles', profileName)
const linkPath = join(profileDir, 'node_modules', PACKAGE)
const patchPath = join(profileDir, 'cordis.patch.yml')

/** The insert block this installer owns in the profile patch file. */
const BLOCK = [
  MARKER,
  '# Task_Tracker —— 输入框左侧的任务面板按钮 + 独立窗口 + 任务完成/出错/等待选择通知。',
  '# 第一行给浏览器半侧；第二行把 host 开窗服务单独挂一次：新加的模块 URL 不会被',
  '# Node 的 ESM 缓存命中，所以无需重启 DSH 就能生效（两行导入同一文件，服务自身幂等）。',
  '- insert:',
  `    - id: ${ROW_ID}`,
  `      name: ${PACKAGE}`,
  `    - id: ${ROW_ID}-window`,
  `      name: ${PACKAGE}/window`,
  END_MARKER,
].join('\n')

function readPatch() {
  return existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
}

/** The patch text with this installer's block present exactly once. */
function withBlock(text) {
  const without = stripBlock(text)
  const separator = without.endsWith('\n') || without === '' ? '' : '\n'
  return without + separator + BLOCK + '\n'
}

/** The patch text with this installer's block removed. */
function stripBlock(text) {
  const start = text.indexOf(MARKER)
  if (start < 0) return text
  const end = text.indexOf(END_MARKER, start)
  if (end < 0) return text
  const after = text.slice(end + END_MARKER.length)
  return text.slice(0, start) + after.replace(/^\r?\n/, '')
}

function report() {
  const mounted = existsSync(linkPath)
  const patched = readPatch().includes(MARKER)
  console.log('profile      : ' + profileDir)
  console.log('junction     : ' + (mounted ? 'present  ' + linkPath : 'missing'))
  console.log('patch row    : ' + (patched ? 'present  ' + patchPath : 'missing'))
  console.log('plugin root  : ' + pluginRoot)
  console.log('state        : ' + (mounted && patched ? 'MOUNTED' : mounted || patched ? 'PARTIAL' : 'NOT MOUNTED'))
  return mounted && patched
}

function install() {
  if (!existsSync(profileDir)) {
    console.error('profile directory not found: ' + profileDir)
    process.exit(2)
  }
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  if (existsSync(linkPath)) {
    console.log('junction already present: ' + linkPath)
  } else {
    symlinkSync(pluginRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    console.log('junction created: ' + linkPath + ' → ' + pluginRoot)
  }
  const text = readPatch()
  if (text.includes(BLOCK)) {
    console.log('patch row already present (unchanged)')
  } else {
    if (existsSync(patchPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
      const backup = patchPath + '.' + stamp + '.bak'
      copyFileSync(patchPath, backup)
      console.log('patch backup: ' + backup)
    }
    writeFileSync(patchPath, withBlock(text))
    console.log('patch row written to ' + patchPath)
  }
  console.log('\nDSH recomposes the profile within a few seconds; refresh the page to load the client bundle.')
}

function uninstall() {
  const text = readPatch()
  if (text.includes(MARKER)) {
    writeFileSync(patchPath, stripBlock(text))
    console.log('patch row removed from ' + patchPath)
  } else {
    console.log('patch row not present (nothing to remove)')
  }
  if (existsSync(linkPath)) {
    rmSync(linkPath, { recursive: false, force: true })
    console.log('junction removed: ' + linkPath)
  } else {
    console.log('junction not present (nothing to remove)')
  }
  console.log('\nRefresh the page; the button disappears after DSH recomposes.')
}

if (process.argv.includes('--install')) install()
else if (process.argv.includes('--uninstall')) uninstall()
else report()
