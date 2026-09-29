// 抽帧实现层：只跟 ffmpeg 打交道，**不碰配置、不碰网络、不碰宿主**。
//
// 这一份是上游 `plugins/video-frames/frames.js`（逐字留档
// `reference/video-frames-1.0.0/frames.js`）的 InteractiveBot 适配版。上游那两条
// 关键设计说明**原样保留**（它们都是踩过的坑，不是文风）：
//
// ── 为什么 `-ss` 要放在 `-i` 前面 ──────────────────────────────────────
// `ffmpeg -i in.mp4 -ss 30 ...` 是**输出定位**：必须从第 0 秒解码到第 30 秒，
// 再把前面全部丢掉 —— 30 秒的高清视频要白解 30 秒。
// `ffmpeg -ss 30 -i in.mp4 ...` 是**输入定位**：直接跳到关键帧再解码，
// 快几倍到几十倍。对 10 分钟的视频取 4 帧，这个差别是「秒级」和「卡住」的区别。
//
// ── 为什么不做"直接把 URL 丢给 ffmpeg" ────────────────────────────────
// 社区版让 ffmpeg 直接读 HTTP URL，好处是只拉真正需要的那几段字节
// （10 分钟视频取 4 帧只传几百 KB，而不是几十 MB）。
// 但这里有 SSRF 缺口：URL 来自 OneBot 消息段（发送方可影响），
// ffmpeg 会自己去连、自己解析 DNS，我们没有任何机会做内网校验 ——
// 让群友发一条"视频链接"就能让宿主去探内网端口。
// 所以本项目坚持先经校验并落地成文件，再对本地文件抽帧。
// 代价是下载整个视频；换来的是不能被当跳板。
//
// ══════════════════════════════════════════════════════════════════════════
// 适配加了两件上游没有的东西（为什么必须加，见 skills/video-frames/README-InteractiveBot.md）
// ══════════════════════════════════════════════════════════════════════════
//  ① `extractFramesToDir()`：把帧**留在盘上**并返回路径。
//     上游只产出 base64 data URL（它的宿主把图直接塞进消息），而本宿主的技能工具
//     **只能返回文本**（`mcp/mcp-skills-server.mjs` 把技能返回值 `String()` 掉，
//     没有 image 内容块通道）。所以本宿主的路子是：帧落进工作区 → 返回相对路径 →
//     模型用 `read_image` 逐张读。这就是宿主自己看图功能的 `image.mode='on-demand'`
//     同一条路（见 `src/images.mjs` 顶部与 `src/channel-prompt.mjs`）。
//  ② `__setRunner()`：给测试用的注入点。本机（以及多数装机环境）**没有 ffmpeg**，
//     没有这个口子就只能测"找不到 ffmpeg"这一条分支，抽帧管线本身无法回归。
//     注入的是"怎么跑外部命令"这一层，参数拼装、时间点、命名、清理全都在被测范围内。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 单次 ffmpeg 调用的默认超时（上游值，保留）。 */
export const DEFAULT_RUN_TIMEOUT_MS = 20000
/** 抽帧数量硬上下限（上游是 1~12，保留）。 */
export const MIN_COUNT = 1
export const MAX_COUNT = 12

/** 调外部命令，收集 stdout；失败/超时返回 null（不抛）。 */
function run(cmd, args, timeoutMs = DEFAULT_RUN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch { return finish(null) }
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } finish(null) }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.on('error', () => { clearTimeout(timer); finish(null) })
    child.on('close', () => { clearTimeout(timer); finish(out || null) })
  })
}

/* ── 测试注入点 ────────────────────────────────────────────────────────── */

let runner = run
/**
 * 换掉"怎么跑外部命令"这一层（**只给测试用**）。
 * 传非函数等于恢复默认。生产代码不该调用它。
 */
export function __setRunner(fn) {
  runner = typeof fn === 'function' ? fn : run
}
export function __resetRunner() {
  runner = run
}

/* ── ffmpeg / ffprobe 定位 ─────────────────────────────────────────────── */

/** 找一个可用的 ffmpeg（带缓存；失败结果只缓存 60 秒，之后允许重探）。 */
let ffmpegCache = null
let ffmpegChecked = false
let ffmpegCheckedAt = 0
const FFMPEG_RETRY_MS = 60000
export async function findFfmpeg() {
  // 成功结果长期缓存；失败（没找到）60 秒后允许重探——
  // 否则"首次探测时没装、后来装好了"就永远不可用，只能重启
  if (ffmpegChecked && ffmpegCache) return ffmpegCache
  if (ffmpegChecked && Date.now() - ffmpegCheckedAt < FFMPEG_RETRY_MS) return ffmpegCache
  ffmpegChecked = true
  ffmpegCheckedAt = Date.now()
  ffmpegCache = null
  for (const name of ['ffmpeg', 'ffmpeg.exe']) {
    const r = await runner(name, ['-version'], 5000)
    if (r) { ffmpegCache = name; break }
  }
  return ffmpegCache
}

/** 测试/运维用：强制清空探测缓存。 */
export function resetFfmpegCache() {
  ffmpegCache = null
  ffmpegChecked = false
  ffmpegCheckedAt = 0
}

/**
 * **同步**在 PATH 里找一个 ffmpeg（不 spawn 进程）。
 *
 * ── 为什么需要它（0.2.7 修正的一个真缺陷）───────────────────────────────
 * 上游的 `available()` 用的是"首次乐观放行 + 后台 spawn 探测 + 结果缓存"。那套在
 * 上游宿主里成立，在**本宿主里会让控制台卡片永远报错不起来** —— 因为：
 *   · `available()` 按契约必须**同步**，所以第一次只能乐观返回 `{ok:true}`；
 *   · 而控制台卡片读的是**装载那一刻存下来的** `skill.available` 快照
 *     （`extensions.mjs` 的 `loadSkill` 存、`describeSkill` 取），不是每次现调；
 *   · 于是"明明没装 ffmpeg"这件事，卡片上**一句提示都没有**，`--extensions`
 *     也只会显示 ✅ 已启用。（实测确认：`describeSkill.available.ok === true`。）
 * 结果就是使用者看不到"去设置里填 ffmpeg 路径"这句话 —— 正是它最需要看到的那句。
 *
 * 修法：**不 spawn**，直接扫 PATH 目录做同步查表。结论是真的，而且依然同步。
 * ── 它的边界（如实写清）────────────────────────────────────────────────
 *   · "PATH 上有 ffmpeg.exe" **不等于**"它跑得起来"（架构不符、文件损坏、缺 DLL）。
 *     这一层不在这里判：真正抽帧时 `pickFfmpeg()` → `findFfmpeg()` 会**真的跑一次
 *     `-version`**，跑不起来会在工具结果里如实报出来。
 *   · 只扫 PATH，**不猜安装位置**（项目里那条"不写死任何机器专属绝对路径"的纪律）。
 *     装在别处的，由使用者填进设置项 `ffmpegPath` —— 那条分支是同步判存在，最准。
 *
 * @param {{env?: object, exists?: Function, platform?: string, delimiter?: string}} [opts] 只为测试
 * @returns {string} 找到的完整路径；没找到返回空串
 */
export function findFfmpegOnPathSync({ env = process.env, exists = fs.existsSync, platform = process.platform, delimiter = path.delimiter } = {}) {
  const raw = String(env?.PATH ?? env?.Path ?? env?.path ?? '')
  const dirs = raw.split(delimiter).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean)
  const names = platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg']
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (exists(candidate)) return candidate
      } catch {
        /* 某个目录读不了（权限/坏盘）不该影响其它目录 */
      }
    }
  }
  return ''
}

/**
 * 这个可执行文件到底能不能跑（自检与"配了路径"那条分支用）。
 * @returns {Promise<{ok:boolean, version:string, why:string}>}
 */
export async function checkFfmpeg(exe) {
  const cmd = String(exe ?? '').trim()
  if (!cmd) return { ok: false, version: '', why: '没有给可执行文件路径' }
  const out = await runner(cmd, ['-version'], 5000)
  if (!out) return { ok: false, version: '', why: `跑不起来：${cmd}` }
  const version = String(out).split(/\r?\n/)[0].trim()
  return { ok: true, version, why: '' }
}

/**
 * 从 ffmpeg 的路径推 ffprobe 的路径。
 *
 * 为什么需要：Windows 上 ffmpeg 官方 zip 解出来两个 exe 是并排放的，
 * 用户填了 `D:\ffmpeg\bin\ffmpeg.exe` 之后，ffprobe 就在隔壁 ——
 * 这时候还去 PATH 里找 `ffprobe` 是没道理的（多数人只把 ffmpeg 加进了 PATH，
 * 或者干脆只填了这一个路径）。推不出来就返回空串，调用方自己退回 `ffprobe`。
 */
export function siblingFfprobe(ffmpegExe) {
  const p = String(ffmpegExe ?? '')
  if (!p || (!p.includes('/') && !p.includes('\\'))) return ''
  return p.replace(/ffmpeg(\.exe)?$/i, (m, ext) => `ffprobe${ext || ''}`)
}

/** 用 ffprobe 读时长；没有 ffprobe 就返回 0（调用方退回"等间隔猜"）。 */
export async function probeDuration(filePath, ffprobePath = 'ffprobe') {
  const txt = await runner(ffprobePath, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', filePath
  ], 15000)
  if (!txt) return 0
  try {
    const j = JSON.parse(txt)
    return Number(j?.format?.duration) || 0
  } catch { return 0 }
}

/* ── 时间点 ────────────────────────────────────────────────────────────── */

/** 把数量夹到 1~12（上游口径）。 */
export function clampCount(v) {
  const n = Math.round(Number(v) || 4)
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, n))
}

/**
 * 时间点：均匀分布在 (5%, 95%) 区间。
 * 不用首尾两端：开头常是黑场/logo，结尾常是黑场/字幕，两头都取等于浪费 2 帧。
 * 时长未知：取前几秒的几个点（短视频居多，猜错的代价只是画面重复）。
 */
export function planFrameTimes(durationSec, count, { unknownStartSec = 1, unknownStepSec = 2 } = {}) {
  const n = clampCount(count)
  const dur = Number(durationSec) > 0 ? Number(durationSec) : 0
  const times = []
  if (dur > 0) {
    for (let i = 0; i < n; i++) {
      times.push(Number((dur * (0.05 + 0.9 * (i / Math.max(1, n - 1)))).toFixed(3)))
    }
  } else {
    for (let i = 0; i < n; i++) times.push(Number((unknownStartSec + i * unknownStepSec).toFixed(3)))
  }
  return times
}

/* ── 抽帧 ──────────────────────────────────────────────────────────────── */

/** 单帧文件名。带上来源指纹与毫秒时间，便于"按来源覆盖"与排障。 */
export function frameFileName({ index, time, tag = '', prefix = 'frame' }) {
  const t = Math.round(Number(time) * 1000)
  return `${prefix}${tag ? `_${tag}` : ''}_${index}_${t}ms.jpg`
}

/**
 * 逐帧调用 ffmpeg 落盘，返回真正产出的文件（失败的单帧跳过）。
 *
 * 单帧失败**不影响**其它帧：一个损坏的时间点不该让整次抽帧失败。
 */
async function grabFrames({
  filePath, outDir, times, ffmpeg, maxWidth = 768, quality = 4,
  timeoutMs = DEFAULT_RUN_TIMEOUT_MS, tag = '', prefix = 'frame',
}) {
  const frames = []
  for (const [i, t] of times.entries()) {
    const name = frameFileName({ index: i, time: t, tag, prefix })
    const dest = path.join(outDir, name)
    try { fs.rmSync(dest, { force: true }) } catch { /* 覆盖不了就让 -y 去处理 */ }
    // -ss 在 -i 之前 = 输入定位（快）；-frames:v 1 = 只要一帧
    await runner(ffmpeg, [
      '-y', '-ss', String(t), '-i', filePath,
      '-frames:v', '1',
      '-vf', `scale='min(${maxWidth},iw)':-2`,
      '-q:v', String(quality),
      dest,
    ], timeoutMs)
    let bytes = 0
    try {
      const st = fs.statSync(dest)
      if (st.isFile()) bytes = st.size
    } catch { bytes = 0 }
    if (!bytes) {
      try { fs.rmSync(dest, { force: true }) } catch { /* ignore */ }
      continue
    }
    frames.push({ abs: dest, name, time: t, bytes })
  }
  return frames
}

/** 解析这次要用哪个 ffmpeg：设置里填了就用它，没填就自动探测。 */
async function pickFfmpeg(explicit) {
  const want = String(explicit ?? '').trim()
  if (want) {
    if (!fs.existsSync(want)) return { ffmpeg: '', why: `未找到 ffmpeg（设置的路径不存在：${want}）` }
    return { ffmpeg: want, why: '' }
  }
  const found = await findFfmpeg()
  return found
    ? { ffmpeg: found, why: '' }
    : { ffmpeg: '', why: '未找到 ffmpeg（PATH 里没有 ffmpeg / ffmpeg.exe）' }
}

/**
 * 抽 N 帧并**把图片留在 outDir 里**（本宿主的路子：返回路径给模型 read_image）。
 *
 * @param {object} o
 *   filePath    本地视频文件（**必须是本地** —— 见文件头 SSRF 说明）
 *   outDir      帧落地目录（工作区内）
 *   count       要几帧（1~12，默认 4）
 *   ffmpegPath  可执行文件路径（不传则自动探测）
 *   maxWidth    缩放宽度上限（默认 768；越小 token 越省）
 *   quality     JPEG 质量 2~31，越小越好（默认 4）
 *   durationSec 已知时长（省一次 ffprobe）
 *   timeoutMs   单帧超时
 *   tag         来源指纹（用于按来源覆盖旧帧）
 * @returns {Promise<{frames: {abs,name,time,bytes}[], times:number[], durationSec:number, error?:string}>}
 */
export async function extractFramesToDir({
  filePath,
  outDir,
  count = 4,
  ffmpegPath = null,
  maxWidth = 768,
  quality = 4,
  durationSec = 0,
  timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  tag = '',
} = {}) {
  const src = String(filePath || '')
  if (!src || !fs.existsSync(src)) return { frames: [], times: [], durationSec: 0, error: '视频文件不存在' }
  const dir = String(outDir || '').trim()
  if (!dir) return { frames: [], times: [], durationSec: 0, error: '没有指定帧输出目录' }
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { frames: [], times: [], durationSec: 0, error: `建不了帧目录：${error?.message ?? error}` }
  }

  const picked = await pickFfmpeg(ffmpegPath)
  if (!picked.ffmpeg) return { frames: [], times: [], durationSec: 0, error: picked.why }

  const n = clampCount(count)
  // 有 ffprobe 就用真实时长；填了 ffmpegPath 时优先找**它旁边**那个 ffprobe
  const probe = siblingFfprobe(picked.ffmpeg) || 'ffprobe'
  const dur = Number(durationSec) > 0 ? Number(durationSec) : (await probeDuration(src, probe))
  const times = planFrameTimes(dur, n)

  const frames = await grabFrames({
    filePath: src, outDir: dir, times, ffmpeg: picked.ffmpeg,
    maxWidth: clampWidth(maxWidth), quality: clampQuality(quality), timeoutMs, tag,
  })

  if (!frames.length) {
    return {
      frames: [], times: [], durationSec: dur,
      error: '抽帧失败（ffmpeg 没有产出可用画面）—— 常见原因：这个文件其实不是视频、编码不受支持，或者单帧超时太短',
    }
  }
  return { frames, times: frames.map((f) => f.time), durationSec: dur }
}

/** 宽度上限：夹到 64~4096，避免设置写 0 或荒唐的大数。 */
export function clampWidth(v) {
  const n = Math.round(Number(v) || 768)
  return Math.max(64, Math.min(4096, n))
}

/** JPEG 质量：夹到 2~31（越小越清晰、体积越大）。 */
export function clampQuality(v) {
  const n = Math.round(Number(v) || 4)
  return Math.max(2, Math.min(31, n))
}

/**
 * 上游那条路：抽 N 帧，返回 **data URL 数组**。
 *
 * 契约逐字保留（上游宿主的能力 `video.frames` 就吃这个形状），
 * 所以两个宿主共用同一个实现。本宿主不用它（MCP 工具只能返回文本，
 * base64 塞进文本既看不见又白烧 token），本宿主走 `extractFramesToDir()`。
 *
 * @returns {Promise<{ frames: string[], times: number[], error?: string }>}
 */
export async function extractFrames({
  filePath,
  count = 4,
  ffmpegPath = null,
  maxWidth = 768,
  quality = 4,
  durationSec = 0,
  tmpDir = null,
} = {}) {
  const src = String(filePath || '')
  if (!src || !fs.existsSync(src)) return { frames: [], times: [], error: '视频文件不存在' }

  const picked = await pickFfmpeg(ffmpegPath)
  if (!picked.ffmpeg) return { frames: [], times: [], error: picked.why }

  const n = clampCount(count)
  const dir = tmpDir || path.dirname(src)
  const probe = siblingFfprobe(picked.ffmpeg) || 'ffprobe'
  const dur = Number(durationSec) > 0 ? Number(durationSec) : (await probeDuration(src, probe))
  const times = planFrameTimes(dur, n)

  const grabbed = await grabFrames({
    filePath: src, outDir: dir, times, ffmpeg: picked.ffmpeg,
    maxWidth: clampWidth(maxWidth), quality: clampQuality(quality),
  })

  const frames = []
  const okTimes = []
  for (const f of grabbed) {
    try {
      const buf = fs.readFileSync(f.abs)
      if (!buf.length) continue
      frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`)
      okTimes.push(f.time)
    } catch { /* 单帧读失败不影响其它帧 */ } finally {
      try { fs.rmSync(f.abs, { force: true }) } catch { /* ignore */ }
    }
  }

  if (!frames.length) return { frames: [], times: [], error: '抽帧失败（ffmpeg 没有产出可用画面）' }
  return { frames, times: okTimes }
}

/** 默认的临时目录（上游契约里的 `tmpDir`，抽完即删，调用方负责清）。 */
export function defaultTmpDir() {
  return os.tmpdir()
}

export const internals = {
  run,
  grabFrames,
  pickFfmpeg,
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_COUNT,
  MIN_COUNT,
}
