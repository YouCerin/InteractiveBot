/**
 * 服务器监测：**采样 → 状态机 → 事件**（0.3.2 P2）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════════════════════
 * 需求原话是「服务器出问题时小鲸鱼会**且仅会一次**在选定聊天中报告」。
 * 「且仅会一次」不是靠"记得别重复报"实现的 —— 它靠**状态跃迁**：
 *
 *   · 持续 down **不重复产出事件**（只有 `up→down` 那一次产出）；
 *   · 状态**落盘** ⇒ 桥接重启也不会把"它已经报过了"忘掉；
 *   · `down→up` 也产出**一次**（"恢复了"必须说，否则使用者永远不知道它自己好了）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 这个模块**不认识 Minecraft**（这是它最要紧的性质）
 * ══════════════════════════════════════════════════════════════════════════
 * 它只吃一份**归一化快照**（`{reachable, players, tps, version, error}`），
 * 于是：
 *   · **没有任何版本判断**（不许出现 `if (paper)` / `if (forge)` / `instanceof`）；
 *   · 全部逻辑可以**离线测**（造快照即可，不需要任何服务端）；
 *   · 换一种服务端/换一种事件源（RCON / 子进程输出 / 插件推送）**不用改这里**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ "什么算故障"必须先声明（不许在代码里猜）
 * ══════════════════════════════════════════════════════════════════════════
 * 契约（`docs/0.3.2-task-manager-plan.md` §6.1）定的是：
 *   · **默认只把"连不上"算 down**；
 *   · `tps` 低、人数异常等 ⇒ 归「异常报告」（**只报告、不重启**）。
 * 理由很硬：**"tps 低"重启一次是赌博**，而重启用错地方比不重启贵得多。
 * ∴ 本模块产出两类事件，类型不同 ⇒ 上层处置不同：
 *   `down` / `up`（可自恢复，允许重启）· `anomaly`（只报告）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三条不能改的性质
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **绝不抛异常**：监测是增强路径（同 `oplog` / `memory-stats` 的纪律）。
 *   ② **采样失败 ≠ down**：要连续失败 N 次才判 down（`failThreshold`）——
 *      网络抖一下就播报"服务器挂了"会让这个功能变成噪音源，而噪音等于没有告警。
 *   ③ **落盘的状态只存事实**：进程数、判定来源、时刻 —— 不存任何玩家聊天内容。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 监测状态文件所在目录（工作区相对）。★ 放工作区 ⇒ 天然属于受保护路径。 */
export const MONITOR_DIR = 'runtime/servers'

/** 连续失败多少次才算 down。★ 1 会让网络抖动变成误报。 */
export const DEFAULT_FAIL_THRESHOLD = 2

/** 恢复后要连续成功多少次才算 up（对称地防抖）。 */
export const DEFAULT_OK_THRESHOLD = 1

/** 事件类型。 */
export const EVENT = {
  /** 从"能用"变成"连不上" —— **唯一允许触发重启的那一类**。 */
  DOWN: 'down',
  /** 从"连不上"变回"能用"。 */
  UP: 'up',
  /** 能用，但某项指标异常（只报告，**不重启**）。 */
  ANOMALY: 'anomaly',
}

/**
 * 一个归一化快照。
 *
 * @typedef {object} ServerSnapshot
 * @property {boolean} reachable  连上了吗（**唯一的 down 判据**）
 * @property {number|null} players 在线人数（拿不到就 null，**不编 0**）
 * @property {string[]|null} playerNames 在线名单（拿不到就 null）
 * @property {number|null} tps     服务端自报的 TPS（拿不到就 null）
 * @property {string|null} version 版本串（拿不到就 null）
 * @property {string|null} error   失败时的分类文案（**不含密码**）
 * @property {number} at           采样时刻
 */

/**
 * 造一个监测状态机（**可注入时钟与文件系统路径**，所以能离线测）。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} opts.serverId           稳定标识（状态文件名用它）
 * @param {number} [opts.failThreshold]
 * @param {number} [opts.okThreshold]
 * @param {(rel: string) => object|null} [opts.read]  可注入读（测试用）
 * @param {(rel: string, value: object) => void} [opts.write] 可注入写（测试用）
 * @param {() => number} [opts.now]
 * @param {(m: string) => void} [opts.log]
 */
export function createMonitor({
  workspace,
  serverId,
  failThreshold = DEFAULT_FAIL_THRESHOLD,
  okThreshold = DEFAULT_OK_THRESHOLD,
  read = null,
  write = null,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const root = String(workspace ?? '')
  const id = String(serverId ?? '').replace(/[^a-zA-Z0-9_.-]/g, '_')
  const rel = `${MONITOR_DIR}/${id}.json`

  const readImpl =
    read ??
    ((r) => {
      try {
        const p = join(root, r)
        if (!existsSync(p)) return null
        let text = readFileSync(p, 'utf8')
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
        return JSON.parse(text)
      } catch {
        return null
      }
    })

  const writeImpl =
    write ??
    ((r, value) => {
      const p = join(root, r)
      mkdirSync(join(p, '..'), { recursive: true })
      const tmp = `${p}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, 'utf8')
      renameSync(tmp, p)
    })

  /**
   * 状态。`phase` 只有两个值（`up` / `down`），而 `streak` 是"连续同向采样次数"。
   *
   * ★★ 为什么 `streak` 必须落盘：不落盘的话，重启后"连续失败 1 次"会重新数起，
   *   于是一个"已经连续挂了 10 次"的服务器在重启后又变成"疑似"，**告警被推迟**。
   */
  let state = {
    version: 1,
    serverId: id,
    /** 'up' | 'down' */
    phase: 'up',
    /** 连续"不可达"次数 */
    failStreak: 0,
    /** 连续"可达"次数 */
    okStreak: 0,
    /** 上次跃迁的时刻与原因（给人看） */
    since: null,
    lastPhaseChangeAt: null,
    /** 最近一次采样的事实（**不含聊天内容**） */
    lastAt: null,
    lastReachable: null,
    lastPlayers: null,
    lastTps: null,
    lastVersion: null,
    lastError: null,
    /** 已经播报过的异常键（防同一异常反复播报） */
    anomalyKeys: [],
    /** 累计采样与失败次数（巡检用） */
    samples: 0,
    failures: 0,
  }

  /** 从盘上恢复（**读不出来就当作全新**，并留一行证据）。 */
  function load() {
    const saved = readImpl(rel)
    if (saved && typeof saved === 'object' && saved.serverId === id) {
      state = { ...state, ...saved }
      // 白名单化 phase（盘上被手改成别的值时**不许当成 up**）
      state.phase = saved.phase === 'down' ? 'down' : 'up'
      state.anomalyKeys = Array.isArray(saved.anomalyKeys) ? saved.anomalyKeys.slice(-50) : []
      return { ok: true, restored: true }
    }
    return { ok: true, restored: false }
  }

  function save() {
    try {
      writeImpl(rel, state)
      return { ok: true }
    } catch (error) {
      // 增强路径：写不上只留证据（但它会让"恰好一次"在重启后退化，所以必须喊）
      log(`⚠️ [servers] ${id} 监测状态没写盘（重启后可能重复播报一次）：${error?.message ?? error}`)
      return { ok: false, why: String(error?.message ?? error) }
    }
  }

  /**
   * 喂一份快照，拿回**这一跳产生的事件**（可能是空数组）。
   *
   * ★ 这是本模块唯一的入口，也是"恰好一次"落地的地方：事件**只在跃迁时产出**。
   *
   * @param {ServerSnapshot} snap
   * @returns {{events: {type: string, serverId: string, at: number, snapshot: ServerSnapshot, detail?: string}[],
   *            phase: string, changed: boolean, streak: {fail: number, ok: number}}}
   */
  function feed(snap = {}) {
    const events = []
    const at = Number(snap.at ?? now())
    state.samples += 1
    state.lastAt = at
    state.lastReachable = snap.reachable === true
    state.lastPlayers = numOrNull(snap.players)
    state.lastTps = numOrNull(snap.tps)
    state.lastVersion = typeof snap.version === 'string' ? snap.version.slice(0, 80) : null
    state.lastError = snap.error ? String(snap.error).slice(0, 200) : null
    if (snap.reachable !== true) state.failures += 1

    const before = state.phase

    if (snap.reachable === true) {
      state.okStreak = (state.okStreak ?? 0) + 1
      state.failStreak = 0
      if (state.phase === 'down' && state.okStreak >= Math.max(1, okThreshold)) {
        state.phase = 'up'
        events.push({ type: EVENT.UP, serverId: id, at, snapshot: copySnap(snap) })
      }
      // ── 异常报告（**只报告，不重启**）────────────────────────────────
      const anomaly = detectAnomaly(snap)
      if (anomaly) {
        // ★ 同一个异常只播报一次：键里带上"哪个指标"而不是数值
        //   （数值每次都变 ⇒ 会变成每跳一次 —— 那是刷屏，不是告警）
        const key = anomaly.key
        if (!state.anomalyKeys.includes(key)) {
          events.push({ type: EVENT.ANOMALY, serverId: id, at, snapshot: copySnap(snap), detail: anomaly.text })
          state.anomalyKeys.push(key)
          state.anomalyKeys = state.anomalyKeys.slice(-50)
        }
      } else {
        // 异常消失了 ⇒ 清掉键，下次再出现要能重新播报（否则"第二次低 TPS"永远没人知道）
        state.anomalyKeys = []
      }
    } else {
      state.failStreak = (state.failStreak ?? 0) + 1
      state.okStreak = 0
      if (state.phase === 'up' && state.failStreak >= Math.max(1, failThreshold)) {
        state.phase = 'down'
        events.push({ type: EVENT.DOWN, serverId: id, at, snapshot: copySnap(snap), detail: state.lastError ?? '' })
      }
    }

    const changed = before !== state.phase
    if (changed) {
      state.since = events[0]?.type ?? null
      state.lastPhaseChangeAt = at
    }
    save()
    return { events, phase: state.phase, changed, streak: { fail: state.failStreak, ok: state.okStreak } }
  }

  return {
    feed,
    load,
    save,
    serverId: id,
    rel,
    /** 只读快照（巡检/界面用）。★ 返回副本，调用方改它不影响内部状态。 */
    snapshot: () => JSON.parse(JSON.stringify(state)),
    /** 重置到全新状态（管理手段）。 */
    reset() {
      state.phase = 'up'
      state.failStreak = 0
      state.okStreak = 0
      state.since = null
      state.lastPhaseChangeAt = null
      state.anomalyKeys = []
      state.samples = 0
      state.failures = 0
      save()
      return { ok: true }
    },
  }
}

/**
 * 「这个数拿到了吗」——**唯一的判据**。
 *
 * ★★ 为什么必须单独写一个（这是个真缺陷，被断言抓到的）：
 *   `Number(null)` 是 **0**、`Number('')` 也是 **0**，而 `Number.isFinite(0)` 是 `true`。
 *   于是 `Number.isFinite(Number(snap.players))` 会把"**拿不到**"判成"**0 人**"，
 *   渲染出来是「在线 0 人」—— 使用者会以为服务器空了，而其实是没问出来。
 *   ∴ 任何"拿不到就 null"的字段都必须先排除 null/undefined/空串，再谈数值。
 */
function numOrNull(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 只把事实拷进事件（**不含任何聊天内容** —— 这个模块根本拿不到那些）。 */
function copySnap(snap) {
  return {
    reachable: snap.reachable === true,
    players: numOrNull(snap.players),
    playerNames: Array.isArray(snap.playerNames) ? snap.playerNames.slice(0, 200) : null,
    tps: numOrNull(snap.tps),
    version: typeof snap.version === 'string' ? snap.version.slice(0, 80) : null,
    error: snap.error ? String(snap.error).slice(0, 200) : null,
    at: Number(snap.at ?? Date.now()),
  }
}

/**
 * 判"异常"（**不是故障**）。
 *
 * ★★ 阈值从哪来：**调用方给**（`snap.thresholds`），本模块**不内置默认阈值** ——
 *   "TPS 低于多少算异常"取决于服务端与整合包，写死一个数字就是替使用者做决定。
 *   没给阈值 ⇒ 不判异常（**宁可不报，也不乱报**）。
 *
 * ★ 返回的 `key` 是**指标名**，不是数值 —— 同一指标反复异常只播报一次。
 */
export function detectAnomaly(snap = {}) {
  const th = snap.thresholds && typeof snap.thresholds === 'object' ? snap.thresholds : null
  if (!th) return null
  const tps = numOrNull(snap.tps)
  const players = numOrNull(snap.players)
  const minTps = numOrNull(th.minTps)
  const maxPlayers = numOrNull(th.maxPlayers)
  if (minTps !== null && tps !== null && tps < minTps) {
    return { key: 'tps-low', text: `TPS 只有 ${tps}（低于 ${minTps}）` }
  }
  if (maxPlayers !== null && players !== null && players > maxPlayers) {
    return { key: 'players-high', text: `在线 ${players} 人（超过 ${maxPlayers}）` }
  }
  return null
}

/**
 * 把一份快照渲染成**给人看的一行**（告警与查询都用同一份措辞 —— 一处实现）。
 *
 * ★ 拿不到的事实写「拿不到」而不是 0：`0 人` 与「不知道几个人」是两件事，
 *   混起来会让使用者以为服务器空了。
 */
export function describeSnapshot(snap = {}) {
  if (snap.reachable !== true) {
    // ★ 不写 `连不上（连不上那个…）`：失败原因来自 `rcon.mjs` 的**分类文案**，
    //   它本来就以"连不上那个 RCON 端口…"开头 —— 外面再包一层就重复嵌套了
    //   （实测在 `--servers` 的输出里看到过）。拿不到原因时**如实说拿不到**。
    const why = String(snap.error ?? '').trim()
    return why ? why.slice(0, 160) : '连不上，但没拿到原因（监测只记下了这一次失败）'
  }
  const bits = []
  const players = numOrNull(snap.players)
  const tps = numOrNull(snap.tps)
  bits.push(players !== null ? `在线 ${players} 人` : '在线人数拿不到')
  if (Array.isArray(snap.playerNames) && snap.playerNames.length > 0) {
    bits.push(snap.playerNames.slice(0, 8).join('、') + (snap.playerNames.length > 8 ? ' 等' : ''))
  }
  bits.push(tps !== null ? `TPS ${tps}` : 'TPS 拿不到')
  if (snap.version) bits.push(`版本 ${snap.version}`)
  return bits.join(' · ')
}
