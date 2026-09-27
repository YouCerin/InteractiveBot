/**
 * 从源码打开桌面窗口（`npm run desktop`）—— **一条不依赖 `require('electron')` 的启动器**（0.2.5 补）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么不用 electron 包自带的 `cli.js`
 * ══════════════════════════════════════════════════════════════════════════
 * `cli.js` 只做一件事：`spawn(require('./'), process.argv.slice(2))`。它有两个坑，都实测踩到过：
 *
 *   ① **`require('./')`（= `electron/index.js`）依赖 `node_modules/electron/path.txt`。**
 *      我们**刻意**用 `npm install --ignore-scripts` 跳过 electron 官方的 postinstall
 *      （它要从 github 下二进制，本机连不通；而且它一失败 npm 会把整棵 node_modules 回滚），
 *      而**官方 postinstall 里正包含"写这个 path.txt"这一件事**。缺它时报的是
 *      `Electron failed to install correctly, please delete node_modules/electron and try installing again`
 *      —— 可运行时（`dist/electron.exe` 200 MB）其实好好的。
 *      ⇒ `scripts/fetch-electron.mjs` 现在会幂等地把它补上（幂等：每次跑都确保它在）。
 *
 *   ② ★★ **`ELECTRON_RUN_AS_NODE` 会顺着环境变量传下去。** 这个变量让 electron 二进制
 *      "**当 Node 用**"；那种模式下 `require('electron')` 返回的是**包的路径字符串**，
 *      而不是 API ⇒ 壳在 `app.getAppPath()` 上抛
 *      `TypeError: Cannot read properties of undefined (reading 'getAppPath')`。
 *      实测来源（本机取证）：**DSH 自己的 node 垫片**
 *      `%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd` 里有 `set ELECTRON_RUN_AS_NODE=1`，
 *      于是任何"由它起的 Node → 再 spawn electron"的链路都会中招。
 *      ⇒ 本启动器**显式摘掉**这个变量再起子进程，并且**把这件事打出来**（不静默改环境）。
 *
 * 顺带两条小改进：app 目录用**绝对路径**传（不依赖 cwd）、退出码与信号原样转发。
 *
 * 用法：node scripts/run-desktop.mjs        （= npm run desktop）
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const DESKTOP = join(PKG_ROOT, 'desktop')
const ELECTRON_PKG = join(DESKTOP, 'node_modules', 'electron')

/** 官方口径的二进制名在 `path.txt` 里（Windows 是 `electron.exe`）。 */
function electronBinaryName () {
  const f = join(ELECTRON_PKG, 'path.txt')
  if (existsSync(f)) {
    const v = readFileSync(f, 'utf8').trim()
    if (v) return v
  }
  if (process.platform === 'win32') return 'electron.exe'
  if (process.platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron'
  return 'electron'
}

const exe = join(ELECTRON_PKG, 'dist', electronBinaryName())
if (!existsSync(exe)) {
  console.error(
    `❌ 没有 Electron 运行时：${exe}\n` +
      '   先把工具链准备好（首次一次即可）：\n' +
      '     cd desktop && npm install --ignore-scripts && cd ..\n' +
      '     npm run desktop:fetch\n',
  )
  process.exit(1)
}

// ★★ 摘掉 ELECTRON_RUN_AS_NODE（理由见文件头 ②）—— 其它环境原样透传
const env = { ...process.env }
if (env.ELECTRON_RUN_AS_NODE) {
  console.log(
    '[desktop] 注意到环境里有 ELECTRON_RUN_AS_NODE —— 已为子进程摘掉' +
      '（否则 electron 会「当 Node 用」，壳拿不到 app；DSH 的 node 垫片会设它）',
  )
  delete env.ELECTRON_RUN_AS_NODE
}

const child = spawn(exe, [DESKTOP], { stdio: 'inherit', env })
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig)
  })
}
child.on('close', (code, signal) => {
  if (code === null) {
    console.error(`[desktop] electron 被信号 ${signal} 结束`)
    process.exit(1)
  }
  process.exit(code)
})
