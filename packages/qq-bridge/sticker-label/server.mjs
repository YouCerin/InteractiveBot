/**
 * 人工标注台的**启动壳**（只有"解析命令行 + 监听端口"这点事）。
 *
 * 真正的 HTTP 服务在 `../src/sticker-label-server.mjs` —— 放在 `src/` 下是为了
 * 能被测试直接 `createLabelServer(...)` 起一个（不必 spawn 子进程、不必抢端口），
 * 也为了满足 manifest 守卫"跨模块复用的代码必须在 src/ 下登记"。
 *
 * 用法（在 packages/qq-bridge 下）：
 *   node sticker-label/server.mjs            # 起标注台（用 config.json 的工作区与库目录）
 *   node sticker-label/server.mjs --port 4399
 *   node sticker-label/server.mjs --open     # 顺手打开浏览器
 * 或者双击 `sticker-label/启动标注.bat`。
 */

import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { createLabelServer, loadConfig } from '../src/sticker-label-server.mjs'
import { stickerRoot } from '../src/sticker-library.mjs'

async function main() {
  const argv = process.argv
  const argOf = (f) => {
    const i = argv.indexOf(f)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const config = loadConfig()
  const workspace = config.dsh?.workspace
  if (!workspace) {
    console.error('❌ 配置里没有 dsh.workspace，读不到表情库')
    process.exit(2)
  }
  const dir = config.skills?.sticker?.libraryDir ?? 'stickers'
  const port = Number(argOf('--port')) || 4399

  const server = createLabelServer({ workspace, dir, log: (m) => console.log(m) })

  /**
   * `--wait-port` = 端口被占时**先等一会儿再试**（默认重试 10 次 × 400ms）。
   *
   * ★★ 为什么必须有它（实测踩到）：UI 上的「重启服务」是"**先拉起新进程、再关掉旧的**"
   *   （反过来会有一段没人接手的空窗）。可旧进程**不会立刻释放端口** ——
   *   新进程一绑就撞 `EADDRINUSE`，于是"重启"变成"关掉之后再也起不来"，
   *   日志里只有一行"端口已被占用"。
   *
   * ∴ 重启用 `--wait-port` 拉起：新进程自己等旧进程让出端口，等到了就正常起。
   *   普通手动启动**不加这个参数** —— 那时端口被占是真的冲突，应该立刻报错说清楚。
   */
  const waitPort = argv.includes('--wait-port')
  const maxTries = waitPort ? 10 : 1
  let attempt = 0
  let exited = false

  server.on('error', (error) => {
    if (error?.code === 'EADDRINUSE' && !exited) {
      attempt += 1
      if (attempt < maxTries) {
        console.log(`[标注台] 端口 ${port} 还被旧进程占着，${400}ms 后重试（${attempt}/${maxTries - 1}）…`)
        setTimeout(() => {
          if (!exited) server.listen(port, '127.0.0.1')
        }, 400)
        return
      }
      // ★★ `--wait-port` 下**绝不能在这里退出**。
      //   这个进程现在已经能"原地重听"（见 `rebindInPlace`）：页面上的「重启服务」
      //   会先关监听再绑回来，中间那一小段里 `server.listen()` 可能报 EADDRINUSE。
      //   若按普通启动那样在这里 `process.exit(1)`，就等于**把正在重听的进程杀掉** ——
      //   表现是"点了重启，服务直接没了"。等不到端口只说明这一次绑得慢，交给上层重试。
      if (waitPort) {
        console.log(`[标注台] 端口 ${port} 暂时还被占着（第 ${attempt} 次），继续留在进程里等下一轮…`)
        return
      }
      console.error(
        `❌ 端口 ${port} 一直被占用（等了 ${(maxTries - 1) * 400}ms）—— ` +
          '要么它被另一个标注台占着（在页面上点「✕ 退出」，或换端口），要么换一个端口：' +
          'node sticker-label/server.mjs --port 4400',
      )
    } else if (!exited) {
      console.error(`❌ 起服务失败：${error?.message ?? error}`)
    }
    exited = true
    process.exit(1)
  })

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`
    console.log('')
    console.log('  表情包人工标注台（独立工具，不属于控制台后台）')
    console.log(`  表情库：${stickerRoot({ workspace, dir })}`)
    console.log('')
    console.log(`  ★ 打开：${url}`)
    console.log('')
    console.log('  两个页签：')
    console.log('    · 逐张标注 —— 点标签贴上（数字键 1-9）｜← → 翻页｜空格跳过｜Ctrl+Z 撤销')
    console.log('    · 按标签看图 —— 左边点标签看这批图长什么样，还能现场新建/改标签')
    console.log('  ★ 标成 manual 的条目**重打标签时会跳过**，不会被模型覆盖。')
    console.log('  ★ 改完**不用重启**桥接：它每轮现读词表与库文件，下一轮对话就生效。')
    console.log('')
    console.log('  按 Ctrl+C 退出。')
    console.log('')
    if (argv.includes('--open')) {
      try {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
      } catch {
        /* 打不开浏览器不影响服务 */
      }
    }
  })
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main().catch((error) => {
    console.error(`❌ ${error?.message ?? error}`)
    process.exit(1)
  })
}
