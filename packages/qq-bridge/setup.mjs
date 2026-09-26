#!/usr/bin/env node
/**
 * 一次性准备：把外部工具复制进包里，让整个包**换地方也能直接跑**。
 *
 * ── 为什么需要这一步（以及为什么用"复制"而不是"引用"）────────────────
 * 桥接要用的东西有三样在包外面：Node 运行时、`ws` 依赖、DSH 本体。
 * 如果直接用绝对路径引用它们，一旦把包拷到别的机器/别的盘，全会断。
 * 所以这里把**小的、必须的**复制进 `vendor/`，把**大的、可选的**留着
 * 用环境变量指定（见下面 DSH 的说明）。
 *
 * ── 幂等 ───────────────────────────────────────────────────────────────
 * 可以反复跑。已经存在的不会重复复制（除非加 --force）。
 * 已经就位的东西会打 ✅ 跳过，所以这个脚本也可以当"体检"用。
 *
 * 用法：
 *   node setup.mjs                   # 准备必需项（Node 运行时 + ws 依赖）
 *   node setup.mjs --release         # 打出发布包前的准备 + 发布前体检（★ 见下）
 *   node setup.mjs --with-snowluma --snowluma-source <目录>   # 本机自用，把协议端也收进来
 *   node setup.mjs --check           # 只体检，不复制
 *   node setup.mjs --force           # 覆盖已有的
 *
 * ── --release 做了什么、以及它**不做**什么 ─────────────────────────────
 * 做：① 备齐两个必需项（Node + ws）；② 跑一遍"发布前体检"（见 auditForRelease）：
 *     提醒你清空明文密钥、确认没有把不该分发的东西打进去。
 * 不做：它**不会**替你改 config.json —— 清理密钥是有副作用的动作，
 *     不能藏在一个"准备依赖"的脚本里偷偷做。体检只报告，不修改。
 *
 * 注意：**本脚本刻意不复制 DSH 本体**（约 275 MB）。DSH 属于"运行环境"，
 * 由 src/local.mjs 的 findDshCli() 按候选顺序定位，或用环境变量
 * DSH_DESKTOP_APP / config.json 的 dsh.searchPaths 指定。
 * **也不复制 SnowLuma** —— 它的许可证不允许随第三方安装包分发（见下）。
 */

import { cpSync, mkdirSync, existsSync, statSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIRS, PKG_ROOT, findNodeBinary, findDshCli, findDshCliWithSource, describeDshCandidates, describeLayout, resolveDshHome, readSearchPathsFromConfig } from './src/local.mjs'

const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const FORCE = args.includes('--force')
const RELEASE = args.includes('--release')
const WITH_SNOWLUMA = args.includes('--with-snowluma')
/**
 * `--json`：只输出**机器可读**的体检结果，不打印人看的报告。
 *
 * ★ 为什么需要它：`scripts/assemble-release.mjs` 要按类别判断"哪类 ❌ 该拦住组装、
 *   哪类只是提示"，而它**不能靠解析排版文本** —— 试过，代价是两头耦合：
 *   组装脚本挑 `❌` 前缀，而体检脚本成功时根本不打某些字，于是判通过时假失败。
 *   结构化输出把这条耦合变成**一份契约**（下面的 JSON 字段名就是契约）。
 *
 * 用法：`node setup.mjs --release --json` → stdout 只有一行 JSON
 */
const JSON_OUT = args.includes('--json')

/** 取 `--flag <值>` 形式的值（不存在则返回 null）。 */
function argValue(flag) {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}

/** `--json-out <路径>`：把结构化体检结果**写到文件**（绕开管道限制，见下）。 */
const JSON_OUT_FILE = argValue('--json-out')

const line = (s = '') => console.log(s)
function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 递归求目录大小（用于报告复制了多少）。 */
function dirSize(path) {
  let total = 0
  const walk = (p) => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        try {
          total += statSync(full).size
        } catch {
          /* 读不到就跳过 */
        }
      }
    }
  }
  try {
    walk(path)
  } catch {
    /* ignore */
  }
  return total
}

function copyFile(from, to, label) {
  if (existsSync(to) && !FORCE) {
    line(`✅ ${label} 已就位，跳过`)
    return true
  }
  if (!existsSync(from)) {
    line(`❌ ${label}：找不到源文件 ${from}`)
    return false
  }
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
  line(`📦 ${label} 已复制（${mb(statSync(to).size)}）`)
  return true
}

function copyDir(from, to, label) {
  if (existsSync(to) && !FORCE) {
    line(`✅ ${label} 已就位，跳过`)
    return true
  }
  if (!existsSync(from)) {
    line(`❌ ${label}：找不到源目录 ${from}`)
    return false
  }
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
  line(`📦 ${label} 已复制（${mb(dirSize(to))}）`)
  return true
}

/** 读一个包的版本号（读不到就返回 null —— 清单只是线索，不该因为读不到就失败）。 */
function readPackageVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * 在候选位置里找 ws 包（纯 JS，无原生模块）。
 *
 * ★ 这里**刻意不写死任何绝对路径**。以前第一候选是 `D:\QQagent_DeepSeek\node_modules\ws`
 * —— 那是开发机上的另一个项目，换台机器必然落空，而且失败信息会指向一个
 * 用户根本不认识的目录。现在按"包内 → 上一级 → 环境变量"的顺序找，
 * 找不到了就给出**可执行**的三条出路。
 *
 * @returns {string|null}
 */
function findWsSource() {
  const fromEnv = process.env.WS_SOURCE ? resolve(process.env.WS_SOURCE) : null
  const candidates = [
    join(DIRS.vendorNodeModules, 'ws'), // 已经准备好过（幂等重跑）
    join(PKG_ROOT, 'node_modules', 'ws'), // 本包 npm install 过
    join(PKG_ROOT, '..', '..', 'node_modules', 'ws'), // 工作区根装过
    fromEnv, // 显式指定（环境变量 WS_SOURCE）
  ]
  return candidates.find((p) => p && existsSync(join(p, 'index.js'))) ?? null
}

/**
 * SnowLuma 的源目录（仅 `--with-snowluma` 用）。
 *
 * ⚠️ 默认**不复制** SnowLuma 进包：它的 EULA §5.4 明确禁止"将其并入第三方安装包"，
 * LICENSE §5 也不授予原生组件（`snowluma-*.node`/`*.dll`）的再分发权利。
 * 所以发布包里没有它，用户自己去官方 Release 下载。
 * 这个开关只留给"自己机器上想摆成一体"的用法。
 */
function findSnowlumaSource() {
  const fromArg = argValue('--snowluma-source')
  const fromEnv = process.env.SNOWLUMA_SOURCE
  const candidates = [
    fromArg ? resolve(fromArg) : null,
    fromEnv ? resolve(fromEnv) : null,
    join(PKG_ROOT, '..', '..', 'snowluma'), // 工作区根（开发时的常见位置）
  ]
  return candidates.find((p) => p && existsSync(join(p, 'index.mjs'))) ?? null
}

line('')
line('═══ QQ 桥接 · 依赖准备 ═══')
line(`包根目录：${PKG_ROOT}`)
line(CHECK_ONLY ? '模式：仅体检' : '模式：准备（幂等，可重复执行）')
line('')

// ── 0. 体检现状 ──────────────────────────────────────────────────────────
line('── 当前布局 ──')
for (const row of describeLayout()) {
  line(`  ${row.present ? '✅' : '⬜'} ${row.label}`)
  line(`      ${row.path}`)
}
line('')

if (CHECK_ONLY) {
  // --check 模式下，DSH 是"必需但**不随包分发**"，要单独报告它是从哪来的。
  // ★ 必须把 config.json 里 `dsh.searchPaths` 也带进来 —— 否则会出现
  //   "体检说没找到、程序却跑得起来"这种自相矛盾（启动路径读配置，这里不读）。
  // ★ 找不到时把**所有**候选位置列出来 —— 只说一句"找不到"会让用户无从下手。
  const searchPaths = readSearchPathsFromConfig('dsh.searchPaths')
  const probed = findDshCliWithSource({ searchPaths })
  line('── 可搬迁性体检 ──')
  line(`  Node 运行时：${findNodeBinary() ?? '（找不到）'}`)
  line(`  DSH 本体  ：${probed ? `${probed.cliPath}` : '（没找到）'}`)
  if (probed) {
    line(`      来源：${probed.source}`)
    if (!probed.cliPath.startsWith(DIRS.vendorDsh)) {
      line('      ⚠️ 来自包外（这是既定设计：本包不分发 DSH）。换机器时要确认那台装了 DSH。')
    }
  } else {
    line('      它是**运行环境**，本包不分发，需要你自己装。已查过这些位置：')
    for (const c of describeDshCandidates({ searchPaths })) line(`        · ${c.source}`)
    line('        · 还可用环境变量 DSH_DESKTOP_APP 或 config.json 的 dsh.searchPaths 指定')
  }
  line('')
  process.exit(0)
}

line('── 开始复制 ──')
let ok = true

// ── 1. Node 运行时（必需）────────────────────────────────────────────────
// 为什么要复制 Node？因为"打包后直接能用"意味着不能指望目标机器装过 Node。
const nodeSrc = process.execPath
const nodeDest = join(DIRS.vendorNode, process.platform === 'win32' ? 'node.exe' : 'node')
ok = copyFile(nodeSrc, nodeDest, 'Node 运行时') && ok

// ── 2. ws 依赖（必需）────────────────────────────────────────────────────
const wsSrc = findWsSource()
if (!wsSrc) {
  line('❌ ws 依赖：找不到源。请任选一种方式：')
  line('     ① 在本目录执行 npm install ws --no-save，然后重跑本脚本')
  line('     ② 手工把 ws 包目录复制到 vendor/node_modules/ws')
  ok = false
} else {
  ok = copyDir(wsSrc, join(DIRS.vendorNodeModules, 'ws'), 'ws 依赖（纯 JS，无需编译）') && ok
}

// ── 3. 技能的 npm 依赖（**可选**：只有要挂代理出网的技能需要）─────────────
//
// 0.2.2 起包内可以装外部技能（`skills/<id>/`），而技能用的是**普通的 import('xxx')** ——
// 它没法像桥接自己那样用 createRequire 指到 vendor（那是宿主内部机制），
// 所以会在真机上直接 ERR_MODULE_NOT_FOUND。
// 修法：这里复制到 vendor/node_modules 的包，由桥接启动时**软链**到
// `skills/node_modules`（见 src/extensions.mjs 的 ensureSkillNodeModules）。
//
// 为什么是"可选、缺失只告警"：`ws` 是桥接的命脉，缺了就不能跑；而 `undici` 只被
// pixiv 那类"要挂代理"的技能用到 —— 缺了它们会**自己报「代理不可用」**，
// 机器人本体一切正常。把可选依赖做成硬失败，会让"我只想跑机器人"的人卡住。
const OPTIONAL_SKILL_DEPS = ['undici']
line('')
line('ℹ️  技能的 npm 依赖（可选）：' + OPTIONAL_SKILL_DEPS.join('、'))
for (const dep of OPTIONAL_SKILL_DEPS) {
  const dest = join(DIRS.vendorNodeModules, dep)
  if (existsSync(join(dest, 'package.json'))) {
    line(`    ✅ ${dep} 已就位`)
    continue
  }
  const src =
    [join(PKG_ROOT, 'node_modules', dep), join(PKG_ROOT, '..', '..', 'node_modules', dep)].find((p) =>
      existsSync(join(p, 'package.json')),
    ) ?? null
  if (!src) {
    line(`    ⚠️ ${dep} 没找到（不进包）：用得到它的技能会自己报「代理不可用」。`)
    line(`       需要的话：本目录执行 npm install ${dep}，然后重跑 setup.mjs`)
    continue
  }
  copyDir(src, dest, `${dep}（技能用，可选）`)
}

// ── 4. DSH 本体：**刻意不复制** ──────────────────────────────────────────
// 用户已明确："不用复制 DSH"。这不是偷懒，是有理由的取舍：
//   · 体积：DSH 安装根约 275 MB / 15000 个文件，复制会让包从 86 MB 涨到 360 MB
//   · 本质：DSH 是**运行时**，和 Node 一样属于"跑这个包所需的环境"，
//           而不是这个包自己的内容；把它当运行环境、用环境变量指定更干净
//   · 可搬迁性不受影响：路径解析按候选顺序查找（见 src/local.mjs 的
//           findDshCli），换机器时只要目标机器装了 DSH，或设一个
//           DSH_DESKTOP_APP 环境变量即可
// 所以这里不提供 --with-dsh。

line('')
line('ℹ️  DSH 本体不复制（这是既定设计）。桥接会自动在这些位置找它：')
line('      1. vendor/dsh/                          （你若手工放了一份就用它）')
line('      2. 环境变量 DSH_DESKTOP_APP 指向的安装根')
line('      3. DSH 桌面版默认安装位置')
line(`    当前解析结果：${findDshCli() ?? '（没找到，请检查 DSH 是否已安装）'}`)

// ── 5. SnowLuma（可选，**且发布包不要用它**）─────────────────────────────
//
// ★ 许可证提醒：SnowLuma 的 EULA §5.4 禁止"将其并入第三方安装包"，
//   LICENSE §5 不授予原生组件的再分发权利、§3(d) 要求公开发布衍生版须事先书面许可。
//   所以**发布 zip 里不要带它**，让用户自己去官方 Release 下载。
//   这个开关只用于"本机摆成一体"。
if (WITH_SNOWLUMA) {
  const snowSrc = findSnowlumaSource()
  if (!snowSrc) {
    line('❌ SnowLuma：找不到源目录。用 --snowluma-source <目录> 或环境变量 SNOWLUMA_SOURCE 指定，')
    line('   或者干脆不放（推荐：发布包里本来就不该带它）。')
    ok = false
  } else {
    // ⚠️ 目标必须是 `vendor/snowluma/index.mjs` 那一层 —— findSnowluma() 就是按
    //    `vendor/snowluma/index.mjs` 找的。以前这里多套了一层（vendor/snowluma/snowluma），
    //    结果"复制了但发现不了"。
    ok = copyDir(snowSrc, DIRS.vendorSnowluma, 'QQ 协议端 SnowLuma（仅本机自用）') && ok
  }
}

// ── 6. 写一份清单，方便日后再体检 ────────────────────────────────────────
//
// ★ 这里**只记"是什么"和"来源"，不记绝对路径**。
//   以前 manifest.json 里存的是 `D:\...\vendor\node\node.exe` 这类绝对路径，
//   包一搬走它就是错的，还会误导排查（"清单说在 D 盘，可我在 C 盘"）。
//   相对包根的路径才是可搬迁的表述。
const manifest = {
  preparedAt: new Date().toISOString(),
  nodeVersion: process.version,
  node: join('vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
  wsVersion: readPackageVersion(join(DIRS.vendorNodeModules, 'ws')),
  // DSH 本体是**运行环境**、不随包分发，所以这里只记"本机解析到哪、来源是什么"，
  // 供下次 --check 对照，不作为分发内容。
  dsh: (() => {
    const probed = findDshCliWithSource()
    return probed ? { resolvable: true, source: probed.source } : { resolvable: false, source: null }
  })(),
  dshHome: resolveDshHome({ cliPath: findDshCli() })?.source ?? null,
  snowlumaVendored: existsSync(join(DIRS.vendorSnowluma, 'index.mjs')),
}
writeFileSync(join(DIRS.vendor, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

/**
 * 磁盘上的原始配置（**不做归一化** —— 体检要看的就是"文件里到底写了什么"）。
 * 读不到就当作空对象，让体检如实报告"读不到配置"。
 */
let rawConfig = {}
try {
  rawConfig = JSON.parse(readFileSync(join(PKG_ROOT, 'config.json'), 'utf8'))
} catch (error) {
  rawConfig = {}
  line(`⚠️ 读不到 config.json（${error.message}）—— 发布前体检的结果会不完整。`)
}

/**
 * 发布前体检：只**报告**，不修改任何文件。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────────
 * 这个包最容易出的事故不是"跑不起来"，而是**把不该带出去的东西带出去了**：
 * 明文密钥、开发机的绝对路径、别人的聊天记录。这些都**不会**让程序报错，
 * 所以只能靠一次显式的检查拦住。
 *
 * 为什么不自动清理：清空密钥/删运行痕迹是**有副作用**的动作，
 * 藏在"准备依赖"的脚本里偷偷做，会在开发机上把正在用的配置洗掉。
 * 所以这里只列清单，改不改由人决定。
 *
 * @returns {number} 问题条数
 */
async function auditForRelease() {
  const problems = []
  const warns = []
  const rel = (p) => p.replace(PKG_ROOT + '\\', '').replace(PKG_ROOT + '/', '')

  // ① 明文密钥（最严重）
  const RAW_SECRETS = [
    ['onebot.wsToken', 'SnowLuma WebSocket token'],
    ['onebot.httpToken', 'SnowLuma HTTP token'],
    ['dsh.apiKey', '模型 API key'],
  ]
  for (const [key, label] of RAW_SECRETS) {
    const [head, tail] = key.split('.')
    const value = rawConfig?.[head]?.[tail]
    if (typeof value === 'string' && value.trim() !== '') {
      problems.push(`config.json 里 ${key}（${label}）仍有明文 —— 发布前必须清空`)
    }
  }

  // ② 个人 QQ 号
  const personal = [
    ...(rawConfig?.access?.adminUsers ?? []),
    ...(rawConfig?.access?.dmAllowlist ?? []),
    ...(rawConfig?.access?.groupAllowlist ?? []),
  ].filter(Boolean)
  if (personal.length) {
    warns.push(`config.json 里的名单含具体号码（${personal.length} 个）—— 换成空数组或占位值`)
  }

  // ③ 开发机专属配置：这些路径对别人无意义，还会误导
  if (rawConfig?.dsh?.cliPath) warns.push('config.json 的 dsh.cliPath 非空（开发机路径）—— 发布前清空')
  const dshPaths = rawConfig?.dsh?.searchPaths ?? []
  if (Array.isArray(dshPaths) && dshPaths.length) {
    warns.push(`config.json 的 dsh.searchPaths 有 ${dshPaths.length} 条（开发机路径）—— 发布前清空`)
  }
  if (rawConfig?.snowluma?.installDir) {
    warns.push('config.json 的 snowluma.installDir 非空 —— 发布包应留空，让用户自己指')
  }

  // ④ 不该进包的东西
  for (const [label, p] of [
    ['DSH 本体（275MB，属运行环境）', join(DIRS.vendorDsh, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')],
    ['SnowLuma（许可证不允许随包分发）', join(DIRS.vendorSnowluma, 'index.mjs')],
  ]) {
    if (existsSync(p)) problems.push(`vendor/ 里存在 ${label} —— 打包前删掉`)
  }
  for (const [label, p] of [
    ['运行日志', DIRS.logs],
    ['agent 工作区（含聊天痕迹）', DIRS.defaultWorkspace],
    ['MCP 缓存（含 httpToken 明文）', join(PKG_ROOT, 'cache')],
    ['配置文件备份（含旧密钥）', null],
  ]) {
    if (label.startsWith('配置文件备份')) {
      const baks = readdirSync(PKG_ROOT).filter((f) => f.startsWith('config.json.bak'))
      if (baks.length) warns.push(`存在 ${baks.length} 个 config.json.bak* —— 发布前删掉：${baks.join(', ')}`)
      continue
    }
    if (existsSync(p)) warns.push(`${label} 还在：${rel(p)} —— 发布前删掉或清空`)
  }
  for (const [label, p] of [
    ['旧架构目录（已废弃）', join(PKG_ROOT, '..', 'dsh-qq-bot（废弃）')],
    ['前端源码依赖（202MB，不进包）', join(PKG_ROOT, 'config-ui', 'node_modules')],
  ]) {
    if (existsSync(p)) warns.push(`${label} 仍在磁盘上：${rel(resolve(p))}（打包时排除即可）`)
  }

  // ⑤ 必需件在不在
  if (!existsSync(join(DIRS.vendorNode, 'node.exe'))) problems.push('vendor/node/node.exe 缺失 —— 跑一次无参数的 setup.mjs')
  if (!existsSync(join(DIRS.vendorNodeModules, 'ws', 'index.js'))) problems.push('vendor/node_modules/ws 缺失 —— 跑一次无参数的 setup.mjs')
  if (!existsSync(join(PKG_ROOT, 'config-ui', 'dist', 'index.html'))) {
    problems.push('config-ui/dist 缺失 —— 界面改动必须在 config-ui 里跑 npm run build')
  }

  // ⑤-b ★ 界面产物**是不是当前源码构建的**（构建溯源）
  //
  // 为什么这一条是发布验收的一部分：界面分两条路出货 —— 开发路径
  // `config-ui/dist`（已入库）与发布路径 `_release/<包>/config-ui/dist`
  // （§5 用 robocopy 拷）。而"包里那份是不是当前源码构建的"以前**没有任何
  // 东西能判断**：上面那条只验 `index.html` 在不在，存在即通过。
  // 实测脱钩过一次 —— 包里源码与 UI 都比工作区旧约 5 小时，1100 项测试全绿。
  //
  // ⚠️ `stale`（源码改了没构建）与 `unstamped`（无法自证来源）**必须分开报**：
  //    前者的修法是重新构建，后者重新构建也没用。混成一句"不同步"会让人
  //    往错的方向修。
  {
    const { checkUiFreshness } = await import('./src/ui-status.mjs')
    const ui = checkUiFreshness({ distDir: join(PKG_ROOT, 'config-ui', 'dist') })
    if (ui.status === 'stale') {
      problems.push(
        `config-ui/dist **落后于**当前源码 —— ${ui.why}。${ui.advice}`,
      )
    } else if (ui.status === 'unstamped') {
      problems.push(
        `config-ui/dist **无法自证来源**（缺 ui-build.json）—— ${ui.why}。${ui.advice}`,
      )
    } else if (ui.status === 'missing') {
      // 上面已经报过一次，这里不重复
    } else {
      // 同步是**好消息**，但也值得留一行：发布记录里能对上是哪次构建
      line('')
      line(`  ✅ 界面产物与源码同步（构建于 ${ui.stamp?.builtAt ?? '?'}）`)
      line('')
    }
  }

  // ⑥ 模板与真实配置的关系（git 不跟踪 config.json，所以模板必须自带、且必须干净）
  const examplePath = join(PKG_ROOT, 'config.example.json')
  if (!existsSync(examplePath)) {
    problems.push('config.example.json 缺失 —— 它是仓库里唯一的配置模板（config.json 被 gitignore 了）')
  } else {
    try {
      const example = JSON.parse(readFileSync(examplePath, 'utf8'))
      const leaks = [
        ['dsh.apiKey', example?.dsh?.apiKey],
        ['onebot.wsToken', example?.onebot?.wsToken],
        ['onebot.httpToken', example?.onebot?.httpToken],
        ['snowluma.installDir', example?.snowluma?.installDir],
      ].filter(([, v]) => typeof v === 'string' && v.trim() !== '')
      for (const [k] of leaks) problems.push(`config.example.json 里 ${k} 非空 —— 模板必须是干净的`)
      const ids = [
        ...(example?.access?.adminUsers ?? []),
        ...(example?.access?.dmAllowlist ?? []),
        ...(example?.access?.groupAllowlist ?? []),
      ].filter(Boolean)
      if (ids.length) problems.push(`config.example.json 里的名单含 ${ids.length} 个具体号码 —— 模板必须为空`)
      if ((example?.dsh?.searchPaths ?? []).length) {
        problems.push('config.example.json 的 dsh.searchPaths 非空 —— 模板不能带开发机路径')
      }
    } catch (error) {
      problems.push(`config.example.json 读不了或不是合法 JSON：${error.message}`)
    }
  }

  // ── 输出 ──
  if (JSON_OUT || JSON_OUT_FILE) {
    // 机器可读：`problems` / `warns` 原样给全，让调用方自己决定"哪类算阻断" ——
    // 判据不塞在这里，因为不同调用方口径不同：
    //   · 组装发布包：真 config.json 的明文**不算**阻断（组装根本不拷它）
    //   · 人执行：那当然要清（所以它是 ❌）
    //
    // ★ 为什么支持**写文件**（`--json-out <路径>`）而不是只打 stdout：
    //   受限沙箱禁止"通过管道截获另一个程序的输出"（EPERM），
    //   调用方（assemble-release.mjs）**拿不到**子进程的 stdout ——
    //   实测 `execFileSync` 与 `spawnSync` + pipe 都直接 EPERM，
    //   而报错里既没有退出码也没有输出，看起来毫无头绪。
    //   写文件走的是普通文件 I/O，不碰管道，在同样环境里是好的。
    const payload = { ok: problems.length === 0, problems, warns }
    if (JSON_OUT_FILE) {
      writeFileSync(JSON_OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    }
    if (JSON_OUT) line(JSON.stringify(payload))
    return problems.length
  }

  line('── 发布前体检（只报告，不改文件）──')
  if (!problems.length && !warns.length) {
    line('  ✅ 没发现问题。')
  }
  for (const p of problems) line(`  ❌ ${p}`)
  for (const w of warns) line(`  ⚠️  ${w}`)
  line('')
  line('  发布包应包含：start.bat / config.json（由 config.example.json 复制并已清空密钥）/ src / mcp /')
  line('               config-ui/dist / vendor/node / vendor/node_modules/ws / prices.json')
  line('  发布包应排除：vendor/dsh、vendor/snowluma、config-ui/{src,node_modules}、')
  line('               logs、cache、workspace-qq、config.json.bak*、.tmp-*')
  line('  ★ git 不跟踪 config.json（含明文密钥）—— 首次使用：copy config.example.json config.json')
  line('  ★ 另需确认：config.json 是**无 BOM 的 UTF-8**（有 BOM 会导致配置解析失败）。')
  line('')
  return problems.length
}

line('')
line('── 结果 ──')
if (JSON_OUT && RELEASE) {
  // --json + --release：stdout 必须是**纯 JSON**（调用方要 JSON.parse 它），
  // 所以这一段人看的版面不能打。这里只在 stderr 留一句，不污染 stdout。
  console.error(
    `[setup] 依赖就位=${ok ? '是' : '否'}（--json 模式，人看的报告已省略）`,
  )
} else {
  for (const row of describeLayout()) {
    line(`  ${row.present ? '✅' : '⬜'} ${row.label}`)
  }
  line('')
  line(ok ? '🎉 必需依赖已就位。下一步：node src/index.mjs --check' : '⚠️ 有必需项没准备好，见上面的提示。')
  line('')
}

// --release：必备项就位后再跑一次"发布前体检"（退出码反映的是体检结果）
if (RELEASE) {
  const bad = await auditForRelease()
  process.exit(bad === 0 && ok ? 0 : 1)
}
process.exit(ok ? 0 : 1)
