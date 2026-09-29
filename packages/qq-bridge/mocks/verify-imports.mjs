/**
 * **导入与登记漂移审计**（H16）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它防的是哪三种"不报错的坏"
 * ══════════════════════════════════════════════════════════════════════════
 * ① **导入指向不存在的文件**：改名/移动文件后漏改一处 `import` —— 只有当那条**代码路径
 *    真的被执行**时才会以 `ERR_MODULE_NOT_FOUND` 炸出来，而它可能是"每周才跑一次"的分支。
 * ② **写了模块没人用**（孤儿模块）：功能写好了、测试也有，但**接线从来没做** ——
 *    本项目最贵的一类缺陷（"任务段在真机上从未注入"就是这么来的）。孤儿模块本身不是错，
 *    但**它必须是有意的**，所以这里要求它在白名单里、并写清为什么。
 * ③ **写了测试套件没登记**：`mocks/verify-*.mjs` 存在但不在 `package.json` 的 `test` 链里 ——
 *    它永远不会跑，而且**没有任何地方提示**。本审计真实地抓过这一类
 *    （H3/H10/H14 的套件都是靠人工记得才登记上的）。
 *
 * 用法：node mocks/verify-imports.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** 递归收集 .mjs（跳过 node_modules / vendor / dist / 临时目录）。 */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'vendor' || name === 'dist' || name.startsWith('.tmp')) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) {
      if (['workspace-qq', 'logs', 'cache', '_release', 'snowluma'].includes(name)) continue
      collect(abs, out)
    } else if (name.endsWith('.mjs')) {
      out.push(abs)
    }
  }
  return out
}

/**
 * 抽出所有**相对导入**的字面量。
 *
 * ⚠️ 只认字面量（`from './x.mjs'` / `import('./x.mjs')`）—— 动态拼路径的导入本来就没法静态审计，
 * 那种情况要人工看。这里**不假装能覆盖它**。
 *
 * ★ 必须先**剥掉注释**：第一版直接扫全文，于是本文件头部那句
 * `from './x.mjs'` 的**示例**把审计自己给报了出来（假阳性）。
 * 剥注释的做法保守：只整行剥 `//`（不看行内的，免得误伤字符串里的 URL）与成块剥 `/* *\/`。
 */
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n')
}

function relativeImports(text) {
  const out = new Set()
  const re = /(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g
  let m
  const body = stripComments(text)
  while ((m = re.exec(body)) !== null) out.add(m[1])
  return [...out]
}

const files = collect(PKG_ROOT)
const allRel = files.map((f) => relative(PKG_ROOT, f).replace(/\\/g, '/'))

// ══════════════════════════════════════════════════════════════════════════
section('① 每个相对导入都要指向真实存在的文件')
// ══════════════════════════════════════════════════════════════════════════
const broken = []
const escaped = []
const importGraph = new Map()
for (const abs of files) {
  const rel = relative(PKG_ROOT, abs).replace(/\\/g, '/')
  const text = readFileSync(abs, 'utf8')
  const imports = relativeImports(text)
  importGraph.set(rel, imports)
  for (const spec of imports) {
    if (!spec.endsWith('.mjs')) continue // 只审计 ESM 文件导入（JSON 等由运行时处理）
    const target = resolve(dirname(abs), spec)
    const targetRel = relative(PKG_ROOT, target).replace(/\\/g, '/')
    if (targetRel.startsWith('..')) {
      escaped.push(`${rel} → ${spec}`)
      continue
    }
    if (!existsSync(target)) broken.push(`${rel} → ${spec}`)
  }
}
check('★ 没有指向不存在文件的导入（改名漏改会在这里现形）', broken.length === 0, broken.join(' | ') || '（干净）')
check('★ 没有相对导入跑到包外（`../../` 越界会让整个包不能搬走）', escaped.length === 0, escaped.join(' | ') || '（干净）')
console.log(`   （扫了 ${files.length} 个 .mjs 文件）`)

// ══════════════════════════════════════════════════════════════════════════
section('② 孤儿模块：写了没人用，**必须是有意的**')
// ══════════════════════════════════════════════════════════════════════════
{
  // 白名单：允许"暂时没人 import"的模块，但**每个都要写理由**。
  // 加东西进来之前先问自己：这是有意的（入口/夹具），还是我忘了接线？
  //
  // ★ 0.2.4 的一个实例：`src/sticker-tag.mjs` 一开始确实是孤儿（离线入口，
  //   由人手动 `node src/sticker-tag.mjs` 跑），后来 `verify-sticker-tag.mjs`
  //   要测它的解析器 —— 于是它**不再是孤儿**，白名单条目就必须删掉。
  //   这条"白名单本身也要维护"的守卫正是为这种时刻准备的：留着旧条目会掩盖
  //   真正的孤儿（以后有人把 import 删了也不会有人发现）。
  const ALLOWED_ORPHANS = {
    'src/index.mjs': '命令行入口：由 node 直接执行，不是被 import 的',
  }
  const imported = new Set()
  for (const [, specs] of importGraph) {
    for (const spec of specs) {
      if (!spec.endsWith('.mjs')) continue
      imported.add(spec.replace(/^\.\//, '').split('/').pop())
    }
  }
  // 按文件名匹配（相对导入的写法在各目录里不同，这里只问"这个模块名有没有人导"）
  const srcModules = allRel.filter((r) => r.startsWith('src/'))
  const orphans = srcModules.filter((r) => {
    const base = r.split('/').pop()
    return !imported.has(base) && !Object.prototype.hasOwnProperty.call(ALLOWED_ORPHANS, r)
  })
  check('★ src/ 下没有"没人导入又没有登记"的模块（忘记接线是本项目最贵的一类 bug）',
    orphans.length === 0, orphans.join(' | ') || '（都接上了）')

  const staleAllow = Object.keys(ALLOWED_ORPHANS).filter((r) => {
    const base = r.split('/').pop()
    return imported.has(base)
  })
  check('★ 白名单本身也要维护：已经有人导入的条目要从白名单里删掉（否则它会掩盖真正的孤儿）',
    staleAllow.length === 0, staleAllow.join(' | ') || '（白名单是准的）')
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 测试套件必须登记进 package.json 的 test 链')
// ══════════════════════════════════════════════════════════════════════════
{
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  const chain = String(pkg.scripts?.test ?? '')
  // 允许"故意不进链"的：要花钱的、要真 QQ 的、要真协议端的
  const ALLOWED_UNREGISTERED = {
    'verify-live.mjs': '★ 会真的调用模型（花钱），所以刻意不进 `npm test` 链',
    'session-grep.mjs': '取证工具，不是测试（`mocks/` 下但不是 verify-*）',
    'probe-onebot-actions.mjs': '真机探针，不是测试（要连协议端）',
    'mock-sdk-server.mjs': '模拟服务端（由别的套件拉起）',
    'mock-onebot-server.mjs': '模拟服务端（由别的套件拉起）',
  }
  const suites = readdirSync(join(PKG_ROOT, 'mocks')).filter((n) => /^verify-.*\.mjs$/.test(n))
  const unregistered = suites.filter(
    (n) => !chain.includes(`mocks/${n}`) && !Object.prototype.hasOwnProperty.call(ALLOWED_UNREGISTERED, n),
  )
  check('★★ 每个 verify-*.mjs 都在 test 链里（写好了没人跑 = 等于没写）',
    unregistered.length === 0, unregistered.join(' | ') || `（${suites.length} 套都已登记）`)

  const stale = Object.keys(ALLOWED_UNREGISTERED).filter(
    (n) => /^verify-.*\.mjs$/.test(n) && chain.includes(`mocks/${n}`),
  )
  check('  例外清单没有过期条目（进了链就不该再挂在例外里）', stale.length === 0, stale.join(' | ') || '（准的）')
  check('  链里引用的每个套件文件都真实存在',
    (chain.match(/mocks\/[\w.-]+\.mjs/g) ?? []).every((p) => existsSync(join(PKG_ROOT, p))),
    '（都找得到）')
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 版本号单一来源：脚本不许自己写死版本')
// ══════════════════════════════════════════════════════════════════════════
{
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  const scriptsDir = join(PKG_ROOT, 'scripts')
  const offenders = []
  if (existsSync(scriptsDir)) {
    for (const name of readdirSync(scriptsDir).filter((n) => n.endsWith('.mjs'))) {
      const text = readFileSync(join(scriptsDir, name), 'utf8')
      // 形如 `const VERSION = '0.2.0'` 的硬编码 → 应该从 package.json 读
      if (/const\s+VERSION\s*=\s*['"]\d+\.\d+/.test(text)) offenders.push(`scripts/${name}`)
    }
  }
  check('★ 没有脚本把版本号写死（改一处、四处不一致是发布事故的常见来源）',
    offenders.length === 0, offenders.join(' | ') || '（都从 package.json 读）')
  check('  package.json 的 version 可读且形如 x.y.z', /^\d+\.\d+\.\d+/.test(String(pkg.version)), String(pkg.version))
}

console.log('')
if (failed === 0) {
  console.log(`🎉 导入与登记审计通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败（${passed} 项通过）`)
process.exit(1)
