/**
 * 组装桌面壳（`InteractBot.exe` 那一份）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么是"先 stage 再打包"，而不是直接 `electron-builder desktop/`
 * ══════════════════════════════════════════════════════════════════════════
 * 直接打会失败，而且失败原因与本项目**无关**：
 *
 *   ⨯ spawn EPERM   failedTask=build
 *     at node-module-collector/nodeModulesCollector.ts:376
 *
 * electron-builder 会为了"收集运行期依赖"去起一个子进程跑 `npm list`，并用
 * **管道**读它的输出；而本机沙箱禁止"通过管道截获另一个程序的输出"（EPERM）。
 * 结果是：一个**零运行期依赖**的壳，因为 npm 跑不起来而打不出包。
 *
 * ★ 修法不是"想办法让 npm 跑起来"，而是**把这一步整个去掉**：
 *   桌面壳的运行期依赖是 **0**（它只用 Electron 自己的 API 与 node 内置模块，
 *   见 desktop/package.json —— 那里刻意没有 `dependencies`）。
 *   所以这里先把 4 个源文件 + 图标 stage 到一个**没有 node_modules 的临时目录**，
 *   再让 electron-builder 打那个目录；它到了收集那一步会发现"没什么可收集的"。
 *
 * ★★ 顺带的两个好处（都不是巧合，是顺着这个修法来的）：
 *   ① 打进 app 的东西**可枚举**：就是 stage 目录里那几个文件。不存在
 *      "顺手把 desktop/node_modules 也塞进去"这种事（那会让包多出 200MB）；
 *   ② stage 目录的内容与源文件**逐一比对**过（下面 verifyStage），
 *      所以"打包用的到底是哪份代码"不需要靠信任。
 *
 * 用法：
 *   node scripts/assemble-desktop.mjs            # 组装到 packages/qq-bridge/.build-desktop/win-unpacked
 *   node scripts/assemble-desktop.mjs --dry-run  # 只报告，不写盘
 *   node scripts/assemble-desktop.mjs --out <目录>
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const DESKTOP = join(PKG_ROOT, 'desktop')
// 产物根。**每次构建换一个新目录**（见下面 stage 那段的注释：Windows 上
// `win-unpacked` 里的文件可能被 Defender/索引器短暂占住，导致"上次的产物删不掉"，
// 而 electron-builder 会去 unlink 它并失败 —— EBUSY）。
const BUILD_ROOT = join(PKG_ROOT, '.build-desktop')
const STAGE = join(PKG_ROOT, 'cache', 'desktop-stage')

/** 要打进 app 的**全部**文件（相对 desktop/）。多一个少一个都要在这里改。 */
const APP_FILES = ['main.cjs', 'preload.cjs', 'lib.cjs', 'splash.html', join('assets', 'app-icon.ico')]

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
// 默认输出目录带上时间戳：与上次的产物**不共用路径**，于是"删不掉"不再是阻碍。
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
const OUT = resolve(
  args.includes('--out') ? args[args.indexOf('--out') + 1] : join(BUILD_ROOT, `pack-${stamp}`),
)
/** 给发布组装脚本用的稳定入口：最近一次成功构建的目录写在这里。 */
const LATEST = join(BUILD_ROOT, 'latest.json')

let failures = 0
const log = (m) => console.log(m)
const bad = (m) => {
  failures += 1
  console.log(`❌ ${m}`)
}

log('')
log('组装桌面壳 InteractBot.exe')
log(`  app 源：${DESKTOP}`)
log(`  产物  ：${OUT}`)
if (DRY) log('  ⚠️ --dry-run：只报告，不写盘')

// ── ① 前置检查：源文件、图标、本机 Electron 运行时 ────────────────────────
log('')
log('── ① 前置检查 ──')
for (const rel of APP_FILES) {
  if (!existsSync(join(DESKTOP, rel))) bad(`缺少 desktop/${rel}`)
}
const pkgJson = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'))
const electronVersion = pkgJson.devDependencies?.electron
if (!/^\d+\.\d+\.\d+$/.test(String(electronVersion))) {
  bad(`desktop/package.json 里的 electron 不是精确版本：${JSON.stringify(electronVersion)}`)
}
const electronDist = join(DESKTOP, 'node_modules', 'electron', 'dist')
if (!existsSync(join(electronDist, 'electron.exe'))) {
  bad(
    '本机没有 Electron 运行时 —— 先跑：\n' +
      '     cd desktop && npm install --ignore-scripts && node scripts/fetch-electron.mjs\n' +
      '   （为什么不用 electron 包自带的 postinstall：见 scripts/fetch-electron.mjs 顶部）',
  )
}
if (pkgJson.dependencies && Object.keys(pkgJson.dependencies).length > 0) {
  bad(`desktop/package.json 有运行期 dependencies（${Object.keys(pkgJson.dependencies).join('、')}）—— 壳必须是零依赖`)
}
if (failures > 0) {
  log('')
  bad('前置检查没过 —— 不组装')
  process.exit(1)
}
log(`   ✅ ${APP_FILES.length} 个 app 文件都在，Electron ${electronVersion} 运行时就位，零运行期依赖`)

if (DRY) {
  log('')
  log('--dry-run 结束：上面就是全部动作，未写盘。')
  process.exit(0)
}

// ── ② stage（一份**没有 node_modules** 的 app 源）────────────────────────
log('')
log('── ② stage（这一步是"能打出包"的关键）──')
rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })
for (const rel of APP_FILES) {
  const from = join(DESKTOP, rel)
  const to = join(STAGE, rel)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
}
// package.json 只带必要字段：`main` 必须对，devDependencies 不进去
writeFileSync(
  join(STAGE, 'package.json'),
  `${JSON.stringify(
    {
      name: 'interactbot-desktop',
      productName: 'InteractBot',
      version: readFileSync(join(PKG_ROOT, 'package.json'), 'utf8') ? JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version : '0.0.0',
      description: 'InteractBot 桌面壳（控制台窗口 + 启动器）',
      main: 'main.cjs',
      author: 'InteractBot',
    },
    null,
    2,
  )}\n`,
  'utf8',
)
// ★ 自校验：stage 里的每个文件都必须与源**逐字节**相同。
//   "打包用的到底是哪份代码"这个问题不该靠信任（本项目在 UI 产物上脱钩过一次）。
{
  const problems = []
  for (const rel of APP_FILES) {
    const a = readFileSync(join(DESKTOP, rel))
    const b = readFileSync(join(STAGE, rel))
    if (Buffer.compare(a, b) !== 0) problems.push(rel)
  }
  if (problems.length) bad(`stage 与源不一致：${problems.join('、')}`)
  else log(`   ✅ stage 完成，${APP_FILES.length + 1} 个文件与源逐字节一致`)
  // 反向断言：stage 里**不许**出现 node_modules（那正是这次要绕开的东西）
  if (existsSync(join(STAGE, 'node_modules'))) bad('stage 里出现了 node_modules —— 那会让 electron-builder 又去跑 npm list')
}

// ── ③ 打包 ────────────────────────────────────────────────────────────────
log('')
log('── ③ electron-builder（免安装目录版）──')

// ★ 顺手清掉**旧的**构建目录（保留本次的 OUT）：它们每一个都 ~250 MB。
//   ⚠️ 清不掉是**正常**的、不算失败：Windows 上 Defender / 搜索索引器会短暂占住
//      里面的文件（实测 EBUSY: unlink 'default_app.asar'），而那不是本次构建的问题。
//      这种情况只提示一句"可以手工删"，绝不因此把构建判失败 —— 假失败会让人去改脚本。
{
  if (existsSync(BUILD_ROOT)) {
    let removed = 0
    let stuck = 0
    for (const name of readdirSync(BUILD_ROOT)) {
      if (name === 'latest.json' || name === `pack-${stamp}`) continue
      try {
        rmSync(join(BUILD_ROOT, name), { recursive: true, force: true })
        removed += 1
      } catch {
        stuck += 1
      }
    }
    if (removed) log(`   · 清掉了 ${removed} 个旧构建目录`)
    if (stuck) log(`   · ${stuck} 个旧构建目录这次删不掉（多半是 Defender/索引器正占着）—— 稍后手工删即可，不影响本次`)
  }
}

const builderYml = join(DESKTOP, 'electron-builder.yml')
if (!existsSync(builderYml)) bad(`缺少 ${builderYml}`)

// ★ 先给 electron-builder 打补丁（幂等）：它的依赖收集器会用**管道**读子进程输出，
//   而本机沙箱禁止这件事 ⇒ `⨯ spawn EPERM` ⇒ 整个构建失败（实测两次）。
//   补丁把"父进程用管道读、再转写进文件"改成"子进程直接写那个文件"。
//   完整理由与失败处理见 scripts/patch-electron-builder.mjs。
{
  const patch = join(HERE, 'patch-electron-builder.mjs')
  if (!existsSync(patch)) bad(`缺少补丁脚本 ${patch}`)
  else {
    const p = spawnSync(process.execPath, [patch], { cwd: PKG_ROOT, stdio: 'inherit' })
    if (p.status !== 0) bad(`打补丁失败（退出码 ${p.status ?? '?'}）—— 不打补丁就打不出包，故在此停下`)
  }
}
if (failures > 0) process.exit(1)

// ★ 生成一份"跑在 stage 里"的配置：只覆盖**两个必须按本机绝对路径来**的键，
//   其余（files / win.target / asar / electronDist …）**原样**来自 desktop/electron-builder.yml。
//
//   为什么非覆盖不可（放默认值就是在猜）：
//     · `directories.output`：相对路径在不打包运行时是相对 **package.json** 解析的，
//       而 stage 时相对 stage ⇒ 产物会落到 cache/desktop-stage/ 里面（意料之外的位置）；
//     · `win.icon`：electron-builder 会拿 `buildResources` 去解析它，而 buildResources
//       在配置里是 `desktop/` —— 与 projectDir（stage）不是同一个目录。
//   两处都写绝对路径，含糊就没了。
//
// ⚠️ 这里**必须 parse 后合并**，不能"把两段 YAML 拼起来"：
//   拼起来会出现两个 `directories:` / 两个 `win:` 键 —— js-yaml 按**重复键**报错
//   （实测：`⨯ duplicated mapping key (28:1)`），而且报错位置指向第二段的第一行，
//   看起来像"配置里多了一行"，完全不像"这次覆盖写坏了"。
//   用 electron-builder 自己带的 js-yaml 解析，再以 JSON 落盘（YAML 是 JSON 的超集）。
const stageYml = join(STAGE, 'electron-builder.json')
{
  // ⚠️ js-yaml 不是本包的依赖，而是 electron-builder 的**传递依赖**，
  //    所以这里按**绝对路径** require 它（`import 'js-yaml'` 会去 scripts/ 下找，
  //    找不到就 ERR_MODULE_NOT_FOUND —— 实测踩过）。
  //    宁可这样，也不为了解析一次 YAML 就往包根加一个依赖。
  const { createRequire } = await import('node:module')
  const req = createRequire(join(DESKTOP, 'package.json'))
  const yaml = req('js-yaml')
  const base = yaml.load(readFileSync(builderYml, 'utf8'))
  const merged = {
    ...base,
    directories: { ...(base.directories ?? {}), output: OUT, buildResources: STAGE },
    win: { ...(base.win ?? {}), icon: join(STAGE, 'assets', 'app-icon.ico') },
    // ★ 同理：`electronDist` 在配置里写的是相对 projectDir 的路径，而 projectDir 是 stage
    //   （stage 里**没有** node_modules —— 那正是这次能打包成功的原因）。
    //   所以这里必须换成**绝对路径**指向 desktop/node_modules 里那份运行时。
    electronDist,
  }
  // 自校验：合并结果里这两个键必须真的是我们要的值（否则下面打出来的包会落在别处）
  if (merged.directories.output !== OUT) bad('生成的配置里 output 不是预期路径')
  if (!String(merged.win.icon).includes('app-icon.ico')) bad('生成的配置里 win.icon 不是预期文件')
  if (!existsSync(join(merged.electronDist, 'electron.exe'))) bad(`生成的配置里 electronDist 指不到运行时：${merged.electronDist}`)
  writeFileSync(stageYml, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  log(`   ✅ 生成 stage 配置（output=${relative(PKG_ROOT, OUT)}，icon=…/app-icon.ico）`)
}

const env = {
  ...process.env,
  // 镜像：本机连不上 github（实测连接超时），而 electron-builder 要下 winCodeSign
  // 来做"给 exe 换图标 + 写版本号"这一步。这两个环境变量它都认。
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/',
  // 构建缓存也落在包内（沙箱只允许写工作区）
  ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE ?? join(DESKTOP, '.npm-cache', 'eb-cache'),
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  // ★★ 把 build-tools/ 放到子进程 PATH 的**最前面**：那里面有一个 `npm.cmd` 替身。
  //
  //   为什么非这样不可：本机沙箱禁止"通过管道截获另一个程序的输出"，而 electron-builder
  //   收集运行期依赖时**一定**会起 `powershell → npm list` 并读它的管道 ⇒ `⨯ spawn EPERM`
  //   ⇒ 整个构建失败（实测两次）。桌面壳的运行期依赖是 0，所以那条收集没有意义；
  //   替身回一个空依赖树，收集器就会回落到它的**纯文件遍历**通路，照常打完。
  //   完整说明见 scripts/build-tools/npm-stub.mjs 顶部。
  //
  //   ⚠️ 只改这个子进程的 PATH —— 不改系统 PATH、不改 npm 配置、不动别的任何东西。
  PATH: `${join(PKG_ROOT, 'scripts', 'build-tools')}${sep}${process.env.PATH ?? ''}`,
}
// ⚠️ electron-builder 的入口是它自己包里的 js：直接 `node <path>` 起，
//    **不经过 npx / npm**（那两个也会想开管道，本沙箱里 EPERM）。
const builderBin = join(DESKTOP, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
if (!existsSync(builderBin)) {
  bad(`找不到 electron-builder 的入口：${builderBin}（先 cd desktop && npm install --ignore-scripts）`)
  process.exit(1)
}
const r = spawnSync(process.execPath, [builderBin, '--win', '--dir', '--projectDir', STAGE, '--config', stageYml], {
  cwd: STAGE,
  env,
  stdio: 'inherit',
})
if (r.error) bad(`起不了 electron-builder：${r.error.message}`)
if (r.status !== 0) bad(`electron-builder 退出码 ${r.status ?? '?'}`)

// ── ④ 验收：产物在哪、叫什么、多大 ────────────────────────────────────────
log('')
log('── ④ 产物验收 ──')
const unpacked = join(OUT, 'win-unpacked')
const exe = join(unpacked, 'InteractBot.exe')
if (!existsSync(exe)) {
  bad(`没有打出 ${exe}\n   看看 electron-builder 的输出：失败通常只有一行 ⨯（不要只看最后一段）`)
} else {
  const appDir = join(unpacked, 'resources', 'app')
  const sizeMb = (dir) => {
    let n = 0
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.isFile()) n += statSync(p).size
      }
    }
    walk(dir)
    return n / 1024 / 1024
  }
  log(`   ✅ ${relative(PKG_ROOT, exe)}（exe 本体 ${(statSync(exe).size / 1024 / 1024).toFixed(1)} MB）`)
  log(`   ✅ 目录合计约 ${sizeMb(unpacked).toFixed(1)} MB`)
  for (const rel of ['main.cjs', 'preload.cjs', 'lib.cjs', 'splash.html', join('assets', 'app-icon.ico')]) {
    if (!existsSync(join(appDir, rel))) bad(`app 里缺 ${rel}（它没被 files 白名单收进去）`)
  }
  if (existsSync(join(appDir, 'main.cjs'))) {
    // ★ 逐字节比对：app 里那份必须就是源里那份
    const same = Buffer.compare(readFileSync(join(appDir, 'main.cjs')), readFileSync(join(DESKTOP, 'main.cjs'))) === 0
    if (same) log('   ✅ app/main.cjs 与源逐字节一致（打包没换过代码）')
    else bad('app/main.cjs 与源不一致 —— 打进去的不是当前代码')
  }
  // ★ app 里**不许**出现 src/ 或 config-ui/：那是包根的东西（两份 = 两个真相）
  for (const forbidden of ['src', 'config-ui', 'vendor', 'node_modules']) {
    if (existsSync(join(appDir, forbidden))) bad(`app 里不该有 ${forbidden}/ —— 那是包根的东西，不该进 app`)
  }
  if (!existsSync(join(appDir, 'node_modules'))) log('   ✅ app 里没有 node_modules（壳是零运行期依赖）')
}

log('')
if (failures === 0) {
  // ★ 记下"最近一次成功的产物在哪"：发布组装脚本靠它找 exe，
  //   而不是去猜目录名（猜目录名在"多份构建共存"时会指到旧的那一份）。
  mkdirSync(BUILD_ROOT, { recursive: true })
  writeFileSync(
    LATEST,
    `${JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        electronVersion,
        unpacked: relative(PKG_ROOT, unpacked).replace(/\\/g, '/'),
        exe: relative(PKG_ROOT, exe).replace(/\\/g, '/'),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  log(`🎉 桌面壳组装完成：${unpacked}`)
  log(`   已记下最近一次产物：${relative(PKG_ROOT, LATEST)}`)
  log('   下一步：scripts/assemble-release.mjs 会把它平铺进发布包根目录')
  process.exit(0)
}
log(`⚠️ 有 ${failures} 项问题`)
process.exit(1)
