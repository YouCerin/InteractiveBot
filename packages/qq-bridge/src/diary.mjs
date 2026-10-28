/**
 * 她的日记（0.3.3）：一个文件夹、一个 `.jsonl`、一行一条。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么是纯文本，不是数据库
 * ══════════════════════════════════════════════════════════════════════════
 * 使用者原话：「不要搞数据库。就用最土的：一个 .jsonl 文件，一行一条。」
 *   · 你能直接双击打开看
 *   · 你能 grep 它（搜"梨"就能翻到所有提到梨的日子）
 *   · 你能手改（她写歪了你能修）
 *   · 备份就是复制一个文件
 *
 * ── ★ 最重要的一条规矩：**别替她写** ──────────────────────────────────────
 * 这个模块**只提供两个动作**：`appendDiary`（写一条）与 `readRecentDiary`（看最近几条）。
 * **没有**删除、没有"改成某一天"、没有"帮我写完这句" —— 那些是人（主人）的活。
 * 也不提供"按日期生成"之类的入口：一旦能指定日期，就变成了替她排稿。
 *
 * ── 三个坑（都写死在实现里）──────────────────────────────────────────────
 * 1. **别让她固定时间写**：所以这里**没有**任何"每天定时写入"的钩子，
 *    也没有"今天还没写"的提醒 —— 写不写由她决定（工具描述也只写"你可以写点什么"）。
 * 2. **别让她写总结句**：长度上限 200 字（一两句），并在工具描述里明说"别写'今天真是充实的一天'这种"。
 * 3. **别写成汇报**：工具描述不出现"你应该记录今天发生的事"；这里也只校验形状，
 *    **不检查内容有没有提到具体的事** —— 内容是她的。
 *
 * ── 唯一由代码管的东西 ────────────────────────────────────────────────────
 *   · **一天最多三条**（使用者给的规则，超了就如实拒，并说清"明天再写"）；
 *   · 隐私闸（身份证/手机号/银行卡/密码/住址/健康/生物特征）—— 与记忆同一条：
 *     日记也落盘，落盘的文本同样不该带这类东西；
 *   · 时间**由系统给**（`YYYY-MM-DD HH:mm`），不接受调用方指定日期。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { PRIVACY_CATEGORIES, screenForStore } from './privacy.mjs'

/** 日记的落点与规矩（改这里就等于改"她的日记长什么样"）。 */
export const DIARY = Object.freeze({
  dir: 'diary',
  file: 'diary/diary.jsonl',
  /** 一天最多几条（使用者：「你可以规定'一天最多三条'」）。 */
  maxPerDay: 3,
  /** 一条最多几个字（「每条一两句就够」）。 */
  maxChars: 200,
  /** 心情最多几个字（它是标签，不是句子）。 */
  maxMoodChars: 12,
})

/** 工作区 → 日记文件的绝对路径（`workspace` 可以是绝对路径，也可以是相对包根）。 */
export function diaryPath(workspace, { pkgRoot = '' } = {}) {
  const ws = String(workspace ?? '').trim()
  if (!ws) return ''
  const root = isAbsolute(ws) ? ws : join(pkgRoot || process.cwd(), ws)
  return join(root, ...DIARY.file.split('/'))
}

/** `YYYY-MM-DD HH:mm`（**本地时间**：她写的是"今天"，不是 UTC 的今天）。 */
export function formatDiaryTime(at = new Date()) {
  const d = at instanceof Date ? at : new Date(Number(at) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 读原始行（坏行不抛，交给调用方跳过）。 */
function readLines(file) {
  try {
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').split(/\r?\n/)
  } catch {
    return []
  }
}

/** 解析一行；形状不对返回 null。 */
function parseLine(line) {
  const s = String(line ?? '').trim()
  if (!s) return null
  try {
    const o = JSON.parse(s)
    if (!o || typeof o !== 'object') return null
    const time = String(o.时间 ?? '').trim()
    const content = String(o.内容 ?? '').trim()
    if (!time || !content) return null
    return { 时间: time, 心情: String(o.心情 ?? '').trim(), 内容: content }
  } catch {
    return null
  }
}

/** 这一天已经写了几条（按 `时间` 的日期前缀数）。 */
export function countOnDay(entries, day) {
  const d = String(day ?? '').trim()
  if (!d) return 0
  return (Array.isArray(entries) ? entries : []).filter((e) => String(e?.时间 ?? '').startsWith(d)).length
}

/**
 * 写一条。
 *
 * @param {{workspace?: string, pkgRoot?: string, mood?: string, text?: string, now?: Date}} opts
 * @returns {{ok: true, entry: {时间: string, 心情: string, 内容: string}, wroteTo: string}
 *          | {ok: false, why: string}}
 */
export function appendDiary({ workspace, pkgRoot = '', mood = '', text = '', now = new Date() } = {}) {
  const file = diaryPath(workspace, { pkgRoot })
  if (!file) return { ok: false, why: '缺 workspace（不知道该写到哪个工作区）' }
  const content = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!content) return { ok: false, why: '没写内容（空的一条不落盘）' }
  const chars = [...content].length
  if (chars > DIARY.maxChars) {
    return { ok: false, why: `太长了（${chars} 字 > ${DIARY.maxChars}）：写一两句就够，细节可以以后再写` }
  }
  const moodText = String(mood ?? '').replace(/\s+/g, ' ').trim().slice(0, DIARY.maxMoodChars)
  // ★ 隐私闸：与记忆同一条纪律 —— 落盘的文本不带那七类东西。
  const priv = screenForStore(content)
  if (!priv.ok) {
    // ★ 回执说**中文类别**（`phone` 这种内部键名对她没有意义，见 `PRIVACY_CATEGORIES`）。
    const kinds = (priv.categories ?? []).map((c) => PRIVACY_CATEGORIES[c] ?? c).join('、')
    return { ok: false, why: `这条里写了${kinds || '隐私信息'}，不写进日记（日记会一直躺在盘上）` }
  }
  const at = formatDiaryTime(now)
  const day = at.slice(0, 10)

  const existing = readLines(file).map(parseLine).filter(Boolean)
  if (countOnDay(existing, day) >= DIARY.maxPerDay) {
    return { ok: false, why: `今天已经写了 ${DIARY.maxPerDay} 条（上限），剩下的留到明天吧` }
  }

  const entry = { 时间: at, 心情: moodText, 内容: content }
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    // ★ 一行一条：上一行没有换行结尾时先补一个（手改过的文件很容易缺）
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const prefix = raw && !raw.endsWith('\n') ? '\n' : ''
    appendFileSync(file, `${prefix}${JSON.stringify(entry)}\n`, 'utf8')
    return { ok: true, entry, wroteTo: file }
  } catch (error) {
    return { ok: false, why: `写不进去：${error?.message ?? error}` }
  }
}

/**
 * 看最近几条（**只读**）。
 *
 * ★ "最近"= **文件末尾那几条**（按写入顺序），**不按时间重排** ——
 *   手改过的文件可能时间乱序，重排就等于替她整理，而整理不是这里的活。
 *
 * @param {{workspace?: string, pkgRoot?: string, limit?: number}} opts
 * @returns {{ok: boolean, entries: Array<{时间:string,心情:string,内容:string}>, total: number,
 *            skipped?: number, why?: string}}
 */
export function readRecentDiary({ workspace, pkgRoot = '', limit = 5 } = {}) {
  const file = diaryPath(workspace, { pkgRoot })
  if (!file) return { ok: false, entries: [], total: 0, why: '缺 workspace' }
  if (!existsSync(file)) return { ok: true, entries: [], total: 0 }
  const lines = readLines(file)
  const all = []
  let skipped = 0
  for (const l of lines) {
    if (!String(l).trim()) continue
    const e = parseLine(l)
    if (!e) {
      skipped += 1
      continue
    }
    all.push(e)
  }
  const n = Math.max(1, Math.min(50, Number(limit) || 5))
  return {
    ok: true,
    entries: all.slice(-n),
    total: all.length,
    ...(skipped > 0 ? { skipped } : {}),
  }
}

/**
 * 把"最近几条"渲染成模型能读的一段（**不解释、不修饰**）。
 *
 * ★ 为什么不在提示词里教她"该写什么"：使用者原话「不要规定今天要写什么」。
 *   这里只把已有的几条原样列出来。
 */
export function renderRecentDiary({ entries = [], total = 0, skipped = 0 } = {}) {
  const list = Array.isArray(entries) ? entries : []
  if (!list.length) return '（日记还是空的）'
  const lines = list.map((e) => `· ${e.时间}${e.心情 ? `（${e.心情}）` : ''} ${e.内容}`)
  const head = `最近 ${list.length} 条（一共 ${total} 条${skipped ? `，另有 ${skipped} 行读不出来` : ''}）：`
  return [head, ...lines].join('\n')
}
