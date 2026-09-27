/**
 * Electron 桌面壳的**纯逻辑**（不 require electron，可离线测试）。
 *
 * 为什么单独一层：本项目最忌讳"说了做不到、而且不报错"。桌面壳里
 * **没有 electron 就跑不起来**的那部分（窗口/托盘/菜单）只能手工验；
 * 而"端口从哪来 / 什么时候算启动好了 / 状态该显示成什么"这些
 * **判断**必须能被离线套件盯着。这道边界就划在这里。
 *
 * ⚠️ 本文件必须保持 **CommonJS + 只用 node 内置模块**：
 *   · 它跑在 Electron 的主进程里（desktop/package.json 没有 `"type":"module"`）；
 *   · 打包时 desktop/ 整个目录被塞进 app，**没有 node_modules 可依赖**
 *     （见 electron-builder.yml 的 files 白名单）。
 */

'use strict'

const { readFileSync } = require('node:fs')
const { join } = require('node:path')

/** UI 配置接口的默认端口。与 `src/config.mjs` 的 `ui.apiPort` 默认值**必须是同一个数**。 */
const DEFAULT_UI_PORT = 3410

/**
 * 谁是"包根"。
 *
 * 两种运行方式下 `__dirname` 不一样：
 *   · 开发机直接 `electron desktop/`：`desktop/` 的上一级；
 *   · 打包后：app 目录 = `resources/app`，而包根是它的上两级
 *     （`<发布包>/resources/app` → `<发布包>`）。
 * 判据用**存在性**（`src/index.mjs` 与 `config.example.json` 都在才算），
 * 而不是数目录层数 —— 数层数会在打包形态变化时**静默指到错的地方**。
 */
function resolvePkgRoot ({ dirname, resourcesPath = null, isPackaged = false } = {}) {
  const candidates = []
  if (isPackaged && resourcesPath) candidates.push(join(resourcesPath, '..'))
  candidates.push(join(dirname, '..'))
  candidates.push(dirname)
  for (const c of candidates) {
    try {
      readFileSync(join(c, 'config.example.json'))
      readFileSync(join(c, 'src', 'index.mjs'))
      return c
    } catch {
      /* 试下一个 */
    }
  }
  // 一个都命不中时不猜：返回开发形态那一层，让上层把"找不到"报出来
  return candidates[0] ?? dirname
}

/**
 * 从 config.json 里读控制台端口。
 *
 * ⚠️ 这里**故意只读一个键**，不 `import` 桥接的 `src/config.mjs`：
 *   那个模块会做整套默认值合并与校验，把一个**只想知道端口的进程**卷进去
 *   （而且要处理它可能抛错）。读不到的每一种情形都必须能说出话，绝不静默取默认值 ——
 *   "改过端口但界面连不上"正是这条会掩盖的事故。
 *
 * @returns {{port:number, source:'config'|'default'|'invalid', why:string, configPath:string}}
 */
function readUiPort ({ configPath, log = () => {} } = {}) {
  if (!configPath) throw new Error('readUiPort 需要 configPath')
  let text
  try {
    text = readFileSync(configPath, 'utf8')
  } catch (error) {
    return {
      port: DEFAULT_UI_PORT,
      source: 'default',
      why: `读不到 config.json（${error?.code ?? error?.message}）—— 用默认端口 ${DEFAULT_UI_PORT}`,
      configPath,
    }
  }
  let cfg
  try {
    cfg = JSON.parse(text)
  } catch (error) {
    return {
      port: DEFAULT_UI_PORT,
      source: 'invalid',
      why: `config.json 不是合法 JSON（${error?.message}）—— 用默认端口 ${DEFAULT_UI_PORT}；请先在控制台里修好配置`,
      configPath,
    }
  }
  const raw = cfg?.ui?.apiPort
  if (raw === undefined || raw === null || raw === '') {
    return {
      port: DEFAULT_UI_PORT,
      source: 'default',
      why: `config.json 没写 ui.apiPort —— 用默认端口 ${DEFAULT_UI_PORT}`,
      configPath,
    }
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    log(`⚠️ config.json 的 ui.apiPort 不是合法端口（${JSON.stringify(raw)}）—— 用默认端口 ${DEFAULT_UI_PORT}`)
    return {
      port: DEFAULT_UI_PORT,
      source: 'invalid',
      why: `ui.apiPort 取值不合法（${JSON.stringify(raw)}）—— 用默认端口 ${DEFAULT_UI_PORT}`,
      configPath,
    }
  }
  return { port: n, source: 'config', why: `config.json 的 ui.apiPort = ${n}`, configPath }
}

/** 控制台地址。★ 只用 127.0.0.1（接口只监听回环，见 CONFIG-UI.md §5）。 */
function consoleUrl (port) {
  return `http://127.0.0.1:${port}/`
}

/** `GET /api/status` 的地址。 */
function statusUrl (port) {
  return `http://127.0.0.1:${port}/api/status`
}

/**
 * 把 `/api/status` 的返回翻译成"人话 + 该亮什么颜色的灯"。
 *
 * ★ 为什么要单列：界面上那条状态条是**桥接自己**渲染的，而托盘的提示文本与
 *   "启动失败时该说什么"归桌面壳。两处若各写一套判断，就会出现在一边说
 *   "已连上"、另一边说"未连接"的情形 —— 那比不显示更坏。
 *
 * ★★ 字段名是**照 `src/index.mjs` 的 `getStatus()` 抄的**（不是猜的）：
 *   顶层 `connected`（OneBot 连没连上）+ `login: {userId, nickname} | null`
 *   （登录成没成功）。第一版这里写的是 `connection.connected` —— 一个**不存在**
 *   的字段，于是无论怎样都落进"状态未知"。这正是本项目最忌讳的那类缺陷：
 *   不报错、只是永远说一句没用的话。
 */
function describeStatus (payload) {
  if (!payload || typeof payload !== 'object') {
    return { level: 'down', short: '桥接未运行', detail: '配置接口没有响应' }
  }
  const login = payload.login ?? null
  const nickname = login?.nickname || login?.userId || null
  if (payload.connected === true && nickname) {
    return { level: 'ok', short: `已连上（${nickname}）`, detail: '协议端在线，可以收发消息' }
  }
  if (payload.connected === true) {
    return { level: 'warn', short: '协议端已连接，但还没登录 QQ', detail: '去 SnowLuma 控制台扫码登录' }
  }
  // ★ connected === false 与"这个字段根本没有"要分开说：前者是"连不上"，
  //   后者是"这个桥接版本不报这一项"。混成一句会让升级后的人以为是自己坏了。
  if (payload.connected === false) {
    return { level: 'warn', short: '协议端未连接', detail: 'SnowLuma 没在跑，或端口/token 不对' }
  }
  return { level: 'warn', short: '桥接在跑（状态未知）', detail: '接口没报连接状态' }
}

/** 托盘提示（有长度上限，超了会被 Windows 截断，所以这里自己截）。 */
function trayTooltip ({ status, version, port } = {}) {
  const s = status?.short ?? '状态未知'
  const v = version ? ` · v${version}` : ''
  const t = `InteractBot${v} — ${s}（:${port ?? DEFAULT_UI_PORT}）`
  return t.length > 120 ? `${t.slice(0, 119)}…` : t
}

/**
 * 启动完成后该显示什么。
 *
 * ★ 单独成函数的理由：这是**唯一**一处能决定"界面里看到的东西是不是真的"的地方。
 *   失败时必须原样带上子进程的原文（退出码 + 输出），不能只说"启动失败"。
 */
function describeStartResult ({ code, stdout = '', stderr = '', spawnError = null } = {}) {
  const out = String(stdout)
  const err = String(stderr)
  const both = `${out}\n${err}`
  // `--background` 在**已经有一个桥接在跑**时是 exit 1 + 这句提示。
  // 那不是失败：桌面壳只想知道"有没有在跑"，有就够了。
  if (/已经有一个桥接在运行/.test(both)) {
    return { ok: true, alreadyRunning: true, message: '已经有一个桥接在运行 —— 直接连上去' }
  }
  if (spawnError) {
    return { ok: false, alreadyRunning: false, message: `起不来：${spawnError.message ?? spawnError}` }
  }
  if (code === 0) {
    const pid = /pid\s+(\d+)/.exec(out)?.[1] ?? null
    return { ok: true, alreadyRunning: false, pid, message: pid ? `已发起启动（pid ${pid}）` : '已发起启动' }
  }
  const tail = both.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' / ')
  return {
    ok: false,
    alreadyRunning: false,
    message: `启动失败（退出码 ${code}）${tail ? `：${tail}` : ''}`,
  }
}

/**
 * 启动期提示的措辞。
 *
 * ★ "还要等多久"必须给：桥接要连协议端、MCP、能力块，实测不是一瞬。
 *   只说"正在启动"会让人以为卡住了，然后去重复双击 —— 那会撞上单实例锁
 *   （看起来像"双击没反应"）。所以这里把**已用时长**也报出来。
 */
function describeWait ({ elapsedMs = 0, attempts = 0, phase = 'bridge' } = {}) {
  const secs = Math.max(0, Math.round(elapsedMs / 1000))
  if (phase === 'snowluma') {
    return { text: `正在启动 SnowLuma（协议端）… 已等 ${secs} 秒`, hint: '第一次启动要等它把 OneBot 端口开起来' }
  }
  if (phase === 'probe') {
    return { text: `正在确认桥接是不是已经在跑… 已等 ${secs} 秒`, hint: '已经有一个在跑的话就直接连上去，不会起第二个' }
  }
  if (secs < 3) return { text: `正在连接桥接… 已等 ${secs} 秒（第 ${attempts} 次探测）`, hint: '' }
  if (secs < 20) return { text: `桥接正在启动… 已等 ${secs} 秒`, hint: '它在连协议端、装工具、读记忆' }
  return { text: `还在等桥接… 已等 ${secs} 秒`, hint: '如果超过 90 秒还没好，点「看日志」看看卡在哪' }
}

module.exports = {
  DEFAULT_UI_PORT,
  resolvePkgRoot,
  readUiPort,
  consoleUrl,
  statusUrl,
  describeStatus,
  trayTooltip,
  describeStartResult,
  describeWait,
}
