/**
 * 回退到 0.2.3 之后，清掉 **git 管不到**的那些 0.2.4 产物。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════════════
 * `git read-tree`/`revert` 只能还原**被跟踪的文件**。0.2.4 留下的这些东西从来没进 git，
 * 所以回退之后**它们仍在磁盘上**，而其中最要命的一条是：
 *
 *     _release/InteractBot-0.2.4-win-x64-r4/app/InteractBot.exe   ← 双击它跑的是 **0.2.4**
 *
 * 也就是说"代码回退了、你双击的那个 exe 没回退"—— 不说清就一定会有人被这个坑到。
 * 这个脚本把下面几类清掉（都是 0.2.4 专属、0.2.3 用不到的）：
 *
 *   · `.build-desktop/`            exe 构建产物（每次构建一个 pack-<时间戳> 目录，~324 MB/份）
 *   · `desktop/node_modules`       Electron 工具链（~72 MB；desktop/ 的源码已被 git 删掉）
 *   · `desktop/.npm-cache`         npm 缓存 + 下下来的 Electron 运行时 zip（~200 MB）
 *   · `desktop/install.log`        构建残留
 *   · `_release/InteractBot-0.2.4-*`  0.2.4 的发布包与残留（**不会**动 0.1.0 / 0.2.0）
 *
 * ★ 为什么放在 `docs/` 而不是 `scripts/`：回退后的 0.2.3 树里**没有** `scripts/` 目录
 *   （那是 0.2.4 才建的）。放这里才找得到。
 *
 * ★★ 两条纪律（都来自 0.2.4 的真事故）：
 *   ① **删目录之前先确认删得掉**：Windows 上有进程/扫描器占着 `default_app.asar` 时
 *      删除会抛 EPERM，而**已经删掉的那一半不会回来** —— 0.2.4 收尾时因此把两个发布包
 *      削成 133/134 个文件（正常 209），比"没删"更坏。所以这里**先改名到
 *      `.residue-deleting-<时间戳>`**：改名成功就说明这个目录能让位，删不掉也只是留个
 *      名字很显眼的残留，不会再和"哪一份能用"混淆。
 *   ② **老版本一律不动**：`_release/InteractBot-0.1.0-*` 与 `-0.2.0-*` 是留作对照的。
 *
 * 用法：
 *   node docs/rollback-0.2.4-clean.mjs            # 只报告（默认，不删任何东西）
 *   node docs/rollback-0.2.4-clean.mjs --apply    # 真删
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
// ⚠️ 目标之间**不能互相包含**：第一版同时列了 `desktop/node_modules`、`desktop/.npm-cache`
//    和它们的父目录 `desktop/`，于是同一批文件被数了两次（589 MB 报成 589+396+192），
//    真删时还会对已经删掉的路径再删一次。现在按"整目录一次删"来列。
const targets = []

// ① 0.2.4 的构建产物与 Electron 工具链（0.2.3 完全用不到）
for (const rel of ['.build-desktop', 'desktop']) {
  const abs = join(PKG_ROOT, rel)
  if (existsSync(abs)) targets.push({ label: `packages/qq-bridge/${rel}/`, abs })
}

// ② 0.2.4 的发布包与残留（**只清 0.2.4**，老版本不动）
if (existsSync(RELEASE)) {
  for (const e of readdirSync(RELEASE, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (!/^InteractBot-0\.2\.4-/.test(e.name)) continue
    targets.push({ label: `_release/${e.name}/`, abs: join(RELEASE, e.name) })
  }
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
console.log('')
console.log('回退到 0.2.3 之后的清理（git 管不到的那些 0.2.4 产物）')
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
  console.log(`  ${t.label.padEnd(48)} ${String(m.files).padStart(6)} 文件 ${m.mb.toFixed(1).padStart(8)} MB`)
}
console.log('')
console.log(`  合计约 ${totalMb.toFixed(0)} MB`)

// 明确说清"老版本不动"
if (existsSync(RELEASE)) {
  const kept = readdirSync(RELEASE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !/^InteractBot-0\.2\.4-/.test(e.name))
    .map((e) => e.name)
  if (kept.length) {
    console.log('')
    console.log(`  （不动：${kept.join('、')} —— 老版本留作对照）`)
  }
}

if (!APPLY) {
  console.log('')
  console.log('  要真删：node docs/rollback-0.2.4-clean.mjs --apply')
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
  console.log('🎉 清理完成（0.2.3 的形态已经干净）')
  process.exit(0)
}
console.log(`⚠️ 有 ${failed} 项没清掉（见上）—— 重启后再跑一次这个脚本即可`)
process.exit(1)
