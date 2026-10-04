/**
 * 服务器监测循环：**采样 → 状态机 → 事件台账**（0.3.2 P2）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三个模块的分工（别把任何一件塞进另一件）
 * ══════════════════════════════════════════════════════════════════════════
 *   `servers/rcon.mjs`    —— 协议：连上、登录、跑一条命令。
 *   `servers/monitor.mjs` —— 判定：跃迁才产出事件（恰好一次的**判定层**）。
 *   **本模块**             —— 编排：什么时候采样、把事件写进台账、（由桥接）交给谁。
 *
 * ★ 它**不投递消息**：事件写到台账（`runtime/servers/events.jsonl`）就结束了。
 *   投递由定时任务那套的主动回合做 —— 这样"监测"与"说话"解耦，
 *   监测坏了不会连累播报逻辑，换一种事件源也不用改这里。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 采样失败**绝不等于**服务器挂了（这条是"告警变成噪音"的唯一成因）
 * ══════════════════════════════════════════════════════════════════════════
 *   判 down 的活由 `monitor.mjs` 的**连续失败阈值**干（默认 2 次）。本模块只负责
 *   "把这一次采样的结果如实交给状态机" —— 包括**分类过**的失败原因，
 *   因为状态机要把那句话原样带进告警（"端口上没东西在听"比"down"有用得多）。
 *
 * ★ 轮询间隔有下限（15 秒）：模组服的 `list` 偶尔会慢到几秒，
 *   再密只是白耗 CPU 与 RCON 连接。
 * ★ 采样里有 `list` 这一条**只读命令**：它不改服务端任何状态。
 *   真正会改状态的命令（`stop` 等）属于 P4 的重启编排，**不在这一层**。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createRconClient } from './rcon.mjs'
import { EVENT, createMonitor, describeSnapshot } from './monitor.mjs'

/** 事件台账（工作区相对）。★ 属于使用者数据。 */
export const EVENTS_REL = 'runtime/servers/events.jsonl'

/** 采样间隔下限（毫秒）。 */
export const MIN_POLL_MS = 15 * 1000

/** 默认采样间隔。 */
export const DEFAULT_POLL_MS = 30 * 1000

/** 事件台账保留多少行。 */
export const EVENTS_MAX = 500

/**
 * 从 `list` 的应答里抠出在线人数与名单。
 *
 * ★ 各服务端的措辞不一样（vanilla / Paper / Forge / Fabric 各有一套），所以这里
 *   **只认最稳的那一段形状**：`... players online: a, b`；认不出就返回 `null`
 *   —— **不猜**（`Number(null)` 那个坑的同一类：把"认不出"说成"0 人"是错的）。
 * ★ 这是本模块里唯一一处"解析文本"的地方。它做得越少越好：真正的结构化数据
 *   应该来自服务端推送（P3），而不是从人看的文本里抠。
 *
 * @returns {{players: number|null, playerNames: string[]|null}}
 */
export function parsePlayerList(body) {
  const text = String(body ?? '').trim()
  if (!text) return { players: null, playerNames: null }
  // 形状：`There are 2 of a max of 20 players online: 小明, Steve`
  const m = /There are (\d+) of a max of \d+ players online:?\s*(.*)$/i.exec(text)
  if (m) {
    const players = Number(m[1])
    const names = String(m[2] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return { players, playerNames: names.length > 0 ? names : null }
  }
  // 另一种常见形状：`2/20 players online`（认得出人数，认不出名单）
  const m2 = /(\d+)\s*\/\s*\d+\s*players/i.exec(text)
  if (m2) return { players: Number(m2[1]), playerNames: null }
  return { players: null, playerNames: null }
}

/**
 * 从 TPS 命令的应答里抠出 TPS。
 *
 * ★ 与 `parsePlayerList` 同一条纪律：**只认最稳的形状，认不出就 `null`，绝不编**。
 *   尤其**不能**把认不出当成 0 —— 那会让 `rules.minTps` 立刻判出"TPS 过低"，
 *   于是"我解析失败"被播报成"服务器快挂了"（正是 `Number(null) === 0` 那类坑）。
 *
 * 认的形状（真机取回来的原文）：
 *   `Dim minecraft:overworld ...: Mean tick time: 6.418 ms. Mean TPS: 20.000`
 *   `Dim minecraft:the_nether ...: Mean tick time: 0.065 ms. Mean TPS: 20.000`
 * ⇒ 多维度时取**最小值**（最慢的那个维度才是玩家体感；取平均会掩盖一个卡死的维度）。
 *
 * @returns {number|null}
 */
export function parseTps(body) {
  const text = String(body ?? '')
  if (!text.trim()) return null
  const all = [...text.matchAll(/Mean TPS:\s*([0-9]+(?:\.[0-9]+)?)/gi)].map((m) => Number(m[1]))
  const usable = all.filter((n) => Number.isFinite(n))
  if (usable.length === 0) return null
  return Math.min(...usable)
}

function readJson(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : fallback
  } catch {
    return fallback
  }
}

/** 追加一行事件（**失败不抛** —— 监测是增强路径）。 */
function appendEvent(workspace, row) {
  const file = join(workspace, EVENTS_REL)
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error) }
  }
}

/** 读最近的事件（只读；给界面与巡检用）。 */
export function readRecentEvents({ workspace, limit = 30 } = {}) {
  const root = String(workspace ?? '')
  if (!root) return { ok: false, rows: [], why: '缺少 workspace' }
  const file = join(root, EVENTS_REL)
  try {
    if (!existsSync(file)) return { ok: true, rows: [], why: '' }
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim())
    const rows = []
    for (const line of lines) {
      try {
        const v = JSON.parse(line)
        if (v && typeof v === 'object') rows.push(v)
      } catch {
        /* 坏行跳过（一份台账里有坏行不该让整份读不出来） */
      }
    }
    return { ok: true, rows: limit > 0 ? rows.slice(-limit) : rows, why: '' }
  } catch (error) {
    return { ok: false, rows: [], why: String(error?.message ?? error) }
  }
}

/** 事件台账裁剪（超过上限丢最旧）。 */
export function pruneEvents({ workspace, max = EVENTS_MAX } = {}) {
  const root = String(workspace ?? '')
  if (!root) return { ok: false, why: '缺少 workspace' }
  const r = readRecentEvents({ workspace: root, limit: 0 })
  if (!r.ok) return { ok: false, why: r.why }
  if (r.rows.length <= max) return { ok: true, dropped: 0 }
  const kept = r.rows.slice(-max)
  try {
    const file = join(root, EVENTS_REL)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${kept.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf8')
    renameSync(tmp, file)
    return { ok: true, dropped: r.rows.length - kept.length }
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error) }
  }
}

/**
 * 造一个监测循环。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {() => object[]} opts.servers  现读配置里的服务器列表（**每跳现读** ⇒ 改配置即时生效）
 * @param {number} [opts.pollMs]
 * @param {(server: object, client: object) => Promise<object>} [opts.sample]
 *        可注入的采样函数（测试用）。默认：`list` + 从应答里抠人数。
 * @param {Function} [opts.makeClient] 可注入的客户端工厂（测试用）
 * @param {(row: object) => void} [opts.onEvent] 每产出一条事件就回调（**不 await**）
 * @param {Function} [opts.log]
 * @param {object} [opts.timer]
 * @param {() => number} [opts.now]
 */
export function createServerLoop({
  workspace,
  servers = () => [],
  pollMs = DEFAULT_POLL_MS,
  sample = null,
  makeClient = createRconClient,
  onEvent = null,
  log = () => {},
  timer = { setInterval, clearInterval },
  now = () => Date.now(),
} = {}) {
  const root = String(workspace ?? '')
  let handle = null
  let ticks = 0
  let lastPollAt = null
  /**
   * 事件**序号**：随每产出一条事件递增。
   *
   * ★★ 为什么要有它：事件的去重键需要"这一行是第几行"。光靠
   *   `serverId+event+时刻` 也能拼出键，但**同一秒内的两次事件**会撞键
   *   （例如 down 之后立刻 up）⇒ 第二次被静默丢掉。序号只增不减，天然不撞。
   */
  let eventSeq = 0
  /** serverId → {monitor, client}（懒建，且**每台一张**） */
  const byId = new Map()

  /** 默认采样：连上 → 跑 `list`（只读） → 归一化。 */
  async function defaultSample(server, client) {
    const at = now()
    const connected = await client.connect()
    if (!connected.ok) {
      // ★ 失败原因**原样带过去**（状态机要把它写进告警；"端口上没东西在听"比"down"有用）
      return { reachable: false, error: connected.text ?? '连不上', at }
    }
    let players = null
    let playerNames = null
    let listError = null
    try {
      const r = await client.exec('list')
      if (r.ok) {
        const parsed = parsePlayerList(r.body)
        players = parsed.players
        playerNames = parsed.playerNames
      } else {
        // 登录成功但 `list` 失败（模组服上命令可能被改掉）—— **如实记，不编人数**
        listError = r.text ?? 'list 命令失败'
      }
    } catch (error) {
      listError = String(error?.message ?? error)
    }
    // ── TPS：**只在使用者给了命令时才采** ────────────────────────────────
    //
    // ★ 为什么不给就留 null：TPS 不是通用命令（vanilla 要 datapack、各端措辞不同），
    //   猜一个只会在真机上拿到一句报错，然后把"我猜错了"显示成"服务器有问题"。
    // ★ 但也不能永远不采（实测撞到的误导）：Forge 的 `forge tps` 真能给
    //   `Mean TPS: 20.000`，而 `--servers` 那时显示"TPS 拿不到" ——
    //   看起来像服务端的毛病，其实是**我们没问**。
    //   ∴ 把"问什么"交给使用者（`servers[].tpsCommand`），解析不出来就仍留 null，
    //     「拿不到」与「TPS 是 0」始终是两件事。
    let tps = null
    const tpsCommand = String(server.tpsCommand ?? '').trim()
    if (tpsCommand) {
      try {
        const tr = await client.exec(tpsCommand)
        if (tr.ok) tps = parseTps(tr.body)
        else listError = listError ?? tr.text ?? 'tps 命令失败'
      } catch (error) {
        listError = listError ?? String(error?.message ?? error)
      }
    }
    return {
      reachable: true,
      players,
      playerNames,
      tps,
      version: null,
      error: listError,
      thresholds: server.rules?.minTps || server.rules?.maxPlayers ? server.rules : null,
      at,
    }
  }

  /**
   * 采集**一台**服务器并处理它的事件。
   * @returns {Promise<{serverId: string, snapshot: object, events: object[]}>}
   */
  async function pollOne(server) {
    let entry = byId.get(server.id)
    if (!entry) {
      const monitor = createMonitor({ workspace: root, serverId: server.id, failThreshold: server.failThreshold, log })
      monitor.load()
      entry = { monitor, client: null }
      byId.set(server.id, entry)
    }
    // ── 停用：只报告"停用"，**一个网络请求都不发** ──
    if (server.enabled === false) {
      return { serverId: server.id, snapshot: { reachable: null, skipped: 'disabled' }, events: [] }
    }
    // ── 没配密码：**不发起连接**（猜一个默认密码没有意义）──
    if (!server.password) {
      const snap = {
        reachable: false,
        error: '没配 RCON 密码（config.json 的 servers[].password）—— 猜一个默认密码没有意义，所以不连',
        at: now(),
      }
      // ★ 这一条**不喂给状态机**：配置不全不是"服务器挂了"，喂进去会产出假的 down 告警。
      //   它只作为"这一跳没采成"的事实回给调用方（界面/巡检显示"没配密码"）。
      return { serverId: server.id, snapshot: { ...snap, reachable: null, misconfigured: true }, events: [] }
    }

    if (!entry.client) {
      entry.client = makeClient({ host: server.host, port: server.rconPort, password: server.password, log })
    }
    let snap
    try {
      snap = sample ? await sample(server, entry.client) : await defaultSample(server, entry.client)
    } catch (error) {
      snap = { reachable: false, error: `采样抛异常：${error?.message ?? error}`, at: now() }
    }
    // 采样失败 ⇒ 把这条连接丢掉，下一跳重建（RCON 客户端的连接可能已经是坏的）
    if (snap?.reachable !== true && entry.client) {
      try {
        entry.client.close()
      } catch {
        /* 关不掉无所谓 */
      }
      entry.client = null
    }

    const fed = entry.monitor.feed(snap)
    const rows = []
    for (const ev of fed.events) {
      eventSeq += 1
      const row = {
        seq: eventSeq,
        at: ev.at,
        serverId: server.id,
        serverName: server.name,
        event: ev.type,
        detail: ev.detail ?? '',
        text: describeSnapshot(ev.snapshot),
        snapshot: ev.snapshot,
      }
      rows.push(row)
      const w = appendEvent(root, row)
      if (!w.ok) log(`⚠️ [servers] 事件台账没写上（这条告警仍会照常播报）：${w.why}`)
      if (typeof onEvent === 'function') {
        try {
          onEvent(row)
        } catch (error) {
          log(`⚠️ [servers] 事件回调抛异常（已吞掉，不影响监测）：${error?.message ?? error}`)
        }
      }
    }
    return { serverId: server.id, snapshot: evSafeSnapshot(snap), events: rows, phase: fed.phase }
  }

  function evSafeSnapshot(snap) {
    return {
      reachable: snap?.reachable === true,
      players: snap?.players ?? null,
      tps: snap?.tps ?? null,
      version: snap?.version ?? null,
      error: snap?.error ?? null,
      at: snap?.at ?? now(),
    }
  }

  /**
   * 一次巡检（**串行**跑所有启用的服务器；每台各自独立超时）。
   * @returns {Promise<{ok: boolean, at: number, results: object[], events: object[]}>}
   */
  async function tick() {
    ticks += 1
    const at = now()
    lastPollAt = at
    if (!root) {
      log('❌ [servers] 没有 workspace（内部接线问题），这一跳跳过')
      return { ok: false, at, results: [], events: [] }
    }
    let list = []
    try {
      list = servers() ?? []
    } catch (error) {
      log(`❌ [servers] 读服务器列表失败（这一跳跳过）：${error?.message ?? error}`)
      return { ok: false, at, results: [], events: [] }
    }
    const results = []
    const events = []
    for (const s of list) {
      try {
        const r = await pollOne(s)
        results.push(r)
        events.push(...(r.events ?? []))
      } catch (error) {
        // 单台失败不影响其它台（这是**多台**监测里最容易写错的地方）
        log(`❌ [servers] ${s?.id ?? '?'} 这一跳采样失败（其它台照常）：${error?.message ?? error}`)
        results.push({ serverId: s?.id ?? '?', error: String(error?.message ?? error), events: [] })
      }
    }
    if (events.length > 0) {
      const pr = pruneEvents({ workspace: root })
      if (!pr.ok) log(`⚠️ [servers] 事件台账裁剪失败：${pr.why}`)
    }
    return { ok: true, at, results, events }
  }

  function start() {
    if (handle) return false
    const ms = Math.max(MIN_POLL_MS, Number(pollMs) || DEFAULT_POLL_MS)
    handle = timer.setInterval(() => {
      tick().catch((error) => {
        // ★ tick 是 async 而 setInterval 不会等它 —— 必须自己接住拒绝，
        //   否则未处理的 Promise 拒绝会按既定策略把进程带走（同 H13 那条事故的形状）
        log(`❌ [servers] 巡检未捕获错误（已吞掉，机器人照常工作）：${error?.stack ?? error}`)
      })
    }, ms)
    // ★ 绝不能因为一个监测定时器把进程退出拖住
    handle?.unref?.()
    log(`[servers] 服务器监测已开启（每 ${Math.round(ms / 1000)} 秒采样一次；采样只用只读命令）`)
    return true
  }

  function stop() {
    if (!handle) return false
    timer.clearInterval(handle)
    handle = null
    for (const entry of byId.values()) {
      try {
        entry.client?.close()
      } catch {
        /* 关不掉无所谓 */
      }
    }
    return true
  }

  return {
    start,
    stop,
    tick,
    isRunning: () => Boolean(handle),
    stats: () => ({ ticks, lastPollAt, servers: byId.size, running: Boolean(handle), eventSeq }),
    /** 只读：最近产出的事件序号（去重键要用它）。 */
    eventSeq: () => eventSeq,
    /** 某台服务器当前用的 RCON 客户端（重启用它发 `stop`；没有就返回 null）。 */
    clientFor: (serverId) => byId.get(String(serverId))?.client ?? null,
    /**
     * 把某台服务器的监测状态**重置成 up**。
     *
     * ★ 为什么重启成功之后必须调它：状态机还停在 `down`，而 `failStreak` 也在累加 ——
     *   不重置的话下一跳会把"已经恢复"的服务器继续当 down（而且"连续失败次数"永远是旧的）。
     *   这是"我把它救活了，但监测还以为它死着"那种自相矛盾，只有接线级断言看得见。
     */
    resetMonitor: (serverId) => {
      const entry = byId.get(String(serverId))
      if (!entry) return { ok: false, why: '这台还没采过样' }
      entry.monitor.reset()
      return { ok: true }
    },
    /** 只读：某台服务器的监测状态（界面/巡检用）。 */
    stateOf: (serverId) => {
      const entry = byId.get(String(serverId))
      if (!entry) return null
      return entry.monitor.snapshot()
    },
    /**
     * **一次性检测**（界面上的"主动检测"按钮）。
     *
     * ★★★ 它与 `tick()` 的关键区别：**不喂状态机、不产出事件、不改累计计数**。
     *   为什么必须分开（不是"顺手复用一下"）：`pollOne` 会把这次结果喂进
     *   `monitor.feed(...)`，于是"连不上"会累加 `failStreak` ⇒ **使用者点几次按钮
     *   就可能把一台好好的服务器自己点成 down**（并触发一次自动重启）。
     *   一个"看一眼"的按钮绝不该有那个副作用。
     *
     * @returns {Promise<{ok:boolean, serverId:string, snapshot:object}>}
     */
    probeOnce: async (server) => {
      const s = server ?? null
      if (!s?.id) return { ok: false, serverId: '', snapshot: { reachable: null, error: '没有这台服务器' } }
      if (s.enabled === false) {
        return { ok: false, serverId: s.id, snapshot: { reachable: null, skipped: 'disabled', error: '这台是停用的' } }
      }
      if (!s.password) {
        return {
          ok: false,
          serverId: s.id,
          snapshot: { reachable: null, misconfigured: true, error: '没配 RCON 密码（config.json 的 servers[].password）' },
        }
      }
      // ★ 用**临时连接**（不复用循环里那个）：一次性检测不该打乱采样循环的连接状态
      const client = makeClient({ host: s.host, port: s.rconPort, password: s.password, log })
      try {
        const snap = sample ? await sample(s, client) : await defaultSample(s, client)
        return { ok: snap?.reachable === true, serverId: s.id, snapshot: { ...snap, probed: true } }
      } catch (error) {
        return { ok: false, serverId: s.id, snapshot: { reachable: false, probed: true, error: `检测抛异常：${error?.message ?? error}` } }
      } finally {
        try {
          client.close()
        } catch {
          /* 关不掉无所谓 */
        }
      }
    },
  }
}

export { EVENT }
