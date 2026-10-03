/**
 * 抽出源码里的**包内路径引用**，好让发布验收能一次性消灭"漏带文件"这一整类故障。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（2026-10-03 实机测试报告 BUG-1 的建议 ②，报告称"价值最高"）
 * ══════════════════════════════════════════════════════════════════════════
 * 那次事故的形状：`src/ui-status.mjs` 在**模块顶层**
 * `require(join(PKG_ROOT, 'scripts', 'ui-build-stamp.cjs'))`，而发布包按设计
 * **不含 `scripts/`** ⇒ 用户机器上 `start.bat` 直接
 * `Cannot find module 'C:\InteractiveBot\scripts\ui-build-stamp.cjs'`，**桥接从未启动**。
 * 更坏的是 `start.bat --check` 不 import 那个模块，所以自检显示"✅ 通过" ——
 * **先自检全绿、再启动就崩**，而崩的位置（界面构建溯源）与用户想解决的问题毫无关系。
 *
 * 这类缺陷的共同点：
 *   · 静态清单（该有的文件在不在）**表达不出来** —— 缺的是"运行时要用到的包内路径"；
 *   · 只在**用户机器上**暴露（开发机里那个文件就在那儿）；
 *   · 一条断言就能消灭**整类**问题，而不是逐个补文件。
 *
 * 所以这里做一件很窄的事：把 `require(join(PKG_ROOT, …))` / `join(DIRS.x, …)` /
 * 相对 `import('…')` 里的**字面量**路径抽出来，由调用方逐个核对存在性。
 *
 * ── 刻意不做的（写清楚，免得被当成"全都覆盖了"）────────────────────────
 *   · **变量拼接**（`join(PKG_ROOT, name)`、`join(PKG_ROOT, ...parts)`）抽不出来 ——
 *     这些会被计入 `skipped` 并**报出数量**，不静默当成"没问题"。
 *   · 不做 AST 解析：用的是正则，只认那几种固定写法。够用即可（它的价值在于**这一类**
 *     故障，不在于通用性）；误报的代价是发布被拦一次，漏报的代价是用户机器上起不来，
 *     所以判据**宁可窄、不可宽**。
 *   · 不检查 `node_modules` 里的包（那是 vendor/node_modules 的清单管辖范围）。
 */

import { posix } from 'node:path'

/** `join(PKG_ROOT, 'a', 'b')` / `join(DIRS.logs, 'x')` 这类字面量拼接。 */
const JOIN_LITERAL_RE =
  /join\(\s*(PKG_ROOT|DIRS\s*\.\s*([A-Za-z_$][\w$]*))((?:\s*,\s*(?:'[^']*'|"[^"]*"))+)\s*\)/g

/** 相对说明符：动态 `import('./a.mjs')` / `require('./a.cjs')`。 */
const RELATIVE_CALL_RE = /\b(?:import|require)\s*\(\s*(['"])(\.[^'"]*)\1\s*\)/g

/** 静态 `import … from './a.mjs'` / `export … from './a.mjs'`。 */
const STATIC_FROM_RE = /^[ \t]*(?:import|export)\b[^'"\n]*?\bfrom\s*(['"])(\.[^'"]*)\1/gm

/** 把 `join(...)` 里那串字面量拆成路径片段。 */
function literalParts(argText) {
  const parts = []
  const re = /,\s*(?:'([^']*)'|"([^"]*)")/g
  let m
  while ((m = re.exec(argText)) !== null) parts.push(m[1] ?? m[2])
  return parts
}

/**
 * 把注释抹掉（用空格替换、**保留换行**，这样行号不会漂）。
 *
 * 为什么必须做：注释里会正当地写出"以前是这么 require 的"（例如 `src/ui-status.mjs`
 * 的事故记录、以及本模块自己的 JSDoc 示例）。那些引用**运行期不会执行**，
 * 当成真引用就是误报 —— 而这道门的价值全在"报出来的都是真的"。
 *
 * ★ 为什么是**按行**处理，而不是一个字符级状态机：第一版写了状态机，结果被
 *   **正则字面量**打穿 —— `/'[^']*'/` 里有**三个**单引号，状态机以为进了字符串、
 *   于是整个文件后半段的注释都没被抹掉（自测当场抓到：本文件自己的 JSDoc 示例
 *   被当成了真引用）。按行处理时那种"跨行的引号状态"不存在，代价是
 *   `const s = "http://x" // 注释` 这种行尾注释不会（也不敢）被抹掉 —— 宁可漏抹一处，
 *   也不要因为猜错引号而把真代码当注释抹掉。
 */
export function stripComments(text) {
  let inBlock = false
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      const t = line.trim()
      if (inBlock) {
        if (t.includes('*/')) inBlock = false
        return ' '.repeat(line.length)
      }
      // 整行就是注释（`// …` / `/* … */` / `/** …`）
      if (t.startsWith('//') || t.startsWith('/*')) {
        if (t.startsWith('/*') && !t.includes('*/')) inBlock = true
        return ' '.repeat(line.length)
      }
      // 行内出现的块注释起点
      const bi = line.indexOf('/*')
      if (bi >= 0) {
        const end = line.indexOf('*/', bi)
        if (end >= 0) return line.slice(0, bi) + ' '.repeat(line.length - bi)
        inBlock = true
        return line.slice(0, bi)
      }
      // 行尾 `//`：只在这一行**没有引号**时才算注释（有引号时可能是字符串里的 URL）
      const ci = line.indexOf('//')
      if (ci > 0) {
        const before = line.slice(0, ci)
        if (!/['"`]/.test(before)) return before + ' '.repeat(line.length - before.length)
      }
      return line
    })
    .join('\n')
}

/**
 * 扫一份源码文本，抽出它引用的**包内**路径。
 *
 * @param {object} opts
 * @param {string} opts.text     源码内容
 * @param {string} opts.fileRel  该文件相对包根的路径（统一用 `/`），用来解析相对说明符
 * @param {(key: string) => string|null} [opts.dirOf] `DIRS.<key>` → 包内相对目录（不传则跳过这类引用）
 * @returns {{refs: {rel: string, spec: string, line: number, kind: string}[], skipped: number}}
 *   `skipped` = 看见了但**没法静态判定**的拼接（例如变量），调用方应当把它报出来
 */
export function scanSourceForPackageRefs({ text, fileRel, dirOf = null } = {}) {
  const raw = String(text ?? '')
  const src = stripComments(raw)
  const refs = []
  const lineOf = (index) => raw.slice(0, index).split('\n').length

  // ① join(PKG_ROOT|DIRS.x, '...', '...')
  for (const m of src.matchAll(JOIN_LITERAL_RE)) {
    const dirKey = m[2] ?? null
    if (dirKey) {
      if (typeof dirOf !== 'function') continue
      const base = dirOf(dirKey)
      if (!base) continue
      const parts = literalParts(m[0])
      refs.push({
        rel: posix.normalize(posix.join(base, ...parts)),
        spec: m[0],
        line: lineOf(m.index),
        kind: `DIRS.${dirKey}`,
      })
      continue
    }
    const parts = literalParts(m[0])
    if (parts.length === 0) continue
    // `join(PKG_ROOT)` 单独一个参数没有意义，跳过
    refs.push({
      rel: posix.normalize(posix.join(...parts)),
      spec: m[0],
      line: lineOf(m.index),
      kind: 'PKG_ROOT',
    })
  }

  // ② 相对说明符（动态 import / require）
  for (const m of src.matchAll(RELATIVE_CALL_RE)) {
    const spec = m[2]
    refs.push({
      rel: posix.normalize(posix.join(posix.dirname(fileRel), spec)),
      spec,
      line: lineOf(m.index),
      kind: 'relative-call',
    })
  }

  // ③ 静态 import … from './x'
  for (const m of src.matchAll(STATIC_FROM_RE)) {
    const spec = m[2]
    refs.push({
      rel: posix.normalize(posix.join(posix.dirname(fileRel), spec)),
      spec,
      line: lineOf(m.index),
      kind: 'relative-import',
    })
  }

  // ④ 看见 `join(…PKG_ROOT/DIRS.x…)` 但参数里**没有字面量** → 数出来，别假装没看见
  //    （做法：把每个 join(...) 的参数文本抠出来，有引号的已被 ① 处理，没引号的就是判不了的那种）
  let skipped = 0
  for (const m of src.matchAll(/join\(/g)) {
    const open = m.index + m[0].length - 1
    let depth = 1
    let i = open + 1
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth += 1
      else if (src[i] === ')') depth -= 1
      i += 1
    }
    const args = src.slice(open + 1, i - 1)
    if (!/(?:PKG_ROOT|DIRS\s*\.)/.test(args)) continue // 不是"包内基址"的 join，不归这条门管
    if (/['"]/.test(args)) continue // 有字面量 → 已在 ① 里当成真引用处理
    skipped += 1
  }

  return { refs, skipped }
}

/**
 * 只断言"**代码/数据模块**"类的引用。
 *
 * 为什么不是"所有引用都要在包里"：`join(PKG_ROOT, 'logs')`（目录）、
 * `join(DIRS.logs, 'usage.jsonl')`（运行期生成）、`config-ui/dist`（目录）
 * 这些**本来就不该在包里**（或者不是"文件在不在"这个维度上的事）。
 * 把它们也断言一遍，等于让这道门天天误报 —— 误报的代价是"下次没人看它"。
 * 而漏报的那一类恰恰是**代码要 require/import 的模块文件**，也就是 BUG-1 的形态。
 */
export const DEFAULT_ASSERT_EXTS = ['.mjs', '.cjs', '.js', '.json']

/**
 * 明确知道"不该在包里/不必存在"的引用。
 *
 * ★ 每一条都要写清理由。**不要把它当成消音器**：加一条前先问"这是设计如此，
 *   还是我在掩盖一个真问题"。列表越短越好。
 */
export const DEFAULT_EXEMPT = [
  {
    prefix: 'vendor/dsh/',
    why: 'DSH 本属运行环境（275MB），刻意不随包分发（见 RELEASE.md 第 1 节）',
  },
  {
    prefix: 'vendor/snowluma/',
    why: 'SnowLuma 的许可证不允许随第三方安装包分发（EULA §5.4 / LICENSE §5）',
  },
  {
    prefix: 'vendor/__vendor_anchor__.cjs',
    why: 'createRequire 的锚点：只需要"路径"参与解析，文件本身不必存在',
  },
]

/**
 * 在一组"包里有哪些文件"的事实上核对一批源码。
 *
 * @param {object} opts
 * @param {string[]} opts.files     要扫的包内相对路径（通常只给 `src/**` 与 `mcp/**`）
 * @param {(rel: string) => string} opts.read  读文件内容
 * @param {(rel: string) => boolean} opts.exists 该包内路径是否存在（**在包里**，不是在开发机上）
 * @param {(key: string) => string|null} [opts.dirOf]
 * @param {string[]} [opts.assertExts] 只断言这些扩展名（默认 {@link DEFAULT_ASSERT_EXTS}）
 * @param {{prefix: string, why: string}[]} [opts.exempt] 豁免前缀（默认 {@link DEFAULT_EXEMPT}）
 * @returns {{checked: number, refs: number, skipped: number, asserted: number,
 *            notAsserted: number, exempted: number, missing: string[]}}
 *   `missing` 每条形如 `src/ui-status.mjs:37 → scripts/ui-build-stamp.cjs`
 */
export function auditPackageRefs({
  files,
  read,
  exists,
  dirOf = null,
  assertExts = DEFAULT_ASSERT_EXTS,
  exempt = DEFAULT_EXEMPT,
} = {}) {
  const missing = []
  let refs = 0
  let skipped = 0
  let asserted = 0
  let notAsserted = 0
  let exempted = 0
  for (const rel of files) {
    let text
    try {
      text = read(rel)
    } catch {
      continue
    }
    const scan = scanSourceForPackageRefs({ text, fileRel: rel, dirOf })
    refs += scan.refs.length
    skipped += scan.skipped
    for (const r of scan.refs) {
      // 包外相对路径（`../x`）与目录（没有扩展名）不归这条门管
      if (r.rel.startsWith('..')) continue
      const ext = posix.extname(r.rel).toLowerCase()
      if (!assertExts.includes(ext)) {
        notAsserted += 1
        continue
      }
      if (exempt.some((e) => r.rel === e.prefix || r.rel.startsWith(e.prefix))) {
        exempted += 1
        continue
      }
      asserted += 1
      if (!exists(r.rel)) missing.push(`${rel}:${r.line} → ${r.rel}`)
    }
  }
  return { checked: files.length, refs, skipped, asserted, notAsserted, exempted, missing }
}
