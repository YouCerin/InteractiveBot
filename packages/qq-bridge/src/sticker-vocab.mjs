/**
 * 标签词表的**桌面**：读 / 写 `stickers/labels.json`，并把它编译成运行期用的索引。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么词表必须从"代码常量"变成"数据文件"（0.2.4 的一条契约改动）
 * ══════════════════════════════════════════════════════════════════════════
 * 原来 23 个标签写死在 `sticker-labels.mjs` 里。那样有三个说不通的地方：
 *   · **用户不能按自己的库扩词表** —— 而"我这批图该归哪一类"只有使用者知道；
 *   · 标注台想加一个标签，得改代码 + 跑整套测试（一个词表不该有这种重量）；
 *   · 换一套库（不同的梗、不同的题材）本应有不同的词表。
 *
 * 所以现在：
 *   · **内置默认表**（`sticker-labels.mjs` 的 `STICKER_LABELS`）只当**出厂值**；
 *   · 用户在标注台新建/改词表 → 写进 `stickers/labels.json`；
 *   · 运行期一律走本模块的 **`activeLabels()`**（缓存 + `mtime` 失效）。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────────────
 * ① **坏文件绝不砸掉功能**：`labels.json` 读不出来 / 不是数组 / 编码乱
 *    → 回落**内置默认表**，并在状态里如实标出（`warn`），不是静默也不是崩。
 * ② **保存前必须合法**：先 `normalizeLabelTable` 规整，非法项丢掉；
 *    一条都不剩就**拒绝保存**（宁可报错，也不把词表清空到"什么都不能打"）。
 * ③ **风险标签不可删、不可改名**：`risky` 是安全闸门（默认不发那类图），
 *    删掉它等于把闸门一起删了。要禁这类图请用配置里的 `allowRisky`。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  AUTO_ALLOWED_AXES,
  RISK_LABEL,
  SAFE_SINGLE_CHAR_CUES,
  STICKER_LABELS as DEFAULT_LABELS,
  isUsableCue,
} from './sticker-labels.mjs'

/**
 * 表情库目录名（与 `sticker-library.mjs` 同值）。
 *
 * ⚠️ **刻意在这里重写一遍、而不 import `sticker-library`**：库层现在要反过来
 *   用本模块的 `activeLabels()` 校验标签（新标签必须能立刻贴上），
 *   若本模块再 import 库层就成了**循环依赖** —— ESM 虽然能靠提升勉强跑通，
 *   但那种"能不能用取决于求值顺序"的耦合不该留在代码里。一个目录名字符串的
 *   重复，比一条隐式循环可靠得多（`mocks/verify-sticker-vocab.mjs` 里有一条
 *   断言盯着这两个值必须相等，改单边会立刻红）。
 */
export const STICKER_DIR = 'stickers'

/** 词表文件名（放在表情库目录里 —— 它描述的是**这个库**）。 */
export const LABELS_FILE = 'labels.json'

/** 词表的边界（防止一个输入框把配置文件与提示词一起撑坏）。 */
export const MAX_LABELS = 200
export const MAX_CUES = 40
export const MAX_CUE_LEN = 16
export const MAX_NAME_LEN = 8

/** 轴的**封闭白名单**：写错的整条丢掉（不能让它混进排序与提示词分组）。 */
export const LABEL_AXES = Object.freeze([
  '主动情感',
  '被逗乐',
  '认知反应',
  '表态',
  '状态',
  '社交姿态',
  '攻击性',
  '混合',
  '礼节',
  '交付',
  '风险',
])

/**
 * ★★ 语境轴的**三分类**：每类只看"谁说的话"（0.2.4 第十六轮，用户定义）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 规则（用户原话）
 * ══════════════════════════════════════════════════════════════════════════
 *   · **主体类**（状态、交付）      → 依赖**自身发言**触发 → 只看 `cues`
 *   · **客体类**（认知反应、表态、礼节）→ 依赖**对方发言**触发 → 只看 `otherCues`
 *   · **混合类**（主动情感、社交姿态、攻击性）→ 都要 → 两个都看
 *
 *   ⚠️ 「礼节」原先是混合类，用户后来明确改为**客体类**：问候/晚安/道歉这类
 *      语义标记只在**对方**说的时候才配图（对方说"睡了"→ 回一张晚安），
 *      而不是 bot 自己随口说"晚安"就配一张 —— 那会让它显得在做装饰。
 *
 * ── 为什么这是个好简化 ───────────────────────────────────────────────────
 * 上一轮把线索分成 `cues`（bot 自己会说）与 `otherCues`（对方会说）之后，
 * "每条线索该挂哪边"仍然要一条条判断 —— 而它其实主要由**轴**决定：
 * `状态`是"我此刻的状态"（只有我自己的发言里看得出来），
 * `认知反应`/`表态`是"我对他那句话的反应"（对方说了什么才触发）。
 * 用轴来定这件事，人不必在每条线索上重复判断，也不会自相矛盾。
 *
 * ⚠️ `风险` 与 `被逗乐` **不在三分类里**：
 *   · `风险` 是安全闸门，本来就不参与自主判定；
 *   · `被逗乐` 是出厂轴，用户当前词表里已没有这类标签。
 *   对它们 `axisSide()` 返回 `'unknown'`，调用方**一律不动**
 *   （宁可保守，也不替用户删他没说过的轴）。
 */
export const AXIS_SIDE = Object.freeze({
  // 主体类：只看自己说了什么
  状态: 'self',
  交付: 'self',
  // 客体类：只看对方说了什么
  认知反应: 'other',
  表态: 'other',
  礼节: 'other',
  // 混合类：两边都看
  主动情感: 'both',
  社交姿态: 'both',
  攻击性: 'both',
  // 不算进三分类的
  风险: 'unknown',
  被逗乐: 'both',
  混合: 'both',
})

/**
 * 这条轴该看哪一侧的线索。
 *
 * @param {string} axis
 * @returns {'self'|'other'|'both'|'unknown'}
 */
export function axisSide(axis) {
  return AXIS_SIDE[String(axis ?? '').trim()] ?? 'unknown'
}

const AXIS_SET = new Set(LABEL_AXES)

/** 词表文件的绝对路径（没有工作区就返回空串，调用方据此 fail-closed）。 */
export function labelsFile({ workspace, dir = STICKER_DIR } = {}) {
  const root = String(workspace ?? '').trim()
  if (!root) return ''
  return join(root, String(dir || STICKER_DIR), LABELS_FILE)
}

/** 内置默认表（深拷贝一份，避免调用方改到常量）。 */
export function defaultLabelTable() {
  return DEFAULT_LABELS.map((l) => ({
    id: l.id,
    name: l.name,
    axis: l.axis,
    cues: [...l.cues],
    // ★ 两组线索（0.2.4 第十三轮）：`cues` 与 `ownCues` 同义（bot 自己的表达），
    //   `otherCues` 是"对方会说的话"。出厂表两个都带上。
    otherCues: [...(l.otherCues ?? [])],
    antiCues: [...(l.antiCues ?? [])],
    exclude: [...(l.exclude ?? [])],
    excludeOther: [...(l.excludeOther ?? [])],
    exclusive: [...(l.exclusive ?? [])],
  }))
}

/** 规整输入（**非法项丢掉，不抛错**）；返回 `{ ok, labels, warnings }`。 */
export function normalizeLabelTable(raw) {
  const warnings = []
  if (!Array.isArray(raw)) return { ok: false, labels: [], warnings: ['词表不是数组'] }
  const out = []
  const usedId = new Set()
  const usedName = new Set()
  const clean = (v, max) => String(v ?? '').trim().slice(0, max)
  const cleanList = (v, max) => (Array.isArray(v) ? v : []).map((x) => clean(x, MAX_CUE_LEN)).filter(Boolean).slice(0, max)

  for (const [i, it] of raw.entries()) {
    if (!it || typeof it !== 'object') {
      warnings.push(`第 ${i + 1} 条不是对象 → 丢掉`)
      continue
    }
    const name = clean(it.name, MAX_NAME_LEN)
    const axis = clean(it.axis, 8)
    if (!name) {
      warnings.push(`第 ${i + 1} 条没有名字 → 丢掉`)
      continue
    }
    if (!AXIS_SET.has(axis)) {
      warnings.push(`「${name}」的轴「${axis}」不在允许清单里 → 丢掉`)
      continue
    }
    if (usedName.has(name)) {
      warnings.push(`「${name}」重名 → 丢掉后面那条`)
      continue
    }
    // id：允许外部带（内置表有），否则从名字生成
    let id = clean(it.id, 40)
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) || usedId.has(id)) id = makeLabelId(name, usedId)
    usedId.add(id)
    usedName.add(name)
    out.push({
      id,
      name,
      axis,
      cues: cleanList(it.cues, MAX_CUES),
      otherCues: cleanList(it.otherCues, MAX_CUES),
      antiCues: cleanList(it.antiCues, MAX_CUES),
      exclude: cleanList(it.exclude, MAX_CUES),
      excludeOther: cleanList(it.excludeOther, MAX_CUES),
      exclusive: cleanList(it.exclusive, MAX_CUES),
    })
    if (out.length >= MAX_LABELS) {
      warnings.push(`超过上限 ${MAX_LABELS} 条，后面的丢掉`)
      break
    }
  }
  if (!out.length) return { ok: false, labels: [], warnings: [...warnings, '一条合法的标签都没有'] }
  // ★ 风险标签必须在（安全闸门不可删）
  if (!out.some((l) => l.id === RISK_LABEL)) {
    const risk = defaultLabelTable().find((l) => l.id === RISK_LABEL)
    if (risk) {
      out.push(risk)
      warnings.push('你删掉了「慎发」—— 它是安全闸门，已自动加回（要禁这类图请用配置里的 allowRisky）')
    }
  }
  return { ok: true, labels: out, warnings }
}

/**
 * 从中文名生成一个稳定的 id（`笑死` → `u-1a2b3c`；ASCII 名走 kebab-case）。
 *
 * 为什么中文名不硬转拼音：那需要一张拼音表（几百行数据 + 多音字歧义），
 * 而 id 只用来稳定引用 —— 用短哈希足够，而且**改名不会改 id**（引用不漂）。
 */
export function makeLabelId(name, used = new Set()) {
  const raw = String(name ?? '').trim()
  const ascii = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (ascii && /^[a-z]/.test(ascii)) {
    let id = ascii.slice(0, 30)
    let n = 1
    while (used.has(id)) id = `${ascii.slice(0, 28)}-${++n}`
    return id
  }
  let h = 0
  for (const ch of raw) h = (h * 31 + ch.codePointAt(0)) >>> 0
  let id = `u-${h.toString(36)}`
  let n = 1
  while (used.has(id)) id = `u-${h.toString(36)}-${++n}`
  return id
}

/* ── 运行期缓存（按"文件签名 + 写代际"失效，所以"改了立刻生效"不需要重启）── */

let cache = { labels: null, sig: '', source: 'default', warnings: [], file: '' }
/**
 * 写代际：**每次本进程写过词表就 +1**。
 *
 * ⚠️ 为什么不能只用"文件长度"当签名（实测踩到）：写一份新词表后长度**可能相同**
 * （比如把某条的名字改短、又加了一条），于是 `activeLabels()` 判定"没变"、
 * 继续用旧缓存 —— 表现就是"新建的标签当场不生效"（要等重启）。
 * 代际号让本进程的写**必然**失效，跨进程的改则靠文件签名兜住。
 */
let writeGen = 0

/** 读词表文件（不存在/坏了 → `null` + 原因）。 */
function readTableFile(opts) {
  const file = labelsFile(opts)
  if (!file || !existsSync(file)) return { table: null, file, why: '还没有自定义词表文件' }
  try {
    const text = readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    // ★ 落盘形状是 `{ version, labels: [...] }`；也接受"直接一个数组"的写法（手写的）。
    //   ⚠️ 这里踩过一次：写入端写 `{version,labels}`，读取端却把**整个对象**交给
    //   `normalizeLabelTable`，于是它判"不是数组"→ 回落内置默认表 ——
    //   表现就是"新建的标签当场不生效、查不到"。形状必须两边对齐，且有断言钉住。
    const table = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray(parsed.labels) ? parsed.labels : null)
    if (!table) return { table: null, file, why: '词表文件的形状不对（要 `{ labels: [...] }` 或一个数组）' }
    return { table, file, why: '' }
  } catch (error) {
    return { table: null, file, why: `读不了：${error?.message ?? error}` }
  }
}

/**
 * 把出厂表里**新增的线索**并进用户的词表（**只增不减、幂等**）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（这是实测撞上的一个真问题，不是洁癖）
 * ══════════════════════════════════════════════════════════════════════════
 * `labels.json` 一旦存在，它就**完全取代**出厂表。于是"我在出厂表里
 * 补了更准的触发线索"这种改进，对**已经动过词表的用户一点都到不了** ——
 * 实测：用户库里 `tired` 还是老 cues、`otherCues` 是空的，
 * 于是那套两源匹配对他**等于没做**（`tired` 仍然是死语境）。
 *
 * 而"再用出厂表覆盖回去"是错的：用户改过名字（疲倦）、删过标签、
 * 加过自己的标签 —— 那会把人家的编辑冲掉。
 *
 * ∴ 规则：**只对"0.2.4 才引入的字段"做并集**（`otherCues` / `excludeOther`）。
 *   为什么可以这样：用户的文件里**不可能**对这些字段有意见 ——
 *   它们此前根本不存在（老版本 normalizeLabelTable 会把它们丢掉）。
 *   所以"并集"既不会覆盖用户的判断，也天然**幂等**（同一份出厂值并两次结果不变，
 *   这一点很重要：万一将来把并集结果落盘，也不会越滚越大）。
 *   · 用户自己写过的 cues / 名字 / 轴 / antiCues → **一律不动**；
 *   · 用户删掉的标签 → 不复活（只按 id 匹配现有条目）。
 *
 * @returns {{ labels: object[], upgraded: string[] }} 被补过的标签 id（如实报出来）
 */
/** 0.2.4 第十三轮新引入的字段：只有这些才允许"并集注入"。 */
export const FACTORY_INJECT_FIELDS = Object.freeze(['otherCues', 'excludeOther'])

export function applyFactoryUpgrades(labels) {
  const factory = new Map(defaultLabelTable().map((l) => [l.id, l]))
  const upgraded = []
  const out = labels.map((l) => {
    const f = factory.get(l.id)
    if (!f) return l
    const next = { ...l }
    let touched = false
    for (const field of FACTORY_INJECT_FIELDS) {
      const mine = Array.isArray(next[field]) ? next[field] : []
      const theirs = Array.isArray(f[field]) ? f[field] : []
      if (!theirs.length) continue
      const merged = [...mine]
      for (const x of theirs) if (!merged.includes(x)) merged.push(x)
      if (merged.length !== mine.length) {
        next[field] = merged
        touched = true
      }
    }
    if (touched) upgraded.push(l.id)
    return next
  })
  return { labels: out, upgraded }
}

/**
 * **运行期唯一入口**：当前生效的标签表（内置默认 ← 被 `labels.json` 覆盖）。
 *
 * ★ 每轮现读（比 `mtime`，没变就用缓存）—— 所以标注台里新建的标签**下一轮对话就生效**，
 *   与桥接的其它"每轮现读"一致，不需要重启。
 * ★ 从文件读出来之后会过一遍 `applyFactoryUpgrades`：把出厂表里**新增的**线索字段
 *   补给用户（只增不减），否则"改进了出厂表"对老用户永远到不了。
 */
export function activeLabels(opts = {}) {
  const file = labelsFile(opts)
  // 文件签名 = 内容长度（跨进程改了词表也能发现）；本进程的写另有代际号兜底
  let sig = ''
  try {
    sig = existsSync(file) ? `${readFileSync(file, 'utf8').length}:${writeGen}` : `absent:${writeGen}`
  } catch {
    sig = `err:${writeGen}`
  }
  if (cache.labels && cache.file === file && cache.sig === sig) return cache.labels
  const r = readTableFile(opts)
  if (!r.table) {
    cache = { labels: defaultLabelTable(), sig, source: 'default', warnings: r.why ? [r.why] : [], file, upgraded: [] }
    return cache.labels
  }
  const n = normalizeLabelTable(r.table)
  if (!n.ok) {
    cache = { labels: defaultLabelTable(), sig, source: 'default', warnings: [`词表文件不合法（${n.warnings[0] ?? '未知'}）→ 用内置默认表`], file, upgraded: [] }
    return cache.labels
  }
  // ★ 只把出厂表**新增的**线索字段补进来（用户填过的一律不动）
  const { labels: merged, upgraded } = applyFactoryUpgrades(n.labels)
  cache = { labels: merged, sig, source: 'file', warnings: n.warnings, file, upgraded }
  return cache.labels
}

/** 词表状态（给控制台/CLI/标注台显示"现在用的是哪份、有没有告警"）。 */
export function labelTableStatus(opts = {}) {
  activeLabels(opts)
  return {
    source: cache.source,
    file: cache.file,
    warnings: [...cache.warnings],
    count: cache.labels.length,
    labelsFileExists: Boolean(cache.file && existsSync(cache.file)),
    // ★ 从出厂表补过线索的标签（如实报出：词表被"只增不减"地动过）
    upgraded: [...(cache.upgraded ?? [])],
  }
}

/** 清缓存（测试与"刚写完立刻读"的场合用；正常路径靠文件签名 + 代际号自动失效）。 */
export function resetLabelCache() {
  cache = { labels: null, sig: '', source: 'default', warnings: [], file: '' }
  writeGen += 1
}

/* ── 查询（**全部走 activeLabels**，不再直接读常量）──────────────────── */

export function activeLabelById(id, opts = {}) {
  const key = String(id ?? '').trim()
  return activeLabels(opts).find((l) => l.id === key) ?? null
}

export function activeLabelByName(name, opts = {}) {
  const key = String(name ?? '').trim()
  return activeLabels(opts).find((l) => l.name === key) ?? null
}

/** 归一化一个标签引用（id 或中文名，大小写不敏感）→ id；认不出 null。 */
export function resolveActiveLabelId(input, opts = {}) {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const labels = activeLabels(opts)
  const hit = labels.find((l) => l.id === raw) ?? labels.find((l) => l.name === raw) ?? labels.find((l) => l.id === raw.toLowerCase())
  return hit ? hit.id : null
}

/** 标签的中文名（认不出原样返回）。 */
export function activeLabelName(id, opts = {}) {
  return activeLabelById(id, opts)?.name ?? String(id ?? '')
}

/** 这个标签能不能被"自主补"触发（表达类可以；礼节/交付/风险不行）。 */
export function activeIsAutoAllowed(id, opts = {}) {
  const def = activeLabelById(id, opts)
  return Boolean(def) && AUTO_ALLOWED_AXES.has(def.axis)
}

/** 当前生效的标签 id 列表（**顺序就是词表顺序** —— 挑主标签要的"稳定"靠它）。 */
export function activeLabelIds(opts = {}) {
  return activeLabels(opts).map((l) => l.id)
}

/* ── 写入（标注台/CLI 用）────────────────────────────────────────────── */

/**
 * 新建一个标签（**实时生效**：写文件 + 清缓存）。
 *
 * @returns {{ ok:boolean, label?:object, why?:string, warnings?:string[] }}
 */
export function createLabel(opts = {}, { name, axis, cues = [], otherCues = [] } = {}) {
  const file = labelsFile(opts)
  if (!file) return { ok: false, why: '没有工作区，词表无处可写' }
  const cleanName = String(name ?? '').trim().slice(0, MAX_NAME_LEN)
  const cleanAxis = String(axis ?? '').trim()
  if (!cleanName) return { ok: false, why: '标签名不能为空' }
  if (!AXIS_SET.has(cleanAxis)) return { ok: false, why: `轴必须是：${LABEL_AXES.join(' / ')}` }

  const current = activeLabels(opts).map((l) => ({ ...l }))
  if (current.some((l) => l.name === cleanName)) return { ok: false, why: `已经有一个叫「${cleanName}」的标签了` }
  if (current.length >= MAX_LABELS) return { ok: false, why: `标签数已达上限 ${MAX_LABELS}` }

  const used = new Set(current.map((l) => l.id))
  const cleanCues = (v) =>
    (Array.isArray(v) ? v : [])
      .map((x) => String(x ?? '').trim().slice(0, MAX_CUE_LEN))
      .filter(Boolean)
      .slice(0, MAX_CUES)
  const label = {
    id: makeLabelId(cleanName, used),
    name: cleanName,
    axis: cleanAxis,
    cues: cleanCues(cues),
    // ★ 新建时就能一起给"对方会说什么"（用户建的标签常常是场景驱动：
    //   「对方加班到很晚」该配一张，而不是"我自己说我很累"）
    otherCues: cleanCues(otherCues),
    antiCues: [],
    exclude: [],
    excludeOther: [],
    exclusive: [],
  }
  const next = [...current, label]
  const w = writeTable(opts, next)
  if (!w.ok) return { ok: false, why: w.why }
  return { ok: true, label, warnings: w.warnings }
}

/** 改一个标签（只能改中文名 / 轴 / 线索；**id 不能改** —— 库里引用的是它）。 */
export function updateLabel(opts = {}, id, patch = {}) {
  const key = String(id ?? '').trim()
  const current = activeLabels(opts).map((l) => ({ ...l }))
  const idx = current.findIndex((l) => l.id === key)
  if (idx < 0) return { ok: false, why: `没有这个标签：${key}` }
  const cur = current[idx]
  if (key === RISK_LABEL && patch.name && String(patch.name).trim() !== cur.name) {
    return { ok: false, why: '「慎发」是安全闸门，不能改名（要禁这类图请用配置里的 allowRisky）' }
  }
  const clean = (v, max) => String(v ?? '').trim().slice(0, max)
  if (patch.name != null) {
    const name = clean(patch.name, MAX_NAME_LEN)
    if (!name) return { ok: false, why: '标签名不能为空' }
    if (current.some((l, i) => i !== idx && l.name === name)) return { ok: false, why: `已经有一个叫「${name}」的标签了` }
    cur.name = name
  }
  if (patch.axis != null) {
    const axis = clean(patch.axis, 8)
    if (!AXIS_SET.has(axis)) return { ok: false, why: `轴必须是：${LABEL_AXES.join(' / ')}` }
    cur.axis = axis
  }
  for (const f of ['cues', 'otherCues', 'exclude', 'excludeOther']) {
    if (patch[f] != null) {
      cur[f] = (Array.isArray(patch[f]) ? patch[f] : [])
        .map((x) => clean(x, MAX_CUE_LEN))
        .filter(Boolean)
        .slice(0, MAX_CUES)
    }
  }
  current[idx] = cur
  const w = writeTable(opts, current)
  if (!w.ok) return { ok: false, why: w.why }
  return { ok: true, label: cur, warnings: w.warnings }
}

/**
 * 删一个标签（**只动词表，不碰库**）。
 *
 * ★ 图怎么办由**调用方**决定：标注台会把引用了它的图一起恢复成未标注
 *   （见 `sticker-library.clearLabelFromLibrary`）—— 那是用户明确要求的行为。
 *   本函数只管词表这一半，因为"删标签"和"把图恢复成未标注"是两件可分别撤销的事。
 *
 * @returns `{ok, label, removed}` —— ★ `label` 是**被删掉的那份定义**，
 *   调用方要拿它做撤销（撤销时必须先把标签加回来，否则那些图的标签引用
 *   会立刻变成"认不出"，等于撤销失败）。第一版没回这个，撤销就悄悄不生效。
 */
export function deleteLabel(opts = {}, id) {
  const key = String(id ?? '').trim()
  if (key === RISK_LABEL) return { ok: false, why: '「慎发」是安全闸门，不能删（要禁这类图请用配置里的 allowRisky）' }
  const current = activeLabels(opts).map((l) => ({ ...l }))
  const idx = current.findIndex((l) => l.id === key)
  if (idx < 0) return { ok: false, why: `没有这个标签：${key}` }
  if (current.length <= 1) return { ok: false, why: '至少要留一个标签（否则什么都打不了）' }
  const removed = { ...current[idx] }
  const w = writeTable(opts, current.filter((l) => l.id !== key))
  if (!w.ok) return { ok: false, why: w.why }
  return { ok: true, label: removed, removed, warnings: w.warnings }
}

/**
 * 把一个标签**加回词表**（撤销"删标签"用的）。
 *
 * ★ 为什么要单独一个函数：撤销删标签时，图的 `primary` 要写回原来的 id，
 *   而 `applyStickerLabels` 走**生效词表**校验 —— 标签不在表里就被判"认不出"，
 *   于是**看起来撤销没生效**（实测就是这么被抓到的：删掉「笑死」再撤销，
 *   图仍然是未标注，而且不报错）。所以必须"先恢复词表，再恢复图"。
 *
 * 幂等：已经在表里就什么都不做。
 */
export function restoreLabel(opts = {}, label = {}) {
  const file = labelsFile(opts)
  if (!file) return { ok: false, why: '没有工作区，词表无处可写' }
  const name = String(label?.name ?? '').trim()
  const axis = String(label?.axis ?? '').trim()
  const id = String(label?.id ?? '').trim()
  if (!name || !AXIS_SET.has(axis)) return { ok: false, why: '要恢复的标签定义不完整（缺名字或轴不合法）' }
  const current = activeLabels(opts).map((l) => ({ ...l }))
  if (current.some((l) => l.id === id)) return { ok: true, already: true } // 幂等
  if (current.length >= MAX_LABELS) return { ok: false, why: `标签数已达上限 ${MAX_LABELS}` }
  if (current.some((l) => l.name === name)) return { ok: false, why: `已经有一个叫「${name}」的标签了` }
  const item = {
    // ★ id 要**原样恢复**（库里那些图引用的是它，换一个 id 等于没恢复）
    id: /^[a-z0-9][a-z0-9-]{0,39}$/.test(id) ? id : makeLabelId(name, new Set(current.map((l) => l.id))),
    name,
    axis,
    cues: (Array.isArray(label.cues) ? label.cues : []).map((x) => String(x ?? '').trim().slice(0, MAX_CUE_LEN)).filter(Boolean).slice(0, MAX_CUES),
    otherCues: (Array.isArray(label.otherCues) ? label.otherCues : []).map((x) => String(x ?? '').trim().slice(0, MAX_CUE_LEN)).filter(Boolean).slice(0, MAX_CUES),
    antiCues: (Array.isArray(label.antiCues) ? label.antiCues : []).map((x) => String(x ?? '').trim().slice(0, MAX_CUE_LEN)).filter(Boolean).slice(0, MAX_CUES),
    exclude: (Array.isArray(label.exclude) ? label.exclude : []).map((x) => String(x ?? '').trim().slice(0, MAX_CUE_LEN)).filter(Boolean).slice(0, MAX_CUES),
    excludeOther: (Array.isArray(label.excludeOther) ? label.excludeOther : []).map((x) => String(x ?? '').trim().slice(0, MAX_CUE_LEN)).filter(Boolean).slice(0, MAX_CUES),
    // ★ `exclusive` 也要一起还原：它现在不参与判定（互斥改由 SUPPRESS_PAIRS 承担），
    //   但"原样恢复"是撤销的语义 —— 少一个字段就不叫原样了。
    exclusive: (Array.isArray(label.exclusive) ? label.exclusive : []).map((x) => String(x ?? '').trim().slice(0, MAX_CUE_LEN)).filter(Boolean).slice(0, MAX_CUES),
  }
  // 放回**原来的位置**（顺序决定"挑主标签"的优先级），认不出就追加
  const at = Number.isInteger(label.at) && label.at >= 0 && label.at <= current.length ? label.at : current.length
  const next = [...current.slice(0, at), item, ...current.slice(at)]
  const w = writeTable(opts, next)
  if (!w.ok) return { ok: false, why: w.why }
  return { ok: true, label: item, warnings: w.warnings }
}

/** 恢复内置默认表（删掉 `labels.json` 的内容，写回出厂那一份）。 */
export function resetLabels(opts = {}) {
  const w = writeTable(opts, defaultLabelTable())
  if (!w.ok) return { ok: false, why: w.why }
  return { ok: true, warnings: w.warnings }
}

/** 写词表文件（先规整再写；规整后一条不剩就拒绝）。 */
function writeTable(opts, labels) {
  const file = labelsFile(opts)
  if (!file) return { ok: false, why: '没有工作区，词表无处可写' }
  const n = normalizeLabelTable(labels)
  if (!n.ok) return { ok: false, why: `这份词表不能用：${n.warnings[0] ?? '未知原因'}` }
  try {
    // ★ 目录可能还不存在（库还没导入过图时 `stickers/` 是空的）——
    //   词表是**用户在标注台里新建标签**时才会写的，不能假设库目录已经建好了。
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ version: 1, labels: n.labels }, null, 2)}\n`, 'utf8')
    resetLabelCache() // 立刻生效（不等 mtime）
    return { ok: true, warnings: n.warnings }
  } catch (error) {
    return { ok: false, why: `写不了词表：${error?.message ?? error}` }
  }
}

/** 内置表里那些"轴"（界面下拉用）。 */
export function labelAxes() {
  return [...LABEL_AXES]
}

// 让"这条线索能不能用"的判据也只有一份（标注台新建标签时要校验）
export { isUsableCue, SAFE_SINGLE_CHAR_CUES }
