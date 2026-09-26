/**
 * 操作日志（oplog）测试。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套盯的是"**记住自己干过什么**"的原料链
 * ══════════════════════════════════════════════════════════════════════════
 * 缺口原本在这里：`TurnCollector` 收到 `tool/call` 时**只留了工具名**
 * （`{ name, callId }`），把 `arguments` 与 `tool/result` 的内容**全丢了**。
 * 于是"记住自己干过什么"这一条**连原料都没有** —— 桥接明明收到了完整事件。
 *
 * ★ 事件形状**不是猜的**：下面的 fixture 逐字段照抄本机真实会话
 *   （`tool/result` 的 `data.message.content[0].content[]` 结构、
 *    `arguments` 是 **JSON 字符串**、`isError` 在 tool-result 块上）。
 *   实测覆盖 16 种工具，结果块都是这个形状（`read_image` 多一个 image 块）。
 *
 * 另有两组同等重要：
 *   · **隐私**：`pwsh` 的结果里可能带出密钥 → 落盘前必须隐去（保留结构）
 *   · **TTL 清理按文件名日期判定**，认不出日期的文件**不删**（宁可留着）
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  TurnCollector,
  textOfAssistantMessage,
  resultOfToolResult,
  callOfToolCall,
} from '../src/session-bridge.mjs'
import {
  appendOp,
  appendTurnOps,
  readOps,
  listOplogs,
  pruneOplogs,
  oplogRel,
  localDayKey,
  OPLOG_TTL_DAYS,
} from '../src/oplog.mjs'

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

// ── 真实事件 fixture（照抄本机会话形状，不是猜的）──────────────────────────
const evToolCall = (turn, step, callId, name, argsObj) => ({
  type: 'tool/call',
  data: { turn, step, callId, name, arguments: JSON.stringify(argsObj) },
})
const evToolResult = (turn, step, callId, text, { isError = false, image = false } = {}) => ({
  type: 'tool/result',
  data: {
    turn,
    step,
    message: {
      source: { kind: 'tool', callId },
      content: [
        {
          type: 'tool-result',
          toolCallId: callId,
          content: [
            { type: 'text', text },
            ...(image ? [{ type: 'image', data: 'AAA' }] : []),
          ],
          ...(isError ? { isError: true } : { isError: false }),
        },
      ],
    },
  },
})
const evAssistant = (turn, step, text, usage) => ({
  type: 'assistant/message',
  data: {
    turn,
    step,
    message: { content: [{ type: 'text', text }] },
    usage,
  },
})
const evTurnEnd = (turn, reason = 'completed') => ({
  type: 'turn/end',
  data: { turn, reason: { kind: reason } },
})

const ROOT = mkdtempSync(join(tmpdir(), 'qq-bridge-oplog-'))

try {
  // ══════════════════════════════════════════════════════════════════════════
  section('① 结果提取：text 块、image 块、isError')
  // ══════════════════════════════════════════════════════════════════════════
  const r1 = resultOfToolResult(evToolResult(1, 1, 'c1', '文件已写入').data)
  check('取到文本', r1.text === '文件已写入', JSON.stringify(r1.text))
  check('字节数按**原文**算（不是截断后）', r1.bytes === '文件已写入'.length, String(r1.bytes))
  check('isError=false → 明确成功', r1.isError === false)
  check('没有图片块 → hasImage=false', r1.hasImage === false)

  const r2 = resultOfToolResult(evToolResult(1, 2, 'c2', 'cannot read', { isError: true }).data)
  check('isError=true → 明确失败', r2.isError === true)

  const r3 = resultOfToolResult(evToolResult(1, 3, 'c3', '(图)', { image: true }).data)
  check('★ 有图片块 → hasImage=true（否则会显示成"结果为空"）', r3.hasImage === true)

  const long = 'x'.repeat(1000)
  const r4 = resultOfToolResult(evToolResult(1, 4, 'c4', long).data, { excerpt: 300 })
  check('长结果被截断到 300 字 + 省略号', r4.text.length === 301 && r4.text.endsWith('…'),
    String(r4.text.length))
  check('★ 截断是刻意的：全文不入库（操作日志是索引不是仓库）', r4.bytes === 1000, String(r4.bytes))

  const r5 = resultOfToolResult({})
  check('空事件不抛、给出安全默认', r5.text === '' && r5.callId === null && r5.isError === null)

  // ══════════════════════════════════════════════════════════════════════════
  section('② 参数提取：arguments 是 **JSON 字符串**')
  // ══════════════════════════════════════════════════════════════════════════
  const c1 = callOfToolCall({ name: 'web_search', callId: 'c1', arguments: '{"queries":["a","b"]}' })
  check('★★ 字符串被解析成对象', Array.isArray(c1.args?.queries) && c1.args.queries.length === 2,
    JSON.stringify(c1.args))
  check('工具名与 callId 保留', c1.name === 'web_search' && c1.callId === 'c1')

  const c2 = callOfToolCall({ name: 'x', callId: 'c2', arguments: { a: 1 } })
  check('已经是对象的原样保留', c2.args?.a === 1)

  const c3 = callOfToolCall({ name: 'x', callId: 'c3', arguments: 'not json at all' })
  check('★ 解析不了就**留原始字符串**（不丢，参数是排查最需要的）',
    typeof c3.args === 'string' && c3.args.includes('not json'), JSON.stringify(c3.args))

  const c4 = callOfToolCall({ name: 'write', callId: 'c4', arguments: JSON.stringify({ file_path: 'a.txt', content: 'y'.repeat(800) }) }, { argChars: 100 })
  check('★ 超长参数：**结构保留**、只截长字符串值（先截字符串再解析会留下半个对象）',
    c4.args?.file_path === 'a.txt' && String(c4.args?.content).length === 101,
    JSON.stringify({ file_path: c4.args?.file_path, contentLen: String(c4.args?.content).length }))

  // ══════════════════════════════════════════════════════════════════════════
  section('③ TurnCollector：整条流水按 turn/step 收集齐全')
  // ══════════════════════════════════════════════════════════════════════════
  const tc = new TurnCollector('sess-1', { timeoutMs: 60000, label: 'test' })
  const usage = { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, totalTokens: 1050, reasoningTokens: 10 }
  tc.push(evAssistant(1, 1, '我查一下', usage))
  tc.push(evToolCall(1, 1, 'c1', 'web_search', { queries: ['克莱德洛'] }))
  tc.push(evToolResult(1, 1, 'c1', '3 条结果'))
  tc.push(evAssistant(1, 2, '查到了', usage))
  tc.push(evToolCall(1, 2, 'c2', 'write', { file_path: 'a.txt', content: 'hi' }))
  tc.push(evToolResult(1, 2, 'c2', 'Updated file'))
  tc.push(evTurnEnd(1))
  const done = await tc.finished()

  check('回合正常结束', done.endReason?.kind === 'completed', JSON.stringify(done.endReason))
  check('★ `ops` 被交出来（这是原先缺的那份原料）', Array.isArray(done.ops) && done.ops.length === 7,
    `ops=${done.ops?.length}`)

  const calls = done.ops.filter((o) => o.type === 'tool/call')
  check('★★ 两次工具调用都带**参数**（原先只留 name/callId）',
    calls.length === 2 && calls[0].args?.queries?.[0] === '克莱德洛' && calls[1].args?.file_path === 'a.txt',
    JSON.stringify(calls.map((c) => c.args)))
  check('★ 两条结果都记下了（含 ok 与字节数）',
    done.ops.filter((o) => o.type === 'tool/result').length === 2 &&
      done.ops.find((o) => o.type === 'tool/result')?.ok === true,
    JSON.stringify(done.ops.find((o) => o.type === 'tool/result')))
  check('★ 每条都带 turn/step（可回溯到 DSH 会话的那一步）',
    done.ops.every((o) => Number.isInteger(o.turn) && Number.isInteger(o.step)),
    JSON.stringify(done.ops.map((o) => [o.turn, o.step])))
  check('★ 保留原有 `toolCalls`（interim 的「先应一声」依赖它）',
    done.toolCalls.length === 2 && done.toolCalls[0].name === 'web_search')
  check('用量仍逐步累加（没被 ops 影响）', done.usage.input === 200, JSON.stringify(done.usage))
  check('assistant 记录只记字数、**不记正文**（正文已在会话镜像里，避免复制隐私面）',
    done.ops.filter((o) => o.type === 'assistant').every((o) => o.chars > 0 && o.text === undefined))

  section('④ 超时的回合**也**留下流水（与记账同理）')
  {
    // ⚠️ 这里有个**真实陷阱**，不处理就会挂住：
    //   `TurnCollector` 的超时定时器是**故意 `unref()` 的**
    //   （它不该把一个会话的等待变成"进程吊着不退"的理由）。
    //   于是如果事件循环里**没有别的 referenced 计时器**，Node 会在
    //   `await t.finished()` 处直接退出 —— 表现为
    //   `Detected unsettled top-level await` + 退出码 13，而不是断言失败。
    //   所以测试要**自己保持进程存活**：下面这个定时器不 unref。
    const keepAlive = setTimeout(() => {}, 500)
    try {
      const t2 = new TurnCollector('sess-2', { timeoutMs: 20 })
      t2.push(evToolCall(1, 1, 'c9', 'write', { file_path: 'b.txt' }))
      const r = await t2.finished()
      check('★ 超时回合仍然带着 ops（那些操作真的执行了）',
        r.timedOut === true && r.ops.some((o) => o.type === 'tool/call' && o.args?.file_path === 'b.txt'),
        JSON.stringify({ timedOut: r.timedOut, ops: r.ops?.length }))
    } finally {
      clearTimeout(keepAlive)
    }
  }

  section('④-b turn/end 没有 step → 继承上一步（否则"停在第几步"查不到）')
  {
    const t3 = new TurnCollector('sess-3', { timeoutMs: 5000 })
    t3.push(evAssistant(1, 1, 'a'))
    t3.push(evToolCall(1, 2, 'c1', 'read', {}))
    t3.push(evToolResult(1, 2, 'c1', 'ok'))
    t3.push(evTurnEnd(1))
    const r = await t3.finished()
    const end = r.ops.find((o) => o.type === 'turn/end')
    check('★ turn/end 的 step = 上一步的 step（不是 null）', end?.step === 2, JSON.stringify(end))
    check('turn 号仍然正确', end?.turn === 1, JSON.stringify(end))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑤ 落盘：按 会话+本地日期 分文件')
  // ══════════════════════════════════════════════════════════════════════════
  const WS = join(ROOT, 'ws')
  mkdirSync(WS, { recursive: true })
  const day = '2026-09-26'
  const fixed = new Date('2026-09-26T13:05:00')
  check('文件名用**本地**日期（不是 UTC）', localDayKey(fixed) === '2026-09-26', localDayKey(fixed))
  check('会话键里的 `:` 被替换（文件名安全）',
    oplogRel('group:700000001', day) === 'runtime/oplog/group_700000001-2026-09-26.jsonl',
    oplogRel('group:700000001', day))

  const w1 = appendOp({
    workspace: WS, chatKey: 'group:1', now: fixed,
    op: { at: fixed.getTime(), turn: 1, step: 1, type: 'tool/call', name: 'write', callId: 'c1', args: { file_path: 'x.txt' } },
  })
  check('写入成功且给出相对路径', w1.ok === true && w1.rel.endsWith('.jsonl'), JSON.stringify(w1))
  const written = readFileSync(join(WS, w1.rel), 'utf8').trim().split('\n')
  check('一行一条 JSONL', written.length === 1)
  const parsed = JSON.parse(written[0])
  check('落盘内容含 chatKey/turn/step/name/args', parsed.name === 'write' && parsed.args?.file_path === 'x.txt', written[0])
  check('★ 一行里没有换行（否则 JSONL 会碎）', !written[0].includes('\n'))

  section('⑥ 隐私：结果与参数里的隐私在落盘前被隐去（**保留结构**）')
  {
    const w2 = appendOp({
      workspace: WS, chatKey: 'group:1', now: fixed,
      op: {
        at: fixed.getTime(), turn: 1, step: 2, type: 'tool/call', name: 'pwsh', callId: 'c2',
        args: { command: 'echo 13800138000' },
      },
    })
    const rows = readOps({ workspace: WS, chatKey: 'group:1', limit: 10 })
    const op = rows.find((r) => r.callId === 'c2')
    check('★ 参数里的手机号被隐去', op && !JSON.stringify(op.args).includes('13800138000'),
      JSON.stringify(op?.args))
    check('★ 结构保留（仍能看出"这一步调了 pwsh 且参数被隐去"）',
      op?.name === 'pwsh' && String(JSON.stringify(op.args)).includes('隐私'), JSON.stringify(op?.args))

    const w3 = appendOp({
      workspace: WS, chatKey: 'group:1', now: fixed,
      op: {
        at: fixed.getTime(), turn: 1, step: 3, type: 'tool/result', callId: 'c3',
        ok: true, bytes: 30, excerpt: '密码：hunter2xyz',
      },
    })
    const op3 = readOps({ workspace: WS, chatKey: 'group:1', limit: 10 }).find((r) => r.callId === 'c3')
    check('★ 结果摘要里的密钥被隐去', op3 && !String(op3.excerpt).includes('hunter2xyz'),
      JSON.stringify(op3?.excerpt))
    check('隐去后仍标明类别（可查"为什么看不到内容"）',
      String(op3?.excerpt).includes('密码/密钥'), JSON.stringify(op3?.excerpt))
    check('★ 磁盘原文里也找不到隐私（不是只在读的时候遮）',
      !readFileSync(join(WS, w1.rel), 'utf8').includes('13800138000') &&
        !readFileSync(join(WS, w1.rel), 'utf8').includes('hunter2xyz'))

    // 正常内容不该被隐去
    appendOp({
      workspace: WS, chatKey: 'group:1', now: fixed,
      op: { at: fixed.getTime(), turn: 1, step: 4, type: 'tool/result', callId: 'c4', ok: true, bytes: 12, excerpt: 'Updated file' },
    })
    const op4 = readOps({ workspace: WS, chatKey: 'group:1', limit: 10 }).find((r) => r.callId === 'c4')
    check('★ 正常结果**不被**误隐（闸门不能把日志变成一片红acted）',
      op4?.excerpt === 'Updated file', JSON.stringify(op4?.excerpt))
  }

  section('⑦ 会话隔离：一个会话的日志不串到另一个')
  {
    appendOp({
      workspace: WS, chatKey: 'private:9', now: fixed,
      op: { at: fixed.getTime(), turn: 1, step: 1, type: 'tool/call', name: 'read', callId: 'p1', args: {} },
    })
    const a = readOps({ workspace: WS, chatKey: 'group:1', limit: 50 })
    const b = readOps({ workspace: WS, chatKey: 'private:9', limit: 50 })
    check('★ 按会话隔离', a.every((r) => r.chatKey === 'group:1') && b.every((r) => r.chatKey === 'private:9'),
      JSON.stringify({ a: a.length, b: b.length }))
    check('列表也按会话过滤', listOplogs({ workspace: WS, chatKey: 'private:9' }).every((f) => f.includes('private_9')))
  }

  section('⑧ 整回合批量写入')
  {
    const r = appendTurnOps({
      workspace: WS, chatKey: 'group:2',
      ops: [
        { at: Date.now(), turn: 1, step: 1, type: 'tool/call', name: 'a', callId: 'x1', args: {} },
        { at: Date.now(), turn: 1, step: 1, type: 'tool/result', callId: 'x1', ok: true, bytes: 1, excerpt: 'ok' },
      ],
    })
    check('两条都写进去了', r.written === 2 && r.total === 2, JSON.stringify(r))
    check('空数组不报错', appendTurnOps({ workspace: WS, chatKey: 'group:2', ops: [] }).written === 0)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑨ 写失败不抛异常（观测手段不能弄挂主线程）')
  // ══════════════════════════════════════════════════════════════════════════
  let threw = false
  try {
    appendOp({ workspace: '', chatKey: 'x', op: { type: 'tool/call' } })
    appendOp({ workspace: WS, chatKey: 'x', op: null })
    appendOp({ workspace: join(WS, 'nope\0bad'), chatKey: 'x', op: { type: 'tool/call' } })
  } catch {
    threw = true
  }
  check('★ 缺参/坏路径都不抛', threw === false)

  // ══════════════════════════════════════════════════════════════════════════
  section('⑩ TTL 清理：按**文件名日期**判定，认不出日期的不动')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const PWS = join(ROOT, 'prune')
    const dir = join(PWS, 'runtime', 'oplog')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'group_1-2020-01-01.jsonl'), '{}\n', 'utf8') // 很旧
    writeFileSync(join(dir, 'group_1-2099-01-01.jsonl'), '{}\n', 'utf8') // 很新
    writeFileSync(join(dir, 'weird-name.jsonl'), '{}\n', 'utf8') // 认不出日期

    const dry = pruneOplogs({ workspace: PWS, days: OPLOG_TTL_DAYS })
    check('★ 预演：报告要删哪些但**不真删**',
      dry.removed.includes('group_1-2020-01-01.jsonl') && existsSync(join(dir, 'group_1-2020-01-01.jsonl')),
      JSON.stringify(dry.removed))
    check('新的不在删除列表里', !dry.removed.includes('group_1-2099-01-01.jsonl'))
    check('★ 认不出日期的**不动**（宁可留着也不误删）', dry.skipped.includes('weird-name.jsonl'))
    check('给出 cutoff（可核对）', dry.cutoff === localDayKey(new Date(Date.now() - OPLOG_TTL_DAYS * 86400000)),
      dry.cutoff)

    const applied = pruneOplogs({ workspace: PWS, days: OPLOG_TTL_DAYS, apply: true })
    check('实做：旧的被删', applied.removed.includes('group_1-2020-01-01.jsonl') &&
      !existsSync(join(dir, 'group_1-2020-01-01.jsonl')))
    check('实做：新的与认不出的都还在',
      existsSync(join(dir, 'group_1-2099-01-01.jsonl')) && existsSync(join(dir, 'weird-name.jsonl')))
    check('目录不存在时不抛', pruneOplogs({ workspace: join(ROOT, 'nope') }).removed.length === 0)
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
if (failed === 0) {
  console.log(`🎉 操作日志测试全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
  process.exit(1)
}
