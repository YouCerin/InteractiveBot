/**
 * 回退到 0.2.3 之后，清掉 **git 管不到**的那些 0.2.5（独立 UI / 桌面壳线）产物。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════════════
 * `git checkout` / `read-tree` 只能还原**被跟踪的文件**。0.2.5 留下的 Electron 工具链、
 * 构建产物与发布包**从来没进 git**（都已 gitignore），所以回退之后**它们仍在磁盘上**，
 * 而其中最要命的一条是：
 *
 *     _release/InteractBot-0.2.5-win-x64/app/InteractBot.exe   ← 双击它跑的是 **0.2.5**
 *
 * 也就是说"代码回退了、你双击的那个 exe 没回退"—— 不说清就一定会有人被这个坑到。
 * 本脚本清掉下面这些（全是 0.2.5 专属、0.2.3 用不到的）：
 *
 *   · `packages/qq-bridge/.build-desktop/`        exe 构建产物（约 324 MB）
 *   · `packages/qq-bridge/desktop/`               只剩未跟踪的 node_modules + .npm-cache（约 400 MB）
 *   · `packages/qq-bridge/cache/desktop-stage/`   打包用的 stage 目录（**只删这一个子目录**）
 *   · `_release/InteractBot-0.2.5-*`              0.2.5 的发布包与 zip
 *   · `_release/InteractBot-0.2.4-win-x64.zip`    上一次回退**漏掉**的 zip（那份清单只列目录、不含 .zip）
 *
 * ★★ 两条纪律（都来自真事故）：
 *   ① **删目录之前先确认删得掉**：Windows 上有进程/扫描器占着 `default_app.asar` 时删除会抛 EPERM，
 *      而**已经删掉的那一半不会回来** —— 0.2.4 收尾时因此把两个发布包削成 133/134 个文件（正常 209），
 *      比"没删"更坏。所以这里**先改名到 `.residue-deleting-<时间戳>`**：改名成功就说明这个目录能让位，
 *      删不掉也只是留个名字很显眼的残留，不会再和"哪一份能用"混淆。
 *   ② **老版本一律不动**：`_release/InteractBot-0.1.0-*` 与 `-0.2.0-*` 是留作对照的。
 *
 * ⚠️ 它**不动** `packages/qq-bridge/cache/` 整体：那里面还有 MCP 的 token 缓存（运行期数据）。
 *
 * 用法：
 *   node docs/rollback-0.2.5-clean.mjs            # 只报告（默认，不删任何东西）
 *   node docs/rollback-0.2.5-clean.mjs --apply    # 真删
 */

import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PKG_ROOT = join(REPO_ROOT, 'packages', 'qq-bridge')
const RELEASE = join(REPO_ROOT, '_release')

const APPLY = process.argv.includes('--apply')

/** 数一个目录的文件数与字节数（读不动就如实标出来 —— 那通常意味着被占用）。 */
function measure (p) {
  let files = 0
  let bytes = 0
  try {
    const st = statSync(p)
    if (st.isFile()) return { files: 1, mb: st.size / 1024 / 1024 }
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const q = join(d, e.name)
        if (e.isDirectory()) walk(q)
        else if (e.isFile()) {
          files += 1
          try {
            bytes += statSync(q).size
          } catch {
            /* 单个文件读不到不影响整体清点 */
          }
        }
      }
    }
    walk(p)
    return { files, mb: bytes / 1024 / 1024 }
  } catch {
    return { files: -1, mb: 0 }
  }
}

// ── 要清的目标 ───────────────────────────────────────────────────────────────
//
// ⚠️ 目标之间**不能互相包含**：0.2.4 的第一版同时列了 `desktop/node_modules`、`desktop/.npm-cache`
//    和它们的父目录 `desktop/`，于是同一批文件被数了两次、真删时还会对已删路径再删一次。
//    这里按"整目录一次删"来列。
const targets = []

for (const rel of ['.build-desktop', 'desktop', join('cache', 'desktop-stage')]) {
  const abs = join(PKG_ROOT, rel)
  if (existsSync(abs)) targets.push({ label: `packages/qq-bridge/${rel.split('\\').join('/')}/`, abs })
}

if (existsSync(RELEASE)) {
  for (const e of readdirSync(RELEASE, { withFileTypes: true })) {
    // 0.2.5 的目录与 zip，外加 0.2.4 那个漏掉的 zip（**只点这两类名，老版本一律不动**）
    if (/^InteractBot-0\.2\.5-/.test(e.name) || e.name === 'InteractBot-0.2.4-win-x64.zip') {
      targets.push({ label: `_release/${e.name}`, abs: join(RELEASE, e.name) })
    }
  }
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
console.log('')
console.log('清掉 0.2.5（独立 UI / 桌面壳线）留在磁盘上的产物 —— git 管不到的那些')
console.log(`  仓库：${REPO_ROOT}`)
console.log(`  模式：${APPLY ? '⚠️ --apply：真删' : '只报告（默认）'}`)
console.log('')

if (targets.length === 0) {
  console.log('  没有需要清理的东西（已经干净了）')
  process.exit(0)
}

let totalMb = 0
for (const t of targets) {
  const m = measure(t.abs)
  totalMb += Math.max(0, m.mb)
  console.log(`  ${t.label.padEnd(52)} ${String(m.files).padStart(6)} 文件 ${m.mb.toFixed(1).padStart(8)} MB`)
}
console.log('')
console.log(`  合计约 ${totalMb.toFixed(0)} MB`)

// 明确说清"老版本不动"
if (existsSync(RELEASE)) {
  const kept = readdirSync(RELEASE, { withFileTypes: true })
    .filter((e) => !/^InteractBot-0\.2\.5-/.test(e.name) && e.name !== 'InteractBot-0.2.4-win-x64.zip')
    .map((e) => e.name)
  if (kept.length) {
    console.log('')
    console.log(`  （不动：${kept.join('、')} —— 老版本留作对照）`)
  }
}

if (!APPLY) {
  console.log('')
  console.log('  要真删：node docs/rollback-0.2.5-clean.mjs --apply')
  console.log('  ⚠️ 若报 EPERM：重启一次再跑（Defender / 搜索索引器 / 刚退出的 Electron 会占着文件）')
  process.exit(0)
}

// ── 真删：先改名，再删 ───────────────────────────────────────────────────────
console.log('')
let failed = 0
for (const t of targets) {
  const trash = `${t.abs}.residue-deleting-${Date.now()}`
  try {
    renameSync(t.abs, trash)
  } catch (error) {
    failed += 1
    console.log(`  ❌ 连改名都不行 ${t.label}（${error?.code ?? error?.message}）—— **一个字都没动**，这是安全的`)
    continue
  }
  try {
    rmSync(trash, { recursive: true, force: true })
    console.log(`  ✅ 已删 ${t.label}`)
  } catch (error) {
    failed += 1
    console.log(
      `  ⚠️ ${t.label} 已改名成 ${trash.split(/[\\/]/).pop()} 但删不掉（${error?.code ?? error?.message}）\n` +
        '     ⇒ 名字已让开（不会再有"该用哪一份"的歧义），重启后删掉那个 .residue-deleting-* 即可',
    )
  }
}

console.log('')
if (failed === 0) {
  console.log('🎉 清理完成（磁盘上不再有 0.2.5 的产物）')
  process.exit(0)
}
console.log(`⚠️ 有 ${failed} 项没清掉（见上）—— 重启后再跑一次这个脚本即可`)
process.exit(1)
