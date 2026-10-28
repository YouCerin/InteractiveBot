/**
 * 投递管线：**S1 会话级串行链** + **S3 失败回执**（0.3.3）。
 *
 * 对应执行单 `docs/0.3.3-speech-pipeline-execution.md` 的验收项 A1–A4 / B1–B5。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这些断言必须**行为级**（而不是"看日志像对了"）
 * ══════════════════════════════════════════════════════════════════════════
 * S1 修的是一个**并发窗口**：`check()` 读 `#lastSentAt`、`markSent()` 写，
 * 两者之间隔着一次网络往返。窗口类缺陷**单线程顺序测试永远是绿的** ——
 * 所以 A1 必须**真的并发**（`Promise.all`），并且断言落在**实际发送时间差**上。
 *
 * A2 是**变异测试**：把串行链去掉（跑"先 check 再 await send"的老写法），
 * A1 那组断言必须**变红**。这一条是本文件的灵魂 —— 没有它，"链生效了"这句话
 * 无法与"随机数刚好错开了"区分。
 *
 * 用法：node mocks/verify-delivery-pipeline.mjs
 */

import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Bridge } from '../src/bridge.mjs'
import { SendQueue } from '../src/onebot.mjs'
import { SessionRouter } from '../src/session-bridge.mjs'
import { beginDelivery, readLedger } from '../src/delivery-ledger.mjs'
import { shouldReceipt, collect, dedupeKey, summarizeReason, RECEIPT_PREFIX } from '../src/delivery-receipt.mjs'
import { BLOCKED_OUTPUT_NOTICE } from '../src/privacy.mjs'

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 造一个固定间隔的队列（maxGap 压成 = minGap，便于断言"至少 minGap"）。 */
function makeQueue(over = {}) {
  return new SendQueue({
    minGapMs: 120,
    maxGapMs: 120,
    maxPerMinute: 100,
    maxPerHour: 1000,
    dedupeWindowMs: 0,
    log: () => {},
    ...over,
  })
}

/**
 * 走**串行链**投递一条（这就是 `bridge.mjs` 现在的形状）。
 * @returns {Promise<{ok:boolean, reason?:string, at?:number}>}
 */
function deliverChained(queue, chatKey, text, { sendDelayMs = 30, sent = [] } = {}) {
  return queue.run(chatKey, async ({ check, markSent, sleep: qsleep }) => {
    const v = check(text, text)
    if (!v.ok) return { ok: false, reason: v.reason }
    if (v.waitMs > 0) await qsleep(v.waitMs)
    const at = Date.now()
    await sleep(sendDelayMs) // 模拟一次网络往返
    sent.push({ text, at })
    markSent(text, text)
    return { ok: true, at }
  })
}

/** 老写法（**没有链**）—— 只用于 A2 变异对照：check → await send → markSent。 */
function deliverLegacy(queue, text, { sendDelayMs = 30, sent = [] } = {}) {
  const run = async () => {
    const v = queue.check(text, text)
    if (!v.ok) return { ok: false, reason: v.reason }
    if (v.waitMs > 0) await sleep(v.waitMs)
    const at = Date.now()
    await sleep(sendDelayMs)
    sent.push({ text, at })
    queue.markSent(text, text)
    return { ok: true, at }
  }
  return run()
}

/** 相邻两条实际发送时间差（升序）。 */
function gaps(sent = []) {
  const out = []
  for (let i = 1; i < sent.length; i += 1) out.push(sent[i].at - sent[i - 1].at)
  return out
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('A1 ★★★ 同一会话并发投递：相邻两条的实际发送间隔 ≥ minGapMs，且顺序与入链顺序一致')
// ══════════════════════════════════════════════════════════════════════════
{
  const q = makeQueue()
  const sent = []
  // ★ 真的并发：三条同时发起（这正是真机上"中间态 + 正文"、"正文 + 表情"的形状）
  await Promise.all([
    deliverChained(q, 'group:100', 'a', { sent }),
    deliverChained(q, 'group:100', 'b', { sent }),
    deliverChained(q, 'group:100', 'c', { sent }),
  ])
  const g = gaps(sent)
  check('前提：三条都发出去了（否则下面的间隔断言是空的）', sent.length === 3, JSON.stringify(sent.map((s) => s.text)))
  check('★★★ 顺序与入链顺序一致（a → b → c）', sent.map((s) => s.text).join('') === 'abc', sent.map((s) => s.text).join(''))
  check('★★★ 相邻两条的实际发送间隔都 ≥ minGapMs（minGap 从"尽力"变成"保证"）',
    g.length === 2 && g.every((x) => x >= 120), JSON.stringify(g))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('A2 ★★★ 变异测试：把串行链去掉（老写法）→ A1 必须变红')
// ══════════════════════════════════════════════════════════════════════════
{
  const q = makeQueue()
  const sent = []
  await Promise.all([deliverLegacy(q, 'a', { sent }), deliverLegacy(q, 'b', { sent }), deliverLegacy(q, 'c', { sent })])
  const g = gaps(sent)
  check('★ 前提：老写法三条也都发出去了', sent.length === 3, JSON.stringify(sent.map((s) => s.text)))
  check('★★★ 老写法的间隔**会**小于 minGapMs（这就是 A1 去掉链之后会变红的原因）',
    g.some((x) => x < 120), JSON.stringify(g))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('A3 账本：并发场景下每条记录的 chunks[].sent 不交错、sentCount ≤ total')
// ══════════════════════════════════════════════════════════════════════════
{
  const WS = mkdtempSync(join(tmpdir(), 'dsh-ledger-conc-'))
  const q = makeQueue()
  const send = async () => {
    await sleep(20)
  }
  // 两个**不同会话**各自两片并发（不同会话可以并行 —— 链是按会话的）
  const one = async (chatKey, chunks) => {
    const ticket = beginDelivery({ workspace: WS, owner: 'test', chatKey, chunks, log: () => {} })
    for (let i = 0; i < chunks.length; i += 1) {
      await q.run(chatKey, async ({ check, markSent, sleep: qsleep }) => {
        const v = check(chunks[i], `${chatKey}:${i}`)
        if (!v.ok) return { ok: false, reason: v.reason }
        if (v.waitMs > 0) await qsleep(v.waitMs)
        await send()
        markSent(chunks[i], `${chatKey}:${i}`)
        ticket.markSent(i)
        return { ok: true }
      })
    }
    ticket.finish()
  }
  await Promise.all([one('group:200', ['甲1', '甲2']), one('group:201', ['乙1', '乙2'])])

  const ledger = readLedger({ workspace: WS })
  // ★ 账本形状是 `{version, rows}`（不是 `{deliveries}`）—— 读错字段会得到"空账本"
  //   而断言照样绿（空数组 every → true），那是一条**假绿**。实测踩过。
  const recs = ledger?.rows ?? []
  check('前提：账本里有两轮记录', recs.length === 2, JSON.stringify(recs.map((r) => r.chatKey)))
  const okAll = recs.every((r) => {
    const total = Number(r.total) || 0
    const sentCount = (r.chunks ?? []).filter((c) => c.sent).length
    // 不交错：chunks 是从 0 按序建的，**前面的片不能在后面的片没发时先空着**
    const firstUnsent = (r.chunks ?? []).findIndex((c) => !c.sent)
    const noHole = firstUnsent < 0 || (r.chunks ?? []).slice(firstUnsent).every((c) => !c.sent)
    return sentCount <= total && sentCount === total && noHole
  })
  check('★★ 每条记录：sentCount = total，且 chunks 里没有"空洞"（不交错）', okAll,
    JSON.stringify(recs.map((r) => ({ k: r.chatKey, s: (r.chunks ?? []).filter((c) => c.sent).length, t: r.total }))))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('A4 超时：卡死的发送不能把会话永久堵死（记 failed、不 markSent、放过链）')
// ══════════════════════════════════════════════════════════════════════════
{
  const logs = []
  const q = makeQueue({ log: (m) => logs.push(String(m)) })
  // ① 一个永不返回的发送
  const stuck = await q.run(
    'group:300',
    async ({ check, markSent }) => {
      check('stuck', 'stuck')
      await new Promise(() => {}) // 永不 resolve
      markSent('stuck', 'stuck')
      return { ok: true }
    },
    { timeoutMs: 200, label: 'stuck' },
  )
  check('★★ 超时返回 `{ok:false, reason:"timeout"}`', stuck?.ok === false && stuck?.reason === 'timeout', JSON.stringify(stuck))
  check('★ 超时留了日志（第 9 条：可以失败，不许安静地失败）',
    logs.some((l) => /投递超时/.test(l) && /不 markSent/.test(l)), logs.join('｜') || '（没有日志）')

  // ② 链被放过了 —— 后续投递不受阻（这一条是关键：否则一个卡死的请求会永久堵死会话）
  const sent = []
  const after = await q.run(
    'group:300',
    async ({ check, markSent, sleep: qsleep }) => {
      const v = check('next', 'next')
      if (!v.ok) return { ok: false, reason: v.reason }
      if (v.waitMs > 0) await qsleep(v.waitMs)
      sent.push(Date.now())
      markSent('next', 'next')
      return { ok: true }
    },
    { timeoutMs: 2000 },
  )
  check('★★★ 超时之后同会话的**下一条仍能发出**（链被放过了）', after?.ok === true && sent.length === 1, JSON.stringify(after))
  check('★ 超时那条**没有** markSent（没发出去的不许记成"已发"）', q.pendingCount === 1, String(q.pendingCount))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('B0 判据表：哪些失败该回执、哪些不该（表单 §S3 的表，逐条钉住）')
// ══════════════════════════════════════════════════════════════════════════
{
  const yes = [
    ['每分钟上限', '每分钟上限 8 条已达'],
    ['每小时上限', '每小时上限 500 条已达'],
    ['内容去重', '内容重复（3 秒前刚发过）'],
    ['发送异常', '发送失败：ECONNRESET'],
    ['超时', '投递超时（30000ms）'],
  ]
  for (const [label, reason] of yes) {
    check(`回执：${label}`, shouldReceipt({ reason, kind: 'qq' }) === true)
  }
  const no = [
    ['终检门（内部泄漏）', '内部记忆标记（正常应在投递前就被剥掉，这里是第二道网）'],
    ['空段', '内容为空'],
    ['白名单外', '不在名单里'],
    ['认不出', '某种谁也说不清的原因'],
  ]
  for (const [label, reason] of no) {
    check(`不回执：${label}`, shouldReceipt({ reason, kind: 'qq' }) === false)
  }
  check('★ 原因摘要把人话翻出来（不回贴系统报错原文）',
    summarizeReason('每小时上限 500 条已达').includes('上限') && !summarizeReason('发送失败：ECONNRESET').includes('ECONNRESET'))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('B1–B5（接线级）：被丢弃的段落 → 下一轮提示词出现回执；终检门丢弃**不**回执')
// ══════════════════════════════════════════════════════════════════════════
{
  const ADMIN = '10001'
  function makeBridge({ replies = [], send = {}, receipt = {}, humanize = {} } = {}) {
    const WS = mkdtempSync(join(tmpdir(), 'dsh-receipt-'))
    const logs = []
    const log = (m) => logs.push(String(m))
    const router = new SessionRouter({ log: () => {} })
    const rpc = new EventTarget()
    rpc.prompts = []
    let turn = 0
    // ★ 直接在这里捕获**传给模型的提示词**（不要在构造后再包一层：
    //   第一版包了一层，而原实现先 `push('')` 再被包装写回 ⇒ 下标整体错位，
    //   于是"下一轮提示词"读到的是**上上一轮**的。实测踩过 —— 断言因此假绿/假红都出现过。）
    rpc.prompt = async (sessionId, blocks) => {
      rpc.prompts.push(String(blocks?.[0]?.text ?? ''))
      const text = String(replies[turn] ?? replies[replies.length - 1] ?? '好的')
      turn += 1
      router.handleEvent(sessionId, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text }] } },
      })
      router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
      return { messageId: `m${turn}` }
    }
    const onebot = new EventTarget()
    onebot.selfId = '99999'
    onebot.call = async () => ({})
    onebot.sent = []
    onebot.send = async (kind, peerId, text) => {
      onebot.sent.push({ kind, peerId, text })
      return { data: { message_id: `s${onebot.sent.length}` } }
    }
    const config = {
      dsh: { workspace: WS, permissionMode: 'workspace-write' },
      onebot: {},
      access: { adminUsers: [ADMIN], dmAllowlist: [], groupAllowlist: [] },
      trigger: { private: true, mention: true, keyword: false, groupEnabled: false, keywords: [] },
      send: {
        minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000,
        dedupeWindowMs: 0, maxCharsPerMessage: 1500, stickers: {}, ...send,
      },
      turn: { timeoutMs: 5000 },
      humanize: { enabled: false, chunkChars: 300, ...humanize },
      persona: { preset: 'none' },
      memory: { enabled: false },
      image: { enabled: false },
      delivery: { ledger: false, receipt: { enabled: true, maxPerHour: 3, minIntervalMs: 0, ...receipt } },
    }
    const bridge = new Bridge({
      rpc,
      onebot,
      sendQueue: new SendQueue({ ...config.send, log: () => {} }),
      router,
      config,
      log,
    })
    // 捕获**真正传给模型**的提示词：这一步已经由 `rpc.prompt` 自己做（见上面的说明）。
    return { bridge, rpc, onebot, logs, WS }
  }
  const msg = (text) => ({
    post_type: 'message', message_type: 'private', user_id: ADMIN, self_id: '99999',
    message: [{ type: 'text', data: { text } }],
  })

  // ── B1：限频丢弃 → 下一轮提示词里有回执 ──
  {
    // maxPerMinute=1：第一片能发、第二片被丢（这就是"说了但没发出去"）
    const { bridge, rpc, logs } = makeBridge({
      replies: ['第一句\n第二句', '好'],
      send: { maxPerMinute: 1 },
    })
    await bridge.handleEvent(msg('在吗'))
    const dropped = logs.some((l) => /跳过发送/.test(l))
    check('前提：真的有一片被丢弃（否则 B1 测不到东西）', dropped, logs.filter((l) => /跳过发送/.test(l)).join('｜') || '（没有）')
    check('★★ 丢弃被记成回执（日志可观测）', logs.some((l) => /已记下投递回执/.test(l)),
      logs.filter((l) => /投递回执/.test(l)).join('｜') || '（没有）')
    await bridge.handleEvent(msg('接着说'))
    const prompt2 = rpc.prompts[1] ?? ''
    check('★★★ 下一轮提示词里真的出现了 `[投递回执]`', prompt2.includes(RECEIPT_PREFIX), prompt2.slice(-400))
    check('★★ 回执写明"用一句新的话重新发"（给动作，不报故障）', /用一句新的话重新发/.test(prompt2))
    check('★★ 回执**只出现一次**（取用即清，不许每轮都念）', (prompt2.split(RECEIPT_PREFIX).length - 1) === 1)
    // ★ 第三轮断言的口径改准了：**"取用即清"不等于"以后永远没有回执"** ——
    //   第二轮自己也丢了一片（`好` 那句被限频），于是第三轮会拿到**新的**回执。
    //   真正的判据是：**第一轮那条回执不会被重复念**（同一段内容只回执一次）。
    await bridge.handleEvent(msg('再接着说'))
    const prompt3 = rpc.prompts[2] ?? ''
    check('★★ 第一轮那条回执**没有被再念一遍**（取用即清 + 同批去重）',
      !prompt3.includes('第二句'), prompt3.slice(-200))
    check('★★ 每一轮里回执**最多出现一次**（不许一回执就刷屏）',
      (prompt2.split(RECEIPT_PREFIX).length - 1) === 1 && (prompt3.split(RECEIPT_PREFIX).length - 1) <= 1)
  }

  // ── B2：终检门丢弃 → **无**回执（反例，B5 的变异抓手）──
  {
    const { bridge, rpc, logs } = makeBridge({
      // 让整条回复被终检门判为"内部泄漏"（工具调用原始 JSON）
      replies: ['{"name":"read","arguments":{"file_path":"a.txt"}}', '好'],
    })
    await bridge.handleEvent(msg('在吗'))
    check('前提：终检门真的拦下了这一轮', logs.some((l) => /内部泄漏/.test(l)),
      logs.filter((l) => /内部泄漏|泄漏/.test(l)).join('｜') || '（没有）')
    check('★★ 没有生成任何投递回执（回执等于把内部信息再递一遍）',
      !logs.some((l) => /已记下投递回执/.test(l)))
    await bridge.handleEvent(msg('再说'))
    check('★★★ 下一轮提示词里**没有** `[投递回执]`（B5 的变异抓手：shouldReceipt 若被改成恒 true，这条会红）',
      !(rpc.prompts[1] ?? '').includes(RECEIPT_PREFIX), (rpc.prompts[1] ?? '').slice(-200))
  }

  // ── B3：同一批内容反复被丢弃 → **只回执 1 次**（去重）──
  {
    // ★ `maxPerMinute: 0` 是刻意的：它让**每一轮的两片都被丢弃**，于是三轮的
    //   "被丢弃集合"**完全相同** —— 这才测得到"同一批只回执一次"。
    //   若用 maxPerMinute:1，第 1 轮只丢一片、第 2/3 轮丢两片，**根本不是同一批**，
    //   那样得到 2 次回执是**正确行为**，而我第一版把它当成缺陷写进了断言（假红）。
    const { bridge, logs } = makeBridge({
      replies: ['第一句\n第二句', '第一句\n第二句', '第一句\n第二句'],
      send: { maxPerMinute: 0 },
      receipt: { minIntervalMs: 0, maxPerHour: 10 },
    })
    await bridge.handleEvent(msg('在吗'))
    await bridge.handleEvent(msg('在吗'))
    await bridge.handleEvent(msg('在吗'))
    const made = logs.filter((l) => /已记下投递回执/.test(l)).length
    check('★★★ 同一批内容被丢弃 3 次 ⇒ **只回执 1 次**（不重复道歉）', made === 1, `回执了 ${made} 次`)
    check('★ 而且日志说清了"上一轮已经回执过"',
      logs.some((l) => /已经回执过/.test(l)), logs.filter((l) => /不回执/.test(l)).join('｜') || '（没有）')
    // ★ dedupeKey 是这条判据的实现（纯函数，同一批 → 同一个键）
    const k1 = dedupeKey([{ reason: '内容重复', text: '甲' }, { reason: '内容重复', text: '乙' }])
    const k2 = dedupeKey([{ reason: '内容重复', text: '甲' }, { reason: '内容重复', text: '乙' }])
    check('★ dedupeKey 对同一批原文稳定', k1 && k1 === k2, `${k1} / ${k2}`)
    check('★ 不可回执的条目**不参与**去重键（否则"泄漏"也会被算进同一批）',
      dedupeKey([{ reason: '内部泄漏', text: '甲' }]) === '')
  }

  // ── B4：回执不进 mirror / 语料库 / 账本 ──
  {
    const { bridge, WS } = makeBridge({
      replies: ['第一句\n第二句', '好'],
      send: { maxPerMinute: 1 },
    })
    await bridge.handleEvent(msg('在吗'))
    await bridge.handleEvent(msg('接着说'))
    const conv = bridge.listConversations().find((c) => c.chatKey === `private:${ADMIN}`) ?? {}
    const mirrorText = (conv.messages ?? []).map((m) => String(m.text ?? '')).join('\n')
    check('★★ 回执**不在**会话镜像里（它不是"我说过的话"）', !mirrorText.includes(RECEIPT_PREFIX),
      mirrorText.slice(-200))
    // 语料库 db 是二进制；用"回执前缀不该出现在任何记忆/语料文件里"来断言（够硬，且不解析 sqlite）
    let leaked = []
    for (const rel of ['runtime/corpus.sqlite', 'runtime/oplog']) {
      const abs = join(WS, rel)
      if (!existsSync(abs)) continue
      try {
        const raw = readFileSync(abs).toString('utf8')
        if (raw.includes(RECEIPT_PREFIX)) leaked.push(rel)
      } catch {
        /* 二进制读不到就跳过（sqlite 未必逐字含明文） */
      }
    }
    check('★★ 回执**没写进**语料库/oplog', leaked.length === 0, leaked.join('、') || '（干净）')
  }

  // ── B5：变异抓手 —— 判据表是"不回执"的唯一来源 ──
  {
    // 若 shouldReceipt 被改成恒 true，这两条会红（因为 collect 会有 ok:true）
    const gate = collect([{ index: 0, text: '（我这边刚出了点小状况）', reason: '内部记忆标记', kind: 'gate' }])
    check('★★ 终检门类丢弃 → collect 返回 ok:false（回执**不**生成）', gate.ok === false, JSON.stringify(gate))
    const empty = collect([{ index: 0, text: '', reason: '内容重复' }])
    check('★ 空文本 → 也没有回执（没有"改写"的抓手）', empty.ok === false, JSON.stringify(empty))
    const real = collect([{ index: 1, text: '第二句', reason: '每分钟上限 8 条已达', kind: 'qq' }])
    check('★ 正对照：可自救的丢弃 → 生成回执', real.ok === true && real.text.includes(RECEIPT_PREFIX), real.text.split('\n')[0] ?? '')
  }

  // ── B6：★★★ 隐私闸门拦下 → 下一轮提示词里告诉她（0.3.3 真机缺陷）──
  //
  // 事故原样（2026-10-20 00:14，私聊，语料库里有原文）：
  //   USER「这是什么」→ 她的回复被换成固定话术（她不知道）→
  //   USER「夫西地酸乳膏是干什么」→ 她答「**前面两条就在说这个，你没刷到？**」
  // 这里复现"拦下 → 下一轮"这两步，钉住三件事：话术真的发出去了 /
  // 下一轮提示词里有告知 / 告知里**没有原文**且**只出现一次**。
  {
    const { bridge, rpc, onebot, logs } = makeBridge({
      replies: ['他手机号是 13800138000，别外传', '好'],
    })
    await bridge.handleEvent(msg('在吗'))
    const first = onebot.sent[0]?.text ?? ''
    check('前提：真的被隐私闸门拦下（否则本节测不到东西）',
      logs.some((l) => /出站拦下/.test(l)), logs.filter((l) => /隐私/.test(l)).join('｜') || '（没有）')
    check('★★ 对方收到的**只有那句固定话术**（原文一个字都没出去）',
      first === BLOCKED_OUTPUT_NOTICE && !first.includes('13800138000'), first.slice(0, 60))
    check('★ 桥接记下了"下一轮要告诉她"', logs.some((l) => /已记下"这条没发出去"的告知/.test(l)))

    await bridge.handleEvent(msg('接着问'))
    const prompt2 = rpc.prompts[1] ?? ''
    check('★★★ 下一轮提示词里出现了 `[隐私闸门]` 告知（这就是修的这个 bug）',
      prompt2.includes('[隐私闸门]'), prompt2.slice(-320))
    check('★★ 并且明说"没有发出去"', /没有发出去/.test(prompt2), prompt2.slice(-320))
    check('★★★ 提示词里**不含**那段原文（回显隐私 = 防线自己变成泄露面）',
      !prompt2.includes('13800138000'))
    check('★★ 点名禁止"你没刷到"（事故原话）', /你没刷到/.test(prompt2))
    check('★★ 告知**只出现一次**（取用即清，不许每轮都念）',
      (prompt2.split('[隐私闸门]').length - 1) === 1)

    await bridge.handleEvent(msg('再问一句'))
    const prompt3 = rpc.prompts[2] ?? ''
    check('★★ 已经告知过就不再念（一次性语义）', !prompt3.includes('[隐私闸门]'), prompt3.slice(-160))
    // ★ 变异抓手：若告知被写成"每轮都附上"，第三条会红；若被写成"什么都不说"，第二条会红。
    check('★★ 变异对照：告警日志与提示词告知**不是同一件事**（日志每轮都在，提示词只一次）',
      logs.filter((l) => /出站拦下/.test(l)).length === 1)
  }

  // ── B7：★★★ 出站漏斗：**任何调用方**都绕不过隐私闸（2026-10-20 补的缺口）──
  //
  // 修之前的缺口：闸只写在交互回复那段，而 `onebot.send` 的上游是 `deliver()`
  // —— 定时任务 / 服务器事件 / 插件 / 跨通道这些"直接调 deliver"的路径**完全不过闸**。
  // 这里从**旁路**直接调 `bridge.deliver()`（模拟那些调用方），必须同样被拦。
  {
    const { bridge, rpc, onebot } = makeBridge({ replies: ['好'] })
    const out = await bridge.deliver({
      channel: 'qq-private',
      target: ADMIN,
      text: '他手机号是 13800138000，别外传',
    })
    check('★★ 直接调 `deliver()`（旁路）也被拦', onebot.sent[0]?.text === BLOCKED_OUTPUT_NOTICE,
      String(onebot.sent[0]?.text ?? '').slice(0, 60))
    check('★ 返回值带 `privacyBlocked`（调用方据此如实记账）', out?.privacyBlocked === true,
      JSON.stringify(out ?? null).slice(0, 120))
    check('★★ 原文没有出现在任何一条发出的消息里',
      onebot.sent.every((s) => !String(s.text ?? '').includes('13800138000')))
    await bridge.handleEvent(msg('在吗'))
    const p = rpc.prompts[rpc.prompts.length - 1] ?? ''
    check('★★★ 旁路被拦之后，下一轮提示词里也有告知（她同样得知道）', p.includes('[隐私闸门]'), p.slice(-200))
    check('★ 而且提示词里不带原文', !p.includes('13800138000'))
  }

  // ── B8：★★★ 定时任务（主动回合）也过闸，且记账用**实发正文**──
  //
  // 这是缺口里最要紧的一条：定时任务的播报会印在群里，而它原来连闸都不过。
  {
    const { bridge, onebot } = makeBridge({ replies: ['他手机号是 13800138000，记得打过去'] })
    const r = await bridge.runProactiveTurn({
      task: { id: 't1', title: '提醒', prompt: '提醒他吃药' },
      scheduledAt: Date.now(),
      target: { kind: 'private', peerId: ADMIN, sessionId: 's-proactive', channel: 'qq-private' },
    })
    check('前提：主动回合跑成了（否则本节测不到东西）', r?.ok === true, JSON.stringify(r ?? null).slice(0, 140))
    check('★★★ 主动回合同样被隐私闸拦下', onebot.sent[0]?.text === BLOCKED_OUTPUT_NOTICE,
      String(onebot.sent[0]?.text ?? '').slice(0, 60))
    check('★★ 返回的是**实发的正文**（不是模型原文）—— 定时任务据此记账',
      r?.text === BLOCKED_OUTPUT_NOTICE, String(r?.text ?? '').slice(0, 60))
    check('★ 并带上 `privacyBlocked`', r?.privacyBlocked === true)
    check('★ 原文没有发出去', onebot.sent.every((s) => !String(s.text ?? '').includes('13800138000')))
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('C1 链不泄漏、不卡死：20 条并发全部完成，且 `chainCount` 回到 0')
// ══════════════════════════════════════════════════════════════════════════
//
// 这一条盯的是"链实现自己"的故障：Map 忘了删会长胖（每会话一条已 resolve 的 Promise），
// 而 `release()` 漏掉会让**下一个**投递永远等下去（单测串行跑时完全看不出来）。
{
  const q = makeQueue({ minGapMs: 1, maxGapMs: 1 })
  const sent = []
  const jobs = []
  for (let i = 0; i < 20; i += 1) {
    jobs.push(deliverChained(q, 'group:900', `m${i}`, { sent, sendDelayMs: 1 }))
  }
  const done = await Promise.all(jobs)
  check('★★ 20 条并发全部返回（没有一条被卡在链上）', done.length === 20 && done.every((r) => r?.ok), JSON.stringify(done.filter((r) => !r?.ok)))
  check('★★ 20 条全部发出，且顺序 = 入链顺序', sent.length === 20 && sent.map((s) => s.text).join(',') === Array.from({ length: 20 }, (_, i) => `m${i}`).join(','), `${sent.length} 条`)
  check('★★★ 跑完之后**没有残留的链**（Map 不会随会话数长胖）', q.chainCount === 0, String(q.chainCount))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('C2 `#safeSend` 的例外面：只跳过"间隔"，**照样计配额**（E4 那个旁路的回归）')
// ══════════════════════════════════════════════════════════════════════════
{
  const ADMIN = '10001'
  function makeBridge({ send = {}, receipt = {}, replies = [] } = {}) {
    const WS = mkdtempSync(join(tmpdir(), 'dsh-receipt-c-'))
    const logs = []
    const log = (m) => logs.push(String(m))
    const router = new SessionRouter({ log: () => {} })
    const rpc = new EventTarget()
    rpc.prompts = []
    let turn = 0
    rpc.prompt = async (sessionId, blocks) => {
      rpc.prompts.push(String(blocks?.[0]?.text ?? ''))
      const text = String(replies[turn] ?? replies[replies.length - 1] ?? '好的')
      turn += 1
      router.handleEvent(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
      router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
      return { messageId: `m${turn}` }
    }
    const onebot = new EventTarget()
    onebot.selfId = '99999'
    onebot.call = async () => ({})
    onebot.requests = []
    onebot.send = async (kind, peerId, text) => {
      // ★ 记**所有**发出去的东西（含提示类），后面用来断言"回执不许出现在外发文本里"
      onebot.requests.push({ kind, peerId, text, at: Date.now() })
      return { data: { message_id: `s${onebot.requests.length}` } }
    }
    const config = {
      dsh: { workspace: WS, permissionMode: 'workspace-write' },
      onebot: {},
      access: { adminUsers: [ADMIN], dmAllowlist: [], groupAllowlist: [] },
      trigger: { private: true, mention: true, keyword: false, groupEnabled: false, keywords: [] },
      send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500, stickers: {}, ...send },
      turn: { timeoutMs: 5000 },
      humanize: { enabled: false, chunkChars: 300 },
      persona: { preset: 'none' },
      memory: { enabled: false },
      image: { enabled: false },
      delivery: { ledger: false, receipt: { enabled: true, maxPerHour: 3, minIntervalMs: 0, ...receipt } },
    }
    const bridge = new Bridge({
      rpc, onebot, sendQueue: new SendQueue({ ...config.send, log: () => {} }), router, config, log,
    })
    return { bridge, rpc, onebot, logs, WS }
  }
  const msg = (text) => ({
    post_type: 'message', message_type: 'private', user_id: ADMIN, self_id: '99999',
    message: [{ type: 'text', data: { text } }],
  })

  // ── C2-1：`#safeSend` 只跳过"间隔"，**配额照旧计**（E4 那个旁路的回归）──
  //
  // 判据要落到"**第二条提示被配额拦住**"上：这才是"它仍在记账"的证明。
  // 只用"没被间隔拦住"是不够的 —— 那条在旧实现里也成立（它压根不调 check）。
  {
    // ★ 必须和 `self_id` 不同：撞上机器人自己的号会在最前面被当成"自己发的"丢掉，
    //   一路走到 `reason: 'self'`，连权限判定都进不去（这个坑先踩过一次）。
    const OUTSIDER = '88888' // 不在任何名单里 ⇒ 走 `#safeSend` 的"只对名单内的人开放"
    const { bridge, onebot, logs } = makeBridge({ send: { maxPerMinute: 1 } })
    const outsiderMsg = () => ({
      post_type: 'message', message_type: 'private', user_id: OUTSIDER, self_id: '99999',
      message: [{ type: 'text', data: { text: '你好' } }],
    })
    await bridge.handleEvent(outsiderMsg())
    await bridge.handleEvent(outsiderMsg())
    const notices = onebot.requests.filter((r) => String(r.text ?? '').includes('只对名单内的人开放'))
    // ★ 前提：事件真的走到了权限判定。少了这条，"号码撞上 self_id 被当成自己发的"
    //   会伪装成"权限逻辑错了"（本套第一版就是这么红的）。
    check('★ 前提：事件走到了权限判定（不是更早的地方被丢掉）',
      logs.some((l) => /权限判定/.test(l)),
      logs.filter((l) => /身份核实|权限判定|拒绝/.test(l)).join('｜') || '（没有相关日志）')
    check('★★ 第一条提示发出去了', notices.length >= 1, JSON.stringify(onebot.requests.map((r) => r.text)))
    check('★★★ 第二条提示被**配额**拦下（证明 `#safeSend` 仍然计配额 —— 旧实现完全不调 check，这条会红）',
      logs.some((l) => /提示消息未发出：.*上限/.test(l)),
      logs.filter((l) => /提示消息/.test(l)).join('｜') || '（没有相关日志）')
    check('★ 被拦下的那条**没有**再发一次（不是"重试绕过去"）',
      onebot.requests.filter((r) => String(r.text ?? '').includes('只对名单内的人开放')).length === 1,
      String(onebot.requests.filter((r) => String(r.text ?? '').includes('只对名单内的人开放')).length))
  }

  // ── C2-2：回执**绝不**出现在任何外发文本里 ──
  {
    const { bridge, onebot, rpc } = makeBridge({
      replies: ['第一句\n第二句', '好'],
      send: { maxPerMinute: 1 },
    })
    await bridge.handleEvent(msg('在吗'))
    await bridge.handleEvent(msg('接着说'))
    const leaked = onebot.requests.filter((r) => String(r.text ?? '').includes(RECEIPT_PREFIX))
    check('★★★ 回执**一个字都没**出现在外发文本里（它只进提示词）', leaked.length === 0,
      leaked.map((r) => r.text).join('｜') || '（干净）')
    check('★ 而提示词里确实有（正对照，证明上面那条不是因为"根本没生成"）',
      (rpc.prompts[1] ?? '').includes(RECEIPT_PREFIX))
  }

  // ── C2-3：`delivery.receipt.enabled=false` 真的关（一键回滚）──
  {
    const { bridge, rpc, logs } = makeBridge({
      replies: ['第一句\n第二句', '好'],
      send: { maxPerMinute: 1 },
      receipt: { enabled: false },
    })
    await bridge.handleEvent(msg('在吗'))
    await bridge.handleEvent(msg('接着说'))
    check('★★ 关掉之后：日志里没有"已记下投递回执"', !logs.some((l) => /已记下投递回执/.test(l)))
    check('★★ 关掉之后：下一轮提示词里没有 `[投递回执]`', !(rpc.prompts[1] ?? '').includes(RECEIPT_PREFIX))
    check('★ 但"跳过发送"照旧留日志（关掉回执不等于关掉可观测性）',
      logs.some((l) => /跳过发送/.test(l)), logs.filter((l) => /跳过发送/.test(l)).join('｜') || '（没有）')
  }
}

console.log('')
if (failed === 0) {
  console.log(`🎉 投递管线（S1 串行链 + S3 回执）全部通过（${passed} 项）`)
  console.log('   ⚠️ A2 是**变异对照**：把链去掉之后 A1 会红 —— 那是这一套存在的理由。')
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
