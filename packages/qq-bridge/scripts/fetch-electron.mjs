// 一次性构建脚本：把 Electron 的**运行时**下下来并解到 node_modules/electron/dist。
//
// 为什么不用 electron 包自带的 postinstall：
//   ① 本沙箱里 `node_modules/.bin` 下的 .cmd 起不来（EPERM，实测 electron-winstaller
//      的 postinstall 就是这么失败的），而 postinstall 一旦失败 npm 会把整棵
//      node_modules **回滚**；
//   ② 那个 postinstall 走的是 github.com 的 release（本机连不通，实测连接超时）。
//   所以：`npm install --ignore-scripts` + 本脚本从镜像取 + electron-builder 用
//   `electronDist` 直接吃这个目录（那样它自己也**不会**再下一次）。
//
// 用法：node scripts/fetch-electron.mjs [版本]
//
// ⚠️ 位置说明：它在**包根的 `scripts/`** 下（不在 `desktop/` 里），与
//   assemble-desktop / patch-electron-builder 是同一类"构建期脚本"。
//   第一版把它放在 `desktop/scripts/` 下，结果 `verify-manifest` 那条
//   "AGENT.md 里引用的文件都存在"直接报了红 —— 那条检查是**对的**：
//   构建脚本集中在包根一处，找起来才不用猜。
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..', 'desktop')
const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'))
const version = process.argv[2] ?? pkg.devDependencies?.electron
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`❌ 拿不到 Electron 版本号（package.json 里是 ${JSON.stringify(pkg.devDependencies?.electron)}）`)
  process.exit(1)
}

const distDir = join(DESKTOP, 'node_modules', 'electron', 'dist')
const ELECTRON_PKG = join(DESKTOP, 'node_modules', 'electron')

/**
 * 写 `node_modules/electron/path.txt` —— **`require('electron')` 靠它找可执行文件**（0.2.5 补）。
 *
 * ★★ 为什么必须有这一步（真事故，用户实测撞上）：
 *   我们**刻意**用 `npm install --ignore-scripts` 跳过 electron 官方的 postinstall（理由见文件头），
 *   但**官方 postinstall 里正包含"写这个 path.txt"这一件事**。于是"下 zip + 解压"只做了它的一半：
 *   `dist/electron.exe` 明明在，而 `require('electron')`（`electron/index.js` 读 `path.txt`
 *   拿二进制文件名）会抛 `Electron failed to install correctly, please delete node_modules/electron
 *   and try installing again`。而 `npm run desktop` = `electron/cli.js`，**第一行**就是
 *   `require('electron')` ⇒ **源码侧开窗口必然失败**。
 *   （发布包那条路没事：electron-builder 走 `electronDist` 目录，根本不 require electron 包 ——
 *     所以只有源码侧会撞上，这也是它一直没被发现的原因。）
 *   ⇒ 这一步是"跳过 postinstall"必须自己补上的另一半，且**幂等**：每次跑都确保它在。
 */
function ensurePathTxt () {
  const name =
    process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron'
        : 'electron'
  const file = join(ELECTRON_PKG, 'path.txt')
  try {
    const cur = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
    if (cur === name) return false
    writeFileSync(file, name, 'utf8')
    return true
  } catch (error) {
    console.error(
      `❌ 写不了 ${file}：${error?.message ?? error}\n` +
        '   （没有它，`npm run desktop` 会报 "Electron failed to install correctly"）',
    )
    process.exit(1)
  }
}

if (existsSync(join(distDir, 'electron.exe'))) {
  const fixed = ensurePathTxt()
  console.log(`✅ Electron 运行时已就位：${distDir}`)
  if (fixed) {
    console.log('   并把 node_modules/electron/path.txt 补上了（跳过 postinstall 时必须自己写，见本文件注释）')
  }
  process.exit(0)
}
if (!existsSync(join(DESKTOP, 'node_modules', 'electron', 'package.json'))) {
  console.error('❌ 先跑 `npm install --ignore-scripts`（desktop/ 目录下）—— 没有 electron 包就没有地方解运行时')
  process.exit(1)
}

const mirror = process.env.ELECTRON_MIRROR ?? 'https://registry.npmmirror.com/-/binary/electron/'
const url = `${mirror.replace(/\/?$/, '/')}v${version}/electron-v${version}-win32-x64.zip`
const zip = join(DESKTOP, '.npm-cache', `electron-v${version}-win32-x64.zip`)
mkdirSync(dirname(zip), { recursive: true })

if (!existsSync(zip) || statSync(zip).size < 50 * 1024 * 1024) {
  console.log(`下载 ${url}`)
  const res = await fetch(url, { signal: AbortSignal.timeout(900_000) })
  if (!res.ok) {
    console.error(`❌ 下载失败：HTTP ${res.status}（镜像 ${mirror}；换一个用 ELECTRON_MIRROR=… 再试）`)
    process.exit(1)
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zip))
  console.log(`  已保存 ${(statSync(zip).size / 1048576).toFixed(1)} MB → ${zip}`)
} else {
  console.log(`复用已下载的 ${zip}（${(statSync(zip).size / 1048576).toFixed(1)} MB）`)
}

rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })
// 用 PowerShell 的 Expand-Archive 而不是自己写解压：这里是 Windows 一次性构建脚本，
// 而 tar/7z 的可用性因环境而异（实测本沙箱里 tar 能跑、但没必要再引一个依赖）。
const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Path '${zip}' -DestinationPath '${distDir}' -Force`], { stdio: 'inherit' })
if (r.status !== 0 || !existsSync(join(distDir, 'electron.exe'))) {
  console.error(`❌ 解压失败（退出码 ${r.status}）`)
  process.exit(1)
}
const exe = join(distDir, 'electron.exe')
ensurePathTxt()
console.log(`✅ Electron ${version} 运行时就位：${exe}（${(statSync(exe).size / 1048576).toFixed(1)} MB）`)
console.log(
  existsSync(join(ELECTRON_PKG, 'path.txt'))
    ? "   已写 node_modules/electron/path.txt（= electron.exe）—— require('electron') / cli.js 靠它"
    : '   ⚠️ path.txt 没能确认（源码侧 `npm run desktop` 可能报 "Electron failed to install correctly"）',
)
const vf = join(distDir, 'version')
if (existsSync(vf)) console.log(`   版本文件：${readFileSync(vf, 'utf8').trim()}`)
