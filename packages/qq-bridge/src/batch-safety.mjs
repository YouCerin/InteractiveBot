/**
 * `.bat` 启动器的静态安全检查（纯函数，只读文本，**不执行**任何批处理）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（2026-10-03 实机测试报告 BUG-4）
 * ══════════════════════════════════════════════════════════════════════════
 * `start.bat` 里曾有这样一行（在 `if not "%EXITCODE%"=="0" (` 的**块内**）：
 *
 *     echo [!] Could not start (exit %EXITCODE%) -- see the message above.
 *
 * 它让启动器**在成功路径上也直接崩掉** —— 不是"错误提示显示得不完整"，而是
 * 「双击 start.bat，窗口闪一下就没了，什么都看不到」。本机 cmd.exe 实测
 * （把同样的结构写成临时 .bat 再跑，逐条记录退出码）：
 *
 *   ── 块内（行开始时就处在 `if ( … )` 里）──────────────────────────────
 *   · `echo A (paren) B`                 → `B was unexpected at this time.`，退出码 255
 *   · `echo A ) B`                       → 255
 *   · `if 2==2 (` / `    echo A (x) B` （嵌套块）→ 255
 *   · `) echo Y`（块尾 `)` 后面还跟着命令）→ `echo was unexpected at this time.`，255
 *   · `echo A (B`（只有左括号）           → 正常
 *   · `echo X (hm`（行尾左括号）          → 正常 —— 它**不开**新块
 *   · `if 2==2 ( echo Y )`（单行 if）     → 正常
 *   · `for %%i in (a b) do echo %%i`      → 正常
 *   · `))`（一行关两层块）                → 正常
 *   · `) & echo Y`（块尾接 `&` 再起命令） → 正常
 *   · `echo A "(paren)" B`（双引号内）    → 正常
 *   · `echo A ^(paren^) B`（`^` 转义）    → 正常
 *   · `rem comment (paren) here`          → 正常 —— cmd **不**看 rem 行里的括号
 *
 *   ── 顶层（不在任何块里）──────────────────────────────────────────────
 *   · `echo A (paren) B` / `echo A ) B` / `echo A (B` / 单独一行 `)` → **全部正常**
 *
 *   ── 关键结论 ─────────────────────────────────────────────────────────
 *   ① 危险只发生在**行开始时已经在块内**的行上；顶层的括号 cmd 一律当普通字符。
 *   ② 致命的是那种"非行首的 `)`，且它后面还有内容" —— 它会**提前闭合** `if (` 块，
 *      剩下的内容被当成新命令。这条与 `if` 条件真假**无关**（解析期就崩了，
 *      `else` 分支一个字都不会执行）—— 所以"成功路径不受影响"是错的。
 *   ③ rem 行、双引号内、`^` 转义过的括号都不算数。
 *
 * ⚠️ 边界（写清楚，免得下一个人以为它能证明"这个 bat 一定跑得通"）：
 *   它不是批处理解析器，只盯上面实测出来的那几类崩法。`%VAR%` 展开后才出现的
 *   括号（变量里存了 `)`）它看不见 —— 那种情况只能靠"别把括号存进变量"的约定。
 *   反过来，为**不误报**，它对上面实测为正常的所有写法一律放行（含单行 `if`、
 *   `for`、`))`、`) &`）。
 */

/** 行尾是否是一个"会开块"的 `(`（`if … (` / `) else (` 这种）。 */
function opensBlock(trimmed) {
  if (!/(^|[^^])\($/.test(trimmed)) return false // 末尾不是 `(`，或那个 `(` 是 `^(` 转义
  const firstToken = (/^([A-Za-z_][\w.]*)/.exec(trimmed)?.[1] ?? '').toLowerCase()
  // `if`/`for` 的块头，或 `) else (` / `else (` 这种接续写法
  return firstToken === 'if' || firstToken === 'for' || firstToken === 'else' || trimmed.startsWith(')')
}

/** `)` 后面剩下的内容是否属于"实测正常"的几种写法。 */
function tailIsBenign(rest) {
  if (!rest.trim()) return true // 干净的块尾
  if (/^[\s)]*$/.test(rest)) return true // `))`：一行关掉多层块
  if (/^\s*else\b/i.test(rest)) return true // `) else (`
  if (/^\s*[&|]/.test(rest)) return true // `) & echo Y`（实测正常）
  return false
}

/**
 * 扫一份 `.bat` 文本，找出"会让 cmd 提前闭合括号块"的行。
 *
 * @param {string} text `.bat` 文件内容
 * @returns {{line: number, text: string, why: string}[]} 每处隐患（行号从 1 开始）
 */
export function findBatchParenHazards(text) {
  const hazards = []
  const lines = String(text ?? '').split(/\r?\n/)
  let depth = 0

  lines.forEach((raw, index) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    // cmd 不统计 rem 行里的括号（实测）—— 所以注释里可以放心写 `if (...)` 这类说明。
    if (/^rem\b/i.test(trimmed)) return

    const depthAtLineStart = depth
    const inBlock = depthAtLineStart > 0

    // ── 结构：行首的 `)`（可能连续多个）关块，行尾的 `(` 开块 ──────────────
    let i = raw.search(/\S/)
    let leadingClosers = 0
    while (i >= 0 && raw[i] === ')') {
      leadingClosers += 1
      i += 1
    }
    const opener = opensBlock(trimmed)
    depth = Math.max(0, depthAtLineStart - leadingClosers + (opener ? 1 : 0))

    if (!inBlock) return // 顶层：实测括号一律是普通字符，不报

    // `if`/`for` 的**单行**写法（`for %%i in (a b) do …`、`if 2==2 ( echo Y )`）里
    // 括号是 cmd 的正常语法 —— 实测在块内也正常，所以括号配平时整行豁免。
    const firstToken = (/^([A-Za-z_][\w.]*)/.exec(trimmed)?.[1] ?? '').toLowerCase()
    const balancedOneLiner = (() => {
      if (firstToken !== 'if' && firstToken !== 'for') return false
      let q = false
      let opens = 0
      let closes = 0
      for (let k = 0; k < raw.length; k += 1) {
        const ch = raw[k]
        if (ch === '^') {
          k += 1
          continue
        }
        if (ch === '"') {
          q = !q
          continue
        }
        if (q) continue
        if (ch === '(') opens += 1
        else if (ch === ')') closes += 1
      }
      return opens > 0 && opens === closes
    })()

    // ── 行首 `)` 之后的内容：`) echo Y` 会崩（实测），`) else (` / `) & …` 不会 ──
    if (leadingClosers > 0 && !tailIsBenign(raw.slice(i))) {
      hazards.push({
        line: index + 1,
        text: trimmed,
        why:
          '块尾 `)` 后面还跟着命令 —— cmd 会报 "… was unexpected at this time." 并以 255 中止。'
          + '（若要在一行里接命令，用 `) & echo …`）',
      })
    }
    if (balancedOneLiner) return

    // ── 行内其它（非行首）的 `)`：后面还有内容就是提前闭合 ────────────────
    let inQuotes = false
    for (let k = i; k < raw.length; k += 1) {
      const ch = raw[k]
      if (ch === '^') {
        k += 1 // `^x` 是转义：cmd 去掉 ^、把 x 当普通字符
        continue
      }
      if (ch === '"') {
        inQuotes = !inQuotes
        continue
      }
      if (inQuotes) continue
      if (ch !== ')') continue
      const rest = raw.slice(k + 1)
      if (tailIsBenign(rest)) continue
      hazards.push({
        line: index + 1,
        text: trimmed,
        why:
          '括号块内的 `)` 后面还有内容 —— 它会**提前闭合** `if (` 块，剩下的内容被当成新命令，'
          + 'cmd 直接以退出码 255 中止（与 if 条件真假无关，连 else 分支都不会执行）',
      })
    }
  })

  return hazards
}

/** 把一处隐患渲染成一行给人/给日志看的话（发布包验收与测试共用一份文案）。 */
export function batchHazardMessage(rel, hazard) {
  return (
    `${rel}:${hazard.line} 的 \`)\` 会让 cmd 提前闭合括号块（${hazard.why}）`
    + ` —— 修法：删掉括号，或写成 \`^\\)\`；行内容：${hazard.text}`
  )
}
