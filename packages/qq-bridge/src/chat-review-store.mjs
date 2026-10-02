/**
 * 聊天记录评审台 —— **数据层**：评分怎么存、统计怎么算、修订草稿怎么生成。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════════════════════
 * 「让小鲸鱼说话别那么像 AI」这件事，到目前为止是靠**人工读聊天记录、凭印象改
 * `styles/闲聊.md`**。印象有两个毛病：① 说不清"到底违反得最多的是哪一条"；
 * ② 改完没有任何对照物，只能靠再读一遍聊天记录。
 *
 * 所以这个工具把"印象"变成**可数的证据**：人一条条打分 → 每个标签命中多少次 →
 * 哪条规则最常被违反 → 把真实的反例组织成一段可以贴进风格文件的文本。
 *
 * ── 标签为什么必须挂在规则上（`ruleQuote`）──────────────────────────────
 * 标签是"哪条规则没被遵守"的计数器。如果标签与规则是两套东西，它们一定会漂：
 * 风格文件删了一条规则，标签还照旧统计，报告于是开始描述一个不存在的判据。
 * 所以每个标签都带一句 `ruleQuote`（`styles/闲聊.md` 里的**原文片段**），
 * `taxonomyDrift()` 会去核对它还在不在 —— 有断言盯着这件事。
 *
 * ── 写操作只有三件，且都留痕 ──────────────────────────────────────────────
 *   ① 评分（写工作区里的评审数据）；② 删批次（同上）；③ **应用草稿**（写风格文件）。
 * 第三件是唯一碰"机器人人格"的操作，所以它：先算 diff 给人看 → 人点确认 →
 * **先备份** → 再原子写 → 返回新 sha256。**没有"默认应用"这件事。**
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 评审数据放在工作区的 `runtime/` 下（与语料库、任务台账同级；不进发布包）。 */
export const REVIEW_REL = 'runtime/chat-review'

/** 数据文件版本。读到不认识的版本时**拒绝写**（宁可报错，也不要写坏）。 */
export const REVIEW_VERSION = 1

/** 三档结论（`key` 是页面上的键盘快捷键）。 */
export const VERDICTS = [
  { id: 'good', label: '就该这么说', key: '1' },
  { id: 'ok', label: '还行', key: '2' },
  { id: 'bad', label: '不该这么说', key: '3' },
]

/**
 * 标签税则。
 *
 * `ruleQuote` = `styles/闲聊.md` 里的原文片段（**必须真的存在**，见 `taxonomyDrift`）。
 * `advice` = 报告页上"这条被违反这么多次，该怎么办"的一句话。
 * `kind` = `bad`（不该这样）或 `good`（这样很好，报告里分开统计）。
 */
export const TAGS = [
  // ── 不该这样 ────────────────────────────────────────────────────────────
  { id: 'too_long', label: '太长', kind: 'bad', ruleQuote: '极短',
    hint: '一句话能说完的事写成一整段', advice: '「极短」这条要么被忽略了、要么不够显眼，考虑把它挪到更靠前的位置。' },
  { id: 'webby', label: '报告腔/分点', kind: 'bad', ruleQuote: '不用「首先/其次/最后/综上所述」',
    hint: '首先/其次、编号、清单、总结式结尾', advice: '「不写编号清单」这条要写得更具体（点出最容易冒出来的那几个词）。' },
  { id: 'customer_service', label: '像客服', kind: 'bad', ruleQuote: '不主动揽活',
    hint: '「有什么可以帮您」「需要我看点什么吗」这类', advice: '客服腔是最好认的一类，值得直接列成反例清单。' },
  { id: 'over_explain', label: '解释自己', kind: 'bad', ruleQuote: '不科普、不解释自己为什么这么说',
    hint: '给理由、给自己的说法做辩护、展开"可以从三个角度看"', advice: '「不解释自己」这条被违反得多，说明它需要在闲聊节里更靠前。' },
  { id: 'ellipsis', label: '省略号滥用', kind: 'bad', ruleQuote: '省略号只在"无语"的时候用',
    hint: '每句都挂一个「……」，当语气装饰用', advice: '把它降级成"只在无语时用"，并配 2 条真实坏例效果最好。' },
  { id: 'memory_detail', label: '主动抖记忆', kind: 'bad', ruleQuote: '别主动抖记忆里的细节',
    hint: '把记忆里的细节（显卡/机箱/主板）搬出来当谈资', advice: '这条最容易复发，反例清单里要留它最典型的那一条。' },
  { id: 'self_intro', label: '顺势自述', kind: 'bad', ruleQuote: '问到你自己时只给结论',
    hint: '问一句答一整套自我介绍', advice: '规则已写明"只给结论"，被违反说明要给一个"只答一句"的正面例子。' },
  { id: 'ask_for_work', label: '主动揽活', kind: 'bad', ruleQuote: '不主动揽活',
    hint: '「要我写一版吗」「还要我做什么」', advice: '这是使用者点名的第一条禁令，再违反就该把反例贴出来。' },
  { id: 'self_deprecate', label: '自贬/表忠心', kind: 'bad', ruleQuote: '不自贬、不表忠心',
    hint: '「傻就傻吧，反正你叫我还是会应」这类', advice: '使用者点名的第二条禁令；反例固定，直接贴原话最有效。' },
  { id: 'generic_meme', label: '没接住对方的戏', kind: 'bad', ruleQuote: '接梗 = 顺着对方的戏往下演',
    hint: '对方在演、在玩某个设定，它却解释梗、换话题、或干脆拆台', advice: '「接梗 = 顺着对方的戏往下演」这条要在文件里更靠前、并配 2 条真实例子（ciallo / 修理 / 手机）。' },
  { id: 'submit_flat', label: '把戏演成了屈服', kind: 'bad', ruleQuote: '不是屈服',
    hint: '对方只是摆姿态/演角色，它却真的低头认输、或反过来真的谄媚', advice: '「敬语是台词，不是认输」这句要更显眼 —— 这条的两端（太硬 / 太软）都会出错。' },
  { id: 'no_context', label: '没接上一句', kind: 'bad', ruleQuote: '接着上一句往下说',
    hint: '答非所问、从零开始起一个新话题', advice: '这条属于"看起来没错但很出戏"，值得配正面例子而不是禁令。' },
  { id: 'rude_when_down', label: '低落时还玩梗', kind: 'bad', ruleQuote: '别人真的低落、遇到麻烦：收起玩梗',
    hint: '对方在认真难受，它还在抖机灵', advice: '底线类规则，反例要留；必要时提到"底线"那一节的开头。' },
  { id: 'made_up_fact', label: '编事实', kind: 'bad', ruleQuote: '不确定的事实**不要编**',
    hint: '把不确定的事说得像查过一样', advice: '这是全项目最忌讳的一类，反例清单里单列。' },
  { id: 'sexual_mishandle', label: '暗示没看懂/没拒绝', kind: 'bad', ruleQuote: '先表明你看懂了，再明说不搞',
    hint: '装傻、顺着接、或者反过来长篇说教', advice: '使用者给了明确的期望回复，把那条原话留在反例旁边最有效。' },
  { id: 'seniority_flat', label: '摆资历没顺着演', kind: 'bad', ruleQuote: '把他的姿态当剧本演下去',
    hint: '对方摆老资历，它拒绝配合、或反过来真的谄媚', advice: '这条的两端都会出错（太硬/太软），正反例都值得留。' },
  { id: 'other_bad', label: '其他（备注里写）', kind: 'bad', ruleQuote: '',
    hint: '不属于上面任何一条，但你知道它不对', advice: '' },

  // ── 这样很好（报告里分开统计）──────────────────────────────────────────
  { id: 'good_brief', label: '极短且够用', kind: 'good', ruleQuote: '极短',
    hint: '一句话说完，还接住了', advice: '' },
  { id: 'good_meme', label: '接住了对方的戏', kind: 'good', ruleQuote: '接梗 = 顺着对方的戏往下演',
    hint: '用同一个设定/角色接下去，一句就到位', advice: '' },
  { id: 'good_seniority', label: '陪着演还拆台', kind: 'good', ruleQuote: '把他的姿态当剧本演下去',
    hint: '敬语照给，后半句调侃（台词，不是认输）', advice: '' },
  { id: 'good_correction', label: '短一句给对的', kind: 'good', ruleQuote: '短一句给对的',
    hint: '对方说错，它不争辩，直接给对的', advice: '' },
  { id: 'good_refusal', label: '看懂也明说不搞', kind: 'good', ruleQuote: '先表明你看懂了，再明说不搞',
    hint: '表明看懂了 + 一句话拒绝', advice: '' },
  { id: 'good_ellipsis', label: '该无语时才用省略号', kind: 'good', ruleQuote: '省略号只在"无语"的时候用',
    hint: '省略号用得恰到好处', advice: '' },
]

/** 一遍就能查的标签表。 */
const TAG_BY_ID = new Map(TAGS.map((t) => [t.id, t]))

/**
 * 核对每个标签挂的规则原文还在不在风格文件里。
 *
 * @returns {{ok: boolean, drift: Array<{id: string, label: string, ruleQuote: string, why: string}>}}
 *   `ok: false` **不拦着用**（评审数据照样有效），但页面要显眼提示 ——
 *   它意味着"风格文件改过了，报告在描述一个已经不存在的判据"。
 */
export function taxonomyDrift({ styleText = '' } = {}) {
  const text = String(styleText ?? '')
  const drift = []
  for (const tag of TAGS) {
    if (!tag.ruleQuote) continue
    if (!text.includes(tag.ruleQuote)) {
      drift.push({
        id: tag.id,
        label: tag.label,
        ruleQuote: tag.ruleQuote,
        why: `这条标签挂的规则原文（「${tag.ruleQuote}」）在风格文件里找不到了`,
      })
    }
  }
  return { ok: drift.length === 0, drift }
}

/** 校验一次评分。返回 `{ok}` 或 `{ok:false, why}`（理由直接给页面看）。 */
export function validateScore({ verdict, tags = [], note = '' } = {}) {
  if (!VERDICTS.some((v) => v.id === verdict)) {
    return { ok: false, why: `结论只能是 ${VERDICTS.map((v) => v.id).join(' / ')}，收到的是「${verdict}」` }
  }
  const unknown = (Array.isArray(tags) ? tags : []).filter((t) => !TAG_BY_ID.has(t))
  if (unknown.length) return { ok: false, why: `不认识的标签 id：${unknown.join('、')}` }
  if (String(note ?? '').length > 1000) return { ok: false, why: '备注最多 1000 字' }
  return { ok: true }
}

// ══════════════════════════════════════════════════════════════════════════
// 纯函数：统计 / 草稿 / diff / 追加
// ══════════════════════════════════════════════════════════════════════════

/**
 * 统计（**纯函数**，所以能被测试直接喂数据）。
 *
 * @param {object} opts
 * @param {object[]} opts.items  条目（含 id / reply / context / chatKey / chatLabel）
 * @param {object} opts.scores   `{ [itemId]: score }`
 */
export function aggregateStats({ items = [], scores = {} } = {}) {
  const verdicts = { good: 0, ok: 0, bad: 0 }
  const perTag = new Map()
  const perChat = new Map()
  let scored = 0
  let bad = 0

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
    for (const id of s.tags ?? []) {
      const tag = TAG_BY_ID.get(id)
      if (!tag) continue // 税则改过、旧数据里有已删的标签：跳过而不是编一个
      const rec = perTag.get(id) ?? { id, label: tag.label, kind: tag.kind, count: 0, examples: [] }
      rec.count += 1
      if (rec.examples.length < 3) {
        rec.examples.push({
          id: item.id,
          reply: item.reply,
          context: (item.context ?? []).map((c) => `${c.name}：${c.text}`).join('\n'),
          verdict: s.verdict,
          note: s.note ?? '',
        })
      }
      perTag.set(id, rec)
    }
  }

  const tags = [...perTag.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
  return {
    verdicts,
    rate: {
      scored,
      total: items.length,
      good: scored ? verdicts.good / scored : 0,
      bad: scored ? bad / scored : 0,
    },
    tags,
    chats: [...perChat.values()].sort((a, b) => b.scored - a.scored || a.chatKey.localeCompare(b.chatKey)),
  }
}

/** 一条反例要写成什么样（`❌「原话」` + 当时对方说了什么）。 */
function exampleLines(rec, max = 2) {
  const out = []
  for (const ex of rec.examples.slice(0, max)) {
    const reply = String(ex.reply ?? '').replace(/\s*\n\s*/g, ' / ').trim()
    const ctx = String(ex.context ?? '').replace(/\s*\n\s*/g, ' / ').trim()
    out.push(`  - ❌「${reply}」`)
    if (ctx) out.push(`    当时对方说：「${ctx}」`)
    if (ex.note) out.push(`    评审备注：${ex.note}`)
  }
  return out
}

/** 草稿正文最多多少行（它是**要进提示词**的东西，不能无上限）。 */
export const DRAFT_MAX_LINES = 60

/**
 * 把统计结果组织成一段可以贴进风格文件的文本（**确定性生成，零模型调用**）。
 *
 * ★ 为什么产出的是"反例清单"而不是"新规则"：
 *   规则该由人写（它涉及取舍），而**反例是纯事实** —— 这段文本只是把真人标过的
 *   原话按规则归类列出来。它既不与现有规则冲突，也不假装知道该怎么改判据。
 *   建议（`advice`）留在报告页给人看，不写进文件。
 */
export function renderProposedBlock({ stats, now = Date.now(), maxLines = DRAFT_MAX_LINES } = {}) {
  const bad = (stats?.tags ?? []).filter((t) => t.kind === 'bad' && t.count > 0)
  if (!bad.length) return { block: '', usedTags: [], truncated: false }

  const when = new Date(now).toLocaleString('zh-CN', { hour12: false })
  const head = [
    '【评审台：真人标过「不该这么说」的原话（别再说成这样）】',
    `（来自 ${stats.rate?.scored ?? 0} 条人工评审，生成于 ${when}；这一节由聊天记录评审台生成，改它就等于改判据）`,
    '',
  ]
  const body = []
  const usedTags = []
  let truncated = false
  for (const rec of bad) {
    const lines = [`- 「${rec.label}」共 ${rec.count} 次：`, ...exampleLines(rec)]
    if (head.length + body.length + lines.length + 1 > maxLines) {
      truncated = true
      break
    }
    body.push(...lines)
    usedTags.push(rec.id)
  }
  if (truncated) {
    body.push(`（还有 ${bad.length - usedTags.length} 类没有列出来 —— 行数上限 ${maxLines}，它是要进提示词的）`)
  }
  return { block: [...head, ...body].join('\n').trimEnd(), usedTags, truncated }
}

/**
 * 统一 diff（LCS）。只给**人看**，不参与任何自动改写。
 *
 * 为什么不用外部 diff 库：这个项目零运行时依赖，而这里只需要"看个大概" ——
 * 追加一段文本的 diff 尤其简单。行内 LCS 对几百行足够快。
 */
export function unifiedDiff(aText, bText, { context = 3, aName = 'a', bName = 'b' } = {}) {
  const a = String(aText ?? '').split('\n')
  const b = String(bText ?? '').split('\n')
  // LCS 长度表（自底向上），再回溯出编辑序列
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

  // 只保留"改动附近 context 行"，其余折叠
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
    // 一个"块"：连续的 keep，中间允许夹着被折叠的（此处不折叠 —— 追加场景下几乎全是新增）
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

/**
 * 把草稿块追加到风格文件文本末尾（**纯函数**，代价与判断都能单独测）。
 *
 * 拒绝两种情况：块是空的；块已经原样在文件里（**不许写第二遍** ——
 * 重复应用会让提示词里出现两段一样的反例清单，白烧 token 还显得啰嗦）。
 */
export function appendBlock(styleText, block) {
  const base = String(styleText ?? '')
  const add = String(block ?? '').trim()
  if (!add) return { ok: false, why: '草稿是空的（还没有足够的人工评审证据）' }
  if (base.includes(add)) return { ok: false, why: '这份草稿已经在风格文件里了，不重复写' }
  return { ok: true, text: `${base.replace(/\s+$/, '')}\n\n${add}\n` }
}

/** 文本的 sha256（页面上显示前 8 位，用来确认"我看到的和写进去的是同一份"）。 */
export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
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
 * @param {string} opts.workspace  工作区（评审数据写在它下面）
 * @param {string} opts.styleFile  `styles/闲聊.md` 的**绝对**路径（应用草稿时用）
 * @param {(m: string) => void} [opts.log]
 */
export function createReviewStore({ workspace, styleFile, log = () => {} } = {}) {
  const root = String(workspace ?? '')
  if (!root) throw new Error('没有工作区，评审数据无处可放')
  const dir = join(root, REVIEW_REL)
  const indexPath = join(dir, 'index.json')
  const scoresPath = join(dir, 'scores.json')
  const batchPath = (id) => join(dir, 'batches', `${id}.json`)

  /** 已知条目 id 的缓存（打分时要校验"这条真的属于某个批次"）。 */
  let knownIds = null

  const emptyIndex = () => ({ version: REVIEW_VERSION, batches: [] })
  const emptyScores = () => ({ version: REVIEW_VERSION, scores: {}, order: [] })

  const readIndex = () => {
    const raw = readJson(indexPath, emptyIndex(), log)
    const batches = Array.isArray(raw.batches) ? raw.batches : []
    return { version: REVIEW_VERSION, batches }
  }
  const readScores = () => {
    const raw = readJson(scoresPath, emptyScores(), log)
    return {
      version: REVIEW_VERSION,
      scores: raw.scores && typeof raw.scores === 'object' ? raw.scores : {},
      order: Array.isArray(raw.order) ? raw.order.filter((x) => typeof x === 'string') : [],
    }
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
        const abs = batchPath(meta.id)
        if (existsSync(abs)) {
          const data = readJson(abs, null, log)
          for (const item of data?.items ?? []) if (scores[item?.id]) scored += 1
        }
        return { ...meta, scored }
      })
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }

  function createBatch({ label, source = 'import', chatKey = '', chatLabel = '', items = [] } = {}) {
    const id = String(label ?? '').trim()
    if (!id) return { ok: false, why: '批次 id 不能为空' }
    if (!items.length) return { ok: false, why: '这批里一个可评的回合都没有' }
    const meta = {
      id,
      label: String(label),
      source,
      chatKey,
      chatLabel,
      createdAt: Date.now(),
      items: items.length,
    }
    writeJsonAtomic(batchPath(id), { version: REVIEW_VERSION, batch: meta, items })
    const index = readIndex()
    const rest = index.batches.filter((b) => b.id !== id)
    writeJsonAtomic(indexPath, { version: REVIEW_VERSION, batches: [...rest, meta] })
    knownIds = null // 缓存失效
    return { ok: true, batch: { ...meta, scored: 0 } }
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
    writeJsonAtomic(indexPath, {
      version: REVIEW_VERSION,
      batches: index.batches.filter((b) => b.id !== key),
    })
    knownIds = null
    return { ok: true, removed: data?.items?.length ?? 0 }
  }

  function progress(id) {
    const batch = listBatches().find((b) => b.id === String(id))
    if (!batch) return { scored: 0, total: 0 }
    return { scored: batch.scored, total: batch.items }
  }

  /** 写一条评分（重复提交 = 覆盖；评错了就是重评，不需要先删）。 */
  function saveScore({ id, verdict, tags = [], note = '' } = {}) {
    const key = String(id ?? '')
    if (!ensureKnownIds().has(key)) return { ok: false, why: '这个条目不属于任何批次（可能批次被删了）' }
    const valid = validateScore({ verdict, tags, note })
    if (!valid.ok) return valid
    const data = readScores()
    const score = {
      id: key,
      verdict,
      tags: [...new Set(tags)],
      note: String(note ?? '').slice(0, 1000),
      at: Date.now(),
    }
    data.scores[key] = score
    // `order` 是**评分顺序**（不是条目顺序）：撤销要撤"我上一条打的"，不是"上一条数据"
    data.order = data.order.filter((x) => x !== key)
    data.order.push(key)
    writeJsonAtomic(scoresPath, { version: REVIEW_VERSION, ...data })
    return { ok: true, score }
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
    return { ...aggregateStats({ items, scores }), scope: String(scope ?? 'all'), batches: metas.length }
  }

  /** 草稿：建议清单 + 待追加文本 + 统一 diff（只算不写）。 */
  function draft(scope) {
    const { items } = collect(scope)
    const scores = readScores().scores
    const base = aggregateStats({ items, scores })
    const { block, usedTags, truncated } = renderProposedBlock({ stats: base })
    let current = ''
    try {
      current = existsSync(styleFile) ? readFileSync(styleFile, 'utf8') : ''
    } catch (error) {
      log(`⚠️ [评审台] 读不出风格文件（diff 会按空文件算）：${error?.message ?? error}`)
    }
    const applied = appendBlock(current, block)
    return {
      target: styleFile,
      suggestions: base.tags
        .filter((t) => t.count > 0)
        .map((t) => ({
          tagId: t.id,
          label: t.label,
          kind: t.kind,
          count: t.count,
          advice: TAG_BY_ID.get(t.id)?.advice ?? '',
          ruleQuote: TAG_BY_ID.get(t.id)?.ruleQuote ?? '',
          examples: t.examples,
        })),
      proposedBlock: block,
      usedTags,
      truncated,
      alreadyApplied: Boolean(block) && !applied.ok && applied.why.includes('已经在'),
      diff: block ? unifiedDiff(current, applied.ok ? applied.text : current, { aName: styleFile, bName: styleFile }) : '',
      evidenceCount: base.rate.scored,
    }
  }

  /**
   * 应用草稿：**唯一的、会碰机器人人格的写操作**。
   *
   * 顺序不能换：先读最新文件（别人可能刚改过）→ 算追加（可能被判重）→ **先备份** →
   * 原子写。任何一步失败都原样返回理由，且**不留半截文件**。
   */
  function applyDraft({ scope = 'all', confirm = false } = {}) {
    if (confirm !== true) return { ok: false, why: '没有确认。应用会改动 styles/闲聊.md，必须显式确认', code: 400 }
    const d = draft(scope)
    if (!d.proposedBlock) return { ok: false, why: '还没有足够的人工评审证据，生成不出草稿', code: 400 }
    let current = ''
    try {
      current = existsSync(styleFile) ? readFileSync(styleFile, 'utf8') : ''
    } catch (error) {
      return { ok: false, why: `读不出风格文件：${error?.message ?? error}`, code: 500 }
    }
    const next = appendBlock(current, d.proposedBlock)
    if (!next.ok) return { ok: false, why: next.why, code: 409 }
    const backupDir = join(dirname(styleFile), '.backups')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = join(backupDir, `${styleFile.split(/[\\/]/).pop()}.${stamp}.bak`)
    try {
      mkdirSync(backupDir, { recursive: true })
      writeFileSync(backup, current, 'utf8')
      const tmp = `${styleFile}.${process.pid}.tmp`
      writeFileSync(tmp, next.text, 'utf8')
      renameSync(tmp, styleFile)
    } catch (error) {
      return { ok: false, why: `写风格文件失败（备份在 ${backup}）：${error?.message ?? error}`, code: 500 }
    }
    log(`[评审台] 已应用修订草稿：追加 ${next.text.length - current.length} 字，备份 ${backup}`)
    return {
      ok: true,
      backup,
      sha256: sha256(next.text),
      chars: next.text.length,
      appended: next.text.length - current.length,
      block: d.proposedBlock,
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
    draft,
    applyDraft,
    /** 给 `/api/items` 用：某批次的条目 + 评分（不在这里分页，分页是 HTTP 层的事）。 */
    itemsWithScores(scope) {
      const { items, metas } = collect(scope)
      const scores = readScores().scores
      return { items: items.map((it) => ({ ...it, score: scores[it.id] ?? null })), metas }
    },
    scores: () => readScores().scores,
    /** 测试与体检用：把整份数据重读一遍（绕过缓存）。 */
    invalidate() {
      knownIds = null
    },
    files: { index: indexPath, scores: scoresPath, dir, batches: () => readdirSync(dir) },
  }
}
