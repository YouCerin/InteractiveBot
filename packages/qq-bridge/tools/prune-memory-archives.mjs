/**
 * 清理记忆目录里的**旧备份与旧快照**（0.3.3）。
 *
 * ```bash
 * node tools/prune-memory-archives.mjs             # 先看会删什么（默认 dry-run）
 * node tools/prune-memory-archives.mjs --apply      # 真的删
 * ```
 *
 * ── 两类文件、两条不同的规则 ────────────────────────────────────────────────
 *   · `memory/.backups/`：自动备份（覆盖写之前留的那一份）。
 *     **超过 30 天**的删掉 —— 它们的用途是"刚写错时能退回去"，不是历史归档。
 *   · `memory/.snapshots/`：篡改检测用的快照（**当前版本**必须留着，否则下一次读记忆
 *     会被当成"绕过桥接的改动"回滚）。所以**只保留最近 20 份**，按 mtime 排序。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────────
 *   1. **默认 dry-run**（只打印，不动手）；
 *   2. **只删这两类文件**，其它一律不碰（`.migrated/` 是归档证据、记忆正文更不能动）；
 *   3. 删完**如实报数**（删了几个、留了几个、省了多少字节）。
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { PKG_ROOT } from '../src/local.mjs'
import { normalizeConfig } from '../src/config.mjs'
import { readFileSync } from 'node:fs'

const apply = process.argv.includes('--apply')
const KEEP_SNAPSHOTS = 20
const BACKUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const cfgPath = join(PKG_ROOT, 'config.json')
if (!existsSync(cfgPath)) {
  console.error(`❌ 找不到 ${cfgPath}`)
  process.exit(1)
}
const config = normalizeConfig(JSON.parse(readFileSync(cfgPath, 'utf8')))
const workspace = String(config.dsh?.workspace ?? '')
if (!workspace) {
  console.error('❌ 配置里没有 dsh.workspace')
  process.exit(1)
}
const root = isAbsolute(workspace) ? workspace : join(PKG_ROOT, workspace)
const memDir = join(root, 'memory')

/** 列出目录里的普通文件（含 mtime/size），目录不存在就返回空。 */
function entries(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const p = join(dir, e.name)
      const st = statSync(p)
      return { name: e.name, path: p, at: st.mtimeMs, size: st.size }
    })
}

const actions = []
const now = Date.now()

// ── .backups：超过 30 天的删 ────────────────────────────────────────────────
const backupDir = join(memDir, '.backups')
const backups = entries(backupDir)
const oldBackups = backups.filter((f) => now - f.at > BACKUP_MAX_AGE_MS)
for (const f of oldBackups) actions.push({ kind: 'backup', ...f, why: `备份 ${Math.round((now - f.at) / 86400000)} 天前` })

// ── .snapshots：只留最近 20 份 ──────────────────────────────────────────────
const snapDir = join(memDir, '.snapshots')
const snaps = entries(snapDir).sort((a, b) => b.at - a.at)
const extraSnaps = snaps.slice(KEEP_SNAPSHOTS)
for (const f of extraSnaps) actions.push({ kind: 'snapshot', ...f, why: '超出最近 20 份' })

const totalBytes = actions.reduce((s, a) => s + a.size, 0)
console.log(`工作区：${root}`)
console.log(
  `备份 ${backups.length} 个（其中 ${oldBackups.length} 个超过 30 天）` +
    ` · 快照 ${snaps.length} 个（保留最近 ${KEEP_SNAPSHOTS}，多出 ${extraSnaps.length}）`,
)
if (!actions.length) {
  console.log('没有要清理的。')
  process.exit(0)
}
console.log(`\n将要删除 ${actions.length} 个文件，共 ${(totalBytes / 1024).toFixed(1)} KB：`)
for (const a of actions.slice(0, 40)) {
  console.log(`  · ${a.kind === 'backup' ? '.backups' : '.snapshots'}/${a.name}（${a.why}，${(a.size / 1024).toFixed(1)} KB）`)
}
if (actions.length > 40) console.log(`  …另有 ${actions.length - 40} 个`)

if (!apply) {
  console.log('\n（dry-run：什么都没删。确认后加 --apply）')
  process.exit(0)
}
let removed = 0
let failed = 0
for (const a of actions) {
  try {
    unlinkSync(a.path)
    removed += 1
  } catch {
    failed += 1
  }
}
console.log(`\n✅ 删除 ${removed} 个（失败 ${failed}）· 释放约 ${(totalBytes / 1024).toFixed(1)} KB`)
console.log(
  `剩余：备份 ${entries(backupDir).length} 个 · 快照 ${entries(snapDir).length} 个`,
)
