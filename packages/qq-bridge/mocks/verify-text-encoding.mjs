/**
 * **文本编码守卫**（0.2.2 补的，因为真的踩过一次）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它防的是什么（一次真实事故）
 * ══════════════════════════════════════════════════════════════════════════
 * 2026-09-27：一条 PowerShell 命令 `(Get-Content x -Raw) | Set-Content x -Encoding UTF8`
 * 把 `PROJECT.json`（UTF-8，无 BOM）**按系统 ANSI（GBK）读进来**、再按 UTF-8 写回去 ——
 * 中文全变乱码，**而且不报错**。同一条路子还会把输出落成 **UTF-16LE**
 * （`docs/0.2.2-pixiv-adaptation.patch` 早先就中过这个招：`.patch` 存成 UTF-16 等于废掉，
 * 因为 git apply 与所有 diff 工具都按 UTF-8 读）。
 *
 * ★ 为什么必须有一条断言盯着，而不是只在 AGENT.md 里写一句"注意编码"：
 *   这类损坏**不会让任何测试变红** —— 乱码照样是合法 JSON/合法 Markdown，
 *   机器人照常跑，只有人去读那几行字时才发现"这话怎么读不通"。
 *   而"没有断言盯着的纪律"在本项目里等于不存在。
 *
 * ── 判据（三条，都很硬，不靠猜）────────────────────────────────────────────
 *   ① **不许有 UTF-16 BOM**（`FF FE` / `FE FF`）—— 文本文件存成 UTF-16 一律是事故；
 *   ② **不许有 U+FFFD**（替换字符）—— 它是"解码时丢了信息"的痕迹，正常写作不会产生它；
 *   ③ **`.md` / `.mjs` / `.json` / `.patch` / `.txt` 不许有 UTF-8 BOM** ——
 *      这几个格式的读者（git、node、JSON.parse）都不吃 BOM，而 BOM 会让
 *      「按 sha256 比文件」这类做法莫名其妙地不一致。
 *      ⚠️ `.bat` **刻意豁免**：它的 BOM 是 cmd/`chcp 65001` 那套中文处理的历史用法，
 *      且它已经在仓库里、跑得通 —— 我们只**记录**它，不因此判红（要改成无 BOM 得单独验一次）。
 *
 * 用法：node mocks/verify-text-encoding.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 从包根往上两级 = 仓库根（文档在 `<仓库>/docs/` 下，也在守卫范围内）。 */
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(dirname(PKG_ROOT))

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

/** 只看文本类文件；二进制/产物/运行痕迹一律跳过（它们不是"手写的东西"）。 */
const TEXT_EXT = /\.(md|mjs|cjs|js|json|txt|patch|ya?ml|ts|tsx|css|html|ps1)$/i
const SKIP_DIR = new Set([
  'node_modules', 'vendor', 'dist', 'logs', 'cache', '_release', 'snowluma',
  'workspace-qq', '.git', '.tmp-verify', '.tmp-verify-onebot', '.tmp-verify-doctor',
  '.tmp-live-workspace', '.tmp-live-outside', '.tmp-probe-dsh', 'reference',
])

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.tmp')) continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue
      walk(abs, out)
    } else if (TEXT_EXT.test(e.name)) {
      out.push(abs)
    }
  }
  return out
}

/**
 * 三条判据的实现（**只有一处**：扫描与负对照都用它，免得"守卫通过了但判据是错的"）。
 *
 * @returns {{ utf16: boolean, bom: boolean, fffd: number }}
 */
function inspectText(buf) {
  const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  // UTF-16 的内容按 UTF-8 读必然是乱的，再数 U+FFFD 没有意义
  const fffd = utf16 ? 0 : (buf.toString('utf8').match(/\uFFFD/g) ?? []).length
  return { utf16, bom, fffd }
}

section('① 全仓库文本文件：不许 UTF-16、不许 U+FFFD')
{
  const files = walk(REPO_ROOT)
  const utf16 = []
  const fffd = []
  const bom = []
  const batBom = []
  for (const abs of files) {
    const { utf16: is16, bom: isBom, fffd: n } = inspectText(readFileSync(abs))
    const rel = relative(REPO_ROOT, abs)
    if (is16) {
      utf16.push(rel)
      continue
    }
    if (isBom) {
      if (/\.bat$/i.test(rel)) batBom.push(rel)
      else bom.push(rel)
    }
    if (n > 0) fffd.push(`${rel}(${n})`)
  }
  check(
    `★ 扫了 ${files.length} 个文本文件：没有一个是 UTF-16`,
    utf16.length === 0,
    utf16.length ? `UTF-16：${utf16.join(', ')}` : '（0 个）',
  )
  check(
    '★★ 没有文件含 U+FFFD（解码丢信息的痕迹）',
    fffd.length === 0,
    fffd.length ? `${fffd.join(', ')} —— 这就是 2026-09-27 PROJECT.json 事故的形态` : '（0 个）',
  )
  check(
    '★ .md/.mjs/.json/.patch/.txt 都不带 UTF-8 BOM（git/node/JSON.parse 都不吃它）',
    bom.length === 0,
    bom.length ? `带 BOM：${bom.join(', ')}` : '（0 个）',
  )
  if (batBom.length) {
    console.log(`   ℹ️  .bat 带 UTF-8 BOM（历史用法，豁免不判红）：${batBom.join(', ')}`)
  }
}

section('② ★★ 负对照：这套判据真的抓得住那次事故的形态吗')
{
  // ★ 为什么要有这一段：没有它，上面那三条"全绿"完全可能只是**判据写错了**。
  //   本项目对每条守卫都要求"验过牙"（把修复回退掉，测试必须变红）。
  const cases = [
    ['UTF-16LE BOM（事故的第二形态：PowerShell `>` 重定向）', Buffer.from([0xff, 0xfe, 0x64, 0x00]), (r) => r.utf16 === true],
    ['UTF-16BE BOM', Buffer.from([0xfe, 0xff, 0x00, 0x64]), (r) => r.utf16 === true],
    ['U+FFFD（事故的第一形态：GBK 误解码留下的替换字符）', Buffer.from('{"a":"人设\uFFFD库"}', 'utf8'), (r) => r.fffd === 1],
    ['UTF-8 BOM', Buffer.from([0xef, 0xbb, 0xbf, 0x7b]), (r) => r.bom === true],
  ]
  for (const [name, buf, ok] of cases) {
    const r = inspectText(buf)
    check(`★ 抓得住：${name}`, ok(r), JSON.stringify(r))
  }
  check('正对照：正常 UTF-8 中文一个字都不误报', (() => {
    const r = inspectText(Buffer.from('{"note":"人设库 · 一个文件一套人设（0.2.2）"}', 'utf8'))
    return r.utf16 === false && r.bom === false && r.fffd === 0
  })())
}

section('③ 事故现场的两个文件：按最严口径单独盯一遍')
{
  // 这两个文件正是那次事故的受害者，各加一条**指名**断言：
  // 将来有人再拿 PowerShell 重写一遍，报错里会直接出现文件名。
  const proj = join(PKG_ROOT, 'PROJECT.json')
  const projText = readFileSync(proj, 'utf8')
  check('★ PROJECT.json 是合法 JSON 且不含 U+FFFD', (() => {
    if (projText.includes('\uFFFD')) return false
    try {
      JSON.parse(projText)
      return true
    } catch {
      return false
    }
  })(), '（它就是被 PowerShell 重编码写坏过的那份）')

  const patch = join(REPO_ROOT, 'docs', '0.2.2-pixiv-adaptation.patch')
  const pb = readFileSync(patch)
  const pt = pb.toString('utf8')
  check('★ pixiv 迁移 patch 是 UTF-8（没有 NUL 字节 / 不是 UTF-16）',
    !(pb[0] === 0xff && pb[1] === 0xfe) && !pb.includes(0x00) && pt.startsWith('diff --git '),
    `头 16 字节：${JSON.stringify(pt.slice(0, 16))}`)
  check('★ 那份 patch 的 hunk 数没变（31 个）—— 重编码不该改内容',
    (pt.match(/^@@/gm) ?? []).length === 31,
    `实际 ${(pt.match(/^@@/gm) ?? []).length} 个`)
}

console.log('')
if (failed > 0) {
  console.log(`⚠️ ${failed} 项失败 / ${passed} 项通过`)
  console.log('   修法：不要用 PowerShell 的 Get-Content/Set-Content 改这些文件；')
  console.log('   用仓库的文件工具，或 git --output=<file> / .NET 显式编码。详见 AGENT.md §6.6。')
  process.exitCode = 1
} else {
  console.log(`✅ 文本编码守卫全部通过（${passed} 项）`)
}
