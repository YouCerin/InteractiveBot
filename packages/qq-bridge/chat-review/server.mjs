#!/usr/bin/env node
/**
 * 聊天记录评审台的启动壳（**独立小工具**，与控制台、桥接都无关）。
 *
 * 它只做三件事：解析命令行 → 从配置文件里拿工作区 → 监听 127.0.0.1 的端口。
 * 真正的服务实现与理由在 `src/chat-review-server.mjs`（放在那里是为了测试能直接
 * `createReviewServer(...)` 起一个，不必 spawn 子进程、不必抢端口）。
 *
 * 用法：
 *   node chat-review/server.mjs                 # 起在 http://127.0.0.1:4410/
 *   node chat-review/server.mjs --port 4411
 *   node chat-review/server.mjs --open          # 顺手用默认浏览器打开
 *   node chat-review/server.mjs --wait-port     # 端口被旧进程占着时先等一会儿（重启用）
 *
 * ★ 依赖：**零**（只用 Node 内置模块 + 本包自己的模块）。它不连桥接、不发消息、
 *   不改配置；读语料库（只读）与 `styles/闲聊.md`，写的是工作区里的评审数据。
 *
 * ⚠️ 整个主体都在 `isDirectRun` 里面：这个文件**只该被 node 直接执行**。
 *    第一版把 `server.listen()` 写在顶层、把"是不是直接执行"的判断放在文件末尾，
 *    结果是**任何 import 它的人都会意外起一个服务**（然后被末尾那句 close 收掉）——
 *    那种"import 一下就监听端口"的模块是排查噩梦，所以这里结构上就堵死。
 */

import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { createReviewServer, loadConfig } from '../src/chat-review-server.mjs'

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href

function main() {
  const argv = process.argv.slice(2)
  const argOf = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''
  }

  const config = loadConfig()
  const workspace = config.dsh?.workspace
  if (!workspace) {
    console.error('❌ 配置里没有 dsh.workspace，读不到语料库与评审数据')
    process.exit(1)
  }

  const port = Number(argOf('--port')) || 4410
  const styleName = argOf('--style') || config.chat?.mode?.style || ''
  const open = argv.includes('--open')
  const waitPort = argv.includes('--wait-port')

  const { server, styleFile, staticDir } = createReviewServer({
    workspace,
    styleName,
    log: (m) => console.log(m),
  })

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
      console.log(`[评审台] 端口 ${port} 还被旧进程占着，400ms 后重试（${tries}/${MAX_TRIES}）…`)
      setTimeout(() => server.listen(port, '127.0.0.1'), 400)
      return
    }
    if (error?.code === 'EADDRINUSE') {
      console.error(
        `❌ 端口 ${port} 已被占用 —— 换一个：node chat-review/server.mjs --port ${port + 1}\n` +
          `   （查占用：netstat -ano | findstr :${port}，最后一列是 PID）`,
      )
      process.exit(1)
    }
    console.error(`❌ 服务起不来：${error?.message ?? error}`)
    process.exit(1)
  })

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`
    console.log('')
    console.log('  聊天记录评审台（独立小工具，只监听本机）')
    console.log(`  ${url}`)
    console.log(`  工作区：${workspace}`)
    console.log(`  风格文件：${styleFile}`)
    console.log(`  静态页：${staticDir}`)
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
}

if (isDirectRun) main()
