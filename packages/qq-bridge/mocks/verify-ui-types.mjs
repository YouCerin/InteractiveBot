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

console.log('')
if (fail === 0) {
  console.log(`🎉 UI 类型检查守卫：${pass} 项通过`)
  process.exitCode = 0
} else {
  console.log(`❌ UI 类型检查守卫：${pass} 项通过、${fail} 项失败`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
