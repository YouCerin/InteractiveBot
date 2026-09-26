/**
 * 会话状态机测试（H10）：这段对话"聊到哪了" —— **纯规则、零模型调用**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套盯的三件事
 * ══════════════════════════════════════════════════════════════════════════
 * ① **与任务台账的分界不能糊**：那条轴是"我在做什么任务"（跨重启、落盘），
 *    这条轴是"这段对话的走向"（内存、重启即弃）。两个都在注入提示词，
 *    边界一糊就会长成两套互相重复的东西。
 * ② **水位（watermark）要能离线测**：`lastUserSeq > lastConsumedSeq` = 又来了一条更新的消息 ——
 *    这正是桥接里"旧回合作废"那套机制的显式形式（以前只能靠真造两条并发消息来验）。
 * ③ **话头（openLoops）宁可漏也不要误报**：只有"短回复 + 最后一句是问句"才算
 *    "我在等他答"；把每轮都标成"我在等他回答"会让这条提示彻底失效。
 *
 * 用法：node mocks/verify-session-state.mjs
 */

import {
  createSessionStateStore,
  renderSessionStateBlock,
  classifyMove,
  movesFromOps,
  looksLikeQuestion,
  SESSION_IDLE_MS,
  MAX_MOVES,
} from '../src/session-state.mjs'

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

// ══════════════════════════════════════════════════════════════════════════
section('① 动作分类：按"类"而不是按"全文"（与任务台账的分工）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('web_search → 搜索', classifyMove('web_search') === '搜索')
  check('web_fetch → 抓网页', classifyMove('web_fetch') === '抓网页')
  check('read / read_image → 读文件', classifyMove('read') === '读文件' && classifyMove('read_image') === '读文件')
  check('glob / grep → 找东西', classifyMove('glob') === '找东西' && classifyMove('grep') === '找东西')
  check('write / edit → 改文件', classifyMove('write') === '改文件' && classifyMove('edit') === '改文件')
  check('pwsh → 跑命令', classifyMove('pwsh') === '跑命令')
  check('qq_* 工具归到"查 QQ"', classifyMove('mcp__qq__qq_group_members') === '查 QQ')
  check('★ 认不出的工具不编语义（给"用工具"）', classifyMove('某个没见过的工具') === '用工具')
  check('空工具名 → null（不写进列表）', classifyMove('') === null && classifyMove(null) === null)

  const ops = [
    { type: 'tool/call', name: 'read' },
    { type: 'tool/result', ok: true },
    { type: 'tool/call', name: 'read' }, // 同类去重
    { type: 'tool/call', name: 'web_search' },
    { type: 'tool/call', name: 'grep' },
  ]
  check('★ 从 ops 提炼"哪几类"：去重且保序', JSON.stringify(movesFromOps(ops)) === JSON.stringify(['读文件', '搜索', '找东西']),
    JSON.stringify(movesFromOps(ops)))
  check('非 tool/call 的 op 不算动作', movesFromOps([{ type: 'tool/result' }, { type: 'assistant' }]).length === 0)
  check('空 ops 不抛', movesFromOps([]).length === 0 && movesFromOps().length === 0)
  check(`★ 最多留 ${MAX_MOVES} 类（一一对应到类别上限，不是"几个都行"）`, (() => {
    const seven = ['web_search', 'web_fetch', 'read', 'grep', 'write', 'pwsh', 'job_output']
    const got = movesFromOps(seven.map((name) => ({ type: 'tool/call', name })))
    return got.length === MAX_MOVES && got[0] === '搜索' && got[MAX_MOVES - 1] === '跑命令'
  })(), JSON.stringify(movesFromOps(['web_search', 'web_fetch', 'read', 'grep', 'write', 'pwsh', 'job_output'].map((name) => ({ type: 'tool/call', name })))))
}

// ══════════════════════════════════════════════════════════════════════════
section('② 话头判定：宁可漏，也不要误报')
// ══════════════════════════════════════════════════════════════════════════
{
  check('短回复 + 问句结尾 → 算"我在问他"', looksLikeQuestion('你是指哪个文件？') === true)
  check('英文问号也认', looksLikeQuestion('Which one?') === true)
  check('★ 陈述句不算', looksLikeQuestion('好的，我看完了。') === false)
  check('★★ 长回复里的反问**不算**（那是讲完了顺口一问，不是卡在等他回话）',
    looksLikeQuestion(`${'这是一段很长的说明。'.repeat(20)}你觉得呢？`) === false)
  check('★ 只在中间有问号、结尾是陈述 → 不算',
    looksLikeQuestion('你问的是这个吗？我看完了就这些。') === false)
  check('空文本不算', looksLikeQuestion('') === false && looksLikeQuestion(null) === false)
  check('多行时只看最后一行',
    looksLikeQuestion('第一行？\n第二行是陈述。') === false && looksLikeQuestion('第一行。\n要我去做吗？') === true)
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 水位：`superseded` 那套机制的显式形式')
// ══════════════════════════════════════════════════════════════════════════
{
  let t = 1_000_000
  const s = createSessionStateStore({ now: () => t })
  const key = 'private:10001'

  check('没有会话时读回 null（不编一个空状态出来）', s.read(key) === null)
  const seq1 = s.noteUser({ chatKey: key, text: '帮我看看 a.txt', role: 'admin' })
  check('第一条消息 → seq=1', seq1 === 1, String(seq1))
  check('★★ 还没消费 → `hasPendingNewer` 为真（= 有更新的消息没被回答）',
    s.hasPendingNewer(key) === true && s.read(key).lastUserSeq === 1 && s.read(key).lastConsumedSeq === 0)
  s.noteConsumed({ chatKey: key, seq: seq1 })
  check('★ 消费之后就不再 pending（水位追平）', s.hasPendingNewer(key) === false)

  const seq2 = s.noteUser({ chatKey: key, text: '顺便看看 b', role: 'admin' })
  check('又来一条 → seq 单调递增', seq2 === 2, String(seq2))
  check('★ 第二条还没被回答 → pending 又为真（这就是"旧回合作废"的判据）', s.hasPendingNewer(key) === true)

  check('noteConsumed 不传 seq 时用 lastUserSeq 兜底', (() => {
    s.noteConsumed({ chatKey: key })
    return s.read(key).lastConsumedSeq === 2 && s.hasPendingNewer(key) === false
  })())
  check('★ 给一个没消息的会话记水位 → 落在 0，且**不会**被误判成"有更新的消息"',
    s.noteConsumed({ chatKey: 'nope:1' }) === 0 && s.hasPendingNewer('nope:1') === false)
  check('空 chatKey 不造状态', s.noteUser({ chatKey: '', text: 'x' }) === 0 && s.read('') === null)
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 轮次统计 / 上一轮动作 / 闲置翻篇')
// ══════════════════════════════════════════════════════════════════════════
{
  let t = 2_000_000
  const s = createSessionStateStore({ now: () => t })
  const key = 'group:700000001'

  s.noteUser({ chatKey: key, text: '这个报错怎么修', role: 'member' })
  s.noteBot({ chatKey: key, text: '我看一下。', ops: [{ type: 'tool/call', name: 'read' }] })
  const st = s.read(key)
  check('轮次统计：用户 1 次 / 机器人 1 次 / 总 2 轮',
    st.userTurns === 1 && st.botTurns === 1 && st.turnCount === 2, JSON.stringify({ u: st.userTurns, b: st.botTurns, t: st.turnCount }))
  check('记下了"上一轮动了什么"', JSON.stringify(st.lastBotMoves) === JSON.stringify(['读文件']))
  check('记下了最后发言角色', st.lastSpeakerRole === 'bot')
  check('★ 只留最近一次的动作（不是累积）—— 它是"别重复上一轮"的依据', (() => {
    s.noteUser({ chatKey: key, text: '还是不行' })
    s.noteBot({ chatKey: key, text: '那我换个办法。', ops: [{ type: 'tool/call', name: 'pwsh' }] })
    return JSON.stringify(s.read(key).lastBotMoves) === JSON.stringify(['跑命令'])
  })())

  check(`★ 闲置超过 ${SESSION_IDLE_MS / 60000} 分钟 → 当成新对话（状态清掉，与任务台账同一条规则）`, (() => {
    t += SESSION_IDLE_MS + 1
    return s.read(key) === null
  })())
  check('  └ 之后重新记第一条又是 seq=1（翻篇了）', s.noteUser({ chatKey: key, text: '在吗' }) === 1)

  check('read 返回的是**副本**（外面改不动内部状态）', (() => {
    const a = s.read(key)
    a.turnCount = 999
    a.lastBotMoves.push('伪造')
    return s.read(key).turnCount !== 999 && !s.read(key).lastBotMoves.includes('伪造')
  })())

  check('clear() 能清空（测试与排查用）', (() => {
    s.clear()
    return s.size() === 0 && s.read(key) === null
  })())
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 渲染：空的不写、说清是"对话走向"、悬着的话头给指令')
// ══════════════════════════════════════════════════════════════════════════
{
  let t = 3_000_000
  const s = createSessionStateStore({ now: () => t })
  const key = 'private:20002'

  check('★ 第 1 轮（机器人还没说过话）→ 不注入（没什么"走向"可说）', (() => {
    s.noteUser({ chatKey: key, text: '你好' })
    return renderSessionStateBlock(s.read(key)) === ''
  })())
  check('null 状态 → 空串（不抛）', renderSessionStateBlock(null) === '' && renderSessionStateBlock(undefined) === '')

  s.noteBot({ chatKey: key, text: '你好呀，有什么事？', ops: [] })
  const block = renderSessionStateBlock(s.read(key))
  check('★★ 标题里**说清这不是任务台账**（两条轴并存，别让模型以为是一件事）',
    block.includes('对话走向') && block.includes('不是任务台账'), block.split('\n')[0])
  check('★★ 报的是**来回数**（不是把每条消息都算一轮的 `turnCount`，那会渲染成"这是第 5 轮"）',
    block.includes('第 1 个来回') && block.includes('对方说了 1 次') && block.includes('你回了 1 次'),
    (block.match(/这是第[^\n]*/) ?? ['(没有轮次行)'])[0])
  check('★ 有的话头给出**指令**（"先看他是不是在回答这个"），不是干陈述',
    block.includes('先看他是不是在回答这个'), block)

  check('动作段会提醒"别重复同一类动作"', (() => {
    s.noteUser({ chatKey: key, text: '再看看' })
    s.noteBot({ chatKey: key, text: '嗯。', ops: [{ type: 'tool/call', name: 'web_search' }] })
    const b = renderSessionStateBlock(s.read(key))
    return b.includes('搜索') && b.includes('别重复同一类动作')
  })())

  // ── 话头的完整生命周期（★ 这一段修的是一个**只有接线才暴露得出来**的 bug）──
  //
  // 第一版 `noteUser` 里写着"他一开口，话头就算接上了"→ 清空 `openLoops`。
  // 但 `noteUser` 跑在**拼提示词之前**，于是渲染时话头永远是空的 ——
  // 那条"先看他是不是在回答这个"的指令在真机上**一次也不会出现**。
  // 纯函数测试当时还写了条断言把这个错误行为固化了下来（而且那条断言当时
  // 恒真：话头本来就是空的）。所以这里显式把生命周期钉死。
  const k2 = 'private:20003'
  s.noteUser({ chatKey: k2, text: '帮我查个东西' })
  s.noteBot({ chatKey: k2, text: '要查哪个？', ops: [] })
  check('机器人问了一句短的 → 记下话头',
    s.read(k2).openLoops.length === 1 && s.read(k2).openLoops[0].text.includes('要查哪个'),
    JSON.stringify(s.read(k2).openLoops))

  s.noteUser({ chatKey: k2, text: '就那个' })
  check('★★ 用户开口**不**清话头（清掉 = 那句话在提示词里永远渲染不出来）',
    s.read(k2).openLoops.length === 1,
    `话头剩 ${s.read(k2).openLoops.length} 条`)
  const b2 = renderSessionStateBlock(s.read(k2))
  check('★★ 于是这一轮的提示词里真的带着「先看他是不是在回答这个」',
    b2.includes('要查哪个') && b2.includes('先看他是不是在回答这个'),
    (b2.match(/⚠️[^\n]*/) ?? ['(没有话头行)'])[0])

  s.noteBot({ chatKey: k2, text: '好，我去查。', ops: [] })
  check('★ 话头**恰好活一轮**：机器人再回一次（没提问）就清掉，不跨轮堆积',
    s.read(k2).openLoops.length === 0)

  check('★ 长回复不产生话头（避免把每轮都标成"我在等他回答"）', (() => {
    s.noteBot({ chatKey: k2, text: `${'说明。'.repeat(80)}你觉得呢？` })
    return s.read(k2).openLoops.length === 0
  })())
}

console.log('')
if (failed === 0) {
  console.log(`🎉 会话状态机测试全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
