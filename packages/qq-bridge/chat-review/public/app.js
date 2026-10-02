/**
 * 聊天记录评审台 —— 前端（零依赖、无构建、**经典脚本**）。
 *
 * 三个页签：导入 → 打分 → 报告。改版后的形状（先读 chat-review/API.md 的〇节）：
 *   导入真实聊天记录 → 一条条「判档 + 写评论」→ 把评论**整理成「点」**→ 据此**整篇重写** styles/闲聊.md
 *
 * ★ 旧版那套**手写标签**（太长 / 像客服 …）整套删掉了，别再往回加：标签是"我预先想好的分类"，
 *   人没想到的问题就永远进不了统计；现在的素材是**评论**，「点」是从评论里**整理**出来的产物，
 *   草稿是**整篇重写**（不是往文件尾追加），而应用必须"人点确认 + 先备份 + 过锚点核对"。
 *
 * 四条纪律，改代码时不要绕开：
 * ① **不编数据**：请求失败就把服务端给的 `error` 显示出来，字段没给就显示 —，绝不用 0 或
 *    空占位冒充"测出来的数"（典型：`corpus.ok===false` 时顶栏说 why，不画一个像真的行数）。
 * ② **打分不能被网络卡住**：判档后立刻换下一条（乐观推进），失败再把那条**放回原位**并报错。
 * ③ **聊天原文只走 textContent**：reply / context / comment / 证据原文都是真人输入，可能带
 *    恶意标签。本文件从不把字符串当 HTML 塞进页面：那不是显示问题，是 XSS。
 * ④ **契约就是契约**：`/api/...` 路径与字段名都按 API.md。页面调一个不存在的接口时服务端
 *    日志是干净的，症状只会是"点了没反应"，所以路径一个字都不许改。
 */
const $ = (id) => document.getElementById(id)

const PAGE_SIZE = 20 // 一次取多少条（契约默认 20）
const PREFETCH_MIN = 6 // 队列里剩这么少就续取下一页，让"下一条"永远是本地就有的
// 三档结论（契约固定）。`/api/taxonomy` 取不到时用这个兜住键盘，不让人"按了没反应"。
const FALLBACK_VERDICTS = [
  { id: 'good', label: '对', key: '1' },
  { id: 'ok', label: '还行', key: '2' },
  { id: 'bad', label: '不对', key: '3' },
]
const VERDICT_IDS = ['good', 'ok', 'bad']

const state = {
  page: 'import',
  health: null,
  // ★ 取不到时要能区分"还没取到"和"服务端说不可用"，否则页面会显示成"0 个会话"
  sources: { corpus: { ok: false, why: '还没取到数据源', chats: [] }, batches: [] },
  taxonomy: { ok: false, verdicts: [], why: '' }, // 只留三档结论：标签体系已删除
  // ★★ 点表：它**顶替**了原来的标签（位置就在打分卡片上那排按钮），
  //    但性质不同 —— 标签是服务端预先写死的分类，点是使用者从评论里长出来、**可编辑**的词汇表。
  points: { ok: false, why: '还没取到点表', kinds: ['bad', 'good'], items: [], seeded: 0 },
  importFormat: 'forward-json',
  score: {
    batch: '', filter: 'unrated',
    queue: [], index: 0, // 本地待过队列：评过的条目离开队列（撤销会插回来）
    offset: 0, // 服务端分页游标，与队列长度无关（队列会因为评分变短）
    exhausted: false, fetching: false, fetchError: '',
    scored: null, total: null, commented: null, // 一律先 null：没拿到真进度就显示 —，不显示 0
    loadedFor: '', ctxOpen: true,
  },
  reportBatch: 'all', reportVerdict: '', reportSearch: '', reportPoint: '',
  stats: null,
  // 整理那一块的全部状态：GET 一进报告页就拉（不花钱），POST 只在人点击时发生
  cons: {
    loaded: false, latest: null, comments: [], counts: null, model: null,
    limits: null, anchors: [], clusters: null, error: '', busy: false, armed: false,
  },
}

/* ── 通用小工具 ─────────────────────────────────────────────────────── */

/** 建元素；`text` 一律走 textContent —— 这是本文件唯一允许塞文本的路子。 */
function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = String(text)
  return n
}
const td = (text, cls) => el('td', cls, text)
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild) }
/** 毫秒 → 本地时间：服务端给时间戳，页面显示的是**看表的人**的时间。 */
function fmtTime(ms) {
  if (ms == null || ms === '' || Number.isNaN(Number(ms))) return '—'
  const d = new Date(Number(ms))
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
/** 缺字段一律 —：把"服务端没给"和"真的是 0"分开，是这份页面最基本的诚实。 */
const numOrDash = (n) => (Number.isFinite(n) ? String(n) : '—')
function pctOf(count, total) {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0) return '—'
  return `${Math.round((count / total) * 1000) / 10}%`
}
function clamp(n, lo, hi) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo
}
const truncate = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''))
const hasCommentText = (s) => String(s ?? '').trim() !== '' // 空评论是合法的：只判档也能用，只是不进整理
function verdictLabel(id) {
  return [...state.taxonomy.verdicts, ...FALLBACK_VERDICTS].find((v) => v.id === id)?.label ?? id ?? '—'
}
/** 按契约固定的键位取结论；税则里的 `key` 对得上就优先用它。 */
function verdictForKey(key) {
  const list = state.taxonomy.verdicts.length ? state.taxonomy.verdicts : FALLBACK_VERDICTS
  return list.find((v) => String(v.key) === String(key))?.id ?? { 1: 'good', 2: 'ok', 3: 'bad' }[key] ?? null
}
/** `context` 在契约里是数组（`[{name,text,isBot}]`）；不是数组就如实返回空串，不猜。 */
function contextText(ctx) {
  if (Array.isArray(ctx)) return ctx.map((l) => `${l?.name ?? '?'}：${l?.text ?? ''}${l?.isBot ? '（机器人）' : ''}`).join('\n')
  return typeof ctx === 'string' ? ctx : ''
}

/* ── 提示：toast / 全局错误横幅 / 兜底错误条 ─────────────────────────── */

let toastTimer = null
function toast(msg, kind = '') {
  const box = $('toast')
  box.textContent = String(msg)
  box.className = `toast ${kind}`
  box.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { box.hidden = true }, 3200)
}
/** 任何 `ok:false` 都走这里。关掉只是"这一条我知道了"——下次失败会重新亮出来。 */
function showError(msg) {
  const box = $('error-banner')
  if (!box) return
  $('error-text').textContent = String(msg ?? '未知错误')
  box.hidden = false
}
/** 兜底：脚本出意外要**说出来**，不能让人对着"点了没反应"猜。 */
function showPageError(what, error) {
  try {
    const box = $('page-error')
    if (!box) return
    const line = `⚠️ ${what}：${error?.message ?? error}\n   （把这一条截图给开发者即可定位；页面其它部分仍可用，按 F5 重载。）`
    box.textContent = box.textContent ? `${box.textContent}\n${line}` : line
    box.hidden = false
  } catch { /* 连兜底都失败就只能算了，绝不能因此再抛一次 */ }
}
window.addEventListener('error', (e) => showPageError('页面脚本出错', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => showPageError('异步操作失败', e.reason))

/* ── 请求封装 ───────────────────────────────────────────────────────── */
// 失败**永不抛异常**，一律回 `{ok:false, error}`，好让每个调用点都能"看到错误就什么都不做"。
async function api(path, { method = 'GET', body = null } = {}) {
  const fail = (msg) => { showError(msg); return { ok: false, error: msg } }
  let res
  try {
    res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  } catch (e) { return fail(`连不上本地服务（${method} ${path}）：${e?.message ?? e}`) }
  let data
  try { data = await res.json() } catch { return fail(`${method} ${path} 返回的不是 JSON（HTTP ${res.status}）`) }
  if (!data || typeof data !== 'object') return fail(`${method} ${path} 返回了意外的内容`)
  // ok:false 时把服务端的 error 原样亮出来 —— 静默失败是这类工具最糟的坏法
  if (data.ok !== true) showError(data.error ?? `${method} ${path} 失败（HTTP ${res.status}，服务端没给 error）`)
  // 状态码也带上：409 那类"不是网络错、是状态冲突"要靠它才说得清（还有结构化字段如 anchorsMissing）
  return { ...data, httpStatus: res.status }
}

/* ── 顶栏：环境事实 ─────────────────────────────────────────────────── */

async function loadHealth() {
  const data = await api('/api/health')
  state.health = data.ok ? data : null
  renderHealth()
}
function renderHealth() {
  const box = $('health')
  if (!box) return
  clear(box)
  box.appendChild(el('span', 'hk', '[评审台]'))
  const h = state.health
  if (!h) return box.appendChild(el('span', 'hv bad', '拿不到服务端状态（原因见上方红条）'))
  const ws = el('span', 'hv', `工作区 ${h.workspace ?? '（未给）'}`)
  ws.title = String(h.workspace ?? '')
  box.appendChild(ws)
  const c = h.corpus // ★ 语料库读不出来时**说为什么**，绝不显示一个像真的行数
  if (c && c.ok === true) box.appendChild(el('span', 'hv', `语料库 ${numOrDash(c.rows)} 行`))
  else box.appendChild(el('span', 'hv bad', `语料库不可用：${c?.why ?? '服务端没说原因'}`))
  // ★ 这一格就是"改写到底写进去没有"的唯一凭据：应用之后必须重新拉一次（见 applyConsolidation）
  const sf = h.styleFile
  if (sf && sf.exists === true) {
    const sha = String(sf.sha256 ?? '')
    const node = el('span', 'hv', `风格文件 ${numOrDash(sf.chars)} 字｜sha256 ${sha ? sha.slice(0, 8) : '（未给）'}`)
    node.title = String(sf.path ?? '')
    box.appendChild(node)
  } else box.appendChild(el('span', 'hv bad', `风格文件不存在${sf?.path ? `（${sf.path}）` : ''}`))
  const started = el('span', 'hv', `启动于 ${fmtTime(h.startedAt)}`)
  started.title = `本次服务进程的启动时间（分辨页面跑的是不是新起的进程）\ntool=${h.tool ?? '（未给）'}`
  box.appendChild(started)
}

/* ── 三档结论（`/api/taxonomy` 已废弃，只回一句人话 + verdicts）───────── */

async function loadTaxonomy() {
  // ★ 只读 `verdicts`，不读也不渲染任何标签：标签体系已整套删除。
  //   保留这次请求是因为"三档按钮的中文名"由服务端给；拿不到就用契约里的兜底三档。
  const data = await api('/api/taxonomy')
  state.taxonomy = data.ok
    ? { ok: true, verdicts: Array.isArray(data.verdicts) ? data.verdicts : [], why: String(data.why ?? '') }
    : { ok: false, verdicts: [], why: String(data.error ?? '接口失败') }
  const note = $('taxonomy-note')
  if (note) {
    note.hidden = state.taxonomy.ok
    note.textContent = state.taxonomy.ok ? '' : `拿不到 /api/taxonomy（${state.taxonomy.why}）：判档用的是契约里固定的三档（对 / 还行 / 不对）。`
  }
  if (state.page === 'score') renderCard()
}

/* ── 点表（顶替原标签：打分卡片上那排按钮 + 报告页的点管理）───────────── */

/**
 * 拉点表。
 *
 * ★ 为什么单独一条请求而不是从 `/api/stats` 里捎带：打分页要按钮，
 *   而打分页**不该为了拿到按钮去拉整份统计**（那还会随批次变化、越拉越慢）。
 * ★ 拉不到时 `ok:false` 要一路带到按钮区：显示"拿不到点表 + 为什么"，
 *   而**不是**画成"这个批次没有点"（那会让人以为点丢了）。
 */
async function loadPoints() {
  const data = await api('/api/points')
  state.points = data.ok
    ? {
        ok: true,
        why: '',
        kinds: Array.isArray(data.kinds) && data.kinds.length ? data.kinds : ['bad', 'good'],
        items: Array.isArray(data.points) ? data.points : [],
        seeded: Number(data.seeded) || 0,
      }
    : { ok: false, why: String(data.error ?? '接口失败'), kinds: ['bad', 'good'], items: [], seeded: 0 }
  if (state.page === 'score') renderCard()
  if (state.page === 'report') {
    renderPointsAdmin()
    renderCommentList()
  }
}

/** 点表按 kind 分组（bad / good），组内按 count 降序（常用的排前面，少翻）。 */
function pointsByKind(kind) {
  return state.points.items
    .filter((p) => p.kind === kind)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || String(a.title).localeCompare(String(b.title)))
}

/* ── 页签切换 ───────────────────────────────────────────────────────── */

async function switchTab(page) {
  state.page = page
  for (const name of ['import', 'score', 'report']) {
    $(`tab-${name}`).classList.toggle('active', name === page)
    $(`page-${name}`).hidden = name !== page
  }
  if (page === 'import') await refreshSources()
  if (page === 'score') await enterScore()
  if (page === 'report') await enterReport()
}

/* ── 页签一：导入 ───────────────────────────────────────────────────── */

async function refreshSources() {
  const data = await api('/api/sources')
  // 取不到就**明说**；保留上一次的列表，但绝不把失败画成"没有批次"
  if (!data.ok) return void ($('corpus-note').textContent = `拉不到数据源：${data.error ?? '未知原因'}`)
  state.sources = {
    corpus: data.corpus ?? { ok: false, why: '响应里没有 corpus 字段' },
    batches: Array.isArray(data.batches) ? data.batches : [],
  }
  renderCorpusSelect()
  renderBatches()
  renderScoreBatchSelect()
  renderReportBatchSelect()
}

function renderCorpusSelect() {
  const sel = $('corpus-chat')
  const c = state.sources.corpus
  const chats = Array.isArray(c?.chats) ? c.chats : []
  const usable = c?.ok === true && chats.length > 0
  clear(sel)
  $('btn-pull').disabled = !usable
  if (!usable) {
    $('corpus-note').textContent = c?.ok === false ? `语料库不可用：${c.why ?? '（服务端没给 why）'}` : '语料库里没有可用会话。'
    return void sel.appendChild(new Option('（没有可用会话）', ''))
  }
  for (const chat of chats) {
    const bot = Number.isFinite(chat?.botReplies) ? chat.botReplies : null
    const total = Number.isFinite(chat?.total) ? chat.total : null
    const name = chat?.label ?? chat?.chatKey ?? '（无标签）'
    const label = bot == null || total == null ? `${name}（服务端没给条数）` : `${name} — 机器人发言 ${bot} 条 / 共 ${total} 条`
    sel.appendChild(new Option(label, String(chat?.chatKey ?? '')))
  }
  $('corpus-note').textContent = `共 ${chats.length} 个会话；只取机器人自己的发言当"被评的那句话"。`
}

const sourceLabel = (src) => (src === 'corpus' ? '语料库' : src === 'import' ? '粘贴导入' : src ? String(src) : '未知')

function renderBatches() {
  const tbody = $('batch-rows')
  clear(tbody)
  const list = state.sources.batches
  $('batch-table').hidden = list.length === 0
  $('batch-empty').hidden = list.length > 0
  let missingCommented = false
  for (const b of list) {
    if (!Number.isFinite(b?.commented)) missingCommented = true
    const tr = document.createElement('tr')
    tr.appendChild(el('td', 'b-label', b?.label ?? b?.id ?? '（无标签）'))
    tr.appendChild(td(sourceLabel(b?.source)))
    tr.appendChild(td(numOrDash(b?.items)))
    tr.appendChild(td(`${numOrDash(b?.scored)} / ${numOrDash(b?.items)}`))
    tr.appendChild(td(numOrDash(b?.commented)))
    tr.appendChild(td(fmtTime(b?.createdAt)))
    const ops = el('td', 'ops')
    const go = el('button', 'primary small', '开始打分')
    go.onclick = () => {
      state.score.batch = String(b?.id ?? '')
      state.score.filter = 'unrated'
      $('score-filter').value = 'unrated'
      void switchTab('score')
    }
    const del = el('button', 'ghost danger small', '删除')
    del.onclick = () => void removeBatch(b)
    ops.appendChild(go)
    ops.appendChild(del)
    tr.appendChild(ops)
    tbody.appendChild(tr)
  }
  // 「有评论」是"整理还有多少素材"的直接答案，所以服务端没给时必须说明白，不能靠估
  $('batch-note').textContent = !list.length
    ? ''
    : missingCommented
      ? '「有评论」= 这一批里写了评论的条数（整理「点」只吃这些）；标 — 的是服务端这次没给 commented 字段。'
      : '「有评论」= 这一批里写了评论的条数 —— 整理「点」只吃带评论的评分。'
}

async function pullFromCorpus() {
  const chatKey = $('corpus-chat').value
  if (!chatKey) return toast('先选一个会话', 'err')
  // 输入框被清空时按**契约默认值**走（100 / 1），不能悄悄发一个 limit=1 过去
  const rawLimit = $('pull-limit').value.trim()
  const limit = clamp(rawLimit === '' ? 100 : rawLimit, 1, 500)
  const contextBefore = clamp($('pull-context').value.trim() || 1, 0, 3)
  $('pull-limit').value = String(limit) // 越界当场纠正：静默截断会让人以为"拉了 800 条"
  const btn = $('btn-pull')
  btn.disabled = true
  let data
  try {
    data = await api('/api/pull', { method: 'POST', body: { chatKey, limit, contextBefore, batchLabel: $('pull-label').value.trim() } })
  } finally { btn.disabled = false }
  if (!data?.ok) return
  const b = data.batch ?? {}
  await refreshSources()
  // ★ 这句必须写在 refreshSources **之后**：刷新会重画会话下拉，顺序反了这句话就被冲掉，
  //   表现是"拉完了但页面上什么都没说"（拉了多少条、扫描了多少条都看不到）。
  $('pull-result').textContent =
    `已建批次「${b.label ?? b.id ?? '（无标签）'}」：可评回合 ${numOrDash(data.items)} 条，` +
    `扫描 ${numOrDash(data.scanned)} 条消息，跳过标记 ${numOrDash(data.skippedMarkers)} 条。`
  renderWarnings('pull-warnings', data.warnings, '没有需要说明的行。')
  toast(`拉取完成：可评回合 ${numOrDash(data.items)} 条`, 'ok')
}

async function importPasted() {
  const text = $('import-text').value
  if (!text.trim()) return toast('先把内容粘进文本框', 'err')
  const data = await api('/api/import', {
    method: 'POST',
    body: { format: state.importFormat, text, batchLabel: $('import-label').value.trim() },
  })
  // 失败时响应里也可能带 warnings（例如"一条机器人都没认出来"）—— 照样列出来
  if (!data.ok) return renderWarnings('import-warnings', data.warnings, '没有跳过的行。')
  const b = data.batch ?? {}
  $('import-result').textContent =
    `已建批次「${b.label ?? b.id ?? '（无标签）'}」：可评回合 ${numOrDash(data.items)} 条（解析出 ${numOrDash(data.entries)} 条消息）。`
  renderWarnings('import-warnings', data.warnings, '没有跳过的行（全部解析成功）。')
  toast('导入完成', 'ok')
  await refreshSources()
}

/** 跳过的行必须**原样列出来**：它们是"导入少了几条"的唯一解释，不许藏。 */
function renderWarnings(targetId, warnings, emptyText) {
  const box = $(targetId)
  if (!box) return
  clear(box)
  if (!Array.isArray(warnings)) return void box.appendChild(el('li', '', '服务端没有返回 warnings 字段 —— 无法确认有没有跳过的行。'))
  if (!warnings.length) return void box.appendChild(el('li', '', String(emptyText ?? '没有需要说明的行。')))
  for (const w of warnings) box.appendChild(el('li', '', String(w)))
}

async function removeBatch(b) {
  const label = b?.label ?? b?.id ?? '（无标签）'
  const n = Number.isFinite(b?.items) ? ` ${b.items} 条条目和` : ''
  const ok = window.confirm(
    `确认删除批次「${label}」？\n\n· 会删掉它的${n}全部评分，**不可撤销**；\n` +
      '· 只动工作区里的评审数据：语料库和 styles/闲聊.md 都不会被改。',
  )
  if (!ok) return
  const data = await api(`/api/batch?id=${encodeURIComponent(String(b?.id ?? ''))}`, { method: 'DELETE' })
  if (!data.ok) return
  toast(`已删除批次「${label}」`, 'ok')
  if (state.score.batch === b?.id) {
    state.score.batch = ''
    state.score.queue = []
    state.score.index = 0
    state.score.loadedFor = ''
  }
  await refreshSources()
  if (state.page === 'score') renderCard()
}

/* ── 页签二：打分（主战场） ─────────────────────────────────────────── */

function renderScoreBatchSelect() {
  const sel = $('score-batch')
  const keep = state.score.batch
  clear(sel)
  if (!state.sources.batches.length) {
    sel.appendChild(new Option('（还没有批次）', ''))
    return void (state.score.batch = '')
  }
  for (const b of state.sources.batches) {
    sel.appendChild(new Option(`${b?.label ?? b?.id ?? '（无标签）'}（${numOrDash(b?.scored)} / ${numOrDash(b?.items)}）`, String(b?.id ?? '')))
  }
  sel.value = state.sources.batches.some((b) => b?.id === keep) ? keep : String(state.sources.batches[0]?.id ?? '')
  state.score.batch = sel.value
  // 原来选的那一批被删了：队列里还是**上一个批次**的条目，必须一起清掉，否则会出现
  // "下拉显示 A、卡片却是 B 的内容"这种最误导人的状态。
  if (keep && sel.value !== keep) resetQueue()
}

function resetQueue() {
  Object.assign(state.score, { queue: [], index: 0, loadedFor: '', scored: null, total: null, commented: null })
}

async function enterScore() {
  // 切回来时队列还有货就**不重取**：重取会把人正在看的位置冲掉
  const key = `${state.score.batch}|${state.score.filter}`
  if (state.score.loadedFor === key && (state.score.queue.length || state.score.exhausted)) {
    renderCard()
    renderProgress()
    return
  }
  if (!state.sources.batches.length) await refreshSources()
  if (!state.score.batch) state.score.batch = String(state.sources.batches[0]?.id ?? '')
  renderScoreBatchSelect()
  renderCard()
  if (state.score.batch) await loadBatch(state.score.batch, state.score.filter)
}

async function loadBatch(batch, filter, { focusId = '' } = {}) {
  const s = state.score
  Object.assign(s, { batch: String(batch ?? ''), filter, offset: 0, exhausted: false, fetching: false, fetchError: '' })
  resetQueue()
  s.loadedFor = `${s.batch}|${s.filter}`
  renderProgress()
  renderCard()
  if (!s.batch) return
  await fetchPage()
  await loadProgressTruth()
  if (focusId) {
    const at = s.queue.findIndex((it) => it?.id === focusId)
    if (at >= 0) s.index = at
    else toast('撤销的那条不在这一页里 —— 换成「未评」过滤能找到它')
  }
  renderProgress()
  renderCard()
}

/** 取下一页。失败**不动本地队列**：让"没取到"看着像"评完了"是最坏的结果。 */
async function fetchPage() {
  const s = state.score
  if (s.fetching || s.exhausted || !s.batch) return
  s.fetching = true
  try {
    const qs = new URLSearchParams({ batch: s.batch, filter: s.filter, limit: String(PAGE_SIZE), offset: String(s.offset) })
    const data = await api(`/api/items?${qs.toString()}`)
    if (!data.ok) return void (s.fetchError = data.error ?? '取数失败')
    s.fetchError = ''
    const items = Array.isArray(data.items) ? data.items : []
    s.offset += items.length
    s.queue.push(...items)
    if (items.length < PAGE_SIZE) s.exhausted = true
    if (data.batch) applyProgress({ scored: data.batch.scored, total: data.batch.items ?? data.total })
    else if (Number.isFinite(data.total)) { s.total = data.total; renderProgress() }
  } finally { s.fetching = false }
}

// 进度真值：`/api/items` 的 batch 只有 scored/items（**没有 commented**），而进度行要显示
// "有评论 Z"。`/api/stats` 的 `comments.withText` 就是它 —— 多一次请求换一个不编的数字，值得。
async function loadProgressTruth() {
  const s = state.score
  if (!s.batch) return
  const data = await api(`/api/stats?batch=${encodeURIComponent(s.batch)}`)
  if (!data.ok) return
  const rate = data.rate ?? {}
  applyProgress({ scored: rate.scored, total: rate.total, commented: Number.isFinite(data.comments?.withText) ? data.comments.withText : null })
}

function applyProgress(p) {
  const s = state.score
  if (!p) return
  if (Number.isFinite(p.scored)) s.scored = p.scored
  if (Number.isFinite(p.total)) s.total = p.total
  if (Number.isFinite(p.commented)) s.commented = p.commented
  renderProgress()
}

/** 乐观推进用的加减：服务端一回来就被真值覆盖，所以这里只求"立刻动起来"。 */
function addProgress({ scored = 0, commented = 0 } = {}) {
  const s = state.score
  if (Number.isFinite(s.scored)) s.scored = Math.max(0, s.scored + scored)
  if (Number.isFinite(s.commented)) s.commented = Math.max(0, s.commented + commented)
  renderProgress()
}

function renderProgress() {
  const s = state.score
  const known = Number.isFinite(s.scored) && Number.isFinite(s.total) && s.total >= 0
  const commented = Number.isFinite(s.commented) ? String(s.commented) : '—'
  $('progress-text').textContent = known
    ? `已评 ${s.scored} / 共 ${s.total}（有评论 ${commented}）`
    : `已评 — / 共 —（有评论 ${commented}）（还没拿到进度）`
  const fill = $('progress-fill')
  fill.style.width = known && s.total > 0 ? `${Math.max(0, Math.min(100, (s.scored / s.total) * 100))}%` : '0%'
  fill.classList.toggle('unknown', !(known && s.total > 0))
}

/** 队列见底就续取：让"下一条"永远是本地就有的。 */
function maybePrefetch() {
  const s = state.score
  if (s.fetching || s.exhausted || !s.batch) return
  if (s.queue.length - s.index > PREFETCH_MIN) return
  void fetchPage().then(() => { if (state.page === 'score') renderCard() })
}

const currentItem = () => state.score.queue[state.score.index] ?? null

function renderCard() {
  const s = state.score
  const card = $('score-card')
  const empty = $('score-empty')
  if (!card) return
  const item = currentItem()
  if (!s.batch || !item) {
    card.hidden = true
    empty.hidden = false
    empty.textContent = !s.batch
      ? '还没有选批次 —— 先去「① 导入」页从语料库拉一批，或粘贴一批记录。'
      : s.fetchError
        ? `取数失败：${s.fetchError}\n（按右上角「↻ 重载数据」，或切一下过滤/批次再试）`
        : s.fetching
          ? '正在取这一批…'
          : s.exhausted && s.filter === 'unrated'
            ? '这个批次的「未评」已经清空了 🎉\n想看评过的就切到「已评」/「全部」，或者去「③ 报告」页整理评论。'
            : s.exhausted ? '这个过滤下没有条目。' : '正在准备…'
    return
  }
  card.hidden = false
  empty.hidden = true
  renderContext(item)
  $('reply').textContent = String(item.reply ?? '')
  renderItemMeta(item)
  renderVerdicts(item)
  renderPointPicker(item)
  renderComment(item)
  maybePrefetch()
}

/**
 * 点按钮（**就是原来标签按钮的位置**）。
 *
 * ★ (a) 语义（使用者拍板）：点一下**只记点，不往评论框里自动写字** ——
 *   两者各自留痕、谁也不覆盖谁。已选的点在评论框上方单独显示一行（可点 × 取消）。
 * ★ 拉不到点表时显示"拿不到 + 为什么"，**不显示成"没有点"**（那会让人以为点丢了）。
 */
function renderPointPicker(item) {
  const s = state.score
  const selected = Array.isArray(s.draft?.points) ? s.draft.points : ensureDraft(item).points
  const box = $('points-pick-empty')
  if (box) {
    box.hidden = state.points.ok && state.points.items.length > 0
    box.textContent = !state.points.ok
      ? `拿不到点表（${state.points.why}）—— 点按钮暂时用不了；评论照常可以写。按「↻ 刷新点」重试。`
      : '点表还是空的 —— 去「③ 报告」页最下面的「点表」里新建几个，或者先写评论再点「整理评论」让它自己长出来。'
  }
  for (const kind of ['bad', 'good']) {
    const list = $(`points-${kind}`)
    if (!list) continue
    clear(list)
    for (const p of pointsByKind(kind)) {
      const on = selected.includes(p.id)
      const b = el('button', on ? 'point-btn on' : 'point-btn', p.title)
      b.type = 'button'
      b.title = `${p.summary || '（没有摘要）'}\n已记 ${p.count ?? 0} 次 · 来源 ${p.source ?? '?'} · ${p.id}`
      b.onclick = () => togglePoint(p.id)
      list.appendChild(b)
      if (!state.points.items.length) break
    }
  }
  renderPickedPoints(selected, item)
}

/** 已选的点（评论框上方那一行）—— 与评论**并存**，不是替代关系。 */
function renderPickedPoints(selected, item) {
  const wrap = $('picked-points')
  if (!wrap) return
  clear(wrap)
  const chosen = (selected ?? []).map((id) => {
    const p = state.points.items.find((x) => x.id === id)
    return p ? { id, title: p.title } : { id, title: `（已删除的点 ${id}）` }
  })
  wrap.hidden = chosen.length === 0
  if (!chosen.length) return
  wrap.appendChild(el('span', 'picked-label', '已选的点：'))
  for (const c of chosen) {
    const chip = el('span', 'picked-chip', c.title)
    const x = el('button', 'picked-x', '×')
    x.type = 'button'
    x.title = '取消这个点（不动评论）'
    x.onclick = () => togglePoint(c.id)
    chip.appendChild(x)
    wrap.appendChild(chip)
  }
  if (item) wrap.title = '点与评论各自留痕：点一下不会替你写字，写字也不会自动选点'
}

function renderContext(item) {
  const wrap = $('ctx')
  const list = Array.isArray(item.context) ? item.context : []
  clear(wrap)
  wrap.hidden = !state.score.ctxOpen || list.length === 0
  $('ctx-count').textContent = list.length ? `（${list.length} 条）` : '（无上下文）'
  $('ctx-arrow').textContent = state.score.ctxOpen ? '▾' : '▸'
  for (const line of list) {
    const row = el('div', line?.isBot ? 'ctx-line ctx-bot' : 'ctx-line')
    row.appendChild(el('span', 'ctx-name', `${line?.name ?? '?'}：`))
    row.appendChild(el('span', 'ctx-text', String(line?.text ?? '')))
    if (line?.isBot) row.appendChild(el('span', 'ctx-tag', '机器人'))
    wrap.appendChild(row)
  }
}

function renderItemMeta(item) {
  const s = state.score
  const box = $('item-meta')
  clear(box)
  box.appendChild(el('span', 'pill', `本次队列第 ${s.index + 1} / ${s.queue.length} 条`))
  if (item.chatLabel) box.appendChild(el('span', 'pill', String(item.chatLabel)))
  box.appendChild(el('span', 'pill', fmtTime(item.at)))
  const idEl = el('span', 'pill id', `id ${item.id ?? '（无 id）'}`)
  idEl.title = '排查问题时把这个 id 一起发出来'
  box.appendChild(idEl)
  if (item.score?.verdict) box.appendChild(el('span', 'pill done', `已评：${verdictLabel(item.score.verdict)}`))
  const saved = String(item.score?.comment ?? '')
  if (hasCommentText(saved)) box.appendChild(el('span', 'pill done', `已写评论 ${saved.length} 字`))
}

/**
 * 每张卡的编辑态：判档前的评论先攒在这里，判档时一起落盘。
 * ★ 已评过的条目再遇到时 `comment` 从 `item.score.comment` 回填 —— 重评 = 改字，不是重打。
 * （旧数据里的 `tags` 读得进来但**不参与任何逻辑**：契约明说不丢历史。）
 */
function ensureDraft(item) {
  if (!item._draft) {
    item._draft = {
      verdict: item.score?.verdict ?? null,
      comment: typeof item.score?.comment === 'string' ? item.score.comment : '',
      // ★ 已选的点也要回填：重评这条时不许把它原来点过的点丢掉
      points: Array.isArray(item.score?.points) ? [...item.score.points] : [],
    }
  }
  return item._draft
}

/**
 * 切换一个点（点一下 = 记下这一类）。
 *
 * ★ (a) 语义：**只记点，不碰评论框**。用 `force` 立刻落盘（一次点击就是一次决定），
 *   写失败就把它改回去并报错 —— 与判档那条乐观推进同一条纪律。
 */
async function togglePoint(pointId) {
  const item = currentItem()
  if (!item) return
  const d = ensureDraft(item)
  const was = [...d.points]
  d.points = d.points.includes(pointId) ? d.points.filter((x) => x !== pointId) : [...d.points, pointId]
  renderPointPicker(item)
  const data = await postScore(item, { verdict: d.verdict, comment: commentValue(), points: d.points })
  if (!data.ok) {
    d.points = was
    renderPointPicker(item)
    showError(data.error ?? '点没能存上')
    return
  }
  const p = state.points.items.find((x) => x.id === pointId)
  toast(`${was.includes(pointId) ? '取消了' : '记下了'}「${p?.title ?? pointId}」`, 'ok')
}

function renderVerdicts(item) {
  const wrap = $('verdicts')
  clear(wrap)
  const d = ensureDraft(item)
  for (const v of state.taxonomy.verdicts.length ? state.taxonomy.verdicts : FALLBACK_VERDICTS) {
    const b = el('button', `verdict verdict-${v.id}${d.verdict === v.id ? ' active' : ''}`)
    b.appendChild(el('span', 'vk', v.key ?? ''))
    b.appendChild(el('span', 'vl', v.label ?? v.id))
    b.onclick = () => void applyVerdict(v.id)
    wrap.appendChild(b)
  }
}

/**
 * 评论框（这一版的主输入）。只在"换了条目"或"程序改过评论"时才回写 value：
 * ★ 正在这个框里打字时**绝不赋值** —— 给 `value` 赋值会把光标顶到末尾，表现是
 *   "打字打到一半光标乱跳"，而 prefetch 触发的重画随时都可能发生。
 */
function renderComment(item, { force = false } = {}) {
  const box = $('comment')
  if (!box) return
  const sig = `${item.id}|${ensureDraft(item).comment}`
  const sameItem = box.dataset.item === String(item.id)
  if (!force && sameItem && document.activeElement === box) { box.dataset.sig = sig; return }
  if (!force && box.dataset.sig === sig) return
  box.value = ensureDraft(item).comment
  box.dataset.sig = sig
  box.dataset.item = String(item.id)
}

/** 读评论框的**当前**内容（人可能刚打完字还没失焦，"所见即所存"）。 */
const commentValue = () => String($('comment')?.value ?? '')

/** Enter 连续评时把焦点留在评论框里；卡片藏起来（评完了/取数失败）时不要去抢焦点。 */
function focusComment() {
  const box = $('comment')
  if (box && !$('score-card').hidden && state.page === 'score') box.focus()
}

/** 落盘一条评分；返回值给调用方决定"要不要把这条放回来"。 */
async function postScore(item, snapshot) {
  const data = await api('/api/score', {
    method: 'POST',
    body: {
      id: item.id,
      verdict: snapshot.verdict,
      comment: snapshot.comment,
      points: Array.isArray(snapshot.points) ? snapshot.points : [],
    },
  })
  if (data.ok) {
    item.score = data.score ?? { id: item.id, verdict: snapshot.verdict, comment: snapshot.comment, points: snapshot.points ?? [] }
    applyProgress(data.progress)
  }
  return data
}

/** 从队列里把当前这张划掉：评过的卡不该再挡路（撤销会把它插回来）。 */
function consumeCurrent() {
  const s = state.score
  s.queue.splice(s.index, 1)
  if (s.index > s.queue.length) s.index = s.queue.length
}
function restoreCurrent(item, at) {
  const s = state.score
  s.queue.splice(Math.min(Math.max(0, at), s.queue.length), 0, item)
  s.index = Math.min(Math.max(0, at), Math.max(0, s.queue.length - 1))
}

/**
 * 判档（+ 把评论框里已有的字一起落盘）并推进下一条。
 * ★ 乐观推进：先换卡，不等网络 —— 人评几百条时"每点一次等一个往返"就是全部的时间浪费；
 *   失败必须把这张**放回原位**，否则人会以为已经评过了，而它其实一条都没落盘。
 */
async function applyVerdict(verdict, { refocus = false } = {}) {
  const s = state.score
  const at = s.index
  const item = s.queue[at]
  if (!item || !verdict) return
  const d = ensureDraft(item)
  const typed = commentValue()
  const prev = { verdict: d.verdict, comment: d.comment, score: item.score ?? null }
  const delta = {
    scored: prev.score ? 0 : 1,
    commented: (hasCommentText(typed) ? 1 : 0) - (hasCommentText(prev.score?.comment) ? 1 : 0),
  }
  d.verdict = verdict
  d.comment = typed
  const snapshot = { verdict, comment: typed, points: [...d.points] }
  item.score = { id: item.id, verdict, comment: typed, points: [...d.points], at: Date.now() }
  addProgress(delta)
  consumeCurrent()
  renderCard()
  if (refocus) focusComment()
  const res = await postScore(item, snapshot)
  if (res.ok) return
  d.verdict = prev.verdict
  d.comment = prev.comment
  item.score = prev.score
  addProgress({ scored: -delta.scored, commented: -delta.commented })
  restoreCurrent(item, at)
  renderCard()
  renderComment(item, { force: true }) // 评论框退回"已落盘的那一版"，别让页面演一个没存上的状态
  toast(`这一条没存上（${res.error ?? '未知原因'}），已经放回来了`, 'err')
}

/**
 * 评论失焦即存（**没有保存按钮**）：评分是每条几十秒的小动作，攒着必丢。
 * 还没判档时只把字攒在本地草稿里 —— 契约要求 `POST /api/score` 必须带 verdict，
 * 页面**绝不替人编一个**。
 */
async function saveComment() {
  const item = currentItem()
  if (!item) return
  const d = ensureDraft(item)
  const value = commentValue()
  if (value === d.comment) return
  d.comment = value
  if (!d.verdict) return toast('评论先记着：判档时一起落盘（按 1 / 2 / 3 或点上面的按钮）')
  const res = await postScore(item, { verdict: d.verdict, comment: d.comment, points: [...d.points] })
  if (!res.ok) toast(`评论没存上（${res.error ?? '未知原因'}）`, 'err')
}

/** `Enter`：保存并下一条（评论框里也是这个键；`Shift+Enter` 换行不拦）。 */
async function submitAndNext() {
  const item = currentItem()
  if (!item) return
  const d = ensureDraft(item)
  d.comment = commentValue()
  if (!d.verdict) return toast('这条还没判档：先按 1 / 2 / 3（或点上面的三个按钮），Enter 才是"保存并下一条"', 'err')
  await applyVerdict(d.verdict, { refocus: true })
}

/** 跳过 = **只在本地跳过，一个字都不写**（服务端根本不知道这件事）。 */
function skipCurrent() {
  const s = state.score
  const item = currentItem()
  if (!item) return
  // 打了字还没落盘的评论一旦跳过就没了 —— 先问一句，别让它悄悄消失
  if (!item.score && hasCommentText(commentValue()) && !window.confirm('这条评论还没落盘（还没判档），跳过就等于丢掉它。确认跳过？')) return
  if (s.queue.length <= 1) return toast('队列里只有这一条，跳不过去（可以先评了它，或换个过滤/批次）')
  s.queue.splice(s.index, 1)
  s.queue.push(item) // 排到队尾：这一轮看完还能回来
  if (s.index >= s.queue.length) s.index = 0
  renderCard()
  toast('已跳过（没写分），它排到队列末尾了')
}

async function undoLast() {
  const s = state.score
  if (!s.batch) return toast('先选一个批次', 'err')
  const data = await api('/api/undo', { method: 'POST', body: { batch: s.batch } })
  if (!data.ok) return
  if (!data.undone) return toast('这个批次没有可撤销的评分')
  applyProgress(data.progress)
  // 契约里没有"按 id 取一条"的接口，所以撤销后**重取这一批**再把那条定位出来：
  // 这样它一定重新出现在队列里，而不是"撤销了但页面上找不到"。
  await loadBatch(s.batch, s.filter, { focusId: String(data.undone.id ?? '') })
  toast(`已撤销上一条评分：${truncate(data.undone.id ?? '', 48)}`, 'ok')
}

/* ── 页签三：报告（统计 + 评论清单 + 整理 + 应用） ──────────────────── */

function renderReportBatchSelect() {
  const sel = $('report-batch')
  if (!sel) return
  const keep = state.reportBatch
  clear(sel)
  sel.appendChild(new Option('全部批次', 'all'))
  for (const b of state.sources.batches) {
    sel.appendChild(new Option(`${b?.label ?? b?.id ?? '（无标签）'}（${numOrDash(b?.items)} 条）`, String(b?.id ?? '')))
  }
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'all'
  state.reportBatch = sel.value || 'all'
}

async function enterReport() {
  if (!state.sources.batches.length) await refreshSources()
  renderReportBatchSelect()
  await Promise.all([reloadReport(), loadPoints()])
}
async function reloadReport() { await Promise.all([loadStats(), loadConsolidate()]) }

async function loadStats() {
  const box = $('stats-body')
  clear(box)
  const data = await api(`/api/stats?batch=${encodeURIComponent(state.reportBatch || 'all')}`)
  if (!data.ok) {
    // 拉不到就**什么都不画**（评论清单也一起空掉），绝不显示一排像真的 0
    state.stats = null
    box.appendChild(el('div', 'empty', `拉不到统计：${data.error ?? '未知原因'}`))
    renderCommentList()
    return
  }
  state.stats = data
  renderStats(data)
  renderCommentList()
}

function renderStats(data) {
  const box = $('stats-body')
  const counts = data.verdicts && typeof data.verdicts === 'object' ? data.verdicts : null
  if (!counts) return void box.appendChild(el('div', 'empty', '服务端没给 verdicts 字段 —— 这里不显示任何数字（不猜）。'))
  const vals = VERDICT_IDS.map((id) => (Number.isFinite(counts[id]) ? counts[id] : 0))
  const sum = vals.reduce((a, v) => a + v, 0)
  const rate = data.rate ?? {}
  // 分布条：宽度按**已评条数**算；一条都没评时直接说明，不画空条
  const dist = el('div', 'dist')
  if (sum > 0) {
    for (const [i, id] of VERDICT_IDS.entries()) {
      if (!vals[i]) continue
      const seg = el('div', `dist-seg dist-${id}`, `${verdictLabel(id)} ${pctOf(vals[i], sum)}`)
      seg.style.width = `${(vals[i] / sum) * 100}%`
      seg.title = `${verdictLabel(id)}：${vals[i]} 条`
      dist.appendChild(seg)
    }
  }
  box.appendChild(dist)
  const legend = el('div', 'dist-legend')
  for (const [i, id] of VERDICT_IDS.entries()) {
    const one = el('span')
    one.appendChild(el('b', '', String(vals[i])))
    one.appendChild(document.createTextNode(` 条 ${verdictLabel(id)}（${pctOf(vals[i], sum)}）`))
    legend.appendChild(one)
  }
  legend.appendChild(el('span', '', `合计已评 ${numOrDash(rate.scored)}${Number.isFinite(rate.total) ? ` / 共 ${rate.total}` : ''}`))
  box.appendChild(legend)
  if (sum === 0) box.appendChild(el('div', 'note', '还没有评分 —— 去「② 打分」页评几条，这里的分布才有意义。'))
  // ★ 评论是整理的**唯一素材**：只判档不写字的那些会被排除，所以这个数字必须露出来
  const c = data.comments ?? {}
  box.appendChild(el('div', 'stats-line', Number.isFinite(c.withText)
    ? `带评论 ${c.withText} 条 / 只判档没写评论 ${numOrDash(c.withoutText)} 条 —— 整理「点」只吃带评论的那些。`
    : '服务端没给 comments.withText —— "有多少条带评论"这个数字不知道（不猜）。'))

  // ── 点排行（顶替原来的标签排行）：点一下 = 只看"记过这个点"的评论 ──
  const pts = Array.isArray(data.points) ? data.points : []
  const pointHits = data.pointCounts && typeof data.pointCounts === 'object' ? data.pointCounts : {}
  box.appendChild(el('h3', 'sug-head', `点排行（${pts.length} 个点，记过 ${numOrDash(data.pointsUsed)} 条评分）`))
  if (!pts.length) {
    box.appendChild(el('div', 'note', '点表还是空的 —— 去下面「点表」那张卡新建几个，或者在「整理评论」里让它从评论里长出来。'))
    return
  }
  const rank = el('div', 'point-rank')
  for (const p of pts.slice(0, 30)) {
    // 被记了几次：count 是"支撑它的评论数"，pointCounts 是"这个范围里被点了多少次" —— 两个数都给，别混
    const n = Number(pointHits[p.id] ?? 0)
    const b = el('button', `point-chip ${p.kind === 'good' ? 'good' : 'bad'}${state.reportPoint === p.id ? ' on' : ''}`)
    b.appendChild(el('span', 'pc-title', String(p.title)))
    b.appendChild(el('span', 'pc-count', `记过 ${n} · count ${p.count ?? 0}`))
    b.title = `${p.summary || '（没有摘要）'}\n${state.reportPoint === p.id ? '再点一次取消筛选' : '点一下：只看记过这个点的评论'}`
    b.onclick = () => {
      state.reportPoint = state.reportPoint === p.id ? '' : p.id
      renderCommentList()
      renderStats(state.stats)
    }
    rank.appendChild(b)
  }
  box.appendChild(rank)
  if (state.reportPoint) {
    const clearBtn = el('button', 'ghost small', '清掉点的筛选')
    clearBtn.onclick = () => {
      state.reportPoint = ''
      renderCommentList()
      renderStats(state.stats)
    }
    box.appendChild(clearBtn)
  }
}

/** 评论清单：新 → 旧，可按判档筛选、可按文字搜索。这是"素材"本身，永远显示。 */
function renderCommentList() {
  const box = $('comment-list')
  if (!box) return
  clear(box)
  const data = state.stats
  const all = Array.isArray(data?.list) ? data.list : []
  const q = state.reportSearch.trim().toLowerCase()
  const rows = all.filter((r) => {
    if (state.reportVerdict && r?.verdict !== state.reportVerdict) return false
    // 按点筛（点排行点一下就筛）：只看"记过这个点"的评论
    if (state.reportPoint && !(Array.isArray(r?.points) ? r.points : []).some((p) => p?.id === state.reportPoint)) return false
    return !q || `${r?.comment ?? ''}\n${r?.reply ?? ''}`.toLowerCase().includes(q)
  })
  $('comment-list-note').textContent = data
    ? `共 ${all.length} 条评分（带评论 ${all.filter((r) => hasCommentText(r?.comment)).length} 条` +
      `${state.reportPoint ? `，筛了点 ${state.reportPoint}` : ''}），当前显示 ${rows.length} 条｜新 → 旧`
    : '还没有统计数据 —— 清单不可用（原因见上方红条）。'
  if (!data) return void box.appendChild(el('div', 'empty', '拉不到统计 —— 评论清单也一起不可用；不会显示一个空的"看起来没评过"的清单。'))
  if (!all.length) return void box.appendChild(el('div', 'empty', '还没有任何评分 —— 去「② 打分」页评几条，这里就有清单了。'))
  if (!rows.length) return void box.appendChild(el('div', 'empty', '当前筛选/搜索下没有条目（换个判档或清空搜索看看）。'))
  for (const r of rows) box.appendChild(commentRow(r))
}

/** 一条评论 = 判档 + 评论（主角）+ 被评的那句话与上下文。全部走 textContent。 */
function commentRow(r) {
  const card = el('div', 'cm-item')
  const head = el('div', 'cm-head')
  head.appendChild(el('span', `pill v-${r?.verdict ?? 'none'}`, verdictLabel(r?.verdict)))
  head.appendChild(el('span', 'cm-time', fmtTime(r?.at)))
  if (r?.chatLabel) head.appendChild(el('span', 'cm-time', String(r.chatLabel)))
  card.appendChild(head)
  const comment = String(r?.comment ?? '').trim()
  card.appendChild(el('div', comment ? 'cm-comment' : 'cm-comment empty-comment', comment || '（只判了档，没写评论 —— 它不参与整理）'))
  // ★ 点与评论**各自留痕**：这里把这条记过的点也显示出来（(a) 语义：点不写进评论正文）
  const ps = Array.isArray(r?.points) ? r.points : []
  if (ps.length) {
    const row = el('div', 'cm-points')
    row.appendChild(el('span', 'picked-label', '记的点：'))
    for (const p of ps) row.appendChild(el('span', `point-chip ${p?.kind === 'good' ? 'good' : 'bad'}`, String(p?.title ?? p?.id ?? '')))
    card.appendChild(row)
  }
  card.appendChild(el('div', 'cm-reply-label', '被评的那句话：'))
  card.appendChild(el('div', 'cm-reply', String(r?.reply ?? '（服务端没给 reply）')))
  const ctx = contextText(r?.context)
  if (ctx) card.appendChild(el('div', 'cm-ctx', ctx))
  card.appendChild(el('div', 'cm-id', `id ${r?.id ?? '—'}`))
  return card
}

/* ── 点表管理（报告页最下面那张卡）──────────────────────────────────────
 *
 * ★ 为什么这一块必须存在：点是**使用者的词汇表**，不是代码里的常量。
 *   没有编辑入口的话，"点不合理"就只能去找开发者改代码 —— 那就退回到标签时代了。
 * ★ 标题即时落盘（改一个字就发一次），因为它是"我记住的说法"，攒着必丢。
 * ★ 与已有的点同义（服务端按归一化标题判）时会**并进那一个**：页面如实说"已并入"，
 *   绝不假装新建成功（否则人会以为自己建了两个，实际只有一个）。
 */

function renderPointsAdmin() {
  const box = $('points-admin')
  if (!box) return
  clear(box)
  const note = $('points-admin-note')
  if (!state.points.ok) {
    note.textContent = `拿不到点表：${state.points.why} —— 下面显示不了任何点（不显示成"没有点"）。`
    return
  }
  const items = state.points.items
  note.textContent = items.length
    ? `共 ${items.length} 个点（bad ${pointsByKind('bad').length} / good ${pointsByKind('good').length}）` +
      `${state.points.seeded ? `｜这次启动播了 ${state.points.seeded} 个初始点` : ''}｜count = 有多少条评论支撑它`
    : '点表是空的 —— 用上面的表单新建一个，或者去上面点「整理评论」让点从评论里长出来。'
  for (const p of items.slice().sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || (b.count ?? 0) - (a.count ?? 0))) {
    const row = el('div', 'pt-row')
    const kind = el('select', 'pt-kind')
    for (const k of ['bad', 'good']) {
      const o = new Option(k === 'bad' ? '不该这样' : '这样很好', k)
      if (p.kind === k) o.selected = true
      kind.appendChild(o)
    }
    kind.onchange = () => void savePoint({ id: p.id, kind: kind.value, title: p.title, summary: p.summary })
    row.appendChild(kind)

    const title = el('input', 'pt-title')
    title.value = p.title
    title.title = `来源 ${p.source ?? '?'}｜count ${p.count ?? 0}｜${p.id}`
    // 失焦即存；值没变就不发请求（避免点一下别处就打一次接口）
    title.onblur = () => {
      if (title.value.trim() !== p.title) void savePoint({ id: p.id, kind: kind.value, title: title.value, summary: p.summary })
    }
    row.appendChild(title)

    const summary = el('input', 'pt-summary')
    summary.value = p.summary ?? ''
    summary.placeholder = '摘要（可选，按钮的 title 里显示）'
    summary.onblur = () => {
      if (summary.value.trim() !== (p.summary ?? '')) void savePoint({ id: p.id, kind: kind.value, title: title.value, summary: summary.value })
    }
    row.appendChild(summary)

    row.appendChild(el('span', 'pt-count', `×${p.count ?? 0}`))
    row.appendChild(el('span', 'pt-source', String(p.source ?? '')))
    const del = el('button', 'ghost danger', '删除')
    del.onclick = () => void removePoint(p)
    row.appendChild(del)
    box.appendChild(row)
  }
}

async function savePoint({ id, kind, title, summary }) {
  const data = await api('/api/points', { method: 'POST', body: { id: id ?? '', kind, title, summary } })
  if (!data.ok) return void showError(data.error ?? '点没存上')
  state.points = { ...state.points, ok: true, items: Array.isArray(data.points) ? data.points : state.points.items }
  if (data.merged) toast(`「${data.point?.title ?? title}」已并入已有的同名点（不重复建）`, 'ok')
  else if (data.created) toast(`新建了点「${data.point?.title ?? title}」`, 'ok')
  renderPointsAdmin()
  renderCard()
  await loadStats() // 报告页的点排行要跟着变
}

async function removePoint(p) {
  const used = Number(p?.count) || 0
  const ok = window.confirm(
    `删掉点「${p?.title ?? p?.id}」？\n\n` +
      `· 它被记过 ${used} 次（count）；**已经记下的评分不会跟着删** —— 报告页会把它们显示成「（已删除的点）」；\n` +
      '· 打分页上这个按钮会消失。\n\n确定要删吗？',
  )
  if (!ok) return
  const data = await api(`/api/points?id=${encodeURIComponent(p.id)}`, { method: 'DELETE' })
  if (!data.ok) return void showError(data.error ?? '删不掉')
  state.points = { ...state.points, items: Array.isArray(data.points) ? data.points : state.points.items }
  toast(`删掉了点「${p?.title ?? p.id}」（有 ${numOrDash(data.usedBy)} 条评分引用过它）`, 'ok')
  renderPointsAdmin()
  renderCard()
  await loadStats()
}

// `GET /api/consolidate`：取这个范围**最近一次**整理 + 评论 + 模型可用性 + 锚点清单。
// 它**不调模型**（不花钱），所以一进报告页就拉。
async function loadConsolidate({ keepLocal = false } = {}) {
  const data = await api(`/api/consolidate?scope=${encodeURIComponent(state.reportBatch || 'all')}`)
  const c = state.cons
  c.loaded = true
  if (!data.ok) {
    c.model = { ok: false, why: data.error ?? '取整理状态失败' }
    c.error = `取整理状态失败：${data.error ?? '未知原因'}`
    return renderConsolidate()
  }
  Object.assign(c, {
    latest: data.latest ?? null,
    comments: Array.isArray(data.comments) ? data.comments : [],
    counts: data.counts ?? null,
    model: data.model ?? null,
    limits: data.limits ?? null,
    anchors: Array.isArray(data.anchors) ? data.anchors : [],
  })
  // 换了范围时，上一次的失败信息/本地聚类/"仍然应用"的武装状态都作废
  if (!keepLocal) Object.assign(c, { clusters: null, error: '', armed: false })
  renderConsolidate()
}

/** 真的调一次模型整理（人点一下才发生，钱花在明处）。 */
async function runConsolidate() {
  const c = state.cons
  if (c.busy) return
  if (c.model?.ok !== true) return toast('整理不可用（原因见按钮旁的那句话）', 'err')
  c.busy = true
  c.error = ''
  renderConsolidate()
  toast('正在调模型整理评论…（几十秒都算正常，别刷新页面）')
  const res = await api('/api/consolidate', { method: 'POST', body: { scope: state.reportBatch || 'all' } })
  c.busy = false
  if (res.ok === true && res.consolidation) {
    Object.assign(c, { latest: res.consolidation, clusters: res.clusters ?? null, error: '', armed: false })
    renderConsolidate()
    const merge = res.pointsMerge ?? null
    toast(
      `整理完成：${numOrDash(res.consolidation.points?.length)} 个点（点表新建 ${numOrDash(merge?.created)} / 并入 ${numOrDash(merge?.merged)}），${numOrDash(res.ms)} ms`,
      'ok',
    )
    // ★ 整理产出的点**并进了点表** —— 打分页那排按钮要立刻反映出来（不必重启、不必再整理一次）
    if (Array.isArray(res.points)) state.points = { ...state.points, ok: true, items: res.points }
    renderPointsAdmin()
    renderCard()
    return void loadConsolidate({ keepLocal: true })
  }
  // ★ 失败仍是 HTTP 200：error 原样显示，本地聚类与评论原文都要在 —— 素材不能跟着"看不见"
  Object.assign(c, { error: String(res.error ?? '服务端没给 error'), clusters: res.clusters ?? null })
  if (Array.isArray(res.comments) && res.comments.length) c.comments = res.comments
  renderConsolidate()
  toast('整理没成 —— 评论原文与本地聚类都在页面上，没有丢', 'err')
}

function renderConsolidate() {
  const c = state.cons
  const card = $('consolidate-card')
  if (!card) return
  card.hidden = !c.loaded

  // ── 「整理评论」按钮：不可用时**禁用并说明原因**（绝不给一个点了没反应的按钮）──
  const modelOk = c.model?.ok === true
  const noMaterial = Number.isFinite(c.counts?.withText) && c.counts.withText === 0
  $('btn-consolidate').disabled = c.busy || !modelOk || noMaterial
  const lim = c.limits ?? {}
  $('consolidate-why').textContent = !c.loaded
    ? '正在取整理状态…'
    : c.busy
      ? '正在整理…'
      : !modelOk
        ? `整理不可用：${c.model?.why ?? '服务端没说原因'}`
        : noMaterial
          ? '还没有带评论的评分 —— 整理没有素材（去「② 打分」页写几条评论）。'
          : `模型：${c.model.model ?? '（未给）'}${c.model.baseUrl ? `（${c.model.baseUrl}）` : ''}` +
            `｜一次最多喂 ${numOrDash(lim.comments)} 条评论 / ${numOrDash(lim.chars)} 字`

  // ── 底线要点（锚点）清单：GET 就给了，先让人知道"改写必须留住哪些东西" ──
  const anchorBox = $('anchor-list')
  clear(anchorBox)
  if (c.anchors.length) {
    anchorBox.appendChild(el('span', 'anchor-box-title', `底线要点（${c.anchors.length} 条，改写一条都不许丢）：`))
    anchorBox.appendChild(el('span', '', c.anchors.map((a) => a?.label ?? a?.id).filter(Boolean).join('、')))
  }

  // ── 失败：error + 本地聚类；评论原文在上面那份「评论清单」里，一条都不会消失 ──
  const errBox = $('consolidate-error')
  errBox.hidden = !c.error
  errBox.textContent = c.error
    ? `整理没成：${c.error}\n（评论原文见上面的「评论清单」，素材没丢；下面的本地聚类是"哪些评论在说同一件事"）`
    : ''

  const l = c.latest
  const hasLatest = Boolean(l?.id)
  if (hasLatest) {
    const ps = l.promptStats ?? {}
    const trunc = Number.isFinite(ps.truncatedComments) && ps.truncatedComments > 0 ? `（另有 ${ps.truncatedComments} 条因长度没喂进去）` : ''
    $('consolidate-meta').textContent =
      `整理 ${l.id}｜${fmtTime(l.createdAt)}｜模型 ${l.model ?? '（未给）'}｜${numOrDash(l.ms)} ms\n` +
      `点 ${Array.isArray(l.points) ? l.points.length : '—'} 条｜改写 ${numOrDash(l.chars)} 字（原 ${numOrDash(l.styleBeforeChars)} 字）｜` +
      `喂进去 ${numOrDash(ps.kept)} 条评论${trunc}` +
      (l.appliedAt ? `\n已于 ${fmtTime(l.appliedAt)} 应用到 styles/闲聊.md` : '\n还没应用到文件')
  } else {
    $('consolidate-meta').textContent = c.loaded
      ? (c.error ? '还没有成功的整理结果。' : '这个范围还没整理过 —— 点上面的「整理评论」把评论归纳成「点」并整篇重写。')
      : '正在取整理状态…'
  }
  renderPoints(hasLatest ? l : null)
  renderClusters(c.clusters)
  const diff = hasLatest && typeof l.diff === 'string' ? l.diff : ''
  $('diff-head').hidden = !diff
  renderDiff($('consolidate-diff'), diff)
  renderAnchorCheck(hasLatest ? l : null)
  renderApplyRow()
}

/** 「点」+ 可展开的证据原文（证据是提示词里的**评论编号**，能换回原文就换回来）。 */
function renderPoints(l) {
  const box = $('points')
  clear(box)
  if (!l) return
  const points = Array.isArray(l.points) ? l.points : []
  box.appendChild(el('h3', 'sug-head', `整理出来的「点」（${points.length} 条）`))
  if (!points.length) return void box.appendChild(el('div', 'note', '这次整理一个点都没给出 —— 别据此改文件，先看看评论写得够不够具体。'))
  for (const p of points) {
    const kind = p?.kind === 'good' ? 'good' : 'bad'
    const card = el('div', `point point-${kind}`)
    const head = el('div', 'point-head')
    head.appendChild(el('span', 'point-kind', kind === 'good' ? '要保留 / 写清楚' : '要改掉'))
    head.appendChild(el('span', 'point-title', String(p?.title ?? '（没写标题）')))
    if (p?.where) head.appendChild(el('span', 'point-where', `位置：${p.where}`))
    card.appendChild(head)
    if (p?.summary) card.appendChild(el('div', 'point-summary', String(p.summary)))
    const ev = Array.isArray(p?.evidence) ? p.evidence : []
    card.appendChild(el('div', 'point-ev', `证据 ${ev.length} 条`))
    if (ev.length) {
      // `<details>` 是浏览器原生的折叠：零依赖，且证据原文默认不占版面
      const det = document.createElement('details')
      det.appendChild(el('summary', '', `展开证据原文（${ev.length} 条）`))
      for (const n of ev) det.appendChild(el('div', 'ev-line', evidenceText(n)))
      card.appendChild(det)
    }
    box.appendChild(card)
  }
}

// 证据是提示词里的**评论编号**（1 起，见 chat-review-consolidate.mjs 的 commentLine）：
// 编号对得上 `state.cons.comments`（同范围、新→旧、只含带评论的）就换回原文；
// 换不回来就如实显示编号 —— 不编一段看起来像原文的话。
function evidenceText(n) {
  const at = Number(n) - 1
  const row = Number.isInteger(at) && at >= 0 ? state.cons.comments[at] : null
  if (!row) return `第 ${n} 条评论（这次没取到它的原文）`
  const reply = truncate(String(row.reply ?? '').replace(/\s+/g, ' '), 60)
  return `[${n}] 评论：${String(row.comment ?? '').trim()}${reply ? `\n      当时它说：「${reply}」` : ''}`
}

/** 本地确定性聚类（不调模型）：让人看见"哪些评论在说同一件事、说了几遍"。 */
function renderClusters(clusters) {
  const box = $('clusters')
  clear(box)
  if (!clusters || typeof clusters !== 'object') return
  const groups = [['bad', '不对'], ['ok', '还行'], ['good', '对']]
  const total = groups.reduce((n, [k]) => n + (Array.isArray(clusters[k]) ? clusters[k].length : 0), 0)
  if (!total) return
  const det = document.createElement('details')
  det.appendChild(el('summary', '', `本地聚类（相似评论分组，共 ${total} 组；不调模型，随时能看）`))
  for (const [k, label] of groups) {
    const rows = Array.isArray(clusters[k]) ? clusters[k] : []
    if (!rows.length) continue
    det.appendChild(el('div', 'cluster-head', `${label}（${rows.length} 组）`))
    for (const one of rows) {
      const row = el('div', 'cluster')
      row.appendChild(el('span', 'cluster-count', `×${numOrDash(one?.count)}`))
      row.appendChild(el('span', 'cluster-text', String(one?.text ?? '')))
      det.appendChild(row)
    }
  }
  det.appendChild(el('div', 'note', '聚类只是"把说得像的评论堆在一起并计数"，不是结论 —— 结论是上面的「点」。'))
  box.appendChild(det)
}

/** 锚点核对结果：守住了就说守住了；没守住就把丢失的底线要点**逐条**列出来。 */
function renderAnchorCheck(l) {
  const box = $('anchor-check')
  clear(box)
  if (!l) return
  const a = l.anchors
  if (!a || typeof a !== 'object') {
    return void box.appendChild(el('div', 'callout warn', '服务端没给 anchors —— 无法确认底线要点有没有守住，应用前请自己把改写读一遍。'))
  }
  if (a.ok === true) {
    return void box.appendChild(el('div', 'callout ok', `锚点核对通过：${numOrDash(a.checked)} 条底线要点都还在。`))
  }
  const missing = Array.isArray(a.missing) ? a.missing : []
  const warn = el('div', 'callout err')
  warn.appendChild(el('div', '', `⚠️ 锚点没守住：丢了 ${missing.length} 条底线要点（共核对 ${numOrDash(a.checked)} 条）：`))
  const ul = el('ul', 'anchor-missing')
  for (const m of missing) {
    const any = Array.isArray(m?.any) && m.any.length ? `（文件里应有：${m.any.join(' / ')}）` : ''
    ul.appendChild(el('li', '', `${m?.label ?? m?.id ?? '（服务端没给名字）'}${any}`))
  }
  warn.appendChild(ul)
  box.appendChild(warn)
}

/** 不引 diff 库：按行分，`+` 绿 `-` 红。 */
function renderDiff(pre, diff) {
  clear(pre)
  if (!diff) return void (pre.hidden = true)
  pre.hidden = false
  for (const line of diff.split('\n')) {
    const cls = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : line.startsWith('@@') ? 'diff-hunk' : 'diff-line'
    pre.appendChild(el('div', cls, line === '' ? ' ' : line))
  }
}

const anchorMissingOf = (l) => (Array.isArray(l?.anchors?.missing) ? l.anchors.missing : []).map((m) => String(m?.label ?? m?.id ?? '（没给名字）'))

function renderApplyRow() {
  const c = state.cons
  const btn = $('btn-apply')
  const why = $('apply-why')
  if (!btn || !why) return
  const l = c.latest
  if (!l?.id || !String(l.rewritten ?? '').trim()) {
    btn.disabled = true
    btn.textContent = '应用到 styles/闲聊.md'
    why.textContent = l?.id ? '这份整理结果里没有正文（rewritten 是空的）—— 不能应用。' : '还没有整理结果可应用 —— 先点「整理评论」。'
    return
  }
  const anchorsOk = l.anchors?.ok !== false
  btn.disabled = false
  const n = anchorMissingOf(l).length
  if (anchorsOk) {
    btn.textContent = '应用到 styles/闲聊.md'
    why.textContent = '点下去会弹确认框：写清楚会先备份 styles/闲聊.md、再整篇替换、并同步出厂常量。'
  } else if (c.armed) {
    btn.textContent = '我知道，仍然应用'
    why.textContent = `锚点没守住（丢了 ${n} 条）。再点这一次才会写文件（先备份；会记为"覆盖应用"）。`
  } else {
    btn.textContent = '应用到 styles/闲聊.md'
    // ★ 锚点没守住时，第一次点击**不发请求、不写文件**：只把丢失清单摆出来等人确认
    why.textContent = `⚠️ 锚点没守住（丢了 ${n} 条）：第一次点击不会写文件，只会把丢失清单摆出来让你确认。`
  }
}

/**
 * 应用改写：**唯一会碰风格文件与出厂常量的写操作**，所以两段确认一个都不能少 ——
 * ① 弹窗写清"先备份、整篇替换、同步出厂常量"；② 锚点没守住时还要一次明确的"仍然应用"。
 */
async function applyConsolidation() {
  const c = state.cons
  const l = c.latest
  if (!l?.id) return toast('还没有整理结果可应用', 'err')
  if (!String(l.rewritten ?? '').trim()) return toast('这份整理结果里没有正文，不能应用', 'err')
  const anchorsOk = l.anchors?.ok !== false
  if (!anchorsOk && !c.armed) {
    // ★ 第一次点击**什么都不发**：只是把"丢了哪几条"摆到台面上，等一个明确的第二次点击
    c.armed = true
    renderConsolidate()
    return toast('锚点没守住：丢失清单在上面，确认后再点「我知道，仍然应用」', 'err')
  }
  const missing = anchorMissingOf(l)
  const ok = window.confirm(
    // ⚠️ `window.confirm` 是**纯文本**，别在这里写 Markdown（星号会原样显示出来）
    '确认把这份改写写进 styles/闲聊.md 吗？\n\n' +
      '· 会先把现在的文件备份到 styles/.backups/（闲聊.md.<时间戳>.bak）；\n' +
      `· 然后把整份文件替换成这次整理出来的正文（现在 ${numOrDash(l.styleBeforeChars)} 字 → 改写 ${numOrDash(l.chars)} 字）；\n` +
      '· 并同步 src/chat-mode.mjs 里的出厂默认常量（不同步的话两份会漂，测试会红）；\n' +
      (anchorsOk ? '' : `· ⚠️ 这份改写丢了 ${missing.length} 条底线要点：${missing.join('、')} —— 你选择了仍然应用。\n`) +
      `\n整理记录：${l.id}`,
  )
  if (!ok) return
  $('btn-apply').disabled = true
  const res = await api('/api/apply', {
    method: 'POST',
    // ★ 只有"武装过的第二次点击"才带 confirmAnchors:true；确认框首点永远不带
    body: { consolidation: l.id, scope: state.reportBatch || 'all', confirm: true, confirmAnchors: !anchorsOk },
  })
  if (!res.ok) {
    $('btn-apply').disabled = false
    return renderApplyFailure(res)
  }
  renderApplyResult(res)
  toast('已应用到 styles/闲聊.md（备份已生成）', 'ok')
  await loadHealth() // ★ 顶栏的字数与指纹必须跟着变，否则人会以为没写进去
  await loadConsolidate({ keepLocal: true }) // latest.appliedAt 也要更新
}

function renderApplyFailure(res) {
  const lines = [`没能应用（HTTP ${numOrDash(res.httpStatus)}）：${res.error ?? '服务端没给 error'}`]
  const missing = Array.isArray(res.anchorsMissing) ? res.anchorsMissing : []
  if (missing.length) {
    // 服务端在 409 里回了"丢了哪几条" —— 逐条显示，并把按钮切成"仍然应用"
    lines.push(`丢了 ${missing.length} 条底线要点：${missing.map((m) => m?.label ?? m?.id ?? '（没给名字）').join('、')}`)
    state.cons.armed = true
    renderConsolidate()
  }
  $('apply-result').textContent = lines.join('\n')
  if (missing.length) toast('锚点没守住：再点一次「我知道，仍然应用」才会写文件', 'err')
}

function renderApplyResult(res) {
  const before = Number.isFinite(res.beforeChars) ? res.beforeChars : null
  const after = Number.isFinite(res.chars) ? res.chars : null
  const delta = before != null && after != null ? after - before : null
  const parts = [
    `已应用：${numOrDash(before)} → ${numOrDash(after)} 字` +
      (delta == null ? '（服务端没给全字数，算不出精简/增加）' : delta === 0 ? '（字数没变）' : `（${delta < 0 ? '精简' : '增加'} ${Math.abs(delta)} 字）`),
    `备份：${res.backup ?? '（服务端没给备份路径 —— 请自己去 styles/.backups/ 确认）'}`,
    `新 sha256：${res.sha256 ? String(res.sha256).slice(0, 16) : '（未给）'}`,
    `整理记录：${res.consolidationId ?? '（未给）'}`,
    res.anchorsOverridden ? '⚠️ 锚点是被覆盖应用的（这份改写丢了底线要点）' : '锚点核对通过',
  ]
  const cs = res.constantSync
  if (cs?.ok === true) {
    parts.push(`出厂常量已同步${cs.changed === false ? '（内容本来就一致，没改）' : '（src/chat-mode.mjs 已更新）'}`)
  } else if (cs?.ok === false) {
    // ★ 这句必须响：风格文件改了、出厂常量没跟上 —— 两份会漂，而且只有测试会告诉你
    parts.push(`⚠️ 出厂常量没同步成功：${cs.why ?? '服务端没说原因'}\n   （styles/闲聊.md 已经改好了，但 src/chat-mode.mjs 里的默认常量还是旧的 —— 两份会漂，verify-chat-mode 会红。）`)
  } else {
    parts.push('⚠️ 服务端没给 constantSync —— 无法确认出厂常量有没有同步成功。')
  }
  $('apply-result').textContent = parts.join('\n')
}

/* ── 事件绑定：**逐个 try/catch** —— 一个绑不上不影响其余的 ─────────── */
// （"页面画得出来但每个按钮都没反应"就是这么来的）

function bind(id, prop, handler) {
  try {
    const node = $(id)
    if (!node) throw new Error(`页面上找不到 #${id}`)
    node[prop] = handler
  } catch (error) { showPageError(`绑定 #${id} 的 ${prop} 失败`, error) }
}

function bindEvents() {
  bind('tab-import', 'onclick', () => void switchTab('import'))
  bind('tab-score', 'onclick', () => void switchTab('score'))
  bind('tab-report', 'onclick', () => void switchTab('report'))
  bind('btn-reload', 'onclick', async () => {
    await Promise.all([loadHealth(), loadTaxonomy(), refreshSources()])
    if (state.page === 'score') { renderCard(); void loadProgressTruth() }
    if (state.page === 'report') await reloadReport()
    toast('已重载数据')
  })
  bind('error-close', 'onclick', () => { $('error-banner').hidden = true })
  // 导入页
  bind('btn-pull', 'onclick', () => void pullFromCorpus())
  bind('btn-import', 'onclick', () => void importPasted())
  bind('import-format', 'onclick', (e) => {
    const btn = e.target?.closest?.('button[data-format]')
    if (!btn) return
    state.importFormat = btn.dataset.format
    for (const other of $('import-format').children) other.classList.toggle('active', other === btn)
  })
  // 打分页
  bind('score-batch', 'change', (e) => void loadBatch(e.target.value, $('score-filter').value))
  bind('score-filter', 'change', (e) => void loadBatch($('score-batch').value, e.target.value))
  bind('btn-undo', 'onclick', () => void undoLast())
  bind('btn-toggle-ctx', 'onclick', () => {
    state.score.ctxOpen = !state.score.ctxOpen
    renderContext(currentItem() ?? {})
  })
  // 评论：**失焦即存**（没有保存按钮）。打字时不发请求，所以每次击键都不打扰服务端。
  bind('comment', 'onblur', () => void saveComment())
  // 报告页
  bind('report-batch', 'change', (e) => {
    state.reportBatch = e.target.value || 'all'
    state.reportVerdict = ''
    state.reportSearch = ''
    $('comment-search').value = ''
    for (const other of $('comment-filter').children) other.classList.toggle('active', (other.dataset.verdict ?? '') === '')
    $('apply-result').textContent = ''
    void reloadReport()
  })
  bind('comment-filter', 'onclick', (e) => {
    const btn = e.target?.closest?.('button[data-verdict]')
    if (!btn) return
    state.reportVerdict = btn.dataset.verdict ?? ''
    for (const other of $('comment-filter').children) other.classList.toggle('active', other === btn)
    renderCommentList() // 纯本地筛选，不重新请求
  })
  bind('comment-search', 'oninput', (e) => {
    state.reportSearch = String(e.target.value ?? '')
    renderCommentList()
  })
  bind('btn-consolidate', 'onclick', () => void runConsolidate())
  bind('btn-apply', 'onclick', () => void applyConsolidation())
  // 点表：刷新 + 新建（编辑与删除在 renderPointsAdmin 里逐个绑）
  bind('btn-points-reload', 'onclick', () => void loadPoints())
  bind('btn-point-new', 'onclick', () => {
    const title = String($('np-title')?.value ?? '').trim()
    if (!title) return toast('先给新点起个标题', 'err')
    void savePoint({
      id: '',
      kind: $('np-kind')?.value === 'good' ? 'good' : 'bad',
      title,
      summary: String($('np-summary')?.value ?? ''),
    })
    if ($('np-title')) $('np-title').value = ''
    if ($('np-summary')) $('np-summary').value = ''
  })
}

// ── 键盘：打分页不该用鼠标 ──────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const tagName = (e.target?.tagName ?? '').toLowerCase()
  const typing = tagName === 'input' || tagName === 'select' || tagName === 'textarea'
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (e.key === 'Escape') {
    if (typing) return void e.target.blur() // 失焦即存；也顺手把 1/2/3 还给快捷键
    return void ($('error-banner').hidden = true)
  }
  if (state.page !== 'score') return
  // ★ 评论框里的 Enter 就是"保存并下一条"（Shift+Enter 换行）—— 这是评几百条的主路径
  if (typing && tagName === 'textarea' && e.key === 'Enter') {
    if (e.shiftKey) return
    e.preventDefault()
    return void submitAndNext()
  }
  // ★ 在输入框里打字时，数字键/回车都是**文字**，不是快捷键：
  //   评论里写个"2"就跳条目，是比"少一个快捷键"严重得多的坏法
  if (typing) return
  if (e.key === '1' || e.key === '2' || e.key === '3') {
    e.preventDefault()
    return void applyVerdict(verdictForKey(e.key))
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    return void submitAndNext()
  }
  if (e.key === 'u' || e.key === 'U') {
    e.preventDefault()
    return void undoLast()
  }
  if (e.key === 's' || e.key === 'S') {
    e.preventDefault()
    return skipCurrent()
  }
})

/* ── 启动 ───────────────────────────────────────────────────────────── */

async function boot() {
  bindEvents()
  // 点表启动就要有：打分页那排按钮是它的第一落点（原标签的位置不能空着）
  await Promise.all([loadHealth(), loadTaxonomy(), loadPoints()])
  await switchTab('import') // 打开页面先落在导入页：第一次用它的人要从这里开始
}

boot().catch((e) => {
  showPageError('首次加载失败', e)
  toast(`加载失败：${e?.message ?? e}`, 'err')
})
