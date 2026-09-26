/**
 * 记忆使用侧车（H3，**方案 B**）：回答"这条记忆**多久没进过上下文了**"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 与设计决策 D9 的关系（**先说清楚，免得以后有人顺手加衰减**）
 * ══════════════════════════════════════════════════════════════════════════
 * D9 写的是「只做软删归档，**不做强度浮点衰减**」。hermes 那条（`recall_strength`
 * 按 `exp(-0.693·t/S)` 衰减）与 D9 直接冲突，所以本模块**刻意不做**：
 *   · ❌ 没有浮点权重、没有"强度分"、没有自动降权、没有自动归档、没有删除；
 *   · ✅ 只旁挂一份 `memory/.usage.json`，**只排序、只提示**。
 * 我把这条写成注释而不是只写在文档里，因为"顺手加个权重"看起来太自然了 ——
 * 而它的后果是**记忆被时间悄悄吞掉**，且没有任何地方会提示"这条被降权了"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 我们能观测的是"**被注入**"，不是"**被用上**"
 * ══════════════════════════════════════════════════════════════════════════
 * 这条边界必须写在字段名里（`lastInjectedAt` / `injectedCount`），不能写成
 * "lastUsed" —— 后者会让人以为我们知道模型到底依赖了哪条。我们**不知道**：
 * 记忆是整段注入的，模型用了哪几条既不上报也没有引用标记。
 * 把"进了上下文"说成"被使用"是一种**看起来更聪明**的谎话，正是本项目要避免的。
 * 名字诚实，用途才站得住：它回答的是"这条记忆还在参与对话吗"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 排序规则（只有一个真正的作用：**让注入预算花在还活着的条目上**）
 * ══════════════════════════════════════════════════════════════════════════
 * `memory-store.readMemoryForPrompt` 有条数上限（25 条），超出的只报"另有 N 条"。
 * 上限本来按**文件顺序**截 —— 而新条目是**追加在文件末尾**的，于是"用户说记住 X、
 * 机器人也回了好，而 X 从此再没进过任何一轮上下文"这种失效**完全静默**。
 * 排序规则（纯函数，可离线测）：
 *   ① **刚写下、还没进过上下文**的排最前（写入侧登记 `writtenAt`，见 `recordWrite`）；
 *   ② 进过上下文的按 `lastInjectedAt` 倒序；
 *   ③ 其余（从没进过、也不是刚写下 —— "长期饿着的老条目"）排最后；
 *   ④ 并列一律保持**文件顺序**。
 * ★★ 为什么③不是"从没进过的一律排最前"（那是第一版，被测试打回）：老条目会**每轮抢占头部**，
 *   把刚注入的挤下去 → 同一份记忆每轮渲染出不同文本 → 打断前缀缓存（实测命中 91%~96%）。
 *   现在这样：注入集合一旦稳定，相对次序就稳定；"谁在被饿着"交给体检如实报出，
 *   而不是靠打乱提示词去补救。
 *
 * 用法：
 *   readMemoryForPrompt(...)  → blocks[].shownEntries（桥接据此记账）
 *   recordInjection({ workspace, blocks, chatKey })   ← 只在**真的拼进提示词**之后调
 *   recordWrite({ workspace, entries })               ← 写入侧登记"刚写下"（memory-store.appendEntry）
 *   applyRecencyOrder({ entries, usage })             ← 决定显示顺序（纯函数）
 *   staleEntries({ workspace, usage, now })           ← 体检："最久没进过上下文的 N 条"
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { normalizeForCompare } from './text-similarity.mjs'

/** 侧车文件（相对工作区）。★ 放在 `memory/` 下并带 `.` 前缀 —— 记忆页签只展示契约内的文件，这是内部账本。 */
export const USAGE_REL = 'memory/.usage.json'

/** 侧车格式版本（将来改结构时用来识别旧文件）。 */
export const USAGE_VERSION = 1

/** 账本最多记多少条条目（超了丢最旧的）。丢了只会让那条重新被判为"新条目"，代价很小。 */
export const MAX_USAGE_KEYS = 800

/** 体检里"很久没进过上下文"的默认阈值（天）。⚠️ 只用于**提示**，绝不用于降权。 */
export const STALE_DAYS = 90

/**
 * "刚写下"的窗口（天）：在这个窗口内写下、又还没进过上下文的条目**排最前**。
 *
 * ⚠️ 为什么需要它（第一版漏了，被测试抓出来）：
 * 只按"进过上下文的时间"排序时，**刚追加到文件末尾的新记忆会被 25 条上限截掉** ——
 * 那正是"用户说记住 X、机器人也回了好，而 X 从此再没进过任何一轮上下文"这种
 * 最难查的失效。所以写入侧会登记 `writtenAt`（见 `recordWrite`），排序时让
 * "刚写下的"插到最前。
 * ★ 与"从没进过的一律排最前"的区别：后者会让**长期饿着的老条目**每轮都抢占头部，
 *   于是同一份记忆渲染出的文本每轮都变（打断前缀缓存）—— 见 `applyRecencyOrder`。
 */
export const RECENT_WRITE_DAYS = 14

/** 条目预览长度（体检里给人看的，不参与身份判定）。 */
const PREVIEW_CHARS = 40

/**
 * 条目的**身份**（用于账本的键）。
 *
 * ★ 用归一化文本的 hash 而不是行号：行号会随整理合并/插入而整体漂移，
 *   那会让账本一夜之间全指错人（而且不会报错）。归一化复用 `text-similarity`
 *   （同一套"标点/日期前缀/转述前缀"处理），于是"同一条被打磨过的记忆"仍认得出。
 */
export function entryKey(text) {
  const t = normalizeForCompare(String(text ?? ''))
  if (!t) return ''
  return createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 16)
}

function emptyLedger() {
  return { version: USAGE_VERSION, entries: {} }
}
/**
 * 读账本。**任何异常都不抛**（它是增强路径，坏了不能影响记忆本身），
 * 但坏文件要**留证据**（`AGENT.md` 第 9 条：可以失败，不许安静地失败）。
 */
export function readUsage({ workspace, log = () => {} } = {}) {
  const abs = join(String(workspace ?? ''), USAGE_REL)
  if (!String(workspace ?? '') || !existsSync(abs)) return emptyLedger()
  try {
    const raw = JSON.parse(readFileSync(abs, 'utf8'))
    if (!raw || typeof raw !== 'object' || typeof raw.entries !== 'object' || raw.entries === null) {
      log(`⚠️ [memory-usage] 账本结构不对（${USAGE_REL}）→ 当成空的，记忆本身不受影响`)
      return emptyLedger()
    }
    return { version: Number(raw.version) || USAGE_VERSION, startedAt: Number(raw.startedAt) || 0, entries: { ...raw.entries } }
  } catch (error) {
    log(`⚠️ [memory-usage] 账本读不了（${USAGE_REL}）：${error?.message ?? error} → 当成空的，记忆本身不受影响`)
    return emptyLedger()
  }
}

/**
 * 写账本（临时文件 + rename，与 `tasks.mjs` / `recipes.mjs` 同一套写法）。
 * @returns {boolean} 是否真的写成功（失败**不抛**，但调用方可以据此记日志）
 */
export function writeUsage({ workspace, ledger, log = () => {} } = {}) {
  const root = String(workspace ?? '')
  if (!root) return false
  const abs = join(root, USAGE_REL)
  try {
    mkdirSync(dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
    renameSync(tmp, abs)
    return true
  } catch (error) {
    log(`⚠️ [memory-usage] 账本写不进去（${USAGE_REL}）：${error?.message ?? error} —— 记忆本身已经写好，只是"用没用过"没记上`)
    return false
  }
}

/** 只留最新的 N 条键（丢最旧的；丢了等价于"这一条重新算新的"）。 */
function pruneLedger(ledger, max = MAX_USAGE_KEYS) {
  const keys = Object.keys(ledger.entries)
  if (keys.length <= max) return ledger
  const keep = keys
    .sort((a, b) => Number(ledger.entries[b]?.lastInjectedAt ?? 0) - Number(ledger.entries[a]?.lastInjectedAt ?? 0))
    .slice(0, max)
  const entries = {}
  for (const k of keep) entries[k] = ledger.entries[k]
  return { ...ledger, entries }
}

/**
 * 记一次注入：把这一轮**真的拼进提示词**的那些条目记上时间与次数。
 *
 * @param {{workspace?: string, blocks?: object[], chatKey?: string, at?: number, log?: Function}} opts
 *   `blocks` 是 `readMemoryForPrompt()` 返回的 `blocks`（每块带 `shownEntries`）
 * @returns {{recorded: number, written: boolean}}
 */
export function recordInjection({ workspace, blocks = [], chatKey = '', at = Date.now(), log = () => {} } = {}) {
  const flat = []
  for (const b of Array.isArray(blocks) ? blocks : []) {
    for (const text of b?.shownEntries ?? []) flat.push({ text, rel: b?.rel ?? '' })
  }
  if (flat.length === 0) return { recorded: 0, written: false }

  const ledger = readUsage({ workspace, log })
  // ★ 账本的"开账时间"：没它就没法区分"这条真的从没进过上下文"和"账本刚部署、还没记到这条"。
  //   第一版漏了这一点，于是刚部署完跑体检会把 **65 条**全部报成"从没进过上下文" ——
  //   数字是真的，结论是错的（那是缺数据，不是缺使用）。
  if (!Number(ledger.startedAt)) ledger.startedAt = at
  let recorded = 0
  for (const { text, rel } of flat) {
    const key = entryKey(text)
    if (!key) continue
    const cur = ledger.entries[key] ?? { firstInjectedAt: at, injectedCount: 0 }
    ledger.entries[key] = {
      firstInjectedAt: Number(cur.firstInjectedAt) || at,
      lastInjectedAt: at,
      injectedCount: (Number(cur.injectedCount) || 0) + 1,
      rel,
      chats: bumpChats(cur.chats, chatKey),
      preview: String(text).slice(0, PREVIEW_CHARS),
    }
    recorded += 1
  }
  const written = writeUsage({ workspace, ledger: pruneLedger(ledger), log })
  return { recorded, written }
}

/** 记下"哪几个会话见过这条"（最多 5 个）—— 排查"这条记忆到底有没有人看得见"时最有用。 */
function bumpChats(cur, chatKey) {
  const list = Array.isArray(cur) ? cur.slice(0, 5) : []
  const k = String(chatKey ?? '')
  if (!k) return list
  if (list.includes(k)) return list
  return [...list, k].slice(0, 5)
}

/**
 * 记一次**写入**：某条记忆刚被写进文件（还没进过上下文）。
 *
 * ★ 为什么写入侧要参与：注入有条数上限，而新条目**追加在文件末尾** ——
 *   不登记"刚写下"，它就会被老条目挤出上下文，而**没有任何地方会报错**
 *   （用户听到的是"记住了"，磁盘上也有，但它永远不再出现）。
 * 只写 `writtenAt`，不碰 `lastInjectedAt`（那是"进过上下文"的账）。
 */
export function recordWrite({ workspace, entries = [], rel = '', at = Date.now(), log = () => {} } = {}) {
  const list = (Array.isArray(entries) ? entries : [entries]).map((t) => String(t ?? '')).filter(Boolean)
  if (list.length === 0 || !String(workspace ?? '')) return { recorded: 0, written: false }
  const ledger = readUsage({ workspace, log })
  if (!Number(ledger.startedAt)) ledger.startedAt = at
  let recorded = 0
  for (const text of list) {
    const key = entryKey(text)
    if (!key) continue
    const cur = ledger.entries[key] ?? {}
    ledger.entries[key] = {
      ...cur,
      writtenAt: at,
      ...(Number(cur.lastInjectedAt) ? {} : { firstInjectedAt: cur.firstInjectedAt ?? null }),
      rel: rel || cur.rel || '',
      preview: cur.preview ?? String(text).slice(0, PREVIEW_CHARS),
    }
    recorded += 1
  }
  const written = writeUsage({ workspace, ledger: pruneLedger(ledger), log })
  return { recorded, written }
}

/**
 * 按"最近进过上下文 / 刚写下"排序（**纯函数**）。
 *
 * 规则（顺序即优先级）：
 *   ① **刚写下、还没进过上下文**（`writtenAt` 在 `RECENT_WRITE_DAYS` 内）→ 排最前，
 *      按 `writtenAt` 倒序（刚记住的必须先被看见）；
 *   ② 进过上下文的 → 按 `lastInjectedAt` 倒序；
 *   ③ 其余（从没进过、也不是刚写下 —— 即"长期饿着的老条目"）→ 排最后，按文件顺序；
 *   ④ 并列一律按**文件顺序**（稳定）。
 *
 * ★★ 为什么③不能是"从没进过的一律排最前"：那样老条目会每轮抢占头部、把刚被注入的挤下去，
 *   于是同一份记忆**每轮渲染出不同的文本**，把前缀缓存（实测命中 91%~96%）打断。
 *   现在这样：注入集合一旦稳定，所有条目的相对次序就稳定 → 文本不变；
 *   而"谁在被饿着"由体检（`staleEntries`）如实报出来，不靠打乱提示词去补救。
 *
 * ⚠️ 它**不改内容、不删条目、不算权重**（D9：不做强度浮点衰减），只是重排。
 */
export function applyRecencyOrder({ entries = [], usage = null, now = Date.now(), recentDays = RECENT_WRITE_DAYS } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const table = usage?.entries ?? usage ?? {}
  const freshCutoff = Number(now) - Number(recentDays) * 86_400_000
  const decorated = list.map((text, index) => {
    const rec = table[entryKey(text)]
    const injectedAt = Number(rec?.lastInjectedAt)
    const writtenAt = Number(rec?.writtenAt)
    const seen = Number.isFinite(injectedAt) && injectedAt > 0
    const fresh = !seen && Number.isFinite(writtenAt) && writtenAt > 0 && writtenAt >= freshCutoff
    return { text, index, seen, fresh, injectedAt: seen ? injectedAt : 0, writtenAt: Number.isFinite(writtenAt) ? writtenAt : 0 }
  })
  decorated.sort((a, b) => {
    if (a.fresh !== b.fresh) return a.fresh ? -1 : 1 // ① 刚写下的在最前
    if (a.fresh && b.fresh && a.writtenAt !== b.writtenAt) return b.writtenAt - a.writtenAt
    if (a.seen !== b.seen) return a.seen ? -1 : 1 // ② 进过上下文的在没进过的之前
    if (a.seen && b.seen && a.injectedAt !== b.injectedAt) return b.injectedAt - a.injectedAt
    return a.index - b.index // ④ 稳定：并列保持文件顺序
  })
  return decorated.map((d) => d.text)
}

/**
 * 体检用：扫**所有**记忆文件，找出"最久没进过上下文"的条目。
 *
 * ★ 为什么必须扫文件而不是只看账本：账本里只有"进过上下文"的条目 ——
 *   而最该被发现的恰恰是**从来没进过**的那些（比如某个群早就不说话了，
 *   它的 group-<群号>.md 一直在，但从没被注入过）。只看账本会把它们全部漏掉。
 *
 * @returns {{rel: string, text: string, lastInjectedAt: number|null, injectedCount: number, days: number|null}[]}
 *   按"最久没用"排序：从没注入过的排最前
 */
export function staleEntries({ workspace, usage = null, now = Date.now(), days = STALE_DAYS } = {}) {
  const root = String(workspace ?? '')
  const table = usage?.entries ?? usage ?? {}
  const memDir = join(root, 'memory')
  const rels = []
  if (existsSync(join(root, 'MEMORY.md'))) rels.push('MEMORY.md')
  if (existsSync(memDir)) {
    for (const name of readdirSync(memDir).sort()) {
      if (!name.endsWith('.md')) continue
      rels.push(`memory/${name}`)
    }
  }

  const out = []
  for (const rel of rels) {
    let lines = []
    try {
      lines = readFileSync(join(root, rel), 'utf8').split(/\r?\n/)
    } catch {
      continue
    }
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('- ')) continue
      const text = t.slice(2).trim()
      if (!text) continue
      // ⚠️ 已被更正的条目**不参与**这个体检：它们本来就该被忽略（`isSuperseded` 在注入侧过滤）。
      //    这里用最轻的判据（避免把 memory-store 拉进来造成循环依赖）。
      if (text.includes('〔已被更正')) continue
      const rec = table[entryKey(text)]
      const at = Number(rec?.lastInjectedAt)
      const writtenAt = Number(rec?.writtenAt)
      const seen = Number.isFinite(at) && at > 0
      // ★ 刚写下、还没进过上下文的条目不进体检名单：它是"新"，不是"死"。
      //   （第一版会把它们全列成"从没进过上下文" —— 又是一次"没有数据 ≠ 没用过"。）
      const fresh = Number.isFinite(writtenAt) && writtenAt > 0 && now - writtenAt < days * 86_400_000
      if (!seen && fresh) continue
      const ageDays = seen ? Math.floor((now - at) / 86_400_000) : null
      if (seen && ageDays !== null && ageDays < days) continue
      out.push({ rel, text, lastInjectedAt: seen ? at : null, injectedCount: Number(rec?.injectedCount) || 0, days: ageDays })
    }
  }
  out.sort((a, b) => {
    if (a.lastInjectedAt === null && b.lastInjectedAt !== null) return -1
    if (a.lastInjectedAt !== null && b.lastInjectedAt === null) return 1
    if (a.lastInjectedAt === null && b.lastInjectedAt === null) return 0
    return a.lastInjectedAt - b.lastInjectedAt
  })
  return out
}

/** 渲染成给人看的一段（`--memory --usage` / 体检共用，避免两处文案分叉）。 */
export function renderUsageReport({ stale = [], total = 0, neverInjected = 0, days = STALE_DAYS, startedAt = 0 } = {}) {
  const lines = []
  // ★★ 账本还空着时**不能**把"没有记录"说成"从没被用过" —— 那是缺数据，不是缺使用。
  //    第一版就是那样，把 65 条全列出来当"从没进过上下文"，数字真、结论错。
  if (total === 0) {
    lines.push('记忆使用账本：**还是空的** —— 它从这次升级之后才开始记。')
    lines.push(`所以现在**无法判断**哪条记忆没被用过（不是"全都没被用过"）。先去聊两轮，再回来看这里。`)
    lines.push('⚠️ 账本只用于**提示**：不会自动降权、不会自动归档、不会删（设计决策 D9）。')
    return lines.join('\n')
  }
  const since = Number(startedAt) ? `（账本从 ${new Date(Number(startedAt)).toISOString().slice(0, 10)} 开始记）` : ''
  lines.push(`记忆使用账本：记着 ${total} 条条目的"最近一次进入上下文"时间${since}。`)
  lines.push(
    `其中 ${stale.length} 条已经 ${days} 天以上没进过任何会话的上下文` +
      (neverInjected > 0 ? `（含 ${neverInjected} 条**自从账本开始记就没进去过**）` : '') +
      '。',
  )
  lines.push('⚠️ 这只是**提示**，不会自动降权、不会自动归档、不会删 —— 删不删由你决定。')
  if (stale.length > 0) {
    lines.push('')
    for (const s of stale.slice(0, 50)) {
      const when =
        s.lastInjectedAt === null
          ? '自从账本开始记就没进过上下文'
          : `${s.days} 天前（累计注入 ${s.injectedCount} 次）`
      lines.push(`  · [${s.rel}] ${s.text.slice(0, 60)}  —— ${when}`)
    }
    if (stale.length > 50) lines.push(`  …（另有 ${stale.length - 50} 条）`)
  }
  return lines.join('\n')
}
