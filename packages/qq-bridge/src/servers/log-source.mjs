/**
 * 游戏内事件源：读服务端控制台输出，解析出**聊天 / 玩家进出**（0.3.2 P3）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 最要紧的一件事实：**那个文件的编码不是 UTF-8**（真机实测）
 * ══════════════════════════════════════════════════════════════════════════
 * 真机取证（2026-10-04，Forge 1.20.1-47.3.0 + Windows 中文版 + JDK 17）：
 * `say 夹具-测试消息` 落进 `forge1.console.log` 的字节是
 *
 *     ... 5b52636f6e5d20 bcd0bedf2d b2e2cad4cffbcfa2 0d0a
 *                      └───── 这一段按 **GBK** 才是「夹具-测试消息」
 *
 * 按 UTF-8 解码得到的是**替换字符**（坏），按 GBK 解码完全正确。
 * 原因：Windows 中文版 JVM 默认 `file.encoding=GBK`，而 P2 把 stdout **原样重定向**
 * 进那个文件 ⇒ 文件里就是 GBK 字节。
 *
 * ∴ **任何按 UTF-8 读它的代码在真机上一个中文字都读不出来**。
 *   本模块因此有一层**解码回退**（先按 UTF-8 严格解，出现替换字符再按 GBK 重解）。
 *   ⚠️ 而"用 UTF-8 夹具测 UTF-8 解码"会让这一层全绿、真机全废 ——
 *   所以夹具（`mocks/fixtures/chat-dialects.mjs`）里的中文是**真 GBK 字节**。
 *
 * ── 为什么不继承 P2 的 `readLogDelta` ───────────────────────────────────────
 * 它是"给我一段文本"（按 UTF-8 解），而这里要的是**按行 + 按字节游标 + 编码回退**。
 * 两件事混在一起会互相牵制，所以本模块自己读，并**只依赖它的字节游标语义**。
 *
 * ── 方言纪律（与 `monitor.mjs` 同一条）────────────────────────────────────
 * 只认**最稳的那几种形状**，认不出就 `null`（**绝不猜**）：
 *   · 聊天：正文里第一个 `<名> 文本`（名里不能有空白 —— Java 用户名本身也不许有）
 *   · 进出：`X joined the game` / `X left the game` / `X lost connection: …`
 *   · 死亡与成就**不是**聊天，但能证明"这个人在线"（`onlineOnly`）
 *   ★ `[Not Secure]`（1.19+ 未签名聊天）先剥掉再判；
 *   ★ `[Rcon]` / `[Server]` 开头的**一定不是**玩家聊天（那是我们自己发出去的），
 *     这条是防止"把机器人的话当成玩家说的话"（会把自环当成对话）。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 事件台账的位置（与 `servers/loop.mjs` 同目录；它管"服务器状态"，这里管"游戏内对话"）。 */
export const CHAT_CURSOR_REL = 'runtime/servers'
/** 一次最多处理多少字节（控制台刷得快时不要一次读爆内存）。 */
export const MAX_CHUNK_BYTES = 256 * 1024

// ── 解码 ─────────────────────────────────────────────────────────────────

const utf8Strict = new TextDecoder('utf-8', { fatal: false })
let gbkDecoder = null
try {
  gbkDecoder = new TextDecoder('gbk', { fatal: false })
} catch {
  gbkDecoder = null // 没有 ICU 的 Node 上拿不到 gbk ⇒ 下面会如实降级
}

/**
 * 把一段字节解成文本（**带回退**）。
 *
 * 判据是"UTF-8 解得出来吗"：中文 GBK 字节按 UTF-8 解会大量出现 U+FFFD。
 * ★ 只在**出现替换字符**时才回退（不是"有非 ASCII 就用 GBK"）——
 *   否则一段正常的 UTF-8 中文会被错解成乱码（反过来踩同一个坑）。
 *
 * @param {Buffer} buf
 * @param {'auto'|'utf8'|'gbk'} mode
 * @returns {{text: string, encoding: 'utf8'|'gbk'}}
 */
export function decodeConsoleBytes(buf, mode = 'auto') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '')
  if (mode === 'gbk') return { text: gbkDecoder ? gbkDecoder.decode(b) : b.toString('utf8'), encoding: 'gbk' }
  const asUtf8 = utf8Strict.decode(b)
  if (mode === 'utf8') return { text: asUtf8, encoding: 'utf8' }
  if (!asUtf8.includes('\uFFFD')) return { text: asUtf8, encoding: 'utf8' }
  if (!gbkDecoder) return { text: asUtf8, encoding: 'utf8' } // 拿不到 GBK 解码器 ⇒ 如实降级
  return { text: gbkDecoder.decode(b), encoding: 'gbk' }
}

// ── 解析 ─────────────────────────────────────────────────────────────────

/**
 * 剥掉日志前缀，只留"这一行到底在说什么"。
 *
 * ★★★ 判据必须**锚定在最前面**，不能像第一版那样"取最后一个 `]: `" ——
 *   因为**正文里完全可能出现 `]: `**。实测：`<Steve> 他发了 ]: 这个` 用"取最后一个"
 *   会被切成 `这个`（半句没了，而且看起来"解析成功"）。
 *
 * 认这两种前缀形状（都是锚定在行首、逐字取自真机/原版）：
 *   Forge / 原版：`[11:42:53] [Server thread/INFO] [minecraft/MinecraftServer]: <正文>`
 *   Fabric/NeoForge：`[11:42:53] [Server thread/INFO] (MinecraftServer): <正文>`
 *   Paper：线程名可能是 `Async Chat Thread - #0` ⇒ 线程段本身不做形状限制
 *
 * ★ 认不出前缀 ⇒ **原样返回**（宁可让调用方看到一个带前缀的怪行，也不要把正文切掉）。
 */
export function stripLogPrefix(rawLine) {
  const s = String(rawLine ?? '').replace(/\r$/, '')
  // 行首必须是 `[时间]`（这既是"这是日志行"的证据，也保证不会切到正文里的 `]: `）
  const m = /^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]\s+\[[^\]]+\]\s+(?:\[[^\]]+\]|\([^)]+\)):\s?/.exec(s)
  if (m) return s.slice(m[0].length)
  return s
}

/** 机器人自己的回话前缀（`/say` 走 RCON 时服务端会这样记）。 */
const SELF_RE = /^(?:\[Not Secure\]\s*)?\[(Rcon|Server)\]\s*/

const CHAT_RE = /^(?:\[Not Secure\]\s*)?<([^\s<>]+)>\s*(.*)$/
const JOIN_RE = /^([^\s]+) joined the game$/
const LEAVE_RE = /^([^\s]+) (?:left the game|lost connection:.*)$/
/**
 * ★★★ **「名 → UUID」的真机形状**（这是 P3 绑定的关键来源，真机逐字取证）：
 *
 *     [11:56:16] [User Authenticator #1/INFO] [minecraft/ServerLoginPacketListenerImpl]:
 *                UUID of player YoCerin is 00000000-0000-4000-8000-000000000001
 *
 * ★ 为什么它比 `list uuids` 更好：**玩家一登录就写，不用他说话、也不用他还在线**。
 *   `list uuids` 只在"此刻在线"时才有（实测形状 `YoCerin (bbf13b2f-…)`），
 *   而绑定恰恰发生在一个刚进服的人身上 —— 那条日志比 RCON 更早、更可靠。
 * ★ 记录器名（`ServerLoginPacketListenerImpl`）在版本间可能微调 ⇒ 只锚定
 *   `UUID of player <名> is <uuid>` 这一段（它在 1.8~1.21 都是这个措辞）。
 */
const UUID_RE = /^UUID of player ([^\s]+) is ([0-9a-fA-F-]{32,36})$/
const DEATH_RE = /^([^\s]+) (?:was |were |drowned|blew up|burned|fell |hit the ground|tried to swim|withered|starved|suffocated|went off with a bang|experienced kinetic energy|froze to death|was killed)/

/**
 * 解析**一行**控制台输出。
 *
 * @returns {null | {kind:'chat', name:string, text:string}
 *                | {kind:'join', name:string}
 *                | {kind:'leave', name:string}
 *                | {kind:'onlineOnly', name:string, why:string}}
 *         认不出 ⇒ `null`（**绝不猜**）
 */
export function parseConsoleLine(rawLine) {
  const body = stripLogPrefix(rawLine).trim()
  if (!body) return null
  // ★ 我们自己发的话（`[Rcon]` / `[Server]`）**一定不是**玩家聊天 ——
  //   不挡这条的话，机器人在游戏里说的话会被当成玩家说的话，形成自环。
  //   （自话**不产出任何事件**：它的用处只是"证明控制台还活着"，而那是 P2 的事。）
  if (SELF_RE.test(body)) return null

  const chat = CHAT_RE.exec(body)
  if (chat) return { kind: 'chat', name: chat[1], text: String(chat[2] ?? '').trim() }

  const join = JOIN_RE.exec(body)
  if (join) return { kind: 'join', name: join[1] }

  // ★★★ 「名 → UUID」（玩家一登录就写）—— P3 的绑定靠它，别漏
  const uuid = UUID_RE.exec(body)
  if (uuid) return { kind: 'uuid', name: uuid[1], uuid: uuid[2].toLowerCase() }

  const leave = LEAVE_RE.exec(body)
  if (leave) return { kind: 'leave', name: leave[1] }

  // 死亡（能证明人在线，但不是聊天）
  const death = DEATH_RE.exec(body)
  if (death) return { kind: 'onlineOnly', name: death[1], why: 'death' }
  // 成就（同上）
  const adv = /^([^\s]+) has (?:made the advancement|reached the goal|completed the challenge) /.exec(body)
  if (adv) return { kind: 'onlineOnly', name: adv[1], why: 'advancement' }

  return null
}

// ── 按字节游标读 + 只吐完整行 ─────────────────────────────────────────────

/** 游标文件（记"上次读到第几字节"）—— **落盘**，否则桥接重启会重放一大堆旧聊天。 */
export function cursorPath(workspace, serverId) {
  const id = String(serverId ?? '').replace(/[^a-zA-Z0-9_.-]/g, '_')
  return join(String(workspace ?? ''), CHAT_CURSOR_REL, `${id}.chat-cursor.json`)
}

export function readCursor(workspace, serverId) {
  const p = cursorPath(workspace, serverId)
  try {
    if (!existsSync(p)) return 0
    const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    const n = Number(j?.byte)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

export function writeCursor(workspace, serverId, byte) {
  const p = cursorPath(workspace, serverId)
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ byte: Number(byte) || 0, at: Date.now() }) + '\n', 'utf8')
  } catch {
    /* 游标写不上只是"下次会重读" —— 不阻断对话 */
  }
}

/**
 * 从控制台日志里读出**自上次游标以来**的完整行，并解析成事件。
 *
 * ★★ 三条边界（都有断言）：
 *   ① **只吐完整行**：最后那段没有行尾的内容**留在缓冲区**（游标也只推进到它之前）——
 *      否则会把服务端正在写的一行截成半句吐出去；
 *   ② 文件**变小**（轮转/截断）⇒ 从头读（否则"永远不再更新"）；
 *   ③ 解析不出的行**跳过但不吞证据**（`unparsed` 计数如实带回来）。
 *
 * @returns {{events: object[], nextByte: number, encoding: string, unparsed: number, rotated: boolean}}
 */
export function readConsoleEvents({ workspace = '', serverId = 'srv', logFile = '', fromByte = null, encoding = 'auto', maxBytes = MAX_CHUNK_BYTES } = {}) {
  const file = String(logFile ?? '')
  const start0 = fromByte === null ? readCursor(workspace, serverId) : Number(fromByte) || 0
  if (!file || !existsSync(file)) return { events: [], nextByte: start0, encoding: 'utf8', unparsed: 0, rotated: false }
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return { events: [], nextByte: start0, encoding: 'utf8', unparsed: 0, rotated: false }
  }
  const rotated = size < start0
  const begin = rotated ? 0 : start0
  if (size <= begin) return { events: [], nextByte: size, encoding: 'utf8', unparsed: 0, rotated }

  // 只读尾部 maxBytes（控制台可能刷得很快）
  const readFrom = Math.max(begin, size - maxBytes)
  let buf = Buffer.alloc(0)
  let fd = null
  try {
    fd = openSync(file, 'r')
    const want = size - readFrom
    buf = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, readFrom + got)
      if (n <= 0) break
      got += n
    }
    buf = buf.subarray(0, got)
  } catch {
    return { events: [], nextByte: size, encoding: 'utf8', unparsed: 0, rotated }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 无所谓 */
      }
    }
  }

  // ★ 逐行切（按字节找 \n，**不按字符**）—— 这样多字节字符跨块也不会被切坏
  const events = []
  let unparsed = 0
  let encodingUsed = 'utf8'
  let cursor = readFrom
  let lineStart = 0
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0x0a) continue
    const rawLine = buf.subarray(lineStart, i) // 不含 \n
    const { text, encoding: enc } = decodeConsoleBytes(rawLine, encoding)
    encodingUsed = enc
    const ev = parseConsoleLine(text)
    if (ev) events.push(ev)
    else if (text.trim()) unparsed += 1
    cursor = readFrom + i + 1
    lineStart = i + 1
  }
  // 未完成的那一段**不推进游标**（下次接着读）
  return { events, nextByte: cursor, encoding: encodingUsed, unparsed, rotated }
}
