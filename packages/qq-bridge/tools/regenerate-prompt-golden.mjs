/**
 * 一次性工具 · 第一步：为**有意重生成** `mocks/fixtures/prompt-golden.txt` 做准备。
 *
 * 为什么要分成三步（而不是一个"自己 spawn 测试"的脚本）：
 *   `verify-memory-roundtrip.mjs` §⑱ 刻意加了一道闩 —— 基线**只有在
 *   `.regenerate-golden` 标记存在、且基线文件缺失**时才会重新生成。
 *   第一版工具用 `execFileSync(..., { stdio: 'pipe' })` 去跑测试，
 *   在受限沙箱里**管道捕获会被直接拒掉**（EPERM），于是"没报错但也没生成"。
 *   所以流程拆成三条**看得见**的命令，每步都能在输出里核对：
 *
 *     ① node tools/regenerate-prompt-golden.mjs        ← 本脚本：备份 + 删基线 + 建标记
 *     ② node mocks/verify-memory-roundtrip.mjs         ← 跑一次（它会生成基线）
 *     ③ node tools/regenerate-prompt-golden.mjs --done ← 删标记 + 复核
 *
 * 用法：
 *   node tools/regenerate-prompt-golden.mjs          备份 + 删基线 + 建标记
 *   node tools/regenerate-prompt-golden.mjs --done   删标记 + 复核基线真的生成了
 *   node tools/regenerate-prompt-golden.mjs --restore 把备份恢复回基线（后悔时用）
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const FIXTURE = join(PKG, 'mocks', 'fixtures', 'prompt-golden.txt')
const BACKUP = `${FIXTURE}.bak`
const MARK = join(PKG, '.regenerate-golden')

const mode = process.argv.includes('--done') ? 'done' : process.argv.includes('--restore') ? 'restore' : 'prepare'

if (mode === 'prepare') {
  if (existsSync(FIXTURE)) {
    copyFileSync(FIXTURE, BACKUP)
    rmSync(FIXTURE)
    console.log(`· 旧基线已备份到 ${BACKUP}（跑完 diff 一下再看要不要留）`)
  } else if (!existsSync(BACKUP)) {
    console.error('⚠️ 基线不在、备份也不在 —— 那就直接往下走（会生成一份全新的）')
  }
  mkdirSync(dirname(FIXTURE), { recursive: true })
  writeFileSync(MARK, 'rebuild prompt golden baseline\n', 'utf8')
  console.log('✅ 标记 `.regenerate-golden` 已建、基线已移除')
  console.log('   下一步：node mocks/verify-memory-roundtrip.mjs')
  process.exit(0)
}

if (mode === 'restore') {
  if (!existsSync(BACKUP)) {
    console.error('❌ 没有备份可恢复')
    process.exit(1)
  }
  copyFileSync(BACKUP, FIXTURE)
  rmSync(MARK, { force: true })
  console.log('✅ 已把备份恢复成基线，并删掉标记')
  process.exit(0)
}

// ── --done：删标记 + 复核 ────────────────────────────────────────────────
rmSync(MARK, { force: true })
if (existsSync(MARK)) {
  console.error('❌ `.regenerate-golden` 标记没删掉 —— 基线会变成"谁跑谁重建"，那条断言等于没有')
  process.exit(1)
}
if (!existsSync(FIXTURE)) {
  console.error('❌ 基线仍不存在 —— 第二步（跑 verify-memory-roundtrip）没成功执行')
  process.exit(1)
}
console.log(`✅ 标记已删除；基线 ${statSync(FIXTURE).size} 字节`)
console.log('   最后一步：node mocks/verify-memory-roundtrip.mjs（应当全绿）')
