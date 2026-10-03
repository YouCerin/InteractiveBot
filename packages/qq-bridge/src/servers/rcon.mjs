/**
 * RCON 客户端：**自己实现协议，不用 npm 包**（0.3.2 P2）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须自实现
 * ══════════════════════════════════════════════════════════════════════════
 *   ① 项目第 5 条纪律：**运行期依赖不走 npm**（依赖由 `setup.mjs` 收进 `vendor/`，
 *      否则包搬走就废）。而 RCON 协议本身极小（4 类包），自实现比引依赖划算得多。
 *   ② 这类依赖在"受限沙箱里真跑一次"的场景下最容易变成**别人机器上的
 *      `ERR_MODULE_NOT_FOUND`** —— 而那种失败只在那台机器上出现。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 协议要点（Source RCON，Minecraft 用的是它）
 * ══════════════════════════════════════════════════════════════════════════
 *   包 = [长度:4 LE][请求号:4 LE][类型:4 LE][正文][0x00][0x00]
 *         `长度` 数的是**它自己之后**的字节数（即 请求号+类型+正文+两个 0x00）。
 *   类型：3 = 登录（AUTH）、2 = 执行命令（EXECCOMMAND）、
 *         0 = 应答正文（RESPONSE_VALUE）、2 也用于**应答**（应答的 id 与请求一致）
 *
 *   ★★ **登录有个反直觉的约定**（这是最容易判错的一处）：服务端会先回一个
 *      **空的 RESPONSE_VALUE**，再回 **AUTH_RESPONSE**：
 *        · 回 `id == 请求号`  → **成功**
 *        · 回 `id == -1`     → **密码错**
 *      所以"收到包"不等于"登录成功" —— 必须看 **id**。实测过：把第一个包当成功，
 *      症状是"登录看起来成功、第一条命令永远超时"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 密码绝不进日志/错误信息（与 `credentials.mjs` 同一条纪律）
 * ══════════════════════════════════════════════════════════════════════════
 *   这个模块**不记日志、不抛含密码的异常**：所有对外文案里只有"密码被拒"
 *   这种结论，没有任何回显。`mocks/verify-servers.mjs` 里有一条断言逐字检查
 *   失败理由里不含密码。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 错误分类（照 `transport.mjs` 的形状：`{layer, retryable}`）
 * ══════════════════════════════════════════════════════════════════════════
 *   `layer` 说明该去哪一层排查，`retryable` 说明重试有没有意义 ——
 *   **不猜**：认不出的错误归 `protocol`/`unknown` 且 **不标可重试**
 *   （猜错方向会让"其实对方已经收到了"的操作再发一遍，与 H9 同一条理由）。
 */

import { connect } from 'node:net'

/** 包类型。 */
export const PACKET = {
  RESPONSE: 0,
  EXEC: 2,
  AUTH: 3,
}

/** 单包正文上限（保守值：Source RCON 的经典上限是 4096，Minecraft 常见的实现给到 4096~8192）。 */
export const MAX_PAYLOAD_BYTES = 4096

/** 认领请求号的起点（0 被 AUTH 失败的 -1 逻辑占用，从 1 开始更省心）。 */
let requestSeq = 0
function nextId() {
  requestSeq += 1
  if (requestSeq > 2_000_000_000) requestSeq = 1
  return requestSeq
}

// ══════════════════════════════════════════════════════════════════════════
// 编解码（纯函数，可离线测）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 编码一个包。
 *
 * @param {{id: number, type: number, body?: string}} o
 * @returns {Buffer}
 */
export function encodePacket({ id, type, body = '' } = {}) {
  const text = Buffer.from(String(body ?? ''), 'utf8')
  // 长度 = 请求号(4) + 类型(4) + 正文 + 两个 0x00
  const len = 4 + 4 + text.length + 2
  const buf = Buffer.allocUnsafe(4 + len)
  buf.writeInt32LE(len, 0)
  buf.writeInt32LE(Number(id) | 0, 4)
  buf.writeInt32LE(Number(type) | 0, 8)
  text.copy(buf, 12)
  buf.writeUInt8(0, 12 + text.length)
  buf.writeUInt8(0, 13 + text.length)
  return buf
}

/**
 * 从缓冲区里**尽量多**地取出完整包。
 *
 * ★ 这是"粘包/分包"的唯一处理点：TCP 是字节流，一次 `data` 事件可能给半个包、
 *   也可能给三个半。所以状态机只有一个：**攒着，够了就切，不够就等**。
 * ★ 认不出的长度（< 10 或 > 上限）→ **报错返回**，让上层断开重连：
 *   继续按错误长度切只会越切越乱（而且看起来像"服务端乱回话"）。
 *
 * @param {Buffer} buf
 * @returns {{packets: {id:number,type:number,body:string}[], rest: Buffer, error?: string}}
 */
export function decodePackets(buf) {
  const packets = []
  let offset = 0
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? [])
  while (src.length - offset >= 4) {
    const len = src.readInt32LE(offset)
    if (!Number.isFinite(len) || len < 10 || len > MAX_PAYLOAD_BYTES + 16) {
      return { packets, rest: src.slice(offset), error: `包长度不合理（${len}）—— 连接可能已经错位` }
    }
    if (src.length - offset - 4 < len) break // 还没到齐
    const id = src.readInt32LE(offset + 4)
    const type = src.readInt32LE(offset + 8)
    const bodyBytes = src.slice(offset + 12, offset + 4 + len - 2)
    packets.push({ id, type, body: bodyBytes.toString('utf8') })
    offset += 4 + len
  }
  return { packets, rest: src.slice(offset) }
}

/**
 * 把 RCON 的错误分类成 `{layer, retryable, text}`。
 *
 * 判据顺序（**顺序就是规则**）：先看是不是我们自己的判定（密码/协议），
 * 再看网络层错误码。`layer` 直接告诉使用者"去查什么"。
 *
 * @param {unknown} error
 * @param {{stage?: 'connect'|'auth'|'exec'}} [ctx]
 */
export function classifyRconError(error, { stage = 'connect' } = {}) {
  const code = String(error?.code ?? '')
  const msg = String(error?.message ?? error ?? '')
  const low = msg.toLowerCase()

  // ★★ 超时**永远是可重试的**，不管卡在哪一步 —— 它不代表"我们做错了什么"。
  //   这一条必须排在 stage==='auth' 的分支**之前**：否则"服务端收到登录包但没回"
  //   会被说成"密码被拒、不许重试"，而真相只是它慢/没起来（实测抓到的分类错误）。
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || low.includes('timeout') || low.includes('超时')) {
    const where = stage === 'auth' ? '登录' : stage === 'exec' ? '命令' : '连接'
    return {
      layer: 'timeout',
      retryable: true,
      text:
        `RCON ${where}超时。模组服启动/卡顿时很常见 —— ` +
        '也可能是防火墙只放行了游戏端口、没放行 RCON 端口。',
    }
  }

  // ── 我们自己的判定（不带任何回显）──
  if (stage === 'auth') {
    return {
      layer: 'auth',
      retryable: false,
      text: 'RCON 密码被拒（服务端回了 -1）。检查 server.properties 里的 rcon.password 与这里填的是不是同一个。',
    }
  }
  if (/密码|auth/i.test(msg)) {
    return { layer: 'auth', retryable: false, text: 'RCON 登录没通过。检查 rcon.password。' }
  }

  // ── 网络层 ──
  if (code === 'ECONNREFUSED' || low.includes('econnrefused')) {
    return {
      layer: 'network',
      retryable: true,
      text: '连不上那个 RCON 端口（端口上没东西在听）。① 服务端开了吗；② server.properties 里 enable-rcon=true 吗；③ 端口对不对（默认 25575）；④ 服务端刚起时要等它加载完。',
    }
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return { layer: 'network', retryable: true, text: `这台机器到不了那个地址（${code}）。检查地址与网络。` }
  }
  if (code === 'ECONNRESET' || low.includes('econnreset')) {
    return { layer: 'network', retryable: true, text: '连接被对面断开。常见原因是服务端正在重启/关闭。' }
  }
  if (code === 'EACCES') {
    return { layer: 'network', retryable: false, text: '被本机防火墙/权限拦住了（EACCES）。' }
  }
  if (/包长度不合理/.test(msg)) {
    return { layer: 'protocol', retryable: false, text: msg }
  }
  // ★ 认不出的一律**不标可重试**（猜错方向会让"对方其实已经收到了"的操作再发一遍）
  return { layer: 'unknown', retryable: false, text: `RCON 出错：${msg || '未知原因'}` }
}

// ══════════════════════════════════════════════════════════════════════════
// 客户端
// ══════════════════════════════════════════════════════════════════════════

/** 单条命令的默认超时（模组服上 `list` 可能慢，但再久就该当"卡住"）。 */
export const DEFAULT_EXEC_TIMEOUT_MS = 8000
/** 连接+登录的默认超时。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 6000
/**
 * 「应答收齐」的判据是**流静默**这么长时间（见 `handleData` 里那段注释）。
 *
 * ★ 为什么是 60ms 而不是 0：包与包之间哪怕只隔一次事件循环，也应该拼起来；
 *   而 60ms 远小于任何人类的交互间隔，不会让"回话"看起来变慢。
 * ★ 调大它的唯一理由是本机/网络特别抖 —— 但那时该修的是网络，不是这个值。
 */
export const DEFAULT_REPLY_IDLE_MS = 60

/**
 * 造一个 RCON 客户端。
 *
 * 设计取舍（改动前先读）：
 *   · **一次一条命令**（串行队列）：RCON 没有"响应配对"以外的多路复用能力，
 *     而服务端的应答可能与发出的顺序不一致；串行是唯一不会配错的方式。
 *   · **不自动重连**：重连由**监测状态机**决定（它才知道"现在是 down 还是 up"）。
 *     客户端自己偷偷重连会让状态机看不到"中间断过"。
 *   · **`exec` 永不抛**：一律返回 `{ok, body?, error?, layer?, retryable?}` ——
 *     上层（状态机）要能对失败分类，而不是去 catch 异常。
 *
 * @param {{host?: string, port?: number, password?: string, log?: Function,
 *          connectTimeoutMs?: number, execTimeoutMs?: number}} opts
 */
export function createRconClient({
  host = '127.0.0.1',
  port = 25575,
  password = '',
  log = () => {},
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  execTimeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  idleMs = DEFAULT_REPLY_IDLE_MS,
} = {}) {
  const target = `${String(host)}:${Number(port)}`
  let socket = null
  let buffer = Buffer.alloc(0)
  let authed = false
  let closed = false
  /** 串行队列的尾巴（保证"一次一条命令"）。 */
  let queue = Promise.resolve()
  /** 当前在等应答的那一条：`{id, resolve, timer, chunks}`。 */
  let pending = null

  function settlePending(result) {
    if (!pending) return
    const p = pending
    pending = null
    if (p.timer) clearTimeout(p.timer)
    if (p.idleTimer) clearTimeout(p.idleTimer)
    p.resolve(result)
  }

  function teardown(reason) {
    const wasAuthed = authed
    authed = false
    const sock = socket
    socket = null
    buffer = Buffer.alloc(0)
    if (sock) {
      try {
        sock.removeAllListeners()
        sock.destroy()
      } catch {
        /* 已经没了 */
      }
    }
    // 等在等的那一条**立刻**得到结论（不许让它悬着 —— 悬着就是"卡住"那种失败形状）
    if (pending) {
      settlePending({
        ok: false,
        ...classifyRconError({ code: 'ECONNRESET', message: reason ?? '连接断开' }),
      })
    }
    return wasAuthed
  }

  function handleData(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    const { packets, rest, error } = decodePackets(buffer)
    buffer = rest
    if (error) {
      log(`⚠️ [rcon] ${target} ${error}（断开重来）`)
      teardown(error)
      return
    }
    for (const p of packets) {
      if (!pending) continue
      // 应答的 id 必须对得上（对不上的包丢掉 —— RCON 没有"多路复用"，这是错位的信号）
      if (p.id !== pending.id && p.id !== -1) continue
      if (p.type === PACKET.RESPONSE) pending.chunks.push(p.body)
      else if (p.type === PACKET.AUTH) {
        // 登录应答：**id 是判据**（见文件头那段）
        pending.authOk = p.id !== -1 && p.id === pending.id
        pending.chunks.push(p.body)
      } else {
        // 其他类型（含 EXEC 的应答用 type=2 的实现）：也当正文收下
        pending.chunks.push(p.body)
      }
      // ★★ 收齐的判据不是"收到了包"，而是**流静默**。
      //
      //   为什么（实测抓到的缺陷）：RCON **没有"这条应答结束了"的标记** ——
      //   服务端可以把同一个应答拆成任意多个包发。第一版"收到第一个非空包就结算"，
      //   于是"应答被拆成两个包"时**只拿到前半句**，而症状看起来完全合理
      //   （"服务端只回了这么多"）。现在：每次收到正文就重置一个**空闲计时器**，
      //   静默 `idleMs` 之后才算收齐 —— 多包能拼全，卡住的连接也不会悬着
      //   （外层还有 execTimeoutMs 兜底）。
      if (pending.kind === 'auth') {
        if (pending.authOk !== undefined) finishPending('auth')
      } else {
        scheduleIdleFinish()
      }
    }
  }

  function scheduleIdleFinish() {
    if (!pending || pending.kind === 'auth') return
    if (pending.idleTimer) clearTimeout(pending.idleTimer)
    pending.idleTimer = setTimeout(() => finishPending('idle'), idleMs)
  }

  function finishPending() {
    if (!pending) return
    const p = pending
    const body = p.chunks.join('')
    if (p.kind === 'auth') {
      if (p.authOk === true) {
        authed = true
        settlePending({ ok: true, body: '' })
      } else {
        settlePending({ ok: false, ...classifyRconError(new Error('密码被拒'), { stage: 'auth' }) })
      }
      return
    }
    settlePending({ ok: true, body })
  }

  /** 建链 + 登录。`ok:false` 时带分类好的原因。 */
  function open() {
    return new Promise((resolve) => {
      closed = false
      let settled = false
      const done = (r) => {
        if (settled) return
        settled = true
        resolve(r)
      }
      let sock
      try {
        sock = connect({ port: Number(port), host: String(host) })
      } catch (error) {
        return done({ ok: false, ...classifyRconError(error, { stage: 'connect' }) })
      }
      socket = sock
      sock.setNoDelay?.(true)
      const timer = setTimeout(() => {
        done({ ok: false, ...classifyRconError(new Error('连接超时'), { stage: 'connect' }) })
        teardown('连接超时')
      }, connectTimeoutMs)

      sock.once('connect', () => {
        // ── 登录 ──
        const id = nextId()
        pending = { id, kind: 'auth', chunks: [], authOk: undefined, resolve: null, timer: null }
        pending.resolve = (r) => {
          clearTimeout(timer)
          done(r)
        }
        pending.timer = setTimeout(() => {
          settlePending({ ok: false, ...classifyRconError(new Error('登录超时'), { stage: 'auth' }) })
        }, connectTimeoutMs)
        try {
          sock.write(encodePacket({ id, type: PACKET.AUTH, body: password }))
        } catch (error) {
          settlePending({ ok: false, ...classifyRconError(error, { stage: 'auth' }) })
        }
      })
      sock.on('data', handleData)
      sock.once('error', (error) => {
        clearTimeout(timer)
        const wasAuthed = authed
        teardown(error?.message ?? 'socket error')
        done({
          ok: false,
          ...classifyRconError(error, { stage: authed || wasAuthed ? 'exec' : 'connect' }),
        })
      })
      sock.once('close', () => {
        clearTimeout(timer)
        const wasAuthed = authed
        teardown('连接被关闭')
        if (!settled) {
          done({ ok: false, ...classifyRconError(new Error('连接被关闭'), { stage: wasAuthed ? 'exec' : 'connect' }) })
        }
      })
    })
  }

  /** 一次 exec 的内部实现（**只在队列里跑**）。 */
  function execOnce(command) {
    return new Promise((resolve) => {
      if (!socket || !authed) {
        return resolve({ ok: false, ...classifyRconError(new Error('还没登录'), { stage: 'connect' }) })
      }
      const id = nextId()
      pending = {
        id,
        kind: 'exec',
        chunks: [],
        resolve,
        idleTimer: null,
        timer: setTimeout(() => {
          // ★ 超时**不**自动重发（可能对方已经执行了）—— 如实回一个可重试的分类，由上层决定
          settlePending({ ok: false, ...classifyRconError(new Error('执行超时'), { stage: 'exec' }) })
        }, execTimeoutMs),
      }
      try {
        socket.write(encodePacket({ id, type: PACKET.EXEC, body: command }))
      } catch (error) {
        settlePending({ ok: false, ...classifyRconError(error, { stage: 'exec' }) })
      }
    })
  }

  return {
    target,
    /** 建链 + 登录。 */
    async connect() {
      if (socket && authed) return { ok: true, body: '' }
      if (socket) teardown('重新连接')
      return open()
    },
    /**
     * 跑一条命令。**串行**（一次一条），**永不抛**。
     * @returns {Promise<{ok: boolean, body?: string, layer?: string, retryable?: boolean, text?: string}>}
     */
    async exec(command) {
      const cmd = String(command ?? '').trim()
      if (!cmd) return { ok: false, layer: 'usage', retryable: false, text: '命令是空的' }
      if (cmd.length > 1200) {
        // 一条 RCON 命令不可能这么长；写错时早报比"服务端默默截断"好
        return { ok: false, layer: 'usage', retryable: false, text: `命令太长（${cmd.length} 字符）—— 大概率是参数拼错了` }
      }
      const run = queue.then(() => execOnce(cmd))
      // 队列尾巴：无论成败都继续往下走（否则一条失败会把后面全卡死）
      queue = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },
    /** 主动断开（幂等）。 */
    close() {
      closed = true
      teardown('主动关闭')
      queue = Promise.resolve()
      return { ok: true }
    },
    /** 供状态机与巡检读的事实（**不含密码**）。 */
    state() {
      return { target, host: String(host), port: Number(port), connected: Boolean(socket), authed, closed }
    },
  }
}
