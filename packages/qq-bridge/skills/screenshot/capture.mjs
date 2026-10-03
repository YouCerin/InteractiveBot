/**
 * 技能「截图」的纯逻辑层。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个文件里**没有**任何 IO、没有 spawn、没有 PowerShell
 * ══════════════════════════════════════════════════════════════════════════
 * 干活的在 `ps-runner.js`（拼脚本、起进程、读结果）。这样切分的理由和
 * `video-frames/frames.js` 同一条：**"怎么跑外部命令"是唯一需要被替换的层**，
 * 换掉它，参数拼装 / 上限夹取 / 结果判定 / 清理这些真正会出错的地方
 * 就全都在离线测试的覆盖面里了（见 `mocks/verify-screenshot.mjs`）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么格式只给 PNG（这一条是实测踩出来的，别改回去）
 * ══════════════════════════════════════════════════════════════════════════
 * .NET 的 JPEG 编码器（`ImageCodecInfo` + `EncoderParameter(Quality)`）与
 * `Graphics.CopyFromScreen` 在**同一段 PowerShell 里同时出现**时，会命中
 * 杀毒软件/AMSI 的恶意特征 —— 实测（2026-10-xx，本机）：
 *
 *   脚本里只有「截屏 → PNG 保存」              → 正常
 *   脚本里只有「缩放 → JPEG 质量编码」          → 正常
 *   两者合在一段脚本里                          → `This script contains malicious
 *                                                content and has been blocked
 *                                                by your antivirus software`
 *
 * 表现是**整段脚本第一行就报错**（连 `$ErrorActionPreference` 都"含恶意内容"），
 * 也就是那种"看起来像环境坏了、其实是格式选错"的故障。
 * 所以：默认且推荐的格式是 PNG；要 JPEG 请配 ffmpeg（命令行 exe，不踩这个特征）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 黑屏为什么要单独判（Windows 会话隔离）
 * ══════════════════════════════════════════════════════════════════════════
 * 如果桥接跑在**服务/另一个会话**里（不是当前登录的交互会话），`CopyFromScreen`
 * **不报错**，它老老实实返回一张**全黑**的图。锁屏时也一样。
 * "成功返回一张黑图"是最容易骗过人的失败形状，所以这里给一个纯函数
 * （`judgeFrame`）：按亮度均值与标准差判定"接近全黑/纯色"，并**如实附上警告**。
 * 注意口径：**只警告，不丢弃** —— 全屏放一个黑色视频时它也是全黑的，
 * 那属于"确实截到了"，丢了才是错的。
 */

/* ── 常量 ──────────────────────────────────────────────────────────────── */

/** 帧宽上限的夹取范围（和 video-frames 同一个口径：64~4096）。 */
export const MIN_WIDTH = 64
export const MAX_WIDTH = 4096

/** 默认帧宽。为什么要缩：全屏 2560 宽的原图直接给模型读，token 是 1280 宽的 4 倍。 */
export const DEFAULT_MAX_WIDTH = 1280

/** 支持的格式。`jpg` 走 ffmpeg（见文件头"为什么只给 PNG"）。 */
export const FORMATS = ['png', 'jpg']

/** JPEG 质量夹取范围（ffmpeg 的 `-q:v`，数字越小越清晰）。 */
export const MIN_QUALITY = 2
export const MAX_QUALITY = 31
export const DEFAULT_QUALITY = 4

/** 单张图字节上限：与出站发图同一道闸（`mcp-qq-server.mjs` 的 8MB）。 */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** 默认保留时长（小时）。0 = 不清理。 */
export const DEFAULT_RETENTION_HOURS = 24

/** 抓图方式。 */
export const SOURCES = {
  /** 整块虚拟桌面（多显示器一起，左上角可能为负坐标）。 */
  SCREEN: 'screen',
  /** 主显示器。 */
  PRIMARY: 'primary',
  /** 按窗口标题找窗口（PrintWindow，被遮挡也能截到）。 */
  WINDOW: 'window',
}

/** 判定"接近全黑"的亮度均值阈值（0~255）。 */
export const DARK_MEAN_THRESHOLD = 8
/** 判定"纯色"的标准差阈值。 */
export const FLAT_STD_THRESHOLD = 1.5

/* ── 类型收敛 ──────────────────────────────────────────────────────────── */

/** 夹取帧宽上限。 */
export function clampWidth(v) {
  const n = Math.round(Number(v) || DEFAULT_MAX_WIDTH)
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n))
}

/** 夹取 JPEG 质量。 */
export function clampQuality(v) {
  const n = Math.round(Number(v) || DEFAULT_QUALITY)
  return Math.max(MIN_QUALITY, Math.min(MAX_QUALITY, n))
}

/**
 * 缩放倍数：给高 DPI 屏用的。
 *
 * ⚠️ 口径是"**把逻辑坐标乘几**"，不是"缩到多大" —— 最终大小仍由 maxWidth 决定。
 * 例如缩放 125% 的屏上，逻辑虚拟桌面只有 1366×768，而实际像素是 1707×960；
 * 想让 region 的坐标按实际像素对齐时，就把它设成 1.25。
 */
export function clampScale(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.max(0.5, Math.min(4, Number(n.toFixed(3))))
}

/** 格式收敛：不认识的一律回 png（**不报错** —— 报错会在模型侧变成一轮无用往返）。 */
export function normalizeFormat(v) {
  const f = String(v ?? '').trim().toLowerCase()
  if (f === 'jpg' || f === 'jpeg') return 'jpg'
  return 'png'
}

/** 保留时长：0 或负数 = 不清理。 */
export function clampRetentionHours(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.max(1, Math.min(8760, Math.round(n)))
}

/* ── region 校验 ───────────────────────────────────────────────────────── */

/**
 * 校验并收敛一个矩形（`[x, y, w, h]` 或 `{x,y,width,height}`）。
 *
 * 为什么要这一层：region 是**模型给的数字**，而负宽/负高/天文数字会让
 * GDI+ 抛异常（`.NET` 的 `Bitmap` 构造函数直接 `ArgumentException`），
 * 表现成"截屏工具报了个英文异常" —— 那对使用者毫无用处。
 * 这里统一收敛成"能用的矩形"，实在不可用的返回 `null` 并给出人话原因。
 *
 * @returns {{ok:true, rect:{x:number,y:number,width:number,height:number}} | {ok:false, reason:string}}
 */
export function normalizeRegion(input) {
  if (input === undefined || input === null || input === '') return { ok: true, rect: null }
  let r = input
  if (Array.isArray(input)) {
    if (input.length < 4) return { ok: false, reason: 'region 要 4 个数：x, y, 宽, 高' }
    r = { x: input[0], y: input[1], width: input[2], height: input[3] }
  }
  if (typeof r !== 'object') return { ok: false, reason: 'region 要么是 [x,y,w,h]，要么是 {x,y,width,height}' }

  const num = (v, fallback = NaN) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  const x = num(r.x, NaN)
  const y = num(r.y, NaN)
  const width = num(r.width ?? r.w, NaN)
  const height = num(r.height ?? r.h, NaN)
  if (![x, y, width, height].every(Number.isFinite)) {
    return { ok: false, reason: 'region 的 x / y / 宽 / 高 必须都是数字' }
  }
  if (width < 1 || height < 1) {
    return { ok: false, reason: `region 的宽高必须 ≥1（收到 ${width}×${height}）` }
  }
  // 夹到合理范围：单边最大 10000 像素（比任何真实显示器都大，但不会让 GDI+ 炸）
  const cap = (v) => Math.max(0, Math.min(10000, Math.round(v)))
  return { ok: true, rect: { x: cap(x), y: cap(y), width: cap(width), height: cap(height) } }
}

/* ── 计划 ──────────────────────────────────────────────────────────────── */

/**
 * 把「设置 + 模型入参」收敛成一份**可执行的抓图计划**。
 *
 * 纯函数：同样的输入永远同样的输出，不碰文件系统也不碰配置对象本体。
 * `ps-runner` 只认这份计划里的字段，所以"模型能给什么"这件事
 * 完全由这里定义（而不是散在脚本拼装里）。
 *
 * @param {object} o
 *   settings  技能的有效设置（`api.config()` / `ctx.settings`）
 *   args      模型给的入参
 *   ffmpeg    可用的 ffmpeg 路径（空串 = 没有）；只有 format=jpg 时用得上
 * @returns {{ok:true, plan:object} | {ok:false, reason:string, hint?:string}}
 */
export function planCapture({ settings = {}, args = {}, ffmpeg = '' } = {}) {
  const s = settings ?? {}
  const a = args ?? {}

  const format = normalizeFormat(a.format ?? s.format)
  const ff = String(ffmpeg ?? '').trim()
  if (format === 'jpg' && !ff) {
    // ★ 如实说清"为什么不行、怎么办" —— 这一条是本项目对失败文案的硬要求
    return {
      ok: false,
      reason: '这次要的是 jpg，但本机没有可用的 ffmpeg（本技能**不用** .NET 的 JPEG 编码器：它和截屏同处一段脚本时会触发杀毒软件拦截）',
      hint: '改用 format=png（默认），或者在控制台 →「扩展」→ 截图 → 设置里填 ffmpeg 路径',
    }
  }

  const source = String(a.source ?? SOURCES.SCREEN).trim().toLowerCase()
  const windowQuery = String(a.window ?? '').trim()
  if (source === SOURCES.WINDOW && !windowQuery) {
    return { ok: false, reason: 'source=window 时必须给出 window（窗口标题的一部分，不区分大小写）' }
  }

  const regionCheck = normalizeRegion(a.region)
  if (!regionCheck.ok) return regionCheck

  const maxWidth = clampWidth(a.maxWidth ?? s.maxWidth)
  const scale = clampScale(a.scale ?? s.scale)
  const quality = clampQuality(a.quality ?? s.quality)
  const maxBytes = clampMaxBytes(s.maxBytes)

  const plan = {
    source: [SOURCES.SCREEN, SOURCES.PRIMARY, SOURCES.WINDOW].includes(source) ? source : SOURCES.SCREEN,
    window: windowQuery,
    region: regionCheck.rect,
    maxWidth,
    scale,
    format,
    quality,
    ffmpeg: ff,
    maxBytes,
    /** 采样密度：黑屏判定用（每 N 像素采一个点）。 */
    sampleStep: 16,
  }
  return { ok: true, plan }
}

/** 单张图的字节上限：夹到 64KB ~ 8MB。 */
export function clampMaxBytes(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_BYTES
  return Math.max(64 * 1024, Math.min(DEFAULT_MAX_BYTES, Math.round(n)))
}

/* ── 文件名 ────────────────────────────────────────────────────────────── */

/**
 * 帧文件名：`screen_<来源>_<时间戳>_<随机>.<ext>`。
 *
 * 为什么带来源与时间：工作区里的图会被模型按路径引用，出了问题时
 * "这张是什么时候、按什么条件截的"必须能一眼看出来。
 * 为什么不留中文：文件名要能被 URL/日志/命令行安全携带。
 */
export function shotFileName({ source = 'screen', at = Date.now(), rand, ext = 'png' } = {}) {
  const safeSource = String(source).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'screen'
  const r = rand ?? Math.random().toString(36).slice(2, 8)
  return `shot_${safeSource}_${Number(at)}_${r}.${ext}`
}

/** 时间戳目录名（按天分桶，便于按保留时长清理）。 */
export function dayBucket(at = Date.now()) {
  const d = new Date(Number(at))
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/* ── 结果判定 ──────────────────────────────────────────────────────────── */

/**
 * 判定"这一张到底截到了什么"。
 *
 * 输入是**同一趟 PowerShell 里现算出来的采样统计**（不做图像处理，
 * 只采 4000 个点算均值与标准差 —— 实测 165ms 内跑完）。
 *
 * @param {{mean:number, std:number, bytes:number, width:number, height:number}} stats
 * @returns {{ok:boolean, warning:string, kind:'normal'|'dark'|'flat'}}
 */
export function judgeFrame(stats = {}) {
  const bytes = Number(stats.bytes) || 0
  const width = Number(stats.width) || 0
  const height = Number(stats.height) || 0
  const mean = Number(stats.mean)
  const std = Number(stats.std)

  if (bytes <= 0 || width <= 0 || height <= 0) {
    return { ok: false, warning: '抓到的图是空的（尺寸或字节数为 0）', kind: 'flat' }
  }
  if (!Number.isFinite(mean) || !Number.isFinite(std)) {
    // 统计缺席（旧版脚本 / ffmpeg 那条路）时**不猜**：照样放行，但不给黑屏结论。
    return { ok: true, warning: '', kind: 'normal' }
  }
  if (mean <= DARK_MEAN_THRESHOLD) {
    return {
      ok: true,
      kind: 'dark',
      warning:
        '⚠️ 这张图**接近全黑**（亮度均值 ' + mean.toFixed(1) + '）。常见原因：桥接跑在服务/非交互会话里、' +
        '机器锁屏或未登录、或者屏幕确实关着。全屏放黑色画面时也会这样 —— 所以图照常给你，' +
        '但**别把它当成"屏幕就是黑的"**，先如实告诉对方这个疑点。',
    }
  }
  if (std <= FLAT_STD_THRESHOLD) {
    return {
      ok: true,
      kind: 'flat',
      warning:
        '⚠️ 这张图**几乎是纯色**（标准差 ' + std.toFixed(2) + '），不像正常桌面。' +
        '常见原因同上（会话隔离/锁屏），也可能是整个屏幕只有一张纯色窗口。请如实转述这个疑点。',
    }
  }
  return { ok: true, warning: '', kind: 'normal' }
}

/**
 * 读 `ps-runner` 写回来的结果 JSON。
 *
 * ── 为什么不从 stdout 拿 ────────────────────────────────────────────────
 * ① 沙箱（DSH 自己的沙箱、以及别的受限环境）**禁止管道捕获**子进程输出，
 *    实测 `spawnSync(..., {stdio:'pipe'})` 直接 `EPERM`；而"结果写文件"
 *    在所有环境里都能用。
 * ② 截屏失败时要有**结构化**原因（没找到窗口 / 会话不可见 / GDI 失败），
 *    拼一行文本再正则去猜是最脆的一种做法。
 *
 * 坏 JSON 一律当失败，并把原文截断塞进 reason —— 排障时那半行原文往往就是答案。
 */
export function parseResult(raw, { fallbackError = '' } = {}) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, reason: fallbackError || '抓图脚本没有写出结果（进程没跑起来或中途被杀）' }
  let j
  try {
    j = JSON.parse(text)
  } catch {
    return { ok: false, reason: `抓图脚本的结果不是 JSON（原文前 200 字）：${text.slice(0, 200)}` }
  }
  if (j?.ok !== true) {
    return { ok: false, reason: String(j?.error ?? '抓图脚本报告失败（没给原因）') }
  }
  const judge = judgeFrame(j)
  return {
    ok: judge.ok,
    stats: {
      width: Number(j.width) || 0,
      height: Number(j.height) || 0,
      bytes: Number(j.bytes) || 0,
      mean: Number.isFinite(Number(j.mean)) ? Number(j.mean) : null,
      std: Number.isFinite(Number(j.std)) ? Number(j.std) : null,
      windowTitle: String(j.windowTitle ?? ''),
      virtualScreen: j.virtualScreen ?? null,
      captureMs: Number(j.captureMs) || 0,
      note: String(j.note ?? ''),
      methods: Array.isArray(j.methods) ? j.methods.map(String) : [],
    },
    warning: judge.warning,
    kind: judge.kind,
    reason: judge.ok ? '' : judge.warning,
  }
}

/* ── 清理 ──────────────────────────────────────────────────────────────── */

/**
 * 从一批文件里挑出"过期的"（纯函数：真正的删除由调用方做）。
 *
 * 为什么按 `mtime` 而不是按文件名里的时间：文件名可能被别的工具改过，
 * 而 mtime 是文件系统的事实。`retentionHours <= 0` 时**什么都不删**。
 */
export function pickExpired(files = [], { now = Date.now(), retentionHours = DEFAULT_RETENTION_HOURS } = {}) {
  const hours = clampRetentionHours(retentionHours)
  if (!hours) return []
  const cutoff = Number(now) - hours * 3600_000
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && Number.isFinite(Number(f.mtimeMs)) && Number(f.mtimeMs) < cutoff)
    .map((f) => f.path ?? f.name)
    .filter(Boolean)
}

/**
 * 本次抓图要不要顺手清理。
 *
 * 口径：**不是每次调用都扫盘**（工作区目录可能很大），而是按时间间隔抽样
 * （默认 10 分钟一次）—— 清理是维护动作，不是这一轮的核心目的。
 */
export function shouldSweep({ lastSweepAt = 0, now = Date.now(), intervalMs = 10 * 60_000 } = {}) {
  if (!Number.isFinite(Number(lastSweepAt)) || Number(lastSweepAt) <= 0) return true
  return Number(now) - Number(lastSweepAt) >= intervalMs
}

/* ── 与宿主/模型之间的文案 ─────────────────────────────────────────────── */

/**
 * 工具返回给模型的那段话。
 *
 * 三条纪律（都是这个项目反复踩出来的）：
 *   ① **相对路径**给模型（工作区根 = 它的 cwd），和 `video-frames` 一致；
 *   ② 明说"发出去要用哪个工具"——但名字由**调用方**用 `ctx.toolName()` / 宿主映射取，
 *      这里只接字符串，**绝不写死** `mcp__…`；
 *   ③ 失败原因与"下一步"必须同时出现。
 */
export function renderCaptureText({ relPath, stats, warning = '', sendToolName = '', readImage = 'read_image' } = {}) {
  const s = stats ?? {}
  const kb = Math.round((Number(s.bytes) || 0) / 1024)
  const lines = [
    `已截图：${relPath}（${s.width}×${s.height}，${kb} KB${s.captureMs ? `，抓图 ${s.captureMs}ms` : ''}）`,
  ]
  if (s.windowTitle) lines.push(`抓到的是窗口「${s.windowTitle}」。`)
  lines.push(`需要看内容就用 ${readImage} 读上面那个相对路径（读图要花 token，确定用不上就别读）。`)
  if (sendToolName) lines.push(`要把这张图发到当前会话，用 ${sendToolName}，url 处填上面那个相对路径即可（本机工作区文件，不需要内网开关）。`)
  if (warning) lines.push(warning)
  return lines.join('\n')
}

export const internals = {
  normalizeRegion,
  clampMaxBytes,
  judgeFrame,
  parseResult,
  pickExpired,
}
