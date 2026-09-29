/**
 * 表情包人工标注台 —— 前端（零依赖，纯 DOM）。
 *
 * ── 两个页签，两种活 ────────────────────────────────────────────────────
 * ① **逐张标注**：一张张过，点一下即写回，贴完自动跳下一张。
 *    三个刻意的交互决定：**没有"保存"按钮**（标注是连续的小动作，攒着容易丢、
 *    还让人不敢点）、**贴完自动跳下一张**（主要开销是"看下一张"）、
 *    **只显示图与标签按钮**（要判断的是"这张图在表达什么"，不是它的元数据）。
 *
 * ② **按标签看图**（用户后来加的要求）：左边是标签清单（**实时张数**），
 *    点一个就出这标签下的**图墙**。它回答的是一个逐张页答不了的问题 ——
 *    "这个标签是不是都打对了、有没有图明显不属于这里"。
 *    图层里点任意一张可以**当场改成别的标签**（复核时不用切回逐张页），
 *    同一页还能**现场新建 / 改名 / 删标签**（改完下一轮对话就生效）。
 *
 * ── ★★ 一条血泪纪律：图墙只能用**静态缩略图** ────────────────────────────
 * 第一版图墙直接拿**原图**当 `<img src>`。实测点开 `moved`：54 张**动图**、
 * 合计 **159MB** —— 浏览器把 54 个动画全部解码并同时播放，标签页直接**卡死**
 * （不是"慢"，是连浮层的关闭按钮都点不动了）。
 *
 * 现在靠三层解决，**都不依赖"把图藏起来"这种会留下持久状态的技巧**：
 *   ① 图墙用后端 `/thumb/<rel>` —— 服务端从 GIF **最后一帧**合成出一张**静态 PNG**
 *      （实测 85x 小），所以图墙里压根没有动画可播；
 *   ② 一次最多画 `MAX_CELLS` 张，其余点"显示更多"；
 *   ③ `<img loading="lazy">`。
 * 原图只在**浮层**里单张加载（点开才取），并且超过 3MB 的不自动加载。
 *
 * ⚠️ 曾经还有第 ④ 层"滚动时冻结动图"（给网格加 `.paused`、CSS 把 `<img>` 设成
 * `visibility: hidden`）—— **已删除**：缩略图变成静态 PNG 之后它没有意义，
 * 而它一旦残留就让**所有图都不显示**（看着像"缩略图坏了"，实测用户报的正是这个）。
 *
 * ── 一条纪律 ────────────────────────────────────────────────────────────
 * 标签的中文名、轴、张数**全部由后端给**（`/api/list`、`/api/labels`），
 * 前端一个都不硬编码 —— 用户在标注台新建的标签必须立刻出现在这里。
 */

const $ = (id) => document.getElementById(id)

/** 图墙一次最多画多少张（剩下点"显示更多"）。防的是"一个标签几百张"把页面拖垮。 */
const MAX_CELLS = 60

const state = {
  // 页签一：逐张
  rows: [],
  labels: [],
  counts: {},
  unknownCounts: {},
  minUsable: 3,
  filtered: [],
  idx: 0,
  onlyTodo: true,
  onlyManual: false,
  onlyLow: false,
  onlyDisputed: false,
  seeAll: false,
  busy: false,
  // 页签二：按标签看图
  page: 'pass',
  axes: [],
  browse: { label: '', rows: [], manualOnly: false, shown: MAX_CELLS },
  labelQuery: '',
  editing: null, // 正在编辑的标签 id（null = 新建）
  overlayRow: null,
  overlayHintTimer: null,
  // 加载本页面时服务端的版本号（用来发现"服务端重启了、页面还是旧的"，见 startStalePageWatch）
  serverBuildId: '',
}

/** 常用标签（数字键 1-9）—— 先按库里实际张数排，没有的补上最常见的几个。 */
const PREFERRED = ['laugh', 'deadpan', 'confused', 'agree', 'moved', 'tired', 'comfort', 'shock', 'sad']

function quickIds() {
  const byCount = [...state.labels]
    .map((l) => ({ id: l.id, n: state.counts[l.id] ?? 0 }))
    .sort((a, b) => b.n - a.n)
    .map((x) => x.id)
  const out = []
  for (const id of PREFERRED) if (out.length < 9) out.push(id)
  for (const id of byCount) if (out.length < 9 && !out.includes(id)) out.push(id)
  return out.slice(0, 9)
}

function labelMeta(id) {
  return state.labels.find((l) => l.id === id) ?? { id, name: id, axis: '已删标签', cues: [] }
}

/* ══════════════════════════════════════════════════════════════════════
   页签一：逐张标注
   ══════════════════════════════════════════════════════════════════════ */

function applyFilter() {
  state.filtered = state.rows.filter((r) => {
    // ★ "只看冲突"优先（用户要的是"复核最可能是识图错的那批"，而不是全库过一遍）
    if (state.onlyDisputed) return r.disputed && !r.manual
    // ★ "看全部"：逐张复核时用（默认的待办里没有"已经有标签但标签是错的"那些）
    if (state.seeAll) {
      if (state.onlyManual && !r.manual) return false
      if (state.onlyLow && !r.lowConfidence) return false
      return true
    }
    if (state.onlyManual && !r.manual) return false
    if (state.onlyLow && !r.lowConfidence) return false
    // "待办" = 没标签 / 模型不太确定（低置信度）。已经打得挺确定的默认不打扰。
    if (state.onlyTodo && r.primary && !r.lowConfidence) return false
    return true
  })
  if (state.idx >= state.filtered.length) state.idx = Math.max(0, state.filtered.length - 1)
}

function renderPass() {
  applyFilter()
  const total = state.rows.length
  const untagged = state.rows.filter((r) => !r.primary).length
  const manual = state.rows.filter((r) => r.manual).length
  const low = state.rows.filter((r) => r.lowConfidence).length
  const disputed = state.rows.filter((r) => r.disputed && !r.manual).length
  $('stats').textContent =
    `库里 ${total} 张｜没标签 ${untagged}｜低置信度 ${low}｜**识图与文件名冲突** ${disputed}｜我标过 ${manual}｜当前筛选 ${state.filtered.length} 张`
  renderQuick()
  renderAll()

  const row = state.filtered[state.idx]
  const img = $('img')
  const missing = $('missing')
  if (!row) {
    img.removeAttribute('src')
    img.style.display = 'none'
    missing.hidden = false
    missing.textContent = state.rows.length === 0 ? '库里还没有图（先导入）' : '没有符合当前筛选的条目'
    $('meta-name').textContent = '—'
    $('meta-sub').textContent = ''
    $('pos').textContent = `0 / ${state.filtered.length}`
    return
  }
  img.style.display = ''
  img.src = row.url
  img.alt = row.name
  missing.hidden = row.exists
  $('meta-name').textContent = `${row.name}`
  const bits = [
    `id ${row.shortId}`,
    row.sizeMB ? `${row.sizeMB}MB` : '',
    row.primary ? `当前：${row.primaryName}（${row.primary}）` : '当前：没标签',
    row.confidence != null ? `置信度 ${row.confidence}` : '',
    row.manual ? '★ 人工标注' : row.source ? `来源 ${row.source}` : '',
    row.originHint ? `文件名先验：${labelMeta(row.originHint).name}` : '',
    row.disputed ? '⚠️ 两者不一致（看图的结论与文件名先验冲突，多半是识图错）' : '',
  ].filter(Boolean)
  $('meta-sub').textContent = bits.join('　·　')
  $('pos').textContent = `${state.idx + 1} / ${state.filtered.length}`
  document.title = `标注 ${state.idx + 1}/${state.filtered.length} · ${row.name}`
}

function renderQuick() {
  const wrap = $('quick')
  wrap.innerHTML = ''
  const row = state.filtered[state.idx]
  for (const [i, id] of quickIds().entries()) {
    const meta = labelMeta(id)
    const b = document.createElement('button')
    b.innerHTML = `<span class="k">${i + 1}</span>${meta.name}`
    if (row?.primary === id) b.className = 'active'
    b.onclick = () => save(id)
    wrap.appendChild(b)
  }
}

function renderAll() {
  const wrap = $('all')
  wrap.innerHTML = ''
  const row = state.filtered[state.idx]
  const byAxis = new Map()
  for (const l of state.labels) {
    if (!byAxis.has(l.axis)) byAxis.set(l.axis, [])
    byAxis.get(l.axis).push(l)
  }
  for (const [axis, list] of byAxis) {
    const h = document.createElement('div')
    h.className = 'group'
    h.textContent = axis
    wrap.appendChild(h)
    for (const l of list) {
      const n = state.counts[l.id] ?? 0
      const b = document.createElement('button')
      const cls = []
      if (row?.primary === l.id) cls.push('active')
      // 库里的张数低于可用线（3 张）时标记一下：这个标签选了也可能"没图可发"
      if (n < state.minUsable) cls.push('thin')
      b.className = cls.join(' ')
      b.title = `${l.id}${l.cues?.length ? `｜典型语境：${l.cues.join('、')}` : ''}`
      b.innerHTML = `<span><span class="cn">${l.name}</span> <span class="id">${l.id}</span></span><span class="n">${n}</span>`
      b.onclick = () => save(l.id)
      wrap.appendChild(b)
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════
   页签二：按标签看图
   ══════════════════════════════════════════════════════════════════════ */

function renderBrowse() {
  renderLabelList()
  renderBoard()
}

function renderLabelList() {
  const wrap = $('label-list')
  wrap.innerHTML = ''
  const q = state.labelQuery.trim().toLowerCase()
  const hit = (l) => !q || l.id.toLowerCase().includes(q) || l.name.toLowerCase().includes(q)

  /** 一行：标签（名字 + id + 张数）。 */
  const item = (id, name, axis, extra = {}) => {
    const n = extra.count ?? 0
    const b = document.createElement('button')
    const cls = ['ll-item']
    if (n === 0) cls.push('zero')
    else if (n < state.minUsable) cls.push('thin')
    if (state.browse.label === id) cls.push('active')
    if (extra.orphan) cls.push('orphan')
    b.className = cls.join(' ')
    b.innerHTML =
      `<span class="cn">${name}</span><span class="id">${id}</span>` +
      (extra.risk ? '<span class="rk">慎发</span>' : '') +
      `<span class="n">${n}</span>`
    b.title = axis ? `轴：${axis}` : ''
    b.onclick = () => {
      state.browse.label = id
      state.browse.manualOnly = false
      state.browse.shown = MAX_CELLS // 换标签时回到第一屏
      $('grid-manual-only').checked = false
      hideLabelForm()
      loadBrowse()
    }
    wrap.appendChild(b)
  }

  // "未打标签"永远在最前（那是要干的活），然后是各轴。
  item('', '未打标签（待办）', '待办', { count: state.rows.filter((r) => !r.primary).length })

  const byAxis = new Map()
  for (const l of state.labels) {
    if (!hit(l)) continue
    if (!byAxis.has(l.axis)) byAxis.set(l.axis, [])
    byAxis.get(l.axis).push(l)
  }
  for (const [axis, list] of byAxis) {
    const h = document.createElement('div')
    h.className = 'll-axis'
    h.textContent = axis
    wrap.appendChild(h)
    for (const l of list) item(l.id, l.name, l.axis, { count: state.counts[l.id] ?? 0, risk: l.risk })
  }
  // ★ 库里引用了、但词表里已经没有的标签（用户删过标签）—— 必须显示出来，
  //   否则那些图会变成"谁也看不见"的孤儿（只能靠翻 library.json 才发现）。
  const orphans = Object.entries(state.unknownCounts ?? {})
  if (orphans.length) {
    const h = document.createElement('div')
    h.className = 'll-axis'
    h.textContent = '⚠️ 引用已删标签（要重新贴一个）'
    wrap.appendChild(h)
    for (const [id, n] of orphans) item(id, `(已删) ${id}`, '', { count: n, orphan: true })
  }
}

function renderBoard() {
  const b = state.browse
  const label = b.label
  const meta = label ? labelMeta(label) : null
  $('board-title').textContent = label ? `${meta.name}（${label}）` : '未打标签（待办）'
  $('board-count').textContent = `共 ${b.rows.length} 张`
  $('btn-edit-label').disabled = !label

  // 说明行：把"这个标签什么时候会被选中"讲清楚（复核时最需要知道的就是这个）
  const desc = []
  if (meta && label) {
    desc.push(`轴：<code>${meta.axis}</code>`)
    if (meta.cues?.length) desc.push(`典型语境：<code>${meta.cues.join('、')}</code>`)
    if (!label) desc.push('')
    desc.push(
      meta.auto
        ? '✓ 可被**自主补图**（正文像它时系统会自己挑一张）'
        : '✗ 只认模型主动写的 `[sticker:标签]`（功能类，系统不自主挑）',
    )
    if (meta.risk) desc.push('⚠️ **慎发**：默认不进候选，要发得开 `skills.sticker.allowRisky`')
    if (state.counts[label] != null && state.counts[label] < state.minUsable) {
      desc.push(`⚠️ 只有 ${state.counts[label]} 张（低于 ${state.minUsable} 张不会出现在提示词里）`)
    }
  } else {
    desc.push('这些图还没有标签，**不会被选中**。点一张图就能当场贴标签。')
  }
  $('board-desc').innerHTML = desc.join('　·　').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  const grid = $('grid')
  grid.innerHTML = ''
  const rows = b.manualOnly ? b.rows.filter((r) => r.manual) : b.rows
  $('grid-empty').hidden = rows.length > 0
  $('grid-empty').textContent = b.manualOnly
    ? '这个标签下没有人工标过的'
    : label
      ? '这个标签下还没有图 —— 换一个标签，或去「逐张标注」里给它贴几张'
      : '没有待打的图了 🎉'
  // ★ 一次最多画 MAX_CELLS 张（剩下的点"显示更多"）——
  //   防的是"某个标签下几百张"把页面拖垮（实测 54 张动图就够卡死一次了）
  const shown = rows.slice(0, b.shown)
  for (const row of shown) {
    const cell = document.createElement('div')
    const cls = ['cell']
    if (row.manual) cls.push('manual')
    if (row.risk) cls.push('risk')
    if (!row.exists) cls.push('gone')
    cell.className = cls.join(' ')
    cell.title = `${row.name}（点开看大图、改标签）`
    const img = document.createElement('img')
    // ★★ 用**缩略图**，不是原图 —— 见文件头那段"血泪纪律"
    img.src = row.thumb ?? row.url
    img.alt = row.name
    img.loading = 'lazy' // 显式声明：网格里几十张图不该一次全下
    img.decoding = 'async'
    const cap = document.createElement('div')
    cap.className = 'cap'
    cap.textContent = `${row.manual ? '★ ' : ''}${row.name}`
    cell.appendChild(img)
    cell.appendChild(cap)
    cell.onclick = () => openOverlay(row)
    grid.appendChild(cell)
  }
  const foot = $('grid-foot')
  const more = rows.length - shown.length
  foot.hidden = more <= 0
  if (more > 0) {
    $('grid-note').textContent = `还有 ${more} 张没画出来（一次最多 ${MAX_CELLS} 张，避免动图同时播放把页面卡住）`
  }
  // ★ 这里**不再**调 `freezeGifsDuringScroll()` —— 那套"冻结动图"的机制已删，理由见下。
}

/* ── 已删除：`freezeGifsDuringScroll()`（冻结动图）───────────────────────
 *
 * 它曾经是**必需**的：图墙第一版直接拿**原图**当缩略图，一个标签下几十张动图
 * 会同时解码播放，吃满一个核（实测 54 张 / 159MB 让标签页卡到关不掉）。
 * 那套机制的做法是：滚动/加载时给网格加 `.paused`，CSS 里把 `<img>` 设成
 * `visibility: hidden`（藏起来 = 不播放），停 400ms 再放开。
 *
 * ★★ 现在**必须拆掉**，两个理由：
 *  ① **它已经解决不了问题**：图墙现在用的是服务端合成的**静态 PNG**缩略图
 *     （`/thumb/…`，从 GIF 最后一帧合成，实测 85x 小），压根没有动画可播。
 *     原图只在**浮层里单张**加载，也不可能几十张同时播。
 *  ② **它自己成了 bug**：`visibility: hidden` 是"藏起来"，一旦 `.paused`
 *     因为任何原因留在了元素上（定时器被反复重置、标签页被节流……），
 *     结果就是**图全都不显示**，而格子、文件名、按钮都好好的 ——
 *     看起来完全像"缩略图坏了"。实测用户报的正是这个现象。
 *
 * ∴ 删掉。图墙的负载问题现在由三层解决：① 服务端静态缩略图；
 *   ② 一次最多画 `MAX_CELLS` 格；③ `<img loading="lazy">`。
 *   这三层都不依赖"把图藏起来"这种会留下持久状态的技巧。
 */

/* ── 浮层：看大图 + 当场改标签 ─────────────────────────────────────── */

/**
 * 原图**超过这个体积就不自动加载**（改成点一下才放）。
 *
 * ★★ 为什么需要（这是修完图墙之后**剩下唯一没被限制的地方**）：
 * 图墙已经用小图了，但浮层点开拉的还是**原图** —— 实测库里最大的一张是
 * **8.6MB 的动图**，浏览器要解码**全部帧**再铺满全屏，点一下就能把页面冻住。
 * 所以：先显示缩略图（立刻可见、布局稳定），大文件由人**明确点一下**再加载。
 * 小文件（大多数）照旧自动加载，不给人添麻烦。
 */
const OVERLAY_AUTOLOAD_MB = 3

function openOverlay(row) {
  if (!row) return
  state.overlayRow = row
  $('ov').hidden = false
  const thumb = $('ov-thumb')
  const full = $('ov-img')
  const hint = $('ov-hint')
  // ① 先上缩略图：立刻看得见，布局也立刻稳定（不会有一段"一片空白"的空窗）
  thumb.onload = () => {
    if (hint.dataset.mode === 'loading') hint.hidden = true
  }
  thumb.onerror = () => {
    // ★ 缩略图都取不到时必须**说出来**，否则就是"一个空白大框 + 界面像死了"
    //   （这正是用户报的那个现象，而我当时没有任何线索）
    hint.hidden = false
    hint.dataset.mode = 'error'
    hint.textContent = `⚠️ 这张图取不到（${row.name}）—— 关掉浮层后重载页面试试；若一直如此，跑 node sticker-label/doctor.mjs`
    hint.onclick = null
  }
  hint.dataset.mode = 'loading'
  hint.hidden = true // 先不显示，只有卡住/出错才出来（正常加载不该有闪烁的提示）
  thumb.src = row.thumb ?? row.url
  thumb.alt = row.name
  // ★ 缩略图**秒回**才有意义；超过 1.5 秒还没出来就说明有问题，把状态显示出来
  //   （否则用户面对的就是一个没有任何反馈的空白框 —— 那种"像卡死"的观感本身就是 bug）
  if (state.overlayHintTimer) clearTimeout(state.overlayHintTimer)
  state.overlayHintTimer = setTimeout(() => {
    if (hint.dataset.mode === 'loading' && !$('ov').hidden) {
      hint.hidden = false
      hint.textContent = '正在取这张图的预览…（迟迟不出来就说明有问题，可以直接关掉重载）'
      hint.onclick = null
    }
  }, 1500)
  // ② 原图按体积决定要不要自动加载
  full.hidden = true
  full.removeAttribute('src')
  const heavy = (row.sizeMB ?? 0) > OVERLAY_AUTOLOAD_MB
  if (heavy) {
    hint.hidden = false
    hint.dataset.mode = 'heavy'
    hint.textContent = `这张有 ${row.sizeMB}MB（动图要解码全部帧，可能卡顿）—— 点这里加载原图`
    hint.onclick = () => {
      hint.hidden = true
      hint.dataset.mode = 'loading'
      loadOverlayFull(row)
    }
  } else {
    hint.hidden = true
    loadOverlayFull(row)
  }
  $('ov-name').textContent = row.name
  const bits = [
    `id ${row.shortId}`,
    row.sizeMB ? `${row.sizeMB}MB` : '',
    row.primary ? `当前：${row.primaryName}（${row.primary}）` : '当前：没标签',
    row.confidence != null ? `置信度 ${row.confidence}` : '',
    row.manual ? '★ 人工标注' : row.source ? `来源 ${row.source}` : '',
  ].filter(Boolean)
  $('ov-sub').textContent = bits.join('　·　')

  const wrap = $('ov-labels')
  wrap.innerHTML = ''
  for (const l of state.labels) {
    const btn = document.createElement('button')
    btn.textContent = `${l.name}（${state.counts[l.id] ?? 0}）`
    if (row.primary === l.id) btn.className = 'active'
    btn.onclick = async () => {
      await saveLabel(row, l.id)
      closeOverlay()
    }
    wrap.appendChild(btn)
  }
}

/** 加载浮层里的原图（小图自动走这里；大图等人点了"加载"再走）。 */
function loadOverlayFull(row) {
  const full = $('ov-img')
  if (!full || !row) return
  // 加载失败就把缩略图留着 —— 至少还能看见这张是什么
  full.onerror = () => {
    full.hidden = true
    showPageError('原图加载失败（缩略图仍在）', new Error(String(row.url)))
  }
  full.onload = () => {
    full.hidden = false
  }
  full.removeAttribute('src')
  full.alt = row.name
  full.src = row.url
  // ★ 强制动图**从头开始播**：同一个 src 二次赋值时浏览器会沿用旧的解码状态
  //   （表现是"点开不动"）。用一次 visibility 翻转逼它重新开始。
  forceGifRestart(full)
}

/** 逼动图重新开始播放（见 `loadOverlayFull` 里的说明）。 */
function forceGifRestart(img) {
  try {
    img.style.visibility = 'hidden'
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        img.style.visibility = ''
      })
    })
  } catch {
    img.style.visibility = ''
  }
}

function closeOverlay() {
  $('ov').hidden = true
  if (state.overlayHintTimer) {
    clearTimeout(state.overlayHintTimer)
    state.overlayHintTimer = null
  }
  // 顺手把大图卸掉：一张几 MB 的动图留在 DOM 里会一直占着解码内存
  for (const id of ['ov-img', 'ov-thumb']) {
    const img = $(id)
    if (!img) continue
    img.removeAttribute('src')
    if (id === 'ov-img') img.hidden = true
  }
  const hint = $('ov-hint')
  if (hint) {
    hint.hidden = true
    hint.onclick = null
    hint.dataset.mode = ''
  }
  state.overlayRow = null
}

/**
 * 兜底的"页面卡住"逃生口：**任何键**都能把浮层关掉。
 *
 * ★ 为什么值得这么"粗暴"：用户报的正是"浮层开着、点关闭没反应"。
 *   在**捕获阶段**监听，别的监听器抛错或 stopPropagation 也拦不住它；
 *   而且不限 Esc —— 人被卡住时第一反应是随便按个键。
 *   关掉浮层不会丢数据（贴标签是即写即存的），所以这个逃生口是安全的。
 * ★ 只在浮层开着时才吞键，不影响正常键盘操作。
 */
document.addEventListener(
  'keydown',
  (e) => {
    if ($('ov').hidden) return
    if (e.key === 'Tab') return // 允许在浮层里用 Tab 走按钮（可访问性）
    e.preventDefault()
    e.stopPropagation()
    closeOverlay()
  },
  true, // ← 捕获阶段，优先级最高
)

/* ── 自动分类未标注的图（会调模型，所以看清预检、能停）───────────────── */

let autoTimer = null

/** 拉一次状态并渲染（空闲时显示"会处理 N 张"，跑起来显示进度）。 */
async function refreshAutoTag() {
  try {
    const res = await fetch('/api/retag')
    const d = await res.json()
    if (!d.ok) return
    const el = $('auto-status')
    const btn = $('btn-auto-tag')
    const pre = d.preflight ?? {}
    if (d.phase === 'running') {
      el.className = 'auto-status busy'
      el.textContent = `正在分类… ${d.done}/${d.total}（新打 ${d.tagged}｜重打 ${d.retagged}｜失败 ${d.failed}）` +
        `${d.current ? `\n当前：${String(d.current).split('/').pop()}` : ''}` +
        `${d.lastLabel ? `\n刚打上：${d.lastLabel}` : ''}`
      btn.textContent = '■ 停止'
      btn.disabled = false
      btn.dataset.mode = 'running'
      return
    }
    btn.dataset.mode = 'idle'
    btn.textContent = '✨ 自动分类未标注的图'
    btn.disabled = false
    if (d.phase === 'done' || d.phase === 'aborted') {
      el.className = 'auto-status'
      el.textContent = `${d.phase === 'aborted' ? '已停止' : '分类完成'}：新打 ${d.tagged}｜重打 ${d.retagged}｜失败 ${d.failed}` +
        (d.failedList?.length ? `\n失败的（前几条）：${d.failedList.slice(0, 3).map((f) => String(f.rel).split('/').pop()).join('、')}` : '')
      return
    }
    el.className = 'auto-status'
    const n = pre.todo ?? 0
    el.textContent = n > 0
      ? `有 ${n} 张未标注的图可以自动分类（每张一次模型调用）。已标过的一张都不会动。`
      : '没有未标注的图了 —— 库里每张都有标签。'
    btn.disabled = n === 0
  } catch (e) {
    $('auto-status').className = 'auto-status err'
    $('auto-status').textContent = `读状态失败：${e}`
  }
}

async function toggleAutoTag() {
  const btn = $('btn-auto-tag')
  const running = btn.dataset.mode === 'running'
  const el = $('auto-status')
  try {
    if (running) {
      const res = await fetch('/api/retag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'abort' }),
      })
      const d = await res.json()
      toast(d.ok ? '已请求停止（当前那张跑完就停）' : d.error ?? '停止失败', d.ok ? 'ok' : 'err')
      return
    }
    const pre = await (await fetch('/api/retag')).json()
    const n = pre.preflight?.todo ?? 0
    if (n <= 0) return
    if (!window.confirm(`要给 ${n} 张**未标注**的图自动分类吗？\n\n· 每张一次模型调用（会花钱）\n· 已标过标签的一张都不会动\n· 跑完自动写回库，下一轮对话生效\n\n开始？`)) return
    const res = await fetch('/api/retag', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    })
    const d = await res.json()
    if (!d.ok) {
      el.className = 'auto-status err'
      el.textContent = d.error ?? '发起失败'
      toast(d.error ?? '发起失败', 'err')
      return
    }
    toast(`开始分类 ${d.total ?? n} 张…`, 'ok')
    startAutoPolling()
  } catch (e) {
    toast(`请求失败：${e}`, 'err')
  }
}

function startAutoPolling() {
  if (autoTimer) clearInterval(autoTimer)
  void refreshAutoTag()
  // 1.5 秒一次：与桥接那边「重新打标签」的轮询节奏一致（长任务不能没有进度）
  autoTimer = setInterval(async () => {
    await refreshAutoTag()
    const st = $('auto-status')
    if ($('btn-auto-tag').dataset.mode !== 'running') {
      clearInterval(autoTimer)
      autoTimer = null
      // 跑完刷新图墙与计数（新标签会改变分布）
      await load()
      if (state.page === 'browse') await loadBrowse()
      void st
    }
  }, 1500)
}

/* ── 进程控制：退出 / 重启（在 UI 里就能关掉这个进程）─────────────────
   ★ 为什么必须放在页面上（用户明确要求）：这是个**独立进程 + 固定端口**的工具，
     端口被占时新进程连启动都失败（EADDRINUSE），而页面上没有任何提示 ——
     只能去任务管理器翻 node.exe（提权启动的连 taskkill 都会被拒）。
     进程自己最清楚自己是谁，所以"关掉自己"由它自己做最可靠。 */

/** 调一次进程控制接口。 */
async function serverControl(action) {
  const res = await fetch('/api/server', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  return res.json()
}

async function quitServer() {
  if (!window.confirm('关闭标注台？\n\n· 本进程会退出、端口会被释放\n· 没保存的东西：贴标签是即写即存的，不会丢\n\n以后要再用，重新双击 启动标注.bat 即可。')) return
  try {
    await serverControl('shutdown')
    // 服务已经退出，这个页面再也连不上了 —— 把手上的入口都停掉，并说清楚
    showFinalNotice('标注台已退出（端口已释放）。这个页面现在连不上服务了 —— 关掉它就行。\n下次要用：重新双击 启动标注.bat。')
  } catch {
    // 进程退出会让请求"连接被重置"，那是**预期**的，不是失败
    showFinalNotice('标注台已退出（端口已释放）。这个页面现在连不上服务了 —— 关掉它就行。')
  }
}

/**
 * 「重启服务」= 让服务端**同进程原地重听**（关监听再绑回来），页面不用重载。
 *
 * ★ 为什么不"拉起新进程再退旧的"（原来就是那样，踩了两次）：
 *   常规用法是双击 `启动标注.bat`，node 在**那个 cmd 窗口里前台跑**；点重启时旧进程
 *   退出 ⇒ 批处理跑完 ⇒ 窗口关闭，刚拉起的新进程会随宿主进程树被收走。
 *   而且成败取决于宿主怎么杀进程树 —— 代码保证不了（实测同样代码在不同宿主下结果不同）。
 *   ∴ 改成同进程重听：端口是它自己刚释放的，没有交接、没有竞争者，窗口也不用关。
 *   （详见 `src/sticker-label-server.mjs` 的 `rebindInPlace` 与文件头说明。）
 */
async function restartServer() {
  if (!window.confirm('重启标注台服务？\n\n· 服务端会关掉监听再绑回同一个端口，进程不退出\n· 页面**不用**手动刷新（这里会自动接着用）\n· 词表与图库本来每轮现读，重启主要是让改过的代码生效')) return
  try {
    const d = await serverControl('restart')
    if (d && d.ok === false) {
      showFinalNotice(`重启失败：${d.error}`)
      return
    }
  } catch {
    // 重听期间可能有短暂的连接被拒，属预期；等一下再确认
  }
  // 等服务真的回来，再报结果（不谎报"好了"）
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 300))
    try {
      const h = await fetch('/api/health').then((r) => r.json())
      if (h?.ok) {
        if (state.serverBuildId !== '') state.serverBuildId = String(h.buildId ?? h.startedAt)
        showFinalNotice('服务已重启并恢复（端口不变）。本页面可以继续用，不必刷新。')
        return
      }
    } catch {
      /* 还没回来，继续等 */
    }
  }
  showFinalNotice('重启后服务没有恢复 —— 看一下那个启动窗口里的报错，或重新双击 启动标注.bat。')
}

/** 终局提示：占满屏幕的一条消息（此时服务已不在，用页面内提示最可靠）。 */
function showFinalNotice(text) {
  try {
    const box = $('page-error')
    if (!box) return
    box.textContent = `ℹ️ ${text}`
    box.hidden = false
    box.style.borderTopColor = 'var(--accent)'
    // 顺手禁用会打网络的按钮，避免用户反复点然后看到一堆失败
    for (const id of ['btn-quit', 'btn-restart', 'btn-reload', 'btn-auto-tag', 'btn-make-retag']) {
      const el = $(id)
      if (el) el.disabled = true
    }
  } catch {
    /* 兜底失败就算了 */
  }
}

/* ── 标签的新建 / 改名 / 删除（**改完下一轮对话即生效**）────────────── */

function showLabelForm(editId = null) {
  state.editing = editId
  const form = $('label-form')
  form.hidden = false
  const sel = $('lf-axis')
  sel.innerHTML = ''
  for (const ax of state.axes) {
    const o = document.createElement('option')
    o.value = ax
    o.textContent = ax
    sel.appendChild(o)
  }
  if (editId) {
    const l = labelMeta(editId)
    $('lf-title').textContent = `改标签：${l.name}（${l.id}）`
    $('lf-name').value = l.name
    sel.value = l.axis
    $('lf-cues').value = (l.cues ?? []).join(', ')
    // ★ 对方那一组也要回填 —— 否则编辑一次就把"对方会说什么"清空了（静默丢数据）
    $('lf-other').value = (l.otherCues ?? []).join(', ')
    $('lf-auto').textContent = l.auto
      ? '✓ 这个轴可被「自主补图」触发（正文像它时系统会自己挑一张）—— 改轴会改变这一点'
      : '✗ 这个轴只认模型主动写的 [sticker:标签]（系统不自主挑）'
    $('lf-delete').hidden = Boolean(l.protected)
    $('lf-delete').textContent = l.protected ? '' : '删除这个标签'
    $('lf-note').textContent = l.protected
      ? '★ 这个标签是**安全闸门**（默认不发那类图），不能改名也不能删。要放行请改配置 skills.sticker.allowRisky。'
      : `id 是 ${l.id}，**改名不会改 id**（库里引用的是 id，所以改完不会有图掉队）。`
    $('lf-note').innerHTML = $('lf-note').textContent.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  } else {
    $('lf-title').textContent = '新建标签'
    $('lf-name').value = ''
    $('lf-cues').value = ''
    $('lf-other').value = ''
    $('lf-auto').textContent = '轴决定它能不能被「自主补图」触发：主动情感/被逗乐/认知反应/表态/状态可以；礼节/交付/风险只能由模型主动要。'
    $('lf-delete').hidden = true
    $('lf-note').textContent = '★ id 按名字自动生成（中文名走短哈希），**不用你起**。'
    $('lf-note').innerHTML = $('lf-note').textContent.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  }
  $('lf-name').focus()
}

function hideLabelForm() {
  $('label-form').hidden = true
  state.editing = null
}

async function submitLabelForm(event) {
  event.preventDefault()
  const name = $('lf-name').value.trim()
  const axis = $('lf-axis').value
  const splitCues = (v) =>
    String(v ?? '')
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean)
  const cues = splitCues($('lf-cues').value)
  const otherCues = splitCues($('lf-other').value)
  // ★ 两组都要提交（0.2.4 第十三轮）：漏掉 otherCues 会让"对方说了什么"这一路失效
  const body = state.editing
    ? { action: 'update', id: state.editing, name, axis, cues, otherCues }
    : { action: 'create', name, axis, cues, otherCues }
  const data = await postLabels(body)
  if (!data.ok) {
    toast(data.error ?? '保存失败', 'err')
    return
  }
  applyLabelsPayload(data)
  toast(state.editing ? `已改：${name}` : `已新建标签「${name}」—— 下一轮对话就能用它`, 'ok')
  if (!state.editing && data.label?.id) state.browse.label = data.label.id
  hideLabelForm()
  await load()
}

async function removeLabel() {
  if (!state.editing) return
  const meta = labelMeta(state.editing)
  const used = state.counts[state.editing] ?? 0
  if (used > 0) {
    const sure = window.confirm(
      `「${meta.name}」下还有 ${used} 张图。\n\n` +
        `删掉标签**不会删图**，但这 ${used} 张会**恢复成未标注** —— 不会被选中，等着你重新标。\n` +
        '（删错了可以按 Ctrl+Z 整批撤回）\n\n确定删吗？',
    )
    if (!sure) return
  } else if (!window.confirm(`删除标签「${meta.name}」？`)) {
    return
  }
  const data = await postLabels({ action: 'delete', id: state.editing, confirm: true })
  if (!data.ok) {
    toast(data.error ?? '删除失败', 'err')
    return
  }
  applyLabelsPayload(data)
  const unlabeled = data.unlabeled ?? 0
  const secondary = data.relabeledSecondary ?? 0
  const bits = []
  if (unlabeled) bits.push(`${unlabeled} 张恢复成未标注`)
  if (secondary) bits.push(`${secondary} 张只摘掉了这个次要标签`)
  toast(`已删除「${meta.name}」${bits.length ? `（${bits.join('，')}）` : ''}｜Ctrl+Z 可整批撤回`, 'ok')
  state.browse.label = ''
  hideLabelForm()
  await load()
}

/** 提示词/词表相关的返回体统一吸收（标签清单 + 轴）。 */
function applyLabelsPayload(data) {
  if (Array.isArray(data.labels)) {
    state.labels = data.labels
    // /api/labels 返回的是全字段（cues 全量）；/api/list 只给前 3 条线索。
    // 这里保持"全字段优先"，避免改完标签后描述少一半。
  }
  if (Array.isArray(data.axes)) state.axes = data.axes
}

/* ══════════════════════════════════════════════════════════════════════
   写回（两个页签共用）
   ══════════════════════════════════════════════════════════════════════ */

/** 贴标签。`advance=false` 时不跳下一张（图墙里复核时用）。 */
async function save(label, { advance = true, row = null } = {}) {
  if (state.busy) return
  const target = row ?? state.filtered[state.idx]
  if (!target) return
  state.busy = true
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rel: target.rel, label }),
    })
    const data = await res.json()
    if (!data.ok) {
      toast(data.error ?? '写回失败', 'err')
      return
    }
    // 本地更新（不整表重载：整表重载会让"下一张"跳位，刷图的节奏就断了）
    Object.assign(target, data.row)
    if (data.unknown?.length) toast(`有标签名认不出：${data.unknown.map((u) => u.value).join('、')}`, 'err')
    state.counts[label] = (state.counts[label] ?? 0) + 1
    toast(`已标为「${labelMeta(label).name}」（manual，重打时会跳过）`, 'ok')
    // ★ 贴完自动跳下一张（刷图的主要开销是"看下一张"）
    if (advance) step(1)
    else if (state.page === 'browse') loadBrowse()
  } catch (e) {
    toast(`请求失败：${e}`, 'err')
  } finally {
    state.busy = false
  }
}

/** 图墙/浮层里改标签：改完不跳页，只刷新当前图墙。 */
async function saveLabel(row, label) {
  await save(label, { advance: false, row })
}

/** "跳过"= 标成没有合适标签（并记 manual，于是重打也不会安一个猜的）。 */
async function skip({ row = null } = {}) {
  const target = row ?? state.filtered[state.idx]
  if (!target) return
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rel: target.rel, action: 'skip' }),
    })
    const data = await res.json()
    if (data.ok) {
      Object.assign(target, data.row)
      toast('已标为「无合适标签」（manual，重打时会跳过）', 'ok')
    }
  } catch {
    /* 跳过失败就不动 */
  }
  if (row) {
    if (state.page === 'browse') loadBrowse()
    return
  }
  step(1)
}

async function undo() {
  try {
    const res = await fetch('/api/undo', { method: 'POST' })
    const data = await res.json()
    if (!data.ok) {
      toast(data.error ?? '没有可撤销的', 'err')
      return
    }
    if (data.batch) {
      // ★ 整批撤销（删标签）：一次撤回几十条，要说清"撤回了什么"
      const parts = []
      if (data.label) parts.push(`标签「${data.label}」已加回词表`)
      parts.push(`${data.changed} 张图的标注已还原`)
      toast(`已撤销删除：${parts.join('，')}`, 'ok')
      applyLabelsPayload(data)
      await load()
      if (state.page === 'browse') await loadBrowse()
      return
    }
    const row = state.rows.find((r) => r.rel === data.rel)
    if (row && data.row) Object.assign(row, data.row)
    toast(`已撤销：${row?.name ?? data.rel}`, 'ok')
    render()
  } catch (e) {
    toast(`撤销失败：${e}`, 'err')
  }
}

function step(delta) {
  if (!state.filtered.length) return
  // 用"筛选后的列表"翻页；筛掉的条目不会挡路
  state.idx = (state.idx + delta + state.filtered.length) % state.filtered.length
  renderPass()
}

/* ══════════════════════════════════════════════════════════════════════
   取数与渲染
   ══════════════════════════════════════════════════════════════════════ */

async function postLabels(body) {
  try {
    const res = await fetch('/api/labels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await res.json()
  } catch (e) {
    return { ok: false, error: `请求失败：${e}` }
  }
}

async function loadBrowse() {
  const q = state.browse.label ? `?label=${encodeURIComponent(state.browse.label)}` : ''
  try {
    const res = await fetch(`/api/browse${q}`)
    const data = await res.json()
    if (!data.ok) {
      toast(data.error ?? '读图墙失败', 'err')
      return
    }
    state.browse.rows = data.rows
    renderBrowse()
  } catch (e) {
    toast(`读图墙失败：${e}`, 'err')
  }
}

async function load() {
  const res = await fetch('/api/list')
  const data = await res.json()
  if (!data.ok) {
    toast(data.error ?? '读库失败', 'err')
    return
  }
  state.rows = data.rows
  state.labels = data.labels
  state.counts = data.counts
  state.unknownCounts = data.unknownCounts ?? {}
  state.axes = data.axes ?? []
  state.minUsable = data.minUsable ?? 3
  if (data.missing > 0) toast(`有 ${data.missing} 张图的文件不在磁盘上（跑 --stickers --prune 核对）`, 'err')
  $('tab-badge').textContent = ` ${state.rows.filter((r) => !r.primary).length} 待打`
  render()
}

/** 两个页签都画（切页签时不用重新取数）。 */
function render() {
  if (state.page === 'pass') {
    $('page-pass').hidden = false
    $('page-browse').hidden = true
    renderPass()
  } else {
    $('page-pass').hidden = true
    $('page-browse').hidden = false
    renderBrowse()
  }
}

function switchPage(page) {
  state.page = page
  $('tab-pass').classList.toggle('active', page === 'pass')
  $('tab-browse').classList.toggle('active', page === 'browse')
  render()
  // 切到图墙时顺带刷新"自动分类"的状态（空闲要显示会处理几张）
  if (page === 'browse') void refreshAutoTag()
  // ★ 返回 promise，调用方（如「管理标签」）就能 await 到图墙真正加载完，
  //   否则会出现"两次 loadBrowse 抢着渲染"的竞态（第二次的结果可能被第一次覆盖）。
  if (page === 'browse' && !state.browse.rows.length) return loadBrowse()
  return Promise.resolve()
}

/* ══════════════════════════════════════════════════════════════════════
   小工具与事件
   ══════════════════════════════════════════════════════════════════════ */

let toastTimer = null
function toast(msg, kind = '') {
  const t = $('toast')
  t.textContent = msg
  t.className = `toast ${kind}`
  t.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    t.hidden = true
  }, 2600)
}

/* ── 键盘：刷图不该用鼠标 ──────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
  const tag = (e.target?.tagName ?? '').toLowerCase()
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return
  // 浮层开着时只认 Esc（避免误触发表情判定）
  if (!$('ov').hidden) {
    if (e.key === 'Escape') closeOverlay()
    return
  }
  if (e.key === 'Escape' && !$('label-form').hidden) return hideLabelForm()
  if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault()
    return undo()
  }
  // 逐张页才有翻页与数字快贴
  if (state.page !== 'pass') return
  if (e.key === 'ArrowRight' || e.key === 'd') return step(1)
  if (e.key === 'ArrowLeft' || e.key === 'a') return step(-1)
  if (e.key === ' ') {
    e.preventDefault()
    return skip()
  }
  const n = Number(e.key)
  if (n >= 1 && n <= 9) {
    const id = quickIds()[n - 1]
    if (id) save(id)
  }
})

/* ── 兜底：脚本出意外要**说出来**，不能让人对着"点了没反应"猜 ────────── */
function showPageError(what, error) {
  try {
    const box = $('page-error')
    if (!box) return
    const line = `⚠️ ${what}：${error?.message ?? error}\n   （截图这一条给开发者即可定位。页面其它部分仍可用；按 F5 重载。）`
    box.textContent = box.textContent ? `${box.textContent}\n${line}` : line
    box.hidden = false
  } catch {
    /* 连兜底都失败就只能算了，不能因此再抛一次 */
  }
}
window.addEventListener('error', (e) => showPageError('页面脚本出错', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => showPageError('异步操作失败', e.reason))

/* ── 构建标记：问服务端"你是哪一版"，页面据此显示 ──────────────────────
   排查"我改了怎么还是老样子"时，这一行能立刻区分"缓存/旧进程"与"新代码"。 */
async function showBuildStamp() {
  try {
    const res = await fetch('/api/health')
    const data = await res.json()
    const el = $('build-stamp')
    if (el) {
      el.textContent = `构建 ${String(data.startedAt ?? '').slice(11, 19)}`
      el.title =
        `服务端进程启动于 ${data.startedAt}\n` +
        `缩略图缓存上限 ${data.thumbCacheMax}｜并发 ${data.thumbConcurrency}\n` +
        `图墙一次最多 ${MAX_CELLS} 格｜浮层原图超过 ${OVERLAY_AUTOLOAD_MB}MB 不自动播放`
    }
    // 记住"本页面是配着哪一次服务端版本加载的"（原地重听用 buildId，见 startStalePageWatch）
    const stamp = data.buildId ?? data.startedAt
    if (stamp != null && state.serverBuildId === '') state.serverBuildId = String(stamp)
  } catch {
    /* 拿不到就不显示，不影响使用 */
  }
}

/**
 * ★★ 「页面过期自证」（0.2.4 第十八轮）。
 *
 * 为什么必须有：这个工具的静态资源是 `max-age=604800` + `?v=<启动时间>` 指纹 ——
 * 只要**不重载页面**，浏览器就会一直跑着**旧的那份 app.js / style.css**。
 * 而这一轮真实的坑正是这样来的：修好之后服务端四项全绿（接口、缩略图、渲染函数、
 * 样式都验过），但用户页面上的图仍然不显示 —— 因为那份页面是**修复之前**加载的，
 * 里面还带着"滚动冻结动图"那条 `visibility: hidden` 规则。
 *
 * 这种"代码是新的、页面是旧的"只能靠**页面自己发现**：
 * 定期问一次 `/api/health`，一旦服务端的**重听计数**（`buildId`）与加载本页时不同，
 * 就说明中间重启过，当场把提示条亮出来，人按一下 F5 就好。
 * 否则症状是"我明明改好了"与"我看还是坏的"两边都对，却谁也说不清差在哪。
 *
 * ★ 用 `buildId` 而不是 `startedAt`：重启已经改成**同进程原地重听**，进程不换，
 *   `startedAt` 根本不会变（拿它当版本号就永远发现不了）。
 */
function startStalePageWatch() {
  const tick = async () => {
    if (document.hidden) return // 后台标签页不打扰
    try {
      const data = await fetch('/api/health').then((r) => r.json())
      const now = data.buildId ?? data.startedAt
      if (now == null || state.serverBuildId === '') return
      if (String(now) !== String(state.serverBuildId)) {
        state.serverBuildId = String(now)
        showPageError(
          '服务端已重启，本页面还是旧代码',
          new Error('按 F5 重载页面即可拿到新版本（图不显示、按钮没反应都可能只是这个原因）'),
        )
      }
    } catch {
      /* 服务端正在重启时会连不上，忽略即可 */
    }
  }
  setInterval(tick, 15000)
}

/**
 * ★★ 事件绑定要**互不牵连**（这是"页面卡住、什么都点不动"的一个真实成因）。
 *
 * 原来这一整段是顺序执行的裸赋值：只要其中**任何一行**抛错（元素改名、
 * 模板与脚本版本不一致、`$()` 返回 null），后面的绑定就**全都不执行** ——
 * 表现是"页面画得出来，但每个按钮都没反应"，而且只在点的时候才看出来。
 * 所以改成逐个 try/catch：**一个绑不上，不影响其余的**，同时把原因显示出来。
 */
{
  const bind = (id, prop, handler) => {
    try {
      const el = $(id)
      if (!el) throw new Error(`页面上找不到 #${id}`)
      el[prop] = handler
    } catch (error) {
      showPageError(`绑定 #${id} 的 ${prop} 失败`, error)
    }
  }
  bind('tab-pass', 'onclick', () => switchPage('pass'))
  bind('tab-browse', 'onclick', () => switchPage('browse'))
  bind('btn-prev', 'onclick', () => step(-1))
  bind('btn-next', 'onclick', () => step(1))
  bind('btn-skip', 'onclick', () => skip())
  bind('btn-undo', 'onclick', () => undo())
  bind('btn-reload', 'onclick', () =>
    load()
      .then(() => (state.page === 'browse' ? loadBrowse() : null))
      .then(() => toast('已重载')),
  )
  bind('btn-new-label', 'onclick', () => showLabelForm(null))
  bind('btn-auto-tag', 'onclick', () => toggleAutoTag())
  // ★ 进程控制：退出 / 重启（在 UI 里就能关掉这个进程，不用去任务管理器翻 node.exe）
  bind('btn-quit', 'onclick', () => quitServer())
  bind('btn-restart', 'onclick', () => restartServer())
  bind('btn-edit-label', 'onclick', () => state.browse.label && showLabelForm(state.browse.label))
  // ★ 逐张页的「管理标签」：跳到按标签看图，**并直接把编辑表单打开**。
  //   为什么要有这个入口：编辑/删除原先只存在于第二个页签里，用户在逐张页
  //   完全看不到它们（实测反馈"没有看见删除、编辑等新功能的入口"）。
  //   跳到图墙而不是原地弹表单，是因为**改名/删除本来就该看着那批图做判断** ——
  //   点一下就换页并展开表单，比在当前页塞一个没有上下文的小窗口更有用。
  bind('btn-manage-labels', 'onclick', async () => {
    await switchPage('browse')
    // 优先打开"当前正在看的那张图的标签"；没有就打开第一个有图的标签
    const cur = state.filtered[state.idx]?.primary
    const withImages = state.labels.find((l) => (state.counts[l.id] ?? 0) > 0)
    const target = cur || withImages?.id
    if (target) {
      state.browse.label = target
      state.browse.shown = MAX_CELLS
      await loadBrowse()
      showLabelForm(target)
    } else {
      showLabelForm(null)
    }
    toast('在这里改名 / 改轴 / 删除标签（删除后那些图会恢复成未标注）', 'ok')
  })
  bind('lf-cancel', 'onclick', () => hideLabelForm())
  bind('lf-delete', 'onclick', () => removeLabel())
  bind('label-form', 'onsubmit', (e) => submitLabelForm(e))
  bind('label-filter', 'oninput', (e) => {
    state.labelQuery = e.target.value
    renderLabelList()
  })
  bind('grid-manual-only', 'onchange', (e) => {
    state.browse.manualOnly = e.target.checked
    state.browse.shown = MAX_CELLS
    renderBoard()
  })
  bind('btn-more', 'onclick', () => {
    state.browse.shown += MAX_CELLS
    renderBoard()
  })
  bind('ov-skip', 'onclick', async () => {
    const row = state.overlayRow
    closeOverlay()
    if (row) await skip({ row })
  })
  bind('ov', 'onclick', (e) => {
    if (e.target === $('ov')) closeOverlay()
  })

  for (const [id, key] of [
    ['only-todo', 'onlyTodo'],
    ['only-manual', 'onlyManual'],
    ['only-low', 'onlyLow'],
    ['see-all', 'seeAll'],
    ['only-disputed', 'onlyDisputed'],
  ]) {
    bind(id, 'onchange', (e) => {
      state[key] = e.target.checked
      if (key === 'onlyDisputed' && e.target.checked) {
        state.onlyTodo = false
        state.seeAll = false
        $('only-todo').checked = false
        $('see-all').checked = false
      }
      if (key === 'seeAll' && e.target.checked) {
        // 勾"看全部"时把"只看待办"取消（两个同时勾会让人以为筛错了）
        state.onlyTodo = false
        $('only-todo').checked = false
      }
      state.idx = 0
      // 复用 renderPass（不要调 render）：只重画逐张页，不整页重载
      renderPass()
    })
  }
  // 手动取消"待办"时也同步（避免两个都空着导致列表为空而不知所措）
  try {
    $('only-todo').addEventListener('change', (e) => {
      if (e.target.checked) {
        state.seeAll = false
        $('see-all').checked = false
      }
    })
    $('only-todo').checked = state.onlyTodo
  } catch (error) {
    showPageError('初始化"只看待办"开关失败', error)
  }
}

load().catch((e) => {
  showPageError('首次加载失败', e)
  toast(`加载失败：${e}`, 'err')
})
void showBuildStamp()
startStalePageWatch()

// ★ 把"关浮层"挂到全局：`index.html` 里 `#ov-close` 的内联 `onclick="closeOverlay()"`
//   靠的就是它（万一脚本的绑定整段没跑到，这个按钮仍然能关掉全屏遮罩）。
window.closeOverlay = closeOverlay
