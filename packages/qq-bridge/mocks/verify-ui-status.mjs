/**
 * 界面新鲜度（`src/ui-status.mjs`）的状态机与"发布包形态"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么有这个套件（2026-10-03 实机验证报的错）
 * ══════════════════════════════════════════════════════════════════════════
 * 发布包**按设计不含 `config-ui/src`**（只拷 `config-ui/dist`），也不含 `scripts/`。
 * 而 `ui-status.mjs` 原来在**顶层**硬 `require('scripts/ui-build-stamp.cjs')` ⇒
 * 用户机器上整个模块加载失败：
 *
 *   ❌ 界面检查失败：Cannot find module 'C:\InteractiveBot\scripts\ui-build-stamp.cjs'
 *   Require stack: - C:\InteractiveBot\src\ui-status.mjs
 *
 * 上层把它兜成 `unstamped`，界面再渲染成「你看到的是旧界面」——**在发布包里那是假话**
 * （界面不旧，只是没有源码可比）。两个修法里只有一个是错的：
 *   · ❌ 把标记模块打进包：它算哈希的输入是 `config-ui/src`，包里没有 ⇒ 空哈希 ⇒
 *     变成 `stale`（"源码改了没重新构建"）—— 误导更强；
 *   · ✅ 认出发布包形态 ⇒ 新状态 `packaged`，如实说"本机无法核对"。
 *
 * 所以本套件盯三件事：**四种状态分得开** / **packaged 不算告警** /
 * **在没有 scripts/ 与 config-ui/src 的"包根"里模块仍能加载**（最后一节是端到端回归）。
 *
 * 用法：node mocks/verify-ui-status.mjs
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  checkUiFreshness,
  isUiFreshnessAlarm,
  uiFreshnessTitle,
} from '../src/ui-status.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`✅ ${name}${detail ? `  —— ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`❌ ${name}  —— ${detail}`)
  }
}
function section(t) {
  console.log(`\n── ${t} ──`)
}
const tmpBase = mkdtempSync(join(tmpdir(), 'qq-bridge-ui-status-'))
const freshDir = (name) => {
  const d = join(tmpBase, name)
  mkdirSync(d, { recursive: true })
  return d
}

// ══════════════════════════════════════════════════════════════════════════
section('① 发布包形态：没有界面源码 ⇒ packaged（不是"旧界面"）')
// ══════════════════════════════════════════════════════════════════════════
{
  // 造一个"包根"：只有产物，没有 config-ui/src、没有 scripts/
  const pkg = freshDir('pkg-only-dist')
  const dist = join(pkg, 'config-ui', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<html></html>', 'utf8')
  writeFileSync(
    join(dist, 'ui-build.json'),
    JSON.stringify({ name: 'config-ui', pkgVersion: '0.3.0alpha', builtAt: '2026-10-02T14:09:39.870Z', sourceHash: 'deadbeef' }),
    'utf8',
  )

  const r = checkUiFreshness({ distDir: dist, pkgRoot: pkg })
  check('★★ 没有 config-ui/src ⇒ 状态是 packaged', r.status === 'packaged', r.status)
  check('★★ 它明说"本机无法核对"、并点出"不影响回话"', /无法核对/.test(r.why) && /不是故障|不影响回话/.test(r.advice), r.why)
  check('★★ 文案里**不许**出现"旧界面"（那正是这次要修的假话）',
    !/旧界面/.test(r.why) && !/旧界面/.test(r.advice) && !/旧界面/.test(uiFreshnessTitle(r.status)),
    uiFreshnessTitle(r.status))
  check('★ 顺带把产物里记的构建时间读出来给人看（只读展示，不参与判定）',
    r.stamp?.builtAt === '2026-10-02T14:09:39.870Z', JSON.stringify(r.stamp ?? null))
  check('★ packaged 的标题说清"包里只带产物、不带源码"',
    /发布包/.test(uiFreshnessTitle('packaged')) && /不带源码|只带产物/.test(uiFreshnessTitle('packaged')),
    uiFreshnessTitle('packaged'))
}

// ══════════════════════════════════════════════════════════════════════════
section('② 有源码但标记模块读不到 ⇒ unstamped（检出缺文件，不是发布包）')
// ══════════════════════════════════════════════════════════════════════════
{
  const pkg = freshDir('pkg-with-src-no-scripts')
  const dist = join(pkg, 'config-ui', 'dist')
  mkdirSync(dist, { recursive: true })
  mkdirSync(join(pkg, 'config-ui', 'src'), { recursive: true }) // ★ 有源码
  writeFileSync(join(dist, 'index.html'), '<html></html>', 'utf8')

  const r = checkUiFreshness({ distDir: dist, pkgRoot: pkg })
  check('★★ 有源码、没有 scripts/ ⇒ unstamped（不是 packaged）', r.status === 'unstamped', r.status)
  check('★ 如实点名缺的是哪个文件', /ui-build-stamp\.cjs/.test(r.why), r.why)
  check('★ 并给出正确修法：从仓库重新取，**不要**靠重新构建',
    /重新取|缺了它/.test(r.advice) && /不要/.test(r.advice), r.advice)
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 告警判据：packaged / fresh 不算告警')
// ══════════════════════════════════════════════════════════════════════════
check('★ packaged 不是告警（发布包天天在跑，不该天天喊旧界面）', isUiFreshnessAlarm('packaged') === false)
check('★ fresh 不是告警', isUiFreshnessAlarm('fresh') === false)
check('★★ stale / unstamped / missing 都是告警', ['stale', 'unstamped', 'missing'].every((s) => isUiFreshnessAlarm(s) === true))
check('★ 未知状态按"要人看一眼"处理（保守）', isUiFreshnessAlarm('whatever') === true)
check('★ 三种已知问题的标题互不相同（不许混成一句"不同步"）',
  new Set(['stale', 'unstamped', 'missing'].map(uiFreshnessTitle)).size === 3)
check('★ stale 的标题说清"落后于/没重新构建"（"你看到的是旧界面"这句在界面上，见 ⑦）',
  /落后/.test(uiFreshnessTitle('stale')) && /重新构建/.test(uiFreshnessTitle('stale')), uiFreshnessTitle('stale'))

// ══════════════════════════════════════════════════════════════════════════
section('④ 开发机（本仓库）：只能是 fresh/stale/missing/unstamped，绝不可能是 packaged')
// ══════════════════════════════════════════════════════════════════════════
{
  const r = checkUiFreshness()
  check('★★ 本仓库有 config-ui/src ⇒ 不会被判成 packaged', r.status !== 'packaged', r.status)
  check('★ 状态在已知集合里', ['fresh', 'stale', 'unstamped', 'missing'].includes(r.status), r.status)
  check('★ 若 stale，则 why 里给得出两个哈希前缀（可定位）',
    r.status !== 'stale' || /哈希/.test(r.why), r.why.slice(0, 80))
  if (r.status !== 'fresh') {
    console.log(`   （提示：本机现在这份 dist 是 ${r.status} —— 发布前要用 npm run build 让它回到 fresh）`)
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ ★★ 端到端回归：在没有 scripts/ 与 config-ui/src 的"包根"里，模块必须仍能加载')
// ══════════════════════════════════════════════════════════════════════════
//
// 这一节复刻实机那条 `Cannot find module`：把 src/ 整份拷到一个临时目录当"包根"，
// 那里**没有** scripts/、**没有** config-ui/src，然后真的 import 一次。
// 顶层硬 require 那种写法会在这一步当场抛错 —— 这正是回归守卫的价值。
{
  const pkg = freshDir('pkg-copy')
  cpSync(join(PKG_ROOT, 'src'), join(pkg, 'src'), { recursive: true })
  const dist = join(pkg, 'config-ui', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<html></html>', 'utf8')
  check('前提：这份拷贝里没有 scripts/', !existsSync(join(pkg, 'scripts')))
  check('前提：这份拷贝里没有 config-ui/src', !existsSync(join(pkg, 'config-ui', 'src')))

  const probe = join(pkg, 'probe.mjs')
  const probeOut = join(pkg, 'probe-out.json')
  writeFileSync(
    probe,
    `import { writeFileSync } from 'node:fs'\n` +
      `import { checkUiFreshness, uiFreshnessTitle } from ${JSON.stringify(pathToFileURL(join(pkg, 'src', 'ui-status.mjs')).href)}\n` +
      'const r = checkUiFreshness()\n' +
      `writeFileSync(${JSON.stringify(probeOut)}, JSON.stringify({ status: r.status, title: uiFreshnessTitle(r.status) }))\n`,
    'utf8',
  )
  const { spawnSync } = await import('node:child_process')
  // ⚠️ 输出**不能用管道捕获**：本项目在受限沙箱下实测 spawnSync 的 'pipe' 会 EPERM
  //    （报错里连退出码都没有）。所以让子进程把结果**写到文件**，父进程读文件 ——
  //    这正是 assemble-release.mjs 的既有约定（见那里的注释）。
  const out = spawnSync(process.execPath, [probe], { cwd: pkg, stdio: 'inherit' })
  check('★★ import 成功（退出码 0）—— 顶层硬 require 那版会在这里抛 Cannot find module',
    out.status === 0, `exit=${out.status} ${out.error ? `error=${out.error.code}` : ''}`)
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(probeOut, 'utf8'))
  } catch {
    parsed = null
  }
  check('★★ 它在"包根"里得出来的结论是 packaged', parsed?.status === 'packaged', JSON.stringify(parsed))
  check('★★ 而且那句话里没有"旧界面"', parsed !== null && !/旧界面/.test(String(parsed.title)), String(parsed?.title))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 形状守卫：标记模块不许再被"顶层 require"')
// ══════════════════════════════════════════════════════════════════════════
{
  const text = readFileSync(join(PKG_ROOT, 'src', 'ui-status.mjs'), 'utf8')
  const topLevelRequire = /^const\s*\{[^}]*\}\s*=\s*require\(/m.test(text)
  check('★★ src/ui-status.mjs 里没有顶层 require（那正是实机崩法的形状）', !topLevelRequire)
  check('★ 有惰性加载的 loadStampTool（失败要如实说出来，而不是抛出去）',
    /function loadStampTool\(/.test(text) && /ok: false/.test(text))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ 界面侧：告警条件不许再写成"不是 fresh 就打横幅"')
// ══════════════════════════════════════════════════════════════════════════
//
// 客户端是浏览器包，import 不到 src/ —— 判据有两份实现，这里把两份钉在一起，
// 免得改一处忘一处（`config-ui/src` 在 test 链里本来没有任何静态审计）。
{
  const home = readFileSync(join(PKG_ROOT, 'config-ui', 'src', 'pages', 'Home.tsx'), 'utf8')
  const api = readFileSync(join(PKG_ROOT, 'config-ui', 'src', 'lib', 'api.ts'), 'utf8')
  check('★★ 横幅条件是 isUiAlarm(...)，不是 "status !== \'fresh\'"（后者正是实机那条假话的来源）',
    /isUiAlarm\(status\.ui\.status\)/.test(home) && !/status\.ui\.status !== 'fresh'/.test(home))
  check('★ Home.tsx 里 import 了 isUiAlarm', /import \{[^}]*isUiAlarm[^}]*\} from '@\/lib\/api'/.test(home))
  check('★★ packaged 走**中性说明**那条分支（不是告警框）',
    /status\?\.ui\?\.status === 'packaged'/.test(home) && /text-muted-foreground/.test(home))
  check('★ 只有 stale 才说"你看到的是旧界面"', /'你看到的是旧界面（源码改了没重新构建）'/.test(home))
  check('★★ 两份判据语义一致（都不是 fresh、也都不是 packaged）',
    /status !== 'fresh' && status !== 'packaged'/.test(api) &&
      /status !== 'fresh' && status !== 'packaged'/.test(readFileSync(join(PKG_ROOT, 'src', 'ui-status.mjs'), 'utf8')))
}

rmSync(tmpBase, { recursive: true, force: true })

console.log('')
if (failed === 0) {
  console.log(`🎉 界面新鲜度状态机测试全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败（${passed} 项通过）`)
process.exit(1)
