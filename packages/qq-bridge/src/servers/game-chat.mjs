/**
 * 游戏内对话：**判定**（纯函数）+ **读日志的循环**（0.3.2 P3）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 事件源：**桥接自己拉起的那个服务端**的控制台输出（设计文档 §6.3.3 的"白拿"）
 * ══════════════════════════════════════════════════════════════════════════
 * P2 已经把服务端的 stdout/stderr 重定向进 `runtime/servers/<id>.console.log`
 * ⇒ 读它**不需要任何服务端插件/模组**（v1 明确不写服务端代码，用户拍板）。
 *
 * ⚠️ 由此带来的一条**必须如实告知**的限制：**只有本程序拉起的服务端**才有那个文件。
 *   别人手动起的服，这里读不到任何东西 —— 那不是故障，是这条路的设计边界
 *   （要覆盖它就得去尾随服务端自己的 `logs/latest.log`，而那正是 P2 刻意避开的）。
 *   ∴ 启动时若发现"开了游戏内对话但那个文件不存在"，**要打一行说清楚**。
 *
 * ── 为什么单独一个循环，不塞进 `servers/loop.mjs` ──────────────────────────
 * 采样间隔下限是 15 秒（模组服的 `list` 偶尔要几秒），而**聊天要秒级**
 * （30 秒才回一句话不叫对话）。两件事的节奏差一个数量级 ⇒ 硬塞在一起会让
 * 其中一个必然是错的。分开的代价只是多一个定时器（都在 `unref()` 之下）。
 */

import { existsSync } from 'node:fs'

import { consoleLogPath } from './console.mjs'
import { readConsoleEvents, readCursor, writeCursor } from './log-source.mjs'

/** 读控制台的间隔（默认 2 秒：够快，且只是 stat + 读增量，不碰网络）。 */
export const DEFAULT_CHAT_POLL_MS = 2000
/** 间隔下限（再密只是白耗 IO）。 */
export const MIN_CHAT_POLL_MS = 1000
/** 同时在跑的回合上限 —— 防止有人刷屏时把模型调用堆起来。 */
export const MAX_INFLIGHT_EVENTS = 4

/**
 * 这条游戏内发言该怎么处理（**纯函数**，一条事件一次判定）。
 *
 * 两种结果：
 *   `turn`  —— 已绑定 ⇒ 交给唤醒判定与模型
 *   `ignore`—— 未绑定 ⇒ **什么都不做**
 *
 * ★★★ **"未绑定的人说话"不再回提醒**（2026-10-04 使用者的要求）：
 *   他原话是「由于**不能确定每次玩家都在跟小鲸鱼说话**，只有进入服务器时进行提醒」。
 *   提醒改由 `#remindUnboundOnJoin()` 在**进服那一刻**发一次（那儿才知道"他刚来"）。
 *   ∴ 未绑定的人说什么都**不进模型、也不回话**（零成本、也不打扰）。
 *   ⚠️ 唯一的例外在桥接那边：他**明确叫了名字**（命中唤醒词）时补发一次 —— 那种情况
 *   我们**确定**他在跟小鲸鱼说话，沉默反而会让他以为坏了。见 `#onGameChat`。
 *
 * ★★ **"取绑定码"那一步不在这里**：它由 `parseGameBindRequest()` 单独判，
 *   而且**优先于本函数** —— 一个已经绑定的玩家重新说一次 `\mc bind`（换绑/自检）
 *   也应该能拿到新码，而不该被"已绑定 ⇒ 交给模型"这条先吃掉。
 *
 * @param {object} o
 * @param {string|null} o.uuid   解析到的 UUID（拿不到就是 null）
 * @param {object|null} o.bound  `lookupByUuid()` 的结果
 * @returns {{action:'turn'|'ignore'}}
 */
export function decideGameChat({ uuid = null, bound = null } = {}) {
  if (uuid && bound && bound.qqId) return { action: 'turn' }
  return { action: 'ignore' }
}

/**
 * 「你还没绑定」那条提醒的**唯一文案**（**只在进服那一刻**发一次）。
 *
 * ★★ 措辞是 2026-10-04 按使用者的要求改过的，改动的**理由**值得记住：
 *   他原话是「由于**不能确定每次玩家都在跟小鲸鱼说话**，只有进入服务器时进行提醒」。
 *   ∴ 这条文案不能再像"在回你那句话"：
 *     · **不打招呼**（原来的「你好，X。」是在回应一次不存在的对话）；
 *     · 说清它是**进服时的一次性提示**，不是有人在跟他聊天；
 *     · 步骤压到最短（他要照做，不是读说明书）。
 * ★ 三条硬要求（都有断言）：① 给的是 `\mc bind` 且明说**反斜杠**（玩家一定会按习惯
 *   打斜杠，而斜杠进不来）；② 说清"码要发到群里"；③ 不写任何内部术语。
 * ★ 前缀 `<小鲸鱼> ` 由 `tellraw.mjs` 的 `botLine()` 统一加（这里**不重复写**）。
 */
export function unboundReminder(name = '') {
  const who = String(name ?? '').trim()
  return (
    `${who ? `${who}，` : ''}你还没绑定，所以现在还没法在这里跟我说话。\n` +
    '要绑定：在聊天里输入 \\mc bind（**反斜杠**，不是斜杠），我给你一个 6 位码；' +
    '然后把码**直接发到群里**：`\\mc bind 你的码`（**不用 @ 我**）。'
  )
}

/**
 * 造一个"读游戏内聊天"的循环。
 *
 * @param {object} o
 * @param {string} o.workspace
 * @param {() => object[]} o.servers  现读服务器列表（**每跳现读** ⇒ 改配置即时生效）
 * @param {number} [o.pollMs]
 * @param {(server: object, event: object) => any} o.onEvent 每读到一条事件就回调
 *        （**不 await** —— 一次模型回合可能几十秒，等它会把后面所有人的话堵住）
 * @param {Function} [o.log]
 * @param {object} [o.timer]
 * @param {Function} [o.readEvents] 测试注入：替换 `readConsoleEvents`
 * @param {Function} [o.logPathFor] 测试注入：替换 `consoleLogPath`
 */
export function createGameChatLoop({
  workspace = '',
  servers = () => [],
  pollMs = DEFAULT_CHAT_POLL_MS,
  onEvent = null,
  log = () => {},
  timer = { setInterval, clearInterval },
  readEvents = readConsoleEvents,
  logPathFor = consoleLogPath,
} = {}) {
  const root = String(workspace ?? '')
  let handle = null
  let ticks = 0
  let busy = false
  let lastAt = null
  let skippedBusy = 0
  const inflight = new Set()
  /** serverId → 是否已经为它打过"没有控制台日志"的提示（**只打一次**，免得刷屏）。 */
  const warnedNoLog = new Set()

  /** 哪些服务器该读聊天：显式开 `gameChat` 且没被停用。 */
  function chatty() {
    let list = []
    try {
      list = servers() ?? []
    } catch (error) {
      log(`❌ [game-chat] 读服务器列表失败（这一跳跳过）：${error?.message ?? error}`)
      return []
    }
    return list.filter((s) => s && s.gameChat === true && s.enabled !== false)
  }

  function fire(server, event) {
    if (typeof onEvent !== 'function') return
    if (inflight.size >= MAX_INFLIGHT_EVENTS) {
      // ★ 不静默丢：这条是真的没处理（玩家会看到"机器人没理我"）
      log(
        `⚠️ [game-chat] 同时在处理的游戏事件已达上限（${MAX_INFLIGHT_EVENTS}）⇒ ` +
          `丢掉一条（${server?.id ?? '?'}｜${event?.kind ?? '?'}）—— 玩家会说"它没理我"`,
      )
      return
    }
    let p
    try {
      p = Promise.resolve(onEvent(server, event))
    } catch (error) {
      log(`❌ [game-chat] 事件回调抛异常（已吞掉，其它人照常）：${error?.message ?? error}`)
      return
    }
    inflight.add(p)
    p.catch((error) => {
      // ★ 必须接住：未处理的 Promise 拒绝会按既定策略把进程带走
      log(`❌ [game-chat] 处理游戏事件失败（已吞掉，机器人照常工作）：${error?.stack ?? error}`)
    }).finally(() => inflight.delete(p))
  }

  async function tick() {
    if (busy) {
      skippedBusy += 1
      return { ok: true, skipped: 'busy', events: 0 }
    }
    busy = true
    ticks += 1
    lastAt = Date.now()
    let count = 0
    try {
      if (!root) {
        log('❌ [game-chat] 没有 workspace（内部接线问题），这一跳跳过')
        return { ok: false, events: 0 }
      }
      for (const server of chatty()) {
        const id = String(server?.id ?? '')
        if (!id) continue
        const file = logPathFor(root, id)
        if (!existsSync(file)) {
          if (!warnedNoLog.has(id)) {
            warnedNoLog.add(id)
            log(
              `⚠️ [game-chat] 「${server?.name ?? id}」开了游戏内对话，但**读不到它的控制台日志**` +
                `（${file}）⇒ 游戏里说的话进不来。\n` +
                '   这不是故障：只有**本程序拉起**的服务端才会把 stdout 写进那个文件。' +
                '别人手动起的服要走这条路，得让本程序来拉（见 config.json 的 `manageOnStart`）。',
            )
          }
          continue
        }
        const from = readCursor(root, id)
        let out
        try {
          out = await readEvents({
            workspace: root,
            serverId: id,
            logFile: file,
            encoding: server?.logEncoding ?? 'auto',
          })
        } catch (error) {
          log(`❌ [game-chat] 「${server?.name ?? id}」读控制台失败（其它台照常）：${error?.message ?? error}`)
          continue
        }
        // ★ 游标推进要在**处理事件之前**写盘：处理可能几十秒（模型回合），
        //   期间桥接重启的话，重放一遍玩家刚说过的话是更糟的失败形状。
        try {
          writeCursor(root, id, out.nextByte)
        } catch {
          /* 写不上只是"下次会重读" —— 不阻断对话 */
        }
        // 一屏之内没读完（日志刷得太快）⇒ 如实说跳过了多少，绝不假装读全了
        const jumped = Math.max(0, Number(out.nextByte) - Number(from))
        if (jumped > 0 && out.rotated !== true && jumped > 256 * 1024) {
          log(`⚠️ [game-chat] 「${server?.name ?? id}」一跳之内新增 ${jumped} 字节，只解析了尾部一片（中间的可能漏了）`)
        }
        if (out.rotated) log(`[game-chat] 「${server?.name ?? id}」的控制台日志被轮转了 ⇒ 从头读`)
        for (const ev of out.events ?? []) {
          count += 1
          fire(server, ev)
        }
      }
      return { ok: true, events: count, servers: chatty().length }
    } finally {
      busy = false
    }
  }

  function start() {
    if (handle) return false
    const ms = Math.max(MIN_CHAT_POLL_MS, Number(pollMs) || DEFAULT_CHAT_POLL_MS)
    handle = timer.setInterval(() => {
      tick().catch((error) => {
        log(`❌ [game-chat] 巡检未捕获错误（已吞掉，机器人照常工作）：${error?.stack ?? error}`)
      })
    }, ms)
    // ★ 绝不能因为一个读日志的定时器把进程退出拖住
    handle?.unref?.()
    log(`[game-chat] 游戏内对话已开启（每 ${Math.round(ms / 1000)} 秒读一次控制台；只读日志，不写服务端）`)
    return true
  }

  function stop() {
    if (!handle) return false
    timer.clearInterval(handle)
    handle = null
    return true
  }

  return {
    start,
    stop,
    tick,
    isRunning: () => Boolean(handle),
    stats: () => ({ ticks, lastAt, running: Boolean(handle), inflight: inflight.size, skippedBusy }),
  }
}
