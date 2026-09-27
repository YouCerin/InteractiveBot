/**
 * 配方库：沉淀"**怎么做**"，同类任务直接套用。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════════════════════
 * 同一个会话里，"调研一个不熟悉的品牌靠不靠谱"这类事会**反复出现**。
 * 每次从零摸索 = 重复踩已经踩过的坑。
 *
 *   · 任务台账（R2）回答"**我正在干什么**"（当下）
 *   · 配方库（R4）回答"**这种事一般怎么做**"（积累）
 *
 * 两个用途不同、都要注入，不要合并。
 *
 * ── 三个刻意的设计约束 ──────────────────────────────────────────────────
 *
 * **① 置信度用拉普拉斯平滑，不用成功率。**
 *    `base = (succeeded + 1) / (used + 2)`
 *    为什么：只成功过 1 次就记 1.0 会误导（样本太小）。平滑之后
 *    "1 次成功" = 0.67，"10 次成功 0 次失败" ≈ 0.92 —— 后者才配得上"可信"。
 *
 * **② 衰减只降权，**不删**。**
 *    `confidence = base × 0.5 ^ (ageDays / 60)`
 *    过时的做法仍然**可以检索到**，只是不再自动注入。删掉等于把
 *    "以前试过这条路"的知识扔掉 —— 而那恰恰是配方库最值钱的部分。
 *
 * **③ 命令注入走 `requiredActions`，不让模型自己拼。**
 *    配方里可以声明"这类任务通常需要跑这几个命令"。注入时**只把它们当作
 *    提示文本**列出，**绝不自动执行** —— 自动执行等于给了一个"配方作者
 *    可以远程命令执行"的通道。这一点写在这里是为了防止以后有人"顺手"加上。
 *
 * ── 与"回合后抽取"的关系（R4b，**尚未接通**）─────────────────────────────
 * 配方的自动沉淀需要**一次额外的模型调用**（从刚结束的任务里提炼做法）。
 * 当时本项目**没有直连模型 API 的代码**：`dsh.apiKey` 只用于注入 DSH 子进程的
 * 环境变量，全程通过 `session/prompt` 跟模型说话，所以通道**待定**。
 *
 * ★★ **0.2.3 更正：通道已经有了** —— `src/model-direct.mjs` 的 `chatOnce()`
 *    （一次 `/chat/completions`，约 1 秒）。R4b 现在的实现走的是
 *    `runHeadless`（一次性 DSH 进程，2.8~4.4 秒），它跑得通，所以**没换**；
 *    但"没有直连通路"这个前提**已经过期**，要换过去只需给
 *    `extractRecipe({ runner })` 传另一个 runner（那个口子本来就是可注入的）。
 * ⚠️ 上面那段话被刻意留着并加了更正 —— **过期的技术前提比没有前提更危险**。
 *
 * 在那之前：配方库、匹配、注入、置信度、管理手段**全部可用**（它们是确定性的），
 * 配方也可以人工写（`--recipes --add`）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** 触发匹配分数低于这个值就不注入（宁可不提，也不要塞一堆不相关的做法）。 */
export const MATCH_THRESHOLD = 0.34

/** 置信度低于这个值 → 不再自动注入（但仍可检索）。 */
export const INJECT_MIN_CONFIDENCE = 0.15

/** 注入时最多带几条配方（省 token）。 */
export const MAX_INJECT_RECIPES = 2

/** 置信度衰减的半衰期（天）。 */
export const CONFIDENCE_HALF_LIFE_DAYS = 60

/** 一个配方的字段上限（防止抽取产出巨型条目）。 */
const LIMITS = {
  title: 40,
  keywords: 12,
  // ★ 关键词长度从 16 提到 30（真机证据，2026-09-26）：抽取产出的 `keywords`
  //   是**用户会怎么说出这类需求**的整句话，中文里很自然就是 15~25 字，
  //   16 字会把它们从中间**截断**，实测三条里截断两条：
  //     「帮我查一下XX最近有什么新品/新」← 尾巴（"动态"）没了
  //     「XX这个品牌2026年9月上新了」    ← 也截断了
  //   而截断的后果是**静默的**：匹配照样能跑（靠前缀），只是准确率下降，
  //   没有任何地方会告诉你"这条关键词少了一半"。上限保留 30 是为了防巨型条目。
  keyword: 30,
  steps: 6,
  step: 100,
  pitfalls: 4,
  pitfall: 80,
  verify: 100,
  requiredActions: 4,
  action: 80,
}

// ══════════════════════════════════════════════════════════════════════════
// slug 与评分
// ══════════════════════════════════════════════════════════════════════════

/**
 * 由标题生成稳定的 slug（**同一件事换句话说是同一个文件**）。
 *
 * 为什么不用随机 id：随机 id 会让"同一件事"沉淀成很多条，
 * 每次都要人去合并。用标题派生 slug 至少让**完全相同**的标题复用同一个文件。
 * （语义级的去重仍然要靠人/二期，这里不假装能做到。）
 */
export function slugOf(title) {
  const t = String(title ?? '').trim()
  if (!t) return null
  // 中文没有"词"的概念可用，所以：保留中日韩与字母数字，其余折成下划线
  const s = t
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return s || null
}

/**
 * 置信度：拉普拉斯平滑的基础分 × 时间衰减。
 *
 * @param {object} recipe
 * @param {Date|number} [now]
 * @returns {number} 0~1
 */
export function confidenceOf(recipe, now = new Date()) {
  const used = Math.max(0, Number(recipe?.stats?.used) || 0)
  const ok = Math.max(0, Number(recipe?.stats?.succeeded) || 0)
  // ① 拉普拉斯平滑：没成功过的也不给 0（可能只是还没用），成功 1 次不到 1
  const base = (ok + 1) / (used + 2)
  // ② 时间衰减：60 天半衰期
  const lastAt = Number(recipe?.stats?.lastUsedAt) || Number(recipe?.updatedAt) || 0
  if (!lastAt) return base
  const ageDays = Math.max(0, (Number(now instanceof Date ? now.getTime() : now) - lastAt) / 86400000)
  const recency = 0.5 ** (ageDays / CONFIDENCE_HALF_LIFE_DAYS)
  return base * recency
}

/** 极简分词：中文按 2 字滑窗 + 英文/数字整词。够用即可，不做语言学。 */
export function termsOf(text) {
  const t = String(text ?? '').toLowerCase()
  const out = new Set()
  for (const m of t.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0])
  const han = t.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i + 1 < han.length; i += 1) out.add(han.slice(i, i + 2))
  // 短查询（1 个汉字）也保留，否则"查"这种单字任务匹配不到
  if (han.length === 1) out.add(han)
  return out
}

/**
 * 配方与一段文本的匹配分数（0~1）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 打分口径改过一版，原因值得记下来
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版是"`命中关键词数 / 关键词总数`，且命中 <2 个再打 0.75 折"。
 * 实测太严：配方关键词是 `查品牌/靠不靠谱/口碑/评价/是不是骗子`，
 * 而用户说「**这个牌子口碑怎么样**」只命中「口碑」一个词 →
 * `1/5 × 0.75 = 0.15`，**被挡在阈值外**。可那恰恰是配方最该命中的情况
 * —— 人很少一次说中好几个关键词，长尾命中才是常态。
 *
 * 现在的口径：**命中几个词就按几个算，命中率补一个下限**，
 * 并且单个关键词的命中用**子串**判定（`口碑` 直接出现在文本里），
 * 这比"分词后任一元重合"精确得多 —— 后者会让短关键词里的单字乱撞。
 *
 * **仍然不做语义相似度**：那要模型，而这里的全部意义就是
 * "零模型成本地决定要不要提这条"。
 *
 * @param {object} recipe
 * @param {string} text 通常是用户最近说的话
 * @returns {number}
 */
export function matchScore(recipe, text) {
  const kws = Array.isArray(recipe?.trigger?.keywords) ? recipe.trigger.keywords : []
  if (kws.length === 0) return 0
  const t = String(text ?? '').toLowerCase()
  if (!t) return 0
  const hay = termsOf(t)
  let hit = 0
  for (const k of kws) {
    const kk = String(k ?? '').trim().toLowerCase()
    if (!kk) continue
    // ① 直接子串命中（最可靠：`口碑` 就在句子里）
    if (t.includes(kk)) {
      hit += 1
      continue
    }
    // ② 兜底：关键词的 bigram 至少一半能在文本里找到
    //    （处理"查品牌" vs "查一下这个品牌"这类词序/插入差异）
    const kt = [...termsOf(kk)].filter((x) => x.length === 2) // 只看 bigram，避免单字乱撞
    if (kt.length > 0) {
      const got = kt.filter((x) => hay.has(x)).length
      if (got / kt.length >= 0.5) hit += 1
    }
  }
  if (hit === 0) return 0
  // 命中率 + 下限补正：命中 1 个词至少 0.30 —— 足以过阈值，
  // 又不会让"完全沾边的闲聊"混进来（不命中就是 0）
  const ratio = hit / kws.length
  return Math.min(1, ratio + 0.2)
}

/**
 * 为一段文本挑出该注入的配方。
 *
 * @param {object[]} recipes
 * @param {string} text
 * @param {{now?: Date, threshold?: number, max?: number}} [opts]
 * @returns {{recipe: object, score: number, confidence: number}[]}
 */
export function pickRecipes(recipes, text, { now = new Date(), threshold = MATCH_THRESHOLD, max = MAX_INJECT_RECIPES } = {}) {
  return (Array.isArray(recipes) ? recipes : [])
    .filter((r) => r && r.enabled !== false)
    .map((r) => ({ recipe: r, score: matchScore(r, text), confidence: confidenceOf(r, now) }))
    .filter((x) => x.score >= threshold && x.confidence >= INJECT_MIN_CONFIDENCE)
    .sort((a, b) => b.score * b.confidence - a.score * a.confidence)
    .slice(0, Math.max(1, max))
}

// ══════════════════════════════════════════════════════════════════════════
// 入库
// ══════════════════════════════════════════════════════════════════════════

/** 配方目录（工作区相对）。 */
export const RECIPE_DIR = 'memory/recipes'

function recipeRel(id) {
  return `${RECIPE_DIR}/${id}.json`
}

function readJson(file, fallback = null) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : fallback
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, 'utf8')
  renameSync(tmp, file)
}

const cut = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const cutList = (v, n, each) => (Array.isArray(v) ? v : []).map((x) => cut(x, each)).filter(Boolean).slice(0, n)

/**
 * 归一化一个配方对象（**所有入库路径都必须过它**）。
 *
 * 它同时是"抽取产出的形状校验"：抽取是模型给的，字段可能缺、可能超长、
 * 可能类型不对。这里统一收敛，坏的就丢掉。
 *
 * @returns {object|null} null = 没有可用的标题/步骤，不该入库
 */
export function normalizeRecipe(raw, { source = 'manual', now = new Date() } = {}) {
  const title = cut(raw?.title, LIMITS.title)
  if (!title) return null
  const steps = cutList(raw?.steps, LIMITS.steps, LIMITS.step)
  const triggerKeywords = cutList(raw?.trigger?.keywords, LIMITS.keywords, LIMITS.keyword)
  // 既没步骤也没关键词 → 空壳，不入库
  if (steps.length === 0 && triggerKeywords.length === 0) return null
  const at = now.getTime()
  return {
    id: slugOf(title),
    title,
    trigger: {
      keywords: triggerKeywords,
      intent: cut(raw?.trigger?.intent, 60),
    },
    steps,
    pitfalls: cutList(raw?.pitfalls, LIMITS.pitfalls, LIMITS.pitfall),
    verify: cut(raw?.verify, LIMITS.verify),
    // ⚠️ 只作为**提示文本**注入，绝不自动执行（见文件头 ③）
    requiredActions: cutList(raw?.requiredActions, LIMITS.requiredActions, LIMITS.action),
    stats: {
      used: Math.max(0, Number(raw?.stats?.used) || 0),
      succeeded: Math.max(0, Number(raw?.stats?.succeeded) || 0),
      failed: Math.max(0, Number(raw?.stats?.failed) || 0),
      lastUsedAt: Number(raw?.stats?.lastUsedAt) || 0,
      lastOutcome: raw?.stats?.lastOutcome ?? null,
    },
    enabled: raw?.enabled !== false,
    source,
    createdAt: Number(raw?.createdAt) || at,
    updatedAt: at,
  }
}

/** 读一条配方。 */
export function readRecipe({ workspace, id } = {}) {
  const root = String(workspace ?? '')
  if (!root || !id) return null
  return readJson(join(root, recipeRel(id)), null)
}

/** 列出全部配方（按置信度降序）。 */
export function listRecipes({ workspace, now = new Date() } = {}) {
  const root = String(workspace ?? '')
  const dir = join(root, RECIPE_DIR)
  const out = []
  try {
    if (!existsSync(dir)) return []
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const r = readJson(join(dir, f), null)
      if (r && r.id) out.push({ ...r, confidence: confidenceOf(r, now) })
    }
  } catch {
    return []
  }
  return out.sort((a, b) => b.confidence - a.confidence)
}

/**
 * 写入（新增或**合并**）一条配方。
 *
 * 合并规则（同一 slug = 同一个文件）：
 *   · 关键词 / 步骤 / 坑 **取并集**（不覆盖 —— 覆盖会丢掉已经验证过的做法）
 *   · `stats` 保留（除非显式传 `stats`）
 *
 * @returns {{ok: boolean, id?: string, merged?: boolean, why?: string}}
 */
export function upsertRecipe({ workspace, recipe, source = 'manual', now = new Date() } = {}) {
  const root = String(workspace ?? '')
  if (!root) return { ok: false, why: '缺少 workspace' }
  const norm = normalizeRecipe(recipe, { source, now })
  if (!norm) return { ok: false, why: '没有可用的标题或内容（标题与步骤/关键词都不能为空）' }

  const existing = readRecipe({ workspace: root, id: norm.id })
  if (existing) {
    const union = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])]
    const merged = {
      ...existing,
      // 关键词与步骤取并集并**按上限截断**；新的排在后面（顺序不影响匹配）
      trigger: {
        keywords: union(existing.trigger?.keywords, norm.trigger.keywords).slice(0, LIMITS.keywords),
        intent: norm.trigger.intent || existing.trigger?.intent || '',
      },
      steps: union(existing.steps, norm.steps).slice(0, LIMITS.steps),
      pitfalls: union(existing.pitfalls, norm.pitfalls).slice(0, LIMITS.pitfalls),
      verify: norm.verify || existing.verify || '',
      requiredActions: union(existing.requiredActions, norm.requiredActions).slice(0, LIMITS.requiredActions),
      // stats 保留（`used`/`succeeded` 是积累出来的，不能被一次重写清掉）
      stats: existing.stats ?? norm.stats,
      enabled: existing.enabled !== false,
      updatedAt: now.getTime(),
    }
    try {
      writeJson(join(root, recipeRel(norm.id)), merged)
    } catch (error) {
      return { ok: false, why: `写盘失败：${error?.message ?? error}` }
    }
    return { ok: true, id: norm.id, merged: true }
  }

  try {
    writeJson(join(root, recipeRel(norm.id)), norm)
  } catch (error) {
    return { ok: false, why: `写盘失败：${error?.message ?? error}` }
  }
  return { ok: true, id: norm.id, merged: false }
}

// ══════════════════════════════════════════════════════════════════════════
// 使用与反馈（置信度的来源）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 记一次"这条配方被用了，结果是成/败"。
 *
 * ⚠️ `outcome` 必须由调用方**确定性地**给出，不能让模型自评 ——
 *    "它说这次成了"与"这次真成了"是两件事（记忆诊断的核心教训）。
 *    现阶段 `noteTaskTurn` 只在"本任务有失败步骤"时记 failed，
 *    其余情况**不记**（宁可样本少，也不要假样本）。
 *
 * @returns {{ok: boolean, recipe?: object, why?: string}}
 */
export function recordOutcome({ workspace, id, outcome, now = new Date() } = {}) {
  const root = String(workspace ?? '')
  const r = readRecipe({ workspace: root, id })
  if (!r) return { ok: false, why: `没有这条配方：${id}` }
  const ok = outcome === 'ok'
  r.stats = {
    used: (Number(r.stats?.used) || 0) + 1,
    succeeded: (Number(r.stats?.succeeded) || 0) + (ok ? 1 : 0),
    failed: (Number(r.stats?.failed) || 0) + (ok ? 0 : 1),
    lastUsedAt: now.getTime(),
    lastOutcome: ok ? 'ok' : 'failed',
  }
  r.updatedAt = now.getTime()
  try {
    writeJson(join(root, recipeRel(id)), r)
  } catch (error) {
    return { ok: false, why: `写盘失败：${error?.message ?? error}` }
  }
  return { ok: true, recipe: { ...r, confidence: confidenceOf(r, now) } }
}

/** 启用/停用一条配方。 */
export function setRecipeEnabled({ workspace, id, enabled } = {}) {
  const root = String(workspace ?? '')
  const r = readRecipe({ workspace: root, id })
  if (!r) return { ok: false, why: `没有这条配方：${id}` }
  r.enabled = enabled !== false
  r.updatedAt = Date.now()
  try {
    writeJson(join(root, recipeRel(id)), r)
  } catch (error) {
    return { ok: false, why: `写盘失败：${error?.message ?? error}` }
  }
  return { ok: true, recipe: r }
}

/**
 * 删掉一条配方。
 *
 * ⚠️ 这里用 `unlinkSync` 而不是 `rmSync` —— 实测在 Windows 上
 *    `rmSync()` 删**中文文件名**会直接把进程崩掉（退出码 `-1073740791`，
 *    即 `STATUS_STACK_BUFFER_OVERRUN`），而 `existsSync` 明明通过、
 *    ASCII 文件名也正常。而配方的 id 是**由中文标题派生**的
 *    （`slugOf('调研品牌可信度')` → `调研品牌可信度`），所以这条路径
 *    一定会遇到中文名 —— 用 `unlinkSync` 就没问题。
 *    删单个文件本来也不需要 `rm` 那一套递归/重试逻辑。
 */
export function removeRecipe({ workspace, id } = {}) {
  try {
    const p = join(String(workspace ?? ''), recipeRel(id))
    if (!existsSync(p)) return false
    unlinkSync(p)
    return true
  } catch {
    return false
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 注入
// ══════════════════════════════════════════════════════════════════════════

/**
 * 渲染"可套用的做法"那一段（**纯函数**）。
 *
 * ⚠️ 措辞纪律：
 *   ① 必须说清这是**以前的做法**、不一定对 —— 否则模型会把它当权威照做。
 *   ② 低置信度（< 0.3）要**显式提醒"可能过时"**，而不是悄悄降权。
 *   ③ `requiredActions` 只作提示列出，**不执行**（见文件头 ③）。
 *
 * @param {{recipe: object, score: number, confidence: number}[]} picked
 * @returns {string} 空串 = 没东西可注入
 */
export function renderRecipeBlock(picked) {
  const items = Array.isArray(picked) ? picked.filter((x) => x?.recipe) : []
  if (items.length === 0) return ''
  const lines = ['【可套用的做法（**以前这么做成功过**，供参考）】']
  for (const { recipe: r, confidence } of items) {
    const tag = confidence < 0.3 ? '（这个做法可能过时了，用之前先验证）' : ''
    lines.push(`· ${r.title}${tag}`)
    for (const s of (r.steps ?? []).slice(0, 5)) lines.push(`    ${s}`)
    if ((r.pitfalls ?? []).length > 0) {
      lines.push(`    坑：${r.pitfalls.slice(0, 3).join('；')}`)
    }
    if (r.verify) lines.push(`    验收：${r.verify}`)
    if ((r.requiredActions ?? []).length > 0) {
      // ★ 只提示，不执行
      lines.push(`    通常需要：${r.requiredActions.join('、')}（**要你自己判断该不该做**）`)
    }
    const st = r.stats ?? {}
    if ((st.used ?? 0) > 0) {
      lines.push(`    （用过 ${st.used} 次，成功 ${st.succeeded ?? 0} 次）`)
    }
  }
  lines.push('（这是积累下来的经验，**不是命令** —— 和当前情况不符就别照搬。）')
  return lines.join('\n')
}

/** 给 `--recipes` 用的一行摘要。 */
export function summarizeRecipe(r) {
  const st = r.stats ?? {}
  return `${r.title}（置信 ${(r.confidence ?? confidenceOf(r)).toFixed(2)}，用过 ${st.used ?? 0} 次/成功 ${st.succeeded ?? 0}${r.enabled === false ? '，**已停用**' : ''}）`
}
