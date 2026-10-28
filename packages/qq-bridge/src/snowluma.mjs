/**
 * SnowLuma 进程的探测与拉起（给配置 UI 的「协议端」页签用）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么桥接能"拉起 SnowLuma"，却不能"拉起机器人自己"
 * ══════════════════════════════════════════════════════════════════════════
 * `api.mjs` 里有一段注释解释过：接口跑在桥接进程里，桥接停了接口也没了，
 * 所以**没有** `/api/start` 能远程启动桥接（启动走 `start.bat`）。
 *
 * SnowLuma 不一样 —— 它在**桥接外面**，是一个独立进程。
 * 所以"探测它在不在、把它拉起来"这两件事，桥接受理得了。
 *
 * ── 只在本机有意义 ───────────────────────────────────────────────────────
 * 接口只监听 `127.0.0.1`，所以"拉起"必然是**同一台机器上**的操作。
 * 这决定了 `launchCmd` 是一个**本机可执行路径**，界面文案也不能暗示能跨机器。
 *
 * ── 关于 .bat（这里有个真会踩的坑）──────────────────────────────────────
 * SnowLuma 常见的启动入口是 `launcher.bat`。Windows 上 `spawn` 一个 `.bat`
 * **必须**走 `shell: true`，否则直接报 `EINVAL`。
 * 而 `shell: true` 会在中间多出一个 `cmd.exe`。
 *
 * 更要紧的是**生命周期**：DSH 桌面版已经踩过这个坑（`snowluma/launcher.bat`
 * 最后一行是 `pause`，正是为了留住那个 cmd 窗口）。我们这里的对策是
 * `detached: true` + `unref()`：让子进程**脱离**桥接的进程组并独立存活，
 * 于是**关掉桥接不会连带杀掉 SnowLuma**。
 *
 * ── 关于子进程的输出（0.3.0alpha 实机 BUG-3 之后改的）────────────────────
 * 原来这里是 `stdio: 'ignore'`，理由是"用 `pipe` 的话，管道一端消失时子进程
 * 写日志会触发 EPIPE 而挂掉"。那个理由只否掉了 **pipe**，却顺手把
 * **文件句柄**也一起否掉了 —— 而 SnowLuma 的**首次登录引导密码只写 stdout**
 * （不写它自己的日志文件），丢掉 stdout 等于让用户永远拿不到那个密码
 * （详见 `snowluma-console.mjs` 文件头）。
 * 现在用 `stdio: ['ignore', fd, fd]`：既不建管道（EPIPE 的顾虑仍然不成立），
 * 又把输出留在 `logs/snowluma-console.log` 里。
 */

import { spawn } from 'node:child_process'
import { discoverOnebotConfig, listAccountNames } from './token-discovery.mjs'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { findSnowluma, findNodeBinary, PKG_ROOT } from './local.mjs'
import { checkPortFree, probeHttpAnswered } from './ports.mjs'
import { registerExternal } from './process-guard.mjs'
import { bootstrapCredentialInfo, closeConsoleLog, openConsoleLog } from './snowluma-console.mjs'

/** 界面用的状态。判定顺序见 `detect()`，**顺序本身就是规则**。 */
export const SNOWLUMA_STATUS = {
  NOT_CONFIGURED: 'not-configured',
  BRIDGE_OFFLINE: 'bridge-offline',
  OFFLINE: 'offline',
  UP_NOT_LOGGED_IN: 'up-not-logged-in',
  AUTH_FAILED: 'auth-failed',
  CONNECTED: 'connected',
}

const DEFAULT_PROBE_MS = 1500

/**
 * ★★★ 0.3.3：**启动锁**（真机事故：两个 SnowLuma 同时起来，抢 3000/3001）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 那一次到底发生了什么（有日志，不是推测）
 * ══════════════════════════════════════════════════════════════════════════
 * 2026-10-20 10:57:33，日志里连着两行 `[App] SnowLuma starting` —— 两个实例在
 * **同一秒**被拉起。它们把端口分掉了：
 *   · 先绑上的那个拿到 OneBot 3000/3001（桥接连的是它，机器人能用）；
 *   · 后起的那个两个适配器都 `EADDRINUSE`，WebUI 退让到 **5100**，但它照样
 *     登录了同一个 QQ 号、照样 hook 同一批 QQ 进程。
 * 后果有三个，而且都不响：
 *   ① **控制台指向错的那个实例** —— 大家打开的是 5099，落到的恰恰是"适配器全失败"
 *      那一份，于是看起来就是"端口被占用、机器人不在线"；
 *   ② 两个进程往同一个 SQLite 里写 ⇒ 日志里成串的 `database is locked` 与
 *      `database migration failed`（身份库降级）；
 *   ③ 同一账号被登录两次（账号风控敏感）。
 *
 * **为什么原来的三道防线没挡住**：它们（探控制台 / 问 OneBot / 探端口）都是
 * **串行的判断**，判断和 spawn 之间有几百毫秒到几秒的空隙（探控制台超时就有
 * 1.5~2.5 秒）。两次启动同时进入这个窗口时，**双方都看到"没人跑"**，然后都 spawn。
 * 判断"现在有没有人在跑"永远有竞争 —— 所以这里要的不是又一道判断，而是**互斥**。
 *
 * 做法：`cache/snowluma-launch.lock`，`openSync(..., 'wx')` 原子创建。拿不到锁
 * 就去等对面（轮询控制台），而不是跟着再起一个。锁带时间戳，超过 `staleMs` 视为
 * 崩溃残留、直接接管；拿到的锁在 `finally` 里删掉（失败路径也必须删）。
 */
const LAUNCH_LOCK = Object.freeze({
  /** 相对包根的锁文件（放 `cache/`：它本来就在 .gitignore 里，属于"机器专属的运行期产物"）。 */
  file: 'cache/snowluma-launch.lock',
  /** 超过多久算"上一次启动崩了"，可以直接接管。 */
  staleMs: 120_000,
  /** 拿不到锁时，最多等对面多久（毫秒）。 */
  waitMs: 20_000,
  /** 等待时的轮询间隔。 */
  pollMs: 500,
})

/** 锁文件路径。 */
export function launchLockPath(pkgRoot = PKG_ROOT) {
  return join(pkgRoot, ...LAUNCH_LOCK.file.split('/'))
}

/**
 * 拿启动锁（**原子**）。
 *
 * @returns {{ok: true, release: () => void, path: string}
 *          | {ok: false, why: string, holder: {pid?: number, at?: number}, path: string}}
 */
export function acquireLaunchLock({ pkgRoot = PKG_ROOT, now = Date.now(), staleMs = LAUNCH_LOCK.staleMs } = {}) {
  const path = launchLockPath(pkgRoot)
  const tryOnce = () => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const fd = openSync(path, 'wx') // ★ 'wx' = 文件已存在就失败 —— 这一步是**原子**的
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: now }))
      } finally {
        closeQuietly(fd)
      }
      return { ok: true, path, release: () => releaseLaunchLock(path) }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // 拿不到锁的**其它**原因（目录建不出来、权限）—— 不能因此拒绝启动，
        // 那会把"启动 SnowLuma"整个卡死。如实说一句，然后放行。
        return { ok: true, path, release: () => {}, lockError: error?.message ?? String(error) }
      }
      let holder = {}
      try {
        holder = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        holder = {}
      }
      const at = Number(holder?.at) || 0
      if (!at || now - at > staleMs) {
        // 崩溃残留（或文件坏掉）：清掉再抢一次。**只重试一次** —— 反复重试会掩盖真问题。
        try {
          unlinkSync(path)
        } catch {
          /* 已经没了 */
        }
        try {
          const fd = openSync(path, 'wx')
          try {
            writeSync(fd, JSON.stringify({ pid: process.pid, at: now }))
          } finally {
            closeQuietly(fd)
          }
          return { ok: true, path, release: () => releaseLaunchLock(path) }
        } catch (e2) {
          return { ok: false, path, holder, why: `启动锁抢不到（${e2?.code ?? e2?.message}）` }
        }
      }
      const ageS = Math.max(1, Math.round((now - at) / 1000))
      return {
        ok: false,
        path,
        holder: { pid: Number(holder?.pid) || undefined, at },
        why: `另一次 SnowLuma 启动正在进行（pid ${holder?.pid ?? '未知'}，${ageS} 秒前开始）`,
      }
    }
  }
  return tryOnce()
}

/** 放锁（删文件；删不掉不算错 —— 过期后会被接管）。 */
function releaseLaunchLock(path) {
  try {
    unlinkSync(path)
  } catch {
    /* 已经不在了 */
  }
}

/** 关句柄，不抛（关不掉不影响锁的语义：锁的语义在**文件存在**）。 */
function closeQuietly(fd) {
  try {
    closeSync(fd)
  } catch {
    /* 无所谓 */
  }
}


/**
 * 从**运行中那份 SnowLuma 自己的配置**里读 OneBot 的 token。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么 token 必须从它那里读，而不是存在我们的 config.json 里
 * ══════════════════════════════════════════════════════════════════════════
 * 踩过两次的真实事故：`config.json` 里的 token 与**正在跑的那个** SnowLuma
 * 不一致 → 桥接被 401 拒绝 → 症状是「令牌被拒」+ **机器人完全不说话**。
 *
 * 最阴的一次：我用脚本把 token 改对了，之后**通过网页保存了一次配置**，
 * 而那次保存把旧 token 当作非空值提交了 —— 于是被合法地写回旧值，
 * 修复被静默推翻。（`mergeConfigPatch` 的行为没错：非空就是"用户要改"。
 * 真正的病根是 **token 存在两处，必然漂移**。）
 *
 * 所以现在：**SnowLuma 自己的 `config/onebot_<uin>.json` 是唯一真源。**
 * 那是它的数据，它启动时按它校验；我们存一份副本只会有分歧没有好处。
 *
 * 找不到时**回退**到 `config.json`（老配置仍能用），但会在返回值里
 * 如实标注 token 来自哪里 —— 排查时这一点很关键。
 *
 * @returns {{httpToken: string|null, wsToken: string|null, source: string|null, file: string|null}}
 */
export function readSnowlumaTokens({ installDir, selfId, knownTokens = {} } = {}) {
  // ★ H8：真正的读+校验搬到了 `token-discovery.mjs`（保守读：拒符号链接、体积/token 长度上限、
  //   拒控制字符、只采纳 enabled 且回环的服务器、**显式账号找不到就绝不复用别的账号**）。
  //   这里保持原有返回形状，另外把 `why` / `picked` / `accounts` 透出去给排查用。
  const d = discoverOnebotConfig({ installDir, selfId, knownTokens })
  return {
    httpToken: d.httpToken,
    wsToken: d.wsToken,
    source: d.ok ? d.source : null,
    file: d.file,
    why: d.why,
    picked: d.picked,
    accounts: d.accounts,
    warn: d.warn ?? '',
  }
}

/**
 * 解析出最终该用哪一组 token。
 *
 * 优先 SnowLuma 自己的配置；找不到才回退 `config.json`。
 */
export function resolveOnebotTokens({ config, installDir }) {
  const cfg = config?.onebot ?? {}
  // ★★ H8：把 config.json 里现有的 token 当作"已知凭据"传下去 ——
  //   多个账号时，**与它一致的那个账号才是我们自己的**（比"取最新"可靠得多）。
  //   真机取证：本机有两个账号文件，最新的是**使用者的** QQ，只按 mtime 挑会挑错。
  const fromSnowluma = readSnowlumaTokens({
    installDir,
    selfId: cfg.selfId,
    knownTokens: { httpToken: cfg.httpToken, wsToken: cfg.wsToken },
  })
  if (fromSnowluma.httpToken || fromSnowluma.wsToken) {
    return {
      httpToken: fromSnowluma.httpToken || cfg.httpToken || '',
      wsToken: fromSnowluma.wsToken || cfg.wsToken || '',
      source: fromSnowluma.source,
      file: fromSnowluma.file,
      // ★ H8：一侧缺失时的原因（例如"那个通道的条目 enabled=false 或 host 不是回环"）
      why: fromSnowluma.why ?? '',
      picked: fromSnowluma.picked ?? 'none',
      accounts: fromSnowluma.accounts ?? [],
      warn: fromSnowluma.warn ?? '',
      // 两者不一致时说清楚 —— 这正是过去静默失败的地方
      differsFromConfig:
        Boolean(cfg.httpToken) && fromSnowluma.httpToken !== cfg.httpToken
          ? true
          : Boolean(cfg.wsToken) && fromSnowluma.wsToken !== cfg.wsToken,
    }
  }
  return {
    httpToken: cfg.httpToken || '',
    wsToken: cfg.wsToken || '',
    source: 'config.json',
    file: null,
    differsFromConfig: false,
    // ★ H8：**为什么没用 SnowLuma 自己的配置**（没装？没那个账号的文件？token 不合法？）
    //   过去这是一段静默回退，而"静默回退到可能过期的 token"正是 401 的源头。
    why: fromSnowluma.why ?? '',
    picked: fromSnowluma.picked ?? 'none',
    accounts: listAccountNames(installDir),
    warn: fromSnowluma.warn ?? '',
  }
}

/**
 * SnowLuma 控制台的默认地址。
 *
 * 取证：SnowLuma 自己的 `config/runtime.json` 里有 `"webuiPort": 5099`，
 * 而它的 `index.mjs` 用 `runtimeConfig.webuiPort || 5099` 起控制台。
 * **所以这是个可能被改的用户设置**，不能在代码里写死 ——
 * 它是配置项 `snowluma.consoleUrl` 的默认值，改了能跟上。
 */
export const DEFAULT_CONSOLE_URL = 'http://127.0.0.1:5099/'

/** 带超时的 fetch。超时不是"失败"，是"没答案" —— 两者在判定里意义不同。 */
async function fetchWithTimeout(url, { timeoutMs, headers, body }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
    return { res }
  } catch (error) {
    return { error: error?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : error?.message ?? String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测 SnowLuma 与 QQ 登录状态。
 *
 * @param {object} opts
 * @param {object} opts.config           归一化后的配置
 * @param {boolean} opts.wsConnected     桥接自己那条事件通道是否连着
 * @param {() => object|null} opts.getLogin  桥接缓存的登录信息
 * @param {boolean} [opts.bridgeRunning] 桥接自己是否在跑（用于 bridge-offline 兜底）
 */
export async function detectSnowluma({ config, wsConnected, getLogin, bridgeRunning = true }) {
  const httpUrl = config?.onebot?.httpUrl ?? ''
  const wsUrl = config?.onebot?.wsUrl ?? ''
  const launchCmd = config?.snowluma?.launchCmd ?? ''
  const launchCwd = config?.snowluma?.launchCwd ?? ''
  // 启动入口可能来自配置，也可能来自自动发现 —— 两者都要算进"能不能启动"。
  // ★ 路径已由 normalizeConfig 解析成绝对路径，这里直接透传，不再二次解析
  //   （二次解析不会出错，但会让"路径到底谁负责解析"这件事变得含糊）。
  const installDir = config?.snowluma?.installDir || undefined
  const located = findSnowluma({ installDir, searchPaths: config?.snowluma?.searchPaths ?? [] })
  const launchTarget = launchCmd || located.cmd || ''
  const timeoutMs = Number(config?.snowluma?.probeTimeoutMs) || DEFAULT_PROBE_MS

  // ★ token 以 **SnowLuma 自己的配置**为准（见 resolveOnebotTokens 的说明）。
  // 存在 config.json 里的那份会漂移，而漂移的症状是"机器人完全不说话"。
  const tokens = resolveOnebotTokens({ config, installDir })
  const httpToken = tokens.httpToken || tokens.wsToken || ''

  const base = {
    endpoint: { httpUrl, wsUrl },
    // 控制台地址也报给界面：它既是"打开控制台"入口的来源，
    // 也是排查"我明明改过雪露马端口"时唯一能对照的值。
    consoleUrl: config?.snowluma?.consoleUrl || DEFAULT_CONSOLE_URL,
    // ★ 实机 BUG-3：首次登录的**引导密码**在哪里（**绝不含密码本身**）。
    //   界面/日志据此告诉用户"去哪个文件、搜什么"，从而掐掉"重装一遍"这条错误路径。
    bootstrap: bootstrapCredentialInfo({
      pkgRoot: PKG_ROOT,
      installDir: installDir ?? located.cwd ?? (located.cmd ? dirname(located.cmd) : null),
      consoleUrl: config?.snowluma?.consoleUrl || DEFAULT_CONSOLE_URL,
    }),
    // ★ 控制台可达性（§2.7.0）：只在"3000 连不上"时才去探（平时不必多花这次请求）。
    //   null = 没探过；true/false = 探过的结果。界面用它区分
    //   「SnowLuma 没在跑」与「在跑但没钩住 QQ」——两者排查方向完全不同。
    consoleReachable: null,
    // token 从哪来的、有没有和 config.json 打架 —— 排查 401 时这两条是关键线索
    tokenSource: tokens.source,
    tokenDiffersFromConfig: tokens.differsFromConfig,
    // ★ 挑账号的依据（`matched-config:` / `explicit-selfId` / `auto-newest:` /
    //   `ambiguous` / `none`）：界面据此区分"多个账号认不出自己"与"只是还没同步"，
    //   这两种情况的处置方式完全不同。不含任何密钥内容。
    tokenPicked: tokens.picked,
    launch: {
      // ★ 语义是"**现在能不能启动**"，而不是"配置里填没填"。
      //   因为 `launchCmd` 留空时实现会自动发现 —— 那时填没填都是能启动的，
      //   报 configured:false 会让界面误把按钮灰掉，而它其实可用。
      configured: Boolean(launchTarget),
      cmd: launchTarget || null,
      // 来源要说实话：配置里填了就是配置，没填则是自动发现的（带候选来源名）。
      from: launchCmd ? 'config.snowluma.launchCmd' : (located.from ?? null),
      cwd: launchCwd || (launchTarget ? dirname(resolve(launchTarget)) : null),
    },
  }

  // ① 桥接自己没在跑 —— 兜底分支。正常打不开界面，所以平时看不到。
  if (!bridgeRunning) {
    return { ...base, status: SNOWLUMA_STATUS.BRIDGE_OFFLINE, httpReachable: false, wsConnected: false, loggedIn: false, login: null, hint: '机器人本体没在运行，探测不了。' }
  }

  // ② 一次真实探测：调一个"能证明已登录"的动作。
  //    用 `get_login_info` 而不是随便什么动作 —— 它既证明服务在、又顺便带回登录状态。
  const { res, error } = await fetchWithTimeout(`${String(httpUrl).replace(/\/+$/, '')}/get_login_info`, {
    timeoutMs,
    headers: {
      'content-type': 'application/json',
      ...(httpToken ? { authorization: `Bearer ${httpToken}` } : {}),
    },
    body: JSON.stringify({}),
  })

  if (!res) {
    // 连不上 3000。先别急着说"SnowLuma 没在跑" —— 它是**钩住 QQ 之后**才开
    // OneBot 端口的（CONFIG-UI.md §2.7.0），而控制台（5099）在钩之前就起来了。
    // 所以探一下控制台来区分两种完全不同的状况：
    //   控制台也不通 → SnowLuma 真没在跑；
    //   控制台通、3000 不通 → 在跑但没钩住 QQ（排查方向是"钩"，不是"启动"）。
    const consoleProbe = await probeConsole(base.consoleUrl, timeoutMs)
    const consoleReachable = consoleProbe.reachable === true
    return {
      ...base,
      status: SNOWLUMA_STATUS.OFFLINE,
      httpReachable: false,
      consoleReachable,
      wsConnected: Boolean(wsConnected),
      loggedIn: false,
      login: null,
      error,
      hint: consoleReachable
        ? 'SnowLuma 在跑，但还没钩住 QQ——OneBot 端口（3000/3001）没开，桥接当然连不上。'
        : 'SnowLuma 没在运行。',
    }
  }

  // ③ token 被拒。SnowLuma 对未授权的常见回应是 401/403。
  if (res.status === 401 || res.status === 403) {
    return {
      ...base,
      status: SNOWLUMA_STATUS.AUTH_FAILED,
      httpReachable: true,
      wsConnected: Boolean(wsConnected),
      loggedIn: false,
      login: null,
      httpStatus: res.status,
      hint: 'SnowLuma 在跑，但不认我们的 token。',
    }
  }

  // ④ 连得上，看它有没有登录。
  let payload = null
  try {
    payload = await res.json()
  } catch {
    /* 非 JSON：端口上可能有别的东西，但至少它是活的 */
  }

  const data = payload?.data ?? payload
  const userId = data?.user_id ?? data?.userId ?? null
  const nickname = data?.nickname ?? null
  const loggedIn = Boolean(userId)

  // ★ 形状必须统一成 `{ userId, nickname }`。
  // OneBot 的 `get_login_info` 返回的是 snake_case 的 `user_id`，
  // 而桥接缓存 / `/api/status` 用的是 camelCase 的 `userId`。
  // 两条路径产出不同形状的话，界面就得写两个兼容分支 —— 那种"看运气"的字段
  // 迟早会在某一条路径上显示空白。
  const normalize = (info) =>
    info && (info.userId || info.user_id)
      ? { userId: String(info.userId ?? info.user_id), nickname: info.nickname ?? '?' }
      : null

  const cached = normalize(getLogin?.() ?? null)
  const login = cached ?? (loggedIn ? { userId: String(userId), nickname: nickname ?? '?' } : null)

  if (!loggedIn && !cached) {
    return {
      ...base,
      status: SNOWLUMA_STATUS.UP_NOT_LOGGED_IN,
      httpReachable: true,
      wsConnected: Boolean(wsConnected),
      loggedIn: false,
      login: null,
      httpStatus: res.status,
      hint: 'SnowLuma 在跑，但 QQ 还没登录。',
    }
  }

  return {
    ...base,
    status: SNOWLUMA_STATUS.CONNECTED,
    httpReachable: true,
    wsConnected: Boolean(wsConnected),
    loggedIn: true,
    login,
    httpStatus: res.status,
    hint: '一切正常。',
  }
}

/**
 * 探一下 SnowLuma 的**控制台**在不在。
 *
 * ── 为什么需要它，以及它为什么**不能**当启动器 ──────────────────────────
 * SnowLuma 有个 Web 控制台（默认 `http://127.0.0.1:5099/`，端口来自它自己的
 * `config/runtime.json` 的 `webuiPort`）。但它**只在 SnowLuma 已经在跑时才存在** ——
 * 所以"点按钮打开控制台"在"SnowLuma 没启动"这个**最需要它的场景**下必然失败。
 *
 * 这不是缺陷，是因果顺序：控制台是 SnowLuma 的一部分。
 * 所以正确的组合是**先试控制台、不通再真的启动进程**（见 startSnowluma）。
 *
 * @returns {Promise<{reachable: boolean, status?: number, title?: string, error?: string}>}
 */
export async function probeConsole(consoleUrl, timeoutMs = DEFAULT_PROBE_MS) {
  const url = String(consoleUrl ?? '').trim()
  if (!url) return { reachable: false, error: '没有配置控制台地址' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // 用 GET：这是个网页而不是 API，POST 会被它当非法请求。
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    if (!res.ok) return { reachable: false, status: res.status, error: `控制台返回 HTTP ${res.status}` }

    // 顺带确认这真是 SnowLuma 的控制台，而不是那个端口上碰巧有别的东西 ——
    // 否则"连上了就报告成功"会在端口被占用时变成误导。
    let title = null
    try {
      const html = await res.text()
      title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? null
    } catch {
      /* 读不到正文也算可达 */
    }
    return { reachable: true, status: res.status, title }
  } catch (error) {
    return {
      reachable: false,
      error: error?.name === 'AbortError' ? `控制台探测超时（${timeoutMs}ms）` : error?.message ?? String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 打开 SnowLuma 的**网页端（控制台）**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这是界面上那个按钮现在做的事（**不再是"启动进程"**）
 * ══════════════════════════════════════════════════════════════════════════
 * 与 `startSnowluma` 的分工：
 *   · `openSnowlumaConsole` —— 界面按钮用。打开 `snowluma.consoleUrl`。
 *   · `startSnowluma`       —— `start.bat` 启动时用。真的把进程拉起来。
 *
 * 为什么这样分：按钮在浏览器里，"打开一个本机网页"是它能确定做到的事；
 * 而"启动一个进程"会开出第二个实例（端口冲突、抢登录态），
 * 且用户本来就有 `start.bat` 负责这件事。按钮只做前者，职责更清楚。
 *
 * 用**后端**去开浏览器（而不是让界面 `window.open`）的原因：
 *   · 不依赖浏览器的弹窗拦截策略；
 *   · 能如实回报"打开了没有"，而不是"我调了 window.open"；
 *   · 与 SnowLuma 不在同一台机器时（理论上）也能给出明确错误。
 *
 * @returns {Promise<{ok: true, data: object} | {ok: false, status: number, error: string}>}
 */
export async function openSnowlumaConsole({ config, log = () => {}, probe = probeConsole, openBrowser = null, platform = process.platform } = {}) {
  const consoleUrl = config?.snowluma?.consoleUrl || DEFAULT_CONSOLE_URL
  const probeTimeoutMs = Number(config?.snowluma?.probeTimeoutMs) || DEFAULT_PROBE_MS

  // 先探一下，好让界面能区分"打开了"和"打开了但那边其实没在跑"。
  const reachable = await probe(consoleUrl, probeTimeoutMs)

  const launch = openBrowser ?? defaultOpenBrowser(platform)
  try {
    await launch(consoleUrl)
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: `没能打开浏览器：${error?.message ?? error}。你可以手动访问 ${consoleUrl}`,
      consoleUrl,
      reachable: reachable.reachable,
    }
  }

  log(`已打开 SnowLuma 网页端：${consoleUrl}（可达=${reachable.reachable}）`)
  return {
    ok: true,
    data: {
      opened: true,
      consoleUrl,
      reachable: reachable.reachable,
      // ★ 如实说明：打开了浏览器 ≠ SnowLuma 在跑。控制台只在它运行时才存在。
      hint: reachable.reachable
        ? '已打开 SnowLuma 网页端。'
        : '已打开浏览器，但那个地址现在没有服务 —— SnowLuma 可能没在运行（它没跑时网页端也不存在）。请先启动 SnowLuma。',
    },
  }
}

/**
 * ★★ **等 SnowLuma 真的起来（并且登录上）再继续** —— `start.bat` 打开网页端之前必须过这一关。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它修的是一个真实缺陷：「拉起来了，但页面开太早」
 * ══════════════════════════════════════════════════════════════════════════
 * 原来的顺序是：`--snowluma`（spawn，**立刻返回**）→ `--open-console`（立刻开浏览器）。
 * 而 SnowLuma 要好几秒才做完这些事：起控制台（5099）→ 钩住 QQ → 开 OneBot 端口（3000/3001）
 * → 完成登录。于是浏览器里看到的是**启动中途**的那一页：显示未登录 / 空列表，
 * 使用者必须**手动刷新**才能看到真正的状态 —— 而"刷新一下就好了"这种症状最容易被当成
 * "偶发"而长期留着。
 *
 * ★ 判据不是"控制台可达"，而是 **`status === 'connected'`**：
 *   控制台在钩住 QQ **之前**就起来了，所以"5099 能打开"完全不代表登录好了。
 *   `connected` 意味着：OneBot 端点在应答、而且**认我们的 token**（`detect()` 真的调了一次
 *   `get_login_info` 并拿到了登录信息）—— 这正是"页面打开就是登录态"的那个时刻。
 *
 * ── 三条早退规则（都是刻意的）──────────────────────────────────────────────
 *   · `connected`   → 成功，立刻返回（已经在跑的情况下**零等待**）；
 *   · `auth-failed` → 也返回（token 被拒时再等一百年也不会变；该让使用者去控制台改 token）；
 *   · 其余（offline / up-not-logged-in）→ 继续等，并**每约 5 秒报一次进度**，
 *     免得看起来像卡死。
 *
 * @param {object} opts
 * @param {object} opts.config
 * @param {() => Promise<object>} opts.detect  与防重复启动**同一个**探测器（`makeLaunchDetect`）
 * @param {(m: string) => void} [opts.log]
 * @param {number} [opts.timeoutMs]  默认 60 秒（SnowLuma 冷启动 + 钩 QQ 的实测上限）
 * @param {number} [opts.pollMs]     默认 1000ms
 * @param {(ms: number) => Promise<void>} [opts.sleep] 测试注入用
 * @returns {Promise<{ok: boolean, status: string, waitedMs: number, polls: number, last: object|null, hint: string}>}
 */
export async function waitForSnowlumaReady({
  config,
  detect,
  log = () => {},
  timeoutMs = 60_000,
  pollMs = 1000,
  sleep = null,
} = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const limit = Math.max(0, Number(timeoutMs) || 0)
  const interval = Math.max(100, Number(pollMs) || 1000)
  const t0 = Date.now()
  let polls = 0
  let last = null
  let nextReport = 0

  for (;;) {
    polls += 1
    try {
      last = typeof detect === 'function' ? await detect() : null
    } catch (error) {
      last = { status: SNOWLUMA_STATUS.OFFLINE, hint: `探测出错：${error?.message ?? error}` }
    }
    const status = String(last?.status ?? SNOWLUMA_STATUS.OFFLINE)

    if (status === SNOWLUMA_STATUS.CONNECTED) {
      return {
        ok: true,
        status,
        waitedMs: Date.now() - t0,
        polls,
        last,
        hint: polls === 1 ? 'SnowLuma 已经在跑且已登录。' : `SnowLuma 已就绪（等了约 ${Math.round((Date.now() - t0) / 1000)} 秒）。`,
      }
    }
    if (status === SNOWLUMA_STATUS.AUTH_FAILED) {
      log('⚠️  SnowLuma 在跑，但它**拒绝我们的 token**（再等也不会变）—— 这就去打开网页端，请在控制台里核对 token。')
      return { ok: false, status, waitedMs: Date.now() - t0, polls, last, hint: last?.hint ?? 'token 被拒，请去控制台核对。' }
    }

    const elapsed = Date.now() - t0
    if (elapsed >= limit) {
      // 如实说清"等到什么程度、现在是什么状态"——不要含糊成"超时了"。
      const why =
        last?.consoleReachable === true
          ? '控制台能打开，但 OneBot 端口还没开 ⇒ **SnowLuma 还没钩住 QQ**（要先启动 QQ，或重启一次 QQ 让它触发注入）'
          : '控制台也还没起来 ⇒ SnowLuma 可能还在冷启动，或者根本没启动成功'
      log(`⚠️  等了 ${Math.round(elapsed / 1000)} 秒还没就绪：${why}。仍会打开网页端，但页面里可能还是未登录状态。`)
      return { ok: false, status, waitedMs: elapsed, polls, last, hint: why }
    }

    if (elapsed >= nextReport) {
      const secs = Math.round(elapsed / 1000)
      const what =
        status === SNOWLUMA_STATUS.UP_NOT_LOGGED_IN
          ? 'SnowLuma 起来了，等 QQ 登录'
          : last?.consoleReachable === true
            ? 'SnowLuma 在跑，等它钩住 QQ 并开 OneBot 端口'
            : '等 SnowLuma 起床'
      log(`⏳ ${what}… ${secs}s / ${Math.round(limit / 1000)}s`)
      nextReport = elapsed + 5000
    }
    await wait(interval)
  }
}

/** 用系统默认程序打开一个 URL。Windows 用 `start`（必须过 cmd）。 */function defaultOpenBrowser(platform) {
  return (url) =>
    new Promise((resolvePromise, reject) => {
      // Windows 的 `start` 是 cmd 内建命令，直接 spawn 会 ENOENT，
      // 所以必须经由 `cmd /c start "" <url>`（那个空引号是"窗口标题"占位，
      // 少了它，带引号的 URL 会被当成标题）。
      const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open'
      const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
      const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: true })
      child.on('error', reject)
      // `start` 立刻返回，不等浏览器；只要它自己没报错就算成功
      child.on('spawn', () => {
        child.unref()
        resolvePromise()
      })
    })
}

/**
 * 造一个给「拉起 SnowLuma」用的探测函数。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有这个工厂，而不是在两个调用点各写一遍
 * ══════════════════════════════════════════════════════════════════════════
 * `startSnowluma` 的第②步（"3000 端口上应答的是不是**正确的那份**"）完全
 * 依赖调用方传进来的 `detect`：不传，`typeof detect !== 'function'` 会让
 * 整段被**静默跳过**。
 *
 * 而调用方有**两个**：
 *   · `start.bat` → `--snowluma` 分支
 *   · 界面按钮那条路（`createApiHandler` 里注入的 startSnowluma）
 *
 * 真实发生过的事：**`--snowluma` 那条路漏传了 detect**，于是 start.bat 的
 * 防重复启动少了一道防线，而界面按钮却是好的 —— 同一个动作在两条路上
 * 行为不同，是最难查的一类缺陷（因为你验证过的那个路径没问题）。
 *
 * 所以这里只留**一个**实现，两边都用它。"两条路一致"就变成结构上必然成立，
 * 而不是靠人记得改两处。
 *
 * ── 关于 `wsConnected` ──────────────────────────────────────────────────
 * 它是**可选**的：`--snowluma` 那条路根本没有桥接连接（那是"只把协议端
 * 拉起来就退出"的模式），所以只能是 false。
 * 但第②步真正的判据从来不是"端口有没有人应答"，而是
 * **用我们自己的 token 去问它**：
 *   · 答 200       → 正确的那份在跑（token 被接受）
 *   · 答 401 / 403 → 端口上是**别的**实例 → 必须继续去启动正确的那份
 * `detectSnowluma` 正是按 token 判的，所以两条路一样有效。
 */
export function makeLaunchDetect({
  config,
  log = () => {},
  wsConnected = () => false,
  getLogin = () => null,
  bridgeRunning = true,
} = {}) {
  return () =>
    detectSnowluma({
      config,
      wsConnected: typeof wsConnected === 'function' ? wsConnected() : Boolean(wsConnected),
      getLogin,
      bridgeRunning,
      log,
    })
}

/**
 * 拉起 SnowLuma 进程（**给 start.bat 用**，不再是界面按钮的行为）。
 *
 * **两步**（因为单独任何一步都不够用）：
 *
 *   ① **先试控制台** —— 已经在跑就没什么可启动的，直接把它作为结果报回去。
 *      这一步同时回答了"到底需不需要启动"，避免开出第二个实例。
 *   ② **控制台不通才真的启动进程** —— 这才是"拉起"。
 *
 * 为什么不能只做 ②：SnowLuma 常见是**带图形外壳**启动的，这时控制台早就有了，
 * 再 spawn 一次会开出第二个实例（端口冲突、甚至抢登录态）。
 * 为什么不能只做 ①：控制台只在已启动时存在，救不了"没启动"这个主场景。
 *
 * @returns {Promise<{ok: true, data: object} | {ok: false, status: number, error: string}>}
 */
export async function startSnowluma(opts = {}) {
  const pkgRoot = opts.pkgRoot ?? PKG_ROOT
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  // ★★★ 0.3.3：**先抢启动锁**，再走原来那三步判断。
  //
  // 为什么判断不够、必须互斥：判断（探控制台 / 问 OneBot / 探端口）和 spawn 之间
  // 隔着几百毫秒到几秒，两次启动同时进入这个窗口时**双方都看到"没人跑"**，
  // 于是都 spawn —— 2026-10-20 10:57:33 的两个实例就是这么来的（见 LAUNCH_LOCK）。
  const lock = acquireLaunchLock({ pkgRoot })
  if (lock.ok === false) {
    return waitForConcurrentLaunch({ ...opts, pkgRoot, log, why: lock.why, holder: lock.holder })
  }
  if (lock.lockError) {
    // 拿不到锁的**其它**原因（权限/目录）：能启动就启动，但要说清"这一次没有互斥保护"。
    log(`⚠️ 启动锁不可用（${lock.lockError}）—— 这一次没有互斥保护，别同时双击两次。`)
  }
  try {
    return await startSnowlumaUnlocked(opts)
  } finally {
    lock.release()
  }
}

/**
 * 另一次启动正在进行 → **不跟着起第二个**，改为等它。
 *
 * ★ 为什么是"等"而不是"直接返回失败"：双击两次的第二次，用户真正想要的就是
 *   "把 SnowLuma 拉起来"。第一次的失败模式恰恰是**两个都起、一个残废**；
 *   这里让第二次变成"等第一个起完"，成功了就报"已在运行"。
 * @returns {Promise<{ok: true, data: object}>}
 */
async function waitForConcurrentLaunch({
  config,
  probe = probeConsole,
  log = () => {},
  consoleUrl: injectedConsoleUrl,
  why = '',
  holder = {},
  waitMs = LAUNCH_LOCK.waitMs,
  pollMs = LAUNCH_LOCK.pollMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const consoleUrl = injectedConsoleUrl || config?.snowluma?.consoleUrl || DEFAULT_CONSOLE_URL
  const probeTimeoutMs = Number(config?.snowluma?.probeTimeoutMs) || DEFAULT_PROBE_MS
  const deadline = now() + Math.max(pollMs, Number(waitMs) || 0)
  log(`⏳ ${why} —— 这次**不跟着再起一个**（两个实例会抢 3000/3001 与 QQ 登录态）。`)
  while (now() < deadline) {
    await sleep(pollMs)
    try {
      const p = await probe(consoleUrl, probeTimeoutMs)
      if (p?.reachable) {
        log(`✅ 另一次启动已经把 SnowLuma 拉起来了（控制台 ${consoleUrl}），这次没有重复启动。`)
        return {
          ok: true,
          data: {
            started: false,
            alreadyRunning: true,
            launchInProgress: true,
            concurrentPid: holder?.pid ?? null,
            consoleUrl,
            consoleTitle: p.title ?? null,
            hint: '另一次启动已经把 SnowLuma 拉起来了，这次没有重复启动。',
          },
        }
      }
    } catch {
      /* 探测失败继续等 */
    }
  }
  // ★ 如实说"等超时了"，但**不要**在这里补起一个：那正是要防的重复启动。
  log(
    `⚠️ 等 ${Math.round((Number(waitMs) || 0) / 1000)} 秒，另一次启动仍未把控制台拉起来 —— ` +
      `先看 logs/snowluma-console.log 有没有报错，**不要立刻再点一次**。`,
  )
  return {
    ok: true,
    data: {
      started: false,
      alreadyRunning: false,
      launchInProgress: true,
      concurrentPid: holder?.pid ?? null,
      consoleUrl,
      hint:
        `另一次 SnowLuma 启动还在进行（pid ${holder?.pid ?? '未知'}），等了 ` +
        `${Math.round((Number(waitMs) || 0) / 1000)} 秒控制台还没起来。` +
        '先看 logs/snowluma-console.log —— 不要立刻再点一次（那会变成两个实例）。',
    },
  }
}

async function startSnowlumaUnlocked({
  config,
  detect,
  log = () => {},
  probe = probeConsole,
  // 可注入（测试用）。默认就是真实实现：
  //   locateSnowluma 负责"SnowLuma 装在哪"，findNode 负责"用哪个 node 跑它"。
  //
  // ★★ 这个默认实现**必须把 `{ installDir }` 转发下去**（真实事故，见下方③）。
  //    原先写的是 `() => findSnowluma()` —— 参数被丢掉，于是 `snowluma.installDir`
  //    形同虚设，`findSnowluma()` 一路走到候选表最后那条
  //    `D:\QQagent_DeepSeek\snowluma` 兜底，**启动了参考项目里的那一份**。
  locateSnowluma = ({ installDir, searchPaths } = {}) => findSnowluma({ installDir, searchPaths }),
  findNode = findNodeBinary,
  // ★ 第三道防线（缺陷 4）：只看"端口上有没有人应答"，不关心授权。
  checkPort = checkPortFree,
  probeAnswered = probeHttpAnswered,
  // ★ 登记自己拉起的 SnowLuma PID（缺陷 4）：以前只把 PID 写进日志就丢了。
  register = registerExternal,
  pkgRoot = PKG_ROOT,
} = {}) {
  const launchCmd = config?.snowluma?.launchCmd ?? ''
  const consoleUrl = config?.snowluma?.consoleUrl || DEFAULT_CONSOLE_URL
  const probeTimeoutMs = Number(config?.snowluma?.probeTimeoutMs) || DEFAULT_PROBE_MS

  // ── ① 控制台已经在？那就没什么要启动的 ──────────────────────────────
  const consoleProbe = await probe(consoleUrl, probeTimeoutMs)
  if (consoleProbe.reachable) {
    log(`SnowLuma 控制台已在运行，未重复启动：${consoleUrl}`)
    return {
      ok: true,
      data: {
        started: false,
        alreadyRunning: true,
        consoleUrl,
        consoleTitle: consoleProbe.title ?? null,
        hint: 'SnowLuma 已经在运行，没有重复启动。',
      },
    }
  }

  // ── ② 控制台不通，再看桥接自己跟 SnowLuma 到底通没通 ────────────────
  //
  // ★ 判据是 `wsConnected`（**桥接自己的事件通道**），**不是** `httpReachable`。
  //
  // 这一条踩过真实的坑：某个**错误的** SnowLuma 实例占着 3000 端口时，
  // `httpReachable` 是 `true` —— 于是"已在跑"成立，**永远不去启动正确的那份**。
  // 而它会用 401 拒绝桥接，症状是「令牌被拒」+ 机器人完全不说话。
  // 也就是说：**"端口有东西在应答"不等于"我们在跟对的那个说话"**。
  // 看桥接自己的连接状态才是真正相关的信号。
  if (typeof detect === 'function') {
    try {
      const cur = await detect()
      // ★ 这两个状态都表示"**正确的那份**已经在服务"（token 被接受了）：
      //   · CONNECTED        —— 已登录，桥接也连上了
      //   · UP_NOT_LOGGED_IN —— 服务在、token 也对，只是 QQ 还没登录
      //
      //   第二种**也必须**短路。它以前会掉到下面去 spawn —— 那会开出第二个实例
      //   （端口冲突、抢登录态），而正确做法是让使用者去控制台扫码登录。
      //   一个进程"没登录"不等于"没在跑"，这两件事不能混。
      if (
        cur?.status === SNOWLUMA_STATUS.CONNECTED ||
        cur?.status === SNOWLUMA_STATUS.UP_NOT_LOGGED_IN
      ) {
        return {
          ok: true,
          data: {
            started: false,
            alreadyRunning: true,
            consoleUrl,
            consoleError: consoleProbe.error ?? null,
            hint:
              cur.status === SNOWLUMA_STATUS.CONNECTED
                ? 'SnowLuma 已经在运行（桥接已连上），没有重复启动。控制台可能关了，或控制台端口改过。'
                : 'SnowLuma 已经在运行，但 QQ 还没登录。**不要再启动一个**（会端口冲突、抢登录态）—— 去它的控制台扫码登录即可。',
          },
        }
      }
      if (cur?.status === SNOWLUMA_STATUS.AUTH_FAILED) {
        // token 被拒 = 3000 上应答的那个**不是**我们该连的实例。
        // 这时**必须继续往下走**去启动正确的那份，否则界面就卡在"令牌被拒"上
        // 再也没有出路。附带说明原因，免得使用者以为是在瞎启动。
        log(
          `检测到 ${config?.onebot?.httpUrl ?? 'OneBot 端点'} 上有服务在跑，但它拒绝了我们的 token ` +
            `（可能是另一个 SnowLuma 实例）。将尝试启动 snowluma.installDir 指定的那一份。`,
        )
      }
    } catch {
      /* 探测失败不影响启动尝试 */
    }
  }

  // ── ③ 确实没在跑，才真的启动 ────────────────────────────────────────
  //
  // 启动入口**优先自动发现**：配 `launchCmd` 是可选的高级用法。
  // 之前把它做成必填是错的 —— 大多数使用者根本不知道该填什么，
  // 而这一步完全可以从"包在哪、工作区在哪"推出来（见 local.mjs 的 findSnowluma）。
  // SnowLuma 装在哪：**优先配置**（normalizeConfig 已解析成绝对路径），没配就交给发现逻辑。
  //
  // ⚠️ 这里的 `installDir` 与 `searchPaths` **必须真的传到 `locateSnowluma` 里**。
  //    默认实现曾经是 `() => findSnowluma()`，参数被丢掉 → 本行白传。
  //    这一条是"启动了错的那份 SnowLuma、机器人全 401"的根因，
  //    详见 `locateSnowluma` 默认值与下面 `cwd` 两处的注释。
  const installDir = config?.snowluma?.installDir || undefined
  const searchPaths = config?.snowluma?.searchPaths ?? []
  const locate = locateSnowluma({ installDir, searchPaths }) ?? { cmd: null, cwd: null, kind: null, from: null }
  const useAuto = !launchCmd
  const cmdRaw = useAuto ? locate.cmd : launchCmd

  // ── ③ 第三道防线：**端口上有没有东西**（缺陷 4）──────────────────────
  //
  // ★ 位置很关键：必须在"入口能不能找到"之前判断。
  //   "端口已被占用"是比"找不到安装"更准确、也更该先说的诊断 ——
  //   端口被占时用户真正需要知道的是"别再起一个"，而不是去修路径。
  //   （第一版把这段放在入口校验之后，结果端口忙时返回的是"找不到 SnowLuma 安装"，
  //     被测试抓出来。）
  //
  // 前两道防线（探控制台 / 用我们自己的 token 问 OneBot）都只覆盖了
  // "对面接受我们的 token"这一种情况。如果 3000 上蹲着的是**别的**东西
  // （另一个 SnowLuma 实例、或任何 HTTP 服务），它答 401/403 —— 于是
  // "端口有东西"这个事实被当成"没人在跑"，我们再 spawn 一个就撞车了：
  // 两个实例抢 3000/3001 与 QQ 登录态，而且都不会自己退出。
  {
    const portOf = (url) => {
      try {
        return Number(new URL(url ?? '').port) || null
      } catch {
        return null
      }
    }
    const httpPort = portOf(config?.onebot?.httpUrl)
    const wsPort = portOf(config?.onebot?.wsUrl)

    const busy = []
    for (const [label, p] of [
      ['HTTP', httpPort],
      ['WebSocket', wsPort],
    ]) {
      if (!p) continue
      const r = await checkPort(p, { timeoutMs: probeTimeoutMs })
      if (r.inUse) busy.push({ label, port: p, detail: r.detail, method: r.method })
    }

    if (busy.length > 0) {
      const probed = httpPort
        ? await probeAnswered(`http://127.0.0.1:${httpPort}/get_login_info`, probeTimeoutMs)
        : { answered: false }
      const who = probed.answered
        ? `端口上有 HTTP 服务在应答（HTTP ${probed.status ?? '?'}）`
        : '端口被占用，但对 HTTP 探测没有应答'
      log(
        `⚠️ 不再启动新的 SnowLuma：${busy.map((b) => `${b.label} ${b.port}`).join('、')} 已被占用 —— ${who}`,
      )
      log('   → 这是刻意的第三道防线：重复启动会让两个实例抢端口与 QQ 登录态，且都不会自己退出。')
      // ★ 0.3.3：把"重复实例长什么样"写清楚 —— 真机上最迷惑的正是这一点：
      //   两个实例会把端口**分掉**，看起来像"某个端口被占了"，其实是起了两次。
      log(
        '   → 两个实例的典型样子：一个占 3000/3001（能用），另一个的网页端**退让到 5100**' +
          '（所以 5099 上那个可能是"残废的那份"，它的适配器全 EADDRINUSE）。',
      )
      log('   → 若那确实是你想用的 SnowLuma（只是 token 不匹配），去它的控制台核对 token，不要重启它。')
      log('   → 若那是残留的旧实例：`node src/index.mjs --processes` 看登记，用 --kill <pid> 停掉它。')
      return {
        ok: true,
        data: {
          started: false,
          alreadyRunning: false,
          portBusy: busy,
          consoleUrl,
          hint:
            `没有启动新的 SnowLuma：${busy.map((b) => `${b.label} 端口 ${b.port}`).join('、')} 已被占用。` +
            '重复启动会抢端口与登录态，所以这里刻意不动手。',
        },
      }
    }
  }

  if (!cmdRaw) {
    return {
      ok: false,
      status: 400,
      error:
        `SnowLuma 控制台（${consoleUrl}）与 OneBot 端点都连不上，而且**没有找到 SnowLuma 安装**，所以启动不了。` +
        '把 SnowLuma 放到工作区根目录的 snowluma/（或本包 vendor/snowluma/），' +
        '或者在「协议端」页签显式填 snowluma.launchCmd。',
      consoleUrl,
      consoleError: consoleProbe.error ?? null,
    }
  }

  const cmdPath = isAbsolute(cmdRaw) ? cmdRaw : resolve(cmdRaw)
  if (!existsSync(cmdPath)) {
    return {
      ok: false,
      status: 400,
      error: `启动入口不存在：${cmdPath}${useAuto ? '' : '（来自 snowluma.launchCmd）'}`,
    }
  }
  let isDir = false
  try {
    isDir = statSync(cmdPath).isDirectory()
  } catch {
    /* 下面按文件处理 */
  }
  if (isDir) {
    // 这是最典型的填错：填了文件夹。明确说清楚，别让人自己猜。
    return {
      ok: false,
      status: 400,
      error: `启动入口填成了文件夹：${cmdPath}。请填 launcher.bat 或 index.mjs 这样的文件。`,
    }
  }

  /**
   * 用哪个工作目录启动 —— 这一行曾经让"启动了错的那份 SnowLuma"真正发生。
   *
   * ★★ 真实事故（2026-09-26，症状＝机器人不在线，OneBot 全部 401）：
   *
   *   当时 `launchCmd` 填的是**项目里**的 `launcher.bat`，而 `locate.cwd`
   *   （因为上面的默认实现丢了 `installDir`）指向 **D: 那份**安装目录。
   *   于是 spawn 出来的是：
   *       cmd /d /s /c "<项目>\snowluma\launcher.bat"   ← 入口路径看着是对的
   *       cwd = D:\QQagent_DeepSeek\snowluma            ← 但工作目录是错的那份
   *   而 `launcher.bat` 里写的是 `node ./index.mjs`（**相对路径**）——
   *   相对的是 cwd，所以**真正跑起来的是 D: 那份代码**，用 D: 的 token。
   *   桥接拿 config.json 的 token 去连 → 每一次握手和请求都被 401 拒绝。
   *
   *   为什么这条极难查：父进程命令行里那个 `launcher.bat` 路径**看起来完全正确**，
   *   要把 cwd 和"批处理里的相对路径相对谁"两件事连起来才想得到。
   *
   * ★ 所以现在的规则是：**你显式填了 `launchCmd`，我就在那个入口所在的目录里启动它。**
   *   这也是最不容易出意外的语义 —— "入口"和"工作目录"天然是配套的。
   *   只有走自动发现时，才用发现到的目录（两者本来就一致）。
   */
  const cwd = config?.snowluma?.launchCwd
    ? resolve(config.snowluma.launchCwd)
    : launchCmd
      ? dirname(cmdPath)
      : (locate.cwd ?? dirname(cmdPath))

  /**
   * 组装 spawn 参数。
   *
   * ★ `.bat` 与 `.mjs` 的启动方式**不同**，这里必须分开：
   *   · `.bat`  → `shell: true`（Windows 上直接 spawn .bat 会 EINVAL）
   *   · `.mjs`  → 必须显式给它一个 node 可执行文件，因为 .mjs 不是可执行程序
   *
   * 用哪个 node：优先**包内自带的**（`vendor/node`）。理由是"包搬走也能用" ——
   * SnowLuma 自己要求 `^22.13.0 || >=23.4.0`，实测包内 v24.9.0 满足。
   */
  const isMjs = cmdPath.toLowerCase().endsWith('.mjs')
  const nodeBin = typeof findNode === 'function' ? findNode() : process.execPath
  const spawnCmd = isMjs ? nodeBin : cmdPath
  const spawnArgs = isMjs ? [cmdPath] : []

  // 注：第三道防线（端口占用检查）在**入口校验之前**（见上面 ── ③ ── 那段）。
  // 放在那里是因为"端口已被占用"比"找不到安装"更该先说。

  try {
    // ★★ 实机 BUG-3 的修复：不再用 `stdio: 'ignore'` 把 SnowLuma 的输出丢掉。
    //
    // 为什么这**不只是**"多一份日志"：SnowLuma 把**首次登录的引导密码**只写 stdout
    // （不写它自己的日志文件），而桥接只读它的日志文件 —— 两条路都不通，用户就
    // 永远看不到那个密码，5099 的登录页进不去，于是"重新下载一份 / 重新注册一遍"
    // 成了唯一看得见的路。代价是整整一轮首次配置。
    //
    // ★ 用**文件句柄**而不是 pipe：老注释担心"管道一端消失后子进程写日志会 EPIPE"，
    //   文件句柄没有这个问题（文件比父进程活得久）。而"重定向会 GBK 乱码"那条
    //   是用 pipe 测出来的，不适用于文件句柄 —— 本机实测 UTF-8 完全正确
    //   （中文与 `initial credentials:` 行逐字对得上，见 snowluma-console.mjs 文件头）。
    const out = openConsoleLog({ pkgRoot, log })
    let child
    try {
      child = spawn(spawnCmd, spawnArgs, {
        cwd,
        // ⚠️ 只有 .bat/.cmd 才走 shell。给 .mjs 也加 shell 会让参数被 cmd 再解析一遍，
        //    路径里有空格或特殊字符时就会出问题。
        shell: !isMjs,
        // ★ 脱离桥接的进程组：关掉桥接**不会**连带杀掉 SnowLuma。
        detached: true,
        // stdout/stderr 都进同一个文件；stdin 仍然 ignore（SnowLuma 不需要输入）。
        stdio: ['ignore', out.fd ?? 'ignore', out.fd ?? 'ignore'],
        windowsHide: true,
      })
    } finally {
      // 父进程这一份句柄用完就关：子进程已经继承了自己的副本，
      // 不关的话桥接每拉起一次 SnowLuma 就泄漏一个句柄。
      closeConsoleLog(out.fd)
    }
    // 让它独立存活（父进程不再持有引用）
    child.unref()
    log(
      `已发起启动 SnowLuma：${cmdPath}` +
        `${useAuto ? `（自动发现：${locate.from}）` : '（来自 snowluma.launchCmd）'}` +
        ` pid ${child.pid ?? '?'}`,
    )
    // ★ 实机 BUG-3：把"凭据在哪个文件"**当场**说清楚。
    //   此刻 SnowLuma 刚起，凭据（如果这次会打印）还没写出来 —— 所以这里只有位置；
    //   真正扫到凭据后的提示由 `detectSnowluma()` 的 `bootstrap.hint` 给（界面会轮询）。
    const bootstrapAtLaunch = bootstrapCredentialInfo({
      pkgRoot,
      installDir: locate.cwd ?? (cmdPath ? dirname(cmdPath) : null),
      consoleUrl,
      text: '',
    })
    log(
      `ℹ️ SnowLuma 的输出已写到 ${bootstrapAtLaunch.relFile}` +
        `（首次登录的引导密码只在它的启动输出里，去那个文件搜 "initial credentials"）`,
    )

    // ★ 登记这个 PID（缺陷 4）。以前它只出现在这一行日志里 ——
    //   于是"我起了哪个 SnowLuma"过一会儿就没人知道了，
    //   更没法回答"要不要停掉它"。现在它进进程登记表，
    //   可以用 `--processes` 看到、用 `--kill <pid>` 停掉。
    let registered = false
    if (child.pid) {
      try {
        const r = register({
          pkgRoot,
          pid: child.pid,
          port: (() => {
            try {
              return Number(new URL(config?.onebot?.httpUrl ?? '').port) || null
            } catch {
              return null
            }
          })(),
          profile: 'snowluma',
          log,
        })
        registered = Boolean(r?.ok)
      } catch (error) {
        // 登记失败**不该**影响启动本身：SnowLuma 已经在跑了，那是既成事实。
        log(`⚠️ 未能登记 SnowLuma 的 PID（不影响它继续运行）：${error?.message ?? error}`)
      }
    }

    return {
      ok: true,
      data: {
        started: true,
        pid: child.pid ?? null,
        cmd: cmdPath,
        cwd,
        // 交代"这个入口是怎么来的"，排查时就不用猜配置到底生效没有
        discoveredBy: useAuto ? locate.from : 'config.snowluma.launchCmd',
        node: isMjs ? nodeBin : null,
        consoleUrl,
        // 让界面/日志能说清"这个 PID 我已经记下来了，可以用 --kill 停"
        pidRegistered: registered,
        // ★ 实机 BUG-3：凭据文件位置（与 detect 那条路同一份实现，界面两边看到的一样）
        consoleLogFile: bootstrapAtLaunch.consoleLogFile,
        bootstrapHint: bootstrapAtLaunch.hint,
        // ★ 只负责"发起"，不负责"等它连上" —— 界面要轮询 detect。
        hint: registered
          ? `已发起启动（pid ${child.pid}，已记入进程登记）。SnowLuma 需要几秒钟才能接受连接，请等状态变成已连接。`
          : '已发起启动。SnowLuma 需要几秒钟才能接受连接，请等状态变成已连接。',
      },
    }
  } catch (error) {
    return { ok: false, status: 500, error: `启动失败：${error.message}` }
  }
}
