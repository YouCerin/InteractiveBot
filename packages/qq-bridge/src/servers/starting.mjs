/**
 * **启动窗口**：把"它正在启动"与"它挂了"分开（0.3.2 收尾，P3 前置）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这个模块（这是设计文档 §6.3.4 第 2 条，一直没实现）
 * ══════════════════════════════════════════════════════════════════════════
 * 模组服**冷启动 18~60 秒**（实测：这台 Forge 1.20.1 从 `Starting minecraft server`
 * 到 `Done (3.430s)!` 是 4 秒，但**首次/模组多时能到 1~2 分钟**），而判 down 的判据是
 * **连续 `failThreshold` 次**（默认 2）、采样间隔默认 30 秒。
 *
 * ⇒ **服务端还在加载时就会被判成 down**。后果有三条，每条都不轻：
 *   ① 使用者在界面上看到"🔴 down"，以为它挂了 —— 而它其实正在起来；
 *   ② 更糟的是**重启编排会真的动手**（`down` 是唯一允许触发重启的那一类），
 *      于是"我刚把它拉起来，它自己又把我拉起来的那一个当成挂了、再拉一个" ⇒
 *      **两个 JVM 同写一个世界 = 存档损坏（不可逆）**；
 *   ③ 控制台/主动检测回一句"连不上那个 RCON 端口" ⇒ 把人往"服务端有问题"上引。
 *
 * ★ 判据（**顺序不能换**）：进程活着 + 端口还没开 ⇒ **正在启动**；
 *   端口开了但 RCON 登录成功 ⇒ **已就绪**；超过窗口 ⇒ **不再算启动中**（如实说超时）。
 *   ⚠️ 关键：**"正在启动"必须以「我们刚刚真的拉起过它」为前提**（`mark` 时才写）。
 *   否则一个"手动起在别处、还没加载完"的服务端也会被我们当成自己在启动 ——
 *   那会把"别人的服务端"说成"我在启动它"。
 *
 * ★ 落盘：桥接重启/崩溃后**必须还记得**自己在启动（否则重启窗口里又会误报 down）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 默认启动窗口：模组服首次启动实测 1~2 分钟，给足余量。 */
export const DEFAULT_STARTUP_WINDOW_MS = 180_000

const DIR = 'runtime/servers'

/** 启动台账的位置（与归属档、控制台日志同片区）。 */
export function startingPath(workspace, serverId) {
  const id = String(serverId ?? '').replace(/[^a-zA-Z0-9_.-]/g, '_')
  return join(String(workspace ?? ''), DIR, `${id}.starting.json`)
}

/**
 * 记下"我们刚开始启动它"。
 *
 * @param {object} o
 * @param {string} o.workspace
 * @param {string} o.serverId
 * @param {number} [o.pid]      刚拉起的进程 pid（现场核对用；**不参与判据**）
 * @param {number} [o.windowMs] 这次给多长的窗口
 * @param {number} [o.now]
 * @returns {{ok:boolean, file?:string, why?:string}}
 */
export function markStarting({ workspace, serverId, pid = null, windowMs = DEFAULT_STARTUP_WINDOW_MS, now = Date.now() } = {}) {
  try {
    if (!workspace) return { ok: false, why: '没有工作区路径' }
    if (!serverId) return { ok: false, why: '没有 serverId' }
    const file = startingPath(workspace, serverId)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        serverId: String(serverId),
        pid: Number.isFinite(Number(pid)) ? Number(pid) : null,
        startedAt: Number(now),
        until: Number(now) + Math.max(1000, Number(windowMs) || DEFAULT_STARTUP_WINDOW_MS),
      }) + '\n',
      'utf8',
    )
    return { ok: true, file }
  } catch (error) {
    return { ok: false, why: error?.message ?? String(error) }
  }
}

/** 清掉启动台账（已就绪 / 明确失败 / 放弃时调）。 */
export function clearStarting({ workspace, serverId } = {}) {
  try {
    if (!workspace || !serverId) return { ok: false, why: '缺参数' }
    rmSync(startingPath(workspace, serverId), { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, why: error?.message ?? String(error) }
  }
}

/** 读启动台账（认不出/文件坏 ⇒ null，**不猜**）。 */
export function readStarting({ workspace, serverId } = {}) {
  try {
    if (!workspace || !serverId) return null
    const file = startingPath(workspace, serverId)
    if (!existsSync(file)) return null
    let raw = readFileSync(file, 'utf8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object') return null
    if (!Number.isFinite(Number(j.startedAt)) || !Number.isFinite(Number(j.until))) return null
    return { startedAt: Number(j.startedAt), until: Number(j.until), pid: Number.isFinite(Number(j.pid)) ? Number(j.pid) : null }
  } catch {
    return null
  }
}

/**
 * **判定"它现在是不是在启动中"**（纯函数，给界面/监测/控制台共用同一份判据）。
 *
 * @param {object} o
 * @param {object|null} o.state     `readStarting()` 的结果
 * @param {boolean} o.portOpen      端口通不通
 * @param {number} [o.now]
 * @returns {{starting:boolean, expired:boolean, waitedMs:number, leftMs:number}}
 *   · `starting:true`  ⇒ **正在启动**（端口还没开、还在窗口内）
 *   · `expired:true`   ⇒ 窗口过了 ⇒ **不再算启动中**（调用方该如实说"启动超时"）
 */
export function evaluateStarting({ state = null, portOpen = false, now = Date.now() } = {}) {
  if (!state) return { starting: false, expired: false, waitedMs: 0, leftMs: 0 }
  const waitedMs = Math.max(0, Number(now) - state.startedAt)
  const leftMs = Math.max(0, state.until - Number(now))
  // ★ 端口已经开了 ⇒ 不再算"启动中"（剩下的是"等 RCON 登录"，那是另一回事）
  if (portOpen) return { starting: false, expired: false, waitedMs, leftMs }
  if (leftMs <= 0) return { starting: false, expired: true, waitedMs, leftMs: 0 }
  return { starting: true, expired: false, waitedMs, leftMs }
}

/** 给人看的一句话（界面与日志共用，**避免两处措辞分叉**）。 */
export function describeStarting({ waitedMs = 0, leftMs = 0 } = {}) {
  const s = Math.round(Number(waitedMs) / 1000)
  const left = Math.round(Number(leftMs) / 1000)
  return `🟡 正在启动（已等 ${s} 秒，最多再等 ${left} 秒）—— 模组服冷启动常要 1~2 分钟，这期间**不是故障**`
}
