/**
 * 记忆可观测性测试：计数 + 零写入告警 + 体检的两个漏报修复。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套测的是什么（为什么它值得单独存在）
 * ══════════════════════════════════════════════════════════════════════════
 * 0.2.0 的真实事故是：**聊了几十轮、一条记忆都没写，而没有任何地方报警**。
 * 所以这一套不是测"记忆能不能写"（那是 `verify-memory-store` 的事），
 * 而是测 **"记忆不工作时，我们能不能知道"**。
 *
 * 三条断言对应三个具体的静默失败：
 *   ① 计数不落盘        → "到底提议了几条"无从查起
 *   ② 零写入不告警      → 最该报警的情况恰好不报（诊断文档记录的真事）
 *   ③ 体检漏报 MEMORY.md → 使用者以为全局记忆是空的（真事，7605 字节被漏掉）
 *
 * 全程临时目录，**不碰真实工作区**，可重复跑。
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import {
  noteTurn,
  noteMemoryAttempt,
  zeroWriteAlert,
  readAllStats,
  resetStats,
  STATS_DEFAULTS,
} from '../src/memory-stats.mjs'
import { listMemoryFiles, snapshotNameOf, saveSnapshot } from '../src/memory-store.mjs'
import { inspectMemory, formatMemoryReport, checkSnapshots } from '../src/memory-inspect.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
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

function section(title) {
  console.log(`\n── ${title} ──`)
}

const WORK = mkdtempSync(join(tmpdir(), 'qq-bridge-stats-'))

try {
  // ══════════════════════════════════════════════════════════════════════════
  section('① 计数：无条件记轮数（这是告警的分母）')
  // ══════════════════════════════════════════════════════════════════════════
  noteTurn({ workspace: WORK, chatKey: 'group:1' })
  noteTurn({ workspace: WORK, chatKey: 'group:1' })
  const after2 = readAllStats(WORK).find((r) => r.chatKey === 'group:1')
  check('两次 noteTurn → turns = 2', after2?.turns === 2, JSON.stringify(after2 ?? null))
  check('没有落盘 → applied 仍为 0', after2?.applied === 0, String(after2?.applied))
  check('★ 统计文件落在了 memory/.stats.json',
    existsSync(join(WORK, 'memory', '.stats.json')))

  // ══════════════════════════════════════════════════════════════════════════
  section('② 零写入告警：跑够轮数却 0 落盘 → 必须报')
  // ══════════════════════════════════════════════════════════════════════════
  const need = STATS_DEFAULTS.zeroWriteAfterTurns

  // 轮数不够 → 不报（避免误报）
  const early = zeroWriteAlert({ workspace: WORK, chatKey: 'group:1', threshold: need })
  check('轮数不够时不报警（防误报）', early.alert === false, early.why)

  // 补足轮数 → 报
  for (let i = 0; i < need; i += 1) noteTurn({ workspace: WORK, chatKey: 'group:1' })
  const hit = zeroWriteAlert({ workspace: WORK, chatKey: 'group:1', threshold: need })
  check(`★ 跑满 ${need} 轮且 0 落盘 → 报警`, hit.alert === true, hit.why)
  check('告警理由里有轮数与提议数（可核对，不是一句"没生效"）',
    /轮/.test(hit.why) && /提出/.test(hit.why), hit.why)

  // 一旦落过盘 → 不再报
  noteMemoryAttempt({ workspace: WORK, chatKey: 'group:1', proposed: 1, applied: 1, ignored: 0, deduped: 0 })
  const cleared = zeroWriteAlert({ workspace: WORK, chatKey: 'group:1', threshold: need })
  check('★ 落过盘之后不再报警（修好了就闭嘴）', cleared.alert === false, cleared.why)

  // ══════════════════════════════════════════════════════════════════════════
  section('③ 四个计数各自对上（提议/接受/拒绝/去重）')
  // ══════════════════════════════════════════════════════════════════════════
  const before = readAllStats(WORK).find((r) => r.chatKey === 'group:1')
  noteMemoryAttempt({
    workspace: WORK, chatKey: 'group:1',
    proposed: 5, applied: 2, ignored: 2, deduped: 1,
  })
  const after = readAllStats(WORK).find((r) => r.chatKey === 'group:1')
  check('proposed 累加正确', after.proposed - before.proposed === 5,
    `${before.proposed} → ${after.proposed}`)
  check('applied 累加正确', after.applied - before.applied === 2)
  check('ignored 累加正确', after.ignored - before.ignored === 2)
  check('deduped 累加正确', after.deduped - before.deduped === 1)
  check('lastWriteAt 被写入（可回答"最后一次落盘是什么时候"）', after.lastWriteAt > 0,
    new Date(after.lastWriteAt).toISOString())

  section('④ 去重不算失败，但要看得出')
  // "去重"是正常行为（同一条又提了一次），不该被判成"没记"。
  const dedupOnly = readAllStats(WORK).find((r) => r.chatKey === 'group:1')
  check('deduped 独立计数，不混进 ignored', dedupOnly.deduped > 0 && dedupOnly.ignored >= 2)

  // ══════════════════════════════════════════════════════════════════════════
  section('⑤ 按会话分开（告警必须能指出是哪个会话）')
  // ══════════════════════════════════════════════════════════════════════════
  for (let i = 0; i < need; i += 1) noteTurn({ workspace: WORK, chatKey: 'group:2' })
  const rows = readAllStats(WORK)
  check('两个会话各自一行', rows.length === 2, JSON.stringify(rows.map((r) => r.chatKey)))
  const g2 = rows.find((r) => r.chatKey === 'group:2')
  check('★ group:2 零写入 → 报警；group:1 有写入 → 不报',
    g2?.alert === true && rows.find((r) => r.chatKey === 'group:1')?.alert === false,
    JSON.stringify(rows.map((r) => [r.chatKey, r.alert])))

  // ══════════════════════════════════════════════════════════════════════════
  section('⑥ 统计绝不阻断主流程（坏文件也不能抛）')
  // ══════════════════════════════════════════════════════════════════════════
  writeFileSync(join(WORK, 'memory', '.stats.json'), '{ 这不是合法 JSON', 'utf8')
  let threw = false
  try {
    noteTurn({ workspace: WORK, chatKey: 'group:3' })
    zeroWriteAlert({ workspace: WORK, chatKey: 'group:3' })
    readAllStats(WORK)
  } catch {
    threw = true
  }
  check('★★ 统计文件坏掉时不抛异常（记忆是增强功能，不能因观测手段而挂）', threw === false)
  check('坏文件被当成空统计处理（而不是让调用方拿到 undefined）',
    Array.isArray(readAllStats(WORK)))

  resetStats(WORK)
  check('resetStats 能清空', readAllStats(WORK).length === 0)

  // ══════════════════════════════════════════════════════════════════════════
  section('⑦ 体检必须报出根目录的 MEMORY.md（0.2.0 漏报了 7605 字节）')
  // ══════════════════════════════════════════════════════════════════════════
  const WS = mkdtempSync(join(tmpdir(), 'qq-bridge-inspect-'))
  try {
    writeFileSync(join(WS, 'MEMORY.md'), '# 全局记忆\n\n- 全局第一条\n- 全局第二条\n', 'utf8')
    mkdirSync(join(WS, 'memory'), { recursive: true })
    writeFileSync(join(WS, 'memory', 'group-9.md'), '# 群\n\n- 群第一条\n', 'utf8')

    const files = listMemoryFiles(WS)
    check('★ listMemoryFiles 含根 MEMORY.md', files.includes('MEMORY.md'),
      JSON.stringify(files))
    check('★ listMemoryFiles 含 memory/ 下的文件', files.includes('memory/group-9.md'))
    check('根文件排在前面（全局层最该先被看到）', files[0] === 'MEMORY.md')

    const insp = inspectMemory({ workspace: WS, conversations: [{ kind: 'group', peerId: '9' }] })
    const memRow = insp.files.find((f) => f.rel === 'MEMORY.md')
    check('★★ 体检①段能看到 MEMORY.md（修复前完全看不到）', Boolean(memRow),
      JSON.stringify(insp.files.map((f) => f.rel)))
    check('MEMORY.md 的条数被算出来了', memRow?.entries === 2, String(memRow?.entries))

    const text = formatMemoryReport(insp)
    check('★ 报告文本里出现 MEMORY.md', text.includes('MEMORY.md'))

    // ── 快照路径：根文件与子文件必须都能对上 ──────────────────────────────
    section('⑧ 快照路径唯一口径（根文件的篡改检测曾静默失效）')
    check('snapshotNameOf("MEMORY.md") = "MEMORY.md"', snapshotNameOf('MEMORY.md') === 'MEMORY.md')
    check('snapshotNameOf("memory/group-9.md") = "memory__group-9.md"',
      snapshotNameOf('memory/group-9.md') === 'memory__group-9.md')

    // 给两个文件都留快照 → checkSnapshots 应报"一致"（而不是"还没有快照"）
    saveSnapshot({ workspace: WS, rel: 'MEMORY.md' })
    saveSnapshot({ workspace: WS, rel: 'memory/group-9.md' })
    const snaps = checkSnapshots(WS)
    const sRoot = snaps.find((s) => s.rel === 'MEMORY.md')
    const sSub = snaps.find((s) => s.rel === 'memory/group-9.md')
    check('★ 根文件能比对到快照（修复前永远"还没有快照"→ 检测失效）',
      sRoot?.same === true, JSON.stringify(sRoot ?? null))
    check('★ 子文件也能比对到快照', sSub?.same === true, JSON.stringify(sSub ?? null))

    // 篡改根文件 → 必须报不一致
    writeFileSync(join(WS, 'MEMORY.md'), '# 全局记忆\n\n- 被人偷改了\n', 'utf8')
    const snaps2 = checkSnapshots(WS)
    check('★★ 根文件被改 → 报不一致（这是"记忆只能由桥接落盘"的保证）',
      snaps2.find((s) => s.rel === 'MEMORY.md')?.same === false,
      JSON.stringify(snaps2.find((s) => s.rel === 'MEMORY.md') ?? null))
  } finally {
    rmSync(WS, { recursive: true, force: true })
  }
} finally {
  rmSync(WORK, { recursive: true, force: true })
}

console.log('')
if (failed === 0) {
  console.log(`🎉 记忆可观测性测试全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
  process.exit(1)
}
