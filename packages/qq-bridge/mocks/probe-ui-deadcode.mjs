#!/usr/bin/env node
/**
 * 控制台源码**死代码**探针（0.2.2，只读，不是测试）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它回答什么
 * ══════════════════════════════════════════════════════════════════════════
 * `config-ui/src` 是从模板生成出来的，模板把 50+ 个 shadcn 组件一股脑放在
 * `components/ui/` 里。用了几个、剩几个没人知道 —— 结果是"这个仓库有多少文件"
 * 这件事本身就是失真的（实测：83 个源文件里从 `main.tsx` 出发只有 42 个可达）。
 *
 * 这个探针从 **`src/main.tsx`** 出发做一次 import 图遍历（支持 `@/` 别名与省略扩展名），
 * 把**不可达**的文件列出来。`docs/0.2.2-console-plan.md` 的"减法"清单就是它跑出来的。
 *
 * ── 为什么不做成 npm test 里的断言 ────────────────────────────────────────
 * 现在它**本来就会红**（35 个模板组件还没删）。把它塞进测试链只会让
 * "全绿"这个信号变假 —— 本项目对这件事的态度写在 `mocks/harness.mjs` 顶部：
 * 跑不了/还没做就说清楚，别伪装成通过。等清理做完，这条可以升格成断言。
 *
 * 用法：
 *   node mocks/probe-ui-deadcode.mjs           # 人类可读清单
 *   node mocks/probe-ui-deadcode.mjs --json     # 结构化（给后续脚本/门禁用）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { PKG_ROOT } from '../src/local.mjs'

const SRC = join(PKG_ROOT, 'config-ui', 'src')
const asJson = process.argv.includes('--json')

/** 收集 src 下的全部源文件。 */
function listFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) listFiles(p, out)
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * 解析一条 import 说明符到真实文件。
 *
 * 只处理两类：`@/x`（模板的别名，指向 src/x）与相对路径 `./x`。
 * 裸包名（react、sonner…）**不算边** —— 它们是依赖，不是源文件。
 * 扩展名按 TS/Vite 的解析顺序补：先原样，再 .tsx/.ts/.css，最后 /index.tsx。
 */
function resolveSpec(fromFile, spec) {
  let base
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
  else return null
  for (const ext of ['', '.tsx', '.ts', '.css', '/index.tsx', '/index.ts']) {
    const cand = base + ext
    try {
      if (statSync(cand).isFile()) return cand
    } catch {
      /* 不存在就试下一个 */
    }
  }
  return null
}

const files = listFiles(SRC)

/** 邻接表：文件 → 它 import 到的源文件。 */
const deps = new Map()
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  const out = []
  // ⚠️ 必须同时认两种写法：`import { x } from 'y'` **和**副作用导入 `import 'y'`
  //   （样式就是这么进来的）。第一版只认 `from '…'`，于是 `index.css` 被误判成死代码 ——
  //   一个把"入口样式"报成死代码的探针，会让人去删掉它。
  for (const m of text.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
    const hit = resolveSpec(f, m[1])
    if (hit) out.push(hit)
  }
  deps.set(f, out)
}

// 从入口做可达性遍历（深度优先，visited 去重）
const entry = join(SRC, 'main.tsx')
const seen = new Set()
const stack = [entry]
while (stack.length) {
  const f = stack.pop()
  if (seen.has(f)) continue
  seen.add(f)
  for (const d of deps.get(f) ?? []) stack.push(d)
}

const dead = files
  .filter((f) => !seen.has(f))
  .map((f) => relative(SRC, f).replace(/\\/g, '/'))
  .sort()

const result = {
  total: files.length,
  reachable: seen.size,
  dead: dead.length,
  files: dead,
  // 分类只是为了让清单好读（真删之前仍然以"不可达"为唯一判据）
  templates: dead.filter((f) => f.startsWith('components/ui/')).length,
  other: dead.filter((f) => !f.startsWith('components/ui/')),
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`控制台源码：${result.total} 个文件，从 main.tsx 可达 ${result.reachable} 个`)
  console.log(`不可达（死代码）：${result.dead} 个（其中模板组件 ${result.templates} 个）\n`)
  for (const f of result.files) console.log(`  ${f}`)
  console.log('')
  console.log('判据是"从 src/main.tsx 出发的 import 图不可达"，不是名字好不好听。')
  console.log('删除前请重跑本探针；删完应只剩你确实要新加的页面文件。')
  console.log('（清理方案与顺序见 docs/0.2.2-console-plan.md §3.3）')
}
