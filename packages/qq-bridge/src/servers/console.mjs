/**
 * 服务器控制台（手动输指令 + 看输出）—— 0.3.2 收尾。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 为什么这里要写清"输出不可靠归因"，而不是做一个看起来像终端的假终端
 * ══════════════════════════════════════════════════════════════════════════
 * RCON 是**服务器控制台**：`op` / `ban` / `stop` / `save-off` 都能做。
 * 但它有两个实测事实，决定了界面不能假装是个真终端：
 *
 *   ① **很多命令的应答是空的**。真机实测：`list` 与 `forge tps` 有回显，
 *      但 `time set day` / `kill` 这类不改状态就没事干的命令**往往不回话**，
 *      它把结果写进服务端日志。所以"发了命令却什么都没看到"**不代表没生效**。
 *   ② **日志无法把输出归因到具体命令**。我们能做的只是"发命令前后取日志增量"，
 *      于是并发输入时增量里可能混着别的命令的输出、玩家聊天、以及服务端自己的噪音。
 *      ⇒ 界面必须**如实标注**这一点（"以下是控制台的新增输出，不保证只属于这一条命令"）。
 *
 * ★ 那为什么还要做：它解决的是"**我能手动管一下**"（重启前存个档、看看到底怎么了、
 *   手动踢个人），而不是"我要一个精确的交互式 shell"。含糊其辞地把它做成看起来
 *   精确的终端，才是真正危险的地方。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 安全边界（改这个文件之前先读）
 * ══════════════════════════════════════════════════════════════════════════
 * 它是**完整控制台**（op 级别），所以：
 *   · 只从**本机网页**进（`api.mjs` 的 HTTP 服务只绑 127.0.0.1）；
 *   · **绝不进 QQ 工具面**（那条面的纪律是"只说话 + 只读"）——
 *     让 LLM 拿到服务器 op 权限，被诱导一次就是不可逆的。
 * 这个边界是**用户拍板**的，不是实现细节。
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { createRconClient } from './rcon.mjs'
import { SUPERVISE_DIR } from './supervise.mjs'

/** 等多久再取一次日志（第一次取样前）—— 命令的效果不是立刻写进日志的。 */
export const DEFAULT_SETTLE_MS = 400

/**
 * 控制台日志的路径（与 `supervise.mjs` 的 `logFileFor` **同一套命名**）。
 *
 * ★ 不 import 那个函数是因为它挂在 `createSupervisor()` 的闭包里（要 workspace）。
 *   命名规则只有这一行，两处必须一致 —— 有断言盯着（`verify-servers.mjs`）。
 */
export function consoleLogPath(workspace, serverId) {
  return join(String(workspace ?? ''), SUPERVISE_DIR, `${String(serverId).replace(/[^a-zA-Z0-9_.-]/g, '_')}.console.log`)
}

/**
 * 读日志**增量**（从 `fromByte` 之后的新内容）。
 *
 * ★ 按**字节**偏移读，不按行：服务端可能正在写一行（写到一半），按行读会把它截断。
 * ★ 返回 `nextByte` 供下次接着读；文件被轮转/截断（变小）时**从头读**并如实标注 ——
 *   否则偏移会指向一个不存在的位置，表现是"控制台永远不再更新"。
 *
 * @returns {{text: string, nextByte: number, rotated: boolean}}
 */
export function readLogDelta(file, fromByte = 0, maxBytes = 64 * 1024) {
  if (!file || !existsSync(file)) return { text: '', nextByte: 0, rotated: false }
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return { text: '', nextByte: fromByte, rotated: false }
  }
  const rotated = size < fromByte
  const start = rotated ? 0 : fromByte
  if (size <= start) return { text: '', nextByte: size, rotated }
  // 只读尾部 maxBytes（控制台可能刷得很快，读整份会爆内存）
  const begin = Math.max(start, size - maxBytes)
  const want = size - begin
  let fd = null
  try {
    fd = openSync(file, 'r')
    // ★ 真正**按偏移读**那一段（`position` 参数），不把整个文件读进来再切 ——
    //   模组服的控制台日志能长到几十 MB，读整份是没必要的开销。
    const buf = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, begin + got)
      if (n <= 0) break
      got += n
    }
    let text = buf.subarray(0, got).toString('utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return { text, nextByte: size, rotated }
  } catch {
    return { text: '', nextByte: size, rotated }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 无所谓 */
      }
    }
  }
}

/**
 * 跑一条控制台命令，并把它引起的**日志增量**带回来。
 *
 * ★ 永不抛：失败如实返回 `{ok:false, text}`（增强路径，AGENT.md 第 9 条）。
 * ★ `password` 绝不进返回文本（照 `rcon.mjs` 的纪律，有断言盯着）。
 *
 * @param {object} o
 * @param {object} o.server   配置里那一台（要 host/rconPort/password）
 * @param {string} o.command  要执行的命令（**原样**送给服务端）
 * @param {string} o.workspace 工作区（用来定位控制台日志）
 * @param {Function} [o.clientFor] 可注入的 RCON 客户端工厂（测试用）
 * @param {Function} [o.sleep]     可注入的等待（测试用；默认真等）
 * @param {number} [o.settleMs]    发完命令等多久再取日志
 */
export async function runConsoleCommand({ server = {}, command = '', workspace = '', clientFor = null, sleep = null, settleMs = DEFAULT_SETTLE_MS } = {}) {
  const cmd = String(command ?? '').trim()
  if (!cmd) return { ok: false, why: '命令是空的' }
  if (!server.password) {
    return { ok: false, why: '这台没配 RCON 密码 —— 没有命令通道，无从执行（去 config.json 里填 password）' }
  }
  const logFile = consoleLogPath(workspace, server.id)
  const before = (() => {
    try {
      return existsSync(logFile) ? statSync(logFile).size : 0
    } catch {
      return 0
    }
  })()

  const make =
    typeof clientFor === 'function'
      ? clientFor
      : (s) => createRconClient({ host: s.host ?? '127.0.0.1', port: s.rconPort ?? 25575, password: s.password, log: () => {} })
  const client = make(server)
  const nap = typeof sleep === 'function' ? sleep : (ms) => new Promise((res) => setTimeout(res, ms))

  let sent = null
  try {
    const conn = await client.connect()
    if (!conn.ok) {
      return { ok: false, layer: conn.layer, why: conn.text ?? '连不上 RCON' }
    }
    const r = await client.exec(cmd)
    // ★ 应答为空**不算失败**（实测：很多命令就是不回话）——
    //   所以这里记下 reply，但 ok 只表示"命令已送达"。
    sent = { ok: Boolean(r?.ok), reply: String(r?.body ?? ''), layer: r?.layer, text: r?.text }
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error) }
  } finally {
    try {
      client.close()
    } catch {
      /* 无所谓 */
    }
  }

  if (!sent?.ok) {
    return { ok: false, layer: sent?.layer, why: sent?.text ?? '命令没发出去' }
  }

  // 等一会儿让服务端把效果写进日志，再取增量
  await nap(settleMs)
  const delta = readLogDelta(logFile, before)
  return {
    ok: true,
    command: cmd,
    /** RCON 的应答（常常是空串 —— 见文件头那条实测事实） */
    reply: sent.reply,
    /** 控制台日志的新增片段（**不保证只属于这一条命令**） */
    output: delta.text,
    nextByte: delta.nextByte,
    rotated: delta.rotated,
    /** 界面必须原样显示这句（不许把它做成看起来精确的终端） */
    caveat: '以下是控制台的新增输出，**不保证只属于这一条命令**（并发输入、玩家聊天、服务端自身日志都会混进来）。',
  }
}
