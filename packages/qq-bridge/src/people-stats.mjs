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
 * @param {object} opts
 * @param {boolean} [opts.mentioned] 这一条**被叫到**了吗（@ 或命中唤醒词）。
 *   ★ 2026-10-01 新增：用来区分「**只在被叫到时才出现**」与「会主动找机器人说话」——
 *     这是"发言风格"里唯一能确定性算出来、又真的影响回话方式的一条
 *     （对前者别指望他接话，对后者可以）。
 * @param {number} [opts.textLength] 这条消息的字符数。
 *   ★ 只累加**长度**，不存内容（本模块的隐私边界：只记数字）。
 *     用来给"他一般发多长的话"一个量级感 —— 短促 vs 长篇。
 * @returns {{ok: boolean, rec?: object, why?: string}}
 */
export function notePersonTurn({ workspace, userId, chatKey = '', at = Date.now(), mentioned = null, textLength = 0, log = () => {} } = {}) {
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
    // ── 2026-10-01 新增的两个计数（老记录没有这两个字段，读的时候一律按 0 处理）──
    //    ① 被叫到的次数：`mentioned=true` 才加；`null`（未知）**不加也不减**
    //       —— 缺数据时宁可不体现，也不要把"不知道"算成"他没被叫到"。
    if (mentioned === true) cur.mentioned = (Number(cur.mentioned) || 0) + 1
    //    ② 总字符数（**不存内容**）：渲染时除以 messages 得到"他一般发多长"。
    cur.chars = (Number(cur.chars) || 0) + (Number(textLength) || 0)
    //    ③ 峰值时段用来算"作息"：跨天出现的小时数（见 hours）。
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

// ══════════════════════════════════════════════════════════════════════════
// ★★ 行为特征那一行（2026-10-01 用户要求「增加统计层」）
// ══════════════════════════════════════════════════════════════════════════
//
// 上面那行回答"他跟我熟不熟"；这一行回答**"他习惯怎么说话、怎么出现"** ——
// 也就是用户点名要的那一类：稳定行为特征。
//
// ★ 四条硬纪律（少一条就会变成"监视"）：
//   ① **只写算得出来的**：全部来自计数器（小时桶、被叫到次数、字数和、会话计数）。
//      不猜性格、不判情绪、不做语义归类 —— 那属于个人档条目（模型那条路）。
//   ② **每一条都要有次数门槛**：样本不够**一个字都不写**（宁可不提，也不装熟）。
//   ③ **不暴露别人的情况**：会话分布只在"有一处明显集中"时才写，
//      而且**不写群号**（只写"基本只在群里出现"这种量级）——
//      否则这行会变成"他在哪几个群活动"的情报。
//   ④ 失败/字段缺失一律当作"没有这项"，绝不编。

/** "只在被叫到时才出现"的判据：被叫到占绝大多数，且有足够样本。 */
export const MENTIONED_ONLY_RATIO = 0.9
/** 判断"主动出现"至少要有的样本（否则比率不可信）。 */
export const MENTIONED_MIN_SAMPLE = 8
/** "话很短/话不少"的判据（平均字符数）。 */
export const SHORT_MESSAGE_CHARS = 12
export const LONG_MESSAGE_CHARS = 45
/** 会话集中度：某一个会话占到这个比例才提"基本只在 X 出现"。 */
export const DOMINANT_CHAT_RATIO = 0.8
/** "经常出现"的天数门槛（跨天出现才谈得上"习惯"）。 */
export const HABIT_DAYS = 3

/** 会话键 → 人话（**不写群号/QQ 号** —— 这一行不该泄露他在哪活动）。 */
function chatKindLabel(chatKey) {
  const k = String(chatKey ?? '')
  if (k.startsWith('group:')) return '群'
  if (k.startsWith('private:')) return '私聊'
  return ''
}

/**
 * 渲染"稳定行为特征"那一行。**数据不足时返回空串**。
 *
 * 形如：`他的习惯：只在被叫到时出现；话很短（一般 8 个字）；基本只在群聊里出现`
 *
 * @param {object|null} rec `readPersonStats()` 的结果
 * @returns {string} 空串 = 不注入（样本不足或没有可说的）
 */
export function renderPersonHabitsLine(rec) {
  if (!rec) return ''
  const messages = Number(rec.messages) || 0
  if (messages < MIN_MESSAGES_FOR_LINE) return ''

  const traits = []

  // ① 出现方式：只在被叫到时 vs 会主动找机器人说话
  //
  // ★ 这是用户列的"发言风格"里**唯一能确定性算出来**的一条，而且直接影响回话策略：
  //   对"只在被叫到时出现"的人，别指望他接话、也别追问"你怎么不说话"。
  //
  // ⚠️⚠️ 判据必须用**这条数据自己的样本量**（`mentioned` 而不是 `messages`）：
  //   第一版用 `messages >= 8` 当门槛，于是**老记录**（根本没记过 `mentioned`）
  //   算出 0/33 = 0 ⇒ 输出「会主动来找我说话」——**把"没有数据"说成了"有数据"**，
  //   真机数据一渲染就露馅（100000001 的 33 条一条都没记过 mentioned）。
  //   现在两侧各自要有 `MENTIONED_MIN_SAMPLE` 条才敢下结论，否则这一条**一个字都不写**。
  const mentioned = Number(rec.mentioned) || 0
  // ★⚠️ 必须判**原始字段在不在**（`rec.mentioned`），不能用 `Number(...)` 的兜底值 ——
  //   老记录没有这个字段，兜底成 0 之后会被读成"他从来没被叫到过"，
  //   于是输出「会主动来找我说话」：**把"没有数据"说成了"有数据"**（真机一渲染就露馅）。
  const hasMentionedData = rec.mentioned !== undefined && rec.mentioned !== null
  if (hasMentionedData && mentioned >= MENTIONED_MIN_SAMPLE) {
    const ratio = mentioned / messages
    if (ratio >= MENTIONED_ONLY_RATIO) traits.push('基本只在被叫到时才出现')
  } else if (hasMentionedData && messages - mentioned >= MENTIONED_MIN_SAMPLE) {
    // 只有"明确没被叫到"的次数够了才敢说他会主动出现
    if (mentioned / messages <= 1 - MENTIONED_ONLY_RATIO) traits.push('会主动来找我说话')
  }

  // ② 话的长短（**只用量级词**，不报精确统计）
  const chars = Number(rec.chars) || 0
  if (chars > 0 && messages >= MIN_MESSAGES_FOR_LINE) {
    const avg = chars / messages
    if (avg <= SHORT_MESSAGE_CHARS) traits.push(`话很短（一般 ${Math.max(1, Math.round(avg))} 个字）`)
    else if (avg >= LONG_MESSAGE_CHARS) traits.push('说话偏长，一次说挺多')
  }

  // ③ 活动范围（**只在明显集中时写，且不写群号**）
  const chats = rec.chats && typeof rec.chats === 'object' ? rec.chats : null
  if (chats) {
    const entries = Object.entries(chats).filter(([, n]) => Number(n) > 0)
    const total = entries.reduce((s, [, n]) => s + Number(n), 0)
    const label = chatKindLabel(entries.sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0])
    if (label && total > 0 && Number(entries[0][1]) / total >= DOMINANT_CHAT_RATIO) {
      traits.push(`基本只在${label}里出现`)
    }
  }

  // ④ 稳定性：跨天出现才算"习惯"（只来过一两次的不叫习惯）
  const days = Number(rec.days) || 0
  if (days >= HABIT_DAYS) traits.push(`稳定出现了 ${days} 天`)

  if (traits.length === 0) return ''
  return `他的习惯：${traits.join('；')}`
}

/** 全量摘要（给体检/CLI 用）。按最近活动倒序。 */
export function summarizePeopleStats({ workspace, log = () => {} } = {}) {
  const data = readPeopleStatsFile({ workspace, log })
  return Object.values(data.people)
    .map((r) => ({ ...r, line: renderPersonStatsLine(r), habits: renderPersonHabitsLine(r) }))
    .sort((a, b) => (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0))
}
