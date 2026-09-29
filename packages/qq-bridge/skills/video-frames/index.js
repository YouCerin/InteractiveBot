// 视频识别 —— InteractiveRobot 适配版入口。
//
// ══════════════════════════════════════════════════════════════════════════
// 这个技能在两个宿主里的两种形态（同一份代码，刻意如此）
// ══════════════════════════════════════════════════════════════════════════
// 上游宿主（QQ Agent）里它**是个能力提供者**：
//   导出 `providers['video.frames']`，由宿主的 `src/video-reader.js` 主动调用，
//   返回 base64 data URL，宿主把图直接拼进消息。它**没有工具**，模型看不到它。
//
// InteractiveRobot 里没有能力/提供者这套机制（技能能做的只有四件事：注册工具、
// 贡献提示词片段、给自己的设置做界面、写日志 —— 见 `docs/插件设计规范.md` §7）。
// 所以适配的落点是**把它变成一个工具**：`mcp__skills__video-frames__frames`。
//
// ★ 关键差异（也是这次适配最核心的一处）：**技能工具只能返回文本**。
//   `mcp/mcp-skills-server.mjs` 把技能返回值 `String(r?.content ?? r?.text ?? '')` 掉，
//   再包成 `{content:[{type:'text'}]}` —— 没有 image 内容块通道。
//   所以本宿主的路子是宿主自己看图功能的同一条（`image.mode='on-demand'`）：
//     抽出来的帧**落进工作区** → 返回相对路径 → 模型用 `read_image` 逐张读。
//   （为什么不能返回 base64：模型读文本形式的 base64 等于看不见图，还白烧 token。）
//
// 上游那条能力导出**保留不动**，所以这份代码在上游宿主里照样能跑 ——
// 适配的目标是"两个宿主都能跑"，不是"改成只认 InteractiveRobot"。
// 逐处改法与理由见 `docs/0.2.7-video-frames-migration.md`。
//
// ══════════════════════════════════════════════════════════════════════════
// 三条 InteractiveRobot 特有的纪律（都对应一类"静默失效"）
// ══════════════════════════════════════════════════════════════════════════
//   ① 工具名**绝不写死**：模型看到的是 `mcp__skills__video-frames__frames`，
//      由宿主拼。所以 `setup()` 里用 `api.toolName('frames')` 取真名，
//      提示词片段里只引用那个变量（写死旧名字 = 模型去调一个不存在的工具）。
//   ② `available()` **必须同步**：宿主在同步的可用性判定里调它，返回 Promise
//      会被当成"可用"（Promise 是 truthy）。上游的折中是"首次乐观放行 + 后台探测"，
//      但在本宿主里那会让**控制台卡片永远报不出"缺 ffmpeg"**（卡片读的是装载时的快照，
//      详见 `available()` 上面那段）。所以这里改成**同步扫 PATH**：不 spawn、结论为真。
//   ③ 活设置要现读：`api.config()` 在 MCP 子进程里是**启动快照**，
//      所以 `execute(ctx)` 里一律优先读 `ctx.settings` / `ctx.config.skills[<id>]`。

import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  extractFrames,
  extractFramesToDir,
  findFfmpeg,
  findFfmpegOnPathSync,
  resetFfmpegCache,
  checkFfmpeg,
  siblingFfprobe,
  probeDuration,
  planFrameTimes,
  clampCount,
  clampWidth,
  clampQuality,
  __setRunner,
  __resetRunner,
} from './frames.js'
import {
  FRAMES_DIR,
  describeFramesDir,
  ensureFramesDir,
  framesTag,
  pruneFrames,
  removeFramesOfTag,
  resolveWorkspace,
} from './workspace.js'
import { resolveSource } from './sources.js'

/** 技能 id（清单里的同名；工具的裸名是 `<id>__frames`）。 */
export const SKILL_ID = 'video-frames'

/** 本技能自己的目录（`api.skill.dir` 拿不到时的兜底 —— 例如自测里没走宿主）。 */
const SELF_DIR = fileURLToPath(new URL('.', import.meta.url))

/**
 * 清单里 `settings` 的**同一份**默认值。
 *
 * ⚠️ 两处必须逐字一致：清单那份决定"界面上显示什么"，这份决定"拿不到宿主配置时用什么"。
 *    漂了就会出现"界面显示 4 帧、实际抽 6 帧"这类最难查的问题。
 *    `mocks/verify-video-frames.mjs` 有一条断言专门比对这两处。
 */
export const DEFAULTS = Object.freeze({
  enabled: false,
  count: 4,
  maxWidth: 768,
  quality: 4,
  ffmpegPath: '',
  maxSourceMB: 200,
  downloadTimeoutMs: 60000,
  extractTimeoutMs: 30000,
  retentionHours: 24,
})

/* ── 宿主注入的状态 ────────────────────────────────────────────────────── */

let hostApi = null
/** 取"共享设置"（宿主装载时那份；桥接进程里是活对象，MCP 进程里是启动快照）。 */
let sharedSettings = () => ({})
/**
 * 模型实际看到的工具全名。
 *
 * 初值刻意是**空串**而不是上游命名：它同时被当作"这是不是 InteractiveRobot"的判据 ——
 * 取不到就说明跑在别的宿主里，那时提示词片段要走**上游口径**（上游根本没有工具，
 * 框架是宿主自动把图拼进消息的）。
 */
let TOOL_FRAMES = ''

/** 上一次抽帧的结果摘要（自检用；不记来源 URL 全文，避免把长链接写进界面）。 */
let lastRun = null

function log(...a) { try { hostApi?.log?.(...a) } catch { /* 日志失败不影响功能 */ } }
function warn(...a) { try { hostApi?.warn?.(...a) } catch { /* 同上 */ } }

/**
 * 此刻生效的设置。
 *
 * 优先级：`context.config.skills['video-frames']`（宿主每次调用现读的活配置）
 *        > `api.config()`（宿主合并后的设置；MCP 进程里是启动快照）
 *        > 清单默认值。
 */
function settingsOf(context) {
  const live = context && context.config && context.config.skills && context.config.skills[SKILL_ID]
  if (live && typeof live === 'object') return { ...DEFAULTS, ...live }
  try {
    return { ...DEFAULTS, ...(sharedSettings() || {}) }
  } catch {
    return { ...DEFAULTS }
  }
}

/** 数值设置统一收敛（宿主已经夹过一次，这里再夹一次 —— 防手改 config.json）。 */
function numeric(s, key, fallback, lo, hi) {
  const n = Number(s?.[key])
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

/* ══════════════════════════════════════════════════════════════════════════
   依赖自检（`available`）—— 必须同步，而且结论必须**是真的**
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 依赖自检。**必须同步** —— 宿主在同步的可用性判定里调它。
 *
 * ⚠️ 本宿主**不会**因为 `ok:false` 把技能摘掉，而是：
 *   · 在**控制台技能卡上把这句 reason 显示出来**（`ExtensionsPanel` 的 warn 行），
 *     条件是 `enabled && available.ok === false`；
 *   · 在**每次工具调用前**再调一次，`ok:false` 就直接拒绝并把这句 reason 转述给模型。
 * 所以 reason 必须是**给人看的中文**，而且要指得出下一步。
 *
 * ★★ 0.2.7 修正（这条很关键，别再改回去）：**不再用"首次乐观放行 + 后台探测"**。
 *   那套是上游宿主的做法，到了这里会让卡片**永远报不出"缺 ffmpeg"**：
 *   `available()` 必须同步 ⇒ 第一次只能乐观返回 `{ok:true}`；
 *   而卡片读的是 `loadSkill` 那一刻存下来的 `skill.available` **快照**，不是每次现调。
 *   实测：明明没装 ffmpeg，`describeSkill.available.ok === true`，卡片上一句提示都没有 ——
 *   而"去设置里填 ffmpeg 路径"正是使用者最需要看到的那句话。
 *   现在改成**同步扫 PATH**（`findFfmpegOnPathSync`，不 spawn）：结论是真的，依然同步。
 *   它的边界见那个函数的注释（PATH 上有不等于跑得起来；那层由真正抽帧时的
 *   `findFfmpeg()` 真跑 `-version` 兜住）。
 */
export function available(context = {}) {
  const s = settingsOf(context)

  // 关掉时宿主本来就会拒绝执行（isSkillEnabled），这里给的是**界面上能读的原因**。
  if (s.enabled === false) {
    return { ok: false, reason: '「视频识别」开关没打开（控制台 →「扩展」→ 视频识别 → 启用）' }
  }

  // 一、设置里填了路径：完全同步判定，不猜、不看缓存、最准。
  const explicit = String(s.ffmpegPath ?? '').trim()
  if (explicit) {
    if (!existsSync(explicit)) {
      return {
        ok: false,
        reason:
          `抽帧用不了：设置里的 ffmpeg 路径**不存在**：${explicit}` +
          '（控制台 →「扩展」→ 视频识别 → 设置 → ffmpeg 路径；改好即刻生效，不用重启）。',
      }
    }
    return { ok: true }
  }

  // 二、没填路径：同步扫 PATH。扫不到就**如实说清"我查了什么"**（这句话会出现在卡片上、
  //     也会被模型转述给使用者 —— 所以措辞必须准确）。
  //
  // ★★ 0.2.7 修正过一版文案，起因是一次真实误伤：
  //    原来写的是「未找到 ffmpeg，抽帧用不了」—— 使用者明明**已经装好了**（只是没填路径、
  //    也没加 PATH），于是：
  //      · 他自己以为"是不是我没 build 成功"（来问过一次）；
  //      · 模型照这句话转述，在群里说了「**这台机器上没装**」—— 一句彻头彻尾的假话。
  //    ⇒ 现在必须写成"**我没在 PATH 里找到 / 你没填路径**"，并明确
  //      **这不等于没装**，以及"装了的话怎么告诉它"。
  const found = findFfmpegOnPathSync()
  if (!found) {
    return {
      ok: false,
      reason:
        '抽帧用不了：设置里**没填 ffmpeg 路径**，系统 PATH 里也没有 ffmpeg。' +
        '⚠️ 这**不代表机器上没装** —— 装好了的话，把 ffmpeg.exe 的完整路径填进' +
        '「控制台 → 扩展 → 视频识别 → 设置 → ffmpeg 路径」就行（即刻生效，不用改 PATH、也不用重新下载）。',
    }
  }
  return { ok: true }
}

/** 测试用：清掉 ffmpeg 的探测缓存（`available()` 现在是同步扫 PATH，没有自己的缓存）。 */
export function __resetProbe() {
  resetFfmpegCache()
}

/* ══════════════════════════════════════════════════════════════════════════
   工具实现
   ══════════════════════════════════════════════════════════════════════════ */

function fail(text) {
  return { content: text, isError: true }
}

/** 抽帧结果的正文。单独一个函数便于自测断言"模型到底读到什么字"。 */
export function renderFramesResult({ frames, rels, durationSec, source, kind, note, settings }) {
  const lines = []
  lines.push(`已从视频抽出 ${frames.length} 张截图，存在工作区里（用 read_image 逐张读才能真正看到）：`)
  for (const [i, f] of frames.entries()) {
    const secs = Number(f.time).toFixed(2)
    lines.push(`${i + 1}. ${rels[i]}  ← 第 ${secs} 秒`)
  }
  if (durationSec > 0) lines.push(`（视频时长约 ${durationSec.toFixed(1)} 秒；画面宽度上限 ${settings.maxWidth}px。）`)
  lines.push(
    '⚠️ 这些是**静止截图**，不是连续视频：帧与帧之间发生的事你看不到。' +
      '描述时用「某一帧里」「看起来」这类措辞，不要断言中间的连续过程。',
  )
  lines.push('（视频里的**声音**你听不到；要里面的说话内容，得先把语音转成文字。读图花 token，够用就好。）')
  lines.push(
    `来源：${kind === 'url' ? `直链（${note}）` : `工作区文件 ${source}`}。` +
      `这些图 ${settings.retentionHours > 0 ? `超过 ${settings.retentionHours} 小时会被自动清理` : '会一直留着'}。`,
  )
  return lines.join('\n')
}

/**
 * 抽帧工具。
 *
 * @param {object} ctx 宿主给的上下文（`ctx.settings` / `ctx.config` 是**活配置**）
 * @param {{source?:string, count?:number}} args 模型给的参数
 */
export async function runFramesTool(ctx = {}, args = {}) {
  const s = settingsOf(ctx)
  const startedAt = Date.now()
  const source = String(args?.source ?? '').trim()

  if (!source) {
    return fail(
      '没给 source。请传**工作区内的相对路径**（例如 inbox/xxx.mp4），或一条 **http(s) 视频直链**；' +
        '两者都没有的话，先请对方把视频文件放进工作区。',
    )
  }

  // ── 1. 定位工作区 ───────────────────────────────────────────────────────
  const skillDir = hostApi?.skill?.dir || SELF_DIR
  const ws = resolveWorkspace({ skillDir, config: ctx?.config })
  // ⚠️ 这里**只算路径、不建目录**：参数写错（路径越界、文件不存在、地址被拒）时
  //    不该在使用者的工作区里留下一个空的 frames/。真要写盘之前才建（见第 3 步）。
  const framesDir = join(ws.root, FRAMES_DIR)

  // 顺手清理过期帧（工作区是使用者的地盘，宿主不会替我们清）。
  // 目录还不存在时是 no-op —— pruneFrames 自己容错。
  const pruned = pruneFrames(framesDir, { retentionHours: numeric(s, 'retentionHours', DEFAULTS.retentionHours, 0, 24 * 365) })
  if (pruned.removed > 0) log(`清理了 ${pruned.removed} 张过期截图（${(pruned.bytes / 1024 / 1024).toFixed(1)}MB）`)

  // ── 2. 解析来源（工作区路径 / URL 下载 + SSRF 守卫）──────────────────────
  const maxSourceMB = numeric(s, 'maxSourceMB', DEFAULTS.maxSourceMB, 1, 4096)
  let got
  try {
    got = await resolveSource({
      source,
      workspaceRoot: ws.root,
      maxBytes: Math.round(maxSourceMB * 1024 * 1024),
      timeoutMs: numeric(s, 'downloadTimeoutMs', DEFAULTS.downloadTimeoutMs, 5000, 600000),
    })
  } catch (error) {
    return fail(`取视频时出错：${error?.message ?? error}`)
  }
  if (!got.ok) {
    lastRun = { at: Date.now(), ok: false, why: got.why, source }
    return fail(`没取到视频：${got.why}`)
  }

  // ── 3. 抽帧（**到这里才建目录**）──────────────────────────────────────────
  let outDir = framesDir
  try {
    outDir = ensureFramesDir(ws.root)
  } catch (error) {
    return fail(`工作区里的帧目录建不出来（${framesDir}）：${error?.message ?? error}`)
  }
  const tag = framesTag(source)
  const count = clampCount(args?.count ?? s.count)
  let result
  try {
    removeFramesOfTag(outDir, tag) // 同一个来源再抽一次 → 先删旧的，免得模型读到两批
    result = await extractFramesToDir({
      filePath: got.abs,
      outDir,
      count,
      ffmpegPath: String(s.ffmpegPath ?? '').trim() || null,
      maxWidth: clampWidth(s.maxWidth),
      quality: clampQuality(s.quality),
      timeoutMs: numeric(s, 'extractTimeoutMs', DEFAULTS.extractTimeoutMs, 5000, 600000),
      tag,
    })
  } catch (error) {
    result = { frames: [], error: `抽帧时出错：${error?.message ?? error}` }
  } finally {
    got.cleanup() // 下载来的临时副本用完就删（工作区里只留帧）
  }

  if (result.error) {
    lastRun = { at: Date.now(), ok: false, why: result.error, source, ms: Date.now() - startedAt }
    // ⚠️ 措辞注意：**不要写"装好 ffmpeg 后…"** —— 使用者常常已经装了（只是没告诉本技能），
    //   那样写会让他以为自己的安装有问题（真实误伤过一次，见 `available()` 上面那段）。
    const hint = /ffmpeg/.test(result.error)
      ? '\n（**已经装好了**的话：把 ffmpeg.exe 的完整路径填进 控制台 →「扩展」→ 视频识别 → 设置 → ffmpeg 路径，' +
        '即刻生效；**确实没装**的话，先装一个再填。）'
      : ''
    return fail(`${result.error}${hint}`)
  }

  // ── 4. 组装给模型看的话 ─────────────────────────────────────────────────
  const rels = result.frames.map((f) => relative(ws.root, f.abs).replace(/\\/g, '/'))
  const text = renderFramesResult({
    frames: result.frames,
    rels,
    durationSec: result.durationSec,
    source,
    kind: got.kind,
    note: got.note,
    settings: { maxWidth: clampWidth(s.maxWidth), retentionHours: numeric(s, 'retentionHours', DEFAULTS.retentionHours, 0, 24 * 365) },
  })
  lastRun = {
    at: Date.now(),
    ok: true,
    source,
    frames: result.frames.length,
    bytes: result.frames.reduce((a, f) => a + f.bytes, 0),
    ms: Date.now() - startedAt,
  }
  log(`抽出 ${result.frames.length} 帧 → ${FRAMES_DIR}/（${Date.now() - startedAt}ms）`)
  return { content: text }
}

/* ══════════════════════════════════════════════════════════════════════════
   宿主契约：setup / promptSections / diagnose
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 装载。**两个进程各调一次**（桥接主进程只为拿提示词片段，MCP 子进程才真正执行），
 * 所以这里**绝不能**有进程级副作用：不联网、不开端口、不改进程环境变量。
 * 探测 ffmpeg 的 spawn 发生在 `available()` 里、且带缓存，不在这里。
 */
export async function setup(api) {
  hostApi = api
  sharedSettings = () => {
    try {
      return (api?.config && api.config()) || {}
    } catch {
      return {}
    }
  }

  // ★ InteractiveRobot 适配①：把**模型实际看到的工具名**从宿主那里拿过来。
  //   拿不到（跑在上游宿主里）就保持空串 —— 那不是"坏掉"，而是"这个宿主里本技能
  //   没有工具"，提示词片段据此切换到上游口径（见 promptSections）。
  try {
    const n = api?.toolName && api.toolName('frames')
    if (n) TOOL_FRAMES = String(n)
  } catch {
    TOOL_FRAMES = ''
  }

  api.registerTool({
    id: 'frames',
    name: '视频识别',
    category: 'media',
    icon: '🎬',
    // 只读类：它不改别人的东西、不发言、只在自己工作区里产生截图。
    // （网络与落盘的实情写在 description 与清单的 permissions 里，不藏着。）
    permission: 'read',
    description:
      '把一段视频抽成若干张**截图**存进工作区，让只能看图的模型也能"看"视频。'
      + 'source 可以是**工作区内的相对路径**（例如 inbox/xxx.mp4），也可以是一条 **http(s) 视频直链**'
      + '（直链由本技能自己下载、自己校验，内网/回环地址一律拒绝）。'
      + '返回的是图片的**相对路径** —— 你要用 read_image 逐张读那些路径才能真正看到画面'
      + '（读图花 token：只想知道"是不是猫"就少读几张，别一口气读满 12 张）。'
      + '注意：拿到的是**静止截图**，帧与帧之间的过程看不到；视频里的**声音**也听不到。'
      + '它需要 ffmpeg，而且**光装了不算**：路径要么填进扩展设置，要么在系统 PATH 里。'
      + '这两样都没配好时，工具会直接告诉你**往哪填**（不是让你去装、更不是让你去磁盘上搜 ffmpeg）——'
      + '所以别自己去 find/搜文件、也别反复重试；把这句话转告给管理员即可。',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: '视频来源：工作区内的相对路径（如 inbox/a.mp4、store/demo.mov），或 http(s) 视频直链。',
        },
        count: {
          type: 'integer',
          description: '抽几帧（1~12）。不填就用扩展设置里的值（默认 4）。帧越多越能还原过程，读图也越贵。',
        },
      },
      required: ['source'],
    },
    execute: (ctx, a) => runFramesTool(ctx, a),
  })
}

/**
 * 提示词片段（跟着开关走，宿主每轮现调）。
 *
 * ⚠️ 本宿主给 `promptSections(context)` 的 context **只有 `{config}`**，
 *    所以工具名必须用 `setup()` 里捕获的那个变量，不能指望 `context.toolName()`。
 */
export function promptSections(context = {}) {
  const s = settingsOf(context)
  const count = clampCount(s.count)

  // ★★ 0.2.7：**自检没过就别教它**（这条是本项目最硬的规矩之一）。
  //
  // 提示词里提到一个工具，模型就会去调它；而抽帧不可用（没装 ffmpeg / 路径配错）时，
  // 工具调用会被宿主**当场拒绝**（`mcp-skills-server` 在 execute 之前会调 `available()`）——
  // 于是这一段提示词在教一个"必然失败"的动作，模型只能回一句"我抽不出来"。
  // 本项目的原话是：**提示词里凡是写了的能力都必须是真的**（`markers.mjs`、`persona.mjs` 都有这条）。
  // ⇒ 不可用时不注入这一段。"这条消息里到底有没有视频、为什么看不了"由**宿主**那条如实说
  //   （`bridge.mjs` 的 `#videoToolFacts()` + `channel-prompt.mjs` 的视频段）。
  //
  // ⚠️ 只在**本宿主**（能拿到工具名）里这样门控：上游宿主里这一段是它唯一的视频指引
  //    （上游没有工具，画面由宿主自己拼进消息），那边不可用时会自己退回"只读元信息"，
  //    所以那一段**必须留着** —— 否则同一份代码在上游宿主里会静默失效。
  if (TOOL_FRAMES && available(context).ok === false) return []

  // 跑在上游宿主里：没有工具，画面是宿主的 `video.frames` 能力自动拼进消息的。
  // 那段话就是上游原文（逐字保留），别改口径。
  if (!TOOL_FRAMES) {
    return [{
      id: 'video-frames-active',
      title: '视频理解',
      priority: 35,
      content: `你看到的视频画面是从视频里抽出的 ${count} 张截图，不是连续视频。帧与帧之间发生的事你看不到，描述时不要断言中间的连续过程。`,
    }]
  }

  return [{
    id: 'video-frames-active',
    title: '视频识别',
    priority: 35,
    content: [
      `要"看"视频内容时（对方发来或提到一段视频），用 ${TOOL_FRAMES}(source=工作区内的相对路径或 http(s) 视频直链) 抽帧，` +
        '再用 read_image 逐张读它返回的图片路径 —— 不读那些图，你看不到任何画面。',
      '⚠️ 你看到的是**若干张静止截图**，不是连续视频：帧与帧之间发生的事你看不到。' +
        '描述时用「某一帧里」「看起来」这类措辞，不要断言中间的连续过程。',
      '视频里的**声音**你听不到；要里面的说话内容，得先把语音转成文字（那是另一件事）。',
      '读图花 token：够用就好，别一口气把每张都读一遍。',
    ].join('\n'),
  }]
}

/**
 * 自检（控制台「扩展」→ 视频识别 → 自检）。
 *
 * 为什么值得写：本技能最容易的坏法是"静默拿不到 ffmpeg" ——
 * 装没装、装在哪、能不能跑，全靠一句笼统的"抽帧失败"是查不出来的。
 * 这里把每一格都摊开。**不输出任何密钥**（本技能本来也没有密钥）。
 */
export async function diagnose(context = {}) {
  const s = settingsOf(context)
  const skillDir = hostApi?.skill?.dir || SELF_DIR
  const ws = resolveWorkspace({ skillDir, config: context?.config })
  const framesDir = join(ws.root, FRAMES_DIR)
  const explicit = String(s.ffmpegPath ?? '').trim()

  const out = {}
  out['开关'] = s.enabled === false ? '关闭（控制台 →「扩展」→ 视频识别 → 启用）' : '已启用'
  out['工作区'] = `${ws.root}（${ws.source}）`

  // ffmpeg：配了路径就查它，没配就先看同步扫 PATH 的结果，再真跑一次 -version 核实
  if (explicit) {
    const chk = await checkFfmpeg(explicit)
    out['ffmpeg（来自设置）'] = chk.ok ? `${chk.version} —— ${explicit}` : `${chk.why}（设置里填的是 ${explicit}）`
  } else {
    const onPath = findFfmpegOnPathSync()
    out['ffmpeg（同步扫 PATH）'] = onPath
      ? `找到 ${onPath}（这就是 available() 报"可用"的依据）`
      : 'PATH 里没有 —— 请在设置里填 ffmpeg.exe 的完整路径，或把它加进系统 PATH'
    const found = await findFfmpeg()
    if (found) {
      const chk = await checkFfmpeg(found)
      out['ffmpeg（真跑一次 -version）'] = chk.ok ? `${chk.version} —— ${found}` : `找到了 ${found}，但**跑不起来**（架构不符/文件损坏/缺 DLL？）`
    } else {
      out['ffmpeg（真跑一次 -version）'] = '跑不起来或找不到 —— 抽帧会失败'
    }
  }

  // ffprobe：只影响"时间点取在哪"，没有它也能抽（退回固定的前几秒）
  const probe = (explicit && siblingFfprobe(explicit)) || 'ffprobe'
  const probeChk = await checkFfmpeg(probe)
  out['ffprobe'] = probeChk.ok
    ? `可用（${probe}，${probeChk.version}）`
    : `没找到 / 跑不起来（${probe}）—— **不影响抽帧**，只是时间点会退回"前几秒均匀取点"；` +
      '想要"按视频时长均匀分布"就把它和 ffmpeg 放在一起、或加进 PATH'

  const dirState = describeFramesDir(framesDir)
  out['帧目录'] = `${framesDir} —— ${dirState.exists ? `已有 ${dirState.files} 个文件 / ${(dirState.bytes / 1024 / 1024).toFixed(1)}MB` : '还不存在（第一次抽帧时自动建）'}`
  out['保留时长'] = s.retentionHours > 0 ? `${s.retentionHours} 小时（每次抽帧顺手清一次）` : '不清理（0 = 关闭清理）'

  out['抽帧参数'] = `每次 ${clampCount(s.count)} 帧，宽 ≤ ${clampWidth(s.maxWidth)}px，JPEG 质量 ${clampQuality(s.quality)}`
  out['下载上限'] = `${numeric(s, 'maxSourceMB', DEFAULTS.maxSourceMB, 1, 4096)}MB / 单次超时 ${numeric(s, 'downloadTimeoutMs', DEFAULTS.downloadTimeoutMs, 5000, 600000)}ms`
  out['工具名（模型看到的）'] = TOOL_FRAMES || '（本宿主里没有登记工具）'
  out['上次抽帧'] = lastRun
    ? `${lastRun.ok ? '成功' : '失败'}（${new Date(lastRun.at).toLocaleString()}）：` +
      `${lastRun.ok ? `${lastRun.frames} 帧 / ${(lastRun.bytes / 1024).toFixed(0)}KB / ${lastRun.ms}ms` : lastRun.why}`
    : '本次启动后还没抽过'
  return out
}

/** 上游那条能力契约：宿主（上游）通过这两个名字取用，与工具并存，互不影响。 */
export const providers = {
  // 抽帧：参数优先级 调用方传入 > 用户在设置页配的 > 默认值
  'video.frames': async ({ filePath, count, maxWidth, quality, durationSec, ffmpegPath } = {}) => {
    const c = settingsOf({})
    const want = clampCount(count ?? c.count)
    const result = await extractFrames({
      filePath,
      count: want,
      maxWidth: clampWidth(Number(maxWidth) || Number(c.maxWidth) || DEFAULTS.maxWidth),
      quality: clampQuality(Number(quality) || Number(c.quality) || DEFAULTS.quality),
      durationSec,
      ffmpegPath: ffmpegPath || String(c.ffmpegPath ?? '').trim() || null,
    })
    if (result.error) log(`抽帧未成功：${result.error}`)
    return result
  },

  // 让宿主能问"现在这条路走得通吗"，用于 auto 模式的降级判断
  'video.frames.available': async ({ ffmpegPath } = {}) => {
    const c = settingsOf({})
    const explicit = String(ffmpegPath || c.ffmpegPath || '').trim()
    if (explicit) {
      const ok = existsSync(explicit)
      return { ok, reason: ok ? '' : `未找到 ffmpeg（${explicit}）` }
    }
    const ff = await findFfmpeg()
    return { ok: Boolean(ff), reason: ff ? '' : '未找到 ffmpeg（抽帧需要它）' }
  },
}

/** 上游那份关于 `available()` 为什么必须同步的注释，原样保留在这里作为对照：
 *  SkillManager 的可用性判定是同步调用链，`available()` 返回 Promise 会被当成"可用"（Promise 是 truthy）。 */

export const internals = {
  // 上游就有的三个
  extractFrames,
  findFfmpeg,
  probeDuration,
  __resetFfmpegCache: resetFfmpegCache,
  // 适配新增
  extractFramesToDir,
  findFfmpegOnPathSync,
  resolveSource,
  resolveWorkspace,
  ensureFramesDir,
  pruneFrames,
  removeFramesOfTag,
  framesTag,
  planFrameTimes,
  renderFramesResult,
  runFramesTool,
  settingsOf,
  __defaults: () => ({ ...DEFAULTS }),
  __setRunner,
  __resetRunner,
  __resetProbe,
  __setHostApi: (a) => { hostApi = a },
  __setToolName: (n) => { TOOL_FRAMES = String(n ?? '') },
  __lastRun: () => lastRun,
}
