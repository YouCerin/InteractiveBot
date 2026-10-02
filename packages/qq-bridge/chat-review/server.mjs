#!/usr/bin/env node
/**
 * 聊天记录评审台的启动壳（**独立小工具**，与控制台、桥接都无关）。
 *
 * 它只做四件事：解析命令行 → 拿工作区 → **把端口上那份旧的请走** → 监听 127.0.0.1。
 * 真正的服务实现与理由在 `src/chat-review-server.mjs`（放在那里是为了测试能直接
 * `createReviewServer(...)` 起一个，不必 spawn 子进程、不必抢端口）。
 *
 * 用法：
 *   node chat-review/server.mjs                 # 起在 http://127.0.0.1:4410/
 *   node chat-review/server.mjs --port 4411
 *   node chat-review/server.mjs --open           # 顺手用默认浏览器打开
 *   node chat-review/server.mjs --no-replace     # **不**动已在跑的那份（直接报端口被占）
 *   node chat-review/server.mjs --wait-port      # 端口被占时先等一会儿再试（重启用）
 *
 * ★ 启动时会先「接管端口」（用户 2026-10-02 明确要求）：如果 4410 上已经有一份
 *   评审台在跑，先请它退出（`POST /api/shutdown`），必要时再走进程登记里那条
 *   带身份校验的停进程；**认不出对方是谁就绝不动手**。详见
 *   `src/chat-review-server.mjs` 的 `stopRunningReviewServer`。
 *
 * ★ 依赖：**零**（只用 Node 内置模块 + 本包自己的模块）。它不连桥接、不发消息、
 *   不改配置；读语料库（只读）与 `src/voice.mjs` 里那份说话方式，写的是工作区里的评审数据。
 *
 * ⚠️ 整个主体都在 `isDirectRun` 里面：这个文件**只该被 node 直接执行**。
 *    第一版把 `server.listen()` 写在顶层、把"是不是直接执行"的判断放在文件末尾，
 *    结果是**任何 import 它的人都会意外起一个服务**（然后被末尾那句 close 收掉）——
 *    那种"import 一下就监听端口"的模块是排查噩梦，所以这里结构上就堵死。
 */

import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { createReviewServer, loadConfig, stopRunningReviewServer } from '../src/chat-review-server.mjs'
import { PKG_ROOT } from '../src/local.mjs'
import { createProcessGuard } from '../src/process-guard.mjs'

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href

/** 进程登记里的档位名（与桥接的 `bridge` 分开 —— 两者的冲突提示互不打扰）。 */
const PROFILE = 'chat-review'

async function main() {
  const argv = process.argv.slice(2)
  const argOf = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''
  }

  const config = loadConfig()
  const workspace = config.dsh?.workspace
  if (!workspace) {
    console.error('❌ 配置里没有 dsh.workspace，读不到语料库与评审数据')
    process.exitCode = 1
    return
  }

  const port = Number(argOf('--port')) || 4410
  const open = argv.includes('--open')
  const waitPort = argv.includes('--wait-port')
  const replace = !argv.includes('--no-replace')
  const log = (m) => console.log(m)
  /** 起过的服务（退出时先关它，见 `exitSoon`）。 */
  let liveServer = null

  /**
   * 退出：**先让事件循环自然排空，2 秒兜底强退**。
   *
   * ★★ 为什么不直接 `process.exit(code)`（2026-10-02 实测踩到）：这条启动路径上
   *   做过 `fetch`（请旧实例退出）与 `spawnSync`（进程登记要读别的进程命令行），
   *   而在这台 Windows 上、**退出那一刻**会打出 libuv 的
   *   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`。
   *   结果虽然是对的（确实退出了、退出码也对），但窗口里那行红字会把人吓一跳，
   *   而且它**只在退出路径上出现**，属于"再赌一次也不一定复现"的时序问题。
   *   ∴ 不去赌：登记摘掉、监听关掉之后让循环自己排空（心跳是 `unref` 的，
   *   没有任何东西会拖住它）；万一还有句柄没放，2 秒后强退 —— 那时管道/子进程
   *   早已拆干净，不会再撞上那个断言。
   */
  function exitSoon(code) {
    try {
      guard.release()
    } catch {
      /* 退出路径不抛 */
    }
    try {
      if (liveServer?.listening) liveServer.close()
    } catch {
      /* 同上 */
    }
    process.exitCode = code
    const force = setTimeout(() => {
      log(`（事件循环没排空，${code === 0 ? '正常' : '带错误'}退出）`)
      process.exit(code)
    }, 2000)
    // 兜底计时器本身不许拖住进程：能自然退出时它根本不会触发
    if (typeof force.unref === 'function') force.unref()
  }

  // ── 进程登记：**为了让下一个实例能安全地认出并停掉我** ────────────────────
  // 为什么必须有它：没有登记时，"启动时先接管端口"就只能靠猜 PID —— 而盲杀一个
  // PID 可能杀掉恰好复用了那个号的无辜进程。登记里带着 instanceId，
  // `killEntry` 会拿它去命令行里比对，PID 被复用的情况会被当场拒绝。
  //
  // ★ `reportConflicts: false`：下面就要**接管端口**了，先喊一句"还有别的在跑"
  //   再默默把它停掉，只会让人以为出了问题（这条是实测：接管成功的那次启动，
  //   屏幕上先出现一段吓人的冲突警告，然后才是"已接管"）。
  const guard = createProcessGuard({
    pkgRoot: PKG_ROOT,
    profile: PROFILE,
    port,
    log,
    reportConflicts: false,
  })
  const claim = guard.claim()
  guard.startHeartbeat()

  // ── 启动第一步：把端口上那份旧的请走 ────────────────────────────────────
  if (replace) {
    const stop = await stopRunningReviewServer({
      port,
      log,
      listRunning: () => guard.list(),
      kill: (pid) => guard.killEntry(pid),
    })
    if (!stop.ok) {
      // 停不掉就**别急着 listen**（那样只会得到一句更难懂的 EADDRINUSE）
      console.error(`❌ ${stop.why}`)
      if (stop.foreign) {
        console.error(`   → 端口 ${port} 上的东西不是评审台，我不会去动它。换个端口：--port ${port + 1}`)
      }
      exitSoon(1)
      return
    }
    if (stop.how !== 'none') log(`   （接管端口 ${port}：${stop.how === 'graceful' ? '旧实例已自己退出' : `已停掉 pid ${stop.pid}`}）`)
  } else if (await hasOccupant(port)) {
    console.error(`❌ 端口 ${port} 上已经有一份评审台，而你加了 --no-replace（不接管端口）`)
    console.error(`   → 直接再开一份：去掉 --no-replace；或换端口：--port ${port + 1}`)
    exitSoon(1)
    return
  }

  const { server, styleFile, staticDir } = createReviewServer({
    workspace,
    log,
    // ★ 整理（把评论归纳成**修改意见**）要调一次模型：通路与桥接**共用同一套解析**
    //   （`resolveDirectTarget`：key 从哪来、baseUrl、model），密钥不经过浏览器。
    config,
    // ⚠️ 0.3.0alpha：这里**不再**传风格文件相关的选项 —— 评审的目标现在是
    //   `src/voice.mjs` 的 `VOICE_STYLE`（**唯一**一份说话方式），而它就在包里、
    //   路径由 `voiceSourcePath()` 算，不需要也不再允许从配置里挑一份。
    //   所以 `--style` 这个开关一并删掉了（留着会让人以为还能换一份）。
    //   仍然不传任何"写入"目标：产物是修改意见，由人拿去给 LLM 执行。
    // ★ 被 `/api/shutdown` 请退时干什么：走同一个退出路径（自然排空 + 2 秒兜底）。
    //   不在这里 `server.close()` 是因为 `server` 还没赋值 —— `exitSoon` 用的是
    //   外层的 `liveServer`（下面 listen 成功后赋值）。
    onShutdown: () => exitSoon(0),
  })
  liveServer = server

  /** 端口上是不是已经有评审台在跑（只用来给 `--no-replace` 报一句人话）。 */
  async function hasOccupant(p) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(700) })
      const body = await res.json().catch(() => null)
      return Boolean(body && body.tool === 'chat-review')
    } catch {
      return false
    }
  }

  /**
   * 端口被占时**先等一会儿再试**（只在 `--wait-port` 下）。
   *
   * 为什么需要：重启这个工具的做法是"拉起新进程 + 关掉旧进程"，而旧进程不会瞬间
   * 释放端口（Windows 上尤其明显）。没有这一步时，重启会直接 EADDRINUSE 退出，
   * 使用者看到的是"点了一下，窗口自己关了"。默认不等待：第一次启动时端口被占，
   * 十有八九是**别的东西**占着，那时候应该立刻说清楚而不是傻等。
   */
  let tries = 0
  const MAX_TRIES = 15
  server.on('error', (error) => {
    if (error?.code === 'EADDRINUSE' && waitPort && tries < MAX_TRIES) {
      tries += 1
      console.log(`[评审台] 端口 ${port} 还被占着，400ms 后重试（${tries}/${MAX_TRIES}）…`)
      setTimeout(() => server.listen(port, '127.0.0.1'), 400)
      return
    }
    if (error?.code === 'EADDRINUSE') {
      console.error(
        `❌ 端口 ${port} 已被占用 —— 换一个：node chat-review/server.mjs --port ${port + 1}\n` +
          `   （查占用：netstat -ano | findstr :${port}，最后一列是 PID；` +
          `若那确实是评审台，说明它不接受被关闭，请手动关掉它的窗口）`,
      )
      exitSoon(1)
      return
    }
    console.error(`❌ 服务起不来：${error?.message ?? error}`)
    exitSoon(1)
  })

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`
    console.log('')
    console.log('  聊天记录评审台（独立小工具，只监听本机）')
    console.log(`  ${url}`)
    console.log(`  工作区：${workspace}`)
    console.log(`  说话方式：${styleFile}`)
    console.log(`  静态页：${staticDir}`)
    // ★ 只有**别的端口**上的评审台才值得提一句：同一端口那份刚刚已经被我们接管了，
    //   而不同端口的两个实例会**同时写同一份评审数据**（`runtime/chat-review/`），
    //   后写的覆盖先写的 —— 这是真正需要使用者知道的后果。
    const otherPorts = claim.conflicts.filter((c) => Number(c.port) !== port)
    if (otherPorts.length) {
      console.log(
        `  ⚠️ 还有 ${otherPorts.length} 份评审台在**别的端口**上跑（${otherPorts
          .map((c) => `pid ${c.pid}${c.port ? ` → 端口 ${c.port}` : ''}`)
          .join('、')}）：它们和你共用同一份评审数据，两边同时改会互相覆盖`,
      )
    }
    console.log('  关掉这个窗口即停止。')
    console.log('')
    if (!open) return
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
      } else {
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
      }
    } catch (error) {
      console.log(`（没能自动打开浏览器：${error?.message ?? error} —— 手动访问上面的地址即可）`)
    }
  })

  // 前台运行时 Ctrl+C 是最常见的退出方式：**把登记清掉**再走，
  // 否则下一个人会在 `--processes` 里看到一条要等心跳过期才消失的假记录。
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => exitSoon(0))
  }
}

if (isDirectRun) main()
