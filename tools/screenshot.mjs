/**
 * dsh-task-tracker — capture the desktop window so the button's position can be
 * checked by looking at it instead of guessing.
 *
 * Windows-only and dependency-free: a tiny C# program compiled at run time by the
 * bundled .NET Framework compiler prints the window rect (GDI), and the PNG itself
 * is written by the C# code as well, so no image library is needed.
 *
 * Usage:
 *   node tools/screenshot.mjs                  # the DSH window -> _shots/dsh.png
 *   node tools/screenshot.mjs --crop-composer  # a band around the composer tool row
 *   node tools/screenshot.mjs --out <file>
 *
 * The crop guesses the composer band from the window's bottom edge: the tool row
 * sits just above the bottom of the message area, which is where the trigger is
 * expected to be. It exists to make the buttons legible in a downscaled view.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outIndex = process.argv.indexOf('--out')
const out = resolve(outIndex >= 0 ? String(process.argv[outIndex + 1]) : join(root, '_shots', 'dsh.png'))
const crop = process.argv.includes('--crop-composer')
const bottomIndex = process.argv.indexOf('--bottom')
const bottom = bottomIndex >= 0 ? Number(process.argv[bottomIndex + 1]) : 0
// The task window is a second, separately titled window of the same process, so the
// title (or its size) has to be selectable.
const titleIndex = process.argv.indexOf('--title')
const title = titleIndex >= 0 ? String(process.argv[titleIndex + 1]) : 'DeepSeek Harness'
const sizeIndex = process.argv.indexOf('--size')
const size = sizeIndex >= 0 ? String(process.argv[sizeIndex + 1]).split('x').map(Number) : undefined
mkdirSync(dirname(out), { recursive: true })

const program = `
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public class Shot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  public static int Main(string[] args) {
    string outPath = args[0];
    bool crop = args.Length > 1 && args[1] == "crop";
    int bottom = args.Length > 2 && args[2] != "" ? int.Parse(args[2]) : 0;
    IntPtr handle = (IntPtr)long.Parse(args[args.Length - 1]);
    if (IsIconic(handle)) ShowWindow(handle, 9);
    SetForegroundWindow(handle);
    System.Threading.Thread.Sleep(400);
    RECT rect;
    if (!GetWindowRect(handle, out rect)) { Console.WriteLine("NO-RECT"); return 3; }
    // Clamp to the monitor work area: a window taller than the screen would
    // otherwise produce black bands the compositor never painted.
    MONITORINFO info = new MONITORINFO();
    info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    RECT work = rect;
    IntPtr monitor = MonitorFromWindow(handle, 2);
    if (monitor != IntPtr.Zero && GetMonitorInfo(monitor, ref info)) work = info.rcWork;
    int left = Math.Max(rect.Left, work.Left);
    int top = Math.Max(rect.Top, work.Top);
    int right = Math.Min(rect.Right, work.Right);
    int bottomEdge = Math.Min(rect.Bottom, work.Bottom);
    int width = right - left;
    int height = bottomEdge - top;
    if (width <= 0 || height <= 0) { Console.WriteLine("EMPTY window=" + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom + " work=" + work.Left + "," + work.Top + "," + work.Right + "," + work.Bottom); return 4; }
    using (Bitmap full = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
      using (Graphics graphics = Graphics.FromImage(full)) {
        graphics.CopyFromScreen(left, top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
      }
      Bitmap result = full;
      if (crop) {
        // The composer tool row lives just above the bottom of the message area.
        int bandHeight = Math.Min(height, Math.Max(220, height / 4));
        int bandTop = Math.Max(0, height - bandHeight - 8);
        result = full.Clone(new Rectangle(0, bandTop, width, bandHeight), PixelFormat.Format32bppArgb);
      } else if (bottom > 0) {
        int bandHeight = Math.Min(height, bottom);
        result = full.Clone(new Rectangle(0, height - bandHeight, width, bandHeight), PixelFormat.Format32bppArgb);
      }
      result.Save(outPath, ImageFormat.Png);
      Console.WriteLine("OK " + width + "x" + height + " window=" + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom + " work=" + work.Left + "," + work.Top + "," + work.Right + "," + work.Bottom);
      result.Dispose();
    }
    return 0;
  }
}
`

/**
 * The window to capture.
 *
 * Titles are matched in PowerShell, which mangles non-ASCII command-line arguments,
 * and the task window's title is Chinese — so selection happens in Node instead:
 * this returns every candidate window with its rect and title, and the caller
 * picks (by size first, which is unambiguous, then by title).
 * @returns `[{ handle, title, width, height }]`.
 */
function listWindows() {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
}
"@
$all = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
foreach ($p in $all) {
  if ($p.MainWindowHandle -eq 0) { continue }
  $rect = New-Object WinEnum+RECT
  [void][WinEnum]::GetWindowRect($p.MainWindowHandle, [ref]$rect)
  $builder = New-Object System.Text.StringBuilder 512
  [void][WinEnum]::GetWindowTextW($p.MainWindowHandle, $builder, 512)
  $title = $builder.ToString().Replace("\`t", ' ')
  Write-Output ("" + $p.MainWindowHandle.ToInt64() + "\`t" + ($rect.Right - $rect.Left) + "\`t" + ($rect.Bottom - $rect.Top) + "\`t" + $title)
}
`
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  const rows = []
  for (const line of output.split(/\r?\n/u)) {
    const parts = line.split('\t')
    if (parts.length < 4) continue
    const handle = Number(parts[0])
    if (!Number.isFinite(handle) || handle === 0) continue
    rows.push({ handle: String(handle), width: Number(parts[1]), height: Number(parts[2]), title: parts.slice(3).join('\t') })
  }
  return rows
}

const candidates = listWindows()
if (candidates.length === 0) {
  console.error('no DeepSeek Harness window found')
  process.exit(2)
}
let picked = size === undefined ? undefined : candidates.find((row) => row.width === size[0] && row.height === size[1])
if (picked === undefined) picked = candidates.find((row) => row.title.includes(title))
if (picked === undefined) picked = candidates[0]
if (process.env.DSH_DEBUG === '1') {
  for (const row of candidates) console.error('  candidate: ' + row.width + 'x' + row.height + ' | ' + row.title)
}
console.error('picked ' + picked.width + 'x' + picked.height + ' | ' + picked.title)
const handle = picked.handle
// A fresh file name per run: `Add-Type -OutputAssembly` fails when the target
// assembly already exists, and reusing one name made every second run die.
const stamp = String(Date.now()) + '-' + String(process.pid)
const source = join(process.env.TEMP ?? '.', 'dsh-screenshot-' + stamp + '.cs')
// The .NET Framework compiler wants UTF-16 with a BOM for non-ASCII; this program
// is ASCII-only, so plain UTF-8 without a BOM is fine.
writeFileSync(source, program, 'utf8')
try {
  // `System.Drawing` is not referenced by default in Windows PowerShell 5.1.
  const mode = crop ? 'crop' : 'full'
  const output = execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Add-Type -Path '${source}' -ReferencedAssemblies 'System.Drawing' -OutputAssembly '${source}.exe' -OutputType ConsoleApplication; & '${source}.exe' '${out}' '${mode}' '${bottom > 0 ? String(bottom) : ''}' '${handle}'`,
  ], { encoding: 'utf8' })
  process.stdout.write(output)
  console.log('wrote ' + out)
} catch (error) {
  process.stdout.write(String(error.stdout ?? ''))
  process.stderr.write(String(error.stderr ?? '').slice(0, 2000))
  process.exit(1)
}
