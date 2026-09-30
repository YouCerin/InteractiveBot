/**
 * 个人层的**行为统计与习惯**（0.2.9 决定：纳入）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它回答什么、不回答什么
 * ══════════════════════════════════════════════════════════════════════════
 * 回答："这个人**跟我熟不熟**" —— 说过多少次话、第一次/最后一次是什么时候、
 *       一般在哪个时段出现。这些**全都由桥接确定性累加**，与模型无关，
 *       所以它们**不会**被模型编出来（这是"记忆真实"的一部分）。
 * 不回答："他是什么样的人" —— 那属于个人层的**条目**（`memory/people/<QQ>.md`），
 *       由情绪通道/模型提议/关键词直写产生，走 `screenEntry` 那道内容闸门。
 *
 * ── 为什么是**隐藏侧车**而不是个人档里的一行 ──────────────────────────────
 * `memory/.people.json` 与既有的 `memory/.stats.json`（每会话计数）、
 * `memory/.usage.json`（条目使用）是同一类东西：**只记数字、不记内容**，
 * 而且不该被当记忆注入、也不该出现在控制台的记忆树里。隐藏文件天然满足这三点
 * （记忆树跳过 `.` 开头的条目）。写进 `.md` 档里反而要发明一套行格式，
 * 还会占掉那 60 条/8 条的上限。
 *
 * ── 计数口径（**说清楚，因为它决定"常来"是什么意思**）────────────────────
 * `messages` 统计的是「**他来找机器人说话**」的次数 —— 调用点在准入判定**之后**、
 * 语义唤醒闸门**之前**。所以：
 *   · 群里没 @ 机器人的消息**不算**（那些消息桥接根本没读，见 G6 的实测数字）；
 *   · 但被语义判定判成"沉默"的消息**算**（他确实是在跟机器人说话）。
 * 换句话说它量的是**关系**（他多常来找我），不是**群活跃度**。
 *
 * ★★ 而且是**跨会话按人聚合**的（0.2.9 定稿时改过一版，理由值得记下来）：
 *   第一版按 `会话 + 人` 分开存，结果**私聊里读不到他在群里的那份统计** ——
 *   而那恰好违反个人层"跟人走"的整个立意（"对个人的记忆在私聊里也有效"）。
 *   现在按 `userId` 聚合：他在群里说的话，私聊里也认得出"他常来"。
 *   代价如实记下：**看不到"只在某个群"的次数** —— 但那个信息对"认不认识这个人"没用，
 *   而 `chats` 里仍然留了分会话计数（界面/排查需要时能看）。
 *
 * ── 隐私与边界（如实写清）───────────────────────────────────────────────
 *   · 只存**计数与小时直方图**：不存消息内容、不存话题、不存词频；
 *   · 小时直方图是 24 个整数 —— 它足以支撑"常在晚上出现"，但不足以还原作息细节；
 *   · 条数上限 `PEOPLE_MAX`：到顶后**新的人不再计入**，并**只喊一次**日志
 *     （不许静默：否则"统计怎么不长了"会变成一桩无头案）；
 *   · 任何失败只记一行日志，绝不影响聊天（与 memory-stats / oplog 同一条纪律）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 侧车路径（隐藏文件：不进记忆树、不被注入、不被篡改检测扫）。 */
export const PEOPLE_STATS_REL = 'memory/.people.json'

export const PEOPLE_STATS_VERSION = 1

/** 最多记多少个人（防无界增长）。到顶后新面孔不再计入。 */
export const PEOPLE_MAX = 500

/** 少于这么多次，不渲染那一行 —— "数据不足就别装熟"。 */
export const MIN_MESSAGES_FOR_LINE = 5

/** 说"常来"的门槛（低于它只如实报次数）。 */
export const FREQUENT_MESSAGES = 30

/** 峰值时段（"常在 X 点出现"）至少要有的次数；不够就不提时段。 */
export const PEAK_MIN_COUNT = 3

/** 峰值窗口的扩展门槛：邻居桶至少要有峰值的这个比例。 */
export const PEAK_NEIGHBOR_RATIO = 0.5

let warnedCap = false
/** 测试用：清掉"已经喊过上限"的记录。 */
export function __resetPeopleStatsWarnings() {
  warnedCap = false
}

function path(workspace) {
  return join(String(workspace ?? ''), PEOPLE_STATS_REL)
}

/** 读整个侧车（坏文件 → 当成空的，但**留证据**）。 */
export function readPeopleStatsFile({ workspace, log = () => {} } = {}) {
  const p = path(workspace)
  try {
    if (!existsSync(p)) return { version: PEOPLE_STATS_VERSION, people: {} }
    let text = readFileSync(p, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.people !== 'object' || !parsed.people) {
      log(`⚠️ [people-stats] ${PEOPLE_STATS_REL} 结构不对，按空处理（统计会从零重新累加）`)
      return { version: PEOPLE_STATS_VERSION, people: {} }
    }
    return { version: PEOPLE_STATS_VERSION, people: parsed.people }
  } catch (error) {
    // ★ 不许静默：读不出来意味着"计数会从零开始"，而使用者只会看到"它好像不认得我了"
    log(`⚠️ [people-stats] 读不出来（按空处理，统计会从零重新累加）：${error?.message ?? error}`)
    return { version: PEOPLE_STATS_VERSION, people: {} }
  }
}

/** 原子写（tmp + rename）—— 半截文件会让下一次读直接失败。 */
function writeFileAtomic(workspace, data) {
  const p = path(workspace)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, 'utf8')
  renameSync(tmp, p)
}

/** 侧车里的键 = **人**（跨会话聚合；见文件头"跨会话按人聚合"那段）。 */
export function personStatsKey({ userId } = {}) {
  const u = String(userId ?? '').trim()
  return /^\d{5,15}$/.test(u) ? u : null
}

/** 本地日期（yyyy-mm-dd），用来数"来过几天"。 */
function localDay(at) {
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 记一次"他来找机器人说话了"。**每条都调**（累加是确定性的，与模型无关）。
 *
 * @returns {{ok: boolean, rec?: object, why?: string}}
 */
export function notePersonTurn({ workspace, userId, chatKey = '', at = Date.now(), log = () => {} } = {}) {
  try {
    const key = personStatsKey({ userId })
    if (!key) return { ok: false, why: '号码不合法' }
    const data = readPeopleStatsFile({ workspace, log })
    const isNew = !data.people[key]
    if (isNew && Object.keys(data.people).length >= PEOPLE_MAX) {
      if (!warnedCap) {
        warnedCap = true
        log(
          `⚠️ [people-stats] 已达人数上限 ${PEOPLE_MAX}，**新的人不再计入行为统计**` +
            `（老记录照常累加；要腾位置就删 ${PEOPLE_STATS_REL} 里不用的条目）。只报这一次。`,
        )
      }
      return { ok: false, why: `人数已达上限 ${PEOPLE_MAX}` }
    }

    const cur =
      data.people[key] ??
      {
        userId: String(userId),
        messages: 0,
        firstSeenAt: at,
        lastSeenAt: at,
        /** 24 个小时桶（本地时间）—— "常在什么时段出现"。 */
        hours: new Array(24).fill(0),
        /** 来过几天（同一天多来几次只算一天）。 */
        days: 0,
        lastDay: '',
        /** 分会话计数（给人看/排查用；聚合口径是整份记录）。 */
        chats: {},
      }
    const hour = new Date(at).getHours()
    const day = localDay(at)
    cur.messages += 1
    cur.lastSeenAt = at
    if (cur.hours?.length === 24) cur.hours[hour] += 1
    if (cur.lastDay !== day) {
      cur.days = Number(cur.days ?? 0) + 1
      cur.lastDay = day
    }
    const ck = String(chatKey ?? '').trim()
    if (ck) {
      cur.chats = cur.chats && typeof cur.chats === 'object' ? cur.chats : {}
      cur.chats[ck] = (Number(cur.chats[ck]) || 0) + 1
    }
    data.people[key] = cur
    writeFileAtomic(workspace, { version: PEOPLE_STATS_VERSION, people: data.people })
    return { ok: true, rec: cur }
  } catch (error) {
    log(`⚠️ [people-stats] 计数没记上（聊天不受影响）：${error?.message ?? error}`)
    return { ok: false, why: error?.message ?? String(error) }
  }
}

/** 读某人的统计（**按人**，与在哪个会话无关；没有就 null）。 */
export function readPersonStats({ workspace, userId, log = () => {} } = {}) {
  const key = personStatsKey({ userId })
  if (!key) return null
  return readPeopleStatsFile({ workspace, log }).people[key] ?? null
}

/** 峰值时段（返回 `[起, 止)` 的小时区间；没有明显峰值时返回 null）。 */
export function peakHours(hours, { minCount = PEAK_MIN_COUNT, ratio = PEAK_NEIGHBOR_RATIO } = {}) {
  const h = Array.isArray(hours) && hours.length === 24 ? hours.map((n) => Number(n) || 0) : null
  if (!h) return null
  let peak = 0
  for (let i = 1; i < 24; i += 1) if (h[i] > h[peak]) peak = i
  if (h[peak] < minCount) return null
  const need = h[peak] * ratio
  let start = peak
  let end = peak
  // 向左/向右扩：允许跨过 0 点（最多整圈），但**不重复经过同一小时**
  for (let step = 0; step < 23; step += 1) {
    const prev = (start + 23) % 24
    if (prev === end) break
    if (h[prev] >= need) start = prev
    else break
  }
  for (let step = 0; step < 23; step += 1) {
    const next = (end + 1) % 24
    if (next === start) break
    if (h[next] >= need) end = next
    else break
  }
  return [start, (end + 1) % 24]
}

/** "最近"说人话。 */
function recencyText(lastSeenAt, now) {
  const ms = Math.max(0, Number(now) - Number(lastSeenAt || now))
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `最近 ${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `最近 ${hour} 小时前`
  return `最近 ${Math.floor(hour / 24)} 天前`
}

/**
 * 渲染注入用的那一行。**数据不足时返回空串**（宁可不提，也不装熟）。
 *
 * 形如：`他常来（跟我说过 412 次话，最近 3 小时前，常在 20-23 点出现）`
 *
 * @param {object|null} rec  `readPersonStats()` 的结果
 * @param {{now?: number}} [opts]
 */
export function renderPersonStatsLine(rec, { now = Date.now() } = {}) {
  if (!rec) return ''
  const messages = Number(rec.messages) || 0
  if (messages < MIN_MESSAGES_FOR_LINE) return ''
  const head = messages >= FREQUENT_MESSAGES ? '他常来' : `他跟我说过 ${messages} 次话`
  const parts = []
  if (messages >= FREQUENT_MESSAGES) parts.push(`跟我说过 ${messages} 次话`)
  parts.push(recencyText(rec.lastSeenAt, now))
  const peak = peakHours(rec.hours)
  if (peak) {
    const [a, b] = peak
    // b 是"开区间右端"（不含）。跨 0 点时 b <= a。
    const span = b > a ? `${a}-${b} 点` : `${a} 点到次日 ${b} 点`
    parts.push(`常在 ${span}出现`)
  }
  const days = Number(rec.days) || 0
  if (days >= 2) parts.push(`来过 ${days} 天`)
  return `${head}（${parts.join('，')}）`
}

/** 全量摘要（给体检/CLI 用）。按最近活动倒序。 */
export function summarizePeopleStats({ workspace, log = () => {} } = {}) {
  const data = readPeopleStatsFile({ workspace, log })
  return Object.values(data.people)
    .map((r) => ({ ...r, line: renderPersonStatsLine(r) }))
    .sort((a, b) => (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0))
}
