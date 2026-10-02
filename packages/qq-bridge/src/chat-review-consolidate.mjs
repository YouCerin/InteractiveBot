/**
 * 聊天记录评审台 —— **评论 → 点 → 改写草稿**（用户 2026-10-02 定的新形状）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么改成这样（推翻的正是第一版的"标签"）
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版让人**从一张手写标签表里选**（太长 / 像客服 / 乱用省略号…），然后把标签
 * 统计成排行。使用者直接说：**"标签系统并不合理"** —— 他的习惯是
 * **对说得对与不对的地方写一句评论**。这是对的，而且差别是根本性的：
 *
 *   · 标签表是**我预先想好的分类**。人只能在我给的格子里打勾，
 *     我没想到的问题就**永远进不了统计**（这是最要命的：工具会让人以为
 *     "排行榜上没有 = 没问题"）；
 *   · 评论是**人自己的判断**，而"点"应该是**从评论里长出来的**（他的原话：
 *     「从我的评论中整理新的点放上去」），不是我预先设定的。
 *
 * ∴ 现在的形状是：**评论（人写）→ 整 理（归纳成点）→ 草稿（整篇重写）**。
 *   而且"整理"这件事**只有模型做得了**（自由文本的归纳）——这是本工具唯一一次
 *   调模型，且它是人点一下才发生的、结果永远只是**草稿**。
 *
 * ── 两条必须守住的边界 ────────────────────────────────────────────────────
 *   ① **锚点**：整篇重写有机会改坏人格文件，所以有一张"底线要点"表（越权/泄露记忆/
 *      假装成功/别的 bot/不是屈服…）。改写里丢了哪条，就**拒绝应用**并点名说清。
 *      （判据是短词包含，允许同义写法；人确认后可以覆盖 —— 见 store 的 applyDraft。）
 *   ② **失败要说清楚**：模型不通/超时/输出不合法时，如实回 `ok:false` + 为什么，
 *      并附上**本地聚类**的初步分组（至少让人看见"评论都还在"），绝不假装整理过。
 */

import { similarity } from './text-similarity.mjs'

/**
 * **底线要点**：整篇重写时一条都不许丢。
 *
 * 判据刻意用**短词** + `any` 同义写法（而不是整句），因为改写本来就会换措辞：
 * 要求逐字保留整句，等于禁止任何改写；而只要求"这个要点还在"才能既允许精简、
 * 又拦住"把安全底线顺手删掉"。
 */
export const STYLE_ANCHORS = [
  { id: 'precedence', label: '优先级条款（与别处冲突时以本节为准）', any: ['以本节为准'] },
  { id: 'no_leak', label: '不泄露记忆', any: ['不泄露记忆', '不外泄记忆'] },
  { id: 'no_privilege', label: '不越权（权限由代码判定）', any: ['不越权', '权限由代码'] },
  { id: 'no_fake_success', label: '不假装成功', any: ['不假装成功'] },
  { id: 'no_bot_relay', label: '别的机器人不接力', any: ['别的 bot', '别的机器人'] },
  { id: 'not_submit', label: '接梗不是屈服', any: ['不是屈服'] },
  { id: 'honorific_is_line', label: '敬语是台词，不是认输', any: ['敬语是台词'] },
  { id: 'no_made_up', label: '不确定的事实不要编', any: ['不要编', '不许编'] },
  { id: 'down_mood', label: '对方低落时不玩梗', any: ['低落'] },
  { id: 'sexual_refusal', label: '情色暗示看懂并拒绝', any: ['不搞这些'] },
]

/** 一次整理最多带多少条评论 / 多少字符（超了如实截断，不静默）。 */
export const CONSOLIDATE_LIMITS = { comments: 150, chars: 14_000, styleChars: 9_000 }

/** 核对改写后的文本是否保住了全部底线要点。 */
export function checkAnchors({ text, anchors = STYLE_ANCHORS } = {}) {
  const body = String(text ?? '')
  const missing = []
  for (const a of anchors) {
    const hit = (a.any ?? []).some((needle) => body.includes(needle))
    if (!hit) missing.push({ id: a.id, label: a.label, any: a.any ?? [] })
  }
  return { ok: missing.length === 0, missing, checked: anchors.length }
}

/** 一条评论压成提示词里的一行（**编号要留给模型回指**，所以 id 用序号）。 */
function commentLine(entry, index) {
  const verdict = { good: '对', bad: '不对', ok: '还行' }[entry?.verdict] ?? '（没判档）'
  const ctx = (entry?.context ?? [])
    .map((c) => `${c.isBot ? '机器人' : c.name}：${c.text}`)
    .join(' / ')
    .replace(/\s*\n\s*/g, ' ')
  const reply = String(entry?.reply ?? '').replace(/\s*\n\s*/g, ' / ')
  const comment = String(entry?.comment ?? '').replace(/\s*\n\s*/g, ' ').trim()
  return `[${index + 1}] ${verdict}｜机器人当时说：「${reply}」${ctx ? `｜当时对方说：「${ctx}」` : ''}\n    评论：${comment}`
}

/**
 * 造提示词（**纯函数**，所以提示词本身能被断言钉住）。
 *
 * ★ 三条纪律写进提示词里，缺一条都会产出没法用的草稿：
 *   ① **归纳，不是照抄**；② **在精不在多**（点太多等于没整理）；
 *   ③ 输出**只有 JSON**（解析器不猜散文）。
 */
export function buildConsolidatePrompt({ comments = [], styleText = '', anchors = STYLE_ANCHORS, limits = CONSOLIDATE_LIMITS } = {}) {
  const withText = comments.filter((c) => String(c?.comment ?? '').trim())
  const kept = withText.slice(0, Math.max(1, Number(limits.comments) || 150))
  const lines = []
  let used = 0
  for (let i = 0; i < kept.length; i += 1) {
    const line = commentLine(kept[i], i)
    if (used + line.length > (Number(limits.chars) || 14_000)) break
    used += line.length
    lines.push(line)
  }
  const anchorList = anchors.map((a) => `   · ${a.label}（可用这些说法之一：${(a.any ?? []).join(' / ')}）`).join('\n')

  return {
    prompt: [
      '你在整理一个 QQ 机器人（「小鲸鱼」）的**闲聊说话风格**文件。人已经把评审意见写好了，',
      '你要做两件事：①把这些意见**归纳成若干「点」**；②据此**重写整份风格文件**。',
      '',
      '【现有的风格文件 styles/闲聊.md 全文】',
      String(styleText ?? '').slice(0, Number(limits.styleChars) || 9000),
      '',
      `【人工评审意见（共 ${lines.length} 条）】`,
      lines.join('\n'),
      '',
      '【要求】',
      '1. **归纳，不是照抄**：同一个问题的多条评论算**一个点**；点要写成一句能执行的规则，',
      '   而不是"某人说过 XX"。点在精不在多，3~8 条最好。',
      '2. `kind` 取 `bad`（要改掉的）或 `good`（要保留、并且写得更清楚的）。',
      '3. 然后**重写整份风格文件**：',
      '   · 合并重复的说法、删掉被更好说法覆盖的、把评论里反复出现的要求写成明确规则；',
      '   · **按需精简**：这是要进提示词的东西，越短越好 —— 但别把判据删模糊（"短"不能靠"含糊"换）；',
      '   · 保留原有的分节结构（`【标题】`），小节可以增删或合并；',
      '   · ⚠️ 下面这些**底线要点一个字都不许丢**（措辞可以改，要点必须在）：',
      anchorList,
      '4. **只输出 JSON**（不要解释、不要 markdown 代码块），形状严格如下：',
      '{"points":[{"kind":"bad","title":"…","summary":"…","evidence":["2","5"],"where":"说话方式"}],',
      ' "rewritten":"完整的新版文件正文，换行用 \\n 表示",',
      ' "dropped":["如果你确实丢了上面某个要点，在这里老实写它的名字；没有就写空数组"]}',
    ].join('\n'),
    kept: lines.length,
    truncatedComments: withText.length - lines.length,
    chars: used,
    droppedForNoText: comments.length - withText.length,
  }
}

/** 从模型的回复里抠出 JSON（容错：剥 ``` 围栏、取第一个大括号块）。 */
export function parseConsolidation(raw) {
  let text = String(raw ?? '').trim()
  if (!text) return { ok: false, why: '模型返回了空内容' }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) text = fence[1].trim()
  if (!text.startsWith('{')) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return { ok: false, why: '模型没按 JSON 形状回答（找不到 JSON 对象）' }
    text = text.slice(start, end + 1)
  }
  let data = null
  try {
    data = JSON.parse(text)
  } catch (error) {
    return { ok: false, why: `模型的 JSON 解析失败：${error?.message ?? error}` }
  }
  if (!data || typeof data !== 'object') return { ok: false, why: '模型返回的 JSON 不是对象' }
  const rewritten = String(data.rewritten ?? '').trim()
  if (!rewritten) return { ok: false, why: '模型没有给出 rewritten（重写后的正文）' }
  const points = Array.isArray(data.points) ? data.points : []
  return {
    ok: true,
    points: points
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        kind: p.kind === 'good' ? 'good' : 'bad',
        title: String(p.title ?? '').trim() || '（没写标题）',
        summary: String(p.summary ?? '').trim(),
        evidence: Array.isArray(p.evidence) ? p.evidence.map((x) => String(x)) : [],
        where: String(p.where ?? '').trim(),
      })),
    rewritten,
    dropped: Array.isArray(data.dropped) ? data.dropped.map((x) => String(x)).filter(Boolean) : [],
    via: fence ? 'fence' : 'raw',
  }
}

/**
 * 本地**确定性**聚类（模型不可用时的退路）。
 *
 * 它做不了"归纳成规则"（那需要语义），但能把**说法相近的评论聚成组并计数** ——
 * 至少让人看见"哪些评论在说同一件事、说了几遍"，而不是一堆散句。
 * 判据用 `text-similarity.mjs`（仓库已有的字符二元组相似度），阈值 0.34：
 * 刻意松（宁可把两件事并到一起让人自己拆，也不要让同一件事散成五组）。
 */
export function clusterComments({ comments = [], threshold = 0.34, verdict = '' } = {}) {
  const rows = comments.filter((c) => String(c?.comment ?? '').trim() && (!verdict || c.verdict === verdict))
  const clusters = []
  for (const row of rows) {
    const text = String(row.comment).trim()
    const hit = clusters.find((c) => similarity(c.text, text) >= threshold)
    if (hit) {
      hit.count += 1
      hit.ids.push(row.id)
      continue
    }
    clusters.push({ text, count: 1, ids: [row.id] })
  }
  return clusters.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
}

/**
 * 整理一次（**唯一一次模型调用**）。
 *
 * @param {object} opts
 * @param {object[]} opts.comments   评论（含 verdict / comment / reply / context）
 * @param {string} opts.styleText    当前风格文件全文
 * @param {object} [opts.target]     `resolveDirectTarget()` 的结果（ok/baseUrl/apiKey/model）
 * @param {Function} [opts.callModel] `chatOnce`（测试注入；默认由调用方传进来）
 * @returns {Promise<object>} 成功 `{ok:true, points, rewritten, anchors, dropped, ...}`；
 *   失败 `{ok:false, why, clusters?}`（**永远带 clusters**，让人看到评论没丢）
 */
export async function consolidateComments({
  comments = [],
  styleText = '',
  target = null,
  anchors = STYLE_ANCHORS,
  limits = CONSOLIDATE_LIMITS,
  callModel = null,
  timeoutMs = 120_000,
  maxTokens = 8000,
  temperature = 0.3,
} = {}) {
  const built = buildConsolidatePrompt({ comments, styleText, anchors, limits })
  const fallback = () => ({
    bad: clusterComments({ comments, verdict: 'bad' }),
    good: clusterComments({ comments, verdict: 'good' }),
  })

  if (!built.kept) {
    return { ok: false, why: '一条带评论的评分都没有（只有判档），没什么可整理', clusters: fallback() }
  }
  if (!target?.ok) {
    return { ok: false, why: `模型通路不可用：${target?.why ?? '没解析出可用的 key/端点'}`, clusters: fallback() }
  }
  if (typeof callModel !== 'function') {
    return { ok: false, why: '没有可用的模型调用函数（callModel 没传）', clusters: fallback() }
  }

  const r = await callModel({
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    model: target.model,
    prompt: built.prompt,
    timeoutMs,
    maxTokens,
    temperature,
    label: '评论整理',
  })
  if (!r?.ok) {
    return { ok: false, why: `模型调用失败：${r?.why ?? '未知原因'}`, clusters: fallback(), ms: r?.ms }
  }
  const parsed = parseConsolidation(r.text)
  if (!parsed.ok) {
    return { ok: false, why: parsed.why, clusters: fallback(), ms: r?.ms, raw: String(r.text ?? '').slice(0, 2000) }
  }
  const anchorCheck = checkAnchors({ text: parsed.rewritten, anchors })
  return {
    ok: true,
    points: parsed.points,
    rewritten: parsed.rewritten,
    dropped: parsed.dropped,
    anchors: anchorCheck,
    via: parsed.via,
    model: target.model,
    ms: r?.ms ?? null,
    usage: r?.usage ?? null,
    promptStats: { kept: built.kept, truncatedComments: built.truncatedComments, chars: built.chars },
  }
}
