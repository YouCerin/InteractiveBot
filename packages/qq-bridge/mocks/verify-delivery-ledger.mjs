/**
 * 投递账本测试（H15）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套盯的四件事
 * ══════════════════════════════════════════════════════════════════════════
 * ① **所有者要能区分"同一个 pid 的两次运行"**：pid 会被复用，只按 pid 认人时，
 *    新进程会把上一个人留下的账当成自己的 —— 于是**漏发**（以为发过）或**重发**（重复回复）。
 * ② **落账必须在发送之前**（这条由桥接级断言兜住，见 verify-memory-roundtrip §⑯）：
 *    发完再记一笔的话，崩溃时那一笔永远不存在 —— 而真机上丢过整整一条回复。
 * ③ ★★ **绝不自动重放**：崩溃可能发生在"已经发出去、但还没标上"的那一瞬间，
 *    我们**无法区分**这两种情况，自动重发就会产生重复回复 —— 而重复回复在本项目里
 *    被判定为**比漏一条更糟**。所以账本只提供证据，补不补由人决定。
 * ④ **它是排查用的，不是第二份聊天记录**：只存每片长度 + 前 40 字，
 *    与 `memory-audit.mjs` 同一条纪律（审计面越窄越好）。
 *
 * 用法：node mocks/verify-delivery-ledger.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ownerId,
  readLedger,
  writeLedger,
  beginDelivery,
  orphanedDeliveries,
  inFlightDeliveries,
  renderOrphans,
  renderInFlight,
  renderLedger,
  LEDGER_REL,
  STATE,
  MAX_ROWS,
} from '../src/delivery-ledger.mjs'

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

const created = []
function freshWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), `dsh-ledger-${process.pid}-`))
  created.push(dir)
  return dir
}
const rowsOf = (ws) => readLedger({ workspace: ws }).rows ?? []

// ══════════════════════════════════════════════════════════════════════════
section('① 所有者：`pid@启动时刻`（pid 复用不能认错人）')
// ══════════════════════════════════════════════════════════════════════════
{
  const a = ownerId({ pid: 1234, startedAt: 1000 })
  const b = ownerId({ pid: 1234, startedAt: 2000 })
  check('★ 同一个 pid、不同启动时刻 → **不同的所有者**（否则新进程会把上一个人的账当自己的）', a !== b, `${a} vs ${b}`)
  check('  所有者串里同时含 pid 与启动时刻（可读、可排查）', a === '1234@1000')
  check('  缺启动时刻也不崩（给 0）', ownerId({ pid: 9 }) === '9@0')
}

// ══════════════════════════════════════════════════════════════════════════
section('② 状态机：pending → done / failed')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = freshWorkspace()
  const owner = ownerId({ pid: 111, startedAt: 500 })
  const t = beginDelivery({
    workspace: ws,
    owner,
    chatKey: 'private:10001',
    kind: 'private',
    peerId: '10001',
    chunks: ['第一片', '第二片'],
    at: 1_000_000,
  })
  const rows = rowsOf(ws)
  check('★ 落账：文件真的写出来了', existsSync(join(ws, LEDGER_REL)))
  check('★★ 初始状态是 **pending**（"正在投递"在任何时刻都查得到）',
    rows.length === 1 && rows[0].state === STATE.pending, rows[0]?.state)
  check('  记下了会话、片数、所有者', rows[0].chatKey === 'private:10001' && rows[0].total === 2 && rows[0].owner === owner)
  check('  每片初始都是**未发送**', rows[0].chunks.every((c) => c.sent === false))

  t.markSent(0)
  check('★ 标掉第 0 片 → 只有它变成已发送', (() => {
    const r = rowsOf(ws)[0]
    return r.chunks[0].sent === true && r.chunks[1].sent === false
  })())
  check('半途调用 finish() → **仍是 pending**（没发完就不能算完，这是崩溃后能报出来的前提）', (() => {
    t.finish()
    return rowsOf(ws)[0].state === STATE.pending
  })())
  t.markSent(1)
  t.finish()
  check('★ 全部发完 + finish() → done', rowsOf(ws)[0].state === STATE.done)

  const t2 = beginDelivery({ workspace: ws, owner, chatKey: 'private:2', chunks: ['x'], at: 1_000_001 })
  t2.fail('协议端拒了')
  const failedRow = rowsOf(ws).find((r) => r.id === t2.id)
  check('★ 明确失败 → failed，且**带上原因**（与"崩溃留下的 pending"要能分开看）',
    failedRow.state === STATE.failed && failedRow.why === '协议端拒了', JSON.stringify({ s: failedRow.state, why: failedRow.why }))
}

// ══════════════════════════════════════════════════════════════════════════
section('③ ★★ 未完成投递：只报**别人**的 pending，且明说"不自动重发"')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = freshWorkspace()
  const dead = ownerId({ pid: 111, startedAt: 500 })
  const me = ownerId({ pid: 222, startedAt: 900 })

  beginDelivery({ workspace: ws, owner: dead, chatKey: 'private:1', chunks: ['A', 'B'], at: 1 })
  beginDelivery({ workspace: ws, owner: me, chatKey: 'private:2', chunks: ['C'], at: 2 })
  const doneOne = beginDelivery({ workspace: ws, owner: dead, chatKey: 'group:9', chunks: ['D'], at: 3 })
  doneOne.markSent(0)
  doneOne.finish()

  // ★ 存活判定**注入**（与 `token-discovery` 注入 `lstat` 同一个理由）：
  //   真按 pid 查活会让测试依赖"这台机器上恰好没有 pid 111"—— 那是环境运气，不是断言。
  const alive111 = (pid) => String(pid) === '111'

  // ★★ 这一条是**真机抓出来的缺陷的回归锁**：CLI 第一版没做存活判定，于是在桥接
  //    **正在投递**的那一刻跑 `--delivery`，把那条正在发的回复报成了"上一次运行没发完"
  //    （而它几百毫秒后就 done 了）。误导性证据比没有证据更糟 —— 它会让人去翻一个不存在的问题。
  check('★★ 进程**还活着**的 pending → **不算**"上一次没发完"（否则会把"正在发"说成"没发完"）',
    orphanedDeliveries({ workspace: ws, owner: me, isAlive: alive111 }).length === 0)
  check('★★ 反过来：它应该被报成**正在投递**',
    inFlightDeliveries({ workspace: ws, owner: me, isAlive: alive111 }).length === 1)

  const orphans = orphanedDeliveries({ workspace: ws, owner: me, isAlive: () => false })
  check('★★ 进程**已死**的 pending 才算"上一次没发完"',
    orphans.length === 1 && orphans[0].chatKey === 'private:1', JSON.stringify(orphans.map((o) => o.chatKey)))
  check('  自己的 pending **不算**未完成（那是我正在发的）', !orphans.some((o) => o.chatKey === 'private:2'))
  check('  已投递完的**不算**（不能把发过的行复活）', !orphans.some((o) => o.chatKey === 'group:9'))
  check('  报的片数如实（已发出 0/2）', orphans[0].sentCount === 0 && orphans[0].total === 2)
  check('  没有活着的 pending 时，inFlight 为空（不瞎报"正在投递"）',
    inFlightDeliveries({ workspace: ws, owner: me, isAlive: () => false }).length === 0)
  check('  renderInFlight 说明"不是失败"',
    renderInFlight([{ at: Date.now(), chatKey: 'private:1', sentCount: 0, total: 1, preview: 'x' }]).includes('不是失败'))

  const text = renderOrphans(orphans)
  check('★★ 文案里**明说不会自动重发**（降级说明不是口号，要写在用户看得到的地方）',
    text.includes('不会自动重发'), text.split('\n').slice(-1)[0].slice(0, 60))
  check('★★ 文案里说清了**为什么不自动重发**（"已发出但没标上"那一瞬间无法区分）',
    text.includes('已经发出去') && text.includes('重复'))
  check('  文案里指了人工入口（--delivery --resend）', text.includes('--resend'))
  check('  没有未完成投递时 → 空串（不打扰）', renderOrphans([]) === '')

  const book = renderLedger({ ledger: readLedger({ workspace: ws }) })
  check('★ 账本渲染：三种状态各有标记，窗口标题无', /✅|⚠️|❌/.test(book), book.split('\n')[0])
  check('  空账本时说清"从这次升级之后才开始记"（不装成"一切正常"）',
    renderLedger({ ledger: { rows: [] } }).includes('才开始记'))
}

// ══════════════════════════════════════════════════════════════════════════
section('④ ★ 账本是排查用的，**不是第二份聊天记录**')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = freshWorkspace()
  const secret = `手机号 13800138000 后面还有一长串内容${'啊'.repeat(200)}`
  beginDelivery({ workspace: ws, owner: 'x@1', chatKey: 'private:1', chunks: [secret], at: 5 })
  const raw = readFileSync(join(ws, LEDGER_REL), 'utf8')
  const row = rowsOf(ws)[0]
  check('★ 只存长度（能对上原文有多长）', row.chunks[0].chars === secret.length, String(row.chunks[0].chars))
  check('★★ 只存前 40 字 —— **不存全文**（审计面越窄越好，与 memory-audit 同一条纪律）',
    row.chunks[0].preview.length === 40, String(row.chunks[0].preview.length))
  check('★★ 全文**没有**落进账本（隐私内容不会被第二份文件复制）', !raw.includes('啊'.repeat(60)))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 健壮性：坏文件不抛但留证据；上限裁剪**优先保 pending**')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = freshWorkspace()
  mkdirSync(join(ws, 'runtime'), { recursive: true })
  writeFileSync(join(ws, LEDGER_REL), '{ 这不是 JSON', 'utf8')
  const logged = []
  const l = readLedger({ workspace: ws, log: (m) => logged.push(String(m)) })
  check('★ 坏 JSON → 空账本 + **留证据**（不许安静地失败）',
    l.rows.length === 0 && logged.some((m) => m.includes('读不了')), logged[0] ?? '（没有日志）')
  check('  结构不对（rows 不是数组）→ 空账本 + 留证据', (() => {
    writeFileSync(join(ws, LEDGER_REL), JSON.stringify({ version: 1, rows: '不是数组' }), 'utf8')
    const logged2 = []
    const l2 = readLedger({ workspace: ws, log: (m) => logged2.push(String(m)) })
    return l2.rows.length === 0 && logged2.some((m) => m.includes('结构不对'))
  })())
  check('  空工作区 → 空账本，不抛', readLedger({ workspace: '' }).rows.length === 0)
  check('  空工作区写 → 明确返回 false（不假装成功）', writeLedger({ workspace: '', ledger: { rows: [] } }) === false)

  const ws2 = freshWorkspace()
  const many = []
  for (let i = 0; i < MAX_ROWS + 40; i += 1) {
    many.push({
      id: `old-${i}`,
      owner: 'x@1',
      at: i,
      chatKey: 'private:1',
      total: 1,
      state: STATE.done,
      chunks: [{ chars: 1, preview: 'x', sent: true }],
    })
  }
  many.push({
    id: 'orphan-keep-me',
    owner: 'dead@1',
    at: 1,
    chatKey: 'private:9',
    total: 1,
    state: STATE.pending,
    chunks: [{ chars: 1, preview: 'y', sent: false }],
  })
  writeLedger({ workspace: ws2, ledger: { version: 1, rows: many } })
  // 触发一次裁剪（beginDelivery 会写盘 → 走 prune）
  beginDelivery({ workspace: ws2, owner: 'me@2', chatKey: 'private:1', chunks: ['z'], at: 9_999_999 })
  const after = rowsOf(ws2)
  check(`★ 超过 ${MAX_ROWS} 条时丢**已投递的旧记录**`, after.length <= MAX_ROWS + 1, `${after.length} 条`)
  check('★★ 但 **pending 的永远不丢**（那是还没处理的证据，丢了就再也查不到）',
    after.some((r) => r.id === 'orphan-keep-me'))
}

for (const dir of created) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    console.log(`⚠️ 临时目录清理失败（无害）：${error?.code ?? error?.message}`)
  }
}

console.log('')
if (failed === 0) {
  console.log(`🎉 投递账本测试全部通过（${passed} 项）`)
  console.log('   ⚠️ 它只证明**记账与报告**是对的：我们**不做自动重发**（重复回复比漏一条更糟）。')
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
