/**
 * 端口占用探测：判断"这个端口上有没有东西在监听"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（缺陷 4 的第三道防线）
 * ══════════════════════════════════════════════════════════════════════════
 * SnowLuma 以 `detached: true` 启动（有意：关掉桥接不该连带杀掉它），
 * 所以它一旦被重复启动，两个实例会**抢 3000/3001 端口与 QQ 登录态**，
 * 而且都不会自己退出。
 *
 * 已有的两道防线（① 探控制台 ② 用我们自己的 token 问 OneBot）设计是对的，
 * 但 **② 只在"对面接受我们的 token"时才管用**：如果 3000 上蹲着的是
 * 一个**别的**东西（另一个实例、或任何 HTTP 服务），它会用 401/403 回应，
 * 于是"端口有东西"这个事实被当成"没人在跑"。这时候再去 spawn 就晚了。
 *
 * 所以这里补一道**只看"有没有人应答"**的探测 —— 不关心授权、不关心是不是
 * SnowLuma。它的语义是：**端口被别人占着时，绝不闷头再起一个**。
 *
 * ★ 一个必须记住的事实：**bind 成功不等于端口空闲。**
 *   在 Windows 上，即使另一个进程正监听 `0.0.0.0:3000`，我们仍可能成功 bind
 *   `127.0.0.1:3000`（不同地址，主机允许分开绑）。所以"端口占用"要
 *   从"两次 bind 都失败"来判断，而不是反过来推断空闲。
 *
 * 本模块**只做 I/O**，不读配置、不写日志、不决定策略 —— 策略留在 snowluma.mjs。
 */

import { createServer } from 'node:http'
import { connect } from 'node:net'

/**
 * 端口是否"被别人占着"。
 *
 * 判定顺序（先易后难，且每一步都不会阻塞很久）：
 *   ① 先做一次 TCP 连接试。连上了 → 有人监听（**这条路最可靠**：
 *      它在"别人绑 0.0.0.0、我们试 127.0.0.1"的情况下也成立）。
 *   ② 连不上时再试 bind —— 能 bind 到 0.0.0.0 且能 bind 到 127.0.0.1
 *      才算空闲。两次都失败才算占用。
 *
 * @param {number} port
 * @param {object} [opts]
 * @param {string} [opts.host] 连接试用的地址，默认 127.0.0.1
 * @param {number} [opts.timeoutMs] 单步超时，默认 1200
 * @returns {Promise<{inUse: boolean, method: 'connect'|'bind'|'unknown', detail: string}>}
 */
export async function checkPortFree(port, { host = '127.0.0.1', timeoutMs = 1200 } = {}) {
  const p = Number(port)
  if (!Number.isInteger(p) || p <= 0) {
    return { inUse: false, method: 'unknown', detail: `端口号无效（${port}），跳过检查` }
  }

  // ① TCP 连接试：连上了就说明有人在听 —— 这是最直接也最可靠的判据
  const connected = await canConnect(p, { host, timeoutMs })
  if (connected) {
    return { inUse: true, method: 'connect', detail: `${host}:${p} 有东西在监听（TCP 连接成功）` }
  }

  // ② bind 试：两次都能绑才算空闲
  const canBindAny = await canBind(p, '0.0.0.0')
  if (canBindAny.ok) {
    return { inUse: false, method: 'bind', detail: `0.0.0.0:${p} 可绑定（空闲）` }
  }
  const canBindLoopback = await canBind(p, '127.0.0.1')
  if (canBindLoopback.ok) {
    return { inUse: false, method: 'bind', detail: `127.0.0.1:${p} 可绑定（空闲）` }
  }
  return {
    inUse: true,
    method: 'bind',
    detail: `${p} 两次绑定都失败（${canBindAny.error ?? '未知'}），说明被占用`,
  }
}

/** 能不能连上（有人在听就返回 true）。 */
function canConnect(port, { host, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* 已经关了 */
      }
      resolve(ok)
    }
    const socket = connect({ port, host })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 能不能 bind（能绑就返回 true）。 */
function canBind(port, host) {
  return new Promise((resolve) => {
    const srv = createServer()
    let settled = false
    const done = (ok, error) => {
      if (settled) return
      settled = true
      try {
        srv.close()
      } catch {
        /* 没在监听 */
      }
      resolve({ ok, error })
    }
    srv.once('error', (e) => done(false, e?.code ?? e?.message))
    srv.listen(port, host, () => done(true))
  })
}

/**
 * 往一个地址发一次 GET，**只看有没有应答**。
 *
 * 为什么单独写而不是复用 `probeConsole`：那个是探 SnowLuma 的 Web 控制台
 * （要判断 title、要区分"端口被别的程序占了"）。这里只要一个更弱的结论：
 * **这个端口上有没有 HTTP 服务在应答** —— 401/403 也算"有"。
 *
 * @returns {Promise<{answered: boolean, status: number|null, error: string|null}>}
 */
export async function probeHttpAnswered(url, timeoutMs = 1500) {
  const target = String(url ?? '').trim()
  if (!target) return { answered: false, status: null, error: '没有地址' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(200, timeoutMs))
  try {
    const res = await fetch(target, { method: 'GET', signal: controller.signal })
    // ★ 到这里就说明**有 HTTP 服务在应答**，401/403 同样是"有"
    return { answered: true, status: res.status, error: null }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return {
      answered: false,
      status: null,
      error: aborted ? `超时（${timeoutMs}ms）` : (error?.message ?? String(error)),
    }
  } finally {
    clearTimeout(timer)
  }
}
