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
 * ★ 三条实现细节**每一条都是实测踩出来的**（改之前先读完）：
 *
 *   ① **优先 `Get-Process`，不要 `wmic`/`Get-CimInstance`**：实测这台机器上
 *      `Get-CimInstance Win32_Process` 直接 `拒绝访问`（`HRESULT 0x80041003`），
 *      而 `Get-Process` 能正常拿到启动时刻与可执行文件路径。
 *      `wmic` 留作最后一条退路（老系统上它才是有的那个）。
 *   ② **必须 `ToUniversalTime()`**：`Get-Process.StartTime` 的 `Kind` 是 **`Local`**，
 *      直接取 `.Ticks` 会得到本地墙钟 —— 实测与真值**差整整 8 小时**（UTC+8），
 *      于是"明明是我起的"被判成"不是我起的"。加了 `ToUniversalTime()` 之后
 *      与权威值**差 0 秒**。
 *   ③ **别用 `ToFileTimeUtc()`**：实测它给出的低 32 位是错的（差约 5×10¹⁰ 秒）。
 *
 * @param {number} pid
 * @param {{run?: Function, outFile?: string}} [deps]
 *        `run` 可注入的"执行一条命令并拿回输出"（测试用）；
 *        `outFile` 把输出重定向到文件再读（**绕过"管道被禁"**，见 `defaultRun`）
 * @returns {Promise<number|null>} 毫秒时间戳；查不到返回 null
 */
export async function processStartedAt(pid, { run = defaultRun, outFile = '' } = {}) {
  const p = Number(pid)
  if (!Number.isFinite(p) || p <= 0) return null
  if (process.platform !== 'win32') return null
  // 顺序：Get-Process（实测最可靠）→ wmic（老系统退路）。
  // ★ `-ErrorAction SilentlyContinue` + `if ($x)`：进程不存在时**输出空**
  //   （否则会拿到一句错误文本，而 `parseStartTime` 认不出它 ⇒ 仍然是 null，
  //   但让输出干净更省事，也少一处"把错误文本当数据"的风险）。
  const attempts = [
    ['powershell', ['-NoProfile', '-Command', `$x=Get-Process -Id ${p} -ErrorAction SilentlyContinue; if ($x) { $x.StartTime.ToUniversalTime().Ticks }`]],
    ['wmic', ['process', 'where', `processid=${p}`, 'get', 'CreationDate', '/value']],
  ]
  for (const [cmd, args] of attempts) {
    let out = ''
    try {
      out = String((await run(cmd, args, outFile)) ?? '')
    } catch {
      continue
    }
    const t = parseStartTime(out)
    if (t !== null) return t
  }
  return null
}

/** 从几种命令的输出里抠出时间（**认不出返回 null，不猜**）。 */
export function parseStartTime(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  // ① `.NET` 的 `DateTime.ToUniversalTime().Ticks`（**纯数字**，首选）
  //
  //   为什么首选数字：它是**自 1601-01-01 UTC 起的 100ns 计数**，没有时区参与、
  //   没有地域格式差异 ⇒ 解析最不容易出错（实测与权威值差 0 秒）。
  //   ★ 只认**整串都是数字**的情况：PowerShell 的错误文本里也可能出现数字，
  //     而"把错误文本里的某个数当时间"会让归属判据凭空判对（比判错更坏）。
  if (/^\d{15,20}$/.test(s)) {
    const ticks = Number(s)
    // ★ 取整到毫秒：Ticks 是 100ns 精度，直接除会留下小数尾巴，
    //   而调用方比的是毫秒时间戳（小数会让"相等"的比较变脆）。
    const ms = Math.round(ticks / 10_000 - 62_135_596_800_000)
    // 合理范围：**2000 年之后**、且不在未来（防"把别的数字当 Ticks"）。
    // ★ 为什么必须有上界：`.NET` 的 Ticks 是"自 1601 起"，一个被漏掉时区
    //   修正的值会**落到未来**（实测差 8 小时 ⇒ 未来的时间戳）。
    //   把未来判成"它是我起的"没有任何意义，而拒掉它就是拒掉那个 bug。
    // ★ 下界取 2000 年而不是 1970 年：进程启动时刻不可能早于 Windows 存在，
    //   更小的值几乎一定是"别的数字"而不是时间。
    if (Number.isFinite(ms) && ms >= 946_684_800_000 && ms <= Date.now() + 60_000) return ms
    return null
  }
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

/**
 * 默认的"跑一条命令并拿回 stdout"（失败返回空串，由调用方当"查不到"）。
 *
 * ★ 它 `export` 出去是**故意的**：测试要能直接断言"给了 `outFile` 就真的能把输出
 *   拿回来" —— 那是绕过"管道被禁"的那一手，也是归属判据能工作的前提。
 *   一行都不许只是"注释里说它对"（本项目最贵的失败形状之一）。
 *
 * ★★★ `outFile` 不是可选优化，它是**这条退路能不能用**的关键（实测抓到的硬伤）：
 *
 *   第一版用 `stdio: 'pipe'` 抓输出，而**捕获另一个进程的输出需要命名管道**，
 *   受限沙箱直接 `spawnSync powershell EPERM`。后果不是"少一个功能"，而是
 *   **归属判据整个失效**：`processStartedAt()` 与 `commandLooksOurs()` 都走这条
 *   `run()`，拿不到输出 ⇒ 判成"无法证明它是我起的" ⇒ **重启能力废掉** ——
 *   而症状看起来完全像是"这服务端不是我起的"（会把人往错误方向引）。
 *
 *   实测对照（同一个命令，同一台机器）：
 *     管道     `spawnSync powershell` → `EPERM`
 *     重定向到文件                    → 正常拿到输出
 *   ∴ 现在**优先把输出重定向到文件再读**（与"服务端控制台输出落盘"同一套做法），
 *     只在调用方没给文件路径时才退回管道（那是给测试的兼容路径）。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} [outFile] 把 stdout/stderr 写到这里再读回来（绕过管道限制）
 */
export function defaultRun(cmd, args, outFile = '') {
  return new Promise((resolve) => {
    const file = String(outFile ?? '').trim()
    let fd = null
    if (file) {
      try {
        fd = openSync(file, 'w')
      } catch {
        fd = null // 打不开文件就退回管道（总比什么都不做好）
      }
    }
    let child
    try {
      child = spawn(cmd, args, fd === null ? { windowsHide: true } : { windowsHide: true, stdio: ['ignore', fd, fd] })
    } catch {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* 无所谓 */
        }
      }
      resolve('')
      return
    }
    const readBack = () => {
      if (fd === null) return ''
      try {
        let text = readFileSync(file, 'utf8')
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
        return text
      } catch {
        return ''
      }
    }
    const finish = (piped) => {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* 无所谓 */
        }
        resolve(readBack())
        return
      }
      resolve(piped)
    }
    let out = ''
    child.stdout?.on('data', (d) => {
      out += String(d)
    })
    child.on('error', () => finish(''))
    child.on('close', () => finish(out))
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经没了 */
      }
      finish(out)
    }, 8000)?.unref?.()
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
 * @param {Function} [opts.runCmd]    可注入的"捕获一条命令的输出"（测试用）。
 *        ★ 为什么必须能注入：默认实现要 spawn 并**捕获输出**，而受限沙箱禁命名管道
 *        ⇒ 那条路直接 `spawn EPERM`。于是"弱证据比对"这段逻辑**在沙箱里永远测不到**，
 *        只能靠不可注入的注释来"保证"它是对的 —— 而它恰恰是唯一还能证明
 *        "这个服务端是我起的"的退路，值得一条真断言。
 * @param {Function} [opts.log]
 */
export function createSupervisor({
  workspace,
  portOpen = null,
  spawnImpl = spawn,
  startedAt = null,
  pidAlive = (pid) => isPidAlive(pid),
  runCmd = null,
  log = () => {},
} = {}) {
  const root = String(workspace ?? '')
  const rel = (serverId) => `${SUPERVISE_DIR}/${String(serverId).replace(/[^a-zA-Z0-9_.-]/g, '_')}.running.json`
  /**
   * 子进程输出的落盘中转文件。
   *
   * ★ 为什么必须有一个：**捕获子进程输出要命名管道，而受限沙箱禁管道**
   *   （实测 `spawnSync powershell EPERM`）⇒ 不改的话归属判据整条失效。
   *   放在 `SUPERVISE_DIR` 下与归属档同片区，便于排查时一起看。
   * ★ 用处只有一个（跑完立刻读回），所以**每次覆盖写**、不留历史。
   */
  const probeOutFile = root ? join(root, SUPERVISE_DIR, '.probe-out.txt') : ''
  /** 默认的"查启动时刻"：把输出重定向到文件再读（绕过管道限制） */
  const startedAtFn = typeof startedAt === 'function' ? startedAt : (pid) => processStartedAt(pid, { outFile: probeOutFile })

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
    const live = await startedAtFn(pid)
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
    if (!serverId) return { ok: false, why: '缺少 server.id' }
    // ★ 启动形状的判据在下面（`startExe` 优先；见那段注释）—— 这里**不提前判**
    //   `startCommand`，否则"只给了 startExe"的配置会被误拒。
    if (!String(server.startExe ?? '').trim() && !String(server.startCommand ?? '').trim()) {
      return {
        ok: false,
        why:
          '配置里既没有 `startExe`+`startArgs`，也没有 `startCommand` —— **我不知道怎么启动这个服务端**。' +
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
    // ── ★★★ 启动形状：**优先用 `startExe` + `startArgs`（不走 shell）** ──────
    //
    // 为什么这不是可选的优化（实测抓到的硬伤）：`shell: true` 时
    // **`child.pid` 是 `cmd.exe` 的 pid，不是服务端的**。而 `cmd.exe` 起完 java
    // 就自己退出了 ⇒ 归属档里记的 pid **立刻变成"已死的进程"** ⇒
    // `ownership()` 判成"档里的 pid 已死而端口还通 ⇒ 不是我起的" ⇒
    // **归属永远证明不了 ⇒ 重启能力永远不可用**。
    //   ∴ 让使用者显式给「可执行文件 + 参数数组」时，我们**直接 spawn，不经 shell**，
    //     拿到的就是真正的那个进程。
    //   ⚠️ 保留 `startCommand` 那条路（老写法 / 需要 `&&`、变量的场景），
    //     但那时的 pid 是 shell 的 —— 归属档里如实记 `viaShell`，别假装它是服务端。
    const startExe = String(server.startExe ?? '').trim()
    const startArgs = Array.isArray(server.startArgs) ? server.startArgs.map(String) : null
    const cmdline = String(server.startCommand ?? '').trim()
    if (!startExe && !cmdline) {
      return {
        ok: false,
        why:
          '配置里既没有 `startExe`+`startArgs`，也没有 `startCommand` —— **我不知道怎么启动这个服务端**。' +
          '模组服的启动方式各不相同，我不猜，请填一条。',
      }
    }

    // ★★ 三条 spawn 选项缺一不可（见文件头 ①）：
    //   `detached` 脱离桥接的进程组（桥接退出不带走它）、`windowsHide` 不弹窗、
    //   `stdio` 把输出接到**文件句柄**（不是 pipe —— pipe 缓冲区没人读会堵住 JVM）。
    const useShell = !startExe
    let child
    try {
      child = startExe
        ? spawnImpl(startExe, startArgs ?? [], {
            cwd,
            shell: false, // ★ 不走 shell ⇒ `child.pid` 就是真正的服务端进程
            detached: true,
            windowsHide: true,
            stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
          })
        : spawnImpl(cmdline, {
            cwd,
            shell: true, // 这条路的 pid 是 shell 的（归属档里如实记 viaShell）
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
    // ★★★ 「实际命令行」必须对**两种启动形状**都算出来（实测抓到的第二半硬伤）：
    //
    //   第一版只把 `startCommand` 记进 `cmdline`，于是走 `startExe` 时它**恒为空串**。
    //   而"弱证据"退路（`ownership()` 里那条路径比对）正是拿这个字段去比进程命令行 ——
    //   空串比什么都对不上 ⇒ **归属回退机制在最推荐的那条路上彻底失效**，
    //   而那恰恰是唯一还能证明"它是我起的"的退路。
    //   ∴ 这里现拼一条**实际交给系统的**命令行（exe + 参数），与哪种形状无关。
    const effectiveCmdline = useShell
      ? cmdline
      : [startExe, ...(startArgs ?? [])].join(' ')
    // ★★ 归属档里必须记**真实**的启动形状（这是实测踩出来的）：
    //   `shell: true` 时 `child.pid` 是 **`cmd.exe` 的 pid**，而真正在监听端口的是它
    //   拉起来的 `java.exe`。若只记 `command`（原命令），
    //   ① 现场排查时看不出我们到底是怎么起的；
    //   ② "命令行的弱证据"退路会拿 `cmd.exe` 的命令行去比，**永远对不上**。
    //   ∴ 把 `viaShell` 与**实际命令行**一起记下来（`logFile` 也已记）。
    writeState(serverId, {
      version: OWNER_VERSION,
      serverId,
      pid,
      startedAt: startedAtMs,
      startedBy: 'bridge',
      command: basename(cmdline || startExe || '').slice(0, 80),
      /** 真正交给系统的命令行（原样，便于现场核对） */
      cmdline: effectiveCmdline.slice(0, 500),
      /** 启动可执行文件（只有 `startExe` 形状才有；弱证据的最后一道回退用它） */
      startExe: String(startExe ?? '').slice(0, 400),
      /** 是否经 shell（Windows 上 = cmd.exe）；是的话 `pid` 是 shell 的 pid */
      viaShell: useShell,
      cwd: cwd ?? '',
      logFile,
    })
    log(
      `[supervise] ${serverId} 已拉起（${useShell ? 'cmd.exe ' : ''}pid ${pid}；cwd=${cwd ?? '(继承)'}；输出 → ${logFile}）` +
        (useShell ? '—— ⚠️ 这个 pid 是 **cmd.exe** 的，真正的服务端进程是它的子进程' : ''),
    )
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
    // ★ 回退顺序：`command` → `cmdline` → `startExe`。
    //   为什么要有回退：老版本的归属档在 `startExe` 形状下 `command` 与 `cmdline`
    //   **都是空的**（那是被抓到的硬伤）。升级后盘上可能还留着那样的档，
    //   这条退路必须还能用，否则"我起过的服务端"会被判成"不是我起的"。
    const needle =
      commandKey(String(state?.command ?? '')) ||
      commandKey(String(state?.cmdline ?? '')) ||
      commandKey(String(state?.startExe ?? ''))
    if (!needle) return { ok: false, detail: '归属档里没有可比的命令' }
    let text = ''
    try {
      // ★ 同一条实测教训（见 `processStartedAt` 的注释）：`Get-CimInstance
      //   Win32_Process` 在这台机器上**直接拒绝访问**，而 `Get-Process` 能拿到
      //   可执行文件路径 ⇒ 弱证据比对改用 `Get-Process`。
      //   `-ErrorAction SilentlyContinue` + `if ($x)`：进程没了就输出空
      //   （免得把一句错误文本当成"命令行"，那会让比对凭空判对）。
      text = String(
        (await runCmdFn('powershell', [
          '-NoProfile',
          '-Command',
          `$x=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($x) { "$($x.ProcessName)|$($x.Path)" }`,
        ], probeOutFile)) ?? '',
      )
    } catch (error) {
      return { ok: false, detail: `查命令行失败（${error?.message ?? error}）` }
    }
    if (!text.trim()) return { ok: false, detail: '拿不到命令行（这台机器上查不了）' }
    const hit = text.toLowerCase().includes(needle.toLowerCase())
    return { ok: hit, detail: hit ? `命令行里含「${needle}」` : `命令行里不含「${needle}」` }
  }

  /**
   * 跑一条命令并把输出拿回来。失败**不抛**，返回空串 —— 调用方按"查不到"处理。
   *
   * ★ 这里**不再自己实现一遍**：直接复用 `defaultRun`（它会把输出重定向到
   *   `outFile` 再读回，**绕过"管道被禁"**）。两处各写一份必然分叉 ——
   *   而分叉的后果是"启动时刻那条路能用了、命令行这条还是废的"，
   *   归属判据仍然走不通（实测就是这么发现的）。
   */
  function runCmdImpl(cmd, args, outFile = '') {
    return defaultRun(cmd, args, outFile)
  }

  /** 实际用的那条：默认是上面的实现，测试可以整条换掉（沙箱里跑不了默认实现） */
  const runCmdFn = typeof runCmd === 'function' ? runCmd : runCmdImpl

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
/**
 * 默认端口探针：一次 TCP connect。**只要"有没有东西在听"**，不做任何协议交互
 * （RCON 登录要密码，而这里只是判断进程死活）。
 *
 * ★ `export` 是**故意的**：桥接"启动时接管"要等端口真的开放，而它必须与这里
 *   **同一份实现** —— 两处各写一份必然分叉，而分叉的表现是
 *   「`--supervise start` 说起来了、桥接说没起来」（实测最容易被当成"服务端有毛病"）。
 */
export function defaultPortOpen(host, port, timeoutMs = 1500) {
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
