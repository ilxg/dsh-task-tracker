/**
 * dsh-task-tracker — reload the desktop window without restarting DSH.
 *
 * WHY: a client bundle is loaded once per page. The host rebuilds the graph and
 * the page re-imports a *changed* bundle, but a plugin's already-running copy
 * keeps its timers and its slot registrations, so a verification of a new version
 * needs a real page reload. Killing the app is not an option (it hosts the
 * session), so this sends the window the standard reload keystroke.
 *
 * The keystroke is only sent to the one window whose title matches, and Ctrl+R is
 * chosen because the desktop build binds it to "reload the page" rather than to
 * any editing action; `--key f5` sends F5 instead when a build binds that one.
 *
 * Usage:
 *   node tools/reload-window.mjs             # list the candidate windows
 *   node tools/reload-window.mjs --send      # focus it and send Ctrl+R
 *   node tools/reload-window.mjs --send --key f5
 *
 * Verification: run `curl http://127.0.0.1:17777/ping` before and after. The
 * browser half reports its own version through /health, so the version stamp is
 * the check that the page really reloaded.
 */

import { execFileSync } from 'node:child_process'

/** The window title the desktop build puts on its main window. */
const TITLE_HINTS = ['DeepSeek Harness', 'deepseek harness', 'DeepSeek']
const send = process.argv.includes('--send')
const keyIndex = process.argv.indexOf('--key')
const key = keyIndex >= 0 ? String(process.argv[keyIndex + 1]).toLowerCase() : 'ctrl+r'
if (!['ctrl+r', 'f5', 'f12'].includes(key)) {
  console.error('unknown --key ' + key + ' (use ctrl+r, f5 or f12)')
  process.exit(2)
}
/** The SendKeys spelling of each supported key. */
const KEY_TEXT = { 'ctrl+r': '^r', f5: '{F5}', f12: '{F12}' }

/**
 * One PowerShell that finds the window, reports it, and (with -Send) focuses it and
 * presses the key. Kept in a single process so the focus and the keystroke cannot
 * race another window stealing focus in between.
 */
const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$hints = @(${TITLE_HINTS.map((hint) => JSON.stringify(hint)).join(', ')})
$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' }
$matches = @($procs | Where-Object { $title = $_.MainWindowTitle; ($hints | Where-Object { $title -like ('*' + $_ + '*') }).Count -gt 0 })
if ($matches.Count -eq 0) {
  Write-Output 'NO-WINDOW'
  $procs | ForEach-Object { Write-Output ('  candidate: ' + $_.ProcessName + ' | ' + $_.MainWindowTitle) }
  exit 3
}
foreach ($window in $matches) { Write-Output ('window: ' + $window.ProcessName + ' | ' + $window.MainWindowTitle) }
if (-not ${send ? '$true' : '$false'}) { exit 0 }
$target = $matches[0]
$previous = [DshWin]::GetForegroundWindow()
[DshWin]::ShowWindow($target.MainWindowHandle, 9) | Out-Null
[System.Windows.Forms.SendKeys]::SendWait('%')
Start-Sleep -Milliseconds 250
[DshWin]::SetForegroundWindow($target.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 600
$focused = [DshWin]::GetForegroundWindow()
Write-Output ('focused: ' + ($focused -eq $target.MainWindowHandle))
${key === 'ctrl+r' ? "Write-Output 'sending Ctrl+R'" : "Write-Output 'sending " + key.toUpperCase() + "'"}
[System.Windows.Forms.SendKeys]::SendWait('${KEY_TEXT[key]}')
Start-Sleep -Milliseconds 400
if ($previous -ne [IntPtr]::Zero -and $previous -ne $target.MainWindowHandle) { [DshWin]::SetForegroundWindow($previous) | Out-Null }
Write-Output 'sent'
`

try {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  process.stdout.write(output)
} catch (error) {
  process.stdout.write(String(error.stdout ?? ''))
  process.stderr.write(String(error.stderr ?? ''))
  process.exit(error.status ?? 1)
}
