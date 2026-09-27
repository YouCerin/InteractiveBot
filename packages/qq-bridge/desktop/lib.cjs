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
 * 谁是"包根"—— 也就是 `config.json` / `src/` / `workspace-qq` / `logs/` 所在的那一层。
 *
 * ★★★ 这里踩过一次**真机才暴露**的坑，改法因此从"猜目录层数"换成了"看证据 + 找标记"：
 *
 *   第一版只在"打包形态"分支下 `resourcesPath/..`，而那个分支的判据是 `app.isPackaged`。
 *   实测（0.2.4 发布包，2026-09-28 01:19 的 `desktop.log`）：
 *
 *       包根 …\InteractBot-0.2.4-win-x64\app            ← 指到了 app\，而不是发布包根
 *       控制台端口 3410 —— 读不到 config.json（ENOENT）—— 用默认端口 3410
 *
 *   两个原因叠在一起：① **`asar: false` 时 `app.isPackaged` 是 `false`**
 *   （Electron 看的是有没有 `app.asar`，而我们**故意**不打 asar）⇒ 打包分支根本没进；
 *   ② 就算进了，`resourcesPath/..` 也**差一级**（`…\app\resources` 的上一级是 `app`，
 *   不是发布包根）。⇒ 后果不是崩，而是**静默用了错的包根**：读不到使用者的配置、
 *   日志写到别的目录、把 `app/` 当成了工作区与配置的所在地。
 *
 *   ∴ 现在的判据按**优先级**来，且每一级都尽量靠证据而不是靠数层数：
 *     ① `INTERACTBOT_PKG_ROOT` —— 由**调用方**显式设置（用户自建的快捷方式，或将来任何启动器）。
 *        这是**唯一**能让"一个包里存在多个可能的根"变得不含糊的办法：设置它的人本来就知道答案。
 *        ★ 0.2.5：包内**不再有 .bat 启动器**（双击 `app\InteractBot.exe` 直接就开），
 *        所以正常启动走的是 ②；① 留给"我知道根在哪、我要明确告诉壳"这种情形。
 *     ② 从起点**逐级向上找"包根标记"**（同时有 `config.example.json` 与 `src/index.mjs`
 *        的那一层就是包根）—— 对"发布包根 / `app/` / `app/resources/app` / 开发侧 `desktop/`"
 *        这四种起点**都成立**，而且不依赖 `isPackaged`、也不依赖打包形态；
 *     ③ 都找不到就返回起点 —— **绝不猜一个看起来像的路径**（猜错的后果是静默用错根，
 *        而"没找到"至少能在日志里说出来）。
 *
 * ⚠️ 改这里之前先读 `mocks/verify-desktop.mjs` 里那几条"真实布局"断言：
 *   它们是**照着发布包的真实目录形状**写的，因为这个坑正是"只测参数、没测布局"漏掉的。
 */
function resolvePkgRoot ({ dirname, env = {}, isPackaged = false, resourcesPath = null } = {}) {
  const { existsSync } = require('node:fs')
  const { dirname: dirOf, join: joinOf, resolve: resolveOf } = require('node:path')

  /**
   * 包根标记：**同时**有 `config.example.json` 与 `src/index.mjs` 的那一层。
   *
   * 为什么用"两个都要"而不是"有一个就算"：
   *   · 只有 `config.example.json` —— 太弱：模板可能被单独放在别处；
   *   · 只有 `src/index.mjs` —— 太弱：桌面壳候选里 `app/resources/app` 也有 `src`? 不，
   *     它没有 `src/`，但**别的项目**可能有，所以标记越具体越不容易指错；
   *   · 两个都要 ⇒ 实测下**只有真正的包根**同时满足（发布包根 ✓ / `app/` ✓ /
   *     `app/resources/app` ✗ / 开发侧 `desktop/` ✗ / 开发侧包根 ✓）。
   */
  const isPkgRoot = (dir) => {
    try {
      return existsSync(joinOf(dir, 'config.example.json')) && existsSync(joinOf(dir, 'src', 'index.mjs'))
    } catch {
      return false
    }
  }

  // ① 启动器显式告诉我们的（最可靠）
  //
  // ⚠️ 末尾的分隔符要先去掉：批处理里 `set "X=%~dp0"` 给的是 `C:\pkg\`（**带尾反斜杠**），
  //    而 `isPkgRoot()` 拼的是 `join(dir, 'config.example.json')` —— `join` 能容忍尾斜杠，
  //    所以**判断本身不受影响**；但把它原样返回会让日志与字符串比较多一个尾斜杠
  //    （出现"两个看起来一样的路径却不相等"）。这里统一归一化。
  const fromEnv = String(env.INTERACTBOT_PKG_ROOT ?? '').trim().replace(/[\\/]+$/, '')
  if (fromEnv && isPkgRoot(fromEnv)) return resolveOf(fromEnv)
  if (fromEnv && !isPkgRoot(fromEnv)) {
    // ⚠️ 说了但不对 —— 不静默忽略：这正是"配置/路径写错却没人知道"的形态
    console.warn(
      `[desktop] ⚠️ INTERACTBOT_PKG_ROOT=${fromEnv} 看起来不是包根` +
        '（缺 config.example.json 或 src/index.mjs）—— 改为按标记向上查找',
    )
  }

  // ② 从起点逐级向上找标记
  const start = dirname ?? process.cwd()
  const roots = []
  let cur = resolveOf(start)
  for (let i = 0; i < 6; i += 1) {
    roots.push(cur)
    if (isPkgRoot(cur)) return cur
    const up = dirOf(cur)
    if (up === cur) break
    cur = up
  }

  // ③ 找不到 —— 把候选说出来，返回起点（不猜）
  console.warn(
    `[desktop] ⚠️ 没找到包根标记（同时有 config.example.json 与 src/index.mjs 的那一层）。\n` +
      `           找过这些：${roots.join(' → ')}\n` +
      '           ⇒ 配置与日志会落在起点下一级；请检查包是否完整（缺 src/ 或 config.example.json）',
  )
  return roots[roots.length - 1] ?? start
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

/**
 * 桥接日志文件在哪：读 `config.json` 的 `ui.logFile`（默认 `logs/bridge.log`）。
 *
 * ★ 立场与 `readUiPort` 一样：读不到也要**说得出话**；但这里必须有**能用的默认值** ——
 *   调用方（桌面壳）只是想"看一眼日志"，不该因为读不到配置就放弃这件事。
 *
 * @returns {{rel:string, why:string}}
 */
function readUiLogFile ({ configPath } = {}) {
  const fallback = join('logs', 'bridge.log')
  if (!configPath) return { rel: fallback, why: '没给 configPath —— 用默认 logs/bridge.log' }
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    const raw = cfg?.ui?.logFile
    if (typeof raw === 'string' && raw.trim() !== '') {
      return { rel: raw.trim(), why: `config.json 的 ui.logFile = ${raw.trim()}` }
    }
    return { rel: fallback, why: 'config.json 没写 ui.logFile —— 用默认 logs/bridge.log' }
  } catch (error) {
    return { rel: fallback, why: `读不到 config.json（${error?.code ?? error?.message}）—— 用默认 logs/bridge.log` }
  }
}

/**
 * 从桥接日志里判断"它是不是已经启动失败了"，好让桌面壳**早点**把原因说出来（0.2.5）。
 *
 * ★★ 为什么需要它（实测真事，就是"exe 长时间无法唤起桥接"那次）：
 *   桥接是 `--background` + `detached` + `stdio:'ignore'` 起来的 —— 它的输出**被丢掉**，
 *   于是它**一秒就死了，桌面壳这边一点声音都听不到**，只能把 `waitForBridge` 的 90 秒
 *   上限等满，然后说一句"等桥接超时"。使用者看到的是"卡着不动"，而不是"缺了 X"。
 *   ⇒ 桥接自己会把原因写进 `logs/bridge.log`（单一真相仍在桥接那边），**壳读它就行**。
 *
 * 判据（**只认桥接自己写的记号，不猜**）：
 *   · 先按 `=== 桥接启动 ===` 切出**最后一次启动**那一段（日志是追加的，上一次的失败
 *     不该粘到这一次）；
 *   · 命中 `❌` / `启动失败` / `Error:` ⇒ 已失败，把**那一行原文**带出来；
 *   · 看到 `桥接已启动` / `已在后台启动` ⇒ 已成功（还在等接口起来，可能只是慢）；
 *   · 都不命中 ⇒ `null`（什么都别说，继续等）。
 *
 * @returns {{failed:boolean,line:string}|null}
 */
function readBridgeLogVerdict (text) {
  if (!text || typeof text !== 'string') return null
  const mark = '=== 桥接启动 ==='
  const idx = text.lastIndexOf(mark)
  const scope = idx >= 0 ? text.slice(idx) : text
  const lines = scope.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-40)
  if (lines.some((l) => /桥接已启动|已在后台启动/.test(l))) return { failed: false, line: '' }
  const bad = lines.filter((l) => /❌|启动失败|Error:/.test(l))
  if (bad.length) return { failed: true, line: bad[bad.length - 1].trim() }
  return null
}

module.exports = {
  DEFAULT_UI_PORT,
  resolvePkgRoot,
  readUiPort,
  readUiLogFile,
  readBridgeLogVerdict,
  consoleUrl,
  statusUrl,
  describeStatus,
  trayTooltip,
  describeStartResult,
  describeWait,
}
