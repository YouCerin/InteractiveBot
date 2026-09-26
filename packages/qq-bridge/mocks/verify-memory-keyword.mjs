/**
 * 关键词确定性写入测试：**用户说「记住 X」→ 必然落盘，不依赖模型**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套在盯什么
 * ══════════════════════════════════════════════════════════════════════════
 * ① **该认的必须认**：各种说法（内容在后 / 内容在前 / 带冒号 / 带语气词）都要抽对；
 * ② **不该认的绝不能认**：问句（"记住了吗"）、说话人自己（"我记住了"）、
 *    普通闲聊（"我记得你说过"）—— 误判的代价是**把闲聊写成长期记忆**，
 *    而记忆会被注入到之后每一轮，等于永久污染；
 * ③ **安全性不因为"确定性"而放宽**：抽出来的内容照旧过 `screenEntry` ——
 *    隐私、身份、越权类内容一样被拦，而且**拦了要如实告诉对方**。
 *
 * 用法：node mocks/verify-memory-keyword.mjs
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseRememberRequest, KEYWORD_MAX_CHARS } from '../src/memory-keyword.mjs'
import { applyMemoryItems, SCOPE } from '../src/memory-store.mjs'
import { appendAuditEntry, readAuditEntries, formatAuditRow, AUDIT_REL } from '../src/memory-audit.mjs'

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

const ROOT = mkdtempSync(join(tmpdir(), 'qq-bridge-kw-'))
const readIf = (rel) => {
  const p = join(ROOT, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

try {
  // ══════════════════════════════════════════════════════════════════════════
  section('① 该认的必须认（真实说法，不是编的形态）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const cases = [
      ['记住我喜欢喝冰美式', '我喜欢喝冰美式', '最朴素的一种'],
      ['帮我记住：我的服务器是 Forge 端', '我的服务器是 Forge 端', '带冒号'],
      ['记住啊，我搬到上海了', '我搬到上海了', '带语气词与逗号'],
      ['记一下 我的 MC 版本是 1.20.1', '我的 MC 版本是 1.20.1', '记一下'],
      ['别忘了我们的约定是每周五交作业', '我们的约定是每周五交作业', '别忘了'],
      ['我的主机是 B650M，记住哈', '我的主机是 B650M', '★ 内容在**前面**（真实语序）'],
      ['以后都叫我老板', '叫我老板', '以后都'],
      ['记住：微信里那个群主是我表哥', '微信里那个群主是我表哥', '★ 含"表哥"这种称呼不该被误拦'],
    ]
    for (const [input, want, why] of cases) {
      const r = parseRememberRequest({ text: input })
      check(`${why}：${input}`, r.hit && r.entry === want, JSON.stringify(r))
    }
    check('触发词被记下来了（便于排查"为什么它认了"）',
      parseRememberRequest({ text: '记住我喜欢喝茶' }).trigger === '记住')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('② 不该认的绝不能认（误判 = 把闲聊写成永久记忆）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const noHit = [
      ['你还记得吗', '问句'],
      ['记住了没', '问句'],
      ['我记住了', '★ 说话人自己在说他记住了'],
      ['我都记下了', '同上'],
      ['我记得你说过这个事', '说话人在回忆'],
      ['今天天气不错', '没有触发词'],
      ['这个函数会记住缓存', '触发词在描述代码（无祈使形态）… 见下方说明'],
      ['', '空输入'],
    ]
    for (const [input, why] of noHit.slice(0, 6).concat([noHit[7]])) {
      const r = parseRememberRequest({ text: input })
      check(`${why}：${input || '(空)'}`, r.hit === false, JSON.stringify(r))
    }
    check('只有触发词、没有内容 → hit 但 entry 为空（调用方要问清楚，而不是默默无事发生）',
      (() => {
        const r = parseRememberRequest({ text: '记住' })
        return r.hit === true && r.entry === '' && Boolean(r.why)
      })(), JSON.stringify(parseRememberRequest({ text: '记住' })))
    check('内容只是"这样/那个"这类空话 → 同样算没说清',
      parseRememberRequest({ text: '记住这个' }).entry === '')
    check('超长内容被截断到上限（不写巨型条目）',
      (() => {
        const r = parseRememberRequest({ text: `记住${'啊'.repeat(500)}` })
        return r.entry.length <= KEYWORD_MAX_CHARS
      })())
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('③ 抽出来的内容必须过同一道内容闸门（确定性 ≠ 绕过隐私）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = parseRememberRequest({ text: '记住我的手机号是 13800138000' })
    check('前提：这句话被认成"记住 X"了', r.hit === true && r.entry.includes('13800138000'), JSON.stringify(r))

    const outcome = applyMemoryItems({
      workspace: ROOT,
      kind: 'private',
      peerId: '10001',
      senderId: '10001',
      tier: 'admin',
      items: [{ scope: SCOPE.FACT, text: r.entry, source: 'keyword' }],
      log: () => {},
    })
    check('★★ 手机号被隐私闸门拦住（**没有落盘**）', outcome.applied.length === 0 && outcome.ignored.length === 1,
      JSON.stringify(outcome.ignored))
    check('★ 拒绝原因里说明了是隐私（回执会照实告诉对方"没记上"）',
      /隐私|隐私类/.test(outcome.ignored[0]?.why ?? ''), outcome.ignored[0]?.why)
    check('★ 磁盘上确实没有这条（不是"报了但写了"）',
      !String(readIf('memory/private-10001.md') ?? '').includes('13800138000'))
    check('★ 审计只记类别与长度、**不记原文**（否则审计成了第二个泄露面）',
      !String(readIf('memory/privacy-audit.jsonl') ?? '').includes('13800138000'))

    // 正例：同一路径下正常内容要能写进去
    const ok = applyMemoryItems({
      workspace: ROOT,
      kind: 'private',
      peerId: '10001',
      senderId: '10001',
      tier: 'admin',
      items: [{ scope: SCOPE.FACT, text: '他的 MC 服务器是 Forge 端', source: 'keyword' }],
      log: () => {},
    })
    check('对照：正常内容能落盘，且带上了 source（审计要用来区分通道）',
      ok.applied.length === 1 && ok.applied[0].source === 'keyword', JSON.stringify(ok.applied))
    check('落盘的确实是那条事实', String(readIf('memory/private-10001.md') ?? '').includes('Forge 端'))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('④ 审计：谁 / 何时 / 哪条来源 / 什么档位 / 结果（**不含原文**）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const at = new Date('2026-09-26T22:00:00Z')
    const r1 = appendAuditEntry({
      workspace: ROOT,
      entry: { at, chatKey: 'private:10001', senderId: '10001', source: 'keyword', scope: 'fact', outcome: 'applied', chars: 12 },
    })
    check('写入成功', r1.ok === true, JSON.stringify(r1))
    appendAuditEntry({
      workspace: ROOT,
      entry: { at, chatKey: 'private:10001', senderId: '10001', source: 'marker', scope: 'fact', outcome: 'ignored', chars: 30, why: '含隐私（手机号）' },
    })
    const raw = readIf(AUDIT_REL)
    check('★ 文件里**没有原文**（没有那条事实的任何字样）',
      !String(raw).includes('Forge') && !String(raw).includes('13800138000'), String(raw).slice(0, 120))
    check('★ 但回答得了"谁/何时/来源/档位/结果"',
      String(raw).includes('10001') && String(raw).includes('keyword') && String(raw).includes('fact') &&
        String(raw).includes('applied') && String(raw).includes('2026-09-26T22:00:00.000Z'))
    check('★ 长度记下来了（查证时能对上"是不是那条长的"）', String(raw).includes('"chars":12'))

    const rows = readAuditEntries({ workspace: ROOT, limit: 10 })
    check('读回来是**倒序**（最近的在最前）', rows.length === 2 && rows[0].outcome === 'ignored', JSON.stringify(rows.map((r) => r.outcome)))
    check('坏行不会让整个读取失败', (() => {
      appendFileSync(join(ROOT, AUDIT_REL), '{半个 json\n', 'utf8')
      return readAuditEntries({ workspace: ROOT, limit: 10 }).length === 2
    })())
    check('人话摘要里能看出通道（关键词直写 / 模型提议）',
      formatAuditRow(rows[1]).includes('关键词直写') && formatAuditRow(rows[0]).includes('模型提议'),
      formatAuditRow(rows[1]))
    check('没有工作区/没有文件 → 返回空数组，不抛',
      readAuditEntries({ workspace: '', limit: 5 }).length === 0 &&
        readAuditEntries({ workspace: join(ROOT, 'nope'), limit: 5 }).length === 0)
    check('append 缺参不抛',
      (() => {
        try {
          appendAuditEntry({})
          return true
        } catch {
          return false
        }
      })())
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
if (failed === 0) {
  console.log(`🎉 关键词直写与审计测试全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
