/**
 * 桥接入口：把各个零件装配起来并跑起来。
 *
 * ── 启动顺序（顺序本身有讲究）──────────────────────────────────────────
 *   1. 读配置、做自检        ← 配置错了要在连任何东西之前就报出来
 *   2. 建工作区目录          ← 它是权限沙箱的根，必须真实存在
 *   3. 起 dsh 子进程 + initialize
 *   4. 连 QQ 事件通道
 *   5. 挂上桥接逻辑
 *   6. 等退出信号，优雅收尾
 *
 * 为什么先起 DSH 再连 QQ？因为"连上 QQ 但 DSH 没起来"是最糟的状态：
 * 用户发消息会得到一个连接超时，而且 QQ 端看起来一切正常。
 * 反过来先确保 DSH 就绪，QQ 连上就能用。
 *
 * 用法：
 *   node src/index.mjs                 # 正常启动
 *   node src/index.mjs --check         # 只做配置自检，不连任何东西
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { SdkRpcClient } from './sdk-rpc.mjs'
import { OneBotClient, SendQueue } from './onebot.mjs'
import { SessionRouter } from './session-bridge.mjs'
import { Bridge } from './bridge.mjs'
import { makeSessionId } from './session-id.mjs'
import { PKG_ROOT, DIRS, resolveDshHome, resolveInPackage } from './local.mjs'
import { runDoctor, printDoctor } from './doctor.mjs'
import { normalizeConfig, validateConfig } from './config.mjs'
import { createApiHandler, serveApi } from './api.mjs'
import { writeMcpConfig, ensureSdkProfilePatch } from './mcp-profile.mjs'
import { createPriceBook } from './prices.mjs'
import { createUsageLedger } from './usage.mjs'
import { createMemoryStore } from './memory-files.mjs'
import { createRoster } from './roster.mjs'
import { resolveModelCredentials } from './credentials.mjs'
// ★ 不再直接 import `detectSnowluma` —— 所有探测都经 `makeLaunchDetect` 这一个工厂，
//   目的就是让"两条调用路径传的判据一致"变成结构上必然成立（见该函数的注释）。
import { startSnowluma, openSnowlumaConsole, resolveOnebotTokens, makeLaunchDetect } from './snowluma.mjs'
import { createSnowlumaLogReader } from './snowluma-log.mjs'

// ── 日志：同时写控制台和文件 ──────────────────────────────────────────────
let logFile = null
let logBomWritten = false

/**
 * 给日志文件写 UTF-8 BOM。
 *
 * ── 为什么需要这一步（真实踩到）────────────────────────────────────────
 * 日志内容是中文。Node 写文件默认是 **UTF-8 无 BOM**，而 Windows 的工具
 * （PowerShell 的 Get-Content、记事本、部分编辑器）在没有 BOM 时会按
 * **系统 ANSI 代码页（中文系统是 GBK）** 去解码 —— 结果就是满屏乱码：
 *
 *     2026-09-24 18:24:04 === 妗ユ帴鍚姩 === 宸ヤ綔鍖?...
 *
 * 用户是拿记事本看日志排查问题的，乱码等于没有日志。加一个 3 字节的 BOM
 * 就能让这些工具正确识别编码 —— 代价极小，收益是"日志真的能读"。
 */
function ensureLogBom(path) {
  if (logBomWritten) return
  logBomWritten = true
  try {
    if (!existsSync(path) || statSync(path).size === 0) {
      appendFileSync(path, '\uFEFF')
    }
  } catch {
    /* 写 BOM 失败不该影响主流程 */
  }
}

function makeLogger(verbose) {
  return (message) => {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const line = `${stamp} ${message}`
    console.log(line)
    if (logFile) {
      try {
        ensureLogBom(logFile)
        appendFileSync(logFile, line + '\n')
      } catch {
        /* 写日志失败不该影响主流程 */
      }
    }
  }
}

function loadConfig() {
  const path = join(PKG_ROOT, 'config.json')
  if (!existsSync(path)) {
    // ★ config.json **刻意不进 git**：它含 SnowLuma 的 accessToken 与模型 API key 明文，
    //   而 git 历史里的密钥即使之后删掉也仍然可被检出（属于永久泄露）。
    //   所以仓库里给的是 `config.example.json`，这里在缺失时给出**可执行**的提示，
    //   而不是一句"找不到配置文件"（那种报错会让人以为包坏了）。
    const example = join(PKG_ROOT, 'config.example.json')
    throw new Error(
      `找不到配置文件：${path}\n` +
        (existsSync(example)
          ? `  本仓库不跟踪 config.json（它含明文密钥）。复制一份模板即可：\n` +
            `    copy "${example}" "${path}"\n`
          : '  仓库里连模板 config.example.json 也没有，请检查包是否完整。\n'),
    )
  }
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw)
  return { config: normalizeConfig(parsed), path }
}

/**
 * 绑定配置接口，端口忙时**重试**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么不能只 `await serveApi(...)` 一次就完（这里踩过坑）
 * ══════════════════════════════════════════════════════════════════════════
 * 重启是"先起新进程、旧进程随后退出"的，于是新进程常常**在旧进程还没放开端口时**
 * 就来绑定。原实现只试一次，然后在 catch 里把 `EADDRINUSE` 降级成一句 warning
 * 并让 `apiServer = null` —— 后果非常坏：
 *
 *   · 第二个桥接**看起来启动成功**（能连 QQ、能回话），只是控制台不可用；
 *   · 而用户打开的那张控制台界面其实是**第一个进程**的；
 *   · 两个桥接同时从同一个 OneBot 收事件 → 同一句话可能被回答两次；
 *   · 日志里只有一句 ⚠️，没有任何地方能看出"现在有两个桥接"。
 *
 * 所以：端口忙就等一小会儿再试（旧进程退出通常只要几百毫秒），
 * 并且**失败时不许静默**：打 error 级日志，并把结果回报给启动流程，
 * 让 `/api/status` 与 doctor 能如实显示"控制台端口被占用"。
 */
async function bindApiWithRetry({ port, handler, staticDir, log, attempts = 8, delayMs = 400 }) {
  let lastError = null
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await serveApi({ port, handler, staticDir, log })
    } catch (error) {
      lastError = error
      const busy = /EADDRINUSE|已被占用/.test(String(error?.message ?? ''))
      if (!busy) throw error // 不是端口冲突（例如权限问题）就别重试了，直接上报
      if (i < attempts) {
        log(
          `配置接口端口 ${port} 被占用，等待释放后重试（${i}/${attempts - 1}）——` +
            `通常是上一个桥接进程还没退完`,
        )
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
  }
  throw lastError
}

/**
 * 另起一个桥接进程（给 /api/restart 用）。
 *
 * 做法与 start.bat 保持一致：优先用包内 vendor\node\node.exe，
 * 找不到退回系统 node。新进程 detached + stdio 忽略 —— 父进程退出后
 * 它独立存活，日志照旧写 logs/bridge.log，控制台界面不受影响。
 *
 * ★ 它**不负责**"顺序"：谁先谁后由调用方（requestRestart）决定。
 *   原来的顺序是"先起新的、再关旧的"，注释里还断言"不用担心端口冲突"——
 *   那个断言只在旧进程很快退完时成立，而旧进程恰恰可能慢
 *   （在途回复最多等 8s + DSH shutdown 最多 15s）。现在改成：
 *   **先关掉自己的配置接口（释放端口）→ 再 spawn 新进程 → 再收尾退出**，
 *   于是"端口已释放"是**代码保证**的，不再依赖时序假设。
 */
function respawnBridge(log, { port } = {}) {
  const vendorNode = join(PKG_ROOT, 'vendor', 'node', 'node.exe')
  const nodeBin = existsSync(vendorNode) ? vendorNode : 'node'
  // ★ 把端口告诉新进程：它会在绑定失败时重试（bindApiWithRetry），
  //   这样即使旧进程退得比预期慢，新进程也只是慢一点起来，而不是静默丢掉控制台。
  const env = port ? { ...process.env, DSH_BRIDGE_EXPECT_PORT: String(port) } : process.env
  const child = spawn(nodeBin, [join(PKG_ROOT, 'src', 'index.mjs')], {
    cwd: PKG_ROOT,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  // 只"发起"，日志由调用方按顺序补充（见 requestRestart：要先释放端口再报成功）
  return { pid: child.pid, target: join(PKG_ROOT, 'src', 'index.mjs') }
}

async function main() {
  const checkOnly = process.argv.includes('--check')
  const doctorOnly = process.argv.includes('--doctor')
  // 给 start.bat 用的两个小工具开关（见下方"启动前顺手做的事"）。
  const snowlumaOnly = process.argv.includes('--snowluma')
  const openConsoleOnly = process.argv.includes('--open-console')

  let config
  let configPath
  try {
    ;({ config, path: configPath } = loadConfig())
  } catch (error) {
    console.error(`❌ 配置加载失败：${error.message}`)
    process.exit(1)
  }

  const { fatal, warn } = validateConfig(config)
  const log = makeLogger(config.ui.verbose)

  console.log(`\n配置文件：${configPath}`)
  console.log(`工作区  ：${config.dsh.workspace}`)
  console.log(`权限模式：${config.dsh.permissionMode}`)
  console.log(`模型    ：${config.dsh.provider} / ${config.dsh.model}`)
  console.log(`管理员  ：${config.access.adminUsers.length ? config.access.adminUsers.join(', ') : '（未配置）'}`)
  console.log('')

  for (const w of warn) console.log(`⚠️  ${w}`)
  if (fatal.length) {
    for (const f of fatal) console.error(`❌ ${f}`)
    process.exit(1)
  }

  if (checkOnly) {
    console.log('\n✅ 配置自检通过（--check 模式，未连接任何服务）\n')
    return
  }

  // ── 配置界面要用的几个部件 ─────────────────────────────────────────────
  //
  // ⚠️ 路径一律经 `resolveInPackage`，**不要用 `process.cwd()`** ——
  // 本包要能整体搬走（`verify-manifest.mjs` 里有专门的断言查这一条）。
  const priceBook = createPriceBook({
    file: resolveInPackage(config.usage.pricesFile),
    log,
  })
  const usageLedger = createUsageLedger({
    file: join(DIRS.logs, 'usage.jsonl'),
    priceBook,
    enabled: config.usage.enabled !== false,
    log,
  })
  const memoryStore = createMemoryStore({
    workspace: config.dsh.workspace,
    enabled: config.memory?.enabled !== false,
    log,
  })
  // 名单与权限分级。**与 Bridge 共用同一个实例** —— 缓存的好友/群列表
  // 才能被配置接口复用，而不是各拉一份。
  const roster = createRoster({ config, log })
  // SnowLuma 的终端输出（界面上的"终端"面板读它）。
  // 读它的**日志文件**而不是 stdout —— 实测文件是 UTF-8，stdout 是终端编码
  // （重定向会变 GBK 乱码）。详见 src/snowluma-log.mjs。
  const snowlumaLog = createSnowlumaLogReader({
    // 已由 normalizeConfig 解析成绝对路径，这里直接透传。
    installDir: config.snowluma?.installDir || undefined,
  })

  // ── 两个给 start.bat 用的小工具开关 ────────────────────────────────────
  //
  // 为什么不写在 start.bat 里而放这儿：**发现 SnowLuma 装在哪的逻辑只有一份**
  // （src/local.mjs 的 findSnowluma）。批处理里再实现一遍，就会有两份会漂移的
  // 规则 —— 而这种漂移正是之前"启动了错的那份 SnowLuma"的根源。
  // 所以 start.bat 只负责调用，判断全在 JS 里。

  if (openConsoleOnly) {
    // 打开 SnowLuma 的网页端（浏览器）
    const r = await openSnowlumaConsole({ config, log })
    console.log(r.ok ? `✅ ${r.data.hint}` : `❌ ${r.error}`)
    return
  }

  if (snowlumaOnly) {
    // 启动 SnowLuma 进程（已经在跑就不重复启动）
    const tokens = resolveOnebotTokens({
      config,
      installDir: config.snowluma?.installDir || undefined,
    })
    if (tokens.differsFromConfig) {
      console.log('⚠️  config.json 里的 token 与 SnowLuma 自己的配置不一致。')
      console.log(`   实际用的是【${tokens.source}】里的那一组（见 src/snowluma.mjs）。`)
    }
    const r = await startSnowluma({
      config,
      log,
      // ★ 必须传 `detect` —— 这条路原先**漏了它**，代价是"防重复启动"少了一道防线。
      //
      //   `startSnowluma` 的防重复是两步：① 探控制台 ② 问"OneBot 端点上应答的
      //   是不是**正确的那份**"。第②步靠 `detect` 提供判据；不传的话
      //   `typeof detect !== 'function'` 会让整段被静默跳过，只剩第①步。
      //   后果很具体：只要控制台探测失败一次（典型情况是 SnowLuma 改过 WebUI
      //   端口，而 consoleUrl 还写着 5099），哪怕它正在正常服务，这里也会
      //   **再 spawn 一个实例** —— 端口冲突、甚至抢登录态，正是第②步要防的事。
      //
      //   用 `makeLaunchDetect` 和界面按钮那条路**共用同一个实现**，
      //   而不是在这里手写一遍：两边各写一遍的下场就是其中一边漏掉（已经发生过）。
      detect: makeLaunchDetect({ config, log }),
    })
    if (r.ok) {
      console.log(r.data.started ? `✅ ${r.data.hint}` : `ℹ️  ${r.data.hint}`)
      if (r.data.cmd) console.log(`   入口：${r.data.cmd}（来源：${r.data.discoveredBy}）`)
      if (config.snowluma?.consoleUrl) console.log(`   网页端：${config.snowluma.consoleUrl}`)
    } else {
      console.log(`❌ ${r.error}`)
      process.exitCode = 1
    }
    return
  }

  // ── 体检模式：真的去连一次 OneBot，把实际结果报出来 ──────────────────
  // 与 --check 的区别：--check 只看配置本身；--doctor 会发起真实探测
  // （HTTP 请求 + WebSocket 握手），所以能查出"端口填错""token 填反"
  // 这类只有连了才知道的问题。它不发 QQ 消息、不调用大模型。
  if (doctorOnly) {
    const result = await runDoctor({ config, validate })
    const allOk = printDoctor(result)
    if (result.fatal.length) process.exit(1)
    process.exit(allOk ? 0 : 2)
  }

  // 工作区必须真实存在：它是沙箱的根，不存在的话 agent 会以奇怪的状态启动
  mkdirSync(config.dsh.workspace, { recursive: true })

  // ── 把「QQ 工具」挂给模型（必须在起 DSH 之前，否则新进程读不到）────────
  //
  // 背景：模型跑在 dsh 子进程里、看不到桥接的 OneBot 连接，而 SDK 没有工具通道。
  // 唯一接法是让 DSH 的 MCP 客户端加载我们的工具服务器 —— 见 mcp/mcp-qq-server.mjs
  // 与 src/mcp-profile.mjs 里的完整说明。
  //
  // 整段**允许失败**：QQ 工具是增强能力，不该因为挂载失败就让机器人起不来。
  if (config.mcp?.enabled !== false) {
    try {
      // token 只写进 cache 目录，**不写 workspace**
      // （workspace 里的文件 agent 能读到，而 agent 不该看到 token）
      const mcpConfigPath = writeMcpConfig({
        cacheDir: join(PKG_ROOT, 'cache'),
        httpUrl: config.onebot.httpUrl,
        httpToken: config.onebot.httpToken,
        timeoutMs: config.mcp?.toolTimeoutMs ?? 20_000,
      })

      // 定位 DSH_HOME（profiles/ 在它下面）。
      // ⚠️ 不能"从 CLI 路径反推" —— 第一版就是这么错的：DSH 可能是全局安装，
      // 而 profile 在用户数据目录，两者无路径关系，结果把补丁写进了**安装目录**。
      // 现在按已知候选找（环境变量 → 桌面版默认位置 → 安装目录旁兜底），
      // 详见 local.mjs 的 resolveDshHome。
      const resolved = resolveDshHome({ cliPath: config.dsh.cliPath })
      if (!resolved) {
        throw new Error(
          '找不到 DSH_HOME（profiles 所在目录）。请设环境变量 DSH_HOME 指向 harness 目录。',
        )
      }

      // ★ 把解析结果**显式写回环境变量**。
      //
      // 为什么必须这么做：`sdk-rpc.mjs` 起 DSH 子进程时是从
      // `process.env.DSH_HOME` 找凭据文件的（见 credentials.mjs）。
      // 如果这个环境变量**本来没设**，我们就解析出了 home 也传不下去 ——
      // 于是子进程读不到 API key，每一次模型调用都以 MISSING_CREDENTIAL
      // 立刻失败，表现是"机器人能收到消息但没有任何输出内容"。
      process.env.DSH_HOME = resolved.home

      const profilePatchPath = join(resolved.home, 'profiles', 'sdk', 'cordis.patch.yml')

      const { changed } = ensureSdkProfilePatch({
        profilePatchPath,
        nodePath: process.execPath,
        serverPath: join(PKG_ROOT, 'mcp', 'mcp-qq-server.mjs'),
        configPath: mcpConfigPath,
      })
      log(
        changed
          ? `QQ 工具已挂到 sdk profile（重启 DSH 子进程后模型就能调）：${profilePatchPath}`
          : `QQ 工具挂载已是最新：${profilePatchPath}`,
      )
    } catch (error) {
      log(`⚠️ QQ 工具挂载失败（不影响机器人本体）：${error?.message ?? error}`)
    }
  } else {
    log('QQ 工具已按配置关闭（mcp.enabled = false）')
  }

  // 启动时刻：/api/status 要报 uptime
  const startedAt = new Date()

  // 日志文件
  const logPath = join(PKG_ROOT, config.ui.logFile)
  mkdirSync(dirname(logPath), { recursive: true })
  logFile = logPath
  log(`=== 桥接启动 === 工作区=${config.dsh.workspace} 权限=${config.dsh.permissionMode}`)

  // ── 模型凭据自检（★ "机器人不输出内容"那个故障的护栏）────────────────
  //
  // ⚠️ 位置很关键：必须在 `logFile` 赋值**之后**。
  //    第一版放在了 MCP 接线那段（更早），而那些日志只进控制台 ——
  //    桥接是无窗口运行的，等于**写了没人看得见**。
  //    这类"日志写了但看不到"的问题和"没写日志"一样糟。
  //
  // 缺 key 时的表现**只是"没输出"**：不抛异常、不报错，排查极费时间。
  {
    const dshHome = process.env.DSH_HOME ?? resolveDshHome({ cliPath: config.dsh.cliPath })?.home
    const cred = resolveModelCredentials({ dshHome, env: process.env, apiKey: config.dsh.apiKey })
    if (cred.env.DEEPSEEK_API_KEY) {
      log(`🔑 模型凭据：已就绪（来源：${cred.source}）`)
    } else {
      log(`❌ 模型凭据缺失：${cred.warning}`)
      log('   → 这样启动的话，机器人能收到消息但**不会产生任何回复内容**（只会回一句兜底话术）。')
      log('   → 打开控制台「高级」页填一次 API Key，或设环境变量 DEEPSEEK_API_KEY。')
    }
  }

  // ── 起 DSH ──
  const rpc = new SdkRpcClient({
    cliPath: config.dsh.cliPath,
    cwd: config.dsh.workspace,
    provider: config.dsh.provider,
    model: config.dsh.model,
    reasoningEffort: config.dsh.reasoningEffort,
    apiKey: config.dsh.apiKey,
    log,
  })
  rpc.onStderr((line) => log(`[dsh] ${line}`))

  try {
    await rpc.start({ permissionMode: config.dsh.permissionMode })
    log('✅ DSH 就绪')
  } catch (error) {
    console.error(`❌ 无法启动 DSH：${error.message}`)
    log(`❌ 无法启动 DSH：${error.message}`)
    process.exit(1)
  }

  // ── 连 QQ ──
  const onebot = new OneBotClient({ ...config.onebot, log })
  const sendQueue = new SendQueue({ ...config.send, log })
  const router = new SessionRouter({ log })
  const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, usageLedger, roster, log })
  bridge.attach(onebot)

  // 记下登录信息，供配置接口的 /api/status 使用
  let loginInfo = null
  onebot.addEventListener('connected', async () => {
    try {
      const info = await onebot.getLoginInfo()
      loginInfo = info
      log(`✅ 已登录 QQ：${info?.nickname ?? '?'}（${info?.user_id ?? '?'}）`)
      if (config.access.adminUsers.length === 0) {
        log('⚠️ 尚未配置管理员，机器人不会回复任何人')
      }
      // 打一行样例，证明 sessionId 生成正常（不含原始 QQ 号）
      log(`   会话键样例：私聊 <QQ号> → ${makeSessionId('private', config.access.adminUsers[0] ?? '0')}`)
    } catch (error) {
      log(`⚠️ get_login_info 失败：${error.message}`)
    }
  })
  onebot.connect()

  // ── 本地配置接口（给配置 UI 用）────────────────────────────────────────
  // 只监听回环地址：配置里含 accessToken，公开到局域网等于交出控制权。
  // 端口/开关都在 config.json 的 ui 段里 —— 关掉它不影响机器人本体工作。
  let apiServer = null
  if (config.ui.apiEnabled !== false) {
    const apiHandler = createApiHandler({
      configPath,
      readRawConfig: () => JSON.parse(readFileSync(configPath, 'utf8')),
      writeRawConfig: (cfg) => writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8'),
      normalize: normalizeConfig,
      validate: validateConfig,
      // 状态里**不放 token**，只给 UI 需要的运行信息
      getStatus: () => ({
        running: true,
        startedAt: startedAt.toISOString(),
        uptimeMs: Date.now() - startedAt.getTime(),
        login: loginInfo ? { userId: String(loginInfo.user_id), nickname: loginInfo.nickname } : null,
        connected: onebot.connected,
        dshAlive: rpc.alive,
        adminUsers: config.access.adminUsers,
        permissionMode: config.dsh.permissionMode,
        workspace: config.dsh.workspace,
        groupEnabled: config.trigger.groupEnabled,
        stats: bridge.stats,
      }),
      // 会话同步：给"同步 QQ 对话界面"用（内存镜像，最近若干条）
      getConversations: () => bridge.listConversations(),
      runDoctor: async () => {
        const result = await runDoctor({ config, validate: validateConfig })
        return { fatal: result.fatal, warn: result.warn, rows: result.rows }
      },
      // ── 配置界面新增的几组 ──
      // 探雪露马：**用当下的真实探测**，不是缓存值 —— 界面就是要看"现在活没活"。
      detectSnowluma: makeLaunchDetect({
        config,
        log,
        wsConnected: () => onebot.connected,
        getLogin: () => loginInfo,
        bridgeRunning: true,
      }),
      // 界面按钮：只打开 SnowLuma 的网页端（**不启动进程** —— 那是 start.bat 的事）。
      // 这样按钮的职责与它的能力匹配：能确定做到"打开一个本机网页"，
      // 而"启动进程"会开出第二个实例（端口冲突、抢登录态）。
      openSnowlumaConsole: () => openSnowlumaConsole({ config, log }),
      // 界面上的"终端"面板：读 SnowLuma 自己的日志文件（UTF-8，不是 stdout）
      snowlumaLog,
      // 名单配置用：拉真实好友/群列表。复用 Bridge 那份 roster（共享缓存）。
      roster,
      onebotCall: (action, params) => onebot.call(action, params),
      // 保留给 start.bat 用（真实启动进程）
      startSnowluma: () =>
        startSnowluma({
          config,
          log,
          // 和 `--snowluma` 那条路**共用同一个工厂**（见 makeLaunchDetect 的说明：
          // 两边各写一遍就会有一边漏掉，真实发生过）。
          // 区别只在于这条路上桥接在跑，所以能提供真实的连接状态与登录缓存。
          detect: makeLaunchDetect({
            config,
            log,
            wsConnected: () => onebot.connected,
            getLogin: () => loginInfo,
            bridgeRunning: true,
          }),
        }),
      priceBook,
      usageLedger,
      memoryStore,
      // 取图路由用：对话里的图片只从 workspace/inbox 出。
      // config.dsh.workspace 在归一化阶段已是绝对路径（resolveInPackage）。
      workspaceRoot: config.dsh.workspace,
      onConfigSaved: () => log('配置已通过接口保存（需重启桥接才生效）'),
      // 停止/重启：动作本身由 api.mjs 延后执行（先响应 UI 再动进程）。
      // shutdown 在下方定义，这里只是闭包引用，调用时早已初始化。
      requestStop: () => {
        log('收到配置接口的停止请求')
        shutdown('api-stop', { exitDelayMs: 400 })
      },
      requestRestart: () => {
        log('收到配置接口的重启请求')
        // ★ 顺序（改动过，理由见缺陷 2）：**先释放端口，再起新进程**。
        //   原先是先 respawn 再 shutdown，于是新进程经常在旧进程还没放开端口时
        //   就来绑定 —— 只试一次就失败，然后被降级成一句 warning，结果两个桥接
        //   同时在跑、控制台指向旧的那个。现在由代码保证端口先空出来，
        //   新进程那边还有 bindApiWithRetry 兜底重试。
        ;(async () => {
          try {
            if (apiServer) {
              try {
                await apiServer.close()
              } catch {
                /* 关接口失败不影响重启 */
              }
              apiServer = null
              log('已释放配置接口端口，开始拉起新进程')
            }
            const { pid, target } = respawnBridge(log, { port: config.ui.apiPort })
            log(`已拉起新的桥接进程（pid ${pid ?? '?'}）：${target}`)
          } catch (error) {
            log(`❌ 拉起新桥接进程失败：${error.message}（本进程继续运行，请手动重启）`)
            return
          }
          await shutdown('api-restart', { exitDelayMs: 500 })
        })()
      },
    })

    try {
      // 控制台界面（config-ui 的构建产物）存在就一并伺服在同一个端口上，
      // 这样 start.bat 打开 http://127.0.0.1:3410/ 就是完整控制台，无需另起服务。
      const uiDist = join(PKG_ROOT, 'config-ui', 'dist')
      const staticDir = existsSync(join(uiDist, 'index.html')) ? uiDist : undefined
      apiServer = await bindApiWithRetry({
        port: config.ui.apiPort,
        handler: apiHandler,
        staticDir,
        log,
      })
      if (staticDir) log(`控制台界面：http://127.0.0.1:${config.ui.apiPort}/`)
    } catch (error) {
      // 接口起不来**不该让机器人起不来** —— 它只是给 UI 用的辅助能力。
      // ★ 但**不许静默**：端口被别人占着是最可能的原因，而它的后果是
      //   "控制台显示的是另一个进程" —— 必须留一条 error 级证据。
      log(`❌ 配置接口未能启动：${error.message}`)
      log(
        '   → 机器人本体照常工作，但**控制台界面不可用**。' +
          '若你打开的控制台看起来"不对劲"，八成是另一个桥接进程还占着这个端口。',
      )
      log('   → 查占用：netstat -ano | findstr :' + config.ui.apiPort + '（最后一列是 PID）')
      apiServer = null
    }
  } else {
    log('配置接口已按配置关闭（ui.apiEnabled = false）')
  }

  // ── 优雅退出 ──
  //
  // ★★ 这里有一条贯穿全局的硬规则：**退出可以慢，但绝不能退不掉。**
  //
  // 起因是一次真实事故：旧进程卡住关不掉、和新进程抢端口与 PID。
  // 所以 shutdown 有**总预算**（SHUTDOWN_BUDGET_MS），到点就强制收尾并退出 ——
  // 每一小步各自还有自己的超时（bridge.close 8s、rpc.shutdown 15s），
  // 但"每一步都不超时"并不等于"总时间可控"，所以最外层必须有截止。
  let closing = false
  let apiServerClosed = false
  const SHUTDOWN_BUDGET_MS = 20_000

  /** 关掉配置接口（幂等：requestRestart 可能已经关过，释放端口用）。 */
  const closeApiServer = async () => {
    if (!apiServer || apiServerClosed) return
    apiServerClosed = true
    try {
      await apiServer.close()
    } catch {
      /* 关接口失败不影响退出 */
    }
    apiServer = null
  }

  /** 真正的收尾动作（由 shutdown 用预算包住）。 */
  const shutdownSteps = async () => {
    // ★ 顺序很重要：**先让在途回复发完，再关 QQ 通道**。
    //
    // 原来是反过来（第一件事就是 onebot.close()），后果实测过：
    // 一条回复因"静默时段"被延迟 116 秒，而使用者在它发出前重启了桥接 ——
    // 通道当场断开，那条**已经生成好**的回复永远丢了，使用者只看到"没理我"。
    try {
      await bridge.close()
    } catch (error) {
      log(`⚠️ 等待在途回复时出错（继续退出）：${error?.message ?? error}`)
    }
    onebot.close()
    await closeApiServer()

    // DSH：先请它自己收尾；**拿不到确认就强杀，并且强杀也要拿确认**。
    // 这一段是"孤儿 DSH 继续持有工作区"的根治点 —— 见 sdk-rpc.mjs 的 kill()。
    let stopped = { stopped: true }
    try {
      const graceful = await rpc.shutdown()
      if (!graceful.graceful) stopped = await rpc.kill()
    } catch (error) {
      log(`⚠️ 关停 DSH 时出错（转强杀）：${error?.message ?? error}`)
      stopped = await rpc.kill()
    }
    if (!stopped.stopped) {
      // 不许假装成功：这条日志是"工作区可能仍被占用"的唯一线索
      log(`❌ 未能确认 DSH 子进程退出：${stopped.error ?? '原因未知'}`)
      log('   → 它可能仍持有工作区与会话库。请检查任务管理器里的 node.exe，')
      log('     否则下一次启动会出现"两个 agent 写同一份工作区"。')
    } else if (stopped.method && stopped.method !== 'kill') {
      log(`DSH 子进程已强制终止（${stopped.method}，pid ${stopped.pid}）`)
    }
  }

  const shutdown = async (signal, { exitDelayMs = 0 } = {}) => {
    if (closing) return
    closing = true
    log(`收到 ${signal}，开始收尾…`)
    const startedAt = Date.now()
    let budgetTimer = null
    try {
      await Promise.race([
        shutdownSteps(),
        new Promise((resolve) => {
          budgetTimer = setTimeout(() => {
            log(
              `⚠️ 收尾超过 ${Math.round(SHUTDOWN_BUDGET_MS / 1000)} 秒预算，**强制退出**` +
                '（宁可少发一条在途回复，也不能留下一个退不掉的进程）',
            )
            resolve()
          }, SHUTDOWN_BUDGET_MS)
        }),
      ])
    } catch (error) {
      log(`⚠️ 收尾过程中出错（继续退出）：${error?.message ?? error}`)
    } finally {
      // 定时器必须清掉：pending 的 timer 会通过事件循环把退出拖住
      if (budgetTimer) clearTimeout(budgetTimer)
    }
    log(
      `=== 桥接退出（收到 ${bridge.stats.received} 条私聊，回复 ${bridge.stats.answered} 条，` +
        `收尾耗时 ${Date.now() - startedAt}ms）===`,
    )
    // exitDelayMs 是给"先响应 HTTP 再退出"那条路用的：立刻 process.exit 有可能
    // 抢在响应写完之前，UI 就会看到连接被重置而不是"已重启"。
    if (exitDelayMs > 0) setTimeout(() => process.exit(0), exitDelayMs)
    else process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (error) => {
    log(`❌ 未捕获异常：${error?.stack ?? error}`)
    // ★ 记完日志就收尾退出，**不要继续带着损坏的状态跑**。
    //   原来的实现只 log 不退出 —— 那正是"卡住但没死"的典型来源：
    //   进程还在，但半边状态已经丢/错，外部也看不出它坏了。
    //   退出后由 start.bat / 用户重新拉起，比带病运行安全得多。
    log('   → 未捕获异常后进程状态不可信，主动收尾退出（请重新启动）')
    void shutdown('uncaughtException', { exitDelayMs: 200 })
  })
  process.on('unhandledRejection', (error) => {
    // Promise 拒绝的处理同 uncaughtException：记日志 + 收尾退出。
    // 这里刻意与上面保持一致的策略，避免"一半情况会退出、一半不会"这种难查的差异。
    log(`❌ 未处理的 Promise 拒绝：${error?.stack ?? error}`)
    log('   → 未处理拒绝说明有失败路径没被接住，进程状态不可信，主动收尾退出')
    void shutdown('unhandledRejection', { exitDelayMs: 200 })
  })

  log('桥接已启动，等待消息…（Ctrl+C 退出）')
}

main().catch((error) => {
  console.error('启动失败：', error)
  process.exit(1)
})
