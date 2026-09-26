/**
 * 记忆使用侧车测试（H3，方案 B）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套盯的四件事
 * ══════════════════════════════════════════════════════════════════════════
 * ① **不许偷偷加衰减**（设计决策 D9）：账本里不能出现权重/强度/衰减字段，
 *    也不许因为"很久没用"就自动删或自动降权 —— 这条写成断言，因为"顺手加个权重"
 *    看起来太自然，而后果是**记忆被时间悄悄吞掉**且无人察觉。
 * ② **语义要诚实**：我们记的是"**被注入**"（进了上下文），不是"**被用上**"
 *    （模型真依赖了它）—— 后者观测不到。字段名与体检文案都按前者写。
 * ③ **"没有数据" ≠ "没被用过"**：账本刚部署时是全空的，那时**必须说无法判断**。
 *    第一版把 65 条全报成"从没进过上下文"：数字是真的，结论是错的。
 * ④ ★★ **排序的唯一目的**：注入有 25 条上限，而新条目是**追加在文件末尾**的 ——
 *    只按文件顺序截，"用户说记住 X、机器人也回了好，而 X 从此再没进过上下文"
 *    这种失效**完全静默**。所以"刚写下的"排最前；而"从没进过的老条目"**不许**
 *    反复抢占头部（那会让同一份记忆每轮渲染出不同文本，打断前缀缓存）。
 *    错误的那一版就是这么写的，被这里的断言打回。
 *
 * 用法：node mocks/verify-memory-usage.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  entryKey,
  readUsage,
  writeUsage,
  recordInjection,
  recordWrite,
  applyRecencyOrder,
  staleEntries,
  renderUsageReport,
  USAGE_REL,
  MAX_USAGE_KEYS,
  STALE_DAYS,
  RECENT_WRITE_DAYS,
} from '../src/memory-usage.mjs'
import { readMemoryForPrompt } from '../src/memory-store.mjs'

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
  const dir = mkdtempSync(join(tmpdir(), `dsh-usage-${process.pid}-`))
  created.push(dir)
  return dir
}

// ══════════════════════════════════════════════════════════════════════════
section('① 条目身份：按归一化文本认人（不是按行号）')
// ══════════════════════════════════════════════════════════════════════════
{
  const a = entryKey('他喜欢冰美式')
  check('同一条 → 同一个键（幂等）', a === entryKey('他喜欢冰美式') && a.length === 16, a)
  check('不同内容 → 不同键', a !== entryKey('他喜欢冰拿铁'))
  check('空内容 → 空键（不写进账本）', entryKey('') === '' && entryKey(null) === '' && entryKey('   ') === '')
  check('★ 标点/空白差异**归一化后是同一条**（记忆会被整理打磨，不能因此丢账）',
    a === entryKey('他喜欢冰美式。') && a === entryKey('  他喜欢冰美式  '),
    `${a} vs ${entryKey('他喜欢冰美式。')}`)
  check('★ 不按行号：内容相同、行号不同 → 仍是同一条（行号会随整理整体漂移）', a === entryKey('他喜欢冰美式'))
}

// ══════════════════════════════════════════════════════════════════════════
section('② 读账本：怎么坏都不抛（增强路径），但坏文件要留证据')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = freshWorkspace()
  check('没有文件 → 空账本（不是 null）', (() => {
    const l = readUsage({ workspace: ws })
    return l && l.entries && Object.keys(l.entries).length === 0
  })())
  check('没有工作区 → 空账本，不抛', (() => {
    const l = readUsage({ workspace: '' })
    return l && Object.keys(l.entries).length === 0
  })())

  mkdirSync(join(ws, 'memory'), { recursive: true })
  writeFileSync(join(ws, USAGE_REL), '{ 这不是 JSON', 'utf8')
  let logged = []
  check('坏 JSON → 空账本 + **留证据**（不许安静地失败）', (() => {
    const l = readUsage({ workspace: ws, log: (m) => logged.push(String(m)) })
    return Object.keys(l.entries).length === 0 && logged.length === 1 && logged[0].includes('账本读不了')
  })(), logged[0] ?? '（没有日志）')

  writeFileSync(join(ws, USAGE_REL), JSON.stringify({ version: 1, entries: '不是对象' }), 'utf8')
  logged = []
  check('结构不对（entries 不是对象）→ 空账本 + 留证据', (() => {
    const l = readUsage({ workspace: ws, log: (m) => logged.push(String(m)) })
    return Object.keys(l.entries).length === 0 && logged.some((m) => m.includes('结构不对'))
  })())

  check('写不进去**不抛**（记忆本身已经写好，只是"用没用过"没记上）', (() => {
    const bad = readUsage({ workspace: ws })
    const okWrite = writeUsage({ workspace: join(ws, '不存在的目录', 'x'), ledger: bad, log: () => {} })
    // 目录会被 mkdirSync recursive 建出来，所以这里用"空工作区"来构造失败
    return typeof okWrite === 'boolean'
  })())
  check('空工作区写 → 明确返回 false（不假装成功）', writeUsage({ workspace: '', ledger: { entries: {} } }) === false)
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 记账：时间 / 次数 / 会话，且**没有**任何权重字段（D9）')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = freshWorkspace()
  const blocks = [
    { rel: 'MEMORY.md', shownEntries: ['他喜欢冰美式', '工作区里 store/ 是堆放点'] },
    { rel: 'memory/private-1.md', shownEntries: ['他住上海'] },
  ]
  const r1 = recordInjection({ workspace: ws, blocks, chatKey: 'private:1', at: 1_000_000 })
  check('记了 3 条并写盘成功', r1.recorded === 3 && r1.written === true, JSON.stringify(r1))
  check('文件真的落盘了', existsSync(join(ws, USAGE_REL)))

  const l1 = readUsage({ workspace: ws })
  const k = entryKey('他喜欢冰美式')
  check('记下了时间与次数', l1.entries[k].lastInjectedAt === 1_000_000 && l1.entries[k].injectedCount === 1,
    JSON.stringify(l1.entries[k]))
  check('记下了是哪个会话见过的', l1.entries[k].chats.includes('private:1'))
  check('记下了它来自哪个文件', l1.entries[k].rel === 'MEMORY.md')
  check('★ 记了预览（体检给人看），但**不是**用来认人的', typeof l1.entries[k].preview === 'string' && l1.entries[k].preview.length > 0)
  check('★★ **账本里没有任何权重/强度/衰减字段**（D9：不做强度浮点衰减）', (() => {
    const raw = readFileSync(join(ws, USAGE_REL), 'utf8')
    return !/strength|weight|decay|score|priority/i.test(raw)
  })(), readFileSync(join(ws, USAGE_REL), 'utf8').slice(0, 80))

  recordInjection({ workspace: ws, blocks, chatKey: 'private:2', at: 1_100_000 })
  const l2 = readUsage({ workspace: ws })
  check('再记一次 → 次数累加、时间更新、firstInjectedAt 保持最早',
    l2.entries[k].injectedCount === 2 && l2.entries[k].lastInjectedAt === 1_100_000 && l2.entries[k].firstInjectedAt === 1_000_000,
    JSON.stringify(l2.entries[k]))
  check('第二个会话也被记下（最多 5 个）', l2.entries[k].chats.length === 2)
  check('★ 开账时间只设一次（没它就没法区分"没数据"和"没被用过"）',
    l2.startedAt === 1_000_000, String(l2.startedAt))

  check('空 blocks → 不写文件、不报错', (() => {
    const ws2 = freshWorkspace()
    const r = recordInjection({ workspace: ws2, blocks: [], at: 1 })
    return r.recorded === 0 && r.written === false && !existsSync(join(ws2, USAGE_REL))
  })())

  check(`账本上限 ${MAX_USAGE_KEYS}：超了丢最旧的（丢 = 那条重新算新的，代价很小）`, (() => {
    const ws3 = freshWorkspace()
    const many = Array.from({ length: MAX_USAGE_KEYS + 20 }, (_, i) => `条目 ${i}`)
    writeUsage({
      workspace: ws3,
      ledger: {
        version: 1,
        startedAt: 1,
        entries: Object.fromEntries(many.map((t, i) => [entryKey(t), { lastInjectedAt: i + 1, injectedCount: 1, rel: 'MEMORY.md', preview: t }])),
      },
      log: () => {},
    })
    recordInjection({ workspace: ws3, blocks: [{ rel: 'MEMORY.md', shownEntries: ['最新的那条'] }], at: 9_999_999 })
    const l = readUsage({ workspace: ws3 })
    const keys = Object.keys(l.entries)
    return keys.length === MAX_USAGE_KEYS && l.entries[entryKey('最新的那条')] !== undefined &&
      l.entries[entryKey('条目 0')] === undefined
  })())
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 排序：★★ 刚写下的必须先被看见；从没进过的老条目**不许**抢占头部')
// ══════════════════════════════════════════════════════════════════════════
{
  const now = 100 * 86_400_000
  const usage = {
    entries: {
      [entryKey('老条目 A')]: { lastInjectedAt: now - 5_000_000 },
      [entryKey('老条目 B')]: { lastInjectedAt: now - 1_000_000 },
      [entryKey('很旧的 C')]: { lastInjectedAt: now - 9_000_000 },
      // 刚写下、还没进过上下文
      [entryKey('刚写下的新条目')]: { writtenAt: now - 60_000 },
      // 很久以前写下、但从没进过上下文（饿着的老条目）
      [entryKey('饿着的老条目')]: { writtenAt: now - 200 * 86_400_000 },
    },
  }
  const entries = ['老条目 A', '很旧的 C', '饿着的老条目', '刚写下的新条目', '老条目 B']
  const sorted = applyRecencyOrder({ entries, usage, now })
  check('★★ 刚写下的排最前（它不能被 25 条上限截掉 —— 那是完全静默的失效）',
    sorted[0] === '刚写下的新条目', JSON.stringify(sorted))
  check('进过上下文的按最近时间倒序', JSON.stringify(sorted.slice(1, 4)) === JSON.stringify(['老条目 B', '老条目 A', '很旧的 C']),
    JSON.stringify(sorted.slice(1, 4)))
  check('★★ 从没进过、也不是刚写下的 → **排最后**（第一版让它排最前，会每轮抢占头部）',
    sorted[sorted.length - 1] === '饿着的老条目', JSON.stringify(sorted))
  check('★ 不增不减（只是重排，绝不因为"旧"就丢条）',
    sorted.length === entries.length && [...sorted].sort().join('|') === [...entries].sort().join('|'))
  check('原数组**不被修改**（纯函数）', JSON.stringify(entries) === JSON.stringify(['老条目 A', '很旧的 C', '饿着的老条目', '刚写下的新条目', '老条目 B']))

  const tie = applyRecencyOrder({ entries: ['第一条', '第二条', '第三条'], usage: { entries: {} }, now })
  check('★ 全部没记录时 → **保持文件顺序**（稳定排序；否则同内容会渲染出不同文本、打断前缀缓存）',
    JSON.stringify(tie) === JSON.stringify(['第一条', '第二条', '第三条']), JSON.stringify(tie))

  const sameAt = applyRecencyOrder({
    entries: ['x1', 'x2', 'x3'],
    usage: { entries: { [entryKey('x1')]: { lastInjectedAt: 7 }, [entryKey('x2')]: { lastInjectedAt: 7 }, [entryKey('x3')]: { lastInjectedAt: 7 } } },
    now,
  })
  check('同一时间戳（真实情形：同一轮一起注入）→ 顺序不变（这就是前缀缓存稳定的原因）',
    JSON.stringify(sameAt) === JSON.stringify(['x1', 'x2', 'x3']))

  check(`"刚写下"的窗口是 ${RECENT_WRITE_DAYS} 天：超出窗口的**不再**插队（否则它会永久霸占头部）`, (() => {
    const old = applyRecencyOrder({
      entries: ['老条目 A', '很久前写下的'],
      usage: { entries: { [entryKey('很久前写下的')]: { writtenAt: now - (RECENT_WRITE_DAYS + 1) * 86_400_000 }, [entryKey('老条目 A')]: { lastInjectedAt: now - 1000 } } },
      now,
    })
    return old[0] === '老条目 A'
  })())

  check('空输入不抛', JSON.stringify(applyRecencyOrder({ entries: [], usage: null })) === '[]' && JSON.stringify(applyRecencyOrder()) === '[]')
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 体检：扫**文件**找"最久没进过上下文"的（只看账本会漏掉从没进过的）')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = freshWorkspace()
  mkdirSync(join(ws, 'memory'), { recursive: true })
  writeFileSync(join(ws, 'MEMORY.md'), ['# 全局记忆', '- 常用的那条', '- 很久没用的那条', '- 〔已被更正：改成别的了 · 2026-01-01〕错的结论'].join('\n'), 'utf8')
  writeFileSync(join(ws, 'memory', 'group-999.md'), '# 某个早就不说话的群\n- 那个群的老规矩\n', 'utf8')

  const now = 400 * 86_400_000
  writeUsage({
    workspace: ws,
    ledger: {
      version: 1,
      startedAt: 1,
      entries: {
        // 很久以前进过上下文（早于阈值）
        [entryKey('常用的那条')]: { lastInjectedAt: now - 200 * 86_400_000, injectedCount: 3, rel: 'MEMORY.md', preview: '常用的那条' },
        // 刚写下、还没进过上下文 → 它是"新"，不是"死"，**不该**进体检名单
        [entryKey('刚写下的那条')]: { writtenAt: now - 3600_000, rel: 'MEMORY.md', preview: '刚写下的那条' },
      },
    },
    log: () => {},
  })
  writeFileSync(join(ws, 'MEMORY.md'), ['# 全局记忆', '- 常用的那条', '- 很久没用的那条', '- 刚写下的那条', '- 〔已被更正：改成别的了 · 2026-01-01〕错的结论'].join('\n'), 'utf8')
  const usage = readUsage({ workspace: ws })
  const stale = staleEntries({ workspace: ws, usage, now, days: STALE_DAYS })

  const texts = stale.map((s) => s.text)
  check('★ 从没进过上下文的两条排在最前（"那个群的老规矩"从没被读过）',
    texts.slice(0, 2).includes('那个群的老规矩') && texts.slice(0, 2).includes('很久没用的那条'), JSON.stringify(texts))
  check('★ "很久以前进过"的排在"从没进过"的**之后**（越久没用越靠后）',
    texts.indexOf('常用的那条') === texts.length - 1, JSON.stringify(texts))
  check('  并且它带着"多少天前"（有数据的才给天数）',
    stale.find((s) => s.text === '常用的那条')?.days === 200, String(stale.find((s) => s.text === '常用的那条')?.days))
  check('★★ 刚写下、还没进过上下文的**不进名单**（它是"新"，不是"死" —— 又是一次"没有数据 ≠ 没用过"）',
    !texts.includes('刚写下的那条'), JSON.stringify(texts))
  check('★ 已更正的条目不参与（它本来就该被忽略）', !texts.some((t) => t.includes('已被更正')))
  check('从未注入的条目 days 为 null（"没有数据"和"很久没用"要分得开）',
    stale.find((s) => s.text === '很久没用的那条')?.days === null)

  check('阈值内的条目不出现：把 days 调小 → 刚用过的也可能进名单（阈值真的生效）', (() => {
    const s2 = staleEntries({ workspace: ws, usage, now: now + 100 * 86_400_000, days: STALE_DAYS })
    return s2.some((s) => s.text === '常用的那条')
  })())
  check('没有 memory 目录也不抛', staleEntries({ workspace: freshWorkspace(), usage: null, now }).length === 0)

  // ── 文案：★★ "没有数据"绝不能说成"没被用过" ──────────────────────────────
  const empty = renderUsageReport({ stale: stale, total: 0, neverInjected: stale.length })
  check('★★ 账本为空时**必须说无法判断**，不能把"没有记录"说成"从没被用过"',
    empty.includes('无法判断') && empty.includes('还是空的'), empty.split('\n')[0])
  check('  └ 并且这时**不列出**那 65 条（列出来就是在暗示"它们没被用过"）',
    !empty.includes('那个群的老规矩'))
  const real = renderUsageReport({ stale, total: 3, neverInjected: 2, startedAt: 1_700_000_000_000 })
  check('★ 账本有数据时才给结论，并说清"自从账本开始记"', real.includes('自从账本开始记') && real.includes('那个群的老规矩'))
  check('★★ 文案里明说**不降权/不归档/不删**（D9 的可读形式）',
    real.includes('不会自动降权') && real.includes('不会自动归档') && real.includes('不会删'))
  check('明说记的是"被注入"而不是"被用上"（语义诚实）', real.includes('进入上下文'))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 与记忆读取的接线：新记忆进得去、注入文本**稳定**（不打断前缀缓存）')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = freshWorkspace()
  mkdirSync(join(ws, 'memory'), { recursive: true })
  const memPath = join(ws, 'MEMORY.md')
  // 造 27 条老条目 + 1 条刚写下的（超过 25 条上限，看谁被截）
  const lines = ['# 全局记忆']
  for (let i = 1; i <= 27; i += 1) lines.push(`- 老条目 ${i}`)
  lines.push('- 刚刚写下的新记忆')
  writeFileSync(memPath, `${lines.join('\n')}\n`, 'utf8')
  // ★ 模拟真实写入路径：`appendEntry` 会调 `recordWrite` 登记"刚写下"
  recordWrite({ workspace: ws, entries: ['刚刚写下的新记忆'], rel: 'MEMORY.md', at: Date.now() })

  const t1 = readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: '1' })
  check('★ readMemoryForPrompt 会告诉我**具体注入了哪些条目**（桥接据此记账）',
    Array.isArray(t1.blocks[0]?.shownEntries) && t1.blocks[0].shownEntries.length > 0,
    `shownEntries=${t1.blocks[0]?.shownEntries?.length}`)
  check('★★ **刚写下的新记忆进得去** —— 这是排序存在的唯一理由（文件顺序会把它截掉）',
    t1.blocks[0].shownEntries.includes('刚刚写下的新记忆'),
    t1.blocks[0].shownEntries.slice(0, 3).join(' / '))
  check('  上限仍然生效（不是把所有条目都塞进去）',
    t1.blocks[0].shownEntries.length <= 25 && t1.text.includes('另有'))
  check('  被挤掉的是**老条目**（老条目 27 之类的尾部），不是新记忆',
    !t1.blocks[0].shownEntries.includes('老条目 27'), t1.blocks[0].shownEntries.slice(-3).join(' / '))

  recordInjection({ workspace: ws, blocks: t1.blocks, chatKey: 'private:1', at: 1_000 })

  // ── ★★ 稳定性：写入发生后的**那一轮**文本可能变一次，之后必须一模一样 ──────
  const t2 = readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: '1' })
  recordInjection({ workspace: ws, blocks: t2.blocks, chatKey: 'private:1', at: 2_000 })
  const t3 = readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: '1' })
  recordInjection({ workspace: ws, blocks: t3.blocks, chatKey: 'private:1', at: 3_000 })
  const t4 = readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: '1' })

  check('★ 注入集合稳定（第 2 轮与第 3 轮注入的是同一批 25 条）',
    JSON.stringify([...t2.blocks[0].shownEntries].sort()) === JSON.stringify([...t3.blocks[0].shownEntries].sort()))
  check('★★ 稳定之后**每轮渲染出的文本完全一样**（前缀缓存不被这种排序打断）',
    t3.text === t4.text, t3.text === t4.text ? '' : '第 3 / 4 轮文本不一致（会打断缓存）')
  check('  新记忆在稳定态里仍然在（不是"进了一轮又被挤出去"）',
    t4.blocks[0].shownEntries.includes('刚刚写下的新记忆'))

  // ── 新写一条 → 下一轮必须出现（"记住 X"的最后一步：它得真的被看到）──────────
  writeFileSync(memPath, `${readFileSync(memPath, 'utf8')}- 又记住的一条\n`, 'utf8')
  recordWrite({ workspace: ws, entries: ['又记住的一条'], rel: 'MEMORY.md', at: Date.now() })
  const t5 = readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: '1' })
  check('★★ 新记住的一条**下一轮就进上下文**（否则"记住了"只是一句好听的话）',
    t5.blocks[0].shownEntries.includes('又记住的一条'), t5.blocks[0].shownEntries.slice(0, 2).join(' / '))
  check('  它挤掉的是最后一名（老条目），新记忆与旧记忆的相对次序没有乱',
    !t5.blocks[0].shownEntries.includes('老条目 27'))
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
  console.log(`🎉 记忆使用侧车测试全部通过（${passed} 项）`)
  console.log('   ⚠️ 它只证明**记账与排序**是对的；"哪条真的还被用上"我们观测不到（记的是"被注入"）。')
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
