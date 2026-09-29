/**
 * 人工标注台的 HTTP 服务（**独立小工具**，不属于控制台后台 UI）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它解决什么（以及为什么不做进控制台）
 * ══════════════════════════════════════════════════════════════════════════
 * 打标签有两条自动路（视觉模型 / 文件名先验），但都只是**猜测**：
 * 实测模型把「一切都好」（OK 手势）打成「无语」—— 语义相反；文件名先验覆盖不到
 * 一半。所以人工标注是必需的，而它的形态**必须是"能快速刷图 + 一键贴标签"**，
 * 不是"在配置文件里找一条哈希名改 JSON"。
 *
 * ★ 刻意**不放进控制台**（用户明确要求）：控制台是"机器人整体状态"的地方，
 *   而这个工具是**一次性、用完就关**的标注台（要全屏看图、要键盘刷）。
 *   混在一起会两边都别扭：控制台要迁就大图，标注台要迁就后台的布局与加载逻辑。
 *   所以它是一个独立文件夹 + 独立进程 + 零依赖（只用 Node 内置模块）。
 *
 * ── 三个硬要求（都来自"标注是要人长时间盯着看的活"）──────────────
 * ① **看得清**：原图铺满可用区域，键盘就能刷下一张（←/→、空格跳过）。
 * ② **快**：标签按钮带数字快捷键，点一下即写回（**无"保存"按钮** ——
 *    标注是一张一张的小动作，攒着不但容易丢，还会让人不敢点）。
 * ③ **不猜**：写回的标签走宿主的 `applyStickerLabels`（词表校验），
 *    写错的名字会被指出来；写回时**标成 manual**，于是重打标签不会覆盖它。
 *
 * ── 为什么模块在这里、而不在 `sticker-label/server.mjs` ─────────────────
 * 因为**测试要能直接起一个**（`createLabelServer`）而不 spawn 子进程，
 * 而 manifest 守卫要求"被别的模块 import 的代码"必须在 src/ 下登记。
 * `sticker-label/server.mjs` 于是只剩"解析命令行 + 监听端口"这点壳。
 *
 * ── 两个页面（用户后来加的要求）──────────────────────────────────────
 * ① 刷图页：一张张过，贴完自动跳下一张。
 * ② **按标签看图页**：左边是标签清单（带实时张数），点一个就出这标签下的**图墙**；
 *    在图墙里能直接把某张改成别的标签 —— "复核某个标签是不是都打对了"
 *    这个动作不需要来回切页。同一页里还能**现场新建/改标签**。
 *
 * ── 边界（如实说）──────────────────────────────────────────────────────
 * · 它**只读写 `library.json` 与 `labels.json`**，不连桥接、不改配置、不发消息；
 * · 桥接**每轮现读**这两个文件，所以这里改完**下一轮对话就生效**，不需要重启；
 * · 只监听 **127.0.0.1**（图片是本地文件，不该被局域网看到）；
 * · 库是**共享文件**：一边标注一边让控制台按钮重打标签，后写的会覆盖先写的。
 *   本工具不阻止（加了锁反而会出现"卡住解不开"的假故障），但在页面上明说。
 *
 * ── 0.2.4 第十八轮：「重启服务」改成**同进程原地重听**（不再 spawn 子进程）──────
 * 原来重启的做法是"拉起一个新 node 进程（detached + --wait-port），然后本进程退出"。
 * 这条路踩了两次：先是端口交接（新进程撞 EADDRINUSE），后是更隐蔽的一条 ——
 * 常规用法是双击 `启动标注.bat`，node 在**那个 cmd 窗口里前台跑**；点重启用旧进程
 * 退出 ⇒ 批处理跑完 ⇒ 窗口关闭，刚拉起的"detached 新进程"仍随宿主那棵进程树被收走。
 * 迷惑之处：`cache/restart-logs/*.log` 里能看到新进程**已经绑上端口、打出完整启动
 * 横幅**（所以怎么看都是"代码没问题"），可过一会儿端口又是空的；而且同样的代码在
 * 普通 shell 里能活、在被托管的后台任务里就活不了 —— 成败取决于**宿主怎么杀进程树**，
 * 这是代码保证不了的。∴ 不再走这条路：**同一个进程关掉监听、再把端口绑回来**
 * （`rebindInPlace`）。旧进程自己释放端口，既没有抢端口的空窗，也不需要子进程比父进程
 * 活得久，启动窗口更不用关。已验证重听后 health / browse / 缩略图全部照常。
 * 代价：进程内重听不会重新加载已 import 的模块（ESM 缓存不失效）—— 但这在本工具里
 * 无所谓，因为**词表、库、便签都是每条请求现读磁盘**，真正会变的一直是新的。
 */

import { createServer } from 'node:http'
import { existsSync, openSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// 复用宿主已有的实现（**不重复造**：词表校验、条目形状、库读写只有一份）
import { normalizeConfig } from './config.mjs'
import { resolveDirectTarget } from './model-direct.mjs'
import { createRetagJob, preflightRetag } from './sticker-tagging.mjs'
import { PKG_ROOT } from './local.mjs'
import {
  applyStickerLabels,
  clearLabelFromLibrary,
  makeStickerThumbnail,
  readStickerLibrary,
  stickerRoot,
} from './sticker-library.mjs'
import { MIN_TAG_CONFIDENCE, RISK_LABEL } from './sticker-labels.mjs'
import {
  LABEL_AXES,
  activeIsAutoAllowed,
  activeLabelName,
  activeLabels,
  createLabel,
  deleteLabel,
  labelTableStatus,
  resetLabels,
  resolveActiveLabelId,
  restoreLabel,
  updateLabel,
} from './sticker-vocab.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** 静态页在包根的 `sticker-label/public/`（`src/` 的上一级）。 */
const STATIC = join(HERE, '..', 'sticker-label', 'public')

/** 本进程的启动时刻（`/api/health` 报出去，用来分辨"新代码还是旧进程"）。 */
const STARTED_AT = Date.now()

/** 图片扩展名 → MIME（只服务这几种；其余一律 404，避免把库里的杂项当静态资源吐出去）。 */
const IMAGE_MIME = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** 最多回多少条（页面一次拿全量就够了：几百张的 JSON 只有几十 KB）。 */
const MAX_ROWS = 5000

/** 缩略图最长边（图墙格子约 132px，256 在 2x 屏上也够清晰）。 */
const THUMB_SIDE = 256

/**
 * 缩略图缓存（**只在内存**）。
 *
 * 为什么缓存：一张约 11ms（GIF 要解 LZW 第一帧），而图墙一次要几十张 ——
 * 不缓存的话每翻一次标签就重算一遍。
 * 为什么**不落盘**：缩略图是纯派生数据，重建成本极低，而写进库目录
 * 会给"库 = 用户资产"这条边界添一个能被删坏的东西（本项目的老教训）。
 * 为什么满了**整个清掉**而不是做 LRU：几十毫秒就能全部重建，
 * 为省这点开销引入一套淘汰规则不划算（越简单的策略越不会出错）。
 */
const thumbCache = new Map()
const THUMB_CACHE_MAX = 600

/**
 * 缩略图的生成**并发上限**（配合下面的按需唤醒队列）。
 *
 * 为什么需要：浏览器会**并行**拉几十张缩略图（我们实测一个图墙 54 张）。
 * 每张的 GIF LZW 是同步 CPU 活，几十个同时跑会把事件循环堵住 ——
 * 表现是"点一下要等好几秒"。所以同一时刻只让 N 张真正在算。
 */
const THUMB_CONCURRENCY = 3
/** 等待队列（FIFO）**有上限**：排太长的请求直接回落原图，不无限堆积。 */
const THUMB_QUEUE_MAX = 64
/** 排队等多久还没轮上就回落原图（**必须有超时**，否则请求会无限期挂着、页面像死了）。 */
const THUMB_WAIT_TIMEOUT_MS = 3000
let thumbBusy = 0
const thumbQueue = []

/**
 * 申请一个缩略图生成名额。
 *
 * @returns {Promise<boolean>} true = 拿到了（用完必须 `releaseThumbSlot()`）；
 *   false = 队列满或等超时 → 调用方**回落原图**
 */
function acquireThumbSlot() {
  if (thumbBusy < THUMB_CONCURRENCY && thumbQueue.length === 0) {
    thumbBusy += 1
    return Promise.resolve(true)
  }
  if (thumbQueue.length >= THUMB_QUEUE_MAX) return Promise.resolve(false)
  return new Promise((resolve) => {
    const entry = { resolve, timer: null }
    entry.timer = setTimeout(() => {
      const i = thumbQueue.indexOf(entry)
      if (i >= 0) thumbQueue.splice(i, 1)
      resolve(false)
    }, THUMB_WAIT_TIMEOUT_MS)
    thumbQueue.push(entry)
  })
}

/** 释放名额并唤醒下一个等待者。 */
function releaseThumbSlot() {
  thumbBusy = Math.max(0, thumbBusy - 1)
  const next = thumbQueue.shift()
  if (!next) return
  clearTimeout(next.timer)
  thumbBusy += 1
  next.resolve(true)
}

/**
 * 请求日志：**只记"非图片"的请求**，并按 `路径+状态` 去重（每种只打一次）。
 *
 * ★ 为什么要它：这个工具卡死过一次，而当时**没有任何日志**可看 ——
 *   只能靠猜（"是不是缩略图太多？是不是浮层？"）。浏览器请求了什么、
 *   哪一条 404 / 403，是排查这类问题最直接的证据。
 * ★ 为什么**不记成功的图片**：一个图墙 54 张缩略图，全打出来会把有用信息淹掉。
 *   `/img/` 与 `/thumb/` 只在**出错**时各记一条。
 */
const seenRequests = new Set()
function logRequest(log, method, path, status) {
  if (typeof log !== 'function') return
  const isAsset = path.startsWith('/img/') || path.startsWith('/thumb/')
  if (isAsset && status < 400) return
  const key = `${method} ${path} ${status}`
  if (seenRequests.has(key)) return
  seenRequests.add(key)
  log(`[标注台] ${key}`)
}

/**
 * 撤销栈：**只在内存**，进程结束即清。
 *
 * 为什么不做成持久化：它的用途是"刚点错了，撤一下"—— 跨重启的撤销没有意义，
 * 而且要在磁盘上再存一份历史（又多一个可能损坏的状态）。够用就好。
 */
const undoStack = []
const UNDO_MAX = 200

/** 读配置（与别处同一口径：缺文件时给可执行的提示）。 */
export function loadConfig() {
  const path = join(PKG_ROOT, 'config.json')
  if (!existsSync(path)) {
    throw new Error(`找不到 ${path}\n先复制模板：copy config.example.json config.json`)
  }
  return normalizeConfig(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * 词表 → 给页面用的形状（**全字段 + 三个算出来的标记**）。
 *
 * ★ 为什么要有这个函数（实测踩到）：`/api/labels` 起初直接回 `activeLabels()` 的原始对象，
 *   而 `/api/list` 回的是加工过的 —— 两份形状不一样，页面拿 `/api/labels` 去编辑标签时
 *   `auto`/`risk`/`protected` 全是 undefined，界面上"能不能自主发"和"慎发"两个提示消失。
 *   同一样东西有两种形状是必然出错的，所以**只有这一处**产出它。
 *
 * `cues` 给**全量**（不像 `/api/list` 只给前 3 条）：编辑表单要显示用户自己填的全部语境。
 */
function pageLabels(vocabOpts) {
  return activeLabels(vocabOpts).map((l) => ({
    id: l.id,
    name: l.name,
    axis: l.axis,
    // ★ 两组线索都要给（0.2.4 第十三轮）。漏掉 `otherCues` 的后果不是"显示不出来" ——
    //   而是**编辑表单回填为空、一保存就把"对方会说什么"整组清掉**（静默丢数据）。
    cues: Array.isArray(l.cues) ? l.cues : [],
    otherCues: Array.isArray(l.otherCues) ? l.otherCues : [],
    antiCues: Array.isArray(l.antiCues) ? l.antiCues : [],
    exclude: Array.isArray(l.exclude) ? l.exclude : [],
    excludeOther: Array.isArray(l.excludeOther) ? l.excludeOther : [],
    // ★ "能不能被自主补触发"是**从轴推出来的**（不是存下来的开关）：
    //   表达类可以，礼节/交付/风险不行。界面照这个显示，不另外造字段。
    auto: activeIsAutoAllowed(l.id, vocabOpts),
    risk: l.id === RISK_LABEL,
    protected: l.id === RISK_LABEL,
  }))
}

/** 组装一条给页面用的记录（**只给页面需要的字段**，别把整个库条目抖出去）。 */
function toRow(entry, rel, root, vocabOpts) {
  const abs = join(root, ...String(rel).split('/'))
  let exists = false
  try {
    exists = existsSync(abs)
  } catch {
    exists = false
  }
  return {
    rel,
    shortId: String(entry.id ?? '').slice(0, 12),
    name: entry.originName || String(rel).split('/').pop(),
    sizeMB: Math.round(((entry.bytes ?? 0) / 1024 / 1024) * 10) / 10,
    mediaType: entry.mediaType ?? '',
    primary: entry.primary ?? null,
    primaryName: entry.primary ? activeLabelName(entry.primary, vocabOpts) : null,
    labels: Array.isArray(entry.labels) ? entry.labels : [],
    confidence: entry.primaryConfidence ?? null,
    source: entry.source ?? '',
    manual: String(entry.source ?? '') === 'manual',
    // ★ 识图结果与"文件名先验"冲突的样本 —— 实测识图判错是常态，
    //   这批是**最值得人看一眼**的（标注台把它做成一个筛选项）
    disputed: entry.disputed === true,
    originHint: entry.originHint ?? null,
    originName: entry.originName ?? null,
    lowConfidence: entry.primaryConfidence != null && entry.primaryConfidence < MIN_TAG_CONFIDENCE,
    risk: entry.risky === true,
    exists,
    url: `/img/${rel.split('/').map(encodeURIComponent).join('/')}`,
    // ★★ 图墙**必须**用小图（实测：直接拿原图当缩略图会把标签页卡死 ——
    //    `moved` 一选就是 54 张动图、159MB，浏览器解码到关不掉）。
    //    这里给的是服务端缩出来的灰度小 PNG（见 makeStickerThumbnail）。
    thumb: `/thumb/${rel.split('/').map(encodeURIComponent).join('/')}?w=${THUMB_SIDE}`,
    thumbFallback: entry.mediaType && !/gif|png/i.test(entry.mediaType),
  }
}

/** 全量快照（页面轮询/刷新用）。 */
function snapshot({ workspace, dir }, vocabOpts) {
  const root = stickerRoot({ workspace, dir })
  const library = readStickerLibrary({ workspace, dir })
  const rows = Object.entries(library.entries).map(([rel, e]) => toRow(e, rel, root, vocabOpts))
  rows.sort((a, b) => {
    const pa = a.primary ? 1 : 0
    const pb = b.primary ? 1 : 0
    if (pa !== pb) return pa - pb // 没标签的排前面（那才是要干的活）
    return String(a.name).localeCompare(String(b.name), 'zh')
  })
  // ★ 张数按**词表里现有的**标签统计，未知标签（词表改过、库里留着旧 id）也如实列出来，
  //   否则"某个标签下到底有几张"这个问题会答错。
  const counts = {}
  const unknownCounts = {}
  const table = activeLabels(vocabOpts)
  const known = new Set(table.map((l) => l.id))
  for (const l of table) counts[l.id] = 0
  for (const r of rows) {
    if (!r.primary) continue
    if (known.has(r.primary)) counts[r.primary] += 1
    else unknownCounts[r.primary] = (unknownCounts[r.primary] ?? 0) + 1
  }
  return {
    root,
    rows: rows.slice(0, MAX_ROWS),
    total: rows.length,
    untagged: rows.filter((r) => !r.primary).length,
    manual: rows.filter((r) => r.manual).length,
    disputed: rows.filter((r) => r.disputed && !r.manual).length,
    risky: rows.filter((r) => r.risk).length,
    missing: rows.filter((r) => !r.exists).length,
    // ★ 与 `/api/list` **同一份形状**（同一个 `pageLabels`）—— 见它的注释：
    //   两处形状不一致会让页面上"能不能自主发 / 慎发"两个提示凭空消失（实测踩过）。
    labels: pageLabels(vocabOpts),
    counts,
    unknownCounts,
    axes: labelAxesFor(vocabOpts),
    minUsable: 3,
  }
}

/** 轴清单：词表里出现的轴 + 内置轴的并集（新建标签时给下拉用）。 */
function labelAxesFor(vocabOpts) {
  const out = [...LABEL_AXES]
  for (const l of activeLabels(vocabOpts)) if (l.axis && !out.includes(l.axis)) out.push(l.axis)
  return out
}

/** 本进程实际监听的端口（重启时沿用它）。由 `server.on('listening')` 填。 */
let currentPort = null

/**
 * 「重听次数」—— 页面的**版本号**。
 *
 * ★ 为什么不能拿 `startedAt` 当版本号（原地重听之后就不行了）：
 *   `startedAt` 是**进程**启动时间，而"重启"现在是同进程重听 —— 进程一直没换，
 *   这个值当然不变，页面于是永远发现不了"服务端已经换过一轮"。
 *   每成功重听一次就 +1，页面拿它跟加载时的值比，一比就知道自己是不是旧的。
 */
let rebindCount = 0

/**
 * 「重启服务」= **关掉监听、再把同一个端口绑回来**（同一个进程，不 spawn 子进程）。
 *
 * ★★ 为什么是这条路（详见文件头"第十八轮"那段）：spawn 一条新进程再退出自己，
 *   成败取决于"新进程能不能比旧进程活得久"，而那取决于宿主怎么杀进程树 ——
 *   实测同一条代码在不同宿主下结果不同，无法用代码保证。同进程重听则把这件事
 *   变成**纯本地操作**：端口是它自己刚释放的，没有交接、没有竞争者。
 *
 * ★ 关监听要**等 close 回调**再去绑：`server.close()` 是异步的，立刻 bind 会撞
 *   EADDRINUSE；留几次 400ms 重试兜住"内核还没放干净"的情况。
 * ★ 绑之前先把缩略图缓存清掉：重听的一大动机就是"代码改了想生效"，
 *   而缩略图解码逻辑若有变化，旧缓存会让新代码看不出效果。
 *
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {() => void} [onRebound] 绑回成功后的回调（打印启动横幅等）
 * @returns {Promise<{ok:true,port:number}|{ok:false,why:string}>}
 */
async function rebindInPlace(server, port, onRebound = () => {}) {
  // ① 关监听（已经没在听就直接跳过）
  if (server.listening) {
    await new Promise((resolvePromise) => {
      server.close(() => resolvePromise())
      // keep-alive 连接会让 close 一直不回 —— 强制断开（Node ≥18.2 有这个方法）
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    })
  }
  // ② 清掉进程内缓存（让"重启"这件事对新代码/新解码逻辑真的有意义）
  thumbCache.clear()

  // ③ 绑回同一端口：期间装一个临时 error 处理器，把 EADDRINUSE 变成"再试一次"
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const bindOnce = () => new Promise((resolvePromise) => {
    const onError = (e) => {
      server.removeListener('listening', onListening)
      resolvePromise({ ok: false, code: e?.code })
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolvePromise({ ok: true })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })

  for (let attempt = 1; attempt <= 10; attempt++) {
    const r = await bindOnce()
    if (r.ok) {
      rebindCount += 1 // 页面拿这个当版本号（见 `rebindCount` 的说明）
      onRebound()
      return { ok: true, port }
    }
    if (r.code !== 'EADDRINUSE') return { ok: false, why: `绑回 ${port} 失败：${r.code}` }
    if (attempt === 10) return { ok: false, why: `端口 ${port} 一直被别的进程占着` }
    await sleep(400)
  }
  return { ok: false, why: '绑回端口失败' }
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolvePromise) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1_000_000) raw = raw.slice(0, 1_000_000) // 防呆：这接口只收小 JSON
    })
    req.on('end', () => {
      try {
        resolvePromise(raw ? JSON.parse(raw) : {})
      } catch {
        resolvePromise(null)
      }
    })
  })
}

/** 起服务器（**导出**是为了能被测试直接起一个，不必 spawn 子进程）。 */
export function createLabelServer({ workspace, dir = 'stickers', log = () => {} } = {}) {
  const root = stickerRoot({ workspace, dir })
  if (!root) throw new Error('没有工作区，读不到表情库')

  /**
   * 「自动分类未标注的图」任务控制器（0.2.4 第十四轮）。
   *
   * ★ 为什么放在**这里**（这个工具是独立进程，不连桥接）：
   *   标注台本来就是"把没标签的图处理掉"的地方 —— 而**打标签这件事只有模型能做**
   *   （看图判断语义）。人一张张过是主路，但几百张待打时先让模型过一遍能省大量人力。
   *   所以这个按钮的语义与"重新打标签"不同：它**只处理未标注的**（`onlyPending`），
   *   已经有人工/模型标签的一张都不动。
   *
   * ★ 模型通路在这里独立解析（`resolveDirectTarget`，与桥接共用同一套配置与规则）——
   *   密钥不下发到页面，只在本进程内使用。
   */
  const retagJob = createRetagJob({
    log: (m) => log(m),
    resolvePreflight: () => preflightRetag({ workspace, dir }, { onlyPending: true }),
  })

  /** 词表口径：一切读写都带上这两个坐标（工作区 + 库目录）。 */
  const vocabOpts = () => ({ workspace, dir })
  const snap = () => snapshot({ workspace, dir }, vocabOpts())

  /**
   * 防目录穿越用的**绝对**库根。
   *
   * ★★ 为什么必须单独算一个绝对的（实测踩到，而且只在真实使用时才暴露）：
   *   `stickerRoot()` 在 `workspace` 是相对路径（`config.json` 里默认就是
   *   `workspace-qq`）时返回**相对**路径 `workspace-qq\stickers`，而请求里的
   *   路径经过 `resolve()` 是**绝对**的 —— `abs.startsWith(root)` 于是永远 false，
   *   结果是**每一张图都 403**（页面整片空白，而接口 JSON 全正常，极难一眼看出）。
   *   测试里没暴露是因为测试的工作区是 `mkdtempSync` 给的绝对路径。
   *   ∴ 判穿越必须在**同一坐标系**里做：两边都转成绝对路径。
   */
  const rootAbs = normalize(resolve(root))

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    // 每条响应结束时记一笔（去重后的）—— 排查"浏览器到底请求了什么"用
    const startedAt = Date.now()
    res.on('finish', () => {
      logRequest(log, req.method ?? 'GET', path, res.statusCode)
      if (process.env.DSH_LABEL_VERBOSE) log(`[标注台] ${req.method} ${path} ${res.statusCode} ${Date.now() - startedAt}ms`)
    })

    // ── favicon：给一个空图，省掉浏览器一条 404（那 404 会出现在控制台里误导人）──
    if (req.method === 'GET' && (path === '/favicon.ico' || path === '/favicon.png')) {
      res.writeHead(204, { 'cache-control': 'max-age=86400' })
      res.end()
      return
    }

    // ── 缩略图：与 /img/ 同一套穿越防护，但返回用服务端缩出来的小 PNG ──
    //
    // ★ 为什么有这一条：图墙直接引用原图会把浏览器卡死（`moved` 一选 = 54 张动图
    //   159MB，标签页连关闭按钮都点不动）。缩略图把 35MB 压到 496KB（73x）。
    if (req.method === 'GET' && path.startsWith('/thumb/')) {
      const rel = decodeURIComponent(path.slice('/thumb/'.length))
      const abs = normalize(resolve(rootAbs, ...rel.split('/')))
      if (abs !== rootAbs && !abs.startsWith(rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep)) {
        res.writeHead(403).end('forbidden')
        return
      }
      if (!existsSync(abs)) {
        res.writeHead(404).end('not found')
        return
      }
      const want = Math.max(16, Math.min(512, Number(url.searchParams.get('w')) || THUMB_SIDE))
      let st = null
      try {
        st = statSync(abs)
      } catch {
        st = null
      }
      // 缓存键带 mtime+大小：文件被换掉（同一路径不同内容）时自动失效
      const key = `${abs}|${want}|${st?.mtimeMs ?? 0}|${st?.size ?? 0}`
      const hit = thumbCache.get(key)
      if (hit) {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': hit.length, 'cache-control': 'no-store' })
        res.end(hit)
        return
      }
      let made = null
      // ★★ 并发闸门（**按需唤醒**，不是轮询 sleep）。
      //
      // 为什么要有闸门：GIF 解码是同步 CPU 活，浏览器会**并行**拉几十张
      // （实测一个图墙 54 张），不限并发就把事件循环堵住，页面表现成"卡住"。
      //
      // ⚠️ 第一版写的是"忙就 sleep 25ms 再看一眼"的轮询 —— 那样每个请求都会
      //    自己反复醒来（几十个请求 × 几十次轮询），既浪费又**没有超时**：
      //    真出意外时请求会一直挂着，浏览器就一直等，看起来就是死页面。
      //    现在换成队列 + 唤醒 + **超时兜底**：到点还没轮上就回落原图，
      //    绝不会让请求无限期挂着。
      const gotSlot = await acquireThumbSlot()
      if (gotSlot) {
        try {
          made = makeStickerThumbnail(readFileSync(abs), want)
        } catch {
          made = null
        } finally {
          releaseThumbSlot()
        }
      }
      if (!made) {
        // 解不出来（WebP/JPEG/异常 GIF）→ **回落原图**，让页面至少能看见东西
        const mime = IMAGE_MIME[extname(abs).toLowerCase()]
        if (!mime) {
          res.writeHead(404).end('not found')
          return
        }
        res.writeHead(302, { location: `/img/${rel.split('/').map(encodeURIComponent).join('/')}` })
        res.end()
        return
      }
      if (thumbCache.size >= THUMB_CACHE_MAX) thumbCache.clear()
      thumbCache.set(key, made)
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': made.length, 'cache-control': 'no-store' })
      res.end(made)
      return
    }

    // ── 图片：只从库目录里取，且路径必须落在库内（防目录穿越）──
    if (req.method === 'GET' && path.startsWith('/img/')) {
      const rel = decodeURIComponent(path.slice('/img/'.length))
      const abs = normalize(resolve(rootAbs, ...rel.split('/')))
      // 用 `rootAbs + sep` 判前缀：否则 `/库/../库2` 这种"同前缀不同目录"能溜过去
      if (abs !== rootAbs && !abs.startsWith(rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep)) {
        res.writeHead(403).end('forbidden')
        return
      }
      const mime = IMAGE_MIME[extname(abs).toLowerCase()]
      if (!mime || !existsSync(abs)) {
        res.writeHead(404).end('not found')
        return
      }
      try {
        const bytes = readFileSync(abs)
        res.writeHead(200, { 'content-type': mime, 'content-length': bytes.length, 'cache-control': 'no-store' })
        res.end(bytes)
      } catch (error) {
        res.writeHead(500).end(String(error?.message ?? error))
      }
      return
    }

    // ── 自动分类「未标注」的图（只打没标签的那些，已标的绝不动）──
    //
    // 形状与桥接的「重新打标签」一致：**预检 → 发起 → 轮询 → 可停止**。
    // 为什么不让 HTTP 请求挂着：打几十张要几分钟，浏览器/代理不会等那么久。
    if (path === '/api/retag') {
      try {
        if (req.method === 'GET') {
          const pre = preflightRetag({ workspace, dir }, { onlyPending: true })
          json(res, 200, { ok: true, ...retagJob.status(), preflight: pre })
          return
        }
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: '只支持 GET / POST' })
          return
        }
        const body = (await readBody(req)) ?? {}
        const action = String(body.action ?? 'start')
        if (action === 'status') {
          json(res, 200, { ok: true, ...retagJob.status() })
          return
        }
        if (action === 'abort') {
          const r = retagJob.abort()
          json(res, 200, { ok: r.ok, error: r.ok ? undefined : r.why, ...retagJob.status() })
          return
        }
        // 起任务：模型通路在本进程解析（密钥不下发页面）
        const config = loadConfig()
        const target = resolveDirectTarget({ config })
        if (!target?.ok) {
          json(res, 422, {
            ok: false,
            error:
              `没有可用于自动分类的模型通路：${target?.why ?? '未知'}。` +
              '打标签要「看图」，需要一把能直连的 API key（设置里的 wake.judge.apiKey）与一个支持图片输入的模型。',
          })
          return
        }
        const r = retagJob.start({
          workspace,
          dir,
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model: target.model,
          // ★ 只处理**未标注的**：这是"自动分类"的语义。
          //   已有人工/模型标签的一张都不动 —— 否则会把人刚标好的覆盖掉。
          onlyPending: true,
        })
        json(res, r.ok ? 200 : 422, r.ok ? { ok: true, ...r, ...retagJob.status() } : { ok: false, error: r.why })
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }

    // ── 进程控制：**在 UI 里退出 / 重启**（0.2.4 第十五轮）──────────────
    //
    // ★ 为什么需要（用户明确要求）：这个工具是**独立进程 + 固定端口**，而端口被占时
    //   新进程连启动都失败（`EADDRINUSE`），页面上什么提示都没有 —— 用户只能去
    //   任务管理器里翻 `node.exe`。实测反复卡在这里（而且提权启动的进程，
    //   连外部 `taskkill` 都会被拒）。
    //   ∴ 把"关掉自己"做成页面上的一个按钮：这是**唯一**总能杀对进程的地方
    //     （进程自己知道自己是谁），也不依赖任何提权。
    //
    // ★ 退出前先回响应、再异步退出：立刻 `process.exit()` 会让浏览器收到
    //   "连接被重置"，页面只能报一个含糊的网络错误；先答完再退就能显示"已退出"。
    if (path === '/api/server' && req.method === 'POST') {
      const body = (await readBody(req)) ?? {}
      const action = String(body.action ?? '')
      if (action === 'shutdown') {
        json(res, 200, { ok: true, action, message: '标注台已退出，端口已释放' })
        log('[标注台] 收到退出请求 → 关闭进程')
        // 给响应一点时间真的发出去，再退出
        setTimeout(() => process.exit(0), 150)
        return
      }
      if (action === 'restart') {
        // ★★ 同进程原地重听（详见 `rebindInPlace` 与文件头"第十八轮"那段）：
        //   旧进程自己释放端口再绑回来 —— 没有"新旧进程抢端口"的空窗，也不需要
        //   子进程比父进程活得久（那条路在"双击 .bat 前台跑"的用法下会失败）。
        //   这里必须**先回响应再重听**：重听会关掉监听，若先关，这个响应就发不出去。
        json(res, 200, { ok: true, action, message: '已重载（端口不变）—— 页面会自己刷新构建标记' })
        log(`[标注台] 收到重启请求 → 同进程原地重听端口 ${currentPort ?? '(未知)'}`)
        setTimeout(async () => {
          const r = await rebindInPlace(server, currentPort ?? 4399, () => {
            log(`[标注台] 重听成功，端口 ${currentPort ?? 4399} 已恢复服务`)
          })
          if (!r.ok) {
            log(`❌ [标注台] 重听失败：${r.why}`)
            // 重听失败就意味着这个工具已经不可用了，但**不能悄悄消失**：
            // 说清楚原因（多半是端口被别的进程抢走了），让人知道该怎么办。
            process.exitCode = 1
          }
        }, 120)
        return
      }
      json(res, 422, { ok: false, error: `不认识的 action：${action}（只支持 shutdown / restart）` })
      return
    }

    // ── 数据 ──
    // 构建/运行状态：页面右上角那行"构建 …"就读它。
    //
    // ★ 为什么值得专门加一条：排查"我改了怎么还是老样子"时，最费时间的一步是
    //   分清**三种可能**：浏览器缓存、旧进程占着端口、代码真没改。
    //   把"进程启动时间 + 关键参数"暴露出来，这一步就变成看一眼的事。
    if (req.method === 'GET' && path === '/api/health') {
      json(res, 200, {
        ok: true,
        startedAt: new Date(STARTED_AT).toISOString(),
        // ★ 页面用它判断"服务端是否重听过一轮"（`startedAt` 在原地重听下不会变）
        buildId: rebindCount,
        uptimeMs: Date.now() - STARTED_AT,
        hasThumb: true, // 老版本没有这个字段也没有这一条路由（页面据此判断新旧）
        thumbCacheMax: THUMB_CACHE_MAX,
        thumbCacheSize: thumbCache.size,
        thumbConcurrency: THUMB_CONCURRENCY,
        thumbBusy,
        thumbQueue: thumbQueue.length,
        root: rootAbs,
      })
      return
    }

    if (req.method === 'GET' && path === '/api/list') {
      try {
        json(res, 200, { ok: true, ...snap() })
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }

    // ── 词表：读全字段（页面要用 cues / auto / risk 来显示与编辑）──
    if (req.method === 'GET' && path === '/api/labels') {
      try {
        const status = labelTableStatus(vocabOpts())
        json(res, 200, {
          ok: true,
          labels: pageLabels(vocabOpts()),
          axes: labelAxesFor(vocabOpts()),
          status,
        })
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }

    // ── 词表：增 / 改 / 删 / 复位（★ 改完**下一轮对话即生效**，不用重启桥接）──
    if (req.method === 'POST' && path === '/api/labels') {
      const body = await readBody(req)
      if (!body) {
        json(res, 400, { ok: false, error: '请求体不是 JSON' })
        return
      }
      const action = String(body.action ?? 'create')
      try {
        let result
        if (action === 'create') {
          result = createLabel(vocabOpts(), {
            name: body.name,
            axis: body.axis,
            cues: body.cues,
            // ★ 对方会说什么（0.2.4 第十三轮）—— 新建时就能给，
            //   因为用户建的标签常常是场景驱动的（"对方加班到很晚"该配一张）
            otherCues: body.otherCues,
          })
          if (!result.ok) throw new Error(result.why ?? '新建标签失败')
        } else if (action === 'update') {
          result = updateLabel(vocabOpts(), body.id, {
            name: body.name,
            axis: body.axis,
            cues: body.cues,
            otherCues: body.otherCues,
          })
          if (!result.ok) throw new Error(result.why ?? '改标签失败')
        } else if (action === 'delete') {
          // ★★ 删除标签 = **删标签 + 把那些图恢复成未标注**（用户明确要求的行为）。
          //
          // 为什么必须一起做：只删标签、把图留在"引用已删标签"的状态，等于把一堆图
          // 悬在半空 —— 界面能列出来，但谁也说不清它们算不算有标签、该不该参与选图。
          // 恢复成未标注（primary 清空 + 置信度清 0）之后语义是明确的：
          // **不会被选中**，等着被重新标 —— 这也是"删错了标签想重来"时最顺的落点。
          //
          // ★ 有图时仍然要**先确认**（不是保护标签，是保护"图上已有的判断"）：
          //   这一步会把那些图上的标注**清掉**，属于会丢人力的操作。
          const used = countLabelUse(body.id)
          if (used > 0 && body.confirm !== true) {
            json(res, 409, {
              ok: false,
              error: `「${body.id}」下还有 ${used} 张图。删掉标签后它们会**恢复成未标注**（不会被选中，等着重新标）`,
              used,
              needConfirm: true,
            })
            return
          }
          // 先把"改前"整批记下来 —— 删除是破坏性的，必须能一步撤销回去
          const labelNameBefore = activeLabelName(body.id, vocabOpts()) // 删之前先把名字取下来（撤销提示要用）
          // ★ 位置也要记：词表的**顺序**决定"挑主标签"的优先级，恢复到原位才是真恢复
          const labelAt = activeLabels(vocabOpts()).findIndex((l) => l.id === body.id)
          const libraryBefore = readStickerLibrary({ workspace, dir })
          const beforeBatch = {}
          for (const [rel, entry] of Object.entries(libraryBefore.entries)) {
            const labels = Array.isArray(entry.labels) ? entry.labels : []
            if (entry.primary !== body.id && !labels.includes(body.id)) continue
            beforeBatch[rel] = {
              primary: entry.primary ?? null,
              labels: [...labels],
              primaryConfidence: entry.primaryConfidence ?? null,
              source: entry.source ?? '',
            }
          }
          result = deleteLabel(vocabOpts(), body.id)
          if (!result.ok) throw new Error(result.why ?? '删标签失败')
          // 删完标签再摘引用（顺序不能反：先摘的话 `countLabelUse` 会算成 0）
          const cleared = clearLabelFromLibrary({ workspace, dir }, body.id)
          if (Object.keys(beforeBatch).length) {
            pushUndoBatch({
              action: 'delete-label',
              rels: beforeBatch,
              label: labelNameBefore,
              // ★ 撤销要用：被删掉的那份定义 + 它原来的位置
              labelDef: result.label ?? result.removed ?? null,
              labelAt,
            })
          }
          result.used = used
          result.unlabeled = cleared.emptied?.length ?? 0
          result.relabeledSecondary = cleared.secondaryOnly ?? 0
        } else if (action === 'reset') {
          // 复位 = 回到出厂词表。会丢掉人工加的标签（库里的图不动）。
          const before = activeLabels(vocabOpts()).length
          result = resetLabels(vocabOpts())
          if (!result.ok) throw new Error(result.why ?? '复位失败')
          result.before = before
        } else {
          json(res, 422, { ok: false, error: `不认识的 action：${action}` })
          return
        }
        log(`[标注台] 词表 ${action} → ${result?.label?.name ?? body.id ?? ''}`.trim())
        json(res, 200, { ok: true, action, ...result, labels: activeLabels(vocabOpts()), axes: labelAxesFor(vocabOpts()) })
      } catch (error) {
        // 词表校验失败都是"用户输入的问题"，用 422 让页面把原话显示出来
        json(res, 422, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }

    // ── 按标签看图：这个标签下的全部条目（图墙用）──
    if (req.method === 'GET' && path === '/api/browse') {
      const want = String(url.searchParams.get('label') ?? '')
      try {
        const s = snap()
        const rows = want ? s.rows.filter((r) => r.primary === want) : s.rows.filter((r) => !r.primary)
        json(res, 200, { ok: true, label: want, rows, total: rows.length, labels: s.labels, counts: s.counts })
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }

    if (req.method === 'POST' && path === '/api/save') {
      const body = await readBody(req)
      if (!body) {
        json(res, 400, { ok: false, error: '请求体不是 JSON' })
        return
      }
      const rel = String(body.rel ?? '')
      const action = String(body.action ?? 'set')
      const library = readStickerLibrary({ workspace, dir })
      const entry = library.entries[rel]
      if (!entry) {
        json(res, 404, { ok: false, error: `库里没有这条：${rel}` })
        return
      }

      // ── 撤销用的"改前"快照 ──
      const before = {
        primary: entry.primary ?? null,
        labels: [...(entry.labels ?? [])],
        primaryConfidence: entry.primaryConfidence ?? null,
        source: entry.source ?? '',
      }

      if (action === 'skip') {
        // "跳过"= 把标签置空并**记成手动**（于是自动重打也不会给它安一个猜的标签）
        const r = applyStickerLabels(
          { workspace, dir },
          { [rel]: { primary: '', labels: [], confidence: 0, source: 'manual' } },
        )
        pushUndo({ rel, before })
        json(res, 200, {
          ok: true,
          action,
          changed: r.changed,
          row: toRow(readStickerLibrary({ workspace, dir }).entries[rel], rel, root, vocabOpts()),
        })
        return
      }

      const primary = resolveActiveLabelId(body.label, vocabOpts())
      if (!primary) {
        // ★ 不猜：认不出的标签直接拒绝，并把可用标签回给页面（页面据此提示）
        json(res, 422, {
          ok: false,
          error: `不是词表里的标签：${body.label}`,
          labels: activeLabels(vocabOpts()).map((l) => l.id),
        })
        return
      }
      const secondary = (Array.isArray(body.secondary) ? body.secondary : [])
        .map((x) => resolveActiveLabelId(x, vocabOpts()))
        .filter((x) => x && x !== primary)
        .slice(0, 2)
      const r = applyStickerLabels(
        { workspace, dir },
        {
          [rel]: {
            primary,
            labels: [primary, ...secondary],
            confidence: 1,
            source: 'manual', // ★ 人工标注：重打标签时会被跳过
          },
        },
      )
      pushUndo({ rel, before })
      json(res, 200, {
        ok: true,
        action: 'set',
        changed: r.changed,
        unknown: r.unknown ?? [],
        row: toRow(readStickerLibrary({ workspace, dir }).entries[rel], rel, root, vocabOpts()),
      })
      return
    }

    if (req.method === 'POST' && path === '/api/undo') {
      const last = undoStack.pop()
      if (!last) {
        json(res, 200, { ok: false, error: '没有可撤销的操作' })
        return
      }
      // ★ 撤销栈里有**两种**条目：
      //   · 单条（贴标签/跳过）—— `{ rel, before }`
      //   · 整批（删标签）—— `{ action:'delete-label', rels:{rel:before,…} }`
      //     ★ 删标签会一次改动几十条，必须**整批一次撤完**；
      //       否则用户要按几十次 Ctrl+Z 才能回到原样（等于不能撤）。
      // ★★ 撤销"删标签"时，**必须先把标签加回词表**，再恢复图上的引用。
      //
      // 为什么顺序不能反（实测抓到的缺陷）：`applyStickerLabels` 走**生效词表**校验，
      // 标签不在表里就被判"认不出" → 那些图的 primary 被丢掉。
      // 于是删掉「笑死」再撤销，图仍然是未标注，**而且不报错** —— 看起来就是"撤销没用"。
      let restoredLabel = null
      if (last.action === 'delete-label' && last.labelDef) {
        const back = restoreLabel(vocabOpts(), { ...last.labelDef, at: last.labelAt })
        if (back.ok) restoredLabel = back.label ?? last.labelDef
      }
      const entries = last.rels
        ? Object.entries(last.rels)
        : [[last.rel, last.before]]
      const updates = {}
      for (const [rel, before] of entries) {
        if (!before) continue
        updates[rel] = {
          primary: before.primary ?? '',
          labels: before.labels ?? [],
          confidence: before.primaryConfidence,
          source: before.source || '',
        }
      }
      const restored = applyStickerLabels({ workspace, dir }, updates)
      const firstRel = entries[0]?.[0] ?? null
      json(res, 200, {
        ok: true,
        rel: firstRel,
        // 整批撤销时回报改了几条（页面据此说清"撤回了什么"）
        changed: restored.changed,
        batch: Boolean(last.rels),
        action: last.action ?? null,
        label: last.action === 'delete-label' ? (last.label ?? null) : null,
        labelRestored: restoredLabel ? restoredLabel.name : null,
        labels: activeLabels(vocabOpts()),
        axes: labelAxesFor(vocabOpts()),
        row: firstRel ? toRow(readStickerLibrary({ workspace, dir }).entries[firstRel], firstRel, root, vocabOpts()) : null,
        remaining: undoStack.length,
        // 若有引用因词表没恢复成功而丢不掉，如实说出来（不许静默）
        unknown: restored.unknown ?? [],
      })
      return
    }

    // ── 静态页 ──
    const relFile = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
    const abs = normalize(join(STATIC, relFile))
    if (!abs.startsWith(normalize(STATIC)) || !existsSync(abs)) {
      res.writeHead(404).end('not found')
      return
    }
    const isHtml = extname(abs) === '.html'
    const type = isHtml
      ? 'text/html; charset=utf-8'
      : extname(abs) === '.js'
        ? 'text/javascript; charset=utf-8'
        : 'text/css; charset=utf-8'
    let body = readFileSync(abs)
    if (isHtml) {
      // ★★ 给 app.js / style.css 加上**构建版本查询串**。
      //
      // 为什么必须做这一步（实测踩到）：这个工具卡死的那几轮里，有一轮我无法排除
      // "浏览器还在跑旧的 app.js" 这个可能 —— 而 `cache-control: no-store` 并不能
      // 100% 保证（强制缓存、代理、扩展缓存都可能插一脚）。加了版本串之后，
      // 每次**服务重启**（= 代码改过）URL 就变，浏览器**必须**重新取，
      // 同时 css/js 又能用 `max-age` 正常缓存，不用每次都重下。
      // 排查时只要看右上角的「构建 …」与这个串一致，就能确定跑的是哪一版。
      const v = String(STARTED_AT)
      body = Buffer.from(
        body
          .toString('utf8')
          .replace(/href="\/style\.css"/g, `href="/style.css?v=${v}"`)
          .replace(/src="\/app\.js"/g, `src="/app.js?v=${v}"`),
        'utf8',
      )
    }
    res.writeHead(200, {
      'content-type': type,
      // HTML 永远不缓存（它是"哪一版"的入口）；带版本串的 css/js 可以放心缓存
      'cache-control': isHtml ? 'no-store' : 'public, max-age=604800',
      'content-length': body.length,
    })
    res.end(body)
  })

  /** 数这个标签下有多少张（删除前提示用）。 */
  function countLabelUse(labelId) {
    const id = resolveActiveLabelId(labelId, vocabOpts())
    if (!id) return 0
    const library = readStickerLibrary({ workspace, dir })
    let n = 0
    for (const entry of Object.values(library.entries)) {
      if (entry.primary === id) n += 1
      else if (Array.isArray(entry.labels) && entry.labels.includes(id)) n += 1
    }
    return n
  }

  // 记下实际端口：重启时要沿用同一个（否则页面刷新会打到旧端口上）
  server.on('listening', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') currentPort = addr.port
  })

  return server
}

function pushUndo(item) {
  undoStack.push(item)
  if (undoStack.length > UNDO_MAX) undoStack.shift()
}

/**
 * 记一条**整批**撤销（删标签用）。
 *
 * ★ 为什么单条撤销不够：删一个标签会一次改动几十条（把它们恢复成未标注）。
 *   如果撤销栈里一条只记一张图，用户得按几十次 Ctrl+Z —— 那等于不能撤。
 *   所以整批当成**一个**撤销步骤。
 */
function pushUndoBatch({ action, rels, label = null, labelDef = null, labelAt = -1 }) {
  pushUndo({ action, rels, label, labelDef, labelAt })
}
