/**
 * 服务端守护：**谁在管这个服务端进程**（0.3.2 P2 收尾 / P4 的前提）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════════════════════
 * `restart.mjs` 要一份**归属证据**（`running.json` 的 `pid@启动时刻`）才肯动手。
 * 那份证据由本模块产生与维护。没有它，"尝试一次重启"这条需求**物理上做不到**
 * —— 因为 RCON 是"先停再起"的交接，而**崩溃的服务端上没有任何命令通道**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 两条设计决定（改之前先读完）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① ★★ **子进程要比桥接活得久**（`detached: true` + `unref()` + `stdio` 重定向到文件句柄）。
 *      反过来（子进程跟着桥接死）会踩两个坑：
 *        · 桥接每次重启（升级、改配置、界面点重启）都**踢掉所有在线玩家**；
 *        · 桥接重启后**认不出那个服务端** ⇒ 可能再起一个 ⇒
 *          **两个 JVM 打开同一个世界目录 = 存档损坏（不可逆）**。
 *      这套做法与 `snowluma.mjs` 拉起协议端时**完全一致**（那里还记着
 *      "`detached` + `unref()` 让子进程脱离桥接的进程组并独立存活"）。
 *
 *   ② ★★ **`pid` 单独当身份是不够的** —— `pid` 会被**复用**。
 *      所以归属判据是 **`pid@进程启动时刻`**（与 `delivery-ledger.mjs` 的
 *      `ownerId(pid, startedAt)` 同一条教训）。查不到启动时刻时**判为"不是我的"**
 *      （宁可不动，也不赌）。这正是"认不出归属就不许抢"那条纪律的落地。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ stdout/stderr 为什么必须**重定向到文件句柄**（不是 pipe）
 * ══════════════════════════════════════════════════════════════════════════
 *   模组服的控制台输出量很大，pipe 的缓冲区一旦没人及时读走就会**把 JVM 堵在写日志上**
 *   （症状像"服务端自己卡死了"，排查方向会完全跑偏）。文件句柄没有这个问题，
 *   而且**日志比父进程活得久**。这套结论 `snowluma-console.mjs` 的文件头记着实测数据。
 *   ∴ 顺带一个白拿的好处：P3 的游戏内聊天事件源可以直接读那两个文件（或这一层的
 *   `logFile`），不需要再操心"日志落不落盘"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 本模块**不做**的三件事（都是刻意的）
 * ══════════════════════════════════════════════════════════════════════════
 *   · **不判断"该不该重启"**（那是 `restart.mjs` 的判据）；
 *   · **不投递消息**（那是桥接的主动回合）；
 *   · **不猜启动命令** —— 它是使用者给的（`servers[].startCommand`）；
 *     没给就如实报"我不知道怎么启动它"，**绝不猜一个 `java -jar server.jar`**。
 */

import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** 归属与日志文件所在目录（工作区相对）。★ 属于使用者数据。 */
export const SUPERVISE_DIR = 'runtime/servers'

/** 归属档的版本（形状变了就升它，读的时候不认就按"没有证据"处理）。 */
const OWNER_VERSION = 1

/**
 * 查一个进程的启动时刻（用来构成 `pid@启动时刻` 这个身份）。
 *
 * ★★ 拿不到就返回 `null`，而**调用方必须把 null 当"不是我的"**（不许退化成"只看 pid"）。
 *   实现方式用 `wmic`（老 Windows）与 PowerShell（新 Windows）两条都试：
 *   这个项目已经吃过"命令在当前系统上不存在"的亏（`--check` 里那些探测都是这么写的）。
 * ★ 在**非 Windows** 上返回 null（如实：我们没实现那两条路）—— 那会让归属判定
 *   保守地失败（只报告不重启），而不是猜。
 *
 * @param {number} pid
 * @param {{run?: Function}} [deps] 可注入的"执行一条命令"（测试用）
 * @returns {Promise<number|null>} 毫秒时间戳；查不到返回 null
 */
export async function processStartedAt(pid, { run = defaultRun } = {}) {
  const p = Number(pid)
  if (!Number.isFinite(p) || p <= 0) return null
  if (process.platform !== 'win32') return null
  // 两条路都试：新系统上 wmic 可能已经移除，老系统上没有 PowerShell 7
  const attempts = [
    ['wmic', ['process', 'where', `processid=${p}`, 'get', 'CreationDate', '/value']],
    ['powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${p} -ErrorAction SilentlyContinue).StartTime.ToString('o')`]],
  ]
  for (const [cmd, args] of attempts) {
    let out = ''
    try {
      out = String((await run(cmd, args)) ?? '')
    } catch {
      continue
    }
    const t = parseStartTime(out)
    if (t !== null) return t
  }
  return null
}

/** 从两种命令的输出里抠出时间（**认不出返回 null，不猜**）。 */
export function parseStartTime(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  // `CreationDate=20261004003012.123456+480`（wmic）
  const wmic = /CreationDate=(\d{14})/.exec(s)
  if (wmic) {
    const v = wmic[1]
    const y = Number(v.slice(0, 4))
    const mo = Number(v.slice(4, 6))
    const d = Number(v.slice(6, 8))
    const h = Number(v.slice(8, 10))
    const mi = Number(v.slice(10, 12))
    const sec = Number(v.slice(12, 14))
    const t = new Date(y, mo - 1, d, h, mi, sec).getTime()
    return Number.isFinite(t) ? t : null
  }
  // ISO（PowerShell 的 `.ToString('o')`）
  const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/.exec(s)
  if (iso) {
    const t = Date.parse(iso[1])
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** 默认的"跑一条命令并拿回 stdout"（失败返回空串，由调用方当"查不到"）。 */
function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch {
      resolve('')
      return
    }
    let out = ''
    child.stdout?.on('data', (d) => {
      out += String(d)
    })
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(out))
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经没了 */
      }
      resolve(out)
    }, 4000)?.unref?.()
  })
}

/** 判断一个 pid 是否还活着（`process.kill(pid, 0)` 不真的发信号）。 */
export function isPidAlive(pid, kill = process.kill) {
  const p = Number(pid)
  if (!Number.isFinite(p) || p <= 0) return false
  try {
    kill(p, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但没权限（仍算活着）；ESRCH = 不存在
    return error?.code === 'EPERM'
  }
}

/**
 * 造一个守护器。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {(host: string, port: number, timeoutMs: number) => Promise<boolean>} [opts.portOpen]
 *        端口探针（判断"服务端在不在听"）；默认用一次 TCP connect。
 * @param {Function} [opts.spawnImpl] 可注入的 spawn（测试用）
 * @param {Function} [opts.startedAt] 可注入的"查进程启动时刻"（测试用）
 * @param {Function} [opts.pidAlive]  可注入的"pid 还活着吗"（测试用）
 * @param {Function} [opts.log]
 */
export function createSupervisor({
  workspace,
  portOpen = null,
  spawnImpl = spawn,
  startedAt = (pid) => processStartedAt(pid),
  pidAlive = (pid) => isPidAlive(pid),
  log = () => {},
} = {}) {
  const root = String(workspace ?? '')
  const rel = (serverId) => `${SUPERVISE_DIR}/${String(serverId).replace(/[^a-zA-Z0-9_.-]/g, '_')}.running.json`

  function readState(serverId) {
    if (!root) return null
    try {
      const p = join(root, rel(serverId))
      if (!existsSync(p)) return null
      let text = readFileSync(p, 'utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      const v = JSON.parse(text)
      if (!v || typeof v !== 'object' || v.version !== OWNER_VERSION) return null
      return v
    } catch (error) {
      log(`⚠️ [supervise] ${serverId} 的归属档读不出来（按"没有证据"处理）：${error?.message ?? error}`)
      return null
    }
  }

  function writeState(serverId, value) {
    if (!root) return { ok: false, why: '缺少 workspace' }
    try {
      const p = join(root, rel(serverId))
      mkdirSync(join(p, '..'), { recursive: true })
      const tmp = `${p}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, 'utf8')
      renameSync(tmp, p)
      return { ok: true, file: p }
    } catch (error) {
      // ★ 写不上意味着**重启能力会退化**（归属证据没了）⇒ 必须喊
      log(`⚠️ [supervise] ${serverId} 的归属档写不上（重启能力会退化成"只报告"）：${error?.message ?? error}`)
      return { ok: false, why: String(error?.message ?? error) }
    }
  }

  /** 服务端控制台输出落盘的位置（**比进程活得久**，P3 也读它）。 */
  function logFileFor(serverId) {
    return root ? join(root, SUPERVISE_DIR, `${String(serverId).replace(/[^a-zA-Z0-9_.-]/g, '_')}.console.log`) : ''
  }

  /**
   * 判定**归属**（`restart.mjs` 要的 `evidence`）。
   *
   * ★★ 判据顺序不能换：**先看端口在不在听**（"有没有东西在跑"），
   *   再看"那是不是我们起的"。反过来的话，一个"档案在、进程早死了"的情况
   *   会被说成 `owner: bridge`（于是去重启一个根本没在跑的东西）。
   *
   * @returns {Promise<{owner: 'bridge'|'external'|'unknown', pid: number|null, startedAt: number|null, why: string, portOpen: boolean}>}
   */
  async function ownership({ serverId, host = '127.0.0.1', port = 25565 } = {}) {
    const open = portOpen ? await safePortOpen(host, port) : await defaultPortOpen(host, port)
    const state = readState(serverId)

    if (!open) {
      // 端口不通 ⇒ 没有东西在听。此时**有档案也不算"我的"**（档案是"我起过"，不是"它在跑"）
      return { owner: 'unknown', pid: null, startedAt: null, portOpen: false, why: '端口上没有东西在听（服务端没在跑）' }
    }

    if (!state) {
      return {
        owner: 'external',
        pid: null,
        startedAt: null,
        portOpen: true,
        why: '端口有东西在听，但**没有归属档**（不是我拉起来的：可能是手动起的、或上一版留下的）',
      }
    }

    const pid = Number(state.pid)
    const recordedAt = Number(state.startedAt)
    if (!Number.isFinite(pid) || !Number.isFinite(recordedAt)) {
      return { owner: 'external', pid: null, startedAt: null, portOpen: true, why: '归属档里没有可用的 pid@启动时刻' }
    }
    if (!pidAlive(pid)) {
      return {
        owner: 'external',
        pid,
        startedAt: recordedAt,
        portOpen: true,
        why: `归属档里记的 pid ${pid} **已经不存在了**，而端口还有东西在听 ⇒ 现在跑的不是我起的那个`,
      }
    }
    // ★★ 关键那一步：`pid@启动时刻` 都对得上才算我的（pid 会被复用）
    const live = await startedAt(pid)
    if (live === null) {
      // ── ★★ 退一步：用**启动命令**做弱证据 ──────────────────────────────
      //
      // 为什么要有这一步（实测踩出来的）：查启动时刻要在 Windows 上**捕获
      // PowerShell/wmic 的输出**，而受限沙箱**禁止命名管道** ⇒ spawn 直接 EPERM
      // （`AGENT.md` §6 记着同一件事：`verify-rpc` / `verify-onebot` / `verify-mcp`
      // 在受限沙箱里会整份跳过）。于是**归属永远无法证明**、"尝试一次重启"永远用不了。
      // ∴ 拿不到启动时刻时，退一步看**这个 pid 的命令行里是不是我们记下的那条命令**：
      //   它比"只看 pid"强（pid 复用后命令行几乎不可能一样），比"启动时刻"弱
      //   （同一命令可能被手动再起一次）。**弱证据要标出来**（`why` 里写明），
      //   让人知道这次判定依据是什么。
      const cmdOk = await commandLooksOurs(pid, state)
      if (cmdOk.ok) {
        return {
          owner: 'bridge',
          pid,
          startedAt: recordedAt,
          portOpen: true,
          weak: true,
          why: `查不到启动时刻（这台机器上查不了），但 pid ${pid} 的命令行与归属档里记的那条一致（**弱证据**）：${cmdOk.detail}`,
        }
      }
      return {
        owner: 'unknown',
        pid,
        startedAt: recordedAt,
        portOpen: true,
        why: `查不到 pid ${pid} 的启动时刻，命令行也对不上（${cmdOk.detail}）⇒ **无法证明它是我起的**（宁可不动，也不赌）`,
      }
    }
    if (Math.abs(live - recordedAt) > 2000) {
      return {
        owner: 'external',
        pid,
        startedAt: recordedAt,
        portOpen: true,
        why: `pid ${pid} 的启动时刻对不上（档里记的与现在这个进程差 ${Math.round(Math.abs(live - recordedAt) / 1000)} 秒）⇒ pid 被复用了，它不是我的`,
      }
    }
    return { owner: 'bridge', pid, startedAt: recordedAt, portOpen: true, why: `是我在 ${new Date(recordedAt).toLocaleString()} 拉起的（pid ${pid}）` }
  }

  async function safePortOpen(host, port) {
    try {
      return Boolean(await portOpen(host, port, 1500))
    } catch {
      return false
    }
  }

  /**
   * 把服务端拉起来（**detached + unref + stdio 重定向到文件句柄**）。
   *
   * ★ 启动命令**必须由使用者给**（`servers[].startCommand`）：模组服的启动方式
   *   五花八门（`@args.txt` / 启动器脚本 / JVM 参数），猜一个只会在真机上失败。
   * ★ 可选命令同样**不猜**（`cmd.exe /c` 那条路留给使用者自己写在 `startCommand` 里）。
   *
   * @param {object} server 配置里那一台（要 `id` 与 `startCommand`；可选 `cwd`）
   * @returns {Promise<{ok: boolean, pid?: number, why?: string, logFile?: string}>}
   */
  async function launch(server = {}) {
    const serverId = String(server.id ?? '')
    const cmdline = String(server.startCommand ?? '').trim()
    if (!serverId) return { ok: false, why: '缺少 server.id' }
    if (!cmdline) {
      return {
        ok: false,
        why:
          '配置里没有 `startCommand` —— **我不知道怎么启动这个服务端**。' +
          '模组服的启动方式各不相同（`@args.txt` / 启动器脚本 / JVM 参数），我不猜，请填一条。',
      }
    }

    const logFile = logFileFor(serverId)
    let fd = null
    try {
      mkdirSync(join(logFile, '..'), { recursive: true })
      // 'a' = 追加：重启后保留上一段输出（排查"它上次为什么挂"要看它）
      fd = openSync(logFile, 'a')
    } catch (error) {
      // 落盘失败**不阻断启动**（看不到日志比起不来轻得多），但要如实说
      log(`⚠️ [supervise] ${serverId} 控制台输出落盘没打开（这一段的输出会丢）：${error?.message ?? error}`)
    }

    const cwd = String(server.cwd ?? '').trim() || undefined
    // ★★ 用 shell 起（模组服的启动行常带 `&&` / 变量 / `@args.txt`）。
    //
    // ⚠️⚠️ **必须写成 `spawn([cmdline], {shell:true})`（包成单元素数组），
    //   不能写 `spawn(cmdline, {shell:false})`** —— 后者会把整串
    //   `node .tmp-fake-server.mjs` 当成**一个可执行文件名**去 CreateProcess，
    //   于是必然 `ENOENT: spawn node server.mjs`。
    //   实测抓到这一次：`--supervise start` 打印了"✅ 已拉起"、归属档也写了 pid，
    //   而**那个进程从来没起来过** —— 正是本项目最忌讳的"看起来成功了"。
    //   （`shell:true` 时 spawn 内部走 `cmd.exe /d /s /c <字符串>`，数组里的那一项
    //    就是被整串执行的命令。）
    const useShell = server.shell !== false
    let child
    try {
      child = useShell
        ? spawnImpl(cmdline, {
            cwd,
            shell: true,
            // ★★ 三条缺一不可（见文件头 ①）：
            detached: true, // 脱离桥接的进程组，桥接退出不带走它
            windowsHide: true,
            stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
          })
        : spawnImpl(cmdline.split(' ')[0], cmdline.split(' ').slice(1), {
            cwd,
            shell: false,
            detached: true,
            windowsHide: true,
            stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
          })
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* 关不掉无所谓 */
        }
      }
      return { ok: false, why: `启动失败：${error?.message ?? error}` }
    }
    // ★ 立刻 unref：让**桥接退出不带走它**（与 SnowLuma 那套一致）
    child.unref()

    const pid = Number(child.pid)
    // 父进程这一份 fd 用完就关（子进程已经继承了自己的副本）——
    // 不关的话 Windows 上这个句柄会一直占着文件，日志轮转/搬迁都会被挡住
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 无所谓 */
      }
    }

    const startedAtMs = Date.now()
    writeState(serverId, {
      version: OWNER_VERSION,
      serverId,
      pid,
      startedAt: startedAtMs,
      startedBy: 'bridge',
      command: basename(cmdline).slice(0, 80),
      logFile,
    })
    log(`[supervise] ${serverId} 已拉起（pid ${pid}；输出 → ${logFile}）`)
    return { ok: true, pid, logFile, startedAt: startedAtMs }
  }

  /**
   * 通过 RCON 优雅停服（发给 `restart.mjs` 当 `stopGracefully`）。
   *
   * ★ 只发**一条 `stop`**：`stop` 是 vanilla 命令，各端都有；而它**不改变世界状态**
   *   （不属于 §8 的"默认拒绝"那一类 —— 那一类指的是 `op/ban/give/tp/execute`）。
   *   ★ 真正"停不下来"时的处置**不在这里**：`restart.mjs` 会等端口释放，
   *   超时就转求助 —— **本模块绝不强杀**（强杀正在写世界的 JVM = 存档损坏）。
   */
  function makeStopGracefully({ server } = {}) {
    const serverId = String(server?.id ?? '')
    return async () => {
      const r = await (server?.__rconExec ? server.__rconExec('stop') : { ok: false, why: '没有可用的 RCON 连接' })
      if (r?.ok) log(`[supervise] ${serverId} 已发出 stop`)
      return { ok: Boolean(r?.ok), why: r?.why }
    }
  }

  /**
   * 弱证据：这个 pid 的命令行里有没有我们记下的那条启动命令。
   *
   * ★ 判据故意**只用"最像标识的那一段"**（脚本名 / jar 名 / 可执行文件名），
   *   而不是整串比较：不同 Windows 会把命令行规范化（引号、绝对路径、`cmd.exe /c` 前缀），
   *   整串比会**永远对不上**，于是这条退路等于没有。
   * ★ 拿不到命令行（沙箱禁管道）⇒ `ok:false` 且原因写清 —— **不许当成"对上了"**。
   */
  async function commandLooksOurs(pid, state) {
    const needle = commandKey(String(state?.command ?? ''))
    if (!needle) return { ok: false, detail: '归属档里没有可比的命令' }
    let text = ''
    try {
      text = String((await runCmd('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`])) ?? '')
    } catch (error) {
      return { ok: false, detail: `查命令行失败（${error?.message ?? error}）` }
    }
    if (!text.trim()) return { ok: false, detail: '拿不到命令行（这台机器上查不了）' }
    const hit = text.toLowerCase().includes(needle.toLowerCase())
    return { ok: hit, detail: hit ? `命令行里含「${needle}」` : `命令行里不含「${needle}」` }
  }

  /**
   * 跑一条命令（**捕获输出**）。失败**不抛**，返回空串 —— 调用方按"查不到"处理。
   *
   * ⚠️ 受限沙箱下会 `spawn EPERM`（禁命名管道）⇒ 这条退路与"启动时刻"那条一样会失效，
   *   但那时我们**如实降级成 unknown**（只报告不重启），**不会**误判成"是我的"。
   */
  function runCmd(cmd, args) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(cmd, args, { windowsHide: true })
      } catch {
        resolve('')
        return
      }
      let out = ''
      child.stdout?.on('data', (d) => (out += String(d)))
      child.on('error', () => resolve(''))
      child.on('close', () => resolve(out))
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 已经没了 */
        }
        resolve(out)
      }, 4000)?.unref?.()
    })
  }

  /**
   * 从一条启动命令里取出**最像标识的那一段**（脚本名 / jar 名 / 可执行文件名）。
   *
   * `node .tmp-mc-stub.mjs`            → `.tmp-mc-stub.mjs`
   * `java -jar server.jar --nogui`     → `server.jar`
   * `C:\mc\start.bat`                  → `start.bat`
   */
  function commandKey(cmdline) {
    const parts = String(cmdline).split(/\s+/).filter(Boolean)
    // 优先找 `.jar` / `.mjs` / `.js` / `.bat` / `.cmd` / `.exe`
    const withExt = parts.find((p) => /\.(jar|mjs|js|cjs|bat|cmd|exe|ps1)$/i.test(p))
    if (withExt) return basename(withExt)
    return parts.length > 0 ? basename(parts[parts.length - 1]) : ''
  }

  return {
    ownership,
    launch,
    makeStopGracefully,
    readState,
    logFileFor,
    rel,
    commandKey,
  }
}

/**
 * 默认端口探针：一次 TCP connect。**只要"有没有东西在听"**，不做任何协议交互
 * （RCON 登录要密码，而这里只是判断进程死活）。
 */
function defaultPortOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        /* 已经关了 */
      }
      resolve(v)
    }
    let sock
    try {
      sock = connect({ host: String(host), port: Number(port) })
    } catch {
      resolve(false)
      return
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}
