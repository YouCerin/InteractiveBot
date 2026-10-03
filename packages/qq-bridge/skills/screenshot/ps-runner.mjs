/**
 * 技能「截图」的执行层：把一份 `plan` 变成一张真的图。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三个"为什么不那样做"（都是实测踩出来的，改之前先读）
 * ══════════════════════════════════════════════════════════════════════════
 * ① **结果写文件，不从 stdout 拿**
 *    受限环境（含 DSH 自己的沙箱）会禁止"管道捕获子进程输出"，
 *    实测 `spawnSync(..., { stdio: 'pipe' })` 直接 `EPERM`。
 *    让 PowerShell 把结论写成一个 JSON 文件、Node 只读文件 —— 到处都能跑，
 *    而且失败原因是**结构化**的（不用去正则猜一行文本）。
 *
 * ② **脚本落成 .ps1 文件再 `-File` 执行，不用 `-Command` 传一大段**
 *    · 编码：PowerShell 5.1 对 `-Command` 的入参按**系统 ANSI 代码页**解释，
 *      脚本里只要有中文（错误文案、窗口标题）就会乱码；写成 **UTF-8 with BOM**
 *      的 .ps1 文件，5.1 与 7 都按 UTF-8 读，稳。
 *    · 引号：不用把整段脚本塞进字符串再转义一次，少一层出错面。
 *
 * ③ **绝不把模型给的字符串拼进脚本源码**
 *    窗口标题这类自由文本一律走**参数文件**（`-Params <json>`），脚本自己读。
 *    拼进去就是命令注入面（`'; Remove-Item ...` 那一类）。
 *    数字（region / 宽度 / 采样步长）在 `capture.js` 里已经夹过范围，
 *    但这里仍然再夹一次 —— 两道，因为这是唯一会碰系统 API 的地方。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 抓图方式（各用在哪）
 * ══════════════════════════════════════════════════════════════════════════
 *   · 屏幕 / 主屏：`BitBlt` 从桌面 DC 直接拷（虚拟桌面可以带负坐标，
 *     这是多显示器最常见的形状，`CopyFromScreen` 也能做但坐标系更容易出错）。
 *     失败或全黑时**再来一次** `CopyFromScreen`（GDI 与 DWM 在不同驱动上
 *     各有脾气，这一条是"别让一个 API 的脾气决定整个功能"）。
 *   · 窗口：`PrintWindow`（**被遮挡也能截到**，正是需求里要的那条）。
 *     最小化的窗口先 `ShowWindow(SW_RESTORE)`；DirectX 独占全屏的窗口
 *     `PrintWindow` 会给出黑图 —— 这种情况如实报，不假装成功。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { parseResult } from './capture.mjs'

/** 单次抓图的总超时（含进程启动）。实测正常路径 < 1s，给足余量。 */
export const DEFAULT_TIMEOUT_MS = 30_000

/* ── PowerShell 定位 ───────────────────────────────────────────────────── */

let cachedPsh = null

/**
 * 找一个能用的 PowerShell。
 *
 * 顺序：`pwsh`（7+，本机可能没装）→ `powershell.exe`（5.1，Windows 自带的那个）。
 * 用 `spawnSync(..., '-v')` 真跑一次，**不信 PATH 里有这个名字** ——
 * 和 `video-frames` 的 `findFfmpeg()` 同一条纪律（名字在 ≠ 能跑）。
 * 失败结果不缓存（用户可能刚装好），成功结果缓存。
 */
export function findPowerShell() {
  if (cachedPsh) return cachedPsh
  for (const name of ['pwsh', 'powershell.exe']) {
    const r = spawnSync(name, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (!r.error && r.status === 0) {
      cachedPsh = name
      return cachedPsh
    }
  }
  return ''
}

/** 测试用：清掉探测缓存。 */
export function resetPowerShellCache() {
  cachedPsh = null
}

/* ── 脚本源码 ──────────────────────────────────────────────────────────── */

/**
 * C# 辅助类：DPI 感知 + 桌面 DC + BitBlt + 窗口枚举/标题/区域 + PrintWindow。
 *
 * 为什么用 `Add-Type` 内联 C# 而不是 PowerShell 的 `Add-Type -AssemblyName`：
 * GDI32/User32 的这几个入口在 .NET 里**没有**托管封装，
 * 而 `Add-Type -MemberDefinition` 或内联 C# 是标准做法（无外部依赖）。
 * ⚠️ 这里**不使用** .NET 的 JPEG 编码器 —— 理由见 `capture.js` 文件头（会被杀毒软件拦）。
 */
const CS_SOURCE = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Shot {
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hDC);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hDC, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hDC, IntPtr h);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hDC);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
  [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr hDC, int index);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);

  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static bool MakeDpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; } catch {}
    try { return SetProcessDPIAware(); } catch { return false; }
  }

  public static IntPtr FindByTitle(string needle, out string title, out bool minimized) {
    IntPtr found = IntPtr.Zero; string foundTitle = null; bool foundMin = false;
    string want = (needle == null ? "" : needle.Trim().ToLowerInvariant());
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      StringBuilder sb = new StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      string t = sb.ToString();
      if (t.Length == 0) return true;
      if (t.ToLowerInvariant().IndexOf(want) >= 0) {
        found = h; foundTitle = t; foundMin = IsIconic(h);
        return false;
      }
      return true;
    }, IntPtr.Zero);
    title = foundTitle; minimized = foundMin;
    return found;
  }

  public static int PrimaryWidth() { IntPtr dc = GetWindowDC(GetDesktopWindow()); int w = GetDeviceCaps(dc, 8); ReleaseDC(GetDesktopWindow(), dc); return w; }
  public static int PrimaryHeight() { IntPtr dc = GetWindowDC(GetDesktopWindow()); int h = GetDeviceCaps(dc, 10); ReleaseDC(GetDesktopWindow(), dc); return h; }
}
`

/**
 * 主脚本。参数文件里只有数字与字符串，脚本自己读 —— 见文件头 ③。
 *
 * 结果 JSON 的字段（`capture.js` 的 `parseResult` 认这个形状）：
 *   ok / error / path / width / height / bytes / mean / std / windowTitle /
 *   virtualScreen / captureMs
 */
const PS_SOURCE = `param([string]$Params, [string]$Out, [string]$Result)
$ErrorActionPreference = 'Stop'
# System.Windows.Forms 只为 [SystemInformation]::VirtualScreen（整块虚拟桌面，含负坐标）。
# ⚠️ 少这一行会在屏幕那条路上报「找不到类型 System.Windows.Forms.SystemInformation」——
#    而窗口那条路照样能用（它不碰这个类型），所以症状看起来像"窗口能截、全屏不能"。
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
${CS_SOURCE}
'@

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 4
  [System.IO.File]::WriteAllText($Result, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$p = Get-Content -LiteralPath $Params -Raw -Encoding UTF8 | ConvertFrom-Json
[void][Shot]::MakeDpiAware()

# 采样统计：黑屏/纯色判定。抽成函数是为了**在缩放之前**判一次 ——
# 驱动/会话隔离导致的"全黑"必须在这里被发现才能换 API 重试（见下面的三级兜底）。
function Get-Stats($bmp, $step) {
  if ($step -lt 1) { $step = 16 }
  $sum = 0.0; $sum2 = 0.0; $n = 0
  for ($yy = 0; $yy -lt $bmp.Height; $yy += $step) {
    for ($xx = 0; $xx -lt $bmp.Width; $xx += $step) {
      $c = $bmp.GetPixel($xx, $yy)
      $l = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
      $sum += $l; $sum2 += $l * $l; $n++
    }
  }
  $mean = 0.0; $std = 0.0
  if ($n -gt 0) { $mean = $sum / $n; $std = [math]::Sqrt([math]::Max(0, ($sum2 / $n) - ($mean * $mean))) }
  return @{ mean = $mean; std = $std; n = $n }
}

# 对同一块区域分别用三种 API 取一次，返回第一张"不像全黑"的。
# ★ 三级兜底的理由：这不是"保险起见"，是实测 —— 本机 BitBlt 返回 true 但结果是全黑，
#   而 CopyFromScreen 与 PrintWindow 都正常。GDI 与 DWM 在不同驱动/会话上各有脾气，
#   让某一个 API 的脾气决定整个功能能不能用，是最没必要的一种失败。
function New-Capture($x, $y, $w, $h, $step) {
  $tried = @()
  $b = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $dstDc = $g.GetHdc()
  $srcDc = [Shot]::CreateCompatibleDC($dstDc)
  $ok = [Shot]::BitBlt($dstDc, 0, 0, $w, $h, $srcDc, $x, $y, 0x00CC0020)
  [void][Shot]::DeleteDC($srcDc)
  $g.ReleaseHdc($dstDc)
  $g.Dispose()
  $tried += "BitBlt(ok=$ok)"
  $st = Get-Stats $b $step
  if ($ok -and $st.mean -gt 8) { return @{ bmp = $b; note = ''; stats = $st; tried = $tried } }
  $b.Dispose()

  $b = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $tried += 'CopyFromScreen'
  $st = Get-Stats $b $step
  if ($st.mean -gt 8) { return @{ bmp = $b; note = '（BitBlt 取回来是全黑，已改用 CopyFromScreen）'; stats = $st; tried = $tried } }
  $b.Dispose()

  # 第三级：直接把桌面窗口整体渲染出来（和窗口级同一条路）
  $b = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $hdc = $g.GetHdc()
  $ok3 = [Shot]::PrintWindow([Shot]::GetDesktopWindow(), $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $tried += "PrintWindow(desktop,ok=$ok3)"
  $st = Get-Stats $b $step
  return @{ bmp = $b; note = '（三种抓屏方式都取回了接近全黑的图）'; stats = $st; tried = $tried }
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$bmp = $null
$note = ''
$title = ''
$triedList = @()
try {
  if ($p.source -eq 'window') {
    $minimized = $false
    $h = [Shot]::FindByTitle([string]$p.window, [ref]$title, [ref]$minimized)
    if ($h -eq [IntPtr]::Zero) { Write-Result @{ ok = $false; error = "没有找到标题里含「$($p.window)」的可见窗口（窗口标题只要一部分就够，不区分大小写）" }; exit 0 }
    if ($minimized) { [void][Shot]::ShowWindow($h, 9); Start-Sleep -Milliseconds 350; $note = '（窗口原本是最小化的，已先还原）' }
    $r = New-Object Shot+RECT
    [void][Shot]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
    if ($w -lt 1 -or $hh -lt 1) { Write-Result @{ ok = $false; error = '窗口区域不正常（宽高算出来是 0）—— 它可能刚被关掉' }; exit 0 }
    $bmp = New-Object System.Drawing.Bitmap($w, $hh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    # 2 = PW_RENDERFULLCONTENT：对使用 DirectComposition 的窗口（浏览器、Electron）必需
    $ok = [Shot]::PrintWindow($h, $hdc, 2)
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    $triedList += "PrintWindow(window,ok=$ok)"
    if (-not $ok) { $note = '（PrintWindow 报了失败，图可能不完整；DirectX 独占全屏的窗口会这样）' }
    $virtual = $null
  } else {
    # ── 屏幕 / 主屏 / 指定矩形 ─────────────────────────────────────────
    # 坐标一律用**虚拟桌面的绝对屏幕坐标**：多显示器时左上角可能是负的
    # （副屏放在主屏左边），而这三个 API 都吃绝对坐标。
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $virtual = @{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height }
    $x = $b.X; $y = $b.Y; $w = $b.Width; $hh = $b.Height
    if ($p.source -eq 'primary') {
      $w = [Shot]::PrimaryWidth(); $hh = [Shot]::PrimaryHeight()
      if ($w -lt 1 -or $hh -lt 1) { $w = $b.Width; $hh = $b.Height }
      $x = 0; $y = 0
    }
    if ($p.region) {
      $x = [int]$p.region.x; $y = [int]$p.region.y
      $w = [int]$p.region.width; $hh = [int]$p.region.height
    }
    if ($w -lt 1 -or $hh -lt 1) { Write-Result @{ ok = $false; error = "要截的区域算出来是空的（$w x $hh）" }; exit 0 }
    $cap = New-Capture $x $y $w $hh ([int]$p.sampleStep)
    $bmp = $cap.bmp
    $triedList = $cap.tried
    if ($cap.note -ne '') { $note = $cap.note }
  }
  $sw.Stop()
  $captureMs = [int]$sw.ElapsedMilliseconds

  # ── 缩放（省 token 的关键一步）──────────────────────────────────────
  if ($p.maxWidth -gt 0 -and $bmp.Width -gt $p.maxWidth) {
    $nw = [int]$p.maxWidth
    $nh = [int]([math]::Round($bmp.Height * $nw / $bmp.Width))
    if ($nh -lt 1) { $nh = 1 }
    $scaled = New-Object System.Drawing.Bitmap($nw, $nh)
    $gs = [System.Drawing.Graphics]::FromImage($scaled)
    $gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gs.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gs.DrawImage($bmp, 0, 0, $nw, $nh)
    $gs.Dispose()
    $bmp.Dispose()
    $bmp = $scaled
  }

  $st = Get-Stats $bmp ([int]$p.sampleStep)
  $meta = @{ ok = $true; path = $Out; width = $bmp.Width; height = $bmp.Height; mean = $st.mean; std = $st.std; windowTitle = $title; virtualScreen = $virtual; captureMs = $captureMs; note = $note; methods = $triedList }
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $fi = Get-Item -LiteralPath $Out
  $meta.bytes = $fi.Length
  Write-Result $meta
} catch {
  try { if ($bmp) { $bmp.Dispose() } } catch {}
  Write-Result @{ ok = $false; error = "$($_.Exception.GetType().Name): $($_.Exception.Message)" }
}
`

/**
 * ffmpeg 那条路：把 PNG 转成 JPEG（**只有 format=jpg 时才走**）。
 *
 * 为什么绕一圈而不是直接截 JPEG：见 `capture.js` 文件头 ——
 * .NET 的 JPEG 编码器与截屏同处一段脚本会被杀毒软件当恶意脚本拦下。
 * ffmpeg 是命令行 exe，不踩这个特征。
 */
function convertToJpeg({ pngPath, jpgPath, ffmpeg, quality, width, maxBytes }) {
  return new Promise((resolve) => {
    const args = ['-y', '-i', pngPath, '-q:v', String(quality)]
    // 只在需要的场合缩（PNG 已经缩过了，这里再兜一道，保证最终宽度不超上限）
    if (width > 0) args.push('-vf', `scale='min(${width},iw)':-2`)
    args.push(jpgPath)
    let child
    try {
      // ⚠️ `shell: true` 是**刻意的**，别把它当疏忽删掉：
      //   · Windows 上 `spawn` 不能直接跑 `.cmd` / `.bat`（会 EINVAL），
      //     而"ffmpeg"在不少机器上就是个包装脚本（scoop/winget/choco 的 shim）；
      //   · 安全上它在这里是可控的：命令与**全部参数**都是我们自己拼的
      //     （可执行文件路径来自配置、输入输出是我们自己生成的路径），
      //     没有任何一段来自模型或消息内容。
      child = spawn(ffmpeg, args, { stdio: 'ignore', windowsHide: true, shell: true })
    } catch (error) {
      return resolve({ ok: false, reason: `ffmpeg 起不来：${error?.message ?? error}` })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve({ ok: false, reason: `ffmpeg 转 JPEG 超时（${DEFAULT_TIMEOUT_MS}ms）` })
    }, DEFAULT_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: `ffmpeg 起不来：${error?.message ?? error}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolve({ ok: false, reason: `ffmpeg 转 JPEG 失败（退出码 ${code}）` })
      let bytes = 0
      try {
        bytes = fs.statSync(jpgPath).size
      } catch {
        return resolve({ ok: false, reason: 'ffmpeg 说成功了，但目标文件不存在' })
      }
      if (bytes > maxBytes) return resolve({ ok: false, reason: `转出来的 JPEG 超过上限（${bytes} > ${maxBytes} 字节）` })
      resolve({ ok: true, bytes })
    })
  })
}

/* ── 主入口 ────────────────────────────────────────────────────────────── */

/**
 * 跑一次抓图。
 *
 * @param {object} o
 *   plan      `capture.js` 的 `planCapture()` 产物
 *   shotsDir  图片落地的**绝对**目录（工作区里）
 *   tmpDir    参数文件/结果文件的落地目录（绝对；默认与 shotsDir 同级）
 *   fileName  目标文件名（由 `shotFileName()` 生成；相对 shotsDir）
 *   timeoutMs 总超时
 *   __run     **测试注入点**：替换"怎么跑一次 PowerShell"（生产代码不该传）
 * @returns {Promise<{ok:boolean, absPath?:string, relPath?:string, stats?:object, warning?:string, reason?:string}>}
 */
export async function runCapture({
  plan,
  shotsDir,
  tmpDir = null,
  fileName = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  __run = null,
} = {}) {
  const p = plan
  if (!p) return { ok: false, reason: '没有抓图计划' }
  const dir = String(shotsDir ?? '').trim()
  if (!dir) return { ok: false, reason: '没有指定截图目录（宿主没把工作区传进来）' }
  const name = String(fileName ?? '').trim()
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, reason: '文件名不合法' }
  }
  const tmp = String(tmpDir ?? dir).trim()

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(tmp, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `建不了截图目录：${error?.message ?? error}` }
  }

  // ① PNG 目标（jpg 时先落 PNG，再让 ffmpeg 转）
  const pngName = p.format === 'jpg' ? `${name.replace(/\.[a-z0-9]+$/i, '')}.png` : name
  const pngPath = path.join(dir, pngName)
  const finalName = p.format === 'jpg' ? name : pngName
  const finalPath = path.join(dir, finalName)

  const paramsPath = path.join(tmp, `.shot-params-${process.pid}-${Date.now()}.json`)
  const resultPath = path.join(tmp, `.shot-result-${process.pid}-${Date.now()}.json`)
  const runnerPath = path.join(tmp, `.shot-run-${process.pid}-${Date.now()}.ps1`)

  const params = {
    source: p.source,
    window: p.window ?? '',
    region: p.region ?? null,
    maxWidth: Number(p.maxWidth) || 0,
    scale: Number(p.scale) || 1,
    sampleStep: Number(p.sampleStep) || 16,
  }

  const cleanup = () => {
    for (const f of [paramsPath, resultPath, runnerPath]) {
      try {
        fs.rmSync(f, { force: true })
      } catch {
        /* 清不掉只是留个临时文件，不影响这一轮 */
      }
    }
  }

  try {
    fs.writeFileSync(paramsPath, JSON.stringify(params), 'utf8')
    // ★ UTF-8 with BOM：PowerShell 5.1 不带 BOM 时会按 ANSI 读，中文文案会乱码
    fs.writeFileSync(runnerPath, `\uFEFF${PS_SOURCE}`, 'utf8')
  } catch (error) {
    cleanup()
    return { ok: false, reason: `写不了抓图脚本：${error?.message ?? error}` }
  }

  const runner =
    typeof __run === 'function'
      ? __run
      : (exe, args) =>
          new Promise((resolve) => {
            let child
            try {
              child = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
            } catch (error) {
              return resolve({ code: -1, error: error?.message ?? String(error) })
            }
            const timer = setTimeout(() => {
              try {
                child.kill()
              } catch {
                /* ignore */
              }
              resolve({ code: -2, error: `超时（${timeoutMs}ms）` })
            }, timeoutMs)
            child.on('error', (error) => {
              clearTimeout(timer)
              resolve({ code: -1, error: error?.message ?? String(error) })
            })
            child.on('close', (code) => {
              clearTimeout(timer)
              resolve({ code })
            })
          })

  const ps = findPowerShell()
  if (!ps) {
    cleanup()
    return {
      ok: false,
      reason: '本机找不到可用的 PowerShell（`pwsh` 与 `powershell.exe` 都跑不起来）—— 截图功能依赖它',
    }
  }

  const runResult = await runner(ps, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    runnerPath,
    '-Params',
    paramsPath,
    '-Out',
    pngPath,
    '-Result',
    resultPath,
  ])

  let raw = ''
  try {
    raw = fs.readFileSync(resultPath, 'utf8')
  } catch {
    raw = ''
  }
  cleanup()

  if (!raw) {
    // 脚本连结果都没写出来 = 进程没起来、被杀、或被杀毒软件拦在最前面
    const why = runResult?.error
      ? `${runResult.error}`
      : `PowerShell 退出码 ${runResult?.code}，并且没有写出结果文件（常见原因：杀毒软件拦下了这段脚本、或 ExecutionPolicy 不允许）`
    return { ok: false, reason: `抓图脚本没能跑起来：${why}` }
  }

  const parsed = parseResult(raw, { fallbackError: '抓图脚本没给出结论' })
  if (!parsed.ok) return { ok: false, reason: parsed.reason }

  // ② JPEG 转换（只有要 jpg 时才走）
  if (p.format === 'jpg') {
    // 路径不存在时**提前**给出人话（否则错误是一句 `spawn ffmpeg ENOENT`，
    // 对使用者来说毫无用处 —— 它甚至不会提到"设置里那个路径填错了"）
    if (p.ffmpeg && !fs.existsSync(p.ffmpeg)) {
      try {
        fs.rmSync(pngPath, { force: true })
      } catch {
        /* ignore */
      }
      return { ok: false, reason: `设置里的 ffmpeg 路径不存在：${p.ffmpeg} —— 改成正确路径，或把格式改回 png` }
    }
    const conv = await convertToJpeg({
      pngPath,
      jpgPath: finalPath,
      ffmpeg: p.ffmpeg,
      quality: p.quality,
      width: 0,
      maxBytes: p.maxBytes,
    })
    if (!conv.ok) {
      try {
        fs.rmSync(pngPath, { force: true })
      } catch {
        /* ignore */
      }
      return { ok: false, reason: conv.reason }
    }
    try {
      fs.rmSync(pngPath, { force: true })
    } catch {
      /* ignore */
    }
    parsed.stats.bytes = conv.bytes
  }

  // ③ 出站大小闸（PNG 那条路在这里判）
  if (parsed.stats.bytes > p.maxBytes) {
    try {
      fs.rmSync(finalPath, { force: true })
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      reason: `截出来的图超过上限（${Math.round(parsed.stats.bytes / 1024)} KB > ${Math.round(p.maxBytes / 1024)} KB）—— 把 maxWidth 调小，或把 region 缩小`,
    }
  }

  return {
    ok: true,
    absPath: finalPath,
    stats: parsed.stats,
    warning: parsed.warning,
  }
}

export const internals = { CS_SOURCE, PS_SOURCE, convertToJpeg }
