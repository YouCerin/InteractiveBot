/**
 * 体检（doctor）：把"连不上 / 一直 401 / 谁都不回"这类问题的原因，
 * 在启动之前就查出来。
 *
 * ── 为什么值得单独做一个文件 ───────────────────────────────────────────
 * 桥接的失败模式有一个共同特点：**QQ 那边看不出区别**。端口填错、token
 * 填反、管理员没配、DSH 找不到 —— 四种完全不同的原因，在 QQ 里都表现成
 * "机器人不说话"。如果不体检，排查就得靠猜。
 *
 * 所以这个模块的职责是：把每一项都能**独立地**试一遍，并给出可执行的建议。
 *
 * ── 它做什么、不做什么 ─────────────────────────────────────────────────
 * 只做只读探测：
 *   · 检查包内依赖（Node / ws / 工作区）
 *   · 检查 DSH 是否能定位
 *   · 检查配置是否自洽（fail-closed 项、端口重复、关键词风险）
 *   · 真的去连一次 OneBot 的 HTTP 与 WebSocket，把**实际**结果报出来
 * 它**不会**发 QQ 消息、**不会**调用大模型。
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS, findDshCli, findNodeBinary } from './local.mjs'
import { assertVendored, vendorRequire } from './vendor.mjs'

const TIMEOUT_MS = 5000

/**
 * 握手成功后的观察窗。用来识别"先升级、再立刻用 close code 踢掉"的拒绝方式
 * （SnowLuma 未授权时就是 close(4401)）。太长会拖慢体检，太短会漏判。
 */
const GRACE_MS = 400

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 检查 token 里有没有非 ASCII 字符。
 *
 * ── 为什么需要这个检查（真实踩过）──────────────────────────────────────
 * HTTP 头只允许 ASCII。如果 token 里混进中文或全角标点（复制粘贴时很常见，
 * 比如全角冒号、中文空格），fetch / ws 会抛出一句**完全看不懂**的底层错误：
 *   "Cannot convert argument to a ByteString because the character at index 7..."
 * 用户看到这句话根本想不到是"token 里有中文"。
 *
 * 所以我们在探测**之前**先自己检查一遍，给出人话版的诊断。
 *
 * @returns {string|null} 有问题的说明；没问题返回 null
 */
function findNonAsciiToken(which, token) {
  if (!token) return null
  const bad = [...String(token)].findIndex((ch) => ch.codePointAt(0) > 0x7f)
  if (bad < 0) return null
  const ch = [...String(token)][bad]
  return (
    `${which} 里含有非 ASCII 字符（第 ${bad + 1} 个字符是「${ch}」，` +
    `码点 U+${ch.codePointAt(0).toString(16).toUpperCase()}）。` +
    `HTTP 头只允许 ASCII —— 多半是复制粘贴时带进了中文标点或全角空格，请重新复制。`
  )
}

/** 探测一个 TCP 端口是否有东西在监听（用 HTTP 请求近似判断）。 */
async function probeHttp(url, token) {
  const tokenError = findNonAsciiToken('httpToken', token)
  if (tokenError) return { reachable: false, error: tokenError }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    // 故意调用一个不存在的 action：能连上会返回非 JSON 或 retcode 错误，
    // 连不上会抛网络错误。两种结果我们都能区分。
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    })
    const text = await response.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      /* 非 JSON 也算连通 */
    }
    return { reachable: true, status: response.status, body, raw: text.slice(0, 200) }
  } catch (error) {
    return {
      reachable: false,
      error: error?.name === 'AbortError' ? `超时（${TIMEOUT_MS}ms）` : error.message,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 连一次 WebSocket，判断握手是否成功。
 * @returns {Promise<{ok: boolean, code?: number, error?: string}>}
 */
function probeWebSocket(url, token, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    // 协议检查：WebSocket 必须用 ws:// 或 wss://。用 http:// 开头的地址会
    // 让底层直接抛错，用户不容易联想到"协议写错了"。
    const protocolError = (() => {
      try {
        const p = new URL(url).protocol
        if (p === 'ws:' || p === 'wss:') return null
        return `wsUrl 的协议是 ${p}，应该是 ws:// 或 wss://（HTTP 地址不能用作事件通道）`
      } catch {
        return `wsUrl 不是合法 URL：${url}`
      }
    })()
    if (protocolError) return resolve({ ok: false, error: protocolError })

    const tokenError = findNonAsciiToken('wsToken', token)
    if (tokenError) return resolve({ ok: false, error: tokenError })

    let settled = false
    let graceTimer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(graceTimer)
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      resolve(result)
    }

    let socket
    try {
      assertVendored('ws')
      const WebSocket = vendorRequire('ws')
      const target = new URL(url)
      if (token && !target.searchParams.has('access_token')) {
        target.searchParams.set('access_token', token)
      }
      socket = new WebSocket(target, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    } catch (error) {
      return resolve({ ok: false, error: `无法发起连接：${error.message}` })
    }

    const timer = setTimeout(() => finish({ ok: false, error: `握手超时（${timeoutMs}ms）` }), timeoutMs)

    // ⚠️ 不能在 'open' 时就宣布成功。有些实现（SnowLuma 就是这样）会先
    // 完成 WebSocket 升级、再立刻用 close code 表示"你 token 不对"。
    // 如果一 open 就返回成功，体检会对一个其实连不上的配置报 ✅ —— 这是
    // 最坏的一类 bug：体检说你没问题，你却在 QQ 里对着空气等。
    //
    // 所以 open 之后留一个很短的观察窗，看服务端会不会马上踢掉我们。
    socket.on('open', () => {
      clearTimeout(timer)
      graceTimer = setTimeout(() => finish({ ok: true, handshakeVerified: true }), GRACE_MS)
    })
    socket.on('unexpected-response', (_req, res) => {
      clearTimeout(timer)
      clearTimeout(graceTimer)
      finish({
        ok: false,
        code: res.statusCode,
        error:
          res.statusCode === 401 || res.statusCode === 403
            ? `握手被拒绝 HTTP ${res.statusCode}（wsToken 多半不对）`
            : `握手被拒绝 HTTP ${res.statusCode}`,
      })
    })
    // 有些实现是先完成 upgrade、再用 close code 表示拒绝（SnowLuma 就是这么做的：
    // 未授权时 close(4401)）。只看 unexpected-response 会漏掉这种情况。
    socket.on('close', (code, reason) => {
      clearTimeout(timer)
      clearTimeout(graceTimer)
      if (code === 4401 || code === 4403) {
        finish({ ok: false, code, error: `握手后被服务端拒绝（close code ${code}，wsToken 多半不对）` })
      } else if (!settled) {
        finish({ ok: false, code, error: `连接被关闭（code ${code}${reason ? ` ${reason}` : ''}）` })
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      clearTimeout(graceTimer)
      finish({ ok: false, error: error.message })
    })
  })
}

/**
 * 跑完整套体检。
 * @param {object} opts
 * @param {object} opts.config
 * @param {(config: object) => {fatal: string[], warn: string[]}} opts.validate
 * @param {number} [opts.expectedHttpPort] 期望的 HTTP 端口（用于端口核对）
 * @param {number} [opts.expectedWsPort]   期望的 WS 端口
 * @returns {Promise<{fatal: string[], warn: string[], rows: object[]}>}
 */
export async function runDoctor({ config, validate, expectedHttpPort, expectedWsPort, processes = null }) {
  const rows = []
  const fatal = []
  const warn = []

  // ── 0. 进程登记：有没有"另一个桥接也在跑"（缺陷 3）──────────────────────
  // 为什么把它放最前面：这是唯一一类"体检能看出、但症状表现得完全像别的问题"
  // 的故障 —— 两个桥接同时从同一个 OneBot 收事件时，同一句话可能被回两次，
  // 而每一个实例自己看上去都完全正常。
  if (Array.isArray(processes)) {
    const running = processes.filter((p) => p.state === 'alive' || p.state === 'stale')
    const others = running.filter((p) => !p.isSelf)
    rows.push({
      group: '进程',
      name: '同时运行的桥接数量',
      ok: others.length === 0,
      detail:
        others.length === 0
          ? `只有本进程（pid ${processes.find((p) => p.isSelf)?.pid ?? '?'}）`
          : `**还有 ${others.length} 个**：` +
            others.map((p) => `pid ${p.pid}（${p.reason ?? p.state}）`).join('、') +
            '。同时跑两个会抢同一个 OneBot 事件流 —— 用 `node src/index.mjs --processes --kill <pid>` 停掉多余的',
    })
    const stale = processes.filter((p) => p.state === 'stale')
    if (stale.length) {
      rows.push({
        group: '进程',
        name: '心跳过期的登记',
        ok: false,
        detail:
          stale.map((p) => `pid ${p.pid}：${p.reason}`).join('、') +
          '（进程还在但很久没刷新心跳，可能卡住了）',
      })
    }
  }

  // ── 1. 包内依赖 ─────────────────────────────────────────────────────────
  const nodeBin = findNodeBinary()
  rows.push({
    group: '包内依赖',
    name: 'Node 运行时',
    ok: nodeBin !== null,
    detail: nodeBin ?? '未找到（执行 node setup.mjs --force 重新准备）',
  })

  let wsOk = false
  let wsDetail = ''
  try {
    assertVendored('ws')
    wsOk = true
    wsDetail = join(DIRS.vendorNodeModules, 'ws')
  } catch (error) {
    wsDetail = error.message.split('\n')[0]
  }
  rows.push({ group: '包内依赖', name: 'ws 依赖（vendor）', ok: wsOk, detail: wsDetail })

  // ── 2. 工作区 ───────────────────────────────────────────────────────────
  const ws = config.dsh.workspace
  let wsExists = existsSync(ws)
  let wsWritable = false
  try {
    mkdirSync(ws, { recursive: true })
    wsExists = existsSync(ws)
    // 真写一个文件再删掉，比看权限位可靠（Windows 上权限位经常骗人）
    const probe = join(ws, '.doctor-write-probe')
    const { writeFileSync, unlinkSync } = await import('node:fs')
    writeFileSync(probe, 'x')
    unlinkSync(probe)
    wsWritable = true
  } catch (error) {
    wsWritable = false
  }
  rows.push({
    group: '包内依赖',
    name: '工作区（权限沙箱的根）',
    ok: wsExists && wsWritable,
    detail: wsExists ? (wsWritable ? ws : `${ws}（不可写）`) : `${ws}（无法创建）`,
  })

  // ── 3. DSH ──────────────────────────────────────────────────────────────
  // 用配置里那份 cliPath；没有就按**同一张候选表**去找，并**带上配置的 searchPaths**
  // —— 否则会出现"启动能找到、体检说找不到"这种自相矛盾（用户会以为程序坏了）。
  const cli = config.dsh.cliPath ?? findDshCli({ searchPaths: config.dsh.searchPaths ?? [] })
  rows.push({
    group: 'DSH',
    name: 'DSH CLI 能否定位',
    ok: Boolean(cli && existsSync(cli)),
    detail:
      cli && existsSync(cli)
        ? cli
        : '未找到。DSH 不随本包分发，需要自己安装；可用环境变量 DSH_DESKTOP_APP 或 config.json 的 dsh.searchPaths 指定',
  })
  rows.push({
    group: 'DSH',
    name: '权限模式',
    ok: config.dsh.permissionMode === 'workspace-write',
    detail:
      config.dsh.permissionMode === 'workspace-write'
        ? 'workspace-write（只限工作区，符合既定决策）'
        : `${config.dsh.permissionMode}（注意：这与"权限只限工作区"的决定不同）`,
  })

  // ── 4. 配置自洽性（复用启动时的同一套校验，避免两套规则漂移）───────────
  const { fatal: cfgFatal, warn: cfgWarn } = validate(config)
  fatal.push(...cfgFatal)
  // ⚠️ 去重：这些警告在入口处已经打印过一次了，体检里再原样列一遍
  // 会让输出看起来像"出了两个问题"。同一句话只说一次。
  for (const w of cfgWarn) {
    if (!warn.includes(w)) warn.push(w)
  }

  rows.push({
    group: '配置',
    name: '管理员白名单',
    ok: config.access.adminUsers.length > 0,
    detail:
      config.access.adminUsers.length > 0
        ? config.access.adminUsers.join(', ')
        : '为空 = 谁都不能用（fail-closed）。请在 config.json 填入你的 QQ 号',
  })

  // 端口核对：真实 SnowLuma 是 3000(HTTP) / 3001(WS) 两个端口。
  // 但有些 OneBot 实现把 HTTP 与 WS 放在同一端口（靠 upgrade 区分），
  // 所以"两个端口相同"本身不算错 —— 只有当调用方明确给出了期望端口时，
  // 才按期望值核对。
  const portProblem = (() => {
    try {
      const httpPort = new URL(config.onebot.httpUrl).port
      const wsPort = new URL(config.onebot.wsUrl).port
      if (expectedHttpPort != null && httpPort !== String(expectedHttpPort)) {
        return `httpUrl 端口是 ${httpPort}，期望 ${expectedHttpPort}`
      }
      if (expectedWsPort != null && wsPort !== String(expectedWsPort)) {
        return `wsUrl 端口是 ${wsPort}，期望 ${expectedWsPort}`
      }
      return null
    } catch {
      return 'OneBot 的 URL 不合法'
    }
  })()
  rows.push({
    group: '配置',
    name: 'OneBot 端口',
    ok: portProblem === null,
    detail:
      portProblem ??
      `${new URL(config.onebot.httpUrl).port}(HTTP) / ${new URL(config.onebot.wsUrl).port}(WS)`,
  })

  rows.push({
    group: '配置',
    name: '群聊开关',
    ok: config.trigger.groupEnabled === false,
    detail: config.trigger.groupEnabled ? '已开启（有账号风控风险）' : '已关闭（第一版决策）',
  })

  rows.push({
    group: '配置',
    name: 'accessToken 是否都已配置',
    ok: Boolean(config.onebot.wsToken && config.onebot.httpToken),
    detail: config.onebot.wsToken && config.onebot.httpToken ? '两个都已配置' : '有一个为空',
  })

  // ── 5. 真实探测 OneBot（这是最有价值的一步）────────────────────────────
  const httpProbe = await probeHttp(`${config.onebot.httpUrl}/get_login_info`, config.onebot.httpToken)
  rows.push({
    group: '协议端探测',
    name: 'HTTP API（发送通道）',
    ok: httpProbe.reachable && httpProbe.status === 200,
    detail: httpProbe.reachable
      ? httpProbe.status === 200
        ? `HTTP 200${httpProbe.body?.data?.nickname ? ` · 已登录 ${httpProbe.body.data.nickname}(${httpProbe.body.data.user_id})` : ''}`
        : `HTTP ${httpProbe.status} · ${httpProbe.raw}`
      : `连不上：${httpProbe.error}`,
  })

  const wsProbe = await probeWebSocket(config.onebot.wsUrl, config.onebot.wsToken)
  rows.push({
    group: '协议端探测',
    name: 'WebSocket（事件通道）',
    ok: wsProbe.ok,
    detail: wsProbe.ok ? '握手成功' : wsProbe.error,
  })

  // 连不上的话给一条可执行的建议，而不是只报错
  if (!httpProbe.reachable && !wsProbe.ok) {
    warn.push(
      '协议端两个通道都连不上。若 SnowLuma 还没启动，请先启动并扫码登录；' +
        '它的 OneBot 端口只有在 QQ 登录成功后才会开始监听。',
    )
  } else if (httpProbe.reachable && !wsProbe.ok) {
    warn.push(
      'HTTP 通但 WebSocket 不通。检查 wsUrl 是否指向了 HTTP 端口；' +
        'SnowLuma 默认 3000=HTTP、3001=WebSocket。',
    )
  }

  // ── 6. 日志目录 ─────────────────────────────────────────────────────────
  const logDir = join(DIRS.logs)
  try {
    mkdirSync(logDir, { recursive: true })
  } catch {
    /* ignore */
  }
  let logCount = 0
  try {
    logCount = readdirSync(logDir).length
  } catch {
    /* ignore */
  }
  rows.push({
    group: '运行环境',
    name: '日志目录',
    ok: true,
    detail: `${logDir}（已有 ${logCount} 个文件）`,
  })

  return { fatal, warn, rows }
}

/** 把体检结果打印成人能看的样子。 */
export function printDoctor({ fatal, warn, rows }) {
  const groups = [...new Set(rows.map((r) => r.group))]
  console.log('\n═══ 桥接体检 ═══')
  for (const group of groups) {
    console.log(`\n── ${group} ──`)
    for (const row of rows.filter((r) => r.group === group)) {
      console.log(`  ${row.ok ? '✅' : '❌'} ${row.name}`)
      console.log(`      ${row.detail}`)
    }
  }
  if (warn.length) {
    console.log('\n── 提醒 ──')
    for (const w of warn) console.log(`  ⚠️  ${w}`)
  }
  if (fatal.length) {
    console.log('\n── 必须修复（否则无法启动）──')
    for (const f of fatal) console.log(`  ❌ ${f}`)
  }
  const allOk = fatal.length === 0 && rows.every((r) => r.ok)
  console.log(`\n${allOk ? '🎉 全部就绪' : fatal.length ? '⛔ 有致命问题，先修上面标 ❌ 的项' : '⚠️ 能启动，但上面有 ❌ 项需要处理'}\n`)
  return allOk
}
