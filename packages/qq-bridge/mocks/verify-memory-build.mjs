/**
 * 按需建档测试（0.2.9）：把"还没计入记忆的消息"立刻整理成条目。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套在盯什么（每条都对应一个"错了会静默变坏"的地方）
 * ══════════════════════════════════════════════════════════════════════════
 * ① **归属由代码裁定**：模型只写 `#n`，编号→QQ 的映射在这里做。
 *    它写一个不存在的编号时，必须**丢弃并说明**，绝不能兜底到"当前发言人"（那就是串人）。
 * ② **落盘照旧过那道闸门**：这一批条目与其它写入路径共用 `screenEntry` ——
 *    第三方负面定性（D27）、身份权限、隐私七类一样拦，而且**被拒要如实回报**。
 * ③ **游标语义**：解析成功就前进（哪怕一条都没采纳——"考虑过了"也是结论）；
 *    **模型失败/解析失败时绝不前进**，否则这批消息会被永久跳过。
 * ④ **默认预演**：不显式 apply 就绝不落盘、绝不推进游标（记忆是长期资产）。
 *
 * 用法：node mocks/verify-memory-build.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildMemoryFromMessages,
  buildMemoryPrompt,
  CURSOR_REL,
  cursorKeyOf,
  normalizeBuildOutput,
  readCursor,
  resolveChatLabel,
  speakersOf,
} from '../src/memory-build.mjs'

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

const ROOT = mkdtempSync(join(tmpdir(), 'qq-bridge-build-'))
let seq = 0
const newWs = () => {
  seq += 1
  const ws = join(ROOT, `ws${seq}`)
  mkdirSync(ws, { recursive: true })
  return ws
}
const read = (ws, rel) => (existsSync(join(ws, rel)) ? readFileSync(join(ws, rel), 'utf8') : null)

const GROUP = '700000001'
const A = '100000001'
const B = '100000002'
const BOT = '200000001'
/** 一段真实形状的消息（含机器人自己的发言）。 */
const msgs = [
  { id: 11, userId: A, senderName: '无忘远霞', isBot: false, text: '我最近这几个项目都是 ai 编程的' },
  { id: 12, userId: BOT, senderName: '小鲸鱼', isBot: true, text: '哇这么厉害' },
  { id: 13, userId: B, senderName: '阿玮', isBot: false, text: '我在写一个爬虫' },
  { id: 14, userId: A, senderName: '无忘远霞', isBot: false, text: '这个群是游戏群' },
]

try {
  // ══════════════════════════════════════════════════════════════════════════
  section('① 发言人清单：按首次出现编号，机器人自己不算"某个人"')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const sp = speakersOf(msgs)
    check('编号按首次出现顺序', sp.map((s) => s.index).join(',') === '1,2', JSON.stringify(sp.map((s) => s.index)))
    check('★ 机器人不进清单（它不该有个人档案）', !sp.some((s) => s.userId === BOT), JSON.stringify(sp.map((s) => s.userId)))
    check('名字也带上（给模型看的是昵称，落盘用的是号码）',
      sp[0].name === '无忘远霞' && sp[0].userId === A, JSON.stringify(sp[0]))
    check('号码不合法的行被跳过（不猜）',
      speakersOf([{ userId: 'abc', isBot: false }, { userId: '', isBot: false }]).length === 0, '')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('② 提示词：教清三档、编号纪律、以及"不许做什么"')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const p = buildMemoryPrompt({ kind: 'group', chatLabel: '活死人之夜', batch: { speakers: speakersOf(msgs), messages: msgs } })
    check('带发言人编号清单（模型只认编号）', p.includes(`#1 = 无忘远霞(${A})`) && p.includes(`#2 = 阿玮(${B})`), '')
    check('带对话正文', p.includes('我最近这几个项目都是 ai 编程的') && p.includes('这个群是游戏群'), '')
    check('★ 明说"不要写 QQ 号"（它写了也会被拒）', /不要写 QQ 号/.test(p), '')
    check('三档都解释清楚（person 必须带 who / group 不要带）',
      /`person`/.test(p) && /`group`/.test(p) && /`global`/.test(p) && /必须带 who/.test(p), '')
    check('★ 重复了那几条硬禁令（隐私 / 第三方负面 / 不抄原文）',
      /不记隐私/.test(p) && /不记对不在场的人的负面评价/.test(p) && /不要把对话原文抄进来/.test(p), '')
    check('宁少勿多的口径在（一次最多 8 条）', /最多 8 条/.test(p) && /宁少勿多/.test(p), '')
    check('没有发言人时也不崩（私聊里可能只有机器人自己说过话）',
      buildMemoryPrompt({ kind: 'private', batch: { speakers: [], messages: [] } }).includes('没有别人说话'), '')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('③ 输出解析：认不出的丢掉，不猜')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const bare = normalizeBuildOutput('{entries:[{who:#1,scope:person,text:他在做爬虫},{scope:group,text:这个群是游戏群}]}')
    check('裸词 JSON 也能解析（与抽取同一套解析器）', bare.ok === true && bare.entries.length === 2, JSON.stringify(bare.entries?.length))
    check('scope 认不出 → 归到 group（不猜成 person，person 是要写进某个人的档案的）',
      normalizeBuildOutput('{entries:[{scope:啥,text:x}]}').entries[0].scope === 'group', '')
    check('空 text 丢掉', normalizeBuildOutput('{entries:[{scope:group,text:""}]}').entries.length === 0, '')
    check('{"entries":[]} 是合法答案（确实没什么可记）', normalizeBuildOutput('{entries:[]}').ok === true, '')
    check('解析不出来 → ok:false（由调用方如实回报，不抛）', normalizeBuildOutput('这不是 JSON').ok === false, '')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('④ 游标键：整会话与"某个人"各走各的进度')
  // ══════════════════════════════════════════════════════════════════════════
  check('整会话', cursorKeyOf({ chatKey: `group:${GROUP}` }) === `group:${GROUP}`, '')
  check('会话+人（不会互相吃掉进度）',
    cursorKeyOf({ chatKey: `group:${GROUP}`, userId: A }) === `group:${GROUP}|user:${A}`, '')
  check('会话为空 → null（fail-closed）', cursorKeyOf({ chatKey: '' }) === null, '')

  // ══════════════════════════════════════════════════════════════════════════
  section('⑤ 端到端：归属、闸门、游标、预演')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const ws = newWs()
    const stub = (text) => async () => ({ ok: true, text, ms: 12 })

    // ── 预演：不调模型、不写盘、不动游标 ───────────────────────────────────
    {
      let called = 0
      const r = await buildMemoryFromMessages({
        workspace: ws,
        kind: 'group',
        peerId: GROUP,
        messages: msgs,
        apply: false,
        runner: async () => {
          called += 1
          return { ok: true, text: '{}' }
        },
        log: () => {},
      })
      check('★★ 预演**不调模型**（省钱：界面先给人看要发什么）', called === 0 && r.dryRun === true, `called=${called}`)
      check('  预演把提示词原样给出来', String(r.prompt).includes('无忘远霞'), String(r.prompt).slice(0, 40))
      check('  预演不写盘、不动游标', read(ws, `memory/people/${A}.md`) === null && read(ws, CURSOR_REL) === null, '')
    }

    // ── 真做：person 按编号落到**对的人**名下；group 落到群文件 ─────────────
    {
      const r = await buildMemoryFromMessages({
        workspace: ws,
        kind: 'group',
        peerId: GROUP,
        chatLabel: '活死人之夜',
        messages: msgs,
        apply: true,
        runner: stub(
          '{entries:[{who:#1,scope:person,text:他做项目靠 AI 编程},' +
            '{who:#2,scope:person,text:他在写爬虫},' +
            '{scope:group,text:这个群是游戏群}],note:"ok"}',
        ),
        log: () => {},
      })
      check('★ 采纳计数如实（3 条）', r.applied.length === 3, JSON.stringify(r.applied.map((a) => `${a.scope}:${a.rel}`)))
      check('★★ #1 落到 A 的个人档、#2 落到 B 的个人档（编号→QQ 是代码做的）',
        String(read(ws, `memory/people/${A}.md`)).includes('靠 AI 编程') &&
          String(read(ws, `memory/people/${B}.md`)).includes('在写爬虫'),
        '')
      check('★ group 档落到群聊层（不落到任何个人档）',
        String(read(ws, `memory/groups/${GROUP}.md`)).includes('游戏群') &&
          !String(read(ws, `memory/people/${A}.md`)).includes('这个群是游戏群'),
        '')
      check('★★ 游标前进到最后一条（11→14）', r.cursorAfter === 14, String(r.cursorAfter))
      const cur = readCursor({ workspace: ws, chatKey: `group:${GROUP}` })
      check('  游标落盘了（重启后不会重复处理）', cur.lastId === 14, JSON.stringify(cur.rec))
      check('  报告里带 wroteFiles（界面能显示"写进了哪几份"）',
        Array.isArray(r.wroteFiles) && r.wroteFiles.length === 3, JSON.stringify(r.wroteFiles))
    }

    // ── 未知编号：丢弃并说明（**绝不兜底到当前发言人**）────────────────────
    {
      const ws2 = newWs()
      const logs = []
      const r = await buildMemoryFromMessages({
        workspace: ws2,
        kind: 'group',
        peerId: GROUP,
        messages: msgs,
        apply: true,
        runner: stub('{entries:[{who:#9,scope:person,text:他在做的事}]}'),
        log: (m) => logs.push(String(m)),
      })
      check('★★ 编号不在清单里 → 丢弃，**不猜是谁**',
        r.applied.length === 0 && r.ignored.length === 1 && /不在这一段的发言人清单里/.test(r.ignored[0].why),
        JSON.stringify(r.ignored))
      check('  磁盘上一条都没写（宁可不记，也不错记）',
        read(ws2, `memory/people/${A}.md`) === null && read(ws2, `memory/people/${B}.md`) === null, '')
      check('★ 但游标**照样前进**（这批消息确实"考虑过了"，否则会永远重复处理）',
        r.cursorAfter === 14, String(r.cursorAfter))
    }

    // ── 内容闸门：D27 的第三方负面定性在这一条路上一样拦 ────────────────────
    {
      const ws3 = newWs()
      const r = await buildMemoryFromMessages({
        workspace: ws3,
        kind: 'group',
        peerId: GROUP,
        messages: msgs,
        apply: true,
        runner: stub('{entries:[{who:#1,scope:person,text:我朋友就是个小丑},{who:#2,scope:person,text:他在写爬虫}]}'),
        log: () => {},
      })
      check('★★ 第三方负面定性被同一道闸门拦下，并如实回报原因',
        r.applied.length === 1 && r.ignored.some((i) => /不在场/.test(String(i.why))),
        JSON.stringify(r.ignored.map((i) => i.why)))
      check('  被拦的那条磁盘上没有', !String(read(ws3, `memory/people/${A}.md`) ?? '').includes('小丑'), '')
    }

    // ── 模型失败 / 解析失败：**游标绝不前进** ───────────────────────────────
    {
      const ws4 = newWs()
      const fail = await buildMemoryFromMessages({
        workspace: ws4,
        kind: 'group',
        peerId: GROUP,
        messages: msgs,
        apply: true,
        runner: async () => ({ ok: false, why: '超时' }),
        log: () => {},
      })
      check('★★ 模型失败 → ok:false、游标不前进（否则这批消息被永久跳过）',
        fail.ok === false && read(ws4, CURSOR_REL) === null && /没有.*前进|超时/.test(String(fail.why)),
        String(fail.why))

      const bad = await buildMemoryFromMessages({
        workspace: ws4,
        kind: 'group',
        peerId: GROUP,
        messages: msgs,
        apply: true,
        runner: async () => ({ ok: true, text: '模型今天不听话' }),
        log: () => {},
      })
      check('★★ 解析失败 → 带**原文片段**（本项目最贵的一类缺陷是"失败但没有证据"）',
        bad.ok === false && String(bad.raw).includes('模型今天不听话') && read(ws4, CURSOR_REL) === null,
        JSON.stringify({ raw: bad.raw, cursor: read(ws4, CURSOR_REL) }))

      const noRunner = await buildMemoryFromMessages({
        workspace: ws4,
        kind: 'group',
        peerId: GROUP,
        messages: msgs,
        apply: true,
        runner: null,
        log: () => {},
      })
      check('★ 没有模型通路 → 说清"游标没有前进，可以重试"',
        noRunner.ok === false && /没有.*前进/.test(String(noRunner.why)), String(noRunner.why))
    }

    // ── 没有新消息 / 只看某个人 ────────────────────────────────────────────
    {
      const ws5 = newWs()
      const empty = await buildMemoryFromMessages({ workspace: ws5, kind: 'group', peerId: GROUP, messages: [], apply: true, runner: stub('{}'), log: () => {} })
      check('没有新消息 → ok:true 且说明白（不是错误）', empty.ok === true && /没有新的消息/.test(String(empty.why)), String(empty.why))
      const perUser = await buildMemoryFromMessages({
        workspace: ws5,
        kind: 'group',
        peerId: GROUP,
        userId: A,
        messages: msgs.filter((m) => m.userId === A),
        apply: true,
        runner: stub('{entries:[{who:#1,scope:person,text:他做项目靠 AI 编程}]}'),
        log: () => {},
      })
      check('★ 只给某个人建档 → 走**独立游标**（不吃掉整会话的进度）',
        perUser.ok === true && readCursor({ workspace: ws5, chatKey: `group:${GROUP}` }).lastId === 0 &&
          readCursor({ workspace: ws5, chatKey: `group:${GROUP}`, userId: A }).lastId === 14,
        JSON.stringify({ all: readCursor({ workspace: ws5, chatKey: `group:${GROUP}` }).lastId, one: readCursor({ workspace: ws5, chatKey: `group:${GROUP}`, userId: A }).lastId }))
    }

    // ── 坏游标文件：按空处理但留证据 ────────────────────────────────────────
    {
      const ws6 = newWs()
      mkdirSync(join(ws6, 'runtime'), { recursive: true })
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(ws6, CURSOR_REL), '{ 坏掉的 JSON', 'utf8')
      const logs = []
      const r = readCursor({ workspace: ws6, chatKey: `group:${GROUP}`, log: (m) => logs.push(String(m)) })
      check('★★ 游标坏了 → 按 0 处理（会重看一遍消息），但**留一行日志**',
        r.lastId === 0 && logs.some((l) => /memory-build/.test(l)), logs.join('｜') || '（没有日志）')
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑥ ★ 截批：条数与**总字数**两个上限都要真的生效，且如实报数')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // ⚠️ 背景：`BUILD_LIMITS.chars = 6000` 曾经是个**死常量**（只声明、没人用）——
    //   单条截到 500 字，但 60 条就是 3 万字，一次点击能把上下文打掉一大块，
    //   而文档里却写着"一批最多 6000 字"。
    const stub = () => async () => ({ ok: true, text: '{"entries":[]}' })

    // ── 条数上限：80 条短消息 ────────────────────────────────────────────────
    {
      const ws = newWs()
      const many = Array.from({ length: 80 }, (_, i) => ({
        id: 100 + i,
        userId: A,
        senderName: '无忘远霞',
        isBot: false,
        text: `第 ${i} 条`,
      }))
      const r = await buildMemoryFromMessages({ workspace: ws, kind: 'group', peerId: GROUP, messages: many, apply: true, runner: stub(), log: () => {} })
      check('★ 短消息：被**条数**截在 60，且 skipped 如实报出剩下的 20 条',
        r.considered === 60 && r.skipped === 20 && r.truncatedBy === 'messages',
        JSON.stringify({ c: r.considered, s: r.skipped, by: r.truncatedBy }))
    }

    // ── 总字数上限：30 条 × 400 字 ───────────────────────────────────────────
    {
      const ws = newWs()
      const long = Array.from({ length: 30 }, (_, i) => ({
        id: 200 + i,
        userId: A,
        senderName: '无忘远霞',
        isBot: false,
        text: `${'长'.repeat(390)}${String(i).padStart(3, '0')}`,
      }))
      const r = await buildMemoryFromMessages({ workspace: ws, kind: 'group', peerId: GROUP, messages: long, apply: true, runner: stub(), log: () => {} })
      check('★★ 长消息：被**总字数**截住（不再是一口气把 3 万字全塞进去）',
        r.truncatedBy === 'chars' && r.considered < 30 && r.considered > 0,
        JSON.stringify({ c: r.considered, by: r.truncatedBy, chars: r.batchChars }))
      check('★ 实际交出去的字数**不超过上限**（含每行的发言人前缀余量）',
        r.batchChars <= 6000, String(r.batchChars))
      check('★ 被截掉的那条**真的没进提示词**（报的 skipped 必须与实际一致）',
        (() => {
          const dropped = long[r.considered]
          return dropped != null && !String(r.prompt).includes(dropped.text.slice(0, 60))
        })(),
        `dropId=${long[r.considered]?.id}`)
      check('★ skipped 与"没进提示词的条数"对得上',
        r.skipped === long.length - r.considered, JSON.stringify({ s: r.skipped, c: r.considered }))
      check('★★ 游标只前进到这一批的最后一条（下次再点接着处理，不丢消息）',
        r.cursorAfter === long[r.considered - 1].id, JSON.stringify({ after: r.cursorAfter, want: long[r.considered - 1].id }))
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑦ ★★ 审计：这条路以前完全没有留痕（2026-09-30 补）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const ws = newWs()
    const r = await buildMemoryFromMessages({
      workspace: ws,
      kind: 'group',
      peerId: GROUP,
      messages: msgs,
      apply: true,
      runner: async () => ({
        ok: true,
        text: '{entries:[{who:#1,scope:person,text:他做项目靠 AI 编程},{who:#2,scope:person,text:我朋友就是个小丑}]}',
      }),
      log: () => {},
    })
    const audit = String(read(ws, 'memory/audit.jsonl') ?? '')
    const rows = audit.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    check('★★★ 采纳的条目在审计里**有一行**（来源 `build`）',
      rows.some((x) => x.source === 'build' && x.outcome === 'applied' && x.scope === 'person'), audit.slice(0, 200))
    check('★★ 被闸门拒的那条**也有审计行**（outcome=ignored 且带原因）',
      rows.some((x) => x.outcome === 'ignored' && /不在场/.test(String(x.why ?? ''))), audit.slice(-220))
    check('★★ 审计**不记条目原文**，只记长度',
      // ⚠️ 精确的不变量：**采纳条目的正文**一个字都不许进审计。
      //    （被拒行的 `why` 会带一小段判据片段，例如 D27 的「我朋友…小丑…」——
      //     那是拒绝理由本身，与桥接那条路的格式一致，**不是**"把原文存了下来"；
      //     而隐私拦截的审计另有一条更严的规矩：只记类别与长度，见 privacy.mjs。）
      !audit.includes('他做项目靠 AI 编程') && !rows.some((x) => String(x.chars ?? 0) > 40 && x.outcome === 'applied'),
      audit.slice(0, 160))
    check('★ 带得出是谁的条目（senderId = 那个人的 QQ）',
      rows.some((x) => x.senderId === A), JSON.stringify(rows.map((x) => x.senderId)))
    check('★ 字段与桥接那条路一致（chatKey/source/scope/outcome/chars/at）',
      rows.length > 0 && rows.every((x) => 'chatKey' in x && 'source' in x && 'scope' in x && 'outcome' in x && 'chars' in x && 'at' in x),
      JSON.stringify(Object.keys(rows[0] ?? {})))
    check('★ 审计行数与报告对得上（1 采纳 + 1 拒）',
      rows.length === 2 && r.applied.length === 1 && r.ignored.length === 1,
      `rows=${rows.length} applied=${r.applied.length} ignored=${r.ignored.length}`)
  }
  // ══════════════════════════════════════════════════════════════════════════
  section('⑧ ★ 会话名：群名接上了（以前群里永远是空的）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const ws = newWs()
    // 私聊：走称呼表
    {
      const { writeContacts } = await import('../src/contacts.mjs')
      writeContacts({ workspace: ws, contacts: [{ qq: A, nickname: '远霞' }] })
      check('★ 私聊 → 称呼表里的名字',
        (await resolveChatLabel({ kind: 'private', peerId: A, workspace: ws })) === '远霞', '')
      check('  称呼表里没有 → 空串（不编）',
        (await resolveChatLabel({ kind: 'private', peerId: '999999999', workspace: ws })) === '', '')
    }
    // 群聊：走 roster.groupNameOf（与界面会话列表同一个来源）
    {
      const seen = []
      const groupNameOf = async (call, gid) => {
        seen.push(gid)
        return gid === GROUP ? '活死人之夜' : ''
      }
      const label = await resolveChatLabel({
        kind: 'group',
        peerId: GROUP,
        workspace: ws,
        groupNameOf,
        call: async () => ({ status: 'ok', retcode: 0, data: [] }),
      })
      check('★★ 群聊 → 真的去问了 roster（以前这一段是空实现）', label === '活死人之夜' && seen.length === 1, `label=${label} seen=${seen.join(',')}`)
      check('★ 群里查不到 → 空串（提示词里如实写"没查到名字"，不编一个群名）',
        (await resolveChatLabel({ kind: 'group', peerId: '700000009', workspace: ws, groupNameOf, call: async () => ({}) })) === '', '')
      check('★ 没接 roster（老调用方）→ 空串，不抛', (await resolveChatLabel({ kind: 'group', peerId: GROUP, workspace: ws })) === '', '')
      check('★ 查名字抛错 → 空串（名字只是可读性，绝不能因此建不了档）',
        (await resolveChatLabel({
          kind: 'group',
          peerId: GROUP,
          workspace: ws,
          groupNameOf: async () => {
            throw new Error('协议端超时')
          },
          call: async () => ({}),
        })) === '', '')
      check('  空 peerId → 空串', (await resolveChatLabel({ kind: 'group', peerId: '', workspace: ws })) === '', '')
      // ★ 名字确实进了提示词（端到端：接线不只看返回值）
      const r = await buildMemoryFromMessages({
        workspace: ws,
        kind: 'group',
        peerId: GROUP,
        chatLabel: label,
        messages: msgs,
        apply: false,
        log: () => {},
      })
      check('★★ 名字真的进了提示词（"对话来自：活死人之夜"）',
        String(r.prompt).includes('对话来自：活死人之夜'), String(r.prompt).split('\n')[1] ?? '')
    }
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
if (failed === 0) {
  console.log(`🎉 按需建档测试全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
