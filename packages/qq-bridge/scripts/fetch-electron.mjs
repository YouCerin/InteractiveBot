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
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
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
if (existsSync(join(distDir, 'electron.exe'))) {
  console.log(`✅ Electron 运行时已就位：${distDir}`)
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
console.log(`✅ Electron ${version} 运行时就位：${exe}（${(statSync(exe).size / 1048576).toFixed(1)} MB）`)
const vf = join(distDir, 'version')
if (existsSync(vf)) console.log(`   版本文件：${readFileSync(vf, 'utf8').trim()}`)
