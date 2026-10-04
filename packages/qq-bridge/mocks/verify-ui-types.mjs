/**
 * UI **类型检查**守卫（0.3.2 收尾）—— 把 `tsc -b` 接进测试链。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（一次真实的疏漏）
 * ══════════════════════════════════════════════════════════════════════════
 * 我给 `ConsolePanel.tsx` 写了四个没用上的 `Card*` 导入，而**我上一轮宣称"类型检查
 * 通过"** —— 因为我跑的是 `tsc --noEmit -p tsconfig.json`，而那份是**项目引用**
 * （`files: []` + `references`），那样跑**不检查被引用的 `tsconfig.app.json`**，
 * 而 `noUnusedLocals: true` 正好写在 app 那份里。
 * 结果：错误只在用户 `npm run build` 时才炸出来。
 *
 * 真判据是 `tsc -b`（`npm run build` 的第一步）。这道守卫就是跑它。
 *
 * ── 边界（如实写清）────────────────────────────────────────────────────────
 *   · 需要 `config-ui/node_modules`（`tsc` 本体 + 类型定义）。**没有就明确跳过**
 *     并说明原因，不算通过 —— 本项目对"跳过 ≠ 通过"有专门纪律。
 *   · 它**不跑 `vite build`**：那一步要 esbuild（受限沙箱里 `spawn EPERM`）。
 *     类型检查与打包是两件事，能离线做的是前者。
 *   · 它不改任何文件（`tsc -b` 只写 `node_modules/.tmp` 里的增量缓存）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

let pass = 0
let fail = 0
const failures = []
function ok(cond, label, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${label}${detail ? `  —— ${detail}` : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

const ROOT = join(import.meta.dirname, '..')
const UI = join(ROOT, 'config-ui')
const TSC = join(UI, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')

console.log('\n=== ① 前置：UI 工程与 tsc 在不在 ===')
ok(existsSync(join(UI, 'tsconfig.json')), 'config-ui/tsconfig.json 存在')
ok(existsSync(join(UI, 'tsconfig.app.json')), 'config-ui/tsconfig.app.json 存在（noUnusedLocals 写在它里面）')

// ★ 这条断言本身就是那次的教训：判据必须是 `tsc -b`（走项目引用），
//   而不是 `-p tsconfig.json`（那样不会检查 app 那份）。
const rootCfg = existsSync(join(UI, 'tsconfig.json')) ? readFileSync(join(UI, 'tsconfig.json'), 'utf8') : ''
ok(/references/.test(rootCfg), '★★ tsconfig.json 是**项目引用**形态 ⇒ 验证必须用 `tsc -b`（用 `-p` 会漏掉 app 那份）')
const appCfg = existsSync(join(UI, 'tsconfig.app.json')) ? readFileSync(join(UI, 'tsconfig.app.json'), 'utf8') : ''
ok(/noUnusedLocals"\s*:\s*true/.test(appCfg), '★ app 那份开了 noUnusedLocals（未使用导入会让 build 失败）')

console.log('\n=== ② 跑 tsc -b（与 npm run build 的第一步同一条命令）===')
if (!existsSync(TSC)) {
  // ★ 明确跳过，且**不当作通过** —— 本项目对"跳过 ≠ 通过"有专门纪律
  console.log('  ⏭️  跳过：没有 config-ui/node_modules（先在该目录跑 npm install）')
  console.log('      ★ 跳过**不算通过**：这一档在没装依赖的机器上不提供任何保护。')
} else {
  const r = spawnSync(TSC, ['-b', '--force'], { cwd: UI, stdio: 'inherit', shell: process.platform === 'win32' })
  ok(r.status === 0, '★★★ `tsc -b` 通过（UI 类型检查干净，含未使用导入/未使用参数）', r.status === 0 ? '' : `退出码 ${r.status}`)
}

console.log('\n=== ③ UI 源码守卫：那个「写入」按钮不许被静默禁用（一次真事故的回归锁）===')

// ★★★ 事故（2026-10-04，使用者原话：「即便在编辑页面修改了 serverport，依然显示
//   ⚠️ 它和本桥接这份配置对不上」）：`ServerForm.tsx` 里那个写入按钮原来写成
//   `disabled={rcon.busy || !rcon.patch.password}` —— 而密码框**永不回显**
//   （留空 = 不改）⇒ **它默认就是禁用的**。使用者把 `server-port` 改成 25566 再点，
//   **什么都没发生、也没有任何报错**，于是"改了游戏端口不生效"看起来像根本没修好。
//   那块原本只管 RCON 三项（"要开 RCON 就得给密码"还讲得通），后来扩成
//   **游戏端口 + EULA** ⇒ 那条前提就成了陷阱。
// ∴ 这条守卫盯的是**判据的形状**：任何 `disabled={…}` 都不许以密码框非空为前提。
//   （"没有要改的"这件事由那一行的「待写入」预告如实说出来，而不是把按钮弄死。）
const formPath = join(UI, 'src', 'sections', 'ServerForm.tsx')
const formSrc = existsSync(formPath) ? readFileSync(formPath, 'utf8') : ''
ok(formSrc.length > 0, 'config-ui/src/sections/ServerForm.tsx 读得到')

// ⚠️ 必须**先剥注释**再扫：上面那段事故说明里就逐字写着那个错的形状，
//    不剥的话守卫会被自己的注释判红（实测踩到过）。
const stripComments = (t) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释（含 JSX 的 {/* … */}）
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // 行注释（避开 "https://" 里的那个 //）
const scanDisabled = (t) => [...stripComments(t).matchAll(/disabled=\{([^}]*)\}/g)].map((m) => m[1])

const disables = scanDisabled(formSrc)
const offenders = disables.filter((d) => /patch\.password/.test(d))
ok(
  disables.length > 0 && offenders.length === 0,
  '★★★ 写入按钮**不以「密码框非空」为前提**（那样它会默认禁用，点了没反应也没提示）',
  offenders.length
    ? `有 ${offenders.length} 处以密码框非空为前提：${offenders.join(' / ')}`
    : `扫了 ${disables.length} 处 disabled=，没有一处以密码框非空为前提`,
)
// ★ 对照：把事故的那个形状喂进同一个扫描器，**必须**被抓到 ——
//   否则"0 处"可能只是"扫描器什么都没查"（本项目对可证伪性有专门纪律）。
ok(
  scanDisabled('<Button disabled={rcon.busy || !rcon.patch.password} />').filter((d) => /patch\.password/.test(d)).length === 1,
  '★★ 对照：事故的那个形状喂进来必须被抓到（证明这道守卫不是空跑）',
)
ok(
  /onClick=\{\(\) => void applyRcon\(\)\}/.test(formSrc),
  '★★ 「写入并同步到本桥接」不送 agreeEula（同意条款不能顺带做掉）',
)
ok(
  /applyRcon\(\{\s*agreeEula:\s*true/.test(formSrc),
  '★★ 同意 EULA 那条路**显式**送 `agreeEula: true`（由使用者自己点那个按钮）',
)
ok(/const willWrite = /.test(formSrc) && /会改：/.test(formSrc), '★ 有「待写入」预告：点了到底会改哪几项，不靠猜')

console.log('')
if (fail === 0) {
  console.log(`🎉 UI 类型检查守卫：${pass} 项通过`)
  process.exitCode = 0
} else {
  console.log(`❌ UI 类型检查守卫：${pass} 项通过、${fail} 项失败`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
