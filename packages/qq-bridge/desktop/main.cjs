/**
 * InteractBot 桌面壳（Electron 主进程）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它为什么存在 / 它**不**做什么
 * ══════════════════════════════════════════════════════════════════════════
 * 0.2.3 及以前，"控制台"是**浏览器里的一个页面**：start.bat 用 `start http://…`
 * 把它丢给默认浏览器。于是它和你的几十个标签页抢位置、关掉就找不回来、
 * 而且"机器人到底还活着吗"只能靠再去点一次那个地址。
 *
 * 这一层把**同一份界面**（`config-ui/dist`，一行没改）装进一个真正的程序窗口，
 * 并顺手把"启动方式"这件事接管过来：
 *
 *   双击 InteractBot.exe → 需要就起桥接（和 SnowLuma）→ 开窗口
 *   关窗口 = 收到托盘（机器人**继续在线**）
 *   托盘菜单 = 开窗口 / 重启 / 停止 / 看日志 / 退出
 *
 * ★★ 三条不能违反的边界（都在下面的代码里逐处注明）：
 *   ① **不重写 UI**。窗口加载的就是桥接自己伺服的 `http://127.0.0.1:<端口>/`，
 *      所以"界面源码 → 产物 → 桌面窗口"只有一条链路，不存在第二份界面。
 *   ② **不重写启动逻辑**。起桥接一律走 `node src/index.mjs --background`
 *      （它自己会做"已经有桥接在跑"的判断与提示，见 src/index.mjs 那段注释）。
 *      桌面壳**不**自己拼 spawn 参数 —— 两份启动逻辑必然分叉。
 *   ③ **不猜路径**。包根由 `lib.cjs` 的 `resolvePkgRoot()` 按**存在性**判定，
 *      Node 运行时优先 `vendor/node/node.exe`（与 start.bat 同一套规则）。
 *
 * ⚠️ 本文件里**每一处失败都必须说话**（状态行 / 托盘提示 / 日志文件 / 弹窗）：
 *   这个项目最该避免的失败模式就是"双击了、什么都没发生、也没有任何提示"。
 */

'use strict'

const { app, BrowserWindow, Menu, Tray, shell, dialog, nativeImage, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync, readFileSync, mkdirSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')

const lib = require('./lib.cjs')

/**
 * 包根：`config.json` / `src/` / `workspace-qq` / `logs/` 所在的那一层。
 *
 * ★ 三个输入缺一不可（`lib.cjs` 的 `resolvePkgRoot` 里逐条解释了为什么）：
 *   · `env` —— 启动器（`启动机器人.bat` / `start.bat`）会显式设 `INTERACTBOT_PKG_ROOT`，
 *     那是**唯一**能让"一个包里多个可能的根"不含糊的证据；
 *   · `appPath` —— `app.getAppPath()`，打包后是 `…\app\resources\app`、开发时是 `desktop/`；
 *   · 向上找"包根标记" —— 前两者都没有时按证据找（同时有 `config.example.json` 与 `src/index.mjs`）。
 *
 * ⚠️ 第一版这里传的是 `process.resourcesPath` 且依赖 `app.isPackaged` —— 实测在
 *   `asar: false` 的发布包里 `isPackaged === false`，于是**静默指到了 `app\`**：
 *   读不到使用者的 config.json（日志里写着 `ENOENT`）、把日志写进了 `app\logs\`。
 */
const PKG_ROOT = lib.resolvePkgRoot({
  dirname: app.getAppPath(),
  env: process.env,
  isPackaged: app.isPackaged,
})

/** 桌面壳自己的日志。与桥接的 logs/bridge.log 分开：混在一起会互相淹没。 */
const DESKTOP_LOG = join(PKG_ROOT, 'logs', 'desktop.log')

/** 一次探测的超时。短一点：本机回环，慢就是没起来。 */
const PROBE_TIMEOUT_MS = 2500
/** 等桥接起来的上限。桥接要连协议端 + 装配能力块，实测要几十秒。 */
const WAIT_BRIDGE_MS = 90_000
/** 等 SnowLuma 的上限（它要开 OneBot 端口）。 */
const WAIT_SNOWLUMA_MS = 60_000

const state = {
  port: lib.DEFAULT_UI_PORT,
  portWhy: '',
  status: { level: 'down', short: '还没连上', detail: '正在启动' },
  account: '',
  window: null,
  tray: null,
  quitting: false,
  quitAsked: false,
  startedBy: null, // 'launcher' = 这个桌面壳起的；null = 本来就在跑（那就不该由我们停掉）
  pollTimer: null,
  lastMinimizeNotice: 0,
}

// ─────────────────────────────────────────────────────────────────────────────
// 日志（同步写，量极小；失败只吞日志本身，绝不影响运行）
// ─────────────────────────────────────────────────────────────────────────────
function logLine (msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try {
    mkdirSync(join(PKG_ROOT, 'logs'), { recursive: true })
    appendFileSync(DESKTOP_LOG, `${line}\n`, 'utf8')
  } catch (error) {
    // ⚠️ 原来这里是空 catch ⇒ 日志写不进去时**完全没有痕迹**（真机上就这样过一次：
    //   会话跑了 10 分钟，`logs/desktop.log` 却不存在，而那是排障的第一入口）。
    //   现在至少往 stderr 喊一句 —— 桌面壳的 stderr 会被启动器/终端看到。
    //   ★ 还不完美（GUI 直接双击时没有终端），所以"回退到用户数据目录"留作下一版的修法。
    if (!logLine.warned) {
      logLine.warned = true
      console.error(`[desktop] ⚠️ 写不进日志文件 ${DESKTOP_LOG}（${error?.code ?? error?.message}）—— 本次运行的日志只在这个终端的输出里`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 与桥接的配置接口说话
// ─────────────────────────────────────────────────────────────────────────────
async function probe (timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const res = await fetch(lib.statusUrl(state.port), {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` }
    const json = await res.json()
    // 桥接的接口约定：`{ ok: true, data: … }`（见 src/api.mjs 的 ok()/fail()）
    if (json?.ok !== true) return { ok: false, why: json?.error ?? '接口回了 ok:false' }
    return { ok: true, data: json.data ?? {} }
  } catch (error) {
    const msg = error?.name === 'TimeoutError' ? '探测超时' : (error?.cause?.code ?? error?.message ?? String(error))
    return { ok: false, why: String(msg) }
  }
}

async function apiGet (path, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
    const json = await res.json().catch(() => null)
    if (!res.ok || json?.ok !== true) return { ok: false, why: json?.error ?? `HTTP ${res.status}` }
    return { ok: true, data: json.data ?? {} }
  } catch (error) {
    return { ok: false, why: String(error?.cause?.code ?? error?.message ?? error) }
  }
}

async function apiPost (path) {
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    })
    const json = await res.json().catch(() => null)
    if (!res.ok || json?.ok !== true) return { ok: false, why: json?.error ?? `HTTP ${res.status}` }
    return { ok: true, data: json.data ?? {} }
  } catch (error) {
    return { ok: false, why: String(error?.cause?.code ?? error?.message ?? error) }
  }
}

function updStatus (payload) {
  state.status = lib.describeStatus(payload)
  const conn = payload?.connection ?? {}
  state.account = conn.nickname || conn.userId || ''
}

// ─────────────────────────────────────────────────────────────────────────────
// 状态轮询（只在窗口活着时跑；窗口收了也继续跑，托盘提示要准）
// ─────────────────────────────────────────────────────────────────────────────
function startPolling (intervalMs = 4000) {
  if (state.pollTimer) return
  state.pollTimer = setInterval(async () => {
    const r = await probe()
    if (!r.ok) {
      if (state.status.level !== 'down') {
        state.status = { level: 'down', short: '桥接未运行', detail: r.why }
      }
    } else {
      updStatus(r.data)
    }
    refreshTray()
    // 只有**这次是桌面壳起的**才自动重连：本来就在跑的那个桥接被别人停掉，
    // 我们不该擅自把它再拉起来（那会变成"谁在管这个进程"说不清）。
    if (!r.ok && state.startedBy === 'launcher' && !state.quitting) {
      logLine('桥接掉线了 —— 正在尝试重新拉起')
      await startBridge({ silent: true })
    }
  }, intervalMs)
  if (typeof state.pollTimer.unref === 'function') state.pollTimer.unref()
}

// ─────────────────────────────────────────────────────────────────────────────
// 启动桥接 / SnowLuma
// ─────────────────────────────────────────────────────────────────────────────
function nodeBin () {
  const vendor = join(PKG_ROOT, 'vendor', 'node', 'node.exe')
  if (existsSync(vendor)) return vendor
  logLine(`⚠️ 没有包内 Node（${vendor}）—— 退回系统 node（发布包不该出现这种情况）`)
  return 'node'
}

/**
 * 起桥接。**唯一**的启动方式就是 `node src/index.mjs --background`：
 * 它自己会判"已经有桥接在跑"并给出人话提示（见 src/index.mjs 的注释），
 * 也会预生成 instanceId —— 这些都是桌面壳不该复制的知识。
 */
function startBridge ({ silent = false } = {}) {
  return new Promise((resolve) => {
    const entry = join(PKG_ROOT, 'src', 'index.mjs')
    if (!existsSync(entry)) {
      const message = `包不完整：找不到 ${entry}`
      logLine(`❌ ${message}`)
      resolve({ ok: false, message })
      return
    }
    logLine(`启动桥接：${nodeBin()} ${entry} --background`)
    const child = spawn(nodeBin(), [entry, '--background'], {
      cwd: PKG_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // ★ 把包根**明确告诉**新进程（而不是让它自己从 `--background` 的 cwd 或 argv 去推）。
      //   桥接自己算出来的根当然也对，但这一行让"这次到底用的是哪个根"变成**父进程说了算**，
      //   排查时不必再靠猜（配合日志里那句"包根 …"）。
      env: { ...process.env, INTERACTBOT_PKG_ROOT: PKG_ROOT },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (error) => {
      const r = lib.describeStartResult({ code: null, stdout, stderr, spawnError: error })
      logLine(`❌ ${r.message}`)
      resolve(r)
    })
    child.on('close', (code) => {
      const r = lib.describeStartResult({ code, stdout, stderr })
      logLine(`${r.ok ? '✅' : '❌'} ${r.message}`)
      if (r.ok) state.startedBy = 'launcher'
      if (!silent) sendSplash({ kind: 'started', ...r })
      resolve(r)
    })
  })
}

/**
 * SnowLuma 是**可选的**：它不在时桥接照常启动，只是连不上协议端。
 * 所以这里失败**不阻断**开窗口，只把话说清楚。
 */
async function ensureSnowluma (sendSplash) {
  const det = await apiGet('/api/snowluma/detect')
  if (!det.ok) {
    logLine(`⚠️ 问不到 SnowLuma 的状态（${det.why}）—— 跳过启动它，界面里能看到详情`)
    return { ok: false, why: `问不到协议端状态（${det.why}）` }
  }
  const detected = det.data.detected
  const running = det.data.running
  if (detected === false) {
    logLine('⚠️ 没检测到 SnowLuma 安装 —— 跳过；机器人会起来但连不上 QQ')
    return { ok: false, why: '没检测到 SnowLuma 安装' }
  }
  if (running === true) {
    logLine('SnowLuma 已在运行，不重复启动')
    return { ok: true, already: true }
  }
  logLine('启动 SnowLuma…')
  sendSplash({ kind: 'phase', phase: 'snowluma', text: '正在启动 SnowLuma（协议端）…' })
  const started = await apiPost('/api/snowluma/start')
  if (!started.ok) {
    logLine(`⚠️ 启动 SnowLuma 失败：${started.why}`)
    return { ok: false, why: `启动失败（${started.why}）` }
  }
  const t0 = Date.now()
  while (Date.now() - t0 < WAIT_SNOWLUMA_MS) {
    const again = await apiGet('/api/snowluma/detect')
    if (again.ok && again.data.running === true) return { ok: true, waitedMs: Date.now() - t0 }
    sendSplash(lib.describeWait({ elapsedMs: Date.now() - t0, phase: 'snowluma' }))
    await sleep(1500)
  }
  logLine('⚠️ 等 SnowLuma 超时 —— 继续开窗口（界面里能看到它到底怎么了）')
  return { ok: false, why: '等 SnowLuma 超时' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─────────────────────────────────────────────────────────────────────────────
// 窗口 / 托盘
// ─────────────────────────────────────────────────────────────────────────────
function iconPath () {
  const packaged = join(__dirname, 'assets', 'app-icon.ico')
  if (existsSync(packaged)) return packaged
  const dev = join(__dirname, '..', 'assets', 'icon.ico')
  return existsSync(dev) ? dev : null
}

function createWindow () {
  const icon = iconPath()
  state.window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: 'InteractBot 控制台',
    backgroundColor: '#0b0f19',
    show: false,
    ...(icon ? { icon } : {}),
    webPreferences: {
      // ★ 界面是**本地可信**的（桥接自己伺服的产物），但仍然按最小权限给：
      //   只开一个 preload 通道给启动页用，窗口内容本身不需要任何特权。
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  state.window.once('ready-to-show', () => state.window.show())

  // 关闭 = 收到托盘（**不是**退出）。这是"关掉窗口机器人就下线"那件事的修法。
  state.window.on('close', (event) => {
    if (state.quitting) return
    event.preventDefault()
    hideToTray()
  })

  // 界面里的外链一律丢给系统浏览器：窗口里没有地址栏，导航走了就回不来。
  state.window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return { action: 'allow' }
    shell.openExternal(url).catch((e) => logLine(`⚠️ 打不开外链 ${url}：${e.message}`))
    return { action: 'deny' }
  })
  state.window.webContents.on('will-navigate', (event, url) => {
    if (String(url).startsWith(lib.consoleUrl(state.port))) return
    if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return
    event.preventDefault()
    shell.openExternal(url).catch((e) => logLine(`⚠️ 打不开外链 ${url}：${e.message}`))
  })
  state.window.on('closed', () => { state.window = null })

  return state.window
}

function showSplash () {
  const w = state.window ?? createWindow()
  w.loadFile(join(__dirname, 'splash.html'))
  w.show()
  return w
}

function sendSplash (payload) {
  if (!state.window || state.window.isDestroyed()) return
  if (!state.window.webContents.getURL().includes('splash.html')) return
  state.window.webContents.send('splash', payload)
}

function hideToTray () {
  if (!state.window) return
  state.window.hide()
  const now = Date.now()
  // 只提示一次、且不要每次关都弹（Windows 的通知很吵）
  if (state.tray && now - state.lastMinimizeNotice > 60_000) {
    state.lastMinimizeNotice = now
    try {
      state.tray.displayBalloon({
        title: 'InteractBot 还在后台运行',
        content: '关掉窗口不会让机器人下线。要它下线请用托盘菜单的「退出并停止机器人」。',
      })
    } catch {
      /* 有些环境不支持气泡，忽略 */
    }
  }
}

function showWindow () {
  if (!state.window || state.window.isDestroyed()) createWindow()
  state.window.show()
  state.window.focus()
}

function refreshTray () {
  if (!state.tray) return
  state.tray.setToolTip(lib.trayTooltip({ status: state.status, version: app.getVersion(), port: state.port }))
}

function trayMenu () {
  return Menu.buildFromTemplate([
    { label: `InteractBot 控制台（:${state.port}）`, enabled: false },
    { label: `状态：${state.status.short}`, enabled: false },
    ...(state.account ? [{ label: `账号：${state.account}`, enabled: false }] : []),
    { type: 'separator' },
    { label: '打开控制台', click: () => showWindow() },
    { label: '重新连接', click: () => reconnect() },
    { label: '重启机器人', click: () => restartBridge() },
    { label: '停止机器人', click: () => stopBridge({ ask: true }) },
    { type: 'separator' },
    { label: '打开 SnowLuma 控制台', click: () => openSnowlumaConsole() },
    { label: '打开日志文件夹', click: () => openLogs() },
    { type: 'separator' },
    { label: '退出（机器人继续在线）', click: () => quitApp({ stopBot: false }) },
    { label: '退出并停止机器人', click: () => quitApp({ stopBot: true }) },
  ])
}

function createTray () {
  const icon = iconPath()
  if (!icon) {
    logLine('⚠️ 找不到图标文件 —— 不建托盘（关窗口会直接隐藏而没法恢复，所以这次关窗口=退出）')
    return
  }
  state.tray = new Tray(nativeImage.createFromPath(icon))
  state.tray.setToolTip(lib.trayTooltip({ status: state.status, version: app.getVersion(), port: state.port }))
  state.tray.setContextMenu(trayMenu())
  state.tray.on('click', () => showWindow())
  state.tray.on('double-click', () => showWindow())
}

// ─────────────────────────────────────────────────────────────────────────────
// 动作
// ─────────────────────────────────────────────────────────────────────────────
async function reconnect () {
  showSplash()
  const ok = await waitForBridge((p) => sendSplash(p))
  if (ok) loadConsole()
  else sendSplash({ kind: 'failed', text: '还是连不上。点「看日志」看桥接自己说了什么。' })
}

function loadConsole () {
  if (!state.window || state.window.isDestroyed()) createWindow()
  state.window.loadURL(lib.consoleUrl(state.port))
  state.window.show()
}

async function restartBridge () {
  logLine('重启桥接（走 POST /api/restart）')
  const r = await apiPost('/api/restart')
  if (!r.ok) {
    logLine(`⚠️ /api/restart 失败：${r.why} —— 改为直接拉起`)
    state.startedBy = null
    await startBridge({ silent: true })
  }
  await sleep(1200)
  await reconnect()
}

async function stopBridge ({ ask = false } = {}) {
  if (ask) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['停止机器人', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '停止机器人',
      message: '确定要停止机器人吗？',
      detail: '停止后 QQ 里的消息不会有人回。窗口会留着，随时可以再启动。',
    })
    if (response !== 0) return
  }
  // ★ 只是"本来就在跑"的那个桥接不该被我们停掉：那不是我们起的。
  //   但仍允许使用者显式停 —— 所以这里只警告，不拒绝。
  const wasOurs = state.startedBy === 'launcher'
  const r = await apiPost('/api/stop')
  logLine(r.ok ? `已请求停止机器人${wasOurs ? '' : '（注意：这个桥接不是本程序启动的）'}` : `停止失败：${r.why}`)
  state.startedBy = null
  const t0 = Date.now()
  while (Date.now() - t0 < 30_000) {
    const p = await probe()
    if (!p.ok) {
      state.status = { level: 'down', short: '已停止', detail: '配置接口已下线' }
      refreshTray()
      if (state.tray) state.tray.setContextMenu(trayMenu())
      showSplash()
      sendSplash({ kind: 'phase', phase: 'stopped', text: '机器人已停止。点「启动」可以再起来。' })
      return
    }
    await sleep(1000)
  }
  sendSplash({ kind: 'failed', text: `请求停止后 30 秒接口还在（${state.port}）—— 可能没停干净，看日志。` })
}

async function openSnowlumaConsole () {
  // SnowLuma 的控制台地址由它自己决定；界面里有这个按钮，能连上就用界面那条路。
  // 这里做的是"连不上桥接时的兜底"：尽力打开它的默认端口。
  const r = await probe()
  if (r.ok) {
    showWindow()
    return
  }
  const url = 'http://127.0.0.1:5099/'
  logLine(`打开 SnowLuma 控制台：${url}`)
  await shell.openExternal(url).catch((e) => logLine(`⚠️ ${e.message}`))
}

function openLogs () {
  const dir = join(PKG_ROOT, 'logs')
  shell.openPath(existsSync(dir) ? dir : PKG_ROOT).catch((e) => logLine(`⚠️ 打不开日志目录：${e.message}`))
}

async function quitApp ({ stopBot }) {
  if (state.quitting) return
  if (stopBot) {
    logLine('退出：按要求先停机器人')
    const r = await apiPost('/api/stop')
    if (!r.ok) logLine(`⚠️ 停止请求失败（${r.why}）—— 机器人可能还在跑`)
    await sleep(800)
  } else if (state.startedBy === 'launcher') {
    logLine('退出：机器人继续在线（桥接是独立进程，不受本窗口影响）')
  }
  state.quitting = true
  app.quit()
}

// ─────────────────────────────────────────────────────────────────────────────
// 启动流程
// ─────────────────────────────────────────────────────────────────────────────
async function waitForBridge (sendSplash) {
  const t0 = Date.now()
  let attempts = 0
  while (Date.now() - t0 < WAIT_BRIDGE_MS) {
    attempts += 1
    const r = await probe()
    if (r.ok) {
      updStatus(r.data)
      refreshTray()
      return true
    }
    sendSplash(lib.describeWait({ elapsedMs: Date.now() - t0, attempts }))
    await sleep(1000)
  }
  return false
}

async function boot () {
  const cfgPath = join(PKG_ROOT, 'config.json')
  const portInfo = lib.readUiPort({ configPath: cfgPath, log: logLine })
  state.port = portInfo.port
  state.portWhy = portInfo.why
  logLine(`包根 ${PKG_ROOT}`)
  logLine(`控制台端口 ${state.port} —— ${portInfo.why}`)

  showSplash()
  sendSplash({ kind: 'phase', phase: 'probe', text: `正在看桥接在不在（127.0.0.1:${state.port}）…` })

  // ① 已经在跑？那就直接连（**不**再起一个：两个桥接会抢同一个 OneBot 事件流，
  //    同一句话可能被回两次 —— 这正是 src/process-guard.mjs 要防的事）。
  //
  // ★★ 但"探测失败"≠"没在跑"：桥接启动要好几秒，**正在启动**的那一个
  //    在这几秒里同样不回答 /api/status。直接 spawn 会撞上它自己那句
  //    "已经有一个桥接在运行"（`--background` 的判据是 process-guard 的登记，
  //    而登记发生在**启动早期**，很可能已经写进去了）—— 结果是：窗口永远等不到
  //    那个我们以为起了、其实没起的进程，而且日志里只有一句让人困惑的提示。
  //    所以先给它 5 秒窗口，确认真的没人应答再起。
  let first = await probe()
  if (!first.ok) {
    const t0 = Date.now()
    while (Date.now() - t0 < 5000) {
      sendSplash({ kind: 'phase', phase: 'probe', text: `正在确认桥接是否已经在跑…（${Math.round((Date.now() - t0) / 1000)}/5 秒）` })
      await sleep(700)
      first = await probe()
      if (first.ok) break
    }
  }
  if (first.ok) {
    logLine('桥接已经在运行 —— 直接连上去（本次不由桌面壳启动）')
    state.startedBy = null
    updStatus(first.data)
    startPolling()
    refreshTray()
    loadConsole()
    return
  }

  // ② 不在跑：起它（这一步的判据与提示全在 `--background` 里面）
  sendSplash({ kind: 'phase', phase: 'starting', text: '桥接没在跑 —— 正在启动…' })
  const started = await startBridge({ silent: true })
  if (!started.ok) {
    sendSplash({ kind: 'failed', text: `起不来：${started.message}` })
    return
  }

  // ③ 等它真的好（能回答 /api/status 才算好；端口连上但接口没装配完不算）
  const ok = await waitForBridge((p) => sendSplash(p))
  if (!ok) {
    logLine('❌ 等桥接超时（90 秒）')
    sendSplash({ kind: 'failed', text: '等了 90 秒桥接还没好 —— 点「看日志」看它卡在哪。' })
    return
  }
  logLine('桥接已就绪')

  // ④ 协议端（SnowLuma）—— 可选，失败不阻断
  if (process.env.INTERACTBOT_SKIP_SNOWLUMA !== '1') {
    const sl = await ensureSnowluma((p) => sendSplash(p))
    if (!sl.ok) sendSplash({ kind: 'phase', phase: 'snowluma-warn', text: `SnowLuma：${sl.why}（界面里能看到它到底怎么了）` })
  }

  startPolling()
  refreshTray()
  if (state.tray) state.tray.setContextMenu(trayMenu())
  loadConsole()
}

// ─────────────────────────────────────────────────────────────────────────────
// 单实例 / 收尾
// ─────────────────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  // 第二个实例：把话说完就退出。**不弹窗**（双击两次不该弹一个错误窗）。
  logLine('已经有一个 InteractBot 窗口在运行 —— 本进程退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    logLine('又有人双击了 —— 把已有窗口叫到前面（不会起第二个桥接）')
    showWindow()
  })

  app.on('window-all-closed', () => {
    // Windows 上**不**退出：这是托盘程序，窗口关掉机器人照跑。
    // 真正的退出只有托盘菜单那两项（见 quitApp）。
  })

  app.on('before-quit', () => { state.quitting = true })

  ipcMain.handle('desktop:action', async (_event, action) => {
    switch (action) {
      case 'start': {
        const r = await startBridge({ silent: true })
        if (!r.ok) return r
        const ok = await waitForBridge((p) => sendSplash(p))
        if (ok) loadConsole()
        return { ok, message: ok ? '已启动' : '启动了但 90 秒内没就绪' }
      }
      case 'stop':
        await stopBridge({ ask: false })
        return { ok: true, message: '已请求停止' }
      case 'restart':
        await restartBridge()
        return { ok: true, message: '已重启' }
      case 'retry':
        await reconnect()
        return { ok: true, message: '重试中' }
      case 'logs':
        openLogs()
        return { ok: true, message: '已打开日志目录' }
      case 'quit':
        await quitApp({ stopBot: false })
        return { ok: true, message: '正在退出' }
      default:
        return { ok: false, message: `不认识的动作：${action}` }
    }
  })

  app.whenReady().then(async () => {
    try {
      createWindow()
      createTray()
      // 菜单栏对托盘程序是噪音，且会让人以为"关掉菜单=关掉程序"。去掉。
      Menu.setApplicationMenu(null)
      await boot()
    } catch (error) {
      logLine(`❌ 启动失败：${error?.stack ?? error}`)
      try {
        dialog.showErrorBox('InteractBot 启动失败', `${error?.message ?? error}\n\n日志：${DESKTOP_LOG}`)
      } catch {
        /* 连弹窗都失败就只能靠日志了 */
      }
    }
  })

  app.on('activate', () => showWindow())
}
