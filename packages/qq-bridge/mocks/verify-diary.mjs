// 回归断言：她的日记（0.3.3）—— 纯文本、两个动作、别替她写。
// 用法：node mocks/verify-diary.mjs
//
// 这一套盯的是**使用者给的那几条规矩**，不是实现的内部结构：
//   ① 一个文件夹 + 一个 `.jsonl`，一行一条（人能手改、能 grep、能双击打开）；
//   ② **只有两个动作**：写一条 / 看最近几条 —— 没有删除、没有改日期、没有"帮她润色"；
//   ③ 一天最多三条、每条一两句（超了如实拒）；
//   ④ **不规定写什么**：代码不审查内容，规劝只写在工具描述里；
//   ⑤ **不固定时间**：没有定时器、没有"今天还没写"的提醒、**不进提示词**。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as diaryMod from '../src/diary.mjs'
import { DIARY, appendDiary, countOnDay, diaryPath, formatDiaryTime, readRecentDiary, renderRecentDiary } from '../src/diary.mjs'

let failures = 0
let passed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (ok) passed += 1
  else failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──────────────────────────────`)
}
const ws = () => mkdtempSync(join(tmpdir(), 'qqb-diary-'))
const lines = (file) => readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim())
const DAY = (d, h = 12, m = 0) => new Date(2026, 9, d, h, m, 0) // 2026-10-<d>

// ══════════════════════════════════════════════════════════════════════════
section('① 落点与形状：一个文件夹、一个 .jsonl、一行一条')
// ══════════════════════════════════════════════════════════════════════════
{
  const W = ws()
  const r = appendDiary({ workspace: W, text: '楼下那棵树今天开始黄了', mood: '有点凉', now: DAY(3, 9, 7) })
  const file = join(W, 'diary', 'diary.jsonl')
  check('★★ 写在 `diary/diary.jsonl`（使用者要的"最土的纯文本"）', r.ok === true && r.wroteTo === file, String(r.wroteTo ?? r.why))
  check('  └ 目录也一起建出来了（不用人先动手）', existsSync(join(W, 'diary')) === true)
  check('★ 一行一条：文件里就一行、且以换行结尾',
    lines(file).length === 1 && readFileSync(file, 'utf8').endsWith('\n'),
    `${lines(file).length} 行`)

  const row = JSON.parse(lines(file)[0])
  check('★★ 字段就是那三个：时间 / 心情 / 内容（人能读懂、能手改）',
    Object.keys(row).sort().join(',') === ['内容', '心情', '时间'].sort().join(','),
    Object.keys(row).join(','))
  check('★ 时间形如 `YYYY-MM-DD HH:mm`', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(row.时间), row.时间)
  check('★ 时间是**本地时间**（她写的是"今天"，不是 UTC 的今天）',
    row.时间 === '2026-10-03 09:07', row.时间)
  check('★ 心情是短标签，不是一句话（超长会被截成 12 字）',
    appendDiary({ workspace: W, text: 'x', mood: '一二三四五六七八九十十一十二十三', now: DAY(4) }).entry.心情.length === 12)

  // 时间**由系统给**：调用方给不了别的日子
  const W2 = ws()
  const noDate = appendDiary({ workspace: W2, text: '随手一条', 日期: '2000-01-01', time: '2000-01-01', 时间: '2000-01-01' })
  check('★★ 不能指定成别的日子（`日期`/`time`/`时间` 参数一律无效）',
    noDate.ok === true && !String(noDate.entry.时间).startsWith('2000'), noDate.entry?.时间)
  const nowish = formatDiaryTime()
  check('★ 不给 now 时用"现在"', String(noDate.entry.时间).slice(0, 10) === nowish.slice(0, 10), noDate.entry?.时间)
  check('formatDiaryTime 补零（09:07 不是 9:7）', formatDiaryTime(DAY(3, 9, 7)) === '2026-10-03 09:07')
  rmSync(W, { recursive: true, force: true })
  rmSync(W2, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('② 一天最多三条（使用者给的规则；超了如实拒，不偷偷丢弃）')
// ══════════════════════════════════════════════════════════════════════════
{
  const W = ws()
  const a = appendDiary({ workspace: W, text: '一', now: DAY(5, 8) })
  const b = appendDiary({ workspace: W, text: '二', now: DAY(5, 12) })
  const c = appendDiary({ workspace: W, text: '三', now: DAY(5, 20) })
  const d = appendDiary({ workspace: W, text: '四', now: DAY(5, 23) })
  check('★ 前三条都写得进去', a.ok && b.ok && c.ok, [a, b, c].map((x) => x.ok).join(','))
  check('★★ 第四条被拒（一天三条上限）', d.ok === false && /上限/.test(String(d.why)), String(d.why))
  check('  └ 并且告诉她"留到明天"（不是"出错"）', /明天/.test(String(d.why)), String(d.why))
  check('★ 被拒的那条**没落盘**（文件里还是三行）', lines(join(W, 'diary', 'diary.jsonl')).length === 3)
  check('★ 数的是"这一天"，不是"一共"', countOnDay([{ 时间: '2026-10-05 08:00' }], '2026-10-05') === 1)
  const next = appendDiary({ workspace: W, text: '第二天的', now: DAY(6, 9) })
  check('★ 换一天就能继续写（按日期前缀数，不是按总条数）', next.ok === true, String(next.why))
  rmSync(W, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 每条一两句：长度上限，且空条不落盘')
// ══════════════════════════════════════════════════════════════════════════
{
  const W = ws()
  const long = '啊'.repeat(DIARY.maxChars + 1)
  const r1 = appendDiary({ workspace: W, text: long, now: DAY(7) })
  check(`★★ 超过 ${DIARY.maxChars} 字被拒（"一两句"是规则，不是建议）`, r1.ok === false && /太长/.test(String(r1.why)), String(r1.why))
  const r2 = appendDiary({ workspace: W, text: '啊'.repeat(DIARY.maxChars), now: DAY(7) })
  check('★ 正好 200 字可以（边界不是差一）', r2.ok === true, String(r2.why))
  check('★ 空内容 / 纯空白不落盘（不写空行）', appendDiary({ workspace: W, text: '   ', now: DAY(7, 13) }).ok === false)
  check('★ 多行被压成一行（一行一条的 JSONL 不能被换行撑破）',
    appendDiary({ workspace: W, text: '第一句\n第二句', now: DAY(8) }).entry.内容 === '第一句 第二句')
  check('缺 workspace ⇒ 明确拒绝，不猜路径', appendDiary({ workspace: '', text: 'x' }).ok === false)
  rmSync(W, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 隐私闸：日记也会一直躺在盘上，与记忆同一条纪律')
// ══════════════════════════════════════════════════════════════════════════
{
  const W = ws()
  const phone = appendDiary({ workspace: W, text: '他手机号是 13812345678', now: DAY(9) })
  check('★★ 手机号被挡（并且说清"日记会一直躺在盘上"）',
    phone.ok === false && /隐私|手机号|电话/.test(String(phone.why)), String(phone.why))
  check('  └ 回执给的是**中文类别**，不是内部键名 phone', /手机号/.test(String(phone.why)), String(phone.why))
  const idcard = appendDiary({ workspace: W, text: '身份证 11010519491231002X', now: DAY(9) })
  check('★ 身份证号被挡（过校验位的那个号）', idcard.ok === false && /身份证/.test(String(idcard.why)), String(idcard.why))
  check('★ 正常内容不误杀', appendDiary({ workspace: W, text: '今天吃的面有点咸', now: DAY(9) }).ok === true)
  rmSync(W, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 只有两个动作：没有删除、没有改、没有"帮她写完"')
// ══════════════════════════════════════════════════════════════════════════
{
  const names = Object.keys(diaryMod)
  check('★★ 模块只导出"写 + 读 + 渲染 + 纯工具函数"',
    names.every((n) => /^(appendDiary|readRecentDiary|renderRecentDiary|diaryPath|formatDiaryTime|countOnDay|DIARY)$/.test(n)),
    names.join(','))
  check('★★ 没有任何删除/编辑/改日期的入口',
    !names.some((n) => /(delete|remove|edit|update|write.?at|setDate|backfill|rewrite|fix)/i.test(n)), names.join(','))
  check('★ 也没有"按日期生成 / 补写某天"的入口',
    !names.some((n) => /(schedule|cron|timer|daily|forDay|seed|generate)/i.test(n)), names.join(','))
  check('★ 配置里只有形状参数（没有"内容要求"这类键）',
    Object.keys(DIARY).sort().join(',') === ['dir', 'file', 'maxChars', 'maxMoodChars', 'maxPerDay'].sort().join(','),
    Object.keys(DIARY).join(','))
  check('DIARY 是冻结的（别让运行期改「一天三条」）', Object.isFrozen(DIARY) === true)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 读：最近几条，坏行跳过（手改过的文件不能把读弄崩）')
// ══════════════════════════════════════════════════════════════════════════
{
  const W = ws()
  check('★ 还没有日记 ⇒ ok 且是空的（不是错误）', (() => { const r = readRecentDiary({ workspace: W }); return r.ok === true && r.entries.length === 0 && r.total === 0 })())
  check('★ 空的渲染成「日记还是空的」（不编内容）', /还是空的/.test(renderRecentDiary(readRecentDiary({ workspace: W }))))

  // ★ 一天三条：这五条要**分别落在五天**（否则第 4 条就被上限拒了，测不到 limit）
  for (let i = 1; i <= 5; i += 1) appendDiary({ workspace: W, text: `第${i}条`, now: DAY(20 + i, 8 + i) })
  const r2 = readRecentDiary({ workspace: W, limit: 2 })
  check('★★ limit 生效，给的是**最近**两条（不是最早两条）',
    r2.entries.length === 2 && r2.entries[1].内容 === '第5条' && r2.entries[0].内容 === '第4条',
    r2.entries.map((e) => e.内容).join(' / '))
  check('★ total 是总条数（提示"还有多少"靠它）', r2.total === 5, String(r2.total))
  check('★ limit 非法/0 时按默认 5 条（不是返回空、也不是返回全部）',
    readRecentDiary({ workspace: W, limit: 0 }).entries.length === 5,
    String(readRecentDiary({ workspace: W, limit: 0 }).entries.length))
  check('★ 渲染原样列出来（不解释、不点评）',
    /第5条/.test(renderRecentDiary(r2)) && /一共 5 条/.test(renderRecentDiary(r2)), renderRecentDiary(r2).split('\n')[0])

  // 手改坏的两种：不是 JSON、缺字段
  const file = join(W, 'diary', 'diary.jsonl')
  appendFileSync(file, '这不是 JSON\n', 'utf8')
  appendFileSync(file, JSON.stringify({ 时间: '2026-10-11 09:00' }) + '\n', 'utf8')
  const r3 = readRecentDiary({ workspace: W, limit: 50 })
  check('★★ 坏行跳过并计数（skipped），不抛错', r3.ok === true && r3.skipped === 2, `skipped=${r3.skipped}`)
  check('★ 好行不受影响', r3.entries.length === 5, String(r3.entries.length))
  check('渲染里也说了"另有几行读不出来"（别悄悄吞掉）', /读不出来/.test(renderRecentDiary(r3)))

  // 手改时漏了结尾换行：追加前要补一个，否则两行会粘成一行
  const W2 = ws()
  mkdirSync(join(W2, 'diary'), { recursive: true })
  writeFileSync(join(W2, 'diary', 'diary.jsonl'), JSON.stringify({ 时间: '2026-10-01 08:00', 心情: '', 内容: '老的一条' }), 'utf8')
  appendDiary({ workspace: W2, text: '新的一条', now: DAY(2) })
  const l2 = lines(join(W2, 'diary', 'diary.jsonl'))
  check('★★ 上一行缺换行时先补换行（两行不许粘成一行）', l2.length === 2 && JSON.parse(l2[1]).内容 === '新的一条', `${l2.length} 行`)
  check('★ 缺文件的目录结构不对也不崩', readRecentDiary({ workspace: join(W2, '不存在') }).ok === true)
  rmSync(W, { recursive: true, force: true })
  rmSync(W2, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ 别替她写：代码**不审查内容**，规劝只在工具描述里')
// ══════════════════════════════════════════════════════════════════════════
{
  const W = ws()
  const summary = '今天真是充实的一天'
  const r = appendDiary({ workspace: W, text: summary, now: DAY(12) })
  check('★★ "总结句"会被**原样收下**（该说的是工具描述，不是代码里的内容审查）',
    r.ok === true && r.entry.内容 === summary, String(r.why))
  check('★ 内容不被改写（除了压空白）',
    appendDiary({ workspace: W, text: '  中间   有空格  ', now: DAY(12, 13) }).entry.内容 === '中间 有空格')
  check('★ 心情可以不填（一个空字符串，不是"无"）',
    appendDiary({ workspace: W, text: '没心情', now: DAY(12, 14) }).entry.心情 === '')
  rmSync(W, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('⑧ 模型看到的工具契约（描述里**不许**出现"你应该记录今天发生的事"）')
// ══════════════════════════════════════════════════════════════════════════
{
  const { TOOLS, runTool } = await import('../mcp/mcp-qq-server.mjs')
  const { described } = await import('../mcp/mcp-qq-server.mjs')
  const write = TOOLS.find((t) => t.name === 'diary_write')
  const read = TOOLS.find((t) => t.name === 'diary_read')
  check('★★ 有两个工具：diary_write / diary_read', Boolean(write) && Boolean(read))
  check('★ 都走本地实现（不经过 OneBot）', write?.local === 'diaryWrite' && read?.local === 'diaryRead')
  check('★ 都不是 adminOnly（她自己的本子，不是管理员操作）', write?.adminOnly === false && read?.adminOnly === false)
  check('★★ 描述里没有"你应该记录今天发生的事"', !/你应该记录|记录今天发生的事/.test(String(write?.description)))
  check('★★ 描述是"你可以写点什么"，不是"该写点什么"',
    /想到什么就写什么/.test(String(write?.description)) && /不想写就不写/.test(String(write?.description)))
  check('★ 规矩写在契约里（一天三条 / 一两句）',
    /一天最多三条/.test(String(write?.description)) && /一两句/.test(String(write?.description)))
  check('★ 明说别写总结句（规劝放在这里，不放进角色卡的例文）',
    /总结句/.test(String(write?.description)))
  check('★ 写只需要 text；心情可选', JSON.stringify(write?.inputSchema?.required) === '["text"]')
  check('★★ 工具表里**没有**删除/修改日记的工具', !TOOLS.some((t) => /^diary_/.test(t.name) && !/^diary_(write|read)$/.test(t.name)),
    TOOLS.filter((t) => /^diary_/.test(t.name)).map((t) => t.name).join(','))

  // ★★ 权限提示不能"张冠李戴"：`diary_write` 是**写**，套上"只读动作"就是在骗模型。
  const wDesc = described(write) ?? ''
  const rDesc = described(read) ?? ''
  check('★★ diary_write 的档位提示里没有"只读动作"', !/只读动作/.test(wDesc), wDesc.split('\n').slice(-2).join(' ').slice(0, 60))
  check('★ diary_write 明说"只写不改不删"', /只写不改不删/.test(wDesc))
  check('★ diary_read 说清读的是她自己写的日记（不是别人的聊天记录）', /她自己写的日记/.test(rDesc))
  check('★ 两个提示都保留"如实"那句（失败就是没做成）', /没做成/.test(wDesc) && /没做成/.test(rDesc))

  // 真机路径：runTool 走一遍（临时工作区）
  const { __setConfig } = await import('../mcp/mcp-qq-server.mjs')
  const W = ws()
  const prev = { workspace: process.cwd() }
  try {
    __setConfig({ httpUrl: 'http://127.0.0.1:9', selfId: '1', workspace: W })
    const w = await runTool('diary_write', { text: '桥接那条路也能写', mood: '试试' })
    check('★★ runTool(diary_write) 落到工作区', w.isError === false && existsSync(join(W, 'diary', 'diary.jsonl')), String(w.text).slice(0, 60))
    check('  └ 回执里带上写好的那条（她能看到自己写了什么）', /桥接那条路也能写/.test(String(w.text)))
    const rd = await runTool('diary_read', { limit: 3 })
    check('★ runTool(diary_read) 原样读回来', rd.isError === false && /桥接那条路也能写/.test(String(rd.text)))
    const bad = await runTool('diary_read', { limit: 'abc' })
    check('★ 参数乱给也不崩（limit 非数字按默认）', bad.isError === false, String(bad.text).slice(0, 40))

    // 只读档位：日记不是管理员操作，**仍然可用**
    __setConfig({ httpUrl: 'http://127.0.0.1:9', selfId: '1', workspace: W, profile: 'readonly' })
    const ro = await runTool('diary_write', { text: '只读档位也能写' })
    check('★ profile=readonly 下仍可写（她自己的本子）', ro.isError === false, String(ro.text).slice(0, 40))
  } finally {
    __setConfig({ httpUrl: 'http://127.0.0.1:9', selfId: '1', ...prev })
    rmSync(W, { recursive: true, force: true })
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑨ 不固定时间、不进提示词（最容易被"补上"的两件事）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★ 只看**代码**，不看注释：注释里正说着"没有定时器/没有提醒"，扫全文必然自打脸。
  const codeOf = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
  const src = codeOf(readFileSync(new URL('../src/diary.mjs', import.meta.url), 'utf8'))
  check('★★ 没有定时器（setInterval / setTimeout / cron）', !/setInterval|setTimeout|cron/i.test(src))
  check('★★ 没有"今天还没写"的提醒', !/还没写/.test(src))
  check('★ 没有按日期生成的路口', !/forDay|generate/i.test(src))

  // 不进提示词：几个拼提示词的模块里**不许**出现 diary
  const promptFiles = ['memory-store.mjs', 'persona.mjs', 'channel-prompt.mjs', 'bridge.mjs']
  for (const f of promptFiles) {
    const p = new URL(`../src/${f}`, import.meta.url)
    const text = existsSync(p) ? readFileSync(p, 'utf8') : ''
    check(`★ ${f} 不引用日记（不注入：日记该她自己去翻）`, !/diary/i.test(text), text ? '' : '文件不存在，跳过')
  }
}

console.log(`\n${failures === 0 ? '🎉' : '⚠️'} 她的日记测试${failures === 0 ? '全部通过' : `有 ${failures} 项失败`}（${passed} 项）`)
process.exit(failures === 0 ? 0 : 1)
