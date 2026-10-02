/**
 * 聊天记录评审台 —— **数据层**：评分怎么存、统计怎么算、改写草稿怎么落地。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 2026-10-02 的**形状变更**（使用者推翻了第一版）
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版：人从一张**手写标签表**里选标签 → 按标签统计 → 生成"反例清单"追加到文件尾。
 * 使用者的原话：**「标签系统并不合理，我的习惯是对说得对与不对的地方进行评论，
 * 生成修订草稿应基于评论而不是标签，对评论进行整理之后再生成草稿，并且按需要
 * 精简整理已有的闲聊.md」**。
 *
 * 于是现在：
 *   · **标签整套删掉**（税则、漂移检查、标签排行、"点"由人预先设定这件事本身都删了）。
 *     旧数据里的 `tags` 字段**读得进来但不参与任何逻辑**（不丢历史，也不再影响结论）。
 *   · **评论是一等公民**：`{verdict, comment}`，评论才是素材。
 *   · **"点"从评论里长出来**：由 `chat-review-consolidate.mjs` 调模型归纳，
 *     结果存成一份"整理"（consolidation），而不是我预先写好的分类。
 *   · **草稿 = 整篇重写**（可按需精简），不是"追加一段"。改写必须过**锚点核对**
 *     （底线要点一条都不许丢），且永远是"人点确认 + 先备份"。
 *
 * ── 写操作仍然只有三件 ────────────────────────────────────────────────────
 *   ① 评分；② 删批次（都在工作区 `runtime/chat-review/` 下）；③ **应用改写**
 *   （唯一碰机器人人格的操作：先备份 → 原子写风格文件 → 顺带同步
 *   `src/chat-mode.mjs` 里的出厂默认常量，否则那两份会开始漂）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { checkAnchors, clusterComments, STYLE_ANCHORS } from './chat-review-consolidate.mjs'
import { sha256, syncStyleConstant } from './chat-style-sync.mjs'

/** 评审数据放在工作区的 `runtime/` 下（与语料库、任务台账同级；不进发布包）。 */
export const REVIEW_REL = 'runtime/chat-review'

/** 数据文件版本。读到不认识的版本时**拒绝写**（宁可报错，也不要写坏）。 */
export const REVIEW_VERSION = 1

/** 三档结论（`key` 是页面上的键盘快捷键）。 */
export const VERDICTS = [
  { id: 'good', label: '对', key: '1' },
  { id: 'ok', label: '还行', key: '2' },
  { id: 'bad', label: '不对', key: '3' },
]

/** 单条评论的长度上限（评论是散文，给得比标签宽 —— 但仍要有上限）。 */
export const COMMENT_MAX_CHARS = 2000

/** 点标题/摘要的长度上限（它是按钮上的字，不是散文）。 */
export const POINT_TITLE_MAX_CHARS = 40
export const POINT_SUMMARY_MAX_CHARS = 300

/**
 * **初始的点**（使用者 2026-10-02 拍板：点表为空时用它播种）。
 *
 * ⚠️ 这**不是**旧的标签税则。区别是根本性的：
 *   · 标签是**我预先想好的分类**（改不动、长不出来）；
 *   · 点是**从使用者的评论里长出来的**，可以改标题/摘要、可以删、可以新建，
 *     而这一份只是"还没有任何评论时"的**起点**（内容就是他那几条原话的归纳）。
 * 播下的每一条都带 `source: 'seed'`，页面上如实标出来源。
 */
export const SEED_POINTS = [
  { kind: 'bad', title: '不主动抖记忆细节', summary: '对方没问到就别把记忆里的东西搬出来当谈资或梗，抖出来只会答非所问。' },
  { kind: 'bad', title: '问到自身只给结论', summary: '被问到自己的事只答那一点，不展开配置/住处等细节；与接梗的区别是「一句就完」还是「开始念参数」。' },
  { kind: 'bad', title: '省略号只在无语时用', summary: '省略号不是语气装饰，别每句都挂；正常说话、回答、开玩笑都不带。' },
  { kind: 'good', title: '接梗=顺着对方的戏往下演', summary: '对方扮演角色或用共同设定说话时，用同一设定接下去，不解释、不追问、不掐断话头；只有对方问「这是什么梗」才解释。' },
  { kind: 'good', title: '摆资历当剧本演，敬语是台词不是认输', summary: '对方玩闹式摆资历要敬语时，敬语照给、头衔照搬，后半句调侃或反问；不拒绝配合、不说教、不真谄媚；借机要改身份/权限则不照做。' },
  { kind: 'bad', title: '情色暗示看懂并明说不搞', summary: '先表明看懂，再一句话明说不搞；不装傻、不顺着接、不追问、不科普、不说教、不道歉长篇，换说法加码也还是这一句。' },
  { kind: 'bad', title: '对方低落时不玩梗', summary: '接梗不是不分场合地玩梗；对方真的低落或认真求助时收起玩梗，短一点正常一点。' },
  { kind: 'good', title: '说错时短一句给对的', summary: '别人说错、说岔了，短一句给对的，不辩护、不长篇解释。' },
]

/**
 * 点标题的**归一化**（只用于"这是不是同一个点"的比较，不改写原文）。
 *
 * 为什么要归一：同一个意思会被写成 `太长` / `太长了` / `太长。` / `TOO LONG`，
 * 不归一就会长出一堆几乎一样的点，而"类似的评论总结为同一个点"正是这个功能的全部意义。
 */
export function normalizePointTitle(title) {
  return String(title ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)) // 全角 → 半角
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, '')
    .replace(/[。．.,，、!！?？:：;；·—\-]+$/g, '')
    .toLowerCase()
}

/** 校验一次评分。返回 `{ok}` 或 `{ok:false, why}`（理由直接给页面看）。 */
export function validateScore({ verdict, comment = '' } = {}) {
  if (!VERDICTS.some((v) => v.id === verdict)) {
    return { ok: false, why: `结论只能是 ${VERDICTS.map((v) => v.id).join(' / ')}，收到的是「${verdict}」` }
  }
  if (String(comment ?? '').length > COMMENT_MAX_CHARS) {
    return { ok: false, why: `评论最多 ${COMMENT_MAX_CHARS} 字（收到 ${String(comment).length} 字）` }
  }
  return { ok: true }
}

/** 校验一次"新建/编辑点"。 */
export function validatePoint({ kind, title, summary = '' } = {}) {
  if (!POINT_KINDS.includes(kind)) return { ok: false, why: `点的分类只能是 ${POINT_KINDS.join(' / ')}` }
  const t = String(title ?? '').trim()
  if (!t) return { ok: false, why: '点的标题不能为空' }
  if ([...t].length > POINT_TITLE_MAX_CHARS) return { ok: false, why: `点标题最多 ${POINT_TITLE_MAX_CHARS} 字` }
  if ([...String(summary ?? '')].length > POINT_SUMMARY_MAX_CHARS) {
    return { ok: false, why: `点摘要最多 ${POINT_SUMMARY_MAX_CHARS} 字` }
  }
  return { ok: true }
}

/** 点的两个分类（与三档结论无关：点是"哪类问题"，结论是"这条好不好"）。 */
export const POINT_KINDS = ['bad', 'good']

// ══════════════════════════════════════════════════════════════════════════
// 纯函数：统计 / diff
// ══════════════════════════════════════════════════════════════════════════

/**
 * 统计（**纯函数**，所以能被测试直接喂数据）。
 *
 * ★ 与第一版的关键差别：**没有标签排行**了 —— 现在是**点排行**，而点是从评论里
 *   长出来的（见 `src/chat-review-consolidate.mjs`）。
 *
 * @param {object} opts
 * @param {object[]} opts.items      条目（含 id / reply / context / chatKey / chatLabel）
 * @param {object} opts.scores       `{ [itemId]: score }`
 * @param {object} [opts.pointsById] 点表（`{ [id]: point }`），用来把点 id 还原成标题；
 *   点被删掉后 id 会悬空，那时**如实显示 id**（不编一个标题出来）
 */
export function aggregateStats({ items = [], scores = {}, pointsById = {} } = {}) {
  const verdicts = { good: 0, ok: 0, bad: 0 }
  const byVerdict = { good: 0, ok: 0, bad: 0 }
  const perChat = new Map()
  const perPoint = new Map()
  const list = []
  let scored = 0
  let bad = 0
  let withText = 0
  let withPoints = 0

  for (const item of items) {
    const s = scores[item?.id]
    if (!s) continue
    scored += 1
    if (verdicts[s.verdict] !== undefined) verdicts[s.verdict] += 1
    if (s.verdict === 'bad') bad += 1
    const key = item.chatKey ?? '?'
    const c = perChat.get(key) ?? { chatKey: key, label: item.chatLabel ?? key, scored: 0, bad: 0 }
    c.scored += 1
    if (s.verdict === 'bad') c.bad += 1
    perChat.set(key, c)

    const comment = String(s.comment ?? '').trim()
    if (comment) {
      withText += 1
      if (byVerdict[s.verdict] !== undefined) byVerdict[s.verdict] += 1
    }
    // ── 点：这条评了哪几个点（(a) 语义：点与评论**各自留痕**，谁都不覆盖谁）──
    const pointIds = Array.isArray(s.points) ? s.points.filter(Boolean) : []
    const points = pointIds.map((pid) => {
      const p = pointsById[pid]
      perPoint.set(pid, (perPoint.get(pid) ?? 0) + 1)
      // 点被删掉之后 id 会悬空：**如实显示 id**，不编一个标题出来
      return p ? { id: pid, kind: p.kind, title: p.title } : { id: pid, kind: '', title: `（已删除的点 ${pid}）` }
    })
    if (points.length) withPoints += 1
    list.push({
      id: item.id,
      verdict: s.verdict,
      comment,
      points,
      at: s.at ?? null,
      reply: item.reply,
      context: item.context ?? [],
      chatLabel: item.chatLabel ?? item.chatKey ?? '',
    })
  }

  list.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return {
    verdicts,
    rate: {
      scored,
      total: items.length,
      good: scored ? verdicts.good / scored : 0,
      bad: scored ? bad / scored : 0,
    },
    comments: { withText, withoutText: scored - withText, byVerdict },
    /** 点被点了多少次（`{ [pointId]: n }`）—— 报告页的"点排行"用它。 */
    pointCounts: Object.fromEntries([...perPoint.entries()].sort((a, b) => b[1] - a[1])),
    pointsUsed: withPoints,
    chats: [...perChat.values()].sort((a, b) => b.scored - a.scored || a.chatKey.localeCompare(b.chatKey)),
    /** 评论清单：报告页显示它，「整理」把它喂给模型。 */
    list,
  }
}

/**
 * 统一 diff（LCS）。只给**人看**，不参与任何自动改写。
 *
 * 为什么不用外部 diff 库：这个项目零运行时依赖，而这里只需要"看个大概"。
 * 整篇重写时行数不多（几十行），LCS 足够快。
 */
export function unifiedDiff(aText, bText, { context = 3, aName = 'a', bName = 'b' } = {}) {
  const a = String(aText ?? '').split('\n')
  const b = String(bText ?? '').split('\n')
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: '-', text: a[i] })
      i += 1
    } else {
      ops.push({ type: '+', text: b[j] })
      j += 1
    }
  }
  while (i < n) ops.push({ type: '-', text: a[i++] })
  while (j < m) ops.push({ type: '+', text: b[j++] })

  const keep = new Array(ops.length).fill(false)
  ops.forEach((op, idx) => {
    if (op.type === ' ') return
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k += 1) keep[k] = true
  })
  const out = [`--- ${aName}`, `+++ ${bName}`]
  let idx = 0
  while (idx < ops.length) {
    if (!keep[idx]) {
      idx += 1
      continue
    }
    const start = idx
    let aCount = 0
    let bCount = 0
    const lines = []
    while (idx < ops.length && keep[idx]) {
      const op = ops[idx]
      if (op.type !== '+') aCount += 1
      if (op.type !== '-') bCount += 1
      lines.push(`${op.type}${op.text}`)
      idx += 1
    }
    out.push(`@@ -${start + 1},${aCount} +${start + 1},${bCount} @@`)
    out.push(...lines)
  }
  return out.join('\n')
}

// ══════════════════════════════════════════════════════════════════════════
// 落盘
// ══════════════════════════════════════════════════════════════════════════

/** 原子写（tmp + rename）—— 半截 JSON 会让下一次读直接失败。 */
function writeJsonAtomic(abs, data) {
  mkdirSync(dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, 'utf8')
  renameSync(tmp, abs)
}

function readJson(abs, fallback, log) {
  if (!existsSync(abs)) return fallback
  try {
    const parsed = JSON.parse(readFileSync(abs, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch (error) {
    // ★ 不许静默：读不出来意味着"评分看起来丢了"，那是最让人不敢用的一类故障
    log(`⚠️ [评审台] 读不出 ${abs}（按空处理，**注意这会看起来像评分丢了**）：${error?.message ?? error}`)
    return fallback
  }
}

/**
 * 造一个评审数据仓库。
 *
 * @param {object} opts
 * @param {string} opts.workspace      工作区（评审数据写在它下面）
 * @param {string} opts.styleFile      `styles/闲聊.md` 的**绝对**路径（应用改写时用）
 * @param {string} [opts.chatModePath] `src/chat-mode.mjs` 的绝对路径（同步出厂常量用；
 *   不传 = 不同步，并在结果里如实说明）
 * @param {(m: string) => void} [opts.log]
 */
export function createReviewStore({ workspace, styleFile, chatModePath = '', log = () => {} } = {}) {
  const root = String(workspace ?? '')
  if (!root) throw new Error('没有工作区，评审数据无处可放')
  const dir = join(root, REVIEW_REL)
  const indexPath = join(dir, 'index.json')
  const scoresPath = join(dir, 'scores.json')
  const consolidateDir = join(dir, 'consolidations')
  const batchPath = (id) => join(dir, 'batches', `${id}.json`)
  const pointsPath = join(dir, 'points.json')

  /** 已知条目 id 的缓存（打分时要校验"这条真的属于某个批次"）。 */
  let knownIds = null

  const emptyIndex = () => ({ version: REVIEW_VERSION, batches: [] })
  const emptyScores = () => ({ version: REVIEW_VERSION, scores: {}, order: [] })

  const readIndex = () => {
    const raw = readJson(indexPath, emptyIndex(), log)
    return { version: REVIEW_VERSION, batches: Array.isArray(raw.batches) ? raw.batches : [] }
  }
  /**
   * 读评分。**兼容旧数据**：旧系统的「备注」字段叫 `note`，它就是现在的评论 ——
   * 不兼容读的话，使用者以前写过的那些字会**看起来从没存在过**（这是最不能接受的一种坏）。
   * 旧的 `tags` 字段继续忽略（标签体系已整套删除）。
   */
  const readScores = () => {
    const raw = readJson(scoresPath, emptyScores(), log)
    const src = raw.scores && typeof raw.scores === 'object' ? raw.scores : {}
    const scores = {}
    for (const [id, s] of Object.entries(src)) {
      if (!s || typeof s !== 'object') continue
      scores[id] = {
        id,
        verdict: s.verdict,
        comment: String(s.comment ?? s.note ?? ''),
        points: Array.isArray(s.points) ? s.points.filter((x) => typeof x === 'string') : [],
        at: s.at ?? null,
      }
    }
    return {
      version: REVIEW_VERSION,
      scores,
      order: Array.isArray(raw.order) ? raw.order.filter((x) => typeof x === 'string') : [],
    }
  }

  /** 点表（`points.json`）。读坏不静默 —— 点表空了会让人以为"我的点丢了"。 */
  const emptyPoints = () => ({ version: REVIEW_VERSION, updatedAt: 0, points: [] })
  const readPoints = () => {
    const raw = readJson(pointsPath, emptyPoints(), log)
    const points = (Array.isArray(raw.points) ? raw.points : [])
      .filter((p) => p && typeof p === 'object' && p.id && p.title)
      .map((p) => ({
        id: String(p.id),
        kind: POINT_KINDS.includes(p.kind) ? p.kind : 'bad',
        title: String(p.title),
        summary: String(p.summary ?? ''),
        count: Number(p.count) || 0,
        source: ['seed', 'consolidated', 'manual'].includes(p.source) ? p.source : 'manual',
        createdAt: p.createdAt ?? null,
        updatedAt: p.updatedAt ?? null,
      }))
    return { version: REVIEW_VERSION, updatedAt: raw.updatedAt ?? 0, points }
  }
  const writePoints = (points) => {
    const payload = { version: REVIEW_VERSION, updatedAt: Date.now(), points }
    writeJsonAtomic(pointsPath, payload)
    return payload
  }
  /** 点 id：`p-` + 递增序号（可读、稳定、不含路径分隔符）。 */
  const nextPointId = (points) => {
    let n = points.length + 1
    const taken = new Set(points.map((p) => p.id))
    while (taken.has(`p-${n}`)) n += 1
    return `p-${n}`
  }

  function ensureKnownIds() {
    if (knownIds) return knownIds
    knownIds = new Set()
    for (const meta of readIndex().batches) {
      const abs = batchPath(meta.id)
      if (!existsSync(abs)) continue
      const data = readJson(abs, null, log)
      for (const item of data?.items ?? []) if (item?.id) knownIds.add(item.id)
    }
    return knownIds
  }

  /** 批次元信息 + 实时进度（`scored` 永远按当前评分算，不存冗余计数）。 */
  function listBatches() {
    const scores = readScores().scores
    return readIndex()
      .batches.map((meta) => {
        let scored = 0
        let commented = 0
        const abs = batchPath(meta.id)
        if (existsSync(abs)) {
          const data = readJson(abs, null, log)
          for (const item of data?.items ?? []) {
            const s = scores[item?.id]
            if (!s) continue
            scored += 1
            if (String(s.comment ?? '').trim()) commented += 1
          }
        }
        return { ...meta, scored, commented }
      })
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }

  function createBatch({ label, source = 'import', chatKey = '', chatLabel = '', items = [] } = {}) {
    const id = String(label ?? '').trim()
    if (!id) return { ok: false, why: '批次 id 不能为空' }
    if (!items.length) return { ok: false, why: '这批里一个可评的回合都没有' }
    const meta = { id, label: String(label), source, chatKey, chatLabel, createdAt: Date.now(), items: items.length }
    writeJsonAtomic(batchPath(id), { version: REVIEW_VERSION, batch: meta, items })
    const index = readIndex()
    const rest = index.batches.filter((b) => b.id !== id)
    writeJsonAtomic(indexPath, { version: REVIEW_VERSION, batches: [...rest, meta] })
    knownIds = null
    return { ok: true, batch: { ...meta, scored: 0, commented: 0 } }
  }

  function readBatch(id) {
    const abs = batchPath(String(id ?? ''))
    if (!existsSync(abs)) return null
    return readJson(abs, null, log)
  }

  function deleteBatch(id) {
    const key = String(id ?? '')
    const index = readIndex()
    if (!index.batches.some((b) => b.id === key)) return { ok: false, why: '没有这个批次' }
    const data = readBatch(key)
    const scores = readScores()
    for (const item of data?.items ?? []) delete scores.scores[item?.id]
    scores.order = scores.order.filter((x) => scores.scores[x])
    writeJsonAtomic(scoresPath, { version: REVIEW_VERSION, ...scores })
    try {
      if (existsSync(batchPath(key))) unlinkSync(batchPath(key))
    } catch (error) {
      return { ok: false, why: `删批次文件失败：${error?.message ?? error}` }
    }
    writeJsonAtomic(indexPath, { version: REVIEW_VERSION, batches: index.batches.filter((b) => b.id !== key) })
    knownIds = null
    return { ok: true, removed: data?.items?.length ?? 0 }
  }

  function progress(id) {
    const batch = listBatches().find((b) => b.id === String(id))
    if (!batch) return { scored: 0, total: 0, commented: 0 }
    return { scored: batch.scored, total: batch.items, commented: batch.commented }
  }

  /** 某个条目属于哪个批次（打分响应要回进度，而打分请求只带条目 id）。 */
  function findBatchOf(itemId) {
    const key = String(itemId ?? '')
    if (!key) return null
    for (const meta of readIndex().batches) {
      const data = readBatch(meta.id)
      if ((data?.items ?? []).some((it) => it.id === key)) return meta.id
    }
    return null
  }

  /**
   * 写一条评分（重复提交 = 覆盖；评错了就是重评，不需要先删）。
   *
   * ★ 评论为空也允许 —— "只判档不写字"是一种合法的快速过法；
   *   但**整理**那一步会如实说"有 N 条只有判档、没有评论，没参与整理"。
   */
  function saveScore({ id, verdict, comment = '', points = [] } = {}) {
    const key = String(id ?? '')
    if (!ensureKnownIds().has(key)) return { ok: false, why: '这个条目不属于任何批次（可能批次被删了）' }
    const valid = validateScore({ verdict, comment })
    if (!valid.ok) return valid
    // ★ 点必须是点表里真有的：写进一个不存在的点 id，报告里就会冒出一条点不到的"点"
    //   （而且点表被编辑过之后它会永远悬空）——所以**点名拒绝**，不静默丢弃。
    const wanted = [...new Set((Array.isArray(points) ? points : []).map((x) => String(x)).filter(Boolean))]
    if (wanted.length) {
      const known = new Set(readPoints().points.map((p) => p.id))
      const unknown = wanted.filter((pid) => !known.has(pid))
      if (unknown.length) return { ok: false, why: `这些点不在点表里（可能刚被删掉）：${unknown.join('、')}` }
    }
    const data = readScores()
    const score = {
      id: key,
      verdict,
      comment: String(comment ?? '').slice(0, COMMENT_MAX_CHARS),
      // (a) 语义：点与评论**各自留痕** —— 点一下不会自动往评论框里写字，反之亦然
      points: wanted,
      at: Date.now(),
    }
    data.scores[key] = score
    // `order` 是**评分顺序**（不是条目顺序）：撤销要撤"我上一条打的"
    data.order = data.order.filter((x) => x !== key)
    data.order.push(key)
    writeJsonAtomic(scoresPath, { version: REVIEW_VERSION, ...data })
    return { ok: true, score }
  }

  /** 撤销某个批次里**最后一次**评分。 */
  function undo(batchId) {
    const data = readBatch(batchId)
    if (!data) return { ok: false, why: '没有这个批次' }
    const ids = new Set((data.items ?? []).map((i) => i.id))
    const scores = readScores()
    for (let i = scores.order.length - 1; i >= 0; i -= 1) {
      const key = scores.order[i]
      if (!ids.has(key)) continue
      const score = scores.scores[key] ?? null
      delete scores.scores[key]
      scores.order.splice(i, 1)
      writeJsonAtomic(scoresPath, { version: REVIEW_VERSION, ...scores })
      return { ok: true, undone: score }
    }
    return { ok: true, undone: null }
  }

  /** 取某个批次（或全部）的条目 + 它们的评分。 */
  function collect(scope) {
    const all = String(scope ?? 'all') === 'all'
    const metas = listBatches().filter((b) => all || b.id === String(scope))
    const items = []
    for (const meta of metas) {
      const data = readBatch(meta.id)
      for (const item of data?.items ?? []) items.push(item)
    }
    return { items, metas }
  }

  function stats(scope) {
    const { items, metas } = collect(scope)
    const scores = readScores().scores
    const pointsById = Object.fromEntries(readPoints().points.map((p) => [p.id, p]))
    return {
      ...aggregateStats({ items, scores, pointsById }),
      scope: String(scope ?? 'all'),
      batches: metas.length,
      points: listPoints(),
    }
  }

  /** 只有评论的评分（**整理**的输入：没写评论的那些不参与）。 */
  function comments(scope) {
    return stats(scope).list.filter((row) => row.comment)
  }

  // ── 点表（使用者 2026-10-02 拍板：点**顶替**原来的标签，是一套长期存在的评论词汇表）──
  //
  // 与旧标签的根本差别：标签是我预先想好的分类（改不动、长不出来）；
  // 点是从评论里**长出来**的，而且**可以编辑**（改标题/摘要、删、新建）。
  // 所以它是数据（`points.json`），不是代码里的一张常量表。

  /** 列出点（按 kind 分组交给页面，这里只给原样一份）。 */
  function listPoints() {
    return readPoints().points.slice().sort((a, b) => b.count - a.count || String(a.id).localeCompare(String(b.id)))
  }

  /**
   * 新建或编辑一个点。
   * - 不带 `id` = 新建：**先按归一化标题查重**，已存在就并入它（这就是
   *   "类似的评论总结为同一个点"的手工版本）；
   * - 带 `id` = 编辑那一条（标题/摘要/分类都能改）。
   */
  function upsertPoint({ id = '', kind = 'bad', title, summary = '' } = {}) {
    const valid = validatePoint({ kind, title, summary })
    if (!valid.ok) return valid
    const t = String(title).trim()
    const s = String(summary ?? '').trim()
    const table = readPoints()
    const now = Date.now()

    if (id) {
      const hit = table.points.find((p) => p.id === String(id))
      if (!hit) return { ok: false, why: `没有这个点：${id}` }
      const merged = table.points.find((p) => p.id !== hit.id && normalizePointTitle(p.title) === normalizePointTitle(t))
      if (merged) {
        // 编辑后的标题和另一个点撞了 ⇒ 并入那一个（合并计数），删掉自己
        merged.count += hit.count
        merged.summary = s || merged.summary
        merged.updatedAt = now
        const rest = table.points.filter((p) => p.id !== hit.id)
        writePoints(rest)
        return { ok: true, point: merged, merged: true }
      }
      hit.kind = kind
      hit.title = t
      hit.summary = s
      hit.source = hit.source === 'seed' ? 'manual' : hit.source
      hit.updatedAt = now
      writePoints(table.points)
      return { ok: true, point: hit, updated: true }
    }

    const existing = table.points.find((p) => normalizePointTitle(p.title) === normalizePointTitle(t))
    if (existing) {
      // 已经有一个"同一个意思"的点：并进去，不新增（否则点表会长出一堆同义条目）
      existing.count += 0
      existing.summary = s || existing.summary
      if (kind !== existing.kind) existing.kind = kind
      existing.updatedAt = now
      writePoints(table.points)
      return { ok: true, point: existing, merged: true }
    }
    const point = { id: nextPointId(table.points), kind, title: t, summary: s, count: 0, source: 'manual', createdAt: now, updatedAt: now }
    writePoints([...table.points, point])
    return { ok: true, point, created: true }
  }

  /** 删一个点。**如实报出有多少条评分引用过它**（引用不会跟着删，报告里会显示"已删除的点"）。 */
  function deletePoint(id) {
    const key = String(id ?? '')
    const table = readPoints()
    const hit = table.points.find((p) => p.id === key)
    if (!hit) return { ok: false, why: `没有这个点：${key}` }
    const usedBy = Object.values(readScores().scores).filter((s) => (s.points ?? []).includes(key)).length
    writePoints(table.points.filter((p) => p.id !== key))
    return { ok: true, removed: hit, usedBy }
  }

  /**
   * 把**整理**产出（或本地聚类产出）的点并进点表。
   *
   * 合并判据 = **归一化标题相同**（`太长` / `太长了` / `太长。` 是同一个点）。
   * `count += evidence.length || 1`：被几条评论支撑就算几次 —— 这是"点排行"的输入。
   */
  function mergePoints(incoming = [], source = 'consolidated') {
    const table = readPoints()
    const now = Date.now()
    let created = 0
    let merged = 0
    for (const raw of incoming) {
      const valid = validatePoint({ kind: raw?.kind, title: raw?.title, summary: raw?.summary ?? '' })
      if (!valid.ok) continue // 模型可能给出空标题：跳过，不写半个点
      const t = String(raw.title).trim()
      const s = String(raw.summary ?? '').trim()
      const n = Math.max(1, Array.isArray(raw.evidence) ? raw.evidence.length : 1)
      const hit = table.points.find((p) => normalizePointTitle(p.title) === normalizePointTitle(t))
      if (hit) {
        hit.count += n
        hit.summary = s || hit.summary // 摘要以新值覆盖旧的（新的通常更贴近现在的说法）
        if (raw.kind === 'good' || raw.kind === 'bad') hit.kind = raw.kind
        hit.updatedAt = now
        merged += 1
        continue
      }
      table.points.push({
        id: nextPointId(table.points),
        kind: raw.kind === 'good' ? 'good' : 'bad',
        title: t,
        summary: s,
        count: n,
        source,
        createdAt: now,
        updatedAt: now,
      })
      created += 1
    }
    writePoints(table.points)
    return { ok: true, created, merged, total: table.points.length, points: table.points }
  }

  /**
   * **幂等播种**：点表为空时落一份初始的点；非空时**一个字都不动**。
   *
   * ★ 为什么必须幂等且不覆盖：使用者会编辑这些点（改标题/摘要/删除）。
   *   如果每次启动都"补种"，他删掉的那条会**自己回来** —— 那是最让人不敢用的行为
   *   （与 `personas.mjs` 的"删掉之后不许自己回来"是同一条纪律）。
   * ★ 为什么这里**不调模型**：启动就花钱是不可接受的，而且模型调用必须是人点一下才发生
   *   （见 API.md）。所以有评论时用**本地聚类**给出初始点，模型整理仍然由人触发。
   *
   * @param {object} opts
   * @param {object[]} [opts.points] 要播的点（默认 `SEED_POINTS`）
   * @param {object[]} [opts.comments] 已有的评论（有则先聚类，产出更贴近他的初始点）
   */
  function seedPointsIfEmpty({ points = SEED_POINTS, comments = [] } = {}) {
    const table = readPoints()
    if (table.points.length) return { ok: true, seeded: 0, why: '点表非空，不播种（使用者编辑过的点不许被覆盖）' }

    const fromComments = []
    if (Array.isArray(comments) && comments.length) {
      for (const kind of ['bad', 'good']) {
        for (const c of clusterComments({ comments, verdict: kind })) {
          fromComments.push({
            kind,
            title: c.text.length > 24 ? `${c.text.slice(0, 24)}…` : c.text,
            summary: `由 ${c.count} 条评论聚类得出（本地聚类，未调模型；你可以改标题或删掉它）。全部原话：${c.text}`,
          })
        }
      }
    }
    const use = fromComments.length ? fromComments : points
    const src = fromComments.length ? 'consolidated' : 'seed'
    const now = Date.now()
    const seeded = use.map((p, i) => ({
      id: `p-${i + 1}`,
      kind: p.kind === 'good' ? 'good' : 'bad',
      title: String(p.title).trim(),
      summary: String(p.summary ?? '').trim(),
      count: 0,
      source: src,
      createdAt: now,
      updatedAt: now,
    }))
    writePoints(seeded)
    log(`[评审台] 点表为空 → 播下 ${seeded.length} 个初始的点（来源：${src === 'seed' ? '内置种子（使用者原话的归纳）' : '已有评论的本地聚类'}）`)
    return { ok: true, seeded: seeded.length, source: src, points: seeded }
  }

  // ── 整理（consolidation）──────────────────────────────────────────────
  function consolidationPath(id) {
    return join(consolidateDir, `${String(id)}.json`)
  }

  /** 存一份整理结果（点 + 改写 + 锚点核对 + diff）。 */
  function saveConsolidation({ scope = 'all', result, styleBefore = '' } = {}) {
    if (!result?.rewritten) return { ok: false, why: '整理结果里没有改写后的正文' }
    const id = `c-${new Date().toISOString().replace(/[:.]/g, '-')}`
    const record = {
      version: REVIEW_VERSION,
      id,
      scope: String(scope),
      createdAt: Date.now(),
      points: result.points ?? [],
      rewritten: result.rewritten,
      dropped: result.dropped ?? [],
      anchors: result.anchors ?? checkAnchors({ text: result.rewritten, anchors: STYLE_ANCHORS }),
      model: result.model ?? null,
      ms: result.ms ?? null,
      usage: result.usage ?? null,
      promptStats: result.promptStats ?? null,
      via: result.via ?? null,
      styleBeforeSha: sha256(styleBefore),
      styleBeforeChars: String(styleBefore ?? '').length,
      chars: String(result.rewritten).length,
      diff: unifiedDiff(styleBefore, result.rewritten, { aName: 'styles/闲聊.md', bName: 'styles/闲聊.md' }),
      appliedAt: null,
      applyResult: null,
    }
    writeJsonAtomic(consolidationPath(id), record)
    // ★ 整理产出的点**并进点表**（不是只留一份快照）：点表是长期存在的评论词汇表，
    //   下次打分时它们就出现在原来标签按钮的位置上。
    const merge = mergePoints(result.points ?? [], 'consolidated')
    return { ok: true, consolidation: record, points: merge }
  }

  function listConsolidations() {
    if (!existsSync(consolidateDir)) return []
    try {
      return readdirSync(consolidateDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson(join(consolidateDir, f), null, log))
        .filter(Boolean)
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    } catch (error) {
      log(`⚠️ [评审台] 列整理记录失败：${error?.message ?? error}`)
      return []
    }
  }

  const latestConsolidation = (scope) =>
    listConsolidations().find((c) => String(scope ?? 'all') === 'all' || String(c.scope) === String(scope)) ?? null

  /**
   * 应用改写草稿：**唯一的、会碰机器人人格的写操作**。
   *
   * 顺序不能换：读最新文件（别人可能刚改过）→ 判重（同一份不许写两遍）→
   * **锚点核对**（丢了底线要点就拒绝，除非人明确覆盖）→ **先备份** → 原子写 →
   * 再同步出厂常量（`src/chat-mode.mjs`）→ 标记已应用。
   *
   * @returns {{ok: boolean, why?: string, code?: number, ...}}
   */
  function applyDraft({ consolidationId = '', scope = 'all', confirm = false, confirmAnchors = false } = {}) {
    if (confirm !== true) return { ok: false, why: '没有确认。应用会改写 styles/闲聊.md，必须显式确认', code: 400 }
    const record = consolidationId
      ? listConsolidations().find((c) => c.id === String(consolidationId))
      : latestConsolidation(scope)
    if (!record) return { ok: false, why: '还没有可应用的整理结果（先去报告页点「整理评论」）', code: 400 }
    if (!String(record.rewritten ?? '').trim()) return { ok: false, why: '这份整理结果里没有正文', code: 400 }

    let current = ''
    try {
      current = existsSync(styleFile) ? readFileSync(styleFile, 'utf8') : ''
    } catch (error) {
      return { ok: false, why: `读不出风格文件：${error?.message ?? error}`, code: 500 }
    }
    if (current.trim() === String(record.rewritten).trim()) {
      return { ok: false, why: '这份改写已经在文件里了（内容和现在一模一样），不重复写', code: 409 }
    }

    const anchors = record.anchors ?? checkAnchors({ text: record.rewritten, anchors: STYLE_ANCHORS })
    if (!anchors.ok && confirmAnchors !== true) {
      return {
        ok: false,
        code: 409,
        anchorsMissing: anchors.missing,
        why:
          `这份改写丢了 ${anchors.missing.length} 条底线要点：${anchors.missing.map((m) => m.label).join('、')}。` +
          '改这份文件有风险，所以**拒绝应用** —— 你可以让模型重写一次，或者明确选择"仍然应用"（会先备份）。',
      }
    }

    const backupDir = join(dirname(styleFile), '.backups')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = join(backupDir, `${styleFile.split(/[\\/]/).pop()}.${stamp}.bak`)
    try {
      mkdirSync(backupDir, { recursive: true })
      writeFileSync(backup, current, 'utf8')
      const tmp = `${styleFile}.${process.pid}.tmp`
      writeFileSync(tmp, String(record.rewritten), 'utf8')
      renameSync(tmp, styleFile)
    } catch (error) {
      return { ok: false, why: `写风格文件失败（备份在 ${backup}）：${error?.message ?? error}`, code: 500 }
    }

    // 出厂默认常量跟着走（否则 `styles/闲聊.md` 与它开始漂，测试会红）
    let constantSync = { ok: false, why: '没有接 chat-mode.mjs 的路径（chatModePath 没传）' }
    if (chatModePath) {
      constantSync = syncStyleConstant({ chatModePath, styleText: String(record.rewritten), log })
    }

    const after = (() => {
      try {
        return readFileSync(styleFile, 'utf8')
      } catch {
        return ''
      }
    })()
    const applyResult = {
      at: Date.now(),
      backup,
      chars: after.length,
      beforeChars: current.length,
      anchors: anchors.ok ? 'ok' : 'overridden',
      constantSync: constantSync.ok ? { ok: true, changed: constantSync.changed } : { ok: false, why: constantSync.why },
    }
    writeJsonAtomic(consolidationPath(record.id), { ...record, appliedAt: Date.now(), applyResult })
    log(
      `[评审台] 已应用改写：${current.length} → ${after.length} 字（${after.length <= current.length ? '精简' : '增加'} ` +
        `${Math.abs(after.length - current.length)}），备份 ${backup}`,
    )
    if (!constantSync.ok) {
      log(`⚠️ [评审台] 出厂默认常量没同步成功：${constantSync.why}`)
    }
    return {
      ok: true,
      consolidationId: record.id,
      backup,
      sha256: sha256(after),
      beforeChars: current.length,
      chars: after.length,
      anchorsOverridden: !anchors.ok,
      constantSync: applyResult.constantSync,
    }
  }

  return {
    dir,
    listBatches,
    createBatch,
    readBatch,
    deleteBatch,
    progress,
    saveScore,
    findBatchOf,
    undo,
    stats,
    comments,
    // ── 点表（顶替原标签的那套东西：长期存在、可编辑）──
    listPoints,
    upsertPoint,
    deletePoint,
    mergePoints,
    seedPointsIfEmpty,
    saveConsolidation,
    listConsolidations,
    latestConsolidation,
    applyDraft,
    /** 给 `/api/items` 用：某批次的条目 + 评分（分页是 HTTP 层的事）。 */
    itemsWithScores(scope) {
      const { items, metas } = collect(scope)
      const scores = readScores().scores
      return { items: items.map((it) => ({ ...it, score: scores[it.id] ?? null })), metas }
    },
    scores: () => readScores().scores,
    invalidate() {
      knownIds = null
    },
    files: { index: indexPath, scores: scoresPath, dir, batches: () => readdirSync(dir), consolidations: consolidateDir },
  }
}
