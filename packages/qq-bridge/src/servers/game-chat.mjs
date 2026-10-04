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
 * 五种结果，**每一种都有明确的理由**（不猜）：
 *   `bind`  —— 未绑定，且 QQ 侧**正好有一份**待绑定资格 ⇒ 现在写死映射
 *   `ask`   —— 未绑定，但有 **≥2 份**资格 ⇒ **绝不猜**（猜错 = 把别人的身份算到你头上）
 *   `remind`—— 未绑定且这一趟还没提示过 ⇒ 只给他本人一条"怎么绑"
 *   `ignore`—— 未绑定且已经提示过 ⇒ 什么都不做（刷屏的提示等于没有提示）
 *   `turn`  —— 已绑定 ⇒ 交给唤醒判定与模型
 *
 * @param {object} o
 * @param {string} o.name            游戏内显示名（`<名> 正文` 里的那个）
 * @param {string|null} o.uuid        解析到的 UUID（拿不到就是 null）
 * @param {object|null} o.bound       `lookupByUuid()` 的结果
 * @param {Array} o.pending           `pendingQualifications()` 的结果
 * @param {boolean} o.reminded        这一趟进服是否已经提示过
 * @returns {{action:'bind'|'ask'|'remind'|'ignore'|'turn', qqId?:string, text?:string}}
 */
export function decideGameChat({ name = '', uuid = null, bound = null, pending = [], reminded = false } = {}) {
  if (uuid && bound && bound.qqId) return { action: 'turn', qqId: String(bound.qqId) }
  const list = Array.isArray(pending) ? pending : []
  if (list.length === 1) return { action: 'bind', qqId: String(list[0]?.qqId ?? '') }
  if (list.length > 1) {
    return {
      action: 'ask',
      text:
        `现在有 ${list.length} 个待确认的绑定，我没法确定你是哪一个 —— ` +
        '请在群里重新发一条 `/绑定`，拿到新码后马上用 `/绑定 <码>` 提交。',
    }
  }
  if (reminded) return { action: 'ignore' }
  return {
    action: 'remind',
    text: `你好，${String(name ?? '')}。我还不知道你是群里的谁 —— 请在群里发 \`/绑定\` 拿一个 6 位码，再用 \`/绑定 <码>\` 交回来，之后就能在这里跟我说话了。`,
  }
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
