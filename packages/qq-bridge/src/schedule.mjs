/**
 * 定时任务：**"到点了、主动说一句"**（0.3.2 P1）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════════════════════
 * 在此之前桥接是**纯镜像**：唯一入口是入站事件（`bridge.mjs` 的
 * `onebot.addEventListener('event', …)`），出站只有"回答刚收到的那条消息"。
 * 于是"8 点时叫我一声""提醒某某人吃饭"这类**无人开口**的需求，一处都落不下去。
 *
 * 本模块负责其中的**调度与落盘**那一半，而且刻意只做纯逻辑 + 文件读写：
 * 「唤醒模型、投递回复」在 `schedule-runner.mjs`（它才碰桥接的状态机）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ "恰好一次"是怎么保证的（这份契约最贵的一条，改之前先读完）
 * ══════════════════════════════════════════════════════════════════════════
 * 需求原话是「服务器出问题时小鲸鱼会**且仅会**一次报告」（`docs/0.3.2-task-manager-plan.md` §1）。
 * 定时提醒同理 —— **一条提醒说两遍比漏一遍更糟**（重复回复在本项目里被判定为更严重的失败）。
 *
 * 保证靠**两个各自独立的机制**，缺任何一个都会漏：
 *
 *   ① **确定性的"这一次"键**（`occurrenceKey` = `任务id@scheduledAt`）——
 *      时间是算出来的、不是"当前时刻"，所以同一个逻辑触发点在任何时候都算出**同一个键**。
 *      用 `Date.now()` 当键就会每次 tick 都得到新的键 ⇒ 每分钟重发一遍。
 *   ② **落盘的触发台账**（`runtime/schedule-fires.jsonl`）——
 *      **在真的调模型之前**先写一行 `claimed`。崩在"写完、还没发"之间时，
 *      重启后看到的是 `claimed`（不是"没有过"）⇒ **不会重复催**，
 *      而 runner 会把这条**未完成**的记录捡起来继续做完（同一次触发，不是第二次）。
 *
 * ★ 为什么不复用 `delivery-ledger.mjs`：那份账本的语义是"**绝不自动重放**"
 *   （发没发出去无法区分 ⇒ 重放会产生重复回复）。而这里我们要的恰恰是
 *   "**这一次触发必须有个结果**" ⇒ 两者的结论相反，不能混成一份。
 *   `delivery-ledger` 管"这一条回复有没有发出去"，本模块管"这一次触发有没有被认领"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 错过怎么办：**不补发，但必须留证据**（使用者 2026-10 拍板）
 * ══════════════════════════════════════════════════════════════════════════
 * 桥接重启/机器关机期间到点的任务，分两种情况，判据是**容差窗口**：
 *
 *   · `now - scheduledAt <= lateToleranceMs`（默认 2 分钟）⇒ **正常触发**，但在提示词里
 *     如实写明"已经晚了 N 分钟"，让它**不假装自己很准时**；
 *   · 超过容差 ⇒ **不补发**，写一行**错过台账**（`runtime/schedule-missed.jsonl`），
 *     由桥接在下一次交互时**如实告诉使用者**（"8 点那条我没发出去"）。
 *
 * ★ 为什么必须有那个容差窗口：没有它，8:00:20 重启会让 8:00 那条**永久消失**
 *   （见 `docs/0.3.2-task-manager-plan.md` §13.1）。而"8 点"这种需求，
 *   20 秒的迟到与"根本没响"在体感上完全不同。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三条不能改的性质
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **绝不抛异常**（除了明确的参数错误）：调度是增强路径，坏了不能带走桥接
 *      （与 `tasks.mjs` / `oplog.mjs` / `memory-stats.mjs` 同一条纪律）。
 *   ② **时区必须走 `zonedParts`**（本模块从 `prices.mjs` 借），**不许用 `date.getHours()`** ——
 *      后者给的是"跑进程那台机器的本地时间"，桥接与使用者不在同一时区时就全错，
 *      而且**时区对的人永远测不出来**（`prices.mjs:68-80` 记着这条）。
 *   ③ **删单个文件用 `unlinkSync`，不用 `rmSync`**（`AGENT.md` 第 8 条：实测在 Windows 上
 *      `rmSync(单个文件)` 要么静默失败、要么把进程崩掉）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zonedParts } from './prices.mjs'

/** 任务定义所在目录（工作区相对）。★ 放工作区里 ⇒ 天然属于受保护路径，不会被打进发布包。 */
export const SCHEDULE_DIR = 'runtime/schedule'

/** 触发台账 / 错过台账（工作区相对）。 */
export const FIRES_REL = 'runtime/schedule-fires.jsonl'
export const MISSED_REL = 'runtime/schedule-missed.jsonl'

/** 台账最多保留多少行（超出按最旧丢）。它按"触发次数"增长，但触发本身是低频的。 */
export const LEDGER_MAX_LINES = 2000

/**
 * 默认容差窗口：**2 分钟**。
 *
 * ★ 取值理由（别随手改小）：这个窗口要能吸收"桥接重启一次"的耗时，
 *   而桥接重启是**常见事件**（改配置、点界面上的重启、升级）。
 *   定得太小 ⇒ 8:00:20 起来就判成"错过"，那条提醒永久消失；
 *   定得太大 ⇒ 使用者会收到一条明显迟到的"8 点提醒"而不明所以
 *   —— 所以超过窗口时**不补发**，只如实记一笔。
 */
export const DEFAULT_LATE_TOLERANCE_MS = 2 * 60 * 1000

/**
 * 发布包里**不允许**出现任务定义 —— 它是使用者数据（含他要提醒的内容）。
 * 这条断言在 `mocks/verify-release-hygiene.mjs` 那一侧消费（见本模块的导出 `isScheduleUserData`）。
 */
export function isScheduleUserData(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  return (
    p === SCHEDULE_DIR ||
    p.startsWith(`${SCHEDULE_DIR}/`) ||
    p === FIRES_REL ||
    p === MISSED_REL ||
    p === 'runtime/schedule-history.jsonl' ||
    p === KNOWN_CHATS_REL
  )
}

/**
 * **已知会话来过的名单**（落盘）。
 *
 * ★★ 为什么必须有它，而且必须是**落盘**的：
 *   定时任务的目标要 fail-closed（"不往陌生号码发消息"，§4）—— 判据是
 *   "这个会话来过消息"。而这份知识如果只在内存里，会撞上一个**天天都会发生**的场景：
 *
 *     晚上重启过桥接 → 早上 8 点那条提醒要发到某个群 → 那个群今天还没人说过话
 *     → 判成"陌生号码" → **提醒被拒**。
 *
 *   使用者看到的是"8 点它没响"，而日志里只有一句"会话镜像里没有它"。
 *   ∴ 把"来过消息的会话"记在盘上（按**会话键**，不含任何消息内容）。
 *   ⚠️ 它**只增不减**（上限见 `KNOWN_CHATS_MAX`）：删掉一条会重演上面那个场景，
 *      而这些键本身不含内容、体积可以忽略（每个约 20 字节）。
 */
export const KNOWN_CHATS_REL = 'runtime/schedule-chats.json'

/** 已知会话名单的上限（超出丢最旧的）。 */
export const KNOWN_CHATS_MAX = 500

/** 读已知会话名单（读不出来返回空集合 + 原因，**不静默**）。 */
export function readKnownChats({ workspace, exists = existsSync } = {}) {
  const root = String(workspace ?? '')
  if (!root) return { ok: false, chats: [], why: '缺少 workspace' }
  const file = join(root, KNOWN_CHATS_REL)
  try {
    if (!exists(file)) return { ok: true, chats: [], why: '' }
    const v = readJson(file, null)
    const list = Array.isArray(v?.chats) ? v.chats.map(String).filter(Boolean) : []
    return { ok: true, chats: list, why: '' }
  } catch (error) {
    return { ok: false, chats: [], why: `读不了 ${KNOWN_CHATS_REL}：${error?.message ?? error}` }
  }
}

/**
 * 记一个"来过消息的会话"（幂等；已经记过就不写盘）。
 *
 * ★ 写失败**不抛**（它是增强路径），但调用方应当喊一声 —— 见 `bridge.mjs` 的接线。
 */
export function noteKnownChat({ workspace, chatKey, now = Date.now(), exists = existsSync } = {}) {
  const root = String(workspace ?? '')
  const key = String(chatKey ?? '').trim()
  if (!root || !key) return { ok: false, why: '缺少 workspace 或 chatKey' }
  const cur = readKnownChats({ workspace: root, exists })
  const list = cur.ok ? cur.chats : []
  if (list.includes(key)) return { ok: true, added: false }
  const next = [...list, key]
  const trimmed = next.length > KNOWN_CHATS_MAX ? next.slice(next.length - KNOWN_CHATS_MAX) : next
  try {
    writeJson(join(root, KNOWN_CHATS_REL), { version: 1, updatedAt: now, chats: trimmed })
    return { ok: true, added: true, dropped: next.length - trimmed.length }
  } catch (error) {
    return { ok: false, why: `写不了 ${KNOWN_CHATS_REL}：${error?.message ?? error}` }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 时区：把"某地某天的 08:00"换成那一刻的 UTC 时刻
// ══════════════════════════════════════════════════════════════════════════

/** 两个日期之间的天数差（按 UTC 日历日算，不涉及时区）。 */
function dayShift(ms, days) {
  const d = new Date(ms)
  d.setUTCDate(d.getUTCDate() + days)
  return d.getTime()
}

/** `HH:MM` → 当天的分钟数；认不出返回 null（**不猜**）。 */
export function parseHm(text) {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(String(text ?? ''))
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * 时区内"年月日 + 分钟数"→ UTC 时刻。
 *
 * 做法：先把它当成 UTC 猜一个时刻，再用该时刻在目标时区的真实墙上时间反解偏移，
 * 修正一次（跨夏令时边界时最多再修一次）。**跨夏令时的那一小时有歧义，
 * 这里给出的是"其中一种合理结果"，不假装能分辨**（中国无夏令时，实际用不到）。
 */
export function instantFromZoned(ymd, minuteOfDay, timeZone) {
  const [y, mo, d] = String(ymd).split('-').map(Number)
  const guessUtc = Date.UTC(y, (mo ?? 1) - 1, d ?? 1, 0, 0, 0) + minuteOfDay * 60_000
  let instant = guessUtc
  for (let i = 0; i < 3; i += 1) {
    const wall = zonedParts(new Date(instant), timeZone)
    const [wy, wmo, wd] = wall.ymd.split('-').map(Number)
    const [wh, wmin] = wall.hm.split(':').map(Number)
    const wallAsUtc = Date.UTC(wy, wmo - 1, wd, wh, wmin, 0)
    const offset = wallAsUtc - instant // 目标时区相对 UTC 的偏移（毫秒）
    const next = guessUtc - offset
    if (next === instant) break
    instant = next
  }
  return instant
}

// ══════════════════════════════════════════════════════════════════════════
// 任务定义：形状与校验
// ══════════════════════════════════════════════════════════════════════════

/** 任务 id 只允许这些字符（它同时是文件名，必须挡住路径穿越）。 */
export function safeTaskId(id) {
  return String(id ?? '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40)
}

/** 任务定义文件（工作区相对路径）。 */
export function taskRel(id) {
  return `${SCHEDULE_DIR}/${safeTaskId(id)}.json`
}

/**
 * 一个任务该长什么样。`normalizeTask` 是**唯一**读任务定义的地方，
 * 所以老版本写下的文件（缺字段）与手写的文件都从这里收口。
 *
 * @typedef {object} ScheduleTask
 * @property {string} id
 * @property {string} title          人话名字（日志/界面/错过台账都用它）
 * @property {boolean} enabled
 * @property {{kind:'daily',at:string,weekdays?:number[]}|{kind:'interval',everyMs:number}|{kind:'once',atIso:string}} repeat
 * @property {{kind:'group'|'private',peerId:string}} target  ★ 消息发给谁（会话键由 kind+peerId 组成）
 * @property {string} prompt         交给模型的任务描述（**它自己决定那句话怎么说**）
 * @property {string} requestedBy    谁要求的（写进提示词，让它知道这句话是为谁说的）
 * @property {boolean} ignoreQuietHours
 * @property {number|null} lastFiredAt
 * @property {number|null} lastScheduledAt
 * @property {number} createdAt      **写文件那一刻**（人话：这任务什么时候建的）
 * @property {number} effectiveFrom  ★ **从哪一刻起算它的账**（见 `normalizeTask` 里那段）
 */

const WEEKDAY_SET = new Set([0, 1, 2, 3, 4, 5, 6])

/**
 * 把一个来路不明的对象收敛成合法任务。**不做"猜"**：认不出的字段用默认值，
 * 认不出的 `repeat` **判为无效**（`ok:false`）—— 静默改成"每天 0 点"是最坏的结果。
 *
 * @returns {{ok: boolean, task?: ScheduleTask, why?: string}}
 */
export function normalizeTask(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return { ok: false, why: '不是对象' }
  const id = safeTaskId(raw.id)
  if (!id) return { ok: false, why: '缺少 id' }
  const title = String(raw.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  if (!title) return { ok: false, why: '缺少 title' }
  const prompt = String(raw.prompt ?? '').trim()
  if (!prompt) return { ok: false, why: '缺少 prompt（到点了要它做什么）' }

  const target = raw.target && typeof raw.target === 'object' ? raw.target : null
  const kind = target?.kind === 'private' ? 'private' : target?.kind === 'group' ? 'group' : null
  const peerId = String(target?.peerId ?? '').trim()
  if (!kind || !peerId) return { ok: false, why: 'target 必须是 {kind: group|private, peerId: "号码"}' }

  const repeat = normalizeRepeat(raw.repeat)
  if (!repeat.ok) return { ok: false, why: repeat.why }

  const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : now
  const timezone = String(raw.timezone ?? '').trim() || 'Asia/Shanghai'

  // ★★ `effectiveFrom`：**从哪一刻起算它的账** = 「创建之后的**第一个**触发点」。
  //
  //   为什么不能直接用 `createdAt`（= 写文件那一刻），以及为什么不是"最近一个已过去的点"：
  //     · 直接用 `createdAt`（取"创建之后"）：昨天建的「每天 8:00」会在今早开机时
  //       去追**昨天 8:00** 那一笔、记成"错过"（实测抓到的缺陷，`verify-schedule` ⑦）；
  //     · 用"最近一个**已过去**的点"：7:59:59 建的任务，那一刻 8:00 还没到 ⇒
  //       探不到 ⇒ 下界退回创建时刻 ⇒ 同一条缺陷换个方向又出现
  //       （`verify-schedule` ③ 的 `effectiveFrom` 断言抓到的）。
  //   ∴ 定义成"**创建之后的第一个触发点**"：7:59 建 ⇒ 8:00 那次照常算账；
  //     昨天建 ⇒ 第一个点是今天 8:00（昨天那笔从来就不是它的账）。
  const effectiveFrom = Math.max(createdAt, firstInstantAtOrAfter(repeat.repeat, createdAt, timezone))

  // ── 触发方式（0.3.2 P2 扩展）：`at` = 时钟到点 · `server` = 某台服务器出状况 ──
  //
  // ★ 为什么放在同一套任务定义里而不是另造一份：两者的**其余部分完全一样**
  //   （目标会话、内容交代、留痕、投递管线、恰好一次的台账）。分成两套只会
  //   让"留痕/去重"这些最容易出错的逻辑各写一遍。
  // ★ 认不出的 trigger **判为无效**（`ok:false`）—— 静默当成"时钟任务"会让
  //   一条本该盯着服务器的规则变成"每天某时刻"，而那是完全不同的行为。
  const trigger = normalizeTrigger(raw.trigger)
  if (!trigger.ok) return { ok: false, why: trigger.why }

  return {
    ok: true,
    task: {
      id,
      title,
      enabled: raw.enabled !== false,
      repeat: repeat.repeat,
      // ★ 事件型任务多带一个"自动播报档位"（默认全 manual —— 见 `normalizeAnnounce` 的理由）。
      //   时钟型不带它：那条路径没有"要不要自动喊"这个问题（到点了就该说）。
      trigger:
        trigger.trigger.kind === 'server'
          ? {
              ...trigger.trigger,
              // ★★ **两个来源都要认**（这是个真缺陷，被接线测试抓到的）：
              //   写盘时档位在 `trigger.announce` 里，而调用方也可能把它放在
              //   顶层 `announce`（写任务那一步更方便）。只认顶层 ⇒
              //   **从盘上读回来时档位会悄悄退回 manual**，表现是"我设了自动播报，
              //   它重启之后就再也不喊了"（而且没有任何报错）。
              announce: normalizeAnnounce(raw.announce ?? raw.trigger?.announce),
            }
          : trigger.trigger,
      target: { kind, peerId },
      prompt,
      requestedBy: String(raw.requestedBy ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
      // ★ 默认 **true**：定时提醒的语义就是"到点就说"，
      //   若默认 false，凌晨的任务会被静默时段推到早上（见 §11 的"静默时段"一条）。
      //   ⚠️ 它是**显式例外**，日志与界面上都要如实标注（不许悄悄绕过闸门）。
      ignoreQuietHours: raw.ignoreQuietHours !== false,
      lateToleranceMs: Number.isFinite(Number(raw.lateToleranceMs))
        ? Math.max(0, Number(raw.lateToleranceMs))
        : DEFAULT_LATE_TOLERANCE_MS,
      timezone,
      lastFiredAt: Number.isFinite(Number(raw.lastFiredAt)) ? Number(raw.lastFiredAt) : null,
      lastScheduledAt: Number.isFinite(Number(raw.lastScheduledAt)) ? Number(raw.lastScheduledAt) : null,
      createdAt,
      effectiveFrom,
    },
  }
}

/**
 * 「在 `from` 这一刻**或之后**的第一个触发点」——只用于把"算账起点"推到合理的位置。
 *
 * 找不到（例如 `once` 的时间已经过去）返回 `-Infinity`（下界退回创建时刻）。
 *
 * ★ 它**不看认领台账** —— 这里回答的是"这个任务的第一个有意义的触发点是哪个"，
 *   与"认领过没有"是两件事（后者由 `dueAt` 判）。
 */
export function firstInstantAtOrAfter(repeat, from, timezone = 'Asia/Shanghai') {
  const t0 = Number(from)
  try {
    if (repeat?.kind === 'once') {
      const t = Date.parse(repeat.at)
      return Number.isFinite(t) && t >= t0 ? t : -Infinity
    }
    if (repeat?.kind === 'interval') {
      const every = repeat.everyMs
      if (!(every > 0)) return -Infinity
      // 锚点就是 `from` 本身（interval 的语义：从算账起点开始每 everyMs 一次）
      return Number.isFinite(t0) ? t0 : -Infinity
    }
    if (repeat?.kind === 'daily') {
      const minute = parseHm(repeat.at)
      if (minute === null) return -Infinity
      const weekdays = Array.isArray(repeat.weekdays) ? repeat.weekdays : null
      // 往前最多探 60 天（weekdays 过滤的最坏情况是一周一次 ⇒ 7 天足够；
      // 留 60 天是给"手写了一个永远匹配不上的 weekdays"留一个终止保证）
      let cursor = t0
      for (let i = 0; i <= 60; i += 1) {
        const wall = zonedParts(new Date(cursor), timezone)
        if (!weekdays || weekdays.includes(wall.weekday)) {
          const t = instantFromZoned(wall.ymd, minute, timezone)
          // 一秒宽容：`from` 是毫秒级的"写文件那一刻"，而触发点是整分钟
          if (Number.isFinite(t) && t + 1000 >= t0) return t
        }
        cursor = instantFromZoned(wall.ymd, 12 * 60, timezone) + 24 * 60 * 60 * 1000
      }
      return -Infinity
    }
  } catch {
    return -Infinity
  }
  return -Infinity
}

/** 触发方式允许的类型（与 `src/servers/watch.mjs` 的事件类型一致）。 */
export const TRIGGER_EVENTS = ['down', 'up', 'anomaly']

/**
 * 触发方式收敛。
 *
 *   `at`（默认）           = 时钟到点（今天之前的所有任务都是这一类，**行为一字不变**）
 *   `server`               = 某台服务器出状况（由 `src/servers/watch.mjs` 产事件）
 *     `{kind:'server', serverId, events:['down','up','anomaly']}`
 *
 * ★ 为什么"缺省 = at"是安全的：老任务定义里**没有** `trigger` 字段，
 *   它们的行为必须与 0.3.2 之前逐字相同 —— 这是本次扩展的硬要求。
 * ★ 认不出的 kind / 空 events / 缺 serverId **一律 ok:false**、不猜。
 */
export function normalizeTrigger(raw) {
  if (raw === undefined || raw === null) return { ok: true, trigger: { kind: 'at' } }
  if (typeof raw !== 'object') return { ok: false, why: `trigger 必须是对象：${JSON.stringify(raw)}` }
  const kind = String(raw.kind ?? 'at').trim()
  if (kind === 'at') return { ok: true, trigger: { kind: 'at' } }
  if (kind !== 'server') return { ok: false, why: `认不出的 trigger.kind：${JSON.stringify(kind)}（只支持 at / server）` }

  const serverId = String(raw.serverId ?? '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40)
  if (!serverId) return { ok: false, why: 'trigger.kind=server 时必须给 serverId' }
  const events = Array.isArray(raw.events)
    ? [...new Set(raw.events.map((e) => String(e).trim()).filter((e) => TRIGGER_EVENTS.includes(e)))]
    : []
  if (events.length === 0) {
    return { ok: false, why: `trigger.events 必须是 ${TRIGGER_EVENTS.join(' / ')} 的非空子集（收到 ${JSON.stringify(raw.events)}）` }
  }
  const cooldownMs = Number.isFinite(Number(raw.cooldownMs)) ? Math.max(0, Number(raw.cooldownMs)) : 5 * 60 * 1000
  return { ok: true, trigger: { kind: 'server', serverId, events, cooldownMs } }
}

/** 自动播报的档位：`none`（连问都不答）/ `manual`（只在被问到时说）/ `auto`（出事自己喊）。 */
export const ANNOUNCE_MODES = ['none', 'manual', 'auto']

/**
 * 事件型任务的**自动播报范围**收敛。
 *
 * ★★ 为什么默认全 `manual`（这条是刻意的，不是漏做）：
 *   一台服务器 `down` 就**自动播报**到群里，等于把"服务端的一部分事实"交给了
 *   **任何能让它掉线的人**（重启一下、打崩它，群里就会响）。`anomaly` 更是噪音源。
 *   ∴ **问**（有人在群里问"服务器怎么样了"）与**自动喊**分开：默认只支持问，
 *   要自动喊**由使用者显式打开**。
 * ★ 它是**数据**（存在任务定义里），不是代码里的开关 —— 所以界面上改它不用重启。
 */
export function normalizeAnnounce(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const one = (v, dflt) => (ANNOUNCE_MODES.includes(String(v)) ? String(v) : dflt)
  return {
    down: one(r.down, 'manual'),
    up: one(r.up, 'manual'),
    anomaly: one(r.anomaly, 'manual'),
  }
}

/** 一条任务是不是"时钟型"（看 `trigger.kind`，缺省即时钟型）。 */
export function isClockTask(task) {
  return (task?.trigger?.kind ?? 'at') === 'at'
}

/** 重复规则收敛。**认不出一律 ok:false**（不许静默变成"每天 0 点"）。 */
export function normalizeRepeat(raw) {
  const r = raw && typeof raw === 'object' ? raw : null
  const kind = String(r?.kind ?? '').trim()
  if (kind === 'daily') {
    const minute = parseHm(r.at)
    if (minute === null) return { ok: false, why: `daily 的 at 认不出（要 HH:MM）：${JSON.stringify(r.at)}` }
    let weekdays = null
    if (Array.isArray(r.weekdays) && r.weekdays.length > 0) {
      const list = [...new Set(r.weekdays.map(Number).filter((n) => WEEKDAY_SET.has(n)))].sort()
      if (list.length === 0) return { ok: false, why: 'weekdays 里没有一个合法值（0=周日 … 6=周六）' }
      weekdays = list
    }
    return { ok: true, repeat: { kind: 'daily', at: hmText(minute), weekdays } }
  }
  if (kind === 'interval') {
    const everyMs = Number(r.everyMs)
    if (!Number.isFinite(everyMs) || everyMs < 60_000) {
      return { ok: false, why: `interval 的 everyMs 必须是 >= 60000 的毫秒数：${JSON.stringify(r.everyMs)}` }
    }
    return { ok: true, repeat: { kind: 'interval', everyMs: Math.floor(everyMs) } }
  }
  if (kind === 'once') {
    const atMs = Date.parse(String(r.at ?? ''))
    if (!Number.isFinite(atMs)) return { ok: false, why: `once 的 at 必须是可解析的时间：${JSON.stringify(r.at)}` }
    return { ok: true, repeat: { kind: 'once', at: new Date(atMs).toISOString() } }
  }
  return { ok: false, why: `认不出的 repeat.kind：${JSON.stringify(kind)}（只支持 daily / interval / once）` }
}

/** 分钟数 → `HH:MM`。 */
export function hmText(minuteOfDay) {
  const n = Math.max(0, Math.min(23 * 60 + 59, Math.floor(minuteOfDay)))
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}

// ══════════════════════════════════════════════════════════════════════════
// 核心：下一次（或最近一次）该触发的时刻
// ══════════════════════════════════════════════════════════════════════════

/**
 * 算出"最近一个已经到点、但**还没被认领**"的触发点。
 *
 * 语义（这是本模块最要紧的一处，改动前请先读文件头）：
 *   · 返回的 `scheduledAt` 是**算出来的**（不依赖"上次跑到哪"），
 *     所以同一个逻辑触发点重复调用得到**同一个值** ⇒ 它就是去重键的一半；
 *   · 已经认领过的（`claimed` / `delivered`）**跳过**，继续往前找；
 *   · ★★ **任务被创建之前的触发点不算它的账**（`createdAt` 是硬下界）——
 *     见下面那段注释，这条是实测抓出来的缺陷；
 *   · 没有到点的 ⇒ `null`（绝大多数 tick 都是这个结果）。
 *
 * @param {ScheduleTask} task
 * @param {object} opts
 * @param {number} opts.now                 当前时刻（毫秒）
 * @param {(key: string) => boolean} opts.isClaimed 这个 occurrenceKey 认领过吗
 * @param {number} [opts.lookbackMs]        最多往前找多久（防止一条坏任务把循环拖死）
 * @returns {{scheduledAt: number, occurrenceKey: string, lateByMs: number}|null}
 */
export function dueAt(task, { now, isClaimed = () => false, lookbackMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const at = Number(now)
  if (!Number.isFinite(at)) return null
  if (task?.enabled === false) return null

  // ★★ 下界 = max(往前找的窗口, **这个任务从哪一刻起算它的账**)。
  //
  //   为什么必须有后一半（实测抓到的缺陷）：一条**今天才建**的
  //   「每天 8:00」任务，在"认领集合为空"时会一路往前算出**昨天 8:00 也欠着** ⇒
  //   重启后把一个它从来不负责的旧时点记成"错过"（`verify-schedule` ⑦ 抓到的
  //   "错过记了两遍"就是这个根因）。
  //   ⚠️ 用的是 `effectiveFrom` 而**不是** `createdAt` —— 两者的区别见 `normalizeTask`
  //      里那段：直接用 createdAt 会让"8:00 之前建的当天任务"当天永不触发。
  const from = Number(task?.effectiveFrom)
  const floor = Math.max(
    at - Math.max(60_000, Number(lookbackMs) || 0),
    Number.isFinite(from) && from > 0 ? from : -Infinity,
  )
  const seen = new Set()

  for (const scheduledAt of candidateInstants(task, at, floor)) {
    if (!Number.isFinite(scheduledAt)) continue
    if (scheduledAt > at) continue
    if (scheduledAt < floor) break
    if (seen.has(scheduledAt)) continue
    seen.add(scheduledAt)
    const key = occurrenceKey(task.id, scheduledAt)
    if (isClaimed(key)) continue
    return { scheduledAt, occurrenceKey: key, lateByMs: at - scheduledAt }
  }
  return null
}

/**
 * 生成候选触发时刻（**由近到远**）。
 *
 * ★ 为什么是生成器而不是"算一个"：认领过的点要能**继续往前找**
 *   （重启后连着错过两次时，得能一条条判"这条认领过没有"）。
 */
export function* candidateInstants(task, now, floor) {
  const repeat = task?.repeat
  if (!repeat) return
  if (repeat.kind === 'interval') {
    const every = repeat.everyMs
    // ★ 锚点用 `effectiveFrom`（= 最近一个已到点的触发点），不是"创建时刻"：
    //   否则"创建于 8:00:20、每 30 分钟"的第一次会是 8:30（对的），
    //   但"昨天建的、每 30 分钟"会去追昨天那一堆（错的）。
    const anchor = Number(task.effectiveFrom) || Number(task.createdAt) || now
    if (every <= 0) return
    // 最近一个 <= now 的锚点倍数
    let n = Math.floor((now - anchor) / every)
    let count = 0
    while (count < 2000) {
      const t = anchor + n * every
      if (!Number.isFinite(t)) return
      if (t <= now && t >= floor) yield t
      if (t < floor) return
      n -= 1
      count += 1
      if (n < -100000) return
    }
    return
  }
  if (repeat.kind === 'once') {
    const t = Date.parse(repeat.at)
    if (Number.isFinite(t)) yield t
    return
  }
  if (repeat.kind === 'daily') {
    const minute = parseHm(repeat.at)
    if (minute === null) return
    const tz = task.timezone || 'Asia/Shanghai'
    const weekdays = Array.isArray(repeat.weekdays) ? repeat.weekdays : null
    // 从"今天"往前最多 366 天（一次覆盖一整年，够用了）
    let cursor = now
    for (let i = 0; i <= 366; i += 1) {
      const wall = zonedParts(new Date(cursor), tz)
      if (!weekdays || weekdays.includes(wall.weekday)) {
        const t = instantFromZoned(wall.ymd, minute, tz)
        if (Number.isFinite(t)) {
          if (t <= now) yield t
          // 往"昨天"退一天（按墙上时间退，避免夏令时把日期跳错）
          const prevWallInstant = instantFromZoned(wall.ymd, 12 * 60, tz) - 24 * 60 * 60 * 1000
          cursor = prevWallInstant
          if (t < floor) return
          continue
        }
      }
      const prevWallInstant = instantFromZoned(wall.ymd, 12 * 60, tz) - 24 * 60 * 60 * 1000
      cursor = prevWallInstant
      if (cursor < floor - 24 * 60 * 60 * 1000) return
    }
  }
}

/** 触发点的去重键。★ 时间来自**算出来的那次触发点**，不是"当前时刻"。 */
export function occurrenceKey(taskId, scheduledAt) {
  return `${safeTaskId(taskId)}@${Math.floor(Number(scheduledAt))}`
}

/**
 * 给下一次触发用的"还要等多久"（只用于日志/巡检，不参与判定）。
 *
 * ★★ 语义（这条是实现时踩过的坑，别改回去）：**先看"有没有已经到点、还没认领的"**，
 *   有 ⇒ 返回 `0`（意思是"现在就该发"），没有才往前找下一个未来的点。
 *
 *   第一版只往**未来**找，于是"今天 8:00 已到点但还没认领"被跳过、直接报成明天的 8:00
 *   —— 巡检里会显示"还要等 24 小时"，**而它其实立刻就欠着一次**。
 *   这种数字看起来完全合理，所以只能靠断言钉住（`verify-schedule` ③）。
 *
 * @returns {number|null} 毫秒；算不出返回 null（**不编**）
 */
export function msUntilNext(task, { now = Date.now(), isClaimed = () => false } = {}) {
  if (task?.enabled === false) return null
  const repeat = task?.repeat
  if (!repeat) return null

  // ① 先问"现在是不是就欠着一次"（未认领的、已经到点的触发点 ⇒ 0）
  try {
    const pending = dueAt(task, { now, isClaimed })
    if (pending) return 0
  } catch {
    /* 算不出就走下面那条路（不编） */
  }

  // ② 再往前找下一个未来的点
  //
  // ★ 这里**不能**写成"今天那次已经认领过 ⇒ 就没有下一次了"：
  //   `once` 已经到点时，只要它还没被认领，`dueAt` 上面就返回 0 了；
  //   走到这里说明它被认领过 ⇒ 对 `once` 确实没有下一次（返回 null 是对的）。
  //   但 `interval` / `daily` 必须继续往前找（下面各自处理）。
  if (repeat.kind === 'once') {
    const t = Date.parse(repeat.at)
    if (!Number.isFinite(t)) return null
    if (t <= now) return null
    return isClaimed(occurrenceKey(task.id, t)) ? null : t - now
  }
  if (repeat.kind === 'interval') {
    const every = repeat.everyMs
    const anchor = Number(task.effectiveFrom) || Number(task.createdAt) || now
    if (!(every > 0)) return null
    // ① 往后扫一遍"已到点的历史点"（与 `dueAt` 同一个口径：只要有一个没被认领 ⇒ 欠着一次）
    let n = Math.floor((now - anchor) / every)
    const oldest = Math.max(0, n - 2000)
    for (let i = n; i >= oldest; i -= 1) {
      const t = anchor + i * every
      if (t > now) continue
      if (!isClaimed(occurrenceKey(task.id, t))) return 0
    }
    // ② 全认领过 ⇒ 找下一个未来的点（同样**不带 isClaimed**，理由见 daily 那一支的注释）
    for (let i = n + 1; i < n + 2001; i += 1) {
      const t = anchor + i * every
      if (t > now) return t - now
    }
    return null
  }
  if (repeat.kind === 'daily') {
    const minute = parseHm(repeat.at)
    if (minute === null) return null
    const tz = task.timezone || 'Asia/Shanghai'
    const weekdays = Array.isArray(repeat.weekdays) ? repeat.weekdays : null
    // ★ 与 `dueAt` 同一条下界：这个任务**从哪一刻起算它的账**
    const from = Number(task.effectiveFrom)
    const createdFloor = Number.isFinite(from) && from > 0 ? from : -Infinity
    // ① 任何**已到点却还没被认领**的历史点（最多往前 7 天）⇒ 0
    //    ⚠️ 不能只看"最近一个"：最近那个可能是今天（还没到点），而昨天那次还欠着。
    //    ⚠️ 也不能把"往前推"写成 `instantFromZoned(今天, 12:00) - 1 天` ——
    //       那是"昨天 12 点"，而**今天**那一格永远扫不到（实测踩到的坑：
    //       于是它算出了明天的 8:00，白白多等 24 小时）。
    {
      const limit = Math.max(createdFloor, now - 7 * 86_400_000)
      let cursor = now
      for (let i = 0; i <= 7; i += 1) {
        const wall = zonedParts(new Date(cursor), tz)
        if (!weekdays || weekdays.includes(wall.weekday)) {
          const t = instantFromZoned(wall.ymd, minute, tz)
          if (Number.isFinite(t) && t <= now && t >= limit && !isClaimed(occurrenceKey(task.id, t))) return 0
        }
        cursor = instantFromZoned(wall.ymd, 12 * 60, tz) - 24 * 60 * 60 * 1000
        if (cursor < limit - 86_400_000) break
      }
    }
    // ② 历史都认领过 ⇒ 找下一个未来的点
    //    ⚠️ 这里**绝不带 `isClaimed` 条件**：认领只对"已经到点的"有意义，
    //       未来的点本来就没被认领。带上它会出现一个荒唐结果 ——
    //       某条实现只要给未来点也回 true，扫描就会一路跑到 370 天外返回 null
    //       （实测踩到：7:59 时它报"没有下一次"）。见 `verify-schedule` ③。
    let cursor = now
    for (let i = 0; i <= 370; i += 1) {
      const wall = zonedParts(new Date(cursor), tz)
      if (!weekdays || weekdays.includes(wall.weekday)) {
        const t = instantFromZoned(wall.ymd, minute, tz)
        if (Number.isFinite(t) && t > now) return t - now
      }
      cursor = instantFromZoned(wall.ymd, 12 * 60, tz) + 24 * 60 * 60 * 1000
    }
    return null
  }
  return null
}

// ══════════════════════════════════════════════════════════════════════════
// 落盘：任务定义 / 触发台账 / 错过台账
// ══════════════════════════════════════════════════════════════════════════

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

/** 原子写（tmp + rename）。与 `tasks.mjs` / `recipes.mjs` 同一套做法。 */
function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 列任务 id（按文件名）。读不出目录返回空数组 + 原因（**不静默**）。 */
export function listTaskIds({ workspace, readdir = readdirSync, exists = existsSync } = {}) {
  const root = String(workspace ?? '')
  if (!root) return { ok: false, ids: [], why: '缺少 workspace' }
  const dir = join(root, SCHEDULE_DIR)
  try {
    if (!exists(dir)) return { ok: true, ids: [], why: '' }
    const ids = readdir(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name.slice(0, -5))
      .sort()
    return { ok: true, ids, why: '' }
  } catch (error) {
    return { ok: false, ids: [], why: `列不了任务目录：${error?.message ?? error}` }
  }
}

/** 读一条任务（不存在返回 null）。 */
export function readTask({ workspace, id } = {}) {
  const root = String(workspace ?? '')
  if (!root || !id) return null
  const raw = readJson(join(root, taskRel(id)), null)
  if (!raw) return null
  const n = normalizeTask(raw)
  return n.ok ? n.task : null
}

/**
 * 读全部任务。**坏掉的任务单独报出来**（`problems`），不拖垮其它任务
 * —— 一条手写坏的任务不该让整个调度器停摆，但它必须被看见。
 *
 * @returns {{ok: boolean, tasks: ScheduleTask[], problems: {id: string, why: string}[], why: string}}
 */
export function listTasks({ workspace } = {}) {
  const root = String(workspace ?? '')
  const listed = listTaskIds({ workspace: root })
  if (!listed.ok) return { ok: false, tasks: [], problems: [], why: listed.why }
  const tasks = []
  const problems = []
  for (const id of listed.ids) {
    const raw = readJson(join(root, taskRel(id)), null)
    if (!raw) {
      problems.push({ id, why: '文件读不出来（不是合法 JSON）' })
      continue
    }
    const n = normalizeTask(raw)
    if (!n.ok) {
      problems.push({ id, why: n.why })
      continue
    }
    tasks.push(n.task)
  }
  return { ok: true, tasks, problems, why: '' }
}

/** 写一条任务（校验不过就拒绝，**不写半个**）。 */
export function writeTask({ workspace, task, now = Date.now() } = {}) {
  const root = String(workspace ?? '')
  if (!root) return { ok: false, why: '缺少 workspace' }
  // ★ 回写已有任务时，`createdAt` / `effectiveFrom` / `lastFiredAt` **必须原样保留**：
  //   它们是"这任务从哪一刻起算账"与"上次发到哪"的事实。重算出 `effectiveFrom`
  //   会把历史整个挪到今天（interval 的锚点、以及"昨天那笔不算账"的判据全靠它）。
  const prev = readTask({ workspace: root, id: safeTaskId(task?.id) })
  const merged = prev
    ? { ...task, createdAt: prev.createdAt, effectiveFrom: prev.effectiveFrom, lastFiredAt: prev.lastFiredAt, lastScheduledAt: prev.lastScheduledAt }
    : task
  const n = normalizeTask(merged, { now })
  if (!n.ok) return { ok: false, why: n.why }
  if (prev) {
    n.task.createdAt = prev.createdAt
    n.task.effectiveFrom = prev.effectiveFrom
    n.task.lastFiredAt = prev.lastFiredAt ?? n.task.lastFiredAt
    n.task.lastScheduledAt = prev.lastScheduledAt ?? n.task.lastScheduledAt
  }
  try {
    writeJson(join(root, taskRel(n.task.id)), n.task)
    return { ok: true, task: n.task }
  } catch (error) {
    return { ok: false, why: `写不进去：${error?.message ?? error}` }
  }
}

/**
 * 删除一条任务（**管理手段**）。
 * ★ 用 `unlinkSync` 而不是 `rmSync` —— 理由见文件头第 ③ 条。
 */
export function deleteTask({ workspace, id } = {}) {
  const root = String(workspace ?? '')
  if (!root || !id) return { ok: false, why: '缺少 workspace 或 id' }
  const file = join(root, taskRel(id))
  if (!existsSync(file)) return { ok: false, why: '任务不存在' }
  try {
    unlinkSync(file)
    return { ok: true }
  } catch (error) {
    return { ok: false, why: `删不掉：${error?.message ?? error}` }
  }
}

// ── JSONL 台账（触发 / 错过 / 历史）──────────────────────────────────────

/** 读一个 JSONL 台账（坏行跳过并计数 —— 一行坏掉不该让整份读不出来）。 */
export function readLedger(rel, { workspace, limit = 0 } = {}) {
  const root = String(workspace ?? '')
  if (!root) return { ok: false, rows: [], bad: 0, why: '缺少 workspace' }
  const file = join(root, rel)
  try {
    if (!existsSync(file)) return { ok: true, rows: [], bad: 0, why: '' }
    const text = readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    const rows = []
    let bad = 0
    for (const line of lines) {
      try {
        const v = JSON.parse(line)
        if (v && typeof v === 'object') rows.push(v)
        else bad += 1
      } catch {
        bad += 1
      }
    }
    const sliced = limit > 0 ? rows.slice(-limit) : rows
    return { ok: true, rows: sliced, bad, why: '' }
  } catch (error) {
    return { ok: false, rows: [], bad: 0, why: `读不了 ${rel}：${error?.message ?? error}` }
  }
}

/** 追加一行（**失败不抛**，返回结果让调用方决定要不要喊）。 */
export function appendLedger(rel, row, { workspace } = {}) {
  const root = String(workspace ?? '')
  if (!root) return { ok: false, why: '缺少 workspace' }
  const file = join(root, rel)
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, `${JSON.stringify(row)}\n`, { flag: 'a', encoding: 'utf8' })
    return { ok: true }
  } catch (error) {
    return { ok: false, why: `写不了 ${rel}：${error?.message ?? error}` }
  }
}

/**
 * 触发台账：读成 `Map<occurrenceKey, row>`（同一键**后者胜**，
 * 因为一行 `claimed` 后面会跟一行 `delivered`）。
 */
export function readFireIndex({ workspace } = {}) {
  const r = readLedger(FIRES_REL, { workspace })
  const map = new Map()
  for (const row of r.rows) {
    const key = String(row?.key ?? '')
    if (key) map.set(key, row)
  }
  return { map, ok: r.ok, bad: r.bad, why: r.why }
}

/**
 * 认领一次触发。**必须在真的调模型之前调用**（见文件头第 ② 条）。
 *
 * @returns {{ok: boolean, key: string, why?: string}}
 */
export function claimFire({ workspace, task, scheduledAt, now = Date.now(), lateByMs = 0 } = {}) {
  const key = occurrenceKey(task?.id, scheduledAt)
  const row = {
    at: now,
    key,
    taskId: safeTaskId(task?.id),
    title: String(task?.title ?? '').slice(0, 60),
    scheduledAt: Math.floor(Number(scheduledAt)),
    status: 'claimed',
    lateByMs: Math.max(0, Math.floor(Number(lateByMs) || 0)),
  }
  const r = appendLedger(FIRES_REL, row, { workspace })
  return { ok: r.ok, key, why: r.why, row }
}

/**
 * **事件级**认领（0.3.2 P2）：服务器事件那条路径的去重键是**事件台账的行号**
 * —— 事件已经由状态机保证"跃迁才产出、持续 down 不重复"，所以这里再做一层
 * "这一行有没有被处理过"就够了。
 *
 * ★ 为什么键用行号（`序号@事件身份`）：行号是**只增不减**的，而"事件身份"
 *   （服务器+类型+时刻）在同一次运行里天然唯一。两者合起来既能去重，
 *   又能在**台账被裁掉**之后自然失效（不会把一条老事件永远挡住）。
 * ★ 与 `claimFire` 的分工：那个的键是**算出来的触发点**（时钟路径），
 *   这个的键由调用方给（事件路径）。两者写进**同一份台账**，于是
 *   "哪一次到底发出去没有"只有一处可查。
 */
export function claimEventFire({ workspace, key, task, detail = '', now = Date.now() } = {}) {
  const k = String(key ?? '').trim()
  if (!k) return { ok: false, key: '', why: '缺少 key（事件级去重键）' }
  const row = {
    at: now,
    key: k,
    kind: 'event',
    taskId: safeTaskId(task?.id),
    title: String(task?.title ?? '').slice(0, 60),
    scheduledAt: now,
    status: 'claimed',
    detail: String(detail).slice(0, 200),
  }
  const r = appendLedger(FIRES_REL, row, { workspace })
  return { ok: r.ok, key: k, why: r.why, row }
}

/** 给一次触发补上结果（`delivered` / `failed` / `empty`）。 */export function settleFire({ workspace, key, status, detail = '', now = Date.now(), chars = 0 } = {}) {
  const row = {
    at: now,
    key: String(key ?? ''),
    status: String(status ?? 'unknown'),
    chars: Math.max(0, Math.floor(Number(chars) || 0)),
  }
  if (detail) row.detail = String(detail).slice(0, 200)
  const r = appendLedger(FIRES_REL, row, { workspace })
  return { ok: r.ok, why: r.why }
}

/** 记一次"错过"（**不补发，但必须留证据**）。 */
export function noteMissed({ workspace, task, scheduledAt, now = Date.now(), lateByMs = 0, reason = 'late' } = {}) {
  const row = {
    at: now,
    key: occurrenceKey(task?.id, scheduledAt),
    taskId: safeTaskId(task?.id),
    title: String(task?.title ?? '').slice(0, 60),
    scheduledAt: Math.floor(Number(scheduledAt)),
    lateByMs: Math.max(0, Math.floor(Number(lateByMs) || 0)),
    reason: String(reason).slice(0, 40),
  }
  const r = appendLedger(MISSED_REL, row, { workspace })
  return { ok: r.ok, why: r.why }
}

/** 记一次"实际发出去的原文"（模型现写 ⇒ 这是唯一能事后核对的东西）。 */
export function noteHistory({ workspace, task, scheduledAt, text, now = Date.now(), via = 'model' } = {}) {
  const row = {
    at: now,
    taskId: safeTaskId(task?.id),
    title: String(task?.title ?? '').slice(0, 60),
    scheduledAt: Math.floor(Number(scheduledAt)),
    via: String(via).slice(0, 20),
    text: String(text ?? '').slice(0, 600),
  }
  const r = appendLedger('runtime/schedule-history.jsonl', row, { workspace })
  return { ok: r.ok, why: r.why }
}

/** 更新任务的"上次触发"（**只是缓存**，去重靠台账，见文件头）。 */
export function markTaskFired({ workspace, id, scheduledAt, now = Date.now() } = {}) {
  const task = readTask({ workspace, id })
  if (!task) return { ok: false, why: '任务不存在' }
  task.lastFiredAt = now
  task.lastScheduledAt = Math.floor(Number(scheduledAt))
  try {
    writeJson(join(String(workspace), taskRel(id)), task)
    return { ok: true, task }
  } catch (error) {
    return { ok: false, why: `写不进去：${error?.message ?? error}` }
  }
}

/**
 * 台账裁剪：超过上限就按"最旧先丢"重写。
 *
 * ★ 为什么只裁这两个台账、不裁历史：历史是"它到底说了什么"的唯一记录，
 *   而它在**用户侧无法重现**（模型现写的）。台账只是去重用的元数据。
 */
export function pruneLedgers({ workspace, maxLines = LEDGER_MAX_LINES } = {}) {
  const out = []
  for (const rel of [FIRES_REL, MISSED_REL]) {
    const r = readLedger(rel, { workspace })
    if (!r.ok) {
      out.push({ rel, ok: false, why: r.why })
      continue
    }
    if (r.rows.length <= maxLines) {
      out.push({ rel, ok: true, kept: r.rows.length, dropped: 0 })
      continue
    }
    const kept = r.rows.slice(-maxLines)
    try {
      const file = join(String(workspace), rel)
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${kept.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf8')
      renameSync(tmp, file)
      out.push({ rel, ok: true, kept: kept.length, dropped: r.rows.length - kept.length })
    } catch (error) {
      out.push({ rel, ok: false, why: `裁剪失败：${error?.message ?? error}` })
    }
  }
  return out
}

/**
 * 把某条**已经报告过**的错过记录从台账里去掉。
 *
 * ★ 为什么要它（否则会有一个"看起来很小、实际天天变大"的问题）：
 *   错过记录一旦写进去就**永远留在台账里**，而 `renderMissedBlock` 每次都把
 *   最后 N 条塞进提示词 ⇒ 一条三天前的错过会**在接下来每一轮对话里都被提一遍**。
 *   使用者看到的就是"它怎么老提那件事"。
 *
 * 调用时机（由 runner 决定）：**这条错过已经真的进过上下文之后**。
 * `pruneMissedBefore` 是它的简单形式：只要成功报告过，就把它连同更早的一起清掉。
 *
 * ★ 用 `unlinkSync` 的风险这里不存在（我们是**重写**而不是删单个文件），
 *   但仍然走 tmp + rename（与其它落盘一致）。
 */
export function pruneMissedBefore({ workspace, at } = {}) {
  const root = String(workspace ?? '')
  if (!root) return { ok: false, why: '缺少 workspace' }
  const cutoff = Number(at)
  if (!Number.isFinite(cutoff)) return { ok: false, why: '缺少 cutoff' }
  const r = readLedger(MISSED_REL, { workspace: root })
  if (!r.ok) return { ok: false, why: r.why }
  const kept = r.rows.filter((row) => !(Number.isFinite(Number(row?.scheduledAt)) && Number(row.scheduledAt) <= cutoff))
  if (kept.length === r.rows.length) return { ok: true, removed: 0 }
  try {
    const file = join(root, MISSED_REL)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, kept.length ? `${kept.map((x) => JSON.stringify(x)).join('\n')}\n` : '', 'utf8')
    renameSync(tmp, file)
    return { ok: true, removed: r.rows.length - kept.length }
  } catch (error) {
    return { ok: false, why: `清不掉：${error?.message ?? error}` }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 提示词：这一轮不是"有人说话"，是"到点了"
// ══════════════════════════════════════════════════════════════════════════

/**
 * 定时任务那一轮给模型看的"任务说明"。
 *
 * ★ 三条措辞纪律（都有具体理由，改之前先读）：
 *   ① **明说这不是对方刚说的话** —— 否则模型会以为对方刚提了这件事，
 *      于是回一句"好的我记下了"这种莫名其妙的话；
 *   ② **明说时间与迟到量** —— 迟到时假装准时就是骗人（`AGENT.md` 第 6 条）；
 *   ③ **明说"直接说那句话"** —— 不说的话它可能回一句元讨论
 *      （"收到，我会在 8 点提醒你"），而那正是使用者眼里最没用的回复。
 *
 * @param {object} opts
 * @param {ScheduleTask} opts.task
 * @param {number} opts.scheduledAt
 * @param {number} opts.now
 * @returns {string} 空串 = 没有可说的（不注入）
 */
export function renderScheduleTaskBlock({ task, scheduledAt, now = Date.now() } = {}) {
  if (!task) return ''
  const lateMs = Math.max(0, Number(now) - Number(scheduledAt))
  const lateMin = Math.round(lateMs / 60000)
  const stamp = formatStamp(Number(scheduledAt))
  const lines = [
    '【定时任务（**不是对方刚说的话**）】',
    `这件事是你自己之前答应过的：「${String(task.prompt ?? '').replace(/\s+/g, ' ').trim()}」`,
    `约定的时刻到了：${stamp}${task.requestedBy ? `（${task.requestedBy} 让你提醒的）` : ''}。`,
  ]
  if (lateMin >= 1) {
    lines.push(
      `⚠️ **现在已经比约定时刻晚了约 ${lateMin} 分钟** —— 别假装你准时，` +
        '该说一句"晚了"就说，别当成刚发生。',
    )
  }
  lines.push(
    '现在**直接说那句要提醒的话**（一句话就够，别解释你在执行什么任务、' +
      '别回"好的我知道了"这种没有信息量的确认）；如果你判断这会儿不适合说，' +
      '那就照实说一句为什么没说成。',
  )
  return lines.join('\n')
}

/** 把时刻写成 `HH:MM`（**按任务自己的时区**，不是跑进程那台机器的时区）。 */
export function formatStamp(ms, timeZone = 'Asia/Shanghai') {
  const t = Number(ms)
  if (!Number.isFinite(t)) return '?'
  const wall = zonedParts(new Date(t), timeZone)
  return `${wall.ymd} ${wall.hm}`
}

/**
 * **服务器事件**那一轮给模型看的任务说明（0.3.2 P2）。
 *
 * ★ 与时钟那条的分工：时钟说"到点了"，这条说"**出事了**"。措辞纪律三条（都有理由）：
 *   ① **明说这不是对方问的** —— 否则它会回一句"好的我看看"，而没有人问过它任何事；
 *   ② **把类别、服务器、时刻、以及"多久前"说清楚** —— 报告的价值在**准确**，
 *      语气不重要（这一条与提醒类正好相反：提醒要像它自己说的话，告警要信息完整）；
 *   ③ **`down` 与 `anomaly` 分开说**：前者可以提"我准备尝试重启一次"（P4），
 *      后者**绝不许**提重启（"TPS 低就重启"是赌博）。
 *
 * @param {object} opts
 * @param {object} opts.task
 * @param {{event?: string, text?: string, at?: number, serverName?: string, snapshot?: object}} opts.trigger
 * @param {number} [opts.now]
 */
export function renderServerEventBlock({ task, trigger = {}, now = Date.now() } = {}) {
  if (!task) return ''
  const kind = String(trigger.event ?? '')
  const serverName = String(trigger.serverName ?? trigger.serverId ?? task?.trigger?.serverId ?? '那台服务器')
  const at = Number(trigger.at ?? now)
  const agoMin = Math.max(0, Math.round((Number(now) - at) / 60000))
  const head =
    kind === 'down'
      ? `⚠️ ${serverName} **连不上了**`
      : kind === 'up'
        ? `✅ ${serverName} **恢复了**`
        : `⚠️ ${serverName} **指标异常**`
  const lines = [
    '【服务器事件（**不是对方问你的**）】',
    `${head}（检测到于 ${formatStamp(at, task?.timezone)}${agoMin >= 1 ? `，约 ${agoMin} 分钟前` : ''}）。`,
  ]
  if (trigger.text) lines.push(`详情：${String(trigger.text).slice(0, 300)}`)
  lines.push(`你之前交代过这件事要报：${String(task.prompt ?? '').replace(/\s+/g, ' ').trim()}`)
  lines.push(
    kind === 'anomaly'
      ? '现在**把这件事说清楚就好**（哪台服、什么指标、什么时候）—— 指标异常**不要**说你要重启，' +
          '也不要承诺任何自动动作。'
      : '现在**把这件事说清楚**（哪台服、什么时候、当时什么状况）—— 一句话就够，' +
          '别解释你在执行什么任务，也别回"好的我知道了"这种没有信息量的确认。',
  )
  return lines.join('\n')
}

/**
 * 把事件里的 `{...}` 占位符填进一段文案（**任务定义与提示词都用它**）。
 *
 * 支持的占位符：`{server}` `{event}` `{time}` `{detail}` `{players}` `{tps}`。
 * ★ **认不出的占位符原样留着**（不删、不填空）：留着一个 `{foo}` 能被一眼看出写错了，
 *   而悄悄换成空串会让文案读起来通顺但内容缺失 —— 那是更难发现的错。
 */
export function fillEventPlaceholders(text, ctx = {}) {
  const map = {
    server: String(ctx.serverName ?? ctx.serverId ?? ''),
    event: String(ctx.event ?? ''),
    time: ctx.at ? formatStamp(ctx.at, ctx.timezone) : '',
    detail: String(ctx.text ?? ''),
    players: Number.isFinite(Number(ctx.snapshot?.players)) ? String(ctx.snapshot.players) : '拿不到',
    tps: Number.isFinite(Number(ctx.snapshot?.tps)) ? String(ctx.snapshot.tps) : '拿不到',
  }
  return String(text ?? '').replace(/\{([a-z]+)\}/gi, (whole, name) => {
    const key = String(name).toLowerCase()
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : whole
  })
}

/**
 * 错过台账 → 给模型的一段话（**由桥接决定何时注入**：下一轮对话时）。
 *
 * ★ 为什么是"告诉模型"而不是"直接补发"：使用者拍板的是**不补发**（§13.1）。
 *   但"什么都不说"就是静默失败 —— 所以让它在下一次说话时**如实提一句**。
 */
export function renderMissedBlock(rows = [], { timeZone = 'Asia/Shanghai', max = 5 } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.title).slice(-Math.max(1, max))
  if (list.length === 0) return ''
  const lines = list.map((r) => {
    const when = formatStamp(r.scheduledAt, timeZone)
    const late = Math.round(Math.max(0, Number(r.lateByMs) || 0) / 60000)
    return `- ${when} 的「${String(r.title).slice(0, 40)}」（当时晚了约 ${late} 分钟，已经错过）`
  })
  return [
    '【有几条定时提醒**没有发出去**】',
    ...lines,
    '（这些**已经过期、不要现在补发**。你只需要在合适的时候**照实提一句**' +
      '（"X 点那条我没发出去"），别装作什么都没发生，也别一次全倒出来。）',
  ].join('\n')
}
