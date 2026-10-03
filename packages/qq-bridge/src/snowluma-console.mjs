/**
 * 把 SnowLuma 的**控制台输出**落盘，并把"首次登录凭据在哪里"说出来。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须有它（2026-10-03 实机测试报告 BUG-3）
 * ══════════════════════════════════════════════════════════════════════════
 * 三条**各自都合理**的决定叠在一起，正好把首次登录凭据吞掉了：
 *
 *   ① SnowLuma 把引导密码**只写 stdout**，不写它自己的日志文件；
 *   ② 桥接拉起它时用 `stdio: 'ignore'` —— 凭据在这里被丢掉；
 *   ③ 桥接**故意只读 SnowLuma 的日志文件**（`snowluma-log.mjs`），
 *      而那条路恰好是唯一**没有**凭据的。
 *
 * 后果不是"少一条日志"，而是**首次配置被卡死**：网页端 5099 能打开，
 * 但登录页要一个从未展示过的密码 —— 对非技术用户来说，"重新下载一份 SnowLuma
 * / 重新注册一遍"就是唯一看得见的路。报告实测里用户就是这么做的。
 *
 * ── 关于旧注释里"接管 stdout 会 GBK 乱码"这条理由 ────────────────────────
 * 它是**用 pipe 测出来的**，不能推广到文件句柄。本机实测（Node 子进程，
 * 中文与凭据行同时写 stdout/stderr，父进程用 `stdio: ['ignore', fd, fd]` 落盘）：
 *
 *     stdout: 00:25:52 OK [200000001] [Event] 私聊 [无忘远霞(100000001)]: 确认一下群聊开关打开了吗
 *     stderr: WARN [WebUI.Auth] initial credentials: user=admin password=<16 位十六进制>
 *
 *     → 179 字节，**UTF-8 完全正确**（无 U+FFFD，中文逐字对得上）
 *
 * 所以现在用**文件句柄**（不是 pipe）。这也顺带保住了原来的顾虑：
 * 老注释担心的是"管道一端消失后子进程写日志会 EPIPE 而挂掉"，
 * 而文件句柄没有这个问题（文件比父进程活得久）。
 *
 * ── 为什么不把密码本身回显到界面 ─────────────────────────────────────────
 * 这是**有意的**：这里只告诉用户"去哪个文件、怎么找"，不把密码复制到
 * 日志、接口响应或界面里。少一份副本就少一个泄漏面，而用户找得到它。
 * 因此本模块的所有返回值**都不含密码值**（扫描结果只有"有没有 / 用户名"）。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** SnowLuma 控制台输出的落盘位置（在**本包**的 logs 下，与桥接日志同目录）。 */
export function consoleLogPath(pkgRoot) {
  return join(pkgRoot, 'logs', 'snowluma-console.log')
}

/**
 * 打开控制台日志文件并返回可传给 `spawn` 的 fd。
 *
 * **不抛异常**：拿不到就退回 `'ignore'`（"看不到日志"比"起不来"轻得多）。
 *
 * @returns {{fd: number|null, path: string, mode: 'file'|'ignore'}}
 */
export function openConsoleLog({ pkgRoot, log = () => {} } = {}) {
  const path = consoleLogPath(pkgRoot)
  try {
    mkdirSync(join(pkgRoot, 'logs'), { recursive: true })
    // 'a' = 追加：重启 SnowLuma 时保留上一次的输出（凭据可能只出现过一次）
    return { fd: openSync(path, 'a'), path, mode: 'file' }
  } catch (error) {
    log(`⚠️ 无法把 SnowLuma 的输出写到 ${path}：${error?.message ?? error}（改为丢弃输出）`)
    return { fd: null, path, mode: 'ignore' }
  }
}

/** 关闭父进程这一份 fd（子进程已经继承了自己的副本）。不抛异常。 */
export function closeConsoleLog(fd) {
  if (fd === null || fd === undefined) return
  try {
    closeSync(fd)
  } catch {
    /* 关不掉也不影响运行 */
  }
}

/**
 * 从一段控制台输出里找"引导凭据"这一行。
 *
 * ★ 只返回"有没有 / 用户名"，**不返回密码**（见文件头"为什么不把密码回显"）。
 * SnowLuma 的实现形状（bundle 里 `logger-*.js`）：
 *     WARN [WebUI.Auth] initial credentials: user=admin password=<16 位十六进制>
 *
 * @returns {{found: boolean, user: string|null}}
 */
export function scanBootstrapCredentials(text) {
  const m = /initial credentials:\s*user=(\S+)\s+password=\S+/i.exec(String(text ?? ''))
  if (!m) return { found: false, user: null }
  return { found: true, user: m[1] }
}

/**
 * 读控制台日志里**可能出现凭据**的两段：开头与结尾。
 *
 * 为什么不是"整个文件"：这个文件会随每次启动不断追加，跑几个月后会很大。
 * 而凭据行只可能出现在**某一次启动的横幅之后** ——
 *   · 文件**开头** = 第一次启动（也是用户最常卡住的那一次）
 *   · 文件**结尾** = 最近一次启动
 * 中间那部分只会是历史输出，扫它既慢又没意义。
 * ⚠️ 边界：如果用户重启了十几次、而凭据恰好在"中间某一次"里，这里看不到 ——
 * 那种情况下提示文案里那句"再启动一次就会轮换出新密码"就是出路。
 */
export function readConsoleForBootstrap({ pkgRoot, headBytes = 64 * 1024, tailBytes = 2 * 1024 * 1024 } = {}) {
  const path = consoleLogPath(pkgRoot)
  try {
    if (!existsSync(path)) return ''
    const size = statSync(path).size
    if (size <= headBytes + tailBytes) return readFileSync(path, 'utf8')
    const buf = readFileSync(path)
    return `${buf.subarray(0, headBytes).toString('utf8')}\n${buf.subarray(size - tailBytes).toString('utf8')}`
  } catch {
    return ''
  }
}

/**
 * 读 SnowLuma 的 `config/webui.json`：它是否还处于"没改过初始密码"的状态。
 *
 * 为什么要读：SnowLuma 在 `mustChangePassword` 仍为 true 时，**下次启动会轮换出
 * 一个新密码并再次打印**（实测值见报告）。这意味着"看不到密码"的正确出路是
 * **重启 SnowLuma**，而不是重装 —— 这条话必须能让用户看到。
 *
 * @returns {{file: string|null, mustChangePassword: boolean|null}}
 */
export function readWebuiBootstrap({ installDir } = {}) {
  if (!installDir) return { file: null, mustChangePassword: null }
  const file = join(installDir, 'config', 'webui.json')
  try {
    if (!existsSync(file)) return { file, mustChangePassword: null }
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return { file, mustChangePassword: data?.mustChangePassword === true }
  } catch {
    return { file, mustChangePassword: null }
  }
}

/**
 * 给出一条**可执行**的提示：凭据在哪个文件、怎么拿。
 *
 * @returns {{consoleLogFile: string, relFile: string, found: boolean, user: string|null,
 *            mustChangePassword: boolean|null, hint: string}}
 *   `hint` 里**不含密码值**（见文件头）。
 */
export function bootstrapCredentialInfo({ pkgRoot, installDir = null, consoleUrl = null, text = null } = {}) {
  const consoleLogFile = consoleLogPath(pkgRoot)
  const relFile = (() => {
    try {
      return relative(pkgRoot, consoleLogFile)
    } catch {
      return consoleLogFile
    }
  })()
  const scanned = scanBootstrapCredentials(text === null ? readConsoleForBootstrap({ pkgRoot }) : text)
  const { mustChangePassword } = readWebuiBootstrap({ installDir })
  const where = consoleUrl ? `，网页端 ${consoleUrl}` : ''

  let hint
  if (scanned.found) {
    hint =
      `SnowLuma 的首次登录凭据已经出现在 ${relFile} 里（用户 ${scanned.user}）—— ` +
      `用记事本打开它，搜 "initial credentials" 就能拿到密码${where}`
  } else if (mustChangePassword === true) {
    hint =
      `SnowLuma 还没改过初始密码，而那个引导密码**只在它的启动输出里出现过一次** —— ` +
      `我们把启动输出重定向到了 ${relFile}（去那里搜 "initial credentials"）。` +
      `如果那里也没有：**再启动一次 SnowLuma** 就会轮换出一个新密码并重新打印，` +
      `不需要重新下载、也不需要重新注册${where}`
  } else {
    hint =
      `SnowLuma 的启动输出已重定向到 ${relFile}` +
      `（首次登录凭据会在里面，搜 "initial credentials"）${where}`
  }

  return {
    consoleLogFile,
    relFile,
    found: scanned.found,
    user: scanned.user,
    mustChangePassword,
    hint,
  }
}
