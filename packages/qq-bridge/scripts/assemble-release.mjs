/**
 * 组装发布包（zip 前的 staging 目录）。**幂等、可复查、不许静默**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有脚本，而不是照 RELEASE.md §5 手敲 robocopy
 * ══════════════════════════════════════════════════════════════════════════
 * 上一次组装就是手敲的，结果是 `启动机器人.bat` / `检查配置.bat` / `体检.bat` /
 * `先读我-首次使用.txt` **只存在于发布包里、仓库里没有源**：
 * 文档的"最终形状"列了它们，而 §5 的拷贝清单里一条都没有 —— 说明当时是
 * 手工补进去的，然后**没人记得**。手敲清单必然漏项，而漏项不会报错。
 * （★ 0.2.5：那几个中文名入口连同 `创建带图标的快捷方式.bat` **已按用户要求删除**，
 *   不再属于本清单。这段历史照旧留着，因为它解释的正是"为什么清单必须机器核对"。）
 *
 * 所以这个脚本做四件事，顺序不能换：
 *   ① **先校验**（`setup.mjs --release`）：密钥/路径没清干净就**不组装**；
 *   ② **不许覆盖已有版本目录**（老版本要留着对照，见 §5 的说明）；
 *   ③ 从 `config.example.json` 复制出空白 `config.json`（**不是**拷你的真配置）；
 *   ④ 组装完跑一次验收脚本（`scripts/check-release-package.mjs`）。
 *
 * 版本号**只从 `package.json` 读**（单一来源）—— 脚本里再写一遍就会分叉。
 *
 * 用法：
 *   node scripts/assemble-release.mjs                     # 组装到 ../../_release/InteractBot-<版本>-win-x64
 *   node scripts/assemble-release.mjs --out <目录>         # 指定输出目录
 *   node scripts/assemble-release.mjs --dry-run           # 只报告要做什么，不写盘
 *   node scripts/assemble-release.mjs --zip               # 组装后压缩（已存在同名 zip 则拒绝）
 *   node scripts/assemble-release.mjs --force             # 允许覆盖已存在的输出目录（默认拒绝）
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { auditReleaseInputs, classifyDeleteTarget, renderProtectedList } from '../src/protected-files.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

const DRY = flag('--dry-run')
const FORCE = flag('--force')
const WANT_ZIP = flag('--zip')

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
const DEFAULT_OUT = join(REPO_ROOT, '_release', `InteractBot-${VERSION}-win-x64`)
const OUT = resolve(value('--out') ?? DEFAULT_OUT)

// ── 桌面壳（0.2.5）：先读"最近一次成功构建"在哪 ────────────────────────────
//
// ★ 读 `latest.json` 而**不猜目录名**：构建产物目录带时间戳（`pack-<时间戳>`），
//   而"上一次到底是哪一个"只有构建脚本自己知道（它写这份文件就是为这件事）。
//   0.2.4 那批 `pack-*` 里有 10 个是空壳、只有 1 个能用 —— 猜名字必然猜错。
const DESKTOP_LATEST = join(PKG_ROOT, '.build-desktop', 'latest.json')
let DESKTOP_UNPACKED = null
let DESKTOP_META = null
{
  if (existsSync(DESKTOP_LATEST)) {
    try {
      DESKTOP_META = JSON.parse(readFileSync(DESKTOP_LATEST, 'utf8'))
      const dir = resolve(PKG_ROOT, DESKTOP_META?.unpacked ?? '')
      if (existsSync(join(dir, 'InteractBot.exe'))) DESKTOP_UNPACKED = dir
    } catch {
      /* 读不出来按"没有产物"处理，错误信息在 ④-b 统一说 */
    }
  }
}

/** 要整目录拷贝的（相对包根）。 */
// ★ `personas` 必须在清单里（0.2.2）：它是**出厂默认那两套人设**的文件。
//   漏了它的后果是「发布包里一套人设都没有」—— 界面人设栏空着，而且**不会报错**
//   （启动时的 `ensureDefaultPersonas` 只在人员没动过手时补默认，用户自己建过就什么都不补）。
const COPY_DIRS = ['src', 'mcp', 'assets', 'skills', 'personas', join('config-ui', 'dist'), join('vendor', 'node'), join('vendor', 'node_modules', 'ws')]
/**
 * 要单文件拷贝的（相对包根）。★ **每一项都必须真的存在于包根** —— 第③步逐项清点，缺一个都不组装。
 *
 * ★ 0.2.5：发布包**只剩一个双击入口** `start.bat`。原先那五个中文名文件
 *   （`启动机器人.bat` / `检查配置.bat` / `体检.bat` / `创建带图标的快捷方式.bat` /
 *   `先读我-首次使用.txt`）已按用户要求删除，**不要加回来**。
 *   同一批从清单里去掉的还有 `QQ机器人.lnk`：它在 0.2.2 就改名叫 `QQbot.lnk` 了，而这一行
 *   一直没跟着改 —— 于是"清点源文件"这一步**早就**卡在「包根缺少这些必需件：QQ机器人.lnk」，
 *   0.2.5 顺手把它修掉。`.lnk` 本身也不再进包：它是**生成物**、里面存的是绝对路径
 *   （理由写在 PROJECT.json 的 `files["assets/icon.ico"]` 与 `entrypoints.launch`）。
 */
const COPY_FILES = [
  'package.json',
  'start.bat',
  'setup.mjs',
  // ★★ 0.2.5：这一个文件看着像"构建脚本"，其实是**运行期依赖** ——
  //   `src/ui-status.mjs` 要在运行期 require 它（校验侧与构建侧共用同一份哈希实现）。
  //   以前它不在清单里 ⇒ 包里的桥接**一启动就死**（MODULE_NOT_FOUND），
  //   而且 `respawnBridge` 是 stdio:'ignore'，连 bridge.log 都不留。
  //   实测：`_release/InteractBot-0.2.0` 起每一份包都有这个缺陷。
  //   ⚠️ 将来往 `scripts/` 里加"运行期要用的东西"时，请一并加到这里；
  //   `scripts/check-release-package.mjs` ①-e 会扫 `join(PKG_ROOT, …)` 指到的文件兜底。
  'scripts/ui-build-stamp.cjs',
  'prices.json',
  'config.example.json',
  'AGENT.md',
  'PROJECT.json',
  'README.md',
  'RELEASE.md',
]

let failures = 0
const log = (m) => console.log(m)
const bad = (m) => {
  failures += 1
  console.log(`❌ ${m}`)
}

log('')
log(`组装发布包  InteractBot-${VERSION}-win-x64`)
log(`  源  ：${PKG_ROOT}`)
log(`  目标：${OUT}`)
if (DRY) log('  ⚠️ --dry-run：只报告，不写盘')
log('')

// ⚠️ 子进程输出**不能用管道捕获**：受限沙箱禁止"通过管道截获另一个程序的输出"
//    （EPERM），实测 `execFileSync` 与 `spawnSync` + `['ignore','pipe','pipe']`
//    **都**直接失败，而报错里既没有退出码也没有输出，看起来毫无头绪。
//    所以约定：让子进程把结构化结果**写到文件**（`--json-out <路径>`），
//    父进程读那个文件。走的是普通文件 I/O，不碰管道。
//    子进程的**人类可读输出**用 `inherit` 直通，所以你会照样看到它打的清单。
//
// ★ 判据一律是**退出码 + 结构化字段**，**绝不解析它的排版文本**。
//   踩过一次：第一版判"验收通过"靠挑输出里有没有 ✅，而验收脚本成功时根本不打 ✅
//   → 每次都报"没通过"，而问题列表是空的。假失败会让人去改验收脚本。
const AUDIT_JSON = join(PKG_ROOT, 'cache', 'release-audit.json')
mkdirSync(dirname(AUDIT_JSON), { recursive: true })
rmSync(AUDIT_JSON, { force: true }) // 先清掉旧的：读不到"新写的"就等于读到了旧结论
log('── ① 发布前体检（setup.mjs --release）──')
spawnSync(process.execPath, [join(PKG_ROOT, 'setup.mjs'), '--release', '--json-out', AUDIT_JSON], {
  cwd: PKG_ROOT,
  stdio: 'inherit',
})
let auditData = null
try {
  auditData = JSON.parse(readFileSync(AUDIT_JSON, 'utf8'))
} catch (error) {
  bad(
    `读不出体检结果（${AUDIT_JSON}）—— **不组装**。\n` +
      `   原因：${error?.message ?? error}\n` +
      '   （这个文件由 `setup.mjs --release --json-out` 生成；写不出来说明 setup.mjs 那步就失败了）',
  )
  process.exit(1)
}
for (const p of auditData.problems ?? []) log(`   ❌ ${p}`)
for (const w of auditData.warns ?? []) log(`   ⚠️  ${w}`)

// 哪类 ❌ 算阻断：**真 config.json 里的明文密钥/路径不算** ——
// 组装根本不拷它（包里那份是 config.example.json 的副本，且下面会自校验）。
// 把"使用者本机的配置"当成发不出去的理由，等于让脚本去改他的工作配置。
const blocking = (auditData.problems ?? []).filter((p) => !/config\.json 里 .*仍有明文/.test(p))
if (blocking.length) {
  log('')
  bad(`发布前体检有 ${blocking.length} 项硬问题 —— **不组装**（见上面的 ❌）`)
  process.exit(1)
}
const excused = (auditData.problems ?? []).length - blocking.length
if (excused > 0) {
  log(`   · 其中 ${excused} 项是**你本机那份 config.json** 的明文密钥/路径，组装不拷它，不算阻断。`)
}
log('   ✅ 模板与产物检查通过（真配置的明文与本次组装无关）')


// ── ② 不许覆盖已有版本目录（老版本要留着对照）──────────────────────────
log('')
log('── ② 输出目录检查（老版本必须留着）──')
if (existsSync(OUT)) {
  if (!FORCE) {
    bad(
      `输出目录已存在：${OUT}\n` +
        '   默认**拒绝覆盖** —— 老版本要留着对照（用户要求）。\n' +
        '   要改版本号就改 package.json 的 version（脚本从那里读，不自己写死）；\n' +
        '   确实要覆盖这一份才用 --force。',
    )
    process.exit(1)
  }
  log('   ⚠️ --force：将覆盖已存在的目录')
} else {
  log('   ✅ 目标目录不存在，可以新建')
}
const existing = existsSync(join(REPO_ROOT, '_release'))
  ? readdirSync(join(REPO_ROOT, '_release')).filter((n) => n.startsWith('InteractBot-'))
  : []
if (existing.length) log(`   （_release 里已有：${existing.join('、')}）`)

// ── ②-b ★★ 受保护路径门禁（H16）：用户数据绝不能被打进包 ─────────────────
//
// 为什么要有这道门：`COPY_DIRS` / `COPY_FILES` 是**手写清单**，往里面多写一行
// （比如顺手加上 `workspace-qq` 或 `logs`）就会把某个真实使用者的**聊天记忆、
// 日志、token**打进发布包 —— 而且**不会有任何报错**（zip 里多两个目录而已）。
// 清单本身也可能被别人改，所以这里做成**可执行的门禁**，而不是文档里的一句叮嘱。
log('')
log('── ②-b 受保护路径门禁（用户数据不许入包）──')
{
  const audit = auditReleaseInputs({ dirs: COPY_DIRS, files: COPY_FILES })
  if (!audit.ok) {
    bad(
      '要拷进包的东西里**含受保护的用户数据**：\n' +
        audit.problems.map((p) => `   · ${p.rel} —— ${p.why}`).join('\n') +
        '\n   请把它们从 COPY_DIRS / COPY_FILES 里去掉。**这一条没有 --force 可绕过**。',
    )
    process.exit(1)
  }
  log(`   ✅ ${COPY_DIRS.length + COPY_FILES.length} 项拷贝输入都不在受保护清单里`)

  // 目标目录删除前的检查：只允许删"我们自己的产物"
  const target = classifyDeleteTarget({
    dir: OUT,
    markerFiles: [join(OUT, 'config.example.json'), join(OUT, 'package.json')],
    exists: (p) => existsSync(p ?? OUT),
    hasFiles: existsSync(OUT) && readdirSync(OUT).length > 0,
  })
  if (existsSync(OUT) && !target.ok) {
    bad(`拒绝删除既有目录：${OUT}\n   ${target.why}\n   （确认它是我们的产物再手动处理，脚本不替你删）`)
    process.exit(1)
  }
}

// ── ③ 逐项校验要拷的东西都在 ──────────────────────────────────────────────
log('')
log('── ③ 源文件清点（缺一个都不组装）──')
const missing = []
for (const d of COPY_DIRS) {
  if (!existsSync(join(PKG_ROOT, d))) missing.push(`${d}/`)
}
for (const f of COPY_FILES) {
  if (!existsSync(join(PKG_ROOT, f))) missing.push(f)
}
if (missing.length) {
  bad(`包根缺少这些必需件：${missing.join('、')}`)
  process.exit(1)
}
log(`   ✅ ${COPY_DIRS.length} 个目录 + ${COPY_FILES.length} 个文件都在`)

if (DRY) {
  log('')
  log('--dry-run 结束：上面就是全部动作，未写盘。')
  process.exit(0)
}

// ── ④ 组装 ───────────────────────────────────────────────────────────────
log('')
log('── ④ 组装 ──')
if (existsSync(OUT)) {
  // ★ `--force` 时必须**先删干净再建**，不能直接往已有目录上拷。
  //   实测：`cpSync(srcDir, existingDir, {recursive:true})` 在这种"目录已存在
  //   且里面有同名目录"的情形下会抛 EIO（errno 5）—— 报错指向 `cp` 那个 syscall，
  //   完全看不出是"目标目录没清"造成的。删了重建最省事也最可预期。
  rmSync(OUT, { recursive: true, force: true })
  log('   （--force：已清掉旧的输出目录再重建）')
}
mkdirSync(OUT, { recursive: true })
for (const d of COPY_DIRS) {
  const from = join(PKG_ROOT, d)
  const to = join(OUT, d)
  mkdirSync(dirname(to), { recursive: true })
  // ★ `skills/node_modules` 是桥接在启动时建的**软链**（指向 vendor/node_modules，见
  //   src/extensions.mjs 的 ensureSkillNodeModules）。它**绝不能进发布包**：
  //   链的目标是开发机的绝对路径，换台机器就是死链，而且会让"发布包里夹带 node_modules"
  //   这条本来就该守住的规则失效。用户拿到包后第一次启动，桥接会自己重建它。
  const filter =
    d === 'skills' ? (src) => !/[\\/]node_modules([\\/]|$)/.test(src.slice(from.length)) : undefined
  cpSync(from, to, { recursive: true, force: true, ...(filter ? { filter } : {}) })
  log(`   📁 ${d}`)
}
for (const f of COPY_FILES) {
  cpSync(join(PKG_ROOT, f), join(OUT, f), { force: true })
  log(`   📄 ${f}`)
}

// ── ④-b 桌面壳（0.2.5）：整目录搬进包根的 `app/` ─────────────────────────
//
// ★ 为什么进 `app/` 子目录、而不把 exe 与 Chromium 那几十个 dll 平铺在包根：
//   ① 包根是"使用者要一眼认出该点哪个"的地方，铺二十个 dll 会把入口淹掉；
//   ② `version` / `LICENSES.chromium.html` 这类通用名不再与我们的文件抢位；
//   ③ 想删掉桌面壳时，删一个目录就干净了。
//
// ★★ exe 仍然找得到包根：它按**包根标记**往上找（`desktop/lib.cjs` 的 `resolvePkgRoot`）——
//    `<包根>/app/resources/app` → `…/app/resources` → `…/app`（没有 config.example.json）
//    → `<包根>`（有）⇒ 命中。这一段是**实测过**的（`mocks/verify-desktop.mjs` 有专门一节
//    造出这个真实布局来断言），不是"应该能找到"。
//
// ★ 本版**没有** .bat 启动器：入口就是双击 `app\InteractBot.exe`。
//   （0.2.4 靠一个中文名 .bat 去设 `INTERACTBOT_PKG_ROOT`，而那几个中文名入口已被用户
//     要求删除 ⇒ "没有启动器也能定位包根"必须自己成立，上面那条就是它的判据。）
if (!DESKTOP_UNPACKED) {
  bad(
    '没有找到桌面壳构建产物（读 `.build-desktop/latest.json`）—— 本版**必须有** InteractBot.exe。\n' +
      '   先打一次：\n' +
      '     npm run desktop:fetch              # 首次：取 Electron 运行时\n' +
      '     npm run desktop:pack               # 打 exe\n' +
      '   （0.2.5 的目标里有两个就落在桌面壳上：没有它，"独立界面"与"打包为 .exe"都不成立）',
  )
} else {
  log('')
  log('── ④-b 桌面壳（InteractBot.exe）──')
  const appDir = join(OUT, 'app')
  mkdirSync(appDir, { recursive: true })
  cpSync(DESKTOP_UNPACKED, appDir, { recursive: true, force: true })
  const exe = join(appDir, 'InteractBot.exe')
  if (!existsSync(exe)) {
    bad('拷完以后 app/InteractBot.exe 不存在 —— 桌面壳没进包')
  } else {
    // ★★ 自校验：包里的壳代码必须与 `desktop/` 那份源码**逐字节相同**。
    //   为什么值得一条硬检查：0.2.4 的教训是"包里那份是不是当前源码构建的"这件事
    //   **没有任何东西能判断**（UI 那次脱钩：包里 UI 与源码都旧约 5 小时，1100 项测试全绿）。
    //   壳这边同理 —— 改了 main.cjs 却忘了重新打包，行为与源码说的不一致，而且**不报错**。
    const APP_FILES = ['main.cjs', 'preload.cjs', 'lib.cjs', 'splash.html', join('assets', 'app-icon.ico')]
    const stale = []
    for (const rel of APP_FILES) {
      const src = join(PKG_ROOT, 'desktop', rel)
      const inPkg = join(appDir, 'resources', 'app', rel)
      if (!existsSync(inPkg)) stale.push(`${rel}（包里没有）`)
      else if (Buffer.compare(readFileSync(src), readFileSync(inPkg)) !== 0) stale.push(rel)
    }
    if (stale.length) {
      bad(
        `包里的壳代码与 desktop/ 源码不一致：${stale.join('、')}\n` +
          '   说明这份 exe 是**旧代码**打的 —— 重新打一次：npm run desktop:pack',
      )
    } else {
      let n = 0
      let bytes = 0
      const walkApp = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name)
          if (e.isDirectory()) walkApp(full)
          else if (e.isFile()) {
            n += 1
            bytes += statSync(full).size
          }
        }
      }
      walkApp(appDir)
      log(`   📁 app/（${n} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB）`)
      log(`   📄 app/InteractBot.exe（${(statSync(exe).size / 1024 / 1024).toFixed(1)} MB）`)
      log(`   ✅ 包里的壳代码与 desktop/ 逐字节一致（${APP_FILES.length} 个文件）`)
    }
    // ★ 溯源：这份 exe 是哪份源码、哪个 Electron、什么时候打的（与 config-ui 的
    //   ui-build.json 同一个理由 —— 发布包里的东西必须能自证来源）
    const appMain = join(appDir, 'resources', 'app', 'main.cjs')
    writeFileSync(
      join(appDir, 'PROVENANCE.txt'),
      [
        `InteractBot 桌面壳（独立窗口 + 启动器）  版本 ${VERSION}`,
        '',
        `打包时间   ：${DESKTOP_META?.builtAt ?? '?'}`,
        `Electron   ：${DESKTOP_META?.electronVersion ?? '?'}`,
        '源文件     ：packages/qq-bridge/desktop/{main,preload,lib}.cjs + splash.html + assets/app-icon.ico',
        `主进程哈希 ：${existsSync(appMain) ? createHash('sha256').update(readFileSync(appMain)).digest('hex').slice(0, 16) : '（读不到）'}`,
        '',
        '怎么启动：双击 app\\InteractBot.exe —— 它自己找到包根、把桥接拉起来、开出控制台窗口。',
        '（本版没有 .bat 启动器。start.bat 仍在，走的是浏览器那条路；它在发现',
        ' app\\InteractBot.exe 时不再开浏览器，避免同一台机器出现两个控制台。）',
        '',
        '窗口关掉只会收到右下角托盘，机器人**继续在线**；要它下线请用托盘菜单的「退出并停止机器人」。',
        '',
        '这份文件由 scripts/assemble-release.mjs 生成，用来回答"这个 exe 是哪来的"。',
        '',
      ].join('\n'),
      'utf8',
    )
    log('   📄 app/PROVENANCE.txt（这份 exe 的来源）')
  }
}

// ★ 空白 config.json：从**模板**复制，绝不拷你的真配置
cpSync(join(OUT, 'config.example.json'), join(OUT, 'config.json'), { force: true })
log('   📄 config.json（由 config.example.json 复制 —— 空白模板，不是你的真配置）')

// 自校验：拷进去的 config.json 必须**确实是干净的**
{
  const cfg = JSON.parse(readFileSync(join(OUT, 'config.json'), 'utf8'))
  const leaks = [
    ['onebot.wsToken', cfg.onebot?.wsToken],
    ['onebot.httpToken', cfg.onebot?.httpToken],
    ['dsh.apiKey', cfg.dsh?.apiKey],
    ['snowluma.installDir', cfg.snowluma?.installDir],
  ].filter(([, v]) => typeof v === 'string' && v.trim() !== '')
  const ids = [
    ...(cfg.access?.adminUsers ?? []),
    ...(cfg.access?.dmAllowlist ?? []),
    ...(cfg.access?.groupAllowlist ?? []),
  ]
  const paths = cfg.dsh?.searchPaths ?? []
  // ⚠️ 这三类各自都会导致"把开发机的秘密发出去了"，所以逐类报，不合成一句
  if (leaks.length) bad(`包里的 config.json 仍有明文：${leaks.map(([k]) => k).join('、')}`)
  if (ids.length) bad(`包里的 config.json 名单非空（含 ${ids.length} 个具体号码）`)
  if (paths.length) bad(`包里的 config.json 有开发机路径（dsh.searchPaths ${paths.length} 条）`)
  if (!leaks.length && !ids.length && !paths.length) log('   ✅ 包里的 config.json 已确认是空白模板')
}

// ── ④-c 清掉"本机试跑过这个包"留下的运行痕迹 ─────────────────────────────
//
// 为什么要有这一步：组装完**在这个目录里双击过 exe / 跑过 start.bat** 是正常的验收动作，
// 而那一刻桥接就会在**包内**建出 `logs/`（壳自己的 `logs/desktop.log` 也在这里）、`cache/`、
// `workspace-qq/`。它们含使用者的路径与聊天痕迹，**绝不能发出去** —— 验收脚本（⑤）本来就会
// 把它们判成"不该包含的东西"，但那时人容易去猜"是不是脚本误报"。所以在验收**之前**先清掉，
// 并把"清卫生"这件事说出来。
//
// ⚠️ 尽力而为、删不掉**不算失败**：Windows 上文件可能被占（0.2.4 在这里栽过两次）。留着的
//    痕迹会由 ⑤ 的验收如实报出来 —— 那比"脚本自己偷偷失败"好。
{
  const junk = ['logs', 'cache', 'workspace-qq']
  const cleaned = []
  const stuck = []
  for (const rel of junk) {
    const p = join(OUT, rel)
    if (!existsSync(p)) continue
    try {
      rmSync(p, { recursive: true, force: true })
      cleaned.push(rel)
    } catch {
      stuck.push(rel)
    }
  }
  if (cleaned.length) log(`   · 清掉了本机试跑留下的运行痕迹：${cleaned.join('、')}`)
  if (stuck.length) log(`   ⚠️ 有运行痕迹删不掉（多半被占）：${stuck.join('、')} —— 验收会报出来，别把它发出去`)
}

// ── ⑤ 验收 ───────────────────────────────────────────────────────────────
log('')
log('── ⑤ 发布包验收（scripts/check-release-package.mjs）──')
let sizeMb = 0
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.isFile()) out.push(full)
  }
  return out
}
const files = walk(OUT)
for (const f of files) sizeMb += statSync(f).size
sizeMb = sizeMb / 1024 / 1024
log(`   文件数 ${files.length}，合计约 ${sizeMb.toFixed(1)} MB`)

// ⚠️ 判"通过"要看**退出码**，不要挑它的输出文案。
//    第一版写成"输出里没有 ✅ 就算失败"，而验收脚本成功时**根本不打 ✅**
//    （它只在有问题时才打 ❌）—— 于是每次组装都会报"验收没通过"，
//    而问题列表其实是空的。假失败会让人去改验收脚本，那是最坏的结果。
const verify = spawnSync(
  process.execPath,
  [join(PKG_ROOT, 'scripts', 'check-release-package.mjs'), OUT],
  { stdio: 'inherit' },
)
if (verify.status === 0) {
  log('   ✅ 验收通过（退出码 0）')
} else {
  bad(
    `发布包验收没通过（退出码 ${verify.status ?? '?'}${verify.error ? `，${verify.error.code}` : ''}）` +
      ' —— 这个包不要发出去',
  )
}

// ── ⑥ 可选的 zip ─────────────────────────────────────────────────────────
if (WANT_ZIP) {
  log('')
  log('── ⑥ 压缩 ──')
  const zip = `${OUT}.zip`
  if (existsSync(zip) && !FORCE) {
    bad(`zip 已存在：${zip}（要覆盖用 --force）`)
  } else {
    try {
      // 用 tar（Windows 10+ 自带 bsdtar）而不是 Compress-Archive：
      // 后者对中文路径与大量小文件明显更慢，且会打出反斜杠分隔的条目名。
      const tar = spawnSync(
        'tar',
        ['-a', '-c', '-f', zip, '-C', dirname(OUT), relative(dirname(OUT), OUT)],
        { stdio: 'inherit' },
      )
      if (tar.status !== 0) throw new Error(`tar 退出码 ${tar.status}`)
      const zipMb = (statSync(zip).size / 1024 / 1024).toFixed(1)
      log(`   ✅ ${relative(REPO_ROOT, zip)}（${zipMb} MB）`)
    } catch (error) {
      bad(`压缩失败：${error?.message ?? error}（可手工：Compress-Archive -Path "${OUT}" -DestinationPath "${zip}"）`)
    }
  }
}

log('')
if (failures === 0) {
  log(`🎉 组装完成：${OUT}`)
  log('   下一步（可选）：node scripts/assemble-release.mjs --zip   —— 或用上面的 tar 命令')
  process.exit(0)
}
log(`⚠️ 有 ${failures} 项问题 —— 先解决再发`)
process.exit(1)
