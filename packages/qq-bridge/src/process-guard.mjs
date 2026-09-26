/**
 * 进程登记：让"现在到底有几个桥接在跑"成为一个**可回答的问题**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（缺陷 3）
 * ══════════════════════════════════════════════════════════════════════════
 * 起因是一类真实事故：**上一个进程卡住关不掉，和新进程抢 PID / 端口**。
 * 而当时的代码里**没有任何 PID 记录** —— `child.pid` 只出现在日志与接口返回值里，
 * 不落盘。于是：
 *   · 用户不知道那个卡住的进程 PID 是多少，只能去任务管理器猜哪个 node.exe；
 *   · 新进程也不知道旧进程存在，无法提示或回收；
 *   · `--doctor` 报不出"有多个桥接在跑"。
 * 也就是说：**这类事故只能靠人手动杀进程收场**，而且事后无从取证。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 设计上最要紧的两点
 * ══════════════════════════════════════════════════════════════════════════
 * ① **必须防 PID 复用**。PID 会被系统回收再分配给无关进程。所以判定"这个 PID
 *    还是不是原来那个进程"不能只看 PID，要同时看：
 *      · `instanceId`（我们生成的一次性标识，写进命令行，可读回来比对）
 *      · 心跳时间（活着的进程每 30 秒刷新一次；太久没刷新 = 疑似已死）
 *    这里刻意**不依赖 wmic/PowerShell**：那些调用在受限环境里会失败，
 *    而"检测进程"这件事失败时的表现会很危险（把活的说成死的 → 开出第二个机器人）。
 * ② **宁可漏报，不可误杀**。判定"已死"的**唯一**依据是"PID 不存在"或
 *    "心跳过期且 PID 读不回我们的 instanceId"。不确定时一律报冲突、交给人决定，
 *    **绝不自动杀别人的进程**。
 *
 * 登记文件放在 `cache/processes.json` —— `cache/` 已在 .gitignore 里，
 * 且它本来就是运行期产物目录（MCP 配置也放那儿）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/** 心跳间隔与"多久没心跳算疑似已死"。 */
const HEARTBEAT_MS = 30_000
const STALE_MS = 120_000

/** 登记文件（相对包根）。 */
export const REGISTRY_REL = 'cache/processes.json'

/**
 * 命令行参数名：把 instanceId 传给自己进程。
 *
 * ★ 为什么走**命令行**而不是环境变量：防 PID 复用要靠"读回这个 PID 的命令行，
 *   看里面还有没有我们的 instanceId"。环境变量不出现在 CommandLine 里，
 *   所以必须是参数。
 */
export const INSTANCE_ARG_PREFIX = '--instance-id='

/** 从 argv 里取 instanceId（由 respawn 传下来的）。 */
export function readInstanceArg(argv = process.argv) {
  const hit = argv.find((a) => typeof a === 'string' && a.startsWith(INSTANCE_ARG_PREFIX))
  return hit ? hit.slice(INSTANCE_ARG_PREFIX.length) : null
}

/** 取自身的进程启动时间（毫秒）。用于"进程是否被换过"的粗判。 */
function selfStartMs() {
  try {
    return Date.now() - Math.round(process.uptime() * 1000)
  } catch {
    return Date.now()
  }
}

/** PID 是否还存在。**不抛异常**：EPERM 说明进程存在但无权信号，也算存在。 */
function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    // ESRCH = 不存在；EPERM = 存在但没权限（也算活着）
    return error?.code === 'EPERM'
  }
}

/**
 * 尽力读回某个 PID 的命令行（用于比对 instanceId）。
 *
 * ★ 这是**尽力而为**：Windows 上要起 PowerShell/CIM，受限环境会失败。
 *   失败时返回 null，调用方据此走"心跳 + PID 存在"的保守判定 ——
 *   绝不能因为读不到命令行就断言"它死了"。
 *
 * @returns {string|null}
 */
function readCommandLine(pid) {
  if (process.platform !== 'win32') {
    try {
      const r = spawnSync('ps', ['-p', String(pid), '-o', 'args='], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      })
      return r.status === 0 ? String(r.stdout ?? '').trim() || null : null
    } catch {
      return null
    }
  }
  try {
    const r = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`,
      ],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    )
    if (r.status !== 0) return null
    const out = String(r.stdout ?? '').trim()
    return out || null
  } catch {
    return null
  }
}

/** 读登记文件。坏了就当空的 —— 进程登记坏掉不该让桥接起不来。 */
function readRegistry(file) {
  try {
    if (!existsSync(file)) return { version: 1, entries: [] }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    return { version: 1, entries: entries.filter((e) => e && typeof e === 'object') }
  } catch {
    return { version: 1, entries: [] }
  }
}

/** 写登记文件（先写临时文件再改名：避免读到写了一半的 JSON）。 */
function writeRegistry(file, data) {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 创建一个进程登记器。
 *
 * @param {object} opts
 * @param {string} opts.pkgRoot 包根（决定登记文件位置）
 * @param {string} opts.profile 运行身份（例如 'bridge'）
 * @param {number|null} opts.port 配置接口端口
 * @param {(msg: string) => void} [opts.log]
 */
export function createProcessGuard({
  pkgRoot,
  profile = 'bridge',
  port = null,
  log = () => {},
  // 可注入：测试里要验证"心跳过期"这条判定，不能真等两分钟。
  staleMs = STALE_MS,
  /**
   * 可注入：读某个 PID 的命令行。
   *
   * ★ 为什么允许注入：这个调用依赖 PowerShell/CIM，**在受限环境里会失败**
   *   （实测沙箱里起不了子进程）。而"读不到"与"读到了但对不上"是两件完全不同的事
   *   （后者才是 PID 被复用），必须能分别测试 —— 否则这段最危险的逻辑
   *   （决定要不要杀一个进程）就只能靠祈祷。
   */
  readCmd = readCommandLine,
} = {}) {
  const file = join(String(pkgRoot), REGISTRY_REL)
  // 复用父进程传来的 instanceId（respawn 那条路），否则自己生成一个。
  // 复用是必要的：respawn 前父进程已经把新 id 写进命令行，新进程若另生成一个，
  // 那条登记就永远对不上命令行（防 PID 复用的判据会失效）。
  const instanceId = readInstanceArg() ?? randomBytes(6).toString('hex')
  const selfPid = process.pid
  let timer = null

  const selfEntry = () => ({
    pid: selfPid,
    profile,
    port,
    instanceId,
    startedAtMs: selfStartMs(),
    updatedAtMs: Date.now(),
    // 命令行里带 instanceId，便于"读回来比对"防 PID 复用
    argv: process.argv.slice(0, 3).join(' '),
  })

  /** 判定一条登记的死活。返回 {state, reason}；state ∈ alive|stale|dead|suspect。 */
  function classify(entry) {
    if (!pidAlive(entry.pid)) return { state: 'dead', reason: 'PID 不存在' }
    const age = Date.now() - Number(entry.updatedAtMs ?? 0)
    const stale = !Number.isFinite(age) || age > staleMs
    if (!stale) return { state: 'alive', reason: `心跳 ${Math.round(age / 1000)} 秒前` }

    // 心跳过期但 PID 还在：可能是长任务卡住了，也可能是 PID 被复用。
    // 尽力读回命令行，看里面是否还有我们的 instanceId。
    const cmd = readCmd(entry.pid)
    if (cmd === null) {
      // ★ 读不到命令行：**保守**判成 suspect ——
      //   既不判死（不清它的登记），也不当它是自己人。
      //   这里踩过一次：一开始写成"读不到就当死"，于是受限环境（读不到命令行）
      //   会把**活着的**登记全清理掉 —— 那正是"多跑一个机器人"的成因。
      return { state: 'suspect', reason: `心跳 ${Math.round(age / 1000)} 秒未刷新，且读不到命令行（无法确认身份）` }
    }
    if (entry.instanceId && cmd.includes(entry.instanceId)) {
      return { state: 'stale', reason: `心跳 ${Math.round(age / 1000)} 秒未刷新（进程仍在，可能卡住）` }
    }
    return { state: 'dead', reason: '命令行里已没有本进程的 instanceId（PID 被复用）' }
  }

  /**
   * 启动时调用：清理死条目、**报告冲突**、登记自己。
   *
   * @returns {{self: object, conflicts: object[], cleaned: object[], others: object[]}}
   */
  function claim() {
    const reg = readRegistry(file)
    const conflicts = []
    const cleaned = []
    const others = []
    const keep = []

    for (const entry of reg.entries) {
      if (Number(entry.pid) === selfPid) continue // 自己的旧条目（重启复用 PID 的极端情况）
      const { state, reason } = classify(entry)
      if (state === 'dead') {
        cleaned.push({ ...entry, reason })
        continue
      }
      keep.push(entry)
      // ⚠️ 冲突只算**可能真的还活着**的：`alive` / `stale`（心跳过期但进程在）/ `suspect`
      //    （读不到命令行，无法确认）。
      //
      //    这里踩过一次：原先只按 `profile` 相等就 push，于是**登记表里那些
      //    已经确认死掉的条目**（state='dead'）也会被算进 conflicts。
      //    它们的 state 会一路带到 `list()`，而 `list()` 的冲突过滤是
      //    `state === 'alive' || state === 'stale'` —— 两处口径不一致，
      //    结果就是**人看到的列表是干净的、却仍被警告"还有其它桥接在跑"**，
      //    然后被指引去 kill 一个已经不存在的 pid。
      //    实测（杀完旧实例后）就是这样：列表里只显示 23404 dead + 28312 alive，
      //    下面却照样报"有 1 个其它桥接在跑"。
      if (entry.profile === profile && state !== 'dead') conflicts.push({ ...entry, state, reason })
      else others.push({ ...entry, state, reason })
    }

    keep.push(selfEntry())
    writeRegistry(file, { version: 1, entries: keep })

    if (cleaned.length) {
      log(`[guard] 清理了 ${cleaned.length} 条已失效的进程登记（PID 已不存在）`)
    }
    if (conflicts.length) {
      // ★ 只报告，不擅自杀。理由：判定依据里含"心跳过期"这种可能误判的信号，
      //   而误杀一个正在干活的机器人比多跑一个更糟。
      log(
        `⚠️ 检测到 ${conflicts.length} 个**其它** ${profile} 进程仍在运行：` +
          conflicts.map((c) => `pid ${c.pid}（${c.reason}）`).join('、'),
      )
      log('   → 同时跑两个会抢同一个 OneBot 事件流（同一句话可能被回两次），建议先停掉一个。')
      log(`   → 查看：node src/index.mjs --processes    强制停掉：node src/index.mjs --processes --kill <pid>`)
    }

    return { self: selfEntry(), conflicts, cleaned, others }
  }

  /** 刷新自己的心跳（定时器调用；也让长任务期间不被误判为 stale）。 */
  function heartbeat() {
    const reg = readRegistry(file)
    const next = reg.entries.filter((e) => Number(e.pid) !== selfPid)
    next.push(selfEntry())
    return writeRegistry(file, { version: 1, entries: next })
  }

  function startHeartbeat() {
    if (timer) return
    timer = setInterval(heartbeat, HEARTBEAT_MS)
    // 心跳不该阻止进程退出
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** 退出时摘掉自己（尽力而为：强杀时不会执行，靠 classify 的探活兜底）。 */
  function release() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    try {
      const reg = readRegistry(file)
      const next = reg.entries.filter((e) => Number(e.pid) !== selfPid)
      writeRegistry(file, { version: 1, entries: next })
    } catch {
      /* 退出路径不抛异常 */
    }
  }

  /** 列出所有登记（含当前状态），给 --processes / doctor / /api/status 用。 */
  function list() {
    const reg = readRegistry(file)
    return reg.entries.map((e) => ({ ...e, ...classify(e), isSelf: Number(e.pid) === selfPid }))
  }

  /**
   * 停掉一个进程：**要求 PID 与 instanceId 都对得上**才动手。
   *
   * 为什么必须双重匹配：PID 会被复用。只按 PID 杀，可能杀掉一个恰好拿到
   * 同一个 PID 的无关程序 —— 那是比"多跑一个机器人"严重得多的事故。
   */
  function killEntry(pid) {
    const target = list().find((e) => Number(e.pid) === Number(pid))
    if (!target) return { ok: false, error: `登记里没有 pid ${pid}` }
    if (target.isSelf) return { ok: false, error: '那是当前进程自己（要停就用 /api/stop 或 Ctrl+C）' }
    if (target.state === 'dead') return { ok: false, error: `pid ${pid} 已经不在运行了` }

    // 二次确认身份：PID 存在 + 命令行里含登记的 instanceId
    const cmd = readCmd(pid)
    if (cmd === null) {
      return {
        ok: false,
        environmentLimited: true,
        error:
          `读不到 pid ${pid} 的命令行，无法确认它还是原来那个进程，已拒绝。` +
          `本环境可能不允许进程查询；要手动停：taskkill /PID ${pid} /T /F（**先确认**它确实是本项目的 node 进程）`,
      }
    }
    if (target.instanceId && !cmd.includes(target.instanceId)) {
      return {
        ok: false,
        pidReused: true,
        error: `pid ${pid} 现在的命令行里没有本项目的 instanceId，说明这个 PID 已被复用给别的进程，已拒绝杀它`,
      }
    }

    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 8000,
        })
      } else {
        process.kill(Number(pid), 'SIGTERM')
      }
    } catch (error) {
      return { ok: false, error: `发送终止信号失败：${error.message}` }
    }
    const gone = !pidAlive(pid)
    return gone
      ? { ok: true, pid: Number(pid) }
      : { ok: false, error: `已发送终止信号，但 pid ${pid} 仍在（可能卡在内核态）` }
  }

  return { file, instanceId, selfPid, claim, heartbeat, startHeartbeat, release, list, killEntry }
}

/**
 * 登记一个**外部进程**（缺陷 4：桥接自己拉起的 SnowLuma）。
 *
 * 与 `claim()` 的区别：claim 登记的是"当前进程自己"（带 instanceId，能靠读回
 * 命令行确认身份）；而外部进程我们只有 PID，**给不出 instanceId**。
 * 于是 classify 对它的判定会保守地停在 `suspect`（不判死）——
 * 这正是我们要的：**宁可留着一条可疑登记，也不要因为判死而漏掉"它还在跑"**。
 *
 * @param {object} opts
 * @param {string} opts.pkgRoot
 * @param {number} opts.pid
 * @param {number|null} [opts.port]
 * @param {string} [opts.profile] 例如 'snowluma'
 * @param {(msg: string) => void} [opts.log]
 */
export function registerExternal({ pkgRoot, pid, port = null, profile = 'external', log = () => {} }) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'PID 无效' }
  const file = join(String(pkgRoot), REGISTRY_REL)
  const reg = readRegistry(file)
  const entries = reg.entries.filter((e) => Number(e.pid) !== n)
  entries.push({
    pid: n,
    profile,
    port,
    // 没有 instanceId：见上面的说明（判定会保守停在 suspect）
    instanceId: null,
    startedAtMs: Date.now(),
    updatedAtMs: Date.now(),
    argv: `（外部进程，由桥接拉起：${profile}）`,
  })
  const ok = writeRegistry(file, { version: 1, entries })
  if (ok) log(`[guard] 已登记外部进程 ${profile}：pid ${n}`)
  return { ok }
}

/**
 * 摘掉一条外部进程登记（用于"我们发现自己起的那个已经不在了"）。
 * 注意：**不做任何杀进程的动作** —— 停不停的判断权在调用方。
 */
export function unregisterExternal({ pkgRoot, pid }) {
  const n = Number(pid)
  if (!Number.isInteger(n)) return { ok: false }
  const file = join(String(pkgRoot), REGISTRY_REL)
  const reg = readRegistry(file)
  const next = reg.entries.filter((e) => Number(e.pid) !== n)
  return { ok: writeRegistry(file, { version: 1, entries: next }) }
}

/** 给 CLI 用的一句话摘要。 */
export function summarizeProcesses(entries) {
  const alive = entries.filter((e) => e.state === 'alive' || e.state === 'stale')
  return `${alive.length} 个在运行（登记 ${entries.length} 条）`
}

/**
 * 从一份 `list()` 结果里挑出"**真的在跑的**桥接"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么它必须是个**按数量**判定的纯函数（而不是 `!isSelf`）
 * ══════════════════════════════════════════════════════════════════════════
 * `--processes` 是**另起的一个进程**。对它来说 `isSelf` **恒为 false** ——
 * 于是任何"用 isSelf 排除自己"的写法，在 CLI 这条路径上都会把
 * **唯一那个正在跑的桥接**当成"其它进程"，报出
 * 「有 1 个其它桥接在跑」并指引去 kill 它。
 * 实测（进程表清理干净后）确实这样：列表只有一条 `alive`，警告照样出现。
 *
 * 正确口径是**数量**：在跑的桥接 **1 条 = 正常**，**≥2 条 = 真冲突**
 * （两个都在抢同一个 OneBot 事件流）。这个口径对两种视角都成立。
 *
 * ⚠️ 不要拿它替代 `claim()` 里的冲突判定 —— 那里有 `isSelf` 的语义
 *    （"自己"是确定的那个进程），两者用途不同。
 *
 * @param {{profile?: string, state?: string}[]} entries `list()` 的返回值
 * @returns {object[]} 在跑的桥接条目
 */
export function runningBridges(entries) {
  return (Array.isArray(entries) ? entries : []).filter(
    (e) => e?.profile === 'bridge' && (e.state === 'alive' || e.state === 'stale'),
  )
}
