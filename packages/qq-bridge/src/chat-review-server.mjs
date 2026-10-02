/**
 * 聊天记录评审台的 HTTP 服务（**独立小工具**，不属于控制台）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么不做进控制台（与表情包标注台同一条理由）
 * ══════════════════════════════════════════════════════════════════════════
 * 评审是**一次性、用完就关**的活：坐下来把几百条记录一条条过完，然后关掉。
 * 控制台是"看机器人整体状态"的地方 —— 两边的形态互相拖累（控制台要迁就
 * 大段聊天记录，评审台要迁就后台的加载逻辑）。所以它是一个独立文件夹 +
 * 独立进程 + 零依赖（只用 Node 内置模块）。
 *
 * ── 它连什么、不连什么（边界如实说）────────────────────────────────────
 * · **不连桥接**：它直接读工作区里的语料库（`runtime/corpus.sqlite`，只读）
 *   与 `styles/闲聊.md`。桥接在跑、甚至桥接没跑，它都能用。
 * · 写操作只有三件：写评分、删批次（都在 `runtime/chat-review/` 下）、
 *   **应用草稿**（唯一会碰风格文件的操作，必须先备份 + 显式确认）。
 * · 只监听 **127.0.0.1**（里面是真实聊天记录，不该被局域网看到）。
 * · 语料库打不开时**不假装有数据**：`corpus.ok=false` 一路传到页面，
 *   由页面如实显示"语料库不可用 + 为什么"，导入与打分照常可用。
 *
 * ── 为什么模块在这里而不在 `chat-review/server.mjs` ──────────────────────
 * 同标注台：**测试要能直接起一个**（`createReviewServer`）而不 spawn 子进程，
 * 而 manifest 守卫要求"被别的模块 import 的代码"必须在 `src/` 下登记。
 * `chat-review/server.mjs` 于是只剩"解析命令行 + 监听端口"这点壳。
 *
 * 前后端契约见 `chat-review/API.md`（改任何一边都要同步改它）。
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConfig } from './config.mjs'
import {
  SELF_NAMES_DEFAULT,
  batchIdFor,
  buildTurns,
  parseForwardJson,
  parsePlainText,
  rowToEntry,
} from './chat-review-import.mjs'
import {
  TAGS,
  VERDICTS,
  createReviewStore,
  sha256,
  taxonomyDrift,
} from './chat-review-store.mjs'
import { createCorpus, silenceSqliteWarning } from './corpus.mjs'
import { PKG_ROOT } from './local.mjs'
import { chatStylePath, readChatStyle, resolveChatStyleName } from './styles.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** 静态页在包根的 `chat-review/public/`（`src/` 的上一级）。 */
const STATIC = join(HERE, '..', 'chat-review', 'public')

/** 本进程的启动时刻（`/api/health` 报出去，用来分辨"页面跑的是不是新起的进程"）。 */
const STARTED_AT = Date.now()

/** 一次拉取的条数上限（页面允许 1~500）。 */
const PULL_MAX = 500
/** 从语料库取原始消息时的放大倍数：回合之间夹着别人的话（实测机器人约占 1/6）。 */
const PULL_WINDOW_FACTOR = 8
/** `/api/items` 一页最多几条。 */
const PAGE_MAX = 200

/** 静态资源的类型（只有这三种 + favicon；其余一律 404）。 */
const TEXT_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

const fail = (res, status, why) => json(res, status, { ok: false, error: String(why ?? '未知错误') })

function readBody(req) {
  return new Promise((resolvePromise) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 4_000_000) raw = raw.slice(0, 4_000_000) // 导入的记录可能很大，但仍要有上限
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

/** 读配置（与别处同一口径：缺文件时给可执行的提示）。 */
export function loadConfig() {
  const path = join(PKG_ROOT, 'config.json')
  if (!existsSync(path)) {
    throw new Error(`找不到 ${path}\n先复制模板：copy config.example.json config.json`)
  }
  return normalizeConfig(JSON.parse(readFileSync(path, 'utf8')))
}

/** 会话键 → 给人看的名字（`group:123` → `群 123`）。 */
export function chatLabelOf(chatKey) {
  const key = String(chatKey ?? '')
  const [kind, ...rest] = key.split(':')
  const id = rest.join(':')
  if (kind === 'group') return `群 ${id}`
  if (kind === 'private') return `私聊 ${id}`
  return key
}

/**
 * 探测某个端口上是不是**评审台**（用它自己 `/api/health` 自报的 `tool` 字段认）。
 *
 * ★ 为什么必须先认身份再动手：这个函数的下一个动作是"请它退出"，甚至是"停掉它"。
 *   只按"端口被占"就动手，会误伤任何一个恰好用了 4410 的程序 —— 而"误杀别人的进程"
 *   比"我自己起不来"严重得多（与 `process-guard.killEntry` 那条"PID 复用也要拦住"
 *   是同一条纪律）。
 *
 * @returns {Promise<{reachable: boolean, ours: boolean, startedAt?: number|null, why?: string}>}
 *   `reachable:false` = 端口上没人在说话（大概率空着，也可能是占端口的不是 HTTP 服务）。
 */
export async function probeReviewHealth({ port, fetchImpl = fetch, timeoutMs = 900 } = {}) {
  const p = Number(port)
  if (!Number.isInteger(p) || p <= 0) return { reachable: false, ours: false, why: `端口号不合法：${port}` }
  try {
    const res = await fetchImpl(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { reachable: true, ours: false, why: `端口 ${p} 上有服务，但它回的是 HTTP ${res.status}` }
    const body = await res.json().catch(() => null)
    if (body && body.tool === 'chat-review') return { reachable: true, ours: true, startedAt: body.startedAt ?? null }
    return { reachable: true, ours: false, why: `端口 ${p} 上有服务，但它不是评审台（health 里没有 tool=chat-review）` }
  } catch (error) {
    return { reachable: false, ours: false, why: `端口 ${p} 上没有回应（${error?.message ?? error}）` }
  }
}

/**
 * 启动前**先接管端口**：把已经在跑的那一份评审台停掉。
 *
 * ── 为什么要有它（用户 2026-10-02 明确要求）──────────────────────────────
 * 常见用法是双击 `启动评审.bat`。使用者想再开一份（或上一次的窗口被最小化、
 * 忘了它还开着）时，旧做法是 `listen` 直接 EADDRINUSE 退出 —— 他看到的是
 * "点了一下，窗口自己关了，什么都没发生"。所以启动第一步就是：**把旧的请走**。
 *
 * ── 三级手段，从最客气到最不客气，每一级都先认对方是谁 ────────────────────
 *   ① **请它自己退**：`POST /api/shutdown`（不需要 PID、不涉及杀进程，最安全）；
 *      然后**等端口真的空出来**才算成功（不能"发了请求就当它退了"）。
 *   ② 它不退 → 从**进程登记**里找同一个 `profile` 的活条目，走 `killEntry(pid)` ——
 *      那里有"PID + 命令行里的 instanceId"双重校验，专门防 PID 被复用后误杀。
 *   ③ 连登记里都没有 → **拒绝动手**，如实说清"它还活着但我停不掉，请手动关那个窗口"。
 *      （宁可让使用者手动关一下，也不要盲杀一个 PID。）
 *
 * @param {object} opts
 * @param {number} opts.port
 * @param {(m: string) => void} [opts.log]
 * @param {() => object[]} [opts.listRunning] 进程登记（`guard.list()`）；不传 = 不做第 ② 级
 * @param {(pid: number) => {ok: boolean, error?: string}} [opts.kill] 带身份校验的停进程（`guard.killEntry`）
 * @param {number} [opts.graceMs]     等它自己退的耐心（默认 5 秒）
 * @param {Function} [opts.fetchImpl] / [opts.sleep] 测试注入
 * @returns {Promise<{ok: boolean, how?: 'none'|'graceful'|'killed', pid?: number, foreign?: boolean, why?: string}>}
 */
export async function stopRunningReviewServer({
  port,
  log = () => {},
  listRunning = null,
  kill = null,
  graceMs = 5000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const p = Number(port)
  const first = await probeReviewHealth({ port: p, fetchImpl })
  if (!first.reachable) return { ok: true, how: 'none', why: '端口上没有回应（没有旧实例要停）' }
  if (!first.ours) return { ok: false, foreign: true, why: first.why }

  // ① 请它自己退
  let asked = false
  try {
    const res = await fetchImpl(`http://127.0.0.1:${p}/api/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    })
    asked = Boolean(res?.ok)
  } catch {
    asked = false
  }
  if (asked) {
    const deadline = Date.now() + Math.max(500, Number(graceMs) || 5000)
    while (Date.now() < deadline) {
      await sleep(200)
      const again = await probeReviewHealth({ port: p, fetchImpl, timeoutMs: 400 })
      if (!again.reachable) {
        log(`[评审台] 端口 ${p} 上那份旧实例已经自己退出了`)
        return { ok: true, how: 'graceful' }
      }
    }
    log(`⚠️ [评审台] 端口 ${p} 上的旧实例**收到了关闭请求但没退**（等了 ${Math.round(graceMs / 1000)} 秒）`)
  } else {
    log(`⚠️ [评审台] 端口 ${p} 上的旧实例不接受关闭请求（可能是旧版本，还没有 /api/shutdown）`)
  }

  // ② 走进程登记 + 带身份校验的停进程
  const entries = typeof listRunning === 'function' ? listRunning() : []
  const target = entries.find((e) => Number(e.port) === p && !e.isSelf && e.state !== 'dead')
  if (!target) {
    return {
      ok: false,
      why:
        `端口 ${p} 上确实还有一份评审台，但它没在进程登记里（多半是**加了登记之前**启动的旧版本），` +
        `我**没法确认那个 PID 是谁**，所以不动手。\n` +
        `   要手动关它：netstat -ano | findstr :${p}（最后一列是 PID）→ 关掉那个窗口，或 taskkill /PID <pid> /T /F\n` +
        `   要直接绕开：node chat-review/server.mjs --port ${p + 1}`,
    }
  }
  if (typeof kill !== 'function') {
    return { ok: false, pid: target.pid, why: `旧实例还在（pid ${target.pid}），但这个入口没有接"停进程"的能力` }
  }
  const killed = kill(target.pid)
  if (killed?.ok) {
    // 停完要**复核端口真的空了**，否则下一步 listen 还是会撞上
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await sleep(150)
      const again = await probeReviewHealth({ port: p, fetchImpl, timeoutMs: 300 })
      if (!again.reachable) {
        log(`[评审台] 已停掉占用端口 ${p} 的旧实例（pid ${target.pid}）`)
        return { ok: true, how: 'killed', pid: target.pid }
      }
    }
    return { ok: false, pid: target.pid, why: `已发出停止信号，但端口 ${p} 仍被占着（pid ${target.pid}）` }
  }
  return {
    ok: false,
    pid: target.pid,
    why: `停不掉旧实例（pid ${target.pid}）：${killed?.error ?? '未知原因'}`,
  }
}

/**
 * 起服务器（**导出**是为了能被测试直接起一个，不必 spawn 子进程）。
 *
 * @param {object} opts
 * @param {string} opts.workspace           工作区（语料库与评审数据都在它下面）
 * @param {string} [opts.styleName]         用哪份风格文件（空 = 默认那份「闲聊」）
 * @param {string[]} [opts.selfNames]       导入时把哪些昵称当机器人（默认见 SELF_NAMES_DEFAULT）
 * @param {(m: string) => void} [opts.log]
 * @param {string} [opts.staticDir]         静态目录（测试可指向别处）
 * @param {string} [opts.styleDir]          风格文件所在目录（默认包根的 `styles/`；测试指向临时目录）
 * @param {Function} [opts.onShutdown]      `POST /api/shutdown` 时干什么（默认 = 关监听并退出进程）
 * @param {number} [opts.shutdownDelayMs]   先回响应再退出的缓冲（默认 150ms）
 */
export function createReviewServer({
  workspace,
  styleName = '',
  selfNames = SELF_NAMES_DEFAULT,
  log = () => {},
  staticDir = STATIC,
  styleDir = join(PKG_ROOT, 'styles'),
  onShutdown = null,
  shutdownDelayMs = 150,
} = {}) {
  const root = String(workspace ?? '')
  if (!root) throw new Error('没有工作区，读不到语料库与评审数据')

  silenceSqliteWarning()
  /**
   * 内部日志：**写不出去也不许弄挂服务**。
   *
   * ★ 为什么要有这一层（实测踩到）：这个工具要么前台跑在 cmd 窗口里，要么被别的
   *   进程拉起（我这边的编排就是后者）。**父进程消失时 stdout 的管道就断了** ——
   *   那时 `console.log` 会抛 EPIPE，于是"一条 404 的日志"就能把整个服务带走。
   *   症状是"它自己没了、没有任何线索"，而且它只在被托管运行时出现，手工跑永远复现不了。
   *   ∴ 日志是增强路径：失败的代价只能是"这条没记下来"，不能是"服务停了"。
   */
  const say = (m) => {
    try {
      log(m)
    } catch {
      /* 管道断了/日志写不出去：服务照常 */
    }
  }
  // ★★ 必须先过 `resolveChatStyleName`：`chatStylePath()` 只拼路径，空名字会拼出
  //    `<styles>/.md`（一个不存在的文件）—— 那会让"应用草稿"写错地方而**看起来成功了**。
  //    实测就是评审台自己的测试抓到的（详见 styles.mjs 里这个函数的注释）。
  const styleFile = chatStylePath({ dir: styleDir, name: resolveChatStyleName(styleName) })
  const store = createReviewStore({ workspace: root, styleFile, log: say })
  // ★ 只读：这个工具**绝不往语料库里写**（它是"过去发生了什么"的证据，不是它的地盘）
  const corpus = createCorpus({ workspace: root, log, readOnly: true })

  const staticRoot = normalize(resolve(staticDir))

  /** 风格文件的现状（`/api/health` 与税则漂移检查共用；**每条请求现读**）。 */
  function styleFacts() {
    const r = readChatStyle({ dir: styleDir, name: styleName })
    return { ...r, path: styleFile }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const startedAt = Date.now()
    res.on('finish', () => {
      // 失败必须留证据；2xx 只在显式开了 verbose 时打（否则控制台会被几百条刷满）
      if (res.statusCode >= 400) {
        say(`❌ [评审台] ${req.method} ${path} → ${res.statusCode}（${Date.now() - startedAt}ms）`)
      } else if (process.env.DSH_REVIEW_VERBOSE) {
        say(`[评审台] ${req.method} ${path} ${res.statusCode} ${Date.now() - startedAt}ms`)
      }
    })

    try {
      // ── favicon：给一个空响应，省掉浏览器一条 404（那 404 在控制台里会误导人）──
      if (req.method === 'GET' && (path === '/favicon.ico' || path === '/favicon.png')) {
        res.writeHead(204, { 'cache-control': 'max-age=86400' })
        res.end()
        return
      }

      // ── ① 环境事实：页面顶部那一栏就是它 ──────────────────────────────
      if (req.method === 'GET' && path === '/api/health') {
        const st = corpus.stats()
        const style = styleFacts()
        let chars = 0
        let exists = false
        try {
          exists = existsSync(styleFile)
          chars = exists ? String(style.text ?? '').length : 0
        } catch {
          exists = false
        }
        return json(res, 200, {
          ok: true,
          tool: 'chat-review',
          startedAt: STARTED_AT,
          workspace: root,
          corpus: st.ok
            ? { ok: true, rows: st.total ?? 0, botMessages: st.botMessages ?? 0, chats: (st.byChat ?? []).length }
            : { ok: false, why: st.why },
          styleFile: {
            path: styleFile,
            exists,
            chars,
            sha256: sha256(String(style.text ?? '')),
            source: style.source,
            why: style.why ?? null,
          },
        })
      }

      // ── ② 标签税则（+ 漂移检查）──────────────────────────────────────
      if (req.method === 'GET' && path === '/api/taxonomy') {
        const style = styleFacts()
        const drift = taxonomyDrift({ styleText: String(style.text ?? '') })
        return json(res, 200, { ok: true, verdicts: VERDICTS, tags: TAGS, drift: drift.drift })
      }

      // ── ③ 数据源：语料库有哪些会话 + 已有批次 ─────────────────────────
      if (req.method === 'GET' && path === '/api/sources') {
        const sums = corpus.chatSummaries()
        return json(res, 200, {
          ok: true,
          corpus: sums.ok
            ? {
                ok: true,
                why: null,
                chats: sums.chats.map((c) => ({
                  chatKey: c.chatKey,
                  label: chatLabelOf(c.chatKey),
                  botReplies: c.botReplies,
                  total: c.total,
                  lastAt: c.lastAt,
                })),
              }
            : { ok: false, why: sums.why, chats: [] },
          batches: store.listBatches().map((b) => ({
            id: b.id,
            label: b.label,
            source: b.source,
            chatKey: b.chatKey ?? '',
            chatLabel: b.chatLabel ?? '',
            items: b.items,
            scored: b.scored,
            createdAt: b.createdAt,
          })),
        })
      }

      // ── ④ 从语料库拉一个批次 ─────────────────────────────────────────
      if (req.method === 'POST' && path === '/api/pull') {
        const body = await readBody(req)
        if (!body) return fail(res, 400, '请求体不是合法 JSON')
        const chatKey = String(body.chatKey ?? '').trim()
        if (!chatKey) return fail(res, 400, '必须指定会话（fail-closed）')
        const limit = Math.min(Math.max(1, Number(body.limit) || 100), PULL_MAX)
        const contextBefore = Math.max(0, Math.min(3, Number(body.contextBefore ?? 1)))
        const window = Math.min(2000, limit * PULL_WINDOW_FACTOR + 20)
        const t = corpus.transcript({ chatKey, limit: window })
        if (!t.ok) return fail(res, 400, `读语料库失败：${t.why}`)
        const entries = t.rows.map(rowToEntry)
        const label = String(body.batchLabel ?? '').trim() || chatLabelOf(chatKey)
        const batch = batchIdFor(label, Date.now())
        const built = buildTurns({
          entries,
          chatKey,
          chatLabel: chatLabelOf(chatKey),
          batch,
          source: 'corpus',
          contextBefore,
          limit,
        })
        if (!built.items.length) {
          return fail(
            res,
            400,
            `这个会话最近 ${t.rows.length} 条消息里没有可评的机器人发言（可能是语料库里还没记到它说话）`,
          )
        }
        const created = store.createBatch({ label: batch, source: 'corpus', chatKey, chatLabel: chatLabelOf(chatKey), items: built.items })
        if (!created.ok) return fail(res, 400, created.why)
        return json(res, 200, {
          ok: true,
          batch: created.batch,
          items: built.items.length,
          scanned: t.rows.length,
          skippedMarkers: built.skippedMarkers,
          warnings: t.rows.some((r) => r.truncated) ? ['有些消息在语料库里本身就是截断的（入库时超长）'] : [],
        })
      }

      // ── ⑤ 导入（合并转发 JSON / 纯文本）──────────────────────────────
      if (req.method === 'POST' && path === '/api/import') {
        const body = await readBody(req)
        if (!body) return fail(res, 400, '请求体不是合法 JSON')
        const format = String(body.format ?? 'forward-json')
        const text = String(body.text ?? '')
        if (!text.trim()) return fail(res, 400, '没有内容可导入（粘贴框是空的）')
        const parsed = format === 'text' ? parsePlainText(text) : parseForwardJson(text)
        if (!parsed.ok) return fail(res, 400, parsed.why)
        const names = Array.isArray(body.selfNames) && body.selfNames.length ? body.selfNames : selfNames
        const label = String(body.batchLabel ?? '').trim() || (format === 'text' ? '粘贴的文本记录' : '合并转发记录')
        const batch = batchIdFor(label, Date.now())
        const built = buildTurns({
          entries: parsed.entries,
          selfNames: names,
          chatKey: `import:${batch}`,
          chatLabel: label,
          batch,
          source: 'import',
          contextBefore: Math.max(0, Math.min(3, Number(body.contextBefore ?? 1))),
          limit: PULL_MAX,
        })
        const warnings = [...parsed.warnings]
        if (!built.items.length) {
          warnings.push(
            `一条机器人发言都没认出来 —— 导入的昵称里要有它自己（当前认这些名字：${names.join('、')}）。` +
              '如果记录里它不是这些名字，用 selfNames 告诉本工具。',
          )
          return json(res, 400, { ok: false, error: '这份记录里没有可评的机器人发言', warnings })
        }
        const created = store.createBatch({
          label: batch,
          source: 'import',
          chatKey: `import:${batch}`,
          chatLabel: label,
          items: built.items,
        })
        if (!created.ok) return fail(res, 400, created.why)
        return json(res, 200, {
          ok: true,
          batch: created.batch,
          items: built.items.length,
          entries: parsed.entries.length,
          skippedMarkers: built.skippedMarkers,
          warnings,
        })
      }

      // ── ⑥ 取条目（默认先推"没评的"）───────────────────────────────────
      if (req.method === 'GET' && path === '/api/items') {
        const batchId = url.searchParams.get('batch') ?? ''
        const filter = url.searchParams.get('filter') ?? 'unrated'
        const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 20), PAGE_MAX)
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
        const batches = store.listBatches()
        const meta = batches.find((b) => b.id === batchId)
        if (!meta) return fail(res, 404, `没有这个批次：${batchId || '(空)'}`)
        const { items } = store.itemsWithScores(batchId)
        const filtered = items.filter((it) => {
          if (filter === 'rated') return Boolean(it.score)
          if (filter === 'all') return true
          return !it.score
        })
        return json(res, 200, {
          ok: true,
          batch: { id: meta.id, label: meta.label, items: meta.items, scored: meta.scored },
          filter,
          total: filtered.length,
          offset,
          items: filtered.slice(offset, offset + limit),
        })
      }

      // ── ⑦ 打分（每条立刻落盘）─────────────────────────────────────────
      if (req.method === 'POST' && path === '/api/score') {
        const body = await readBody(req)
        if (!body) return fail(res, 400, '请求体不是合法 JSON')
        const saved = store.saveScore({
          id: body.id,
          verdict: body.verdict,
          tags: Array.isArray(body.tags) ? body.tags : [],
          note: body.note ?? '',
        })
        if (!saved.ok) return fail(res, 400, saved.why)
        // 进度用**条目所属的那个批次**算：页面靠它画进度条
        const batchId = store.findBatchOf(body.id)
        return json(res, 200, {
          ok: true,
          score: saved.score,
          batchId,
          progress: batchId ? store.progress(batchId) : null,
        })
      }

      // ── ⑧ 撤销上一条 ─────────────────────────────────────────────────
      if (req.method === 'POST' && path === '/api/undo') {
        const body = await readBody(req)
        if (!body) return fail(res, 400, '请求体不是合法 JSON')
        const batchId = String(body.batch ?? '').trim()
        if (!batchId) return fail(res, 400, '必须指定批次')
        const r = store.undo(batchId)
        if (!r.ok) return fail(res, 404, r.why)
        return json(res, 200, { ok: true, undone: r.undone, progress: store.progress(batchId) })
      }

      // ── ⑨ 统计 ───────────────────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/stats') {
        const scope = url.searchParams.get('batch') || 'all'
        const st = store.stats(scope)
        return json(res, 200, { ok: true, ...st })
      }

      // ── ⑩ 修订草稿（只算不写）────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/draft') {
        const scope = url.searchParams.get('batch') || 'all'
        const d = store.draft(scope)
        return json(res, 200, { ok: true, scope, draft: d })
      }

      // ── ⑪ 应用草稿（**唯一会碰风格文件的写操作**）─────────────────────
      if (req.method === 'POST' && path === '/api/apply') {
        const body = await readBody(req)
        if (!body) return fail(res, 400, '请求体不是合法 JSON')
        const scope = String(body.batch ?? 'all') || 'all'
        const r = store.applyDraft({ scope, confirm: body.confirm === true })
        if (!r.ok) return fail(res, r.code ?? 400, r.why)
        return json(res, 200, {
          ok: true,
          backup: r.backup,
          sha256: r.sha256,
          chars: r.chars,
          appended: r.appended,
        })
      }

      // ── ⑫ 删批次 ─────────────────────────────────────────────────────
      if (req.method === 'DELETE' && path === '/api/batch') {
        const batchId = url.searchParams.get('id') ?? ''
        if (!batchId) return fail(res, 400, '必须指定批次 id')
        const r = store.deleteBatch(batchId)
        if (!r.ok) return fail(res, 404, r.why)
        return json(res, 200, { ok: true, removed: r.removed })
      }

      // ── ⑬ 请自己退出（给"启动时先接管端口"用）────────────────────────
      //
      // 为什么要有这条：常见用法是双击 `启动评审.bat`，而使用者可能忘了上一次那份
      // 还开着（窗口被最小化）。没有它时，新实例只会 EADDRINUSE 退出，
      // 使用者看到"点了一下窗口自己关了"。有了它，新实例启动第一步就是请旧的退下。
      //
      // ⚠️ 它**不是**远程关机后门：只监听 127.0.0.1、只关自己、而且必须显式 POST。
      //    没接 `onShutdown` 的实例（比如测试里随手起的）会如实回 501，而不是假装退出。
      if (req.method === 'POST' && path === '/api/shutdown') {
        if (typeof onShutdown !== 'function') {
          return fail(res, 501, '这个实例没有接"被关闭"这件事（onShutdown 没传），所以我不会假装退出')
        }
        json(res, 200, { ok: true, stopping: true, hint: '正在退出；新的实例会接管这个端口。' })
        setTimeout(() => {
          try {
            onShutdown()
          } catch (error) {
            say(`❌ [评审台] 退出回调炸了：${error?.message ?? error}`)
          }
        }, Math.max(0, Number(shutdownDelayMs) || 0))
        return
      }

      // ── 静态页 ───────────────────────────────────────────────────────
      const relFile = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
      const abs = normalize(join(staticRoot, relFile))
      // 用 `staticRoot + sep` 判前缀：否则 `/public/../public2` 这种能溜过去
      if (abs !== staticRoot && !abs.startsWith(staticRoot.endsWith(sep) ? staticRoot : staticRoot + sep)) {
        res.writeHead(403).end('forbidden')
        return
      }
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        res.writeHead(404).end('not found')
        return
      }
      const type = TEXT_MIME[extname(abs).toLowerCase()]
      if (!type) {
        res.writeHead(404).end('not found')
        return
      }
      let bodyBuf = readFileSync(abs)
      if (extname(abs).toLowerCase() === '.html') {
        // ★ 给 app.js / style.css 挂上**进程启动时间**做版本串：重启（= 代码改过）后
        //   URL 就变，浏览器**必须**重新取。没有这一步时，实测会对着旧 app.js 排查半天
        //   （`cache-control: no-store` 并不能 100% 保证，强制缓存/扩展都可能插一脚）。
        // ★★ 替换**锚定到标签**（`<link … href=` / `<script … src=`），不是见字符串就换：
        //   页面里那段注释也写着这两个属性名，裸替换会把注释一起改掉 ——
        //   现象是"注释里说要一字不差，可它自己已经不是原来的写法了"（实测踩到）。
        //   现在只有真标签会被改，注释原样保留。
        const v = String(STARTED_AT)
        bodyBuf = Buffer.from(
          bodyBuf
            .toString('utf8')
            .replace(/(<link\b[^>]*\bhref=")\/style\.css(")/g, `$1/style.css?v=${v}$2`)
            .replace(/(<script\b[^>]*\bsrc=")\/app\.js(")/g, `$1/app.js?v=${v}$2`),
          'utf8',
        )
      }
      res.writeHead(200, {
        'content-type': type,
        'content-length': bodyBuf.length,
        'cache-control': extname(abs).toLowerCase() === '.html' ? 'no-store' : 'max-age=60',
      })
      res.end(bodyBuf)
    } catch (error) {
      // 任何未预料的异常都不许静默：页面会看到一句人话，日志里有原始信息
      say(`❌ [评审台] ${req.method} ${path} 抛异常：${error?.stack ?? error}`)
      if (!res.headersSent) fail(res, 500, `服务端异常：${error?.message ?? error}`)
      else res.end()
    }
  })

  return {
    server,
    store,
    corpus,
    workspace: root,
    styleFile,
    staticDir: staticRoot,
    close() {
      try {
        corpus.close()
      } catch {
        /* 关不掉无所谓 */
      }
      try {
        server.close()
      } catch {
        /* 同上 */
      }
    },
  }
}
