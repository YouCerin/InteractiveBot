/**
 * 聊天记录评审台 —— **数据层**：评分怎么存、统计怎么算、标签与修改意见怎么落。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 2026-10-02 的三次形状变更（使用者每次都在页面上看到了问题）
 * ══════════════════════════════════════════════════════════════════════════
 * **第一版**：我预先写好一张标签税则，人从里面选 → 按标签统计 → 反例清单追加到文件尾。
 * 使用者：「标签系统并不合理，我的习惯是对说得对与不对的地方进行评论」。
 * → 于是删掉税则、评论成为一等公民，"点"改由模型从评论里归纳。
 *
 * **第二版**：模型归纳出的"点"自动并进点表，并在启动时**播种**，页面上就出现了
 * 一整排按钮。使用者看到的效果：**按钮名是长句子**（播种用的是聚类出来的原话，
 * 一条 40 字的评论就成了一个"标签"），糊成一片没法点；而且他明确要求
 * **「标签系统改为人工写标签」**、**「整理不再自动往标签表里塞东西」**。
 * → 于是：
 *   · **标签人工写**（新建 / 改名 / 改说明 / 删），标题**限 12 字**（它是按钮上的字，
 *     不是一句话；40 字的标题在按钮上就是灾难 —— 这是实测出来的）；
 *   · **取消自动并入与启动播种**（那条路已经整个删掉，`SEED_POINTS` / `mergePoints` /
 *     `seedPointsIfEmpty` 都不在了 —— 留着"没人调但会写使用者数据"的函数是隐患）；
 *   · 整理**不再产出标签**，它产出的是**修改意见**。
 *
 * **第三版**：产物从"整篇重写 styles/闲聊.md"改成**逐条修改意见**。
 * 使用者：「最终基于评价过的消息记录和评论，生成闲聊.md 的修改意见」+
 * 「只要意见，修改内容由 LLM 另外执行」。所以：
 *   · 本模块**不再写那份文案**、**不再同步任何常量** ——
 *     应用/备份/常量同步那整条路都删了（`applyDraft` 不存在了）；
 *   · 意见以 `suggestions` 存在整理记录里（针对现有哪一条 → 建议怎么改 → 为什么）。
 *   · ★ 为什么这是对的：上一版实测跑出来 **2389 → 2388 字**，等于把原文件还给我 ——
 *     整篇重写在这个场景里没有产出价值，而"该改哪一条"才是人能直接用的东西。
 *
 * **0.3.0alpha 补注**：上述文案的位置搬过两次 ——
 * `styles/闲聊.md` → 第一步 `src/voice.mjs` 的 `VOICE_STYLE` → **第二步：就在人设文件里**
 * （`personas/小鲸鱼（完整带情绪）.md`）。本模块的**行为一个字没变** ——
 * 它本来就不关心那份文案在哪，只看调用方传进来的 `styleBefore`。
 *
 * ── 写操作只剩两件（都在工作区 `runtime/chat-review/` 下）─────────────────
 *   ① 评分；② 标签的增删改；③ 删批次。**再也不碰机器人的人格文件。**
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createHash } from 'node:crypto'

/** 文本 sha256（"这份意见是针对哪一版提的"就靠它）。 */
function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

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

/**
 * 标签标题/说明的长度上限。
 *
 * ★★ 标题 **12 字**是实测定的（2026-10-02，使用者看到截图后反馈）：
 *   上一版是 40 字，而"自动播种"把一整句评论（「不合适打招呼逻辑，一句改成这个话
 *   有点冗杂…」）塞成了标签名 —— 一排长句子糊在一起，**没法快速点**，
 *   这个功能存在的意义（"方便我便捷评论"）当场就没了。
 *   标题是**按钮上的字**，说明（可以长）放在 `summary` 里当 hover 提示。
 */
export const POINT_TITLE_MAX_CHARS = 12
export const POINT_SUMMARY_MAX_CHARS = 300

/**
 * 标签标题的**归一化**（只用于"这是不是同一个标签"的比较，不改写原文）。
 *
 * 它处理的是**写法差异**：全角/半角、空白、末尾标点 —— 所以 `太长。` 与 `太长`
 * 会被认成同一个（新建时会并入已有那条，不让同义标签长两条）。
 *
 * ⚠️ 它**不做词形归并**：`太长` 与 `太长了` 归一化后仍然不同（中文没有可靠的后缀词干化，
 *   硬做只会把不相干的词并到一起）。所以"这两条是不是同一个意思"最终还是**人**说了算 ——
 *   页面上可以把一条的标题改成另一条的名字，那时两条会自动并起来。
 *   （第一版的注释在这里吹过牛，说 `太长了` 也会被并 —— 那是错的，实测过。）
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
  // ★★ 「有评论」的**新口径**（使用者 2026-10-02：「选择标签已经相当于评论了」）：
  //   只点标签、没写字的评分**不能算成"没评论"** —— 那会把它们排除在整理之外，
  //   而人明明已经用标签把判断表达出来了。∴ 另立 withContent（文本**或**标签）。
  let withContent = 0
  let tagsOnly = 0

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
    if (comment) withText += 1
    // ── 标签：这条评了哪几个标签（(a) 语义：标签与评论**各自留痕**，谁都不覆盖谁）──
    const pointIds = Array.isArray(s.points) ? s.points.filter(Boolean) : []
    const points = pointIds.map((pid) => {
      const p = pointsById[pid]
      perPoint.set(pid, (perPoint.get(pid) ?? 0) + 1)
      // 点被删掉之后 id 会悬空：**如实显示 id**，不编一个标题出来
      return p ? { id: pid, kind: p.kind, title: p.title } : { id: pid, kind: '', title: `（已删除的标签 ${pid}）` }
    })
    if (points.length) withPoints += 1
    // 新口径：有文本**或**有点标签 ⇒ 这条"有评论"（只点标签的那些不再被当成没评论）
    if (comment || points.length) {
      withContent += 1
      if (!comment && points.length) tagsOnly += 1
      if (byVerdict[s.verdict] !== undefined) byVerdict[s.verdict] += 1
    }
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
    comments: {
      // 自由文本口径（与旧版一致）：只有写了字才算 withText
      withText,
      withoutText: scored - withText,
      // ★「有评论」的**新口径**：有文本**或**有点标签（使用者：点标签就等于评论）
      withContent,
      tagsOnly,
      // byVerdict 按**新口径**统计 —— 它就是页面上"有评论的按档分布"
      byVerdict,
    },
    /** 点被点了多少次（`{ [pointId]: n }`）—— 报告页的"点排行"用它。 */
    pointCounts: Object.fromEntries([...perPoint.entries()].sort((a, b) => b[1] - a[1])),
    pointsUsed: withPoints,
    chats: [...perChat.values()].sort((a, b) => b.scored - a.scored || a.chatKey.localeCompare(b.chatKey)),
    /** 评论清单：报告页显示它，「整理」把它喂给模型。 */
    list,
  }
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
 * ⚠️ 它**不需要**那份文案的路径 —— 这一版不写它（产物是修改意见，
 * 由人拿去给 LLM 执行）。那份文案的正文由调用方读好后作为 `styleBefore` 传进
 * `saveConsolidation`，只用来记"这份意见是针对哪个版本提的"。
 * （0.3.0alpha 第二步：那段正文就是**人设文件本身**，由 `chat-review-server.mjs` 现读。）
 *
 * @param {object} opts
 * @param {string} opts.workspace 工作区（评审数据写在它下面）
 * @param {(m: string) => void} [opts.log]
 */
export function createReviewStore({ workspace, log = () => {} } = {}) {
  const root = String(workspace ?? '')
  if (!root) throw new Error('没有工作区，评审数据无处可放')
  const dir = join(root, REVIEW_REL)
  const indexPath = join(dir, 'index.json')
  const scoresPath = join(dir, 'scores.json')
  const consolidateDir = join(dir, 'consolidations')
  const failedDir = join(dir, 'failed')
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

  /** 标签表（`points.json`）。读坏不静默 —— 表空了会让人以为"我的标签丢了"。 */
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
            // ★ 新口径：有文本**或**有点标签都算"有评论"（点标签就等于评论）
            if (String(s.comment ?? '').trim() || (Array.isArray(s.points) && s.points.length)) commented += 1
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
    // ★ 标签必须是标签表里真有的：写进一个不存在的 id，报告里就会冒出一条点不到的标签
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

  /**
   * 「有评论」的评分（**整理**的输入）。
   *
   * ★★ 口径（使用者 2026-10-02 修正）：**点标签就等于评论** ——
   *   所以"只点了标签、没写字"的那些**也要**进来。第一版只收自由文本，
   *   于是它们被标成"未评论"并被排除在整理之外，而人明明已经表达过判断了。
   */
  function comments(scope) {
    return stats(scope).list.filter((row) => row.comment || row.points?.length)
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
   * 新建或编辑一个标签。
   * - 不带 `id` = 新建：先按归一化标题查重（`太长。` 与 `太长` 算同一条，**词形不同不算**），
   *   已存在就并入它、不新增（否则标签表会长出一堆同义条目）；
   * - 带 `id` = 编辑那一条（标题/说明/分类都能改）。
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
      if (!hit) return { ok: false, why: `没有这个标签：${id}` }
      const merged = table.points.find((p) => p.id !== hit.id && normalizePointTitle(p.title) === normalizePointTitle(t))
      if (merged) {
        // 编辑后的名字和另一个标签撞了 ⇒ 并入那一个（合并计数），删掉自己
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
      // 已经有一个"同一个意思"的标签：并进去，不新增（否则标签表会长出一堆同义条目）
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

  /**
   * 删一个标签。**如实报出有多少条评分引用过它**（引用不会跟着删，报告里会显示"已删除的标签"）。
   */
  function deletePoint(id) {
    const key = String(id ?? '')
    const table = readPoints()
    const hit = table.points.find((p) => p.id === key)
    if (!hit) return { ok: false, why: `没有这个标签：${key}` }
    const usedBy = Object.values(readScores().scores).filter((s) => (s.points ?? []).includes(key)).length
    writePoints(table.points.filter((p) => p.id !== key))
    return { ok: true, removed: hit, usedBy }
  }

  /**
   * **清掉"自动塞进来的长标题标签"**（一次性清理，给升级到 12 字上限之前的数据用）。
   *
   * ★ 为什么要有它：上一版会在启动时**自动播种**（用聚类出来的原话当标题），
   *   使用者的点表里因此躺着一排长句子标签 —— 而这一版已经取消播种。
   *   让人一条条手点删除不合理，所以给一个明确的清理动作：
   *   **只删"来源不是手写"（source !== 'manual'）且标题超过 12 字**的那些，
   *   手写的、短的一律不动（有断言）。
   */
  function pruneLongAutoPoints() {
    const table = readPoints()
    const doomed = table.points.filter(
      (p) => p.source !== 'manual' && [...String(p.title ?? '')].length > POINT_TITLE_MAX_CHARS,
    )
    if (!doomed.length) return { ok: true, removed: 0, ids: [] }
    const ids = new Set(doomed.map((p) => p.id))
    writePoints(table.points.filter((p) => !ids.has(p.id)))
    return { ok: true, removed: doomed.length, ids: [...ids] }
  }

  // ── 整理（consolidation）──────────────────────────────────────────────
  function consolidationPath(id) {
    return join(consolidateDir, `${String(id)}.json`)
  }

  /**
   * 存一份**修改意见**（针对那份说话方式里现有哪一条 → 建议怎么改 → 为什么）。
   *
   * ★ 为什么不再存"改写后的整篇"：实测那一版的产出是 2389 → 2388 字（等于把原文件
   *   还回来），而使用者要的是**能直接执行的修改意见**（「只要意见，修改内容由 LLM
   *   另外执行」）。所以这里存的是 `suggestions`，而且**本模块从此不写那份文案**。
   *
   * @param {object} opts
   * @param {object[]} opts.result.suggestions 意见数组（`{action,target,advice,reason,evidence}`）
   * @param {string} [opts.styleBefore] 这份意见是针对哪个版本提的（存 sha 做对照）
   */
  function saveConsolidation({ scope = 'all', result, styleBefore = '' } = {}) {
    const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : []
    if (!suggestions.length) return { ok: false, why: '整理结果里一条修改意见都没有' }
    const id = `c-${new Date().toISOString().replace(/[:.]/g, '-')}`
    const record = {
      version: REVIEW_VERSION,
      id,
      scope: String(scope),
      createdAt: Date.now(),
      suggestions,
      notes: String(result.notes ?? ''),
      // ★ 锚点不再是"应用前的门禁"，而是**提示**：哪些底线要点这份意见覆盖到了、
      //   哪些一条都没提（人自己判断"要不要动它们"）。
      // ★ 不再"没给就重算"：`consolidateComments()` 无条件给出这一项，仓内两个调用点都传完整 result。
      //   重算意味着**存储层依赖归纳层**（store → consolidate），而这个模块的职责是"你给什么我存什么"；
      //   真有人直调 store 又没给这一项时，落一个**空覆盖**（形状不变、页面用 `?.` 读得动），
      //   而不是让一个存储层去替归纳层猜结果。
      anchorCoverage: result.anchorCoverage ?? { covered: [], uncovered: [] },
      model: result.model ?? null,
      ms: result.ms ?? null,
      usage: result.usage ?? null,
      promptStats: result.promptStats ?? null,
      via: result.via ?? null,
      styleBeforeSha: sha256(styleBefore),
      styleBeforeChars: [...String(styleBefore ?? '')].length,
      // ⚠️ 刻意**不留** `rewritten` / `diff` / `appliedAt` —— 这一版没有"应用"这件事了。
    }
    writeJsonAtomic(consolidationPath(id), record)
    return { ok: true, consolidation: record }
  }

  /**
   * **把"整理没成"连同模型原文一起落盘**（2026-10-03 补）。
   *
   * 为什么必须落盘：使用者 2026-10-03 报整理失败时，系统手上只有一句
   * `模型的 JSON 解析失败（已尝试修复 1 处仍未通过）：… position 2343 …`，
   * 而**模型原文一个字节都没留** —— 只能靠合成相似的坏 JSON 反推形状。
   * 这正是本项目最贵的一类缺陷（"失败但没有证据"；`bridge.mjs` 抽取那段
   * 已经为同一件事付过一次学费，见那里的注释）。
   *
   * 落在 `runtime/chat-review/failed/<时间>.json`，只留最近 20 份：
   * 它是排查素材，不是归档 —— 不限量的话这个目录很快就被淹掉，反而没人看。
   */
  function saveFailure({ scope = 'all', why = '', raw = '', at = Date.now() } = {}) {
    const id = `f-${new Date(at).toISOString().replace(/[:.]/g, '-')}`
    const abs = join(failedDir, `${id}.json`)
    writeJsonAtomic(abs, {
      version: REVIEW_VERSION,
      id,
      scope: String(scope),
      createdAt: at,
      why: String(why ?? ''),
      chars: [...String(raw ?? '')].length,
      raw: String(raw ?? ''),
    })
    // 时间戳前缀排出来就是时间序，直接从旧到新删
    try {
      const files = readdirSync(failedDir).filter((f) => f.endsWith('.json')).sort()
      for (const f of files.slice(0, Math.max(0, files.length - 20))) unlinkSync(join(failedDir, f))
    } catch (error) {
      log(`⚠️ [评审台] 清理旧的失败原文失败（不影响这次记录）：${error?.message ?? error}`)
    }
    return { ok: true, id, file: abs, chars: [...String(raw ?? '')].length }
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
    // ── 标签表（人工写的：新建/改名/改说明/删）──
    listPoints,
    upsertPoint,
    deletePoint,
    pruneLongAutoPoints,
    saveConsolidation,
    listConsolidations,
    latestConsolidation,
    // ── 整理失败时的模型原文（落盘给排查用；见 saveFailure 的注释）──
    saveFailure,
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
    files: {
      index: indexPath,
      scores: scoresPath,
      dir,
      batches: () => readdirSync(dir),
      consolidations: consolidateDir,
      failed: failedDir,
    },
  }
}
