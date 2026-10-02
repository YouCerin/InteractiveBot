/**
 * 聊天记录评审台 —— 前端（零依赖、无构建、**经典脚本**）。
 *
 * 三个页签：导入 → 打分 → 报告。四条纪律，改代码时不要绕开：
 * ① **不编数据**：请求失败就把服务端给的 `error` 显示出来，绝不用 0 或空占位冒充"测出来的
 *    数"。典型例子：`corpus.ok === false` 时顶栏显示 `corpus.why`，而不是一个看着正常的行数。
 * ② **打分不能被网络卡住**：判档后立刻换下一条（乐观推进），失败再把那条**放回原位**并报错。
 *    人一次要评几百条，"每点一下等一个往返"就是全部的时间浪费。
 * ③ **聊天原文只走 textContent**：reply / context / examples 都是真人聊天内容，可能带恶意
 *    标签。本文件从不把字符串当 HTML 塞进页面：那不是显示问题，是 XSS。
 * ④ **契约就是契约**：`/api/...` 路径与字段名都按 `chat-review/API.md`。页面调一个不存在
 *    的接口时服务端日志是干净的，症状只会是"点了没反应"，所以路径一个字都不许改。
 */
const $ = (id) => document.getElementById(id)

/** 一次取多少条（契约默认 20）。 */
const PAGE_SIZE = 20
/** 队列里剩这么少就续取下一页：让"下一条"永远是本地就有的，不用等网络。 */
const PREFETCH_MIN = 6
/** 数字键 4–9 / 0 绑给**前七个**标签（契约键位）。 */
const TAG_KEYS = ['4', '5', '6', '7', '8', '9', '0']
/** 三档判档的键位是契约固定的；税则取不到时用它兜住键盘，不让人"按了没反应"。 */
const FALLBACK_VERDICTS = [
  { id: 'good', label: '就该这么说', key: '1' },
  { id: 'ok', label: '还行', key: '2' },
  { id: 'bad', label: '不该这么说', key: '3' },
]

const state = {
  page: 'import',
  health: null,
  // ★ 取不到时要能区分"还没取到"和"服务端说不可用"，否则页面会显示成"0 个会话"
  sources: { corpus: { ok: false, why: '还没取到数据源', chats: [] }, batches: [] },
  taxonomy: { ok: false, verdicts: [], tags: [], drift: [] },
  importFormat: 'forward-json',
  score: {
    batch: '', filter: 'unrated',
    queue: [], // 本地待过队列：评过的条目离开队列（撤销会插回来）
    index: 0,
    offset: 0, // 服务端分页游标，与队列长度无关（队列会因为评分变短）
    exhausted: false, fetching: false, fetchError: '',
    scored: null, total: null, // 一律先 null：没拿到真实进度就显示"—"，不显示 0
    loadedFor: '', ctxOpen: true,
  },
  reportBatch: 'all', reportTag: '',
  stats: null, draft: null,
}

/* ══════════════════════════════════════════════════════════════════════
   通用小工具
   ══════════════════════════════════════════════════════════════════════ */

/** 建元素；`text` 一律走 textContent —— 这是本文件唯一允许塞文本的路子。 */
function el(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text != null) n.textContent = String(text)
  return n
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild) }

/** 毫秒 → 本地时间：服务端给时间戳，页面显示的是**看表的人**的时间。 */
function fmtTime(ms) {
  if (ms == null || ms === '' || Number.isNaN(Number(ms))) return '—'
  const d = new Date(Number(ms))
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
/** 缺字段一律"—"：把"服务端没给"和"真的是 0"分开，是这份页面最基本的诚实。 */
function numOrDash(n) { return Number.isFinite(n) ? String(n) : '—' }
function pctOf(count, total) {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0) return '—'
  return `${Math.round((count / total) * 1000) / 10}%`
}
function clamp(n, lo, hi) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo
}
function truncate(s, n) { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t }
function verdictLabel(id) {
  return [...state.taxonomy.verdicts, ...FALLBACK_VERDICTS].find((v) => v.id === id)?.label ?? id ?? '—'
}
/** `/api/stats` 的 `examples[].context` 是**字符串**，`/api/items` 的 `context` 是**数组**。 */
function contextText(ctx) {
  if (Array.isArray(ctx)) return ctx.map((l) => `${l?.name ?? '?'}：${l?.text ?? ''}${l?.isBot ? '（机器人）' : ''}`).join('\n')
  return typeof ctx === 'string' ? ctx : ''
}

/* ══════════════════════════════════════════════════════════════════════
   提示：toast / 全局错误横幅 / 兜底错误条
   ══════════════════════════════════════════════════════════════════════ */

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

/* ══════════════════════════════════════════════════════════════════════
   请求封装：失败**永不抛异常**，一律返回 `{ok:false, error}`，
   好让每个调用点都能"看到错误就什么都不做"，而不是把异常漏进渲染里。
   ══════════════════════════════════════════════════════════════════════ */

async function api(path, { method = 'GET', body = null } = {}) {
  const fail = (msg) => { showError(msg); return { ok: false, error: msg } }
  let res
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (e) { return fail(`连不上本地服务（${method} ${path}）：${e?.message ?? e}`) }
  let data
  try { data = await res.json() } catch { return fail(`${method} ${path} 返回的不是 JSON（HTTP ${res.status}）`) }
  if (!data || typeof data !== 'object') return fail(`${method} ${path} 返回了意外的内容`)
  // ok:false 时把服务端的 error 原样亮出来 —— 静默失败是这类工具最糟的坏法
  if (data.ok !== true) showError(data.error ?? `${method} ${path} 失败（HTTP ${res.status}，服务端没给 error）`)
  return data
}

/* ══════════════════════════════════════════════════════════════════════
   顶栏：环境事实（工作区 / 语料库 / 风格文件 / 启动时间）
   ══════════════════════════════════════════════════════════════════════ */

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
  // ★ 语料库读不出来时**说为什么**，绝不显示一个像真的行数
  const c = h.corpus
  if (c && c.ok === true) box.appendChild(el('span', 'hv', `语料库 ${numOrDash(c.rows)} 行`))
  else box.appendChild(el('span', 'hv bad', `语料库不可用：${c?.why ?? '服务端没说原因'}`))
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

/* ══════════════════════════════════════════════════════════════════════
   税则与漂移
   ══════════════════════════════════════════════════════════════════════ */

async function loadTaxonomy() {
  const data = await api('/api/taxonomy')
  // 税则没了仍然可以判档（三档是契约固定的），但标签只能诚实地说"没有"
  state.taxonomy = data.ok
    ? {
        ok: true,
        verdicts: Array.isArray(data.verdicts) ? data.verdicts : [],
        tags: Array.isArray(data.tags) ? data.tags : [],
        drift: Array.isArray(data.drift) ? data.drift : [],
      }
    : { ok: false, verdicts: [], tags: [], drift: [] }
  const note = $('taxonomy-note')
  note.hidden = state.taxonomy.ok
  note.textContent = state.taxonomy.ok
    ? ''
    : '拿不到标签税则（/api/taxonomy 失败）：判档按钮用的是契约里固定的三档，标签这一块暂时不可用。'
  renderDrift()
  if (state.page === 'score') renderCard()
}

function renderDrift() {
  const box = $('drift-banner')
  if (!box) return
  clear(box)
  const list = state.taxonomy.drift ?? []
  if (!list.length) return (box.hidden = true)
  // ★ 漂移 = 风格文件改过、税则没跟上。**提示但不拦着打分**（真人的判断比规则准）
  box.hidden = false
  box.appendChild(el('strong', '', `⚠️ 标签税则与风格文件对不上（${list.length} 条）：`))
  box.appendChild(el('span', '', '风格文件改过、标签挂的"规则原文"已经找不到了。可以照常打分，但这些标签的规则原文不可信。'))
  const ul = el('ul', 'drift-list')
  for (const d of list) ul.appendChild(el('li', '', `${d?.id ?? '（无 id）'}：${d?.why ?? '（服务端没给原因）'}`))
  box.appendChild(ul)
}

/* ══════════════════════════════════════════════════════════════════════
   页签切换
   ══════════════════════════════════════════════════════════════════════ */

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

/* ══════════════════════════════════════════════════════════════════════
   页签一：导入
   ══════════════════════════════════════════════════════════════════════ */

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

function sourceLabel(src) {
  if (src === 'corpus') return '语料库'
  if (src === 'import') return '粘贴导入'
  return src ? String(src) : '未知'
}

function renderBatches() {
  const tbody = $('batch-rows')
  clear(tbody)
  const list = state.sources.batches
  $('batch-table').hidden = list.length === 0
  $('batch-empty').hidden = list.length > 0
  for (const b of list) {
    const tr = document.createElement('tr')
    tr.appendChild(el('td', 'b-label', b?.label ?? b?.id ?? '（无标签）'))
    tr.appendChild(el('td', '', sourceLabel(b?.source)))
    tr.appendChild(el('td', '', numOrDash(b?.items)))
    tr.appendChild(el('td', '', `${numOrDash(b?.scored)} / ${numOrDash(b?.items)}`))
    tr.appendChild(el('td', '', fmtTime(b?.createdAt)))
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
}

async function pullFromCorpus() {
  const chatKey = $('corpus-chat').value
  if (!chatKey) return toast('先选一个会话', 'err')
  // 输入框被清空时按**契约默认值**走（100 / 1），不能悄悄发一个 limit=1 过去
  const rawLimit = $('pull-limit').value.trim()
  const rawCtx = $('pull-context').value.trim()
  const limit = clamp(rawLimit === '' ? 100 : rawLimit, 1, 500)
  const contextBefore = clamp(rawCtx === '' ? 1 : rawCtx, 0, 3)
  $('pull-limit').value = String(limit) // 越界当场纠正：静默截断会让人以为"拉了 800 条"
  const btn = $('btn-pull')
  btn.disabled = true
  let data
  try {
    data = await api('/api/pull', {
      method: 'POST',
      body: { chatKey, limit, contextBefore, batchLabel: $('pull-label').value.trim() },
    })
  } finally { btn.disabled = false }
  if (!data?.ok) return
  const b = data.batch ?? {}
  toast(`拉取完成：新增 ${numOrDash(data.added)} 条`, 'ok')
  await refreshSources()
  // ★ 这句必须写在 refreshSources **之后**：刷新会重画会话下拉，顺序反了这句话就被冲掉，
  //   表现是"拉完了但页面上什么都没说"（拉了多少条、跳过多少条都看不到）。
  $('pull-result').textContent =
    `已建批次「${b.label ?? b.id ?? '（无标签）'}」：新增 ${numOrDash(data.added)} 条，跳过 ${numOrDash(data.skipped)} 条。`
}

async function importPasted() {
  const text = $('import-text').value
  if (!text.trim()) return toast('先把内容粘进文本框', 'err')
  const data = await api('/api/import', {
    method: 'POST',
    body: { format: state.importFormat, text, batchLabel: $('import-label').value.trim() },
  })
  if (!data.ok) return
  const b = data.batch ?? {}
  $('import-result').textContent = `已建批次「${b.label ?? b.id ?? '（无标签）'}」：${numOrDash(b.items ?? data.items?.length)} 条。`
  renderWarnings(data.warnings)
  toast('导入完成', 'ok')
  await refreshSources()
}

/** 跳过的行必须**原样列出来**：它们是"导入少了几条"的唯一解释，不许藏。 */
function renderWarnings(warnings) {
  const box = $('import-warnings')
  clear(box)
  if (!Array.isArray(warnings)) return void box.appendChild(el('li', '', '服务端没有返回 warnings 字段 —— 无法确认有没有跳过的行。'))
  if (!warnings.length) return void box.appendChild(el('li', '', '没有跳过的行（全部解析成功）。'))
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

/* ══════════════════════════════════════════════════════════════════════
   页签二：打分（主战场）
   ══════════════════════════════════════════════════════════════════════ */

function renderScoreBatchSelect() {
  const sel = $('score-batch')
  const keep = state.score.batch
  clear(sel)
  if (!state.sources.batches.length) {
    sel.appendChild(new Option('（还没有批次）', ''))
    return void (state.score.batch = '')
  }
  for (const b of state.sources.batches) {
    const label = `${b?.label ?? b?.id ?? '（无标签）'}（${numOrDash(b?.scored)} / ${numOrDash(b?.items)}）`
    sel.appendChild(new Option(label, String(b?.id ?? '')))
  }
  sel.value = state.sources.batches.some((b) => b?.id === keep) ? keep : String(state.sources.batches[0]?.id ?? '')
  state.score.batch = sel.value
  // 原来选的那一批被删了：队列里还是**上一个批次**的条目，必须一起清掉，否则会出现
  // "下拉显示 A、卡片却是 B 的内容"这种最误导人的状态。
  if (keep && sel.value !== keep) resetQueue()
}

function resetQueue() {
  const s = state.score
  s.queue = []
  s.index = 0
  s.loadedFor = ''
  s.scored = null
  s.total = null
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
  s.batch = String(batch ?? '')
  s.filter = filter
  s.offset = 0
  s.exhausted = false
  s.fetching = false
  s.fetchError = ''
  resetQueue()
  s.loadedFor = `${s.batch}|${s.filter}`
  renderProgress()
  renderCard()
  if (!s.batch) return
  await fetchPage()
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

function applyProgress(p) {
  const s = state.score
  if (!p) return
  if (Number.isFinite(p.scored)) s.scored = p.scored
  if (Number.isFinite(p.total)) s.total = p.total
  renderProgress()
}

function renderProgress() {
  const s = state.score
  const known = Number.isFinite(s.scored) && Number.isFinite(s.total) && s.total >= 0
  $('progress-text').textContent = known ? `已评 ${s.scored} / 共 ${s.total}` : '已评 — / 共 —（还没拿到进度）'
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

function currentItem() { return state.score.queue[state.score.index] ?? null }

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
            ? '这个批次的「未评」已经清空了 🎉\n想看评过的就切到「已评」/「全部」，或者去「③ 报告」页出修订草稿。'
            : s.exhausted ? '这个过滤下没有条目。' : '正在准备…'
    return
  }
  card.hidden = false
  empty.hidden = true
  renderContext(item)
  $('reply').textContent = String(item.reply ?? '')
  renderItemMeta(item)
  renderVerdicts(item)
  renderTags(item)
  renderNote(item)
  maybePrefetch()
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
}

/** 每张卡的编辑态：判档前的标签/备注先攒在这里，判档时一起落盘。 */
function ensureDraft(item) {
  if (!item._draft) {
    item._draft = {
      verdict: item.score?.verdict ?? null,
      tags: Array.isArray(item.score?.tags) ? [...item.score.tags] : [],
      note: typeof item.score?.note === 'string' ? item.score.note : '',
    }
  }
  return item._draft
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

function renderTags(item) {
  const bad = $('tags-bad')
  const good = $('tags-good')
  clear(bad)
  clear(good)
  const tags = state.taxonomy.tags
  const d = ensureDraft(item)
  const keyOf = new Map()
  tags.forEach((t, i) => { if (i < TAG_KEYS.length) keyOf.set(t.id, TAG_KEYS[i]) })
  $('tag-note').textContent = tags.length
    ? '点一下切换选中（多选）；数字键 4–9 / 0 对应**前七个**标签；鼠标悬停看这个标签的判据。'
    : '这一轮没有可用标签（税则没取到或确实是空的）。'
  for (const t of tags) {
    const b = el('button', `tag${d.tags.includes(t.id) ? ' active' : ''}`)
    const k = keyOf.get(t.id)
    if (k) b.appendChild(el('span', 'tk', k))
    b.appendChild(el('span', 'tl', t.label ?? t.id))
    b.title = [t.hint, t.ruleQuote ? `规则原文：${t.ruleQuote}` : ''].filter(Boolean).join('\n')
    b.onclick = () => void toggleTag(t.id)
    ;(t.kind === 'good' ? good : bad).appendChild(b)
  }
}

function renderNote(item) {
  const box = $('note')
  const d = ensureDraft(item)
  const sig = `${item.id}|${d.note}`
  // 只在"换了一条"或"备注被程序改过"时回写：正在打字时被 prefetch 触发的重画不该清空输入
  if (box.dataset.sig === sig) return
  box.value = d.note
  box.dataset.sig = sig
}

/** 落盘一条评分；返回值给调用方决定"要不要把这条放回来"。 */
async function postScore(item, snapshot) {
  const data = await api('/api/score', {
    method: 'POST',
    body: { id: item.id, verdict: snapshot.verdict, tags: [...snapshot.tags], note: snapshot.note },
  })
  if (data.ok) {
    item.score = data.score ?? { verdict: snapshot.verdict, tags: [...snapshot.tags], note: snapshot.note }
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

async function applyVerdict(verdict) {
  const s = state.score
  const at = s.index
  const item = s.queue[at]
  if (!item || !verdict) return
  const d = ensureDraft(item)
  const prev = { verdict: d.verdict, tags: [...d.tags], note: d.note, score: item.score ?? null }
  d.verdict = verdict
  const snapshot = { verdict, tags: [...d.tags], note: d.note }
  // ★ 乐观推进：先换卡，不等网络。人评几百条时，"每点一次等一个往返"就是全部的时间浪费。
  item.score = { verdict, tags: [...snapshot.tags], note: snapshot.note, at: Date.now() }
  consumeCurrent()
  renderCard()
  const res = await postScore(item, snapshot)
  if (res.ok) return
  // ★ 失败必须把这张**放回原位**：否则人会以为已经评过了，而它其实一条都没落盘。
  d.verdict = prev.verdict
  d.tags = prev.tags
  d.note = prev.note
  item.score = prev.score
  restoreCurrent(item, at)
  renderCard()
  toast(`这一条没存上（${res.error ?? '未知原因'}），已经放回来了`, 'err')
}

async function toggleTag(tagId) {
  const item = currentItem()
  if (!item) return
  const d = ensureDraft(item)
  const at = d.tags.indexOf(tagId)
  if (at >= 0) d.tags.splice(at, 1)
  else d.tags.push(tagId)
  renderTags(item)
  // 契约里 `POST /api/score` 必须带 verdict —— 还没判档就先攒着，判档时一起落盘
  // （**不替用户编一个 verdict**）
  if (!d.verdict) return toast('这条还没判档：标签先记着，判档时一起落盘')
  const res = await postScore(item, { verdict: d.verdict, tags: [...d.tags], note: d.note })
  if (res.ok) return
  // 存不上就把选中态改回去：页面不显示"其实没存上"的状态
  const back = d.tags.indexOf(tagId)
  if (back >= 0) d.tags.splice(back, 1)
  else d.tags.push(tagId)
  renderTags(item)
  toast(`标签没存上（${res.error ?? '未知原因'}），已经改回去了`, 'err')
}

async function saveNote() {
  const item = currentItem()
  if (!item) return
  const d = ensureDraft(item)
  const value = $('note').value
  if (value === d.note) return
  d.note = value
  if (!d.verdict) return toast('备注先记着，判档时一起落盘') // 同 toggleTag：不替用户编 verdict
  const res = await postScore(item, { verdict: d.verdict, tags: [...d.tags], note: d.note })
  if (!res.ok) toast(`备注没存上（${res.error ?? '未知原因'}）`, 'err')
}

function moveNext() {
  const s = state.score
  if (!s.queue.length) return
  if (s.index + 1 < s.queue.length) {
    s.index += 1
    return renderCard()
  }
  if (!s.exhausted) {
    void fetchPage().then(() => {
      if (s.index + 1 < s.queue.length) s.index += 1
      else toast('后面没有更多了')
      renderCard()
    })
    return
  }
  toast('这个过滤下已经看到最后一条了')
}

/** 跳过 = **只在本地跳过，一个字都不写**（服务端根本不知道这件事）。 */
function skipCurrent() {
  const s = state.score
  const item = currentItem()
  if (!item) return
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

/* ══════════════════════════════════════════════════════════════════════
   页签三：报告
   ══════════════════════════════════════════════════════════════════════ */

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
  await loadStats()
}

async function loadStats() {
  const box = $('stats-body')
  clear(box)
  const data = await api(`/api/stats?batch=${encodeURIComponent(state.reportBatch || 'all')}`)
  if (!data.ok) return void box.appendChild(el('div', 'empty', `拉不到统计：${data.error ?? '未知原因'}`))
  state.stats = data
  renderStats(data)
}

function renderStats(data) {
  const box = $('stats-body')
  const counts = data.verdicts && typeof data.verdicts === 'object' ? data.verdicts : null
  if (!counts) return void box.appendChild(el('div', 'empty', '服务端没给 verdicts 字段 —— 这里不显示任何数字（不猜）。'))
  const ids = ['good', 'ok', 'bad']
  const vals = ids.map((id) => (Number.isFinite(counts[id]) ? counts[id] : 0))
  const sum = vals.reduce((a, v) => a + v, 0)
  const rate = data.rate ?? {}
  const scored = Number.isFinite(rate.scored) ? rate.scored : sum
  const totalAll = Number.isFinite(rate.total) ? rate.total : null
  // 分布条：宽度按**已评条数**算；一条都没评时直接说明，不画空条
  const dist = el('div', 'dist')
  if (sum > 0) {
    for (const [i, id] of ids.entries()) {
      if (!vals[i]) continue
      const seg = el('div', `dist-seg dist-${id}`, `${verdictLabel(id)} ${pctOf(vals[i], sum)}`)
      seg.style.width = `${(vals[i] / sum) * 100}%`
      seg.title = `${verdictLabel(id)}：${vals[i]} 条`
      dist.appendChild(seg)
    }
  }
  box.appendChild(dist)
  const legend = el('div', 'dist-legend')
  for (const [i, id] of ids.entries()) {
    const one = el('span')
    one.appendChild(el('b', '', String(vals[i])))
    one.appendChild(document.createTextNode(` 条 ${verdictLabel(id)}（${pctOf(vals[i], sum)}）`))
    legend.appendChild(one)
  }
  legend.appendChild(el('span', '', `合计已评 ${numOrDash(scored)}${totalAll == null ? '' : ` / 共 ${totalAll}`}`))
  box.appendChild(legend)
  if (sum === 0) box.appendChild(el('div', 'note', '还没有评分 —— 去「② 打分」页评几条，这里的分布才有意义。'))
  // 分会话：一眼看出"哪个人群里最容易说错话"
  const chats = Array.isArray(data.chats) ? data.chats : []
  box.appendChild(el('h3', 'sug-head', '按会话看'))
  if (!chats.length) {
    box.appendChild(el('div', 'note', '服务端没给 chats（或还没评过任何一条）。'))
  } else {
    const table = el('table', 'table')
    const hr = document.createElement('tr')
    for (const t of ['会话', '已评', '不该这么说', '不该这么说占比']) hr.appendChild(el('th', '', t))
    const thead = document.createElement('thead')
    thead.appendChild(hr)
    table.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (const c of chats) {
      const tr = document.createElement('tr')
      tr.appendChild(el('td', 'b-label', c?.label ?? c?.chatKey ?? '（无标签）'))
      tr.appendChild(el('td', '', numOrDash(c?.scored)))
      tr.appendChild(el('td', '', numOrDash(c?.bad)))
      tr.appendChild(el('td', '', pctOf(c?.bad, c?.scored)))
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    box.appendChild(table)
  }
  renderTagRank(Array.isArray(data.tags) ? data.tags : [])
}

function renderTagRank(tags) {
  const box = $('stats-body')
  box.appendChild(el('h3', 'sug-head', `标签命中排行（${tags.length} 个）`))
  if (!tags.length) return void box.appendChild(el('div', 'note', '还没有标签命中 —— 打分时点几个标签，这里就会按次数排出来。'))
  const rank = el('div', 'rank')
  for (const t of tags) {
    const b = el('button', state.reportTag === t?.id ? 'active' : '')
    b.appendChild(el('span', t?.kind === 'good' ? 'rk-good' : 'rk-bad', t?.label ?? t?.id ?? '（无标签）'))
    b.appendChild(el('span', 'rc', `${numOrDash(t?.count)} 次`))
    b.title = t?.ruleQuote ? `规则原文：${t.ruleQuote}` : `标签 id：${t?.id ?? '（无）'}`
    b.onclick = () => {
      state.reportTag = state.reportTag === t?.id ? '' : String(t?.id ?? '')
      for (const other of rank.children) other.classList.remove('active')
      if (state.reportTag) b.classList.add('active')
      renderTagEvidence(state.reportTag ? t : null)
    }
    rank.appendChild(b)
  }
  box.appendChild(rank)
  const ev = el('div', 'evidence-box')
  ev.id = 'tag-examples'
  box.appendChild(ev)
  // 重画排行后把之前选中的证据也放回来，不让人以为"点了没反应"
  renderTagEvidence(tags.find((t) => t?.id === state.reportTag) ?? null)
}

/** 点标签看证据：把**真实原话**原样列出来 —— 这是报告页存在的理由。 */
function renderTagEvidence(tag) {
  const box = $('tag-examples')
  if (!box) return
  clear(box)
  if (!tag) return void (box.hidden = true)
  box.hidden = false
  box.appendChild(el('div', 'evidence-title', `「${tag.label ?? tag.id}」的证据：命中 ${numOrDash(tag.count)} 次，下面是最多 3 条真实原话`))
  if (tag.ruleQuote) box.appendChild(el('div', 'sug-quote', `挂的规则原文：${tag.ruleQuote}`))
  const list = Array.isArray(tag.examples) ? tag.examples : []
  if (!list.length) return void box.appendChild(el('div', 'note', '服务端没给这一条的 examples —— 看不到原文就不编。'))
  for (const e of list) {
    const card = el('div', 'evidence')
    const ctx = contextText(e?.context)
    if (ctx) card.appendChild(el('div', 'ev-ctx', ctx))
    card.appendChild(el('div', 'ev-reply', String(e?.reply ?? '（原文为空）')))
    card.appendChild(el('div', 'ev-id', `id ${e?.id ?? '—'}`))
    box.appendChild(card)
  }
}

async function loadDraft() {
  const data = await api(`/api/draft?batch=${encodeURIComponent(state.reportBatch || 'all')}`)
  $('draft-card').hidden = false
  if (!data.ok) {
    state.draft = null
    $('draft-empty').hidden = false
    $('draft-empty').textContent = `生成草稿失败：${data.error ?? '未知原因'}`
    $('btn-apply').disabled = true
    $('apply-why').textContent = '草稿没有生成成功，不能应用。'
    return
  }
  state.draft = data.draft ?? null
  renderDraft()
}

function renderDraft() {
  const d = state.draft
  const has = typeof d?.proposedBlock === 'string' && d.proposedBlock.trim() !== ''
  $('draft-target').textContent = d?.target
    ? `目标文件：${d.target}｜用到证据 ${numOrDash(d?.evidenceCount)} 条`
    : '服务端没给 target —— 应用前请先确认改的是哪个文件。'
  const empty = $('draft-empty')
  empty.hidden = has
  empty.textContent = '还没有足够证据 —— 先去「② 打分」页把「不该这么说」和对应标签评出来，这里才会给出可应用的修订块。'
  const sugBox = $('draft-suggestions')
  clear(sugBox)
  const suggestions = Array.isArray(d?.suggestions) ? d.suggestions : []
  if (suggestions.length) {
    sugBox.appendChild(el('h3', 'sug-head', `建议（${suggestions.length} 条）`))
    for (const s of suggestions) {
      const card = el('div', 'sug')
      card.appendChild(el('div', 'sug-head', `${s?.label ?? s?.tagId ?? '（无标签）'}：被标出 ${numOrDash(s?.count)} 次`))
      card.appendChild(el('div', 'sug-advice', String(s?.advice ?? '（服务端没给建议文本）')))
      if (s?.ruleQuote) card.appendChild(el('div', 'sug-quote', `挂的规则原文：${s.ruleQuote}（${s?.tagId ?? ''}）`))
      sugBox.appendChild(card)
    }
  } else if (has) {
    sugBox.appendChild(el('div', 'note', '服务端没给 suggestions，但给了可应用的草稿块（下面就是）。'))
  }
  renderDiff($('draft-diff'), typeof d?.diff === 'string' ? d.diff : '')
  $('btn-apply').disabled = !has
  $('apply-why').textContent = has
    ? '点下去会先弹确认框，说明会先备份哪个文件、再追加什么。'
    : '没有草稿内容（proposedBlock 是空的），这个按钮不能点：没有证据就不该改风格文件。'
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

async function applyDraft() {
  const d = state.draft
  if (!d?.proposedBlock) return toast('没有草稿内容，不能应用', 'err')
  const target = d.target ?? 'styles/闲聊.md'
  const ok = window.confirm(
    // ⚠️ `window.confirm` 是**纯文本**，别在这里写 Markdown（星号会原样显示出来）
    `确认把这份草稿写进 ${target} 吗？\n\n· 会【先备份】到 ${target} 同目录下的 .backups/ 里（带时间戳的 .bak）；\n` +
      '· 然后把草稿块【追加到文件末尾】，原有内容一个字都不改；\n' +
      '· 同一份草稿不能应用两次（第二次会被拒绝，报 409）。\n\n' +
      `这次用到证据 ${numOrDash(d.evidenceCount)} 条。`,
  )
  if (!ok) return
  $('btn-apply').disabled = true
  const res = await api('/api/apply', { method: 'POST', body: { confirm: true } })
  if (!res.ok) return void ($('btn-apply').disabled = false)
  $('apply-result').textContent =
    `已应用：备份 ${res.backup ?? '（未返回）'}｜新 sha256 ${res.sha256 ?? '（未返回）'}｜` +
    `文件现在 ${numOrDash(res.chars)} 字（本次追加 ${numOrDash(res.appended)} 字）`
  toast('已应用到风格文件（备份已生成）', 'ok')
  await loadHealth() // 顶栏的字数/指纹必须跟着变，否则人会以为没写进去
  $('btn-apply').disabled = true
  $('apply-why').textContent = '这份草稿已经应用过了；再点一次会被服务端拒绝（409）。'
}

/* ══════════════════════════════════════════════════════════════════════
   事件绑定：**逐个 try/catch** —— 一个绑不上不影响其余的
   （"页面画得出来但每个按钮都没反应"就是这么来的）
   ══════════════════════════════════════════════════════════════════════ */

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
    if (state.page === 'score') renderCard()
    if (state.page === 'report') await loadStats()
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
  bind('note', 'onblur', () => void saveNote())
  // 报告页
  bind('report-batch', 'change', (e) => {
    state.reportBatch = e.target.value || 'all'
    state.reportTag = ''
    void loadStats()
  })
  bind('btn-draft', 'onclick', () => void loadDraft())
  bind('btn-apply', 'onclick', () => void applyDraft())
}

/* ── 键盘：打分页不该用鼠标 ────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
  const tagName = (e.target?.tagName ?? '').toLowerCase()
  // 在输入框里打字时，数字键/回车都是"文字"，不是快捷键
  if (tagName === 'input' || tagName === 'select' || tagName === 'textarea') return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (e.key === 'Escape') return void ($('error-banner').hidden = true)
  if (state.page !== 'score') return
  if (e.key === '1' || e.key === '2' || e.key === '3') {
    e.preventDefault()
    const list = state.taxonomy.verdicts.length ? state.taxonomy.verdicts : FALLBACK_VERDICTS
    // 税则里 `key` 与数字键对得上就用它；对不上就按契约固定的三档（1/2/3）
    void applyVerdict(list.find((x) => String(x.key) === e.key)?.id ?? { 1: 'good', 2: 'ok', 3: 'bad' }[e.key])
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    return moveNext()
  }
  if (e.key === 'u' || e.key === 'U') {
    e.preventDefault()
    return void undoLast()
  }
  if (e.key === 's' || e.key === 'S') {
    e.preventDefault()
    return skipCurrent()
  }
  const at = TAG_KEYS.indexOf(e.key)
  if (at >= 0 && state.taxonomy.tags[at]) {
    e.preventDefault()
    void toggleTag(state.taxonomy.tags[at].id)
  }
})

/* ══════════════════════════════════════════════════════════════════════
   启动
   ══════════════════════════════════════════════════════════════════════ */

async function boot() {
  bindEvents()
  await Promise.all([loadHealth(), loadTaxonomy()])
  await switchTab('import') // 打开页面先落在导入页：第一次用它的人要从这里开始
}

boot().catch((e) => {
  showPageError('首次加载失败', e)
  toast(`加载失败：${e?.message ?? e}`, 'err')
})
