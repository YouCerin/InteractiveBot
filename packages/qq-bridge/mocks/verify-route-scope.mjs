/**
 * **路由对象的作用域守卫**（0.3.2 补）—— 一次真实事故换来的。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它守的是什么（用户报的原文）
 * ══════════════════════════════════════════════════════════════════════════
 *   「我在拓展中开启了定时任务功能，但是标签页中显示未开启且读不到定时任务：
 *     接口内部错误：listScheduleTasks is not defined」
 *
 * 形状：`--schedule` 那个 **CLI 段**里用
 *   `const { listTasks: listScheduleTasks, … } = await import('./schedule.mjs')`
 * 造了一批**块级局部别名**，而任务页签的四条接口（`index.mjs` 里
 * `createApiHandler({…})` 那个对象，在 `main()` 的**另一处**）照着抄了这些名字
 * ⇒ 那四条接口在真实运行时一律抛 `ReferenceError`，界面表现成
 * 「接口内部错误 + 任务页签什么都读不到」。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 为什么当时的测试全绿（这一条比 bug 本身更值得记下来）
 * ══════════════════════════════════════════════════════════════════════════
 * `verify-api-h13.mjs` 与 `verify-apitest.mjs` **各自造了一份路由对象**
 * （各自 `import` 一份 `schedule.mjs`），所以它们测的是**副本** ——
 * 而**这份真实接线从来没有被跑过一次**。这与"任务段从未注入过"是同一类缺陷：
 * **测试全绿，而真机上那条路根本不存在**。
 *
 * ∴ 这一套的做法是**直接审 `src/index.mjs` 里那份真实的路由对象**，
 *   而不是另造一份来测：
 *   ① 词法扫描（剥掉注释/字符串/模板）→ 拿到 token；
 *   ② 括号配对找到 `main()` 的函数体与 `createApiHandler({…})` 的参数对象；
 *   ③ 收集**在作用域里真的有的**名字：模块级 import / 顶层声明 +
 *      `main()` 里块深度不比路由对象更深的那些声明 + 对象字面量内部
 *      自己声明的（箭头参数等）；
 *   ④ 收集对象字面量里**被当作函数调用**的名字与**全大写常量**；
 *   ⑤ 剩下的必须为空。
 *
 * ⚠️ **它做不到什么（如实写）**：这是一个**启发式静态检查**，不是真正的
 *   作用域分析器。已知边界：
 *     · 只查"调用位置的名字"与"全大写常量" —— 一个纯粹当值用的小写标识符
 *       （例如漏了一个 `const foo = …` 而后写成 `bar: foo`）它抓不到；
 *     · **同深度的兄弟块**里的声明会被误算成"在作用域里" ⇒ 会**漏报**
 *       （这是刻意选的失败方向：宁可漏，也不要天天红）；
 *     · 模板字面量里的 `${}` 也当代码扫，但不做语义分析；变量遮蔽只按"名字存在"算。
 *   ★ 它是**可证伪的**：下面第 ① 节有正/负对照 —— 负对照（故意写一个没定义的
 *     调用、以及**本次事故的真实形状**）必须被抓到，正对照（作用域里有的名字、
 *     同一层声明的别名）必须不被抓。
 *   ★ 第 ② 节末尾还有一条**反向对照**：把这批别名从"已绑定"里拿掉时必须变红
 *     —— 用来证明"0 项未定义"不是"检查器什么都没查"。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')

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
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, label, same ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`)
}

// ══════════════════════════════════════════════════════════════════════════
// 极简词法扫描（剥注释/字符串/模板/正则）
// ══════════════════════════════════════════════════════════════════════════

/** 上一个 token 是不是"值"（决定 `/` 是除号还是正则字面量的开头）。 */
function regexAllowed(prev) {
  if (!prev) return true
  if (prev.t === 'id') {
    return !['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await'].includes(prev.v)
  }
  if (prev.t === 'num' || prev.t === 'str' || prev.t === 'regex') return false
  if (prev.t === 'p') return ![')', ']'].includes(prev.v)
  return true
}

/**
 * 把源码切成 token。
 * @returns {{t:'id'|'num'|'str'|'regex'|'p', v:string, at:number}[]}
 */
export function tokenize(src) {
  const out = []
  let i = 0
  let prev = null
  const push = (t, v, at) => {
    const tok = { t, v, at }
    out.push(tok)
    prev = tok
  }
  const isIdStart = (c) => /[A-Za-z_$]/.test(c)
  const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c)

  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      i += 1
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i += 1
        i += 1
      }
      i += 1
      push('str', '', i)
      continue
    }
    if (c === '`') {
      // 模板：`${…}` 里的内容**照常当代码扫**（否则会漏掉里面的调用）
      i += 1
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === '`') {
          i += 1
          break
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          // 把 ${ 里的内容当代码扫一遍（不追求嵌套模板的完美，够用即可）
          i += 2
          let depth = 1
          const inner = i
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth += 1
            else if (src[i] === '}') depth -= 1
            i += 1
          }
          for (const tk of tokenize(src.slice(inner, i - 1))) out.push({ ...tk, at: inner + tk.at })
          continue
        }
        i += 1
      }
      push('str', '', i)
      continue
    }
    if (c === '/' && regexAllowed(prev)) {
      const begin = i
      i += 1
      let inClass = false
      let closed = false
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === '[') inClass = true
        else if (src[i] === ']') inClass = false
        else if (src[i] === '/' && !inClass) {
          closed = true
          break
        } else if (src[i] === '\n') break // 换行不能出现在正则里 ⇒ 那不是正则
        i += 1
      }
      if (!closed) {
        // 不是正则（当除号处理，别把后面的代码吞掉）
        i = begin + 1
        push('p', '/', begin)
        continue
      }
      i += 1
      while (i < src.length && /[a-z]/.test(src[i])) i += 1
      push('regex', '', i)
      continue
    }
    if (isIdStart(c)) {
      let j = i
      while (j < src.length && isIdPart(src[j])) j += 1
      push('id', src.slice(i, j), i)
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9a-fA-FxXoObB._n]/.test(src[j])) j += 1
      push('num', '', i)
      i = j
      continue
    }
    push('p', c, i)
    i += 1
  }
  return out
}

/** 从 token 下标 `from`（指向开括号）找配对的闭括号，返回其下标；找不到返回 -1。 */
export function matchBracket(tokens, from) {
  const open = tokens[from]?.v
  const close = { '(': ')', '{': '}', '[': ']' }[open]
  if (!close) return -1
  let depth = 0
  for (let i = from; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t.t !== 'p') continue
    if (t.v === open) depth += 1
    else if (t.v === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** JS 里本来就有的名字（不算"没定义"）。 */
const GLOBALS = new Set([
  'process', 'console', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'Buffer', 'URL', 'URLSearchParams', 'Promise', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect', 'Intl', 'BigInt',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'structuredClone', 'fetch', 'TextDecoder', 'TextEncoder', 'AbortController', 'AbortSignal',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  'globalThis', 'undefined', 'NaN', 'Infinity', 'require', 'module', 'exports', '__dirname', '__filename',
  'performance', 'crypto', 'atob', 'btoa', 'Function', 'eval', 'arguments',
  // 关键字/语句里会出现的（我们只做"名字"的粗筛，把它们排除掉免得误报）
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
  'function', 'class', 'extends', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'void',
  'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield', 'const', 'let', 'var',
  'this', 'super', 'null', 'true', 'false', 'import', 'export', 'from', 'as', 'get', 'set', 'static',
])

/** 从 `const|let|var|function|class` 那个 token 起，收集这次声明引入的名字。 */
function collectDeclNames(tokens, at, bound) {
  let j = at + 1
  if (tokens[j]?.t === 'id' && tokens[j].v === 'async') j += 1
  while (j < tokens.length) {
    const u = tokens[j]
    if (u.t === 'id') {
      // `{ a: b }` 里 `a` 是属性名、`b` 是名字 —— 两个都收（多收只少报，不误报）
      bound.add(u.v)
      j += 1
      continue
    }
    if (u.t === 'p' && ['{', '[', ',', ':'].includes(u.v)) {
      j += 1
      continue
    }
    break
  }
  return bound
}

/** 模块级（括号深度 0）出现的绑定名：import 子句 + 顶层声明。 */
export function moduleScopeNames(tokens) {
  const bound = new Set()
  let depth = 0
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t.t === 'p' && ['{', '(', '['].includes(t.v)) {
      depth += 1
      continue
    }
    if (t.t === 'p' && ['}', ')', ']'].includes(t.v)) {
      depth -= 1
      continue
    }
    if (depth !== 0) continue
    if (t.t === 'id' && t.v === 'import') {
      // `import <clause> from '…'` —— 收集子句里的**所有** id。
      // ★ `a as b` 会把 a 与 b 都收进来（多收一个只会少报、不会误报）。
      if (tokens[i + 1]?.t === 'p' && tokens[i + 1].v === '(') continue // 动态 import()
      for (let j = i + 1; j < tokens.length; j += 1) {
        if (tokens[j].t === 'str') break
        if (tokens[j].t === 'id' && tokens[j].v === 'from') break
        if (tokens[j].t === 'id') bound.add(tokens[j].v)
      }
      continue
    }
    if (t.t === 'id' && ['const', 'let', 'var', 'function', 'class'].includes(t.v)) {
      collectDeclNames(tokens, i, bound)
    }
  }
  return bound
}

/**
 * `main()` 函数体里声明的名字（只收"块深度 ≤ maxDepth"的那些）。
 *
 * ★★★ 为什么是"深度 ≤ N"而不是"只看第一层"（第一版就是这么写的，实测**误报**）：
 *   真实代码里 `createApiHandler({…})` 并不在 `main()` 的第一层，而在
 *   `if (config.ui.apiEnabled !== false) { … }` 这个块里（相对深度 1），
 *   紧挨着它声明的 `readConfigFromDisk` 也在那一层。
 *   ∴ 判据是"**块深度不比路由对象更深**的那些声明都算在作用域里"。
 * ★★ 也**不按位置过滤**（第二版试过 `beforeIndex`，又一次误报）：
 *   `shutdown` 是在路由对象**下面**才声明的（`const shutdown = async (…) => …`），
 *   而路由里那两处调用是**闭包内的前向引用** —— 调用发生时它早就初始化了，
 *   完全合法（源码里还有一行注释专门说明这件事）。
 * ⚠️ 代价（如实写）：同深度的**兄弟块**里的声明也会被算进来 ⇒ 会**漏报**，
 *   而这正是本检查器选定的失败方向（宁可漏，也不要天天红）。
 *   本次事故那个 `--schedule` 的局部别名在**更深的**一层（if → async 箭头），
 *   所以照样会被抓到（有负对照盯着）。
 *
 * @returns {{bound:Set<string>, bodyStart:number, bodyEnd:number}}
 */
export function mainDecls(tokens, { maxDepth = 1 } = {}) {
  const bound = new Set()
  const start = tokens.findIndex(
    (t, i) => t.t === 'id' && t.v === 'function' && tokens[i + 1]?.t === 'id' && tokens[i + 1].v === 'main',
  )
  if (start < 0) return { bound, bodyStart: -1, bodyEnd: -1 }
  const braceAt = tokens.findIndex((t, i) => i > start && t.t === 'p' && t.v === '{')
  const end = matchBracket(tokens, braceAt)
  if (end < 0) return { bound, bodyStart: braceAt, bodyEnd: -1 }
  let depth = 0
  for (let i = braceAt + 1; i < end; i += 1) {
    const t = tokens[i]
    if (t.t === 'p' && ['{', '(', '['].includes(t.v)) {
      depth += 1
      continue
    }
    if (t.t === 'p' && ['}', ')', ']'].includes(t.v)) {
      depth -= 1
      continue
    }
    if (depth > maxDepth) continue
    if (t.t === 'id' && ['const', 'let', 'var', 'function', 'class'].includes(t.v)) {
      collectDeclNames(tokens, i, bound)
    }
  }
  return { bound, bodyStart: braceAt, bodyEnd: end }
}

/** 一段代码里"自己声明的"名字：箭头参数 + 局部 const/let/function。 */
export function localNames(tokens) {
  const bound = new Set()
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]
    // 箭头参数：`(a, b) =>` 或 `a =>`
    if (t.t === 'p' && t.v === ')' && tokens[i + 1]?.v === '=' && tokens[i + 2]?.v === '>') {
      let d = 0
      let open = -1
      for (let j = i; j >= 0; j -= 1) {
        if (tokens[j].t !== 'p') continue
        if (tokens[j].v === ')') d += 1
        else if (tokens[j].v === '(') {
          d -= 1
          if (d === 0) {
            open = j
            break
          }
        }
      }
      for (let j = open + 1; j < i; j += 1) {
        const u = tokens[j]
        // 用 `for..of` 而不是逐字符正则 —— 上个版本这里写过 `'})]'.includes(...)`，
        // 结果 `)` 被当成开括号，深度算反（踩过一次，记在这里）。
        const isPunct = u.t === 'p' && ['{', '[', ',', ':', '=', '...'].includes(u.v)
        if (u.t === 'id' && !isPunct) bound.add(u.v)
      }
      continue
    }
    if (t.t === 'id' && tokens[i + 1]?.v === '=' && tokens[i + 2]?.v === '>') {
      bound.add(t.v)
      continue
    }
    if (t.t === 'id' && ['const', 'let', 'var', 'function', 'class'].includes(t.v)) {
      collectDeclNames(tokens, i, bound)
    }
  }
  return bound
}

/**
 * 在一段 token 里找出"**当成函数调用**的名字"与"全大写常量"。
 * @returns {Set<string>}
 */
export function usedNames(tokens) {
  const used = new Set()
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t.t !== 'id') continue
    if (tokens[i - 1]?.v === '.') continue // 属性访问，不是自由变量
    if (tokens[i - 1]?.v === '?') continue
    if (tokens[i + 1]?.t === 'id' && ['of', 'in'].includes(tokens[i + 1].v)) continue
    // 调用位置
    if (tokens[i + 1]?.t === 'p' && tokens[i + 1].v === '(') {
      used.add(t.v)
      continue
    }
    // 对象字面量里的键 `foo: …` 不是引用
    if (tokens[i + 1]?.t === 'p' && tokens[i + 1].v === ':') continue
    // 全大写常量（FIRES_REL 这类）
    if (/^[A-Z][A-Z0-9_]{1,}$/.test(t.v)) used.add(t.v)
  }
  return used
}

/** 核心判据：这段 token 里"用了但作用域里没有"的名字。 */
export function findUnbound(tokens, bound) {
  const out = new Set()
  for (const n of usedNames(tokens)) {
    if (bound.has(n)) continue
    if (GLOBALS.has(n)) continue
    out.add(n)
  }
  return [...out].sort()
}

/** 从整份源码里抽"路由对象"的 token（`createApiHandler({…})` 的参数）。 */
export function routeObjectTokens(tokens) {
  // ★ 必须找**调用点**，不是 import 子句里那个名字 —— 第一版 `findIndex` 抓到的是
  //   import 那一处，于是往后找的第一个 `(` 是别的东西，配对自然失败（实测）。
  let at = -1
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].t !== 'id' || tokens[i].v !== 'createApiHandler') continue
    if (tokens[i + 1]?.t === 'p' && tokens[i + 1].v === '(') {
      at = i
      break
    }
  }
  if (at < 0) return null
  const paren = at + 1
  const close = matchBracket(tokens, paren)
  if (close < 0) return null
  const brace = paren + 1
  const braceEnd = matchBracket(tokens, brace)
  if (braceEnd < 0 || braceEnd > close) return null
  return { tokens: tokens.slice(brace, braceEnd + 1), start: brace, end: braceEnd }
}

/** 走一遍完整判据（从源码文本到"没定义的名字"）。测试与真实检查共用它。 */
export function checkSource(src) {
  const tokens = tokenize(src)
  const route = routeObjectTokens(tokens)
  if (!route) return { ok: false, why: '找不到 createApiHandler({…})', unbound: [], size: 0 }
  const bound = new Set([...moduleScopeNames(tokens), ...mainDecls(tokens).bound, ...localNames(route.tokens)])
  const unbound = findUnbound(route.tokens, bound)
  return { ok: unbound.length === 0, unbound, size: bound.size, tokens: tokens.length, routeTokens: route.tokens.length }
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== ① 判据自身的正/负对照（先证明它会红，再拿它审真代码）===')
// ══════════════════════════════════════════════════════════════════════════
{
  // 负对照：一个**没定义**的调用必须被抓到
  const bad = checkSource(`
    function main() {
      const handler = createApiHandler({ f: async () => nopeNotDefined({ a: 1 }) })
    }
  `)
  ok(bad.unbound.includes('nopeNotDefined'), '★★ 负对照：没定义的调用**必须**被抓到', bad.unbound.join(','))

  // 负对照 2：全大写常量没定义也要抓到
  const caps = checkSource(`
    function main() {
      const handler = createApiHandler({ f: () => MISSING_REL })
    }
  `)
  ok(caps.unbound.includes('MISSING_REL'), '★★ 负对照：没定义的全大写常量也抓得到')

  // 正对照：全局 / 属性访问 / 作用域里有的名字都不许误报
  //
  // ⚠️ `from` 是拼出来的：`mocks/verify-imports.mjs` 会扫全仓库的
  //    `from '…'` 字面量并核对文件存在 —— 一段**故意不存在的**示例模块路径
  //    会让那道守卫误报（实测踩到）。拼一下就不会被当成真导入。
  const FROM = 'from'
  const good = checkSource(`
    import { known } ${FROM} './known.mjs'
    function main() {
      const handler = createApiHandler({
        f: async (p) => {
          const q = known(p)
          return JSON.stringify({ q, x: Math.max(1, 2), r: obj.method(3), s: process.pid })
        },
      })
    }
  `)
  eq(good.unbound, [], '★★ 正对照：import 进来的、全局的、属性访问的都不误报')

  // 负对照 3：**本次事故的真实形状** —— 嵌套块里的局部别名，在块外被调用
  const shadow = checkSource(`
    function main() {
      if (x) { ;(async () => { const { listTasks: listScheduleTasks } = dep })() }
      const apiHandler = createApiHandler({ list: async () => listScheduleTasks({ ws }) })
    }
  `)
  ok(
    shadow.unbound.includes('listScheduleTasks'),
    '★★★ 负对照（本次事故的**真实形状**）：某个嵌套块里的局部别名，在块外被调用 ⇒ 必须被抓到',
    shadow.unbound.join(','),
  )

  // 正对照 2：别名就在路由对象**同一层** ⇒ 合法，不该被误报
  const sibling = checkSource(`
    function main() {
      if (x) {
        const { listTasks: listScheduleTasks } = dep
        const apiHandler = createApiHandler({ list: async () => listScheduleTasks({ ws }) })
      }
    }
  `)
  ok(
    !sibling.unbound.includes('listScheduleTasks'),
    '★ 正对照：**同一层**声明的别名不误报（真实代码里 `readConfigFromDisk` 就是这一层）',
  )

  // 正对照 3：**前向引用**（在路由对象下面才声明的同层 const）也不该误报
  const forward = checkSource(`
    function main() {
      const apiHandler = createApiHandler({ stop: () => shutdown('api-stop') })
      const shutdown = async (why) => { void why }
    }
  `)
  ok(
    !forward.unbound.includes('shutdown'),
    '★ 正对照：同层的**前向引用**不误报（真实代码里 `shutdown` 就声明在路由对象下面）',
  )
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== ② 审真实的那份路由对象（`src/index.mjs` 的 `createApiHandler({…})`）===')
// ══════════════════════════════════════════════════════════════════════════
{
  const src = readFileSync(join(PKG_ROOT, 'src', 'index.mjs'), 'utf8')
  const tokens = tokenize(src)
  ok(tokens.length > 5000, '① 词法扫描产出了 token（不是空跑）', `${tokens.length} 个`)

  const mod = moduleScopeNames(tokens)
  ok(mod.has('createApiHandler'), '① 模块级名字里能认出 `createApiHandler`（说明 import 子句解析是对的）', `${mod.size} 个模块级名字`)
  ok(mod.has('listScheduleTasks'), '★★ 模块级名字里有 `listScheduleTasks`（定时任务那批别名现在是顶部导入）')

  const route = routeObjectTokens(tokens)
  ok(Boolean(route), '① 找到了 `createApiHandler({…})` 那个对象字面量')

  const result = checkSource(src)
  ok(result.ok, '★★★ 路由对象里用到的名字**都在作用域里**（本次事故的形状：`listScheduleTasks is not defined`）',
    result.ok ? `（在作用域里的名字共 ${result.size} 个）` : `没定义：${result.unbound.join(', ')}`)

  if (route) {
    ok(result.routeTokens > 500, '① 它是"那一个"大对象（不是抓到别的小括号）', `${result.routeTokens} 个 token`)

    const mi = mainDecls(tokens)
    ok(
      mi.bound.has('readConfigFromDisk') && mi.bound.has('shutdown'),
      '① `mainDecls` 同时认得「同层、在路由之前」与「同层、在路由之后」的声明',
      `${mi.bound.size} 个`,
    )

    // ② 反向对照：把定时任务那批别名从"已绑定"里拿掉，必须变红
    //    （证明上面那条 0 不是"检查器什么都没查"）
    const bound = new Set([...mod, ...mi.bound, ...localNames(route.tokens)])
    for (const n of ['listScheduleTasks', 'readFireIndex', 'readLedger', 'readKnownChats', 'dueAt', 'msUntilNext', 'FIRES_REL', 'MISSED_REL', 'writeScheduleTask', 'deleteScheduleTask', 'formatStamp']) {
      bound.delete(n)
    }
    const shouldBeRed = findUnbound(route.tokens, bound)
    ok(
      shouldBeRed.includes('listScheduleTasks') && shouldBeRed.includes('readFireIndex'),
      '★★★ 反向对照：把这批别名从作用域里拿掉 ⇒ **必须变红**（证明上一条不是空断言）',
      shouldBeRed.slice(0, 6).join(','),
    )
  }
}

console.log('')
if (fail === 0) {
  console.log(`🎉 路由作用域守卫：${pass} 项通过`)
  process.exitCode = 0
} else {
  console.log(`❌ 路由作用域守卫：${pass} 项通过、${fail} 项失败`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
