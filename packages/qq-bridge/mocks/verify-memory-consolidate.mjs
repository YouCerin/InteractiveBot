/**
 * 记忆整理（规则版）测试。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套最要紧的一条是 **幂等性**
 * ══════════════════════════════════════════════════════════════════════════
 * 整理函数会被**周期调用**（自动整理），所以它必须满足：整理过的文件再整理一次
 * **不再变化**。否则每跑一次条目数就漂移一点，谁也不知道最终变成什么。
 *
 * 这不是假想的担心 —— 第一版渲染器**就不幂等**，实测被这里抓到：
 * 它给条目的**每一行**都加了 `- ` 前缀，于是缩进续行
 * （`  1) 小概率…`）被写成 `-   1) 小概率…`；下一次解析时那行**变成了独立条目**。
 *
 * 另有两条同等重要的：
 *   · **分节结构不许被拍平**（`MEMORY.md` 有 4 个日期分节、`self-unknowns.md` 有 4 个分节）
 *   · **快照必须刷新** —— 不刷新的话整理结果会在下一次读记忆时被
 *     `verifyAndRestoreMemory` 回滚掉（表现成"整理完它自己变回去了"）
 *
 * 全程临时目录，不碰真实记忆。
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  parseEntries,
  entryText,
  tidyText,
  normalizeForCompare,
  similarity,
  isNoInfoAfterAttribution,
  consolidateEntries,
  renderLines,
  consolidateFile,
  createConsolidateScheduler,
  CONSOLIDATE_INTERVAL_MS,
  CONSOLIDATE_MIN_INTERVAL_MS,
} from '../src/memory-consolidate.mjs'
import { saveSnapshot, verifyAndRestoreMemory, listMemoryFiles } from '../src/memory-store.mjs'

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

/** 整理一段文本（纯函数链），返回渲染后的全文。 */
function consolidate(raw, opts) {
  const parsed = parseEntries(raw)
  const r = consolidateEntries(parsed.lines, opts)
  return { out: renderLines(r.lines), ...r }
}

const ROOT = mkdtempSync(join(tmpdir(), 'qq-bridge-compact-'))

try {
  // ══════════════════════════════════════════════════════════════════════════
  section('① 解析：多行条目、标题、空行各归各位')
  // ══════════════════════════════════════════════════════════════════════════
  const DOC = [
    '# 某个人的档案',
    '',
    '- 约定：做完就行',
    '- 2026-09-26 据他说，他在做的两个功能：', // ← 日期 + 转述前缀都该被摘掉
    '  1) 表情包',
    '  2) 先应一声',
    '   我给的思路：离线打标签',
    '',
    '## 2026-09-26 追加',
    '',
    '- 他在用 DSH',
    '',
  ].join('\n')

  const parsed = parseEntries(DOC)
  const entries = parsed.lines.filter((n) => n.type === 'entry')
  check('★★ 多行条目算**一条**（修之前：1 条 + 3 个孤儿行）', entries.length === 3,
    JSON.stringify(entries.map((e) => entryText(e).slice(0, 14))))
  check('★ 多行条目的续行被收进同一条',
    entryText(entries[1]).includes('1) 表情包') && entryText(entries[1]).includes('我给的思路'))
  check('★ 小标题**不是**条目（修之前变成 `- ## 2026-09-26 追加`）',
    parsed.lines.some((n) => n.type === 'heading' && n.text.startsWith('## 2026-09-26')))
  check('★ 空行**不是**条目（修之前产出只有空白的"条目"）',
    parsed.lines.filter((n) => n.type === 'blank').length > 0 &&
      !entries.some((e) => entryText(e).trim() === ''))

  // ══════════════════════════════════════════════════════════════════════════
  section('② 幂等：整理过的文件再整理一次必须不再变化')
  // ══════════════════════════════════════════════════════════════════════════
  const once = consolidate(DOC)
  check('第一遍有改动（摘掉了行首的日期与转述前缀）', once.out !== DOC,
    JSON.stringify(entryText(once.lines.find((n) => n.type === 'entry' && n.text.includes('两个功能')))))
  check('★ 日期与转述前缀确实被摘掉',
    once.out.includes('- 他在做的两个功能：') && !once.out.includes('据他说'),
    JSON.stringify(once.out.split('\n')[4]))
  const twice = consolidate(once.out)
  check('★★ 第二遍**无变化**（幂等 —— 续行不再被加 `- ` 前缀）', twice.out === once.out,
    JSON.stringify({ first: once.out.slice(0, 60), second: twice.out.slice(0, 60) }))
  check('第二遍 `changed` 意义上的条目数不漂移', twice.after === once.after,
    `${once.after} → ${twice.after}`)
  check('★ 续行仍以缩进形式存在（没有被提升成条目）',
    once.out.includes('\n  1) 表情包'), JSON.stringify(once.out.split('\n').slice(3, 7)))

  // ══════════════════════════════════════════════════════════════════════════
  section('③ 标点归一：只动中文语境，不动数字/URL/英文')
  // ══════════════════════════════════════════════════════════════════════════
  check('中文旁的半角逗号 → 全角', tidyText('据他说,他每天花30块') === '他每天花30块',
    tidyText('据他说,他每天花30块'))
  check('中文旁的半角冒号 → 全角', tidyText('约定:做完就行') === '约定：做完就行', tidyText('约定:做完就行'))
  check('千分位逗号**不被**改动', tidyText('价格是 1,000 元') === '价格是 1,000 元', tidyText('价格是 1,000 元'))
  check('英文里的逗号**不被**改动', tidyText('a,b 两个参数') === 'a,b 两个参数', tidyText('a,b 两个参数'))
  check('URL 里的冒号**不被**改动',
    tidyText('https://example.com/a') === 'https://example.com/a', tidyText('https://example.com/a'))
  check('中文旁的半角括号 → 全角', tidyText('堆放处(store)') === '堆放处（store）', tidyText('堆放处(store)'))
  check('括号内含中文 → 全角', tidyText('(store 堆放处)') === '（store 堆放处）', tidyText('(store 堆放处)'))
  check('纯英文括号**不被**改动', tidyText('use (x) here') === 'use (x) here', tidyText('use (x) here'))
  check('★ 一对括号整体判定：不会只换半边',
    tidyText('堆放处(store)') === '堆放处（store）' && tidyText('(only english)') === '(only english)',
    `${tidyText('堆放处(store)')} / ${tidyText('(only english)')}`)
  check('★ 已是半全角的畸形输入**保持不动**（不装作能修好它）',
    tidyText('（甲）(乙）') === '（甲）(乙）', tidyText('（甲）(乙）'))
  check('畸形输入不抛异常', tidyText('(') === '(' && tidyText('a)b') === 'a)b')

  // ══════════════════════════════════════════════════════════════════════════
  section('④ 去冗余前缀：行首日期与转述（这是减少噪音的主力）')
  // ══════════════════════════════════════════════════════════════════════════
  check('行首日期被去掉', tidyText('2026-09-26 他在做 MC 服务器') === '他在做 MC 服务器')
  check('行首「据他说，」被去掉', tidyText('据他说，他每天花30块') === '他每天花30块')
  check('行首「他说」被去掉', tidyText('他说他的服务器是 Forge 端') === '他的服务器是 Forge 端')
  check('行首「他提到」被去掉', tidyText('他提到主板卡在 POST 码 B7') === '主板卡在 POST 码 B7')
  check('★ 句中的"他说"**不动**（可能是有意义的转述方）',
    tidyText('张三说他不行') === '张三说他不行', tidyText('张三说他不行'))
  check('★ 「我提醒…」**不动**（判断"整条是不是模型自述"属语义判断，留给 LLM 版）',
    tidyText('我提醒 Forge 与 Paper 的差别') === '我提醒 Forge 与 Paper 的差别')
  check('「他希望…」被去掉', tidyText('他希望机器人能管 MC 服务器') === '机器人能管 MC 服务器')

  section('⑤ 只有转述前缀的条目应当被丢弃')
  check('「他说」→ 无信息量', isNoInfoAfterAttribution('他说') === true)
  check('「据他说，」→ 无信息量', isNoInfoAfterAttribution('据他说，') === true)
  check('有内容的**不**被判为空', isNoInfoAfterAttribution('他说他在做 MC 服务器') === false)
  check('不含转述前缀的正常条目**不**受影响', isNoInfoAfterAttribution('约定：做完就行') === false)

  // ══════════════════════════════════════════════════════════════════════════
  section('⑥ 去重与合并：只留一条，且记明并掉了什么')
  // ══════════════════════════════════════════════════════════════════════════
  const dupDoc = [
    '- 约定：戳一戳不用回已收到',
    '- 2026-09-26 约定：戳一戳不用回已收到', // 去掉日期后与第一条完全相同
  ].join('\n')
  const dupRes = consolidate(dupDoc)
  check('★ 完全重复被去掉（只留一条）', dupRes.after === 1, `after=${dupRes.after}`)
  check('被去重的条目**记录在案**（不静默丢弃）',
    dupRes.droppedDuplicates.length === 1 &&
      typeof dupRes.droppedDuplicates[0].sameAs === 'string',
    JSON.stringify(dupRes.droppedDuplicates))

  const simDoc = [
    '- 他在给 InteractiveRobot 加表情包功能',
    '- 他在给 InteractiveRobot 加表情包功能，卡在省 token',
  ].join('\n')
  const simRes = consolidate(simDoc, { threshold: 0.6 })
  check('★ 高相似的两条被合并成一条', simRes.after === 1, `after=${simRes.after}`)
  check('★ 合并保留**更长**的那条（信息更多）',
    simRes.lines.find((n) => n.type === 'entry').text.includes('卡在省 token'),
    JSON.stringify(simRes.lines.find((n) => n.type === 'entry')?.text))
  check('并掉的原文记录在案', simRes.merged.length === 1 && Boolean(simRes.merged[0].mergedAway))

  section('⑦ 合并不跨分节（分节是人的分类意图）')
  const crossDoc = [
    '## 甲节',
    '- 同一句说明',
    '## 乙节',
    '- 同一句说明',
  ].join('\n')
  const crossRes = consolidate(crossDoc)
  check('★ 两个分节下的相同条目**不被并到一起**', crossRes.after === 2, `after=${crossRes.after}`)

  section('⑧ 分节结构必须原样保留（不许拍平）')
  check('标题行原样保留',
    crossRes.out.includes('## 甲节') && crossRes.out.includes('## 乙节'),
    JSON.stringify(crossRes.out))

  // ══════════════════════════════════════════════════════════════════════════
  section('⑨ 真实形状：带分节的长文档整理后仍是同一个文档')
  // ══════════════════════════════════════════════════════════════════════════
  const bigDoc = [
    '# 全局记忆（对所有聊天生效：私聊 + 每个群）',
    '',
    '- 第一条全局内容',
    '- 第二条全局内容',
    '',
    '## 2026-09-26 桥接新增能力',
    '',
    '- 【本会话新增·身份核实】桥接会核实发言人身份',
    '- 【本会话新增·会话名】控制台显示群名',
    '',
    '## 2026-09-26 追加：版本 0.2.0',
    '',
    '- 【版本】桥接当前是 0.2.0',
    '',
  ].join('\n')
  const big1 = consolidate(bigDoc)
  check('条数不变（这些条目本来就干净）', big1.after === 5, `after=${big1.after}`)
  check('★ 4 个分节标题一个不少',
    ['## 2026-09-26 桥接新增能力', '## 2026-09-26 追加：版本 0.2.0'].every((h) => big1.out.includes(h)))
  check('★ 与原文逐字相同（没被改动就不该重写它）', big1.out.trim() === bigDoc.trim(),
    JSON.stringify(big1.out.slice(0, 80)))
  check('★ 再整理一次仍无变化', consolidate(big1.out).out === big1.out)
  check('相似度自检：完全不同 → 低分', similarity('甲乙丙丁', '戊己庚辛') < 0.2,
    String(similarity('甲乙丙丁', '戊己庚庚')))
  check('相似度自检：仅时序不同 → 满分',
    similarity('约定：做完就行', '2026-09-26 约定：做完就行') === 1,
    String(similarity('约定：做完就行', '2026-09-26 约定：做完就行')))
  check('normalizeForCompare 抹掉日期与转述',
    normalizeForCompare('据他说，他每天花30块') === normalizeForCompare('他每天花30块'))

  // ══════════════════════════════════════════════════════════════════════════
  section('⑩ 写盘：备份 + 快照刷新（不刷新会被回滚）')
  // ══════════════════════════════════════════════════════════════════════════
  const WS = join(ROOT, 'ws')
  mkdirSync(join(WS, 'memory'), { recursive: true })
  const rel = 'memory/private-123.md'
  const original = '# 某人\n\n- 据他说，他每天花30块\n'
  writeFileSync(join(WS, rel), original, 'utf8')
  // 先建立"桥接写下的"快照基准，模拟真实情况
  saveSnapshot({ workspace: WS, rel })

  const dry = consolidateFile({ workspace: WS, rel, apply: false, saveSnapshot })
  check('预演（apply=false）**不写盘**', readFileSync(join(WS, rel), 'utf8') === original)
  check('预演也给出了计划', dry.changed === true && dry.plan.after === 1)

  const applied = consolidateFile({ workspace: WS, rel, apply: true, saveSnapshot })
  check('实做写盘成功', applied.ok === true && applied.changed === true, JSON.stringify(applied.why ?? ''))
  const after = readFileSync(join(WS, rel), 'utf8')
  check('★ 文件里已无冗余前缀', !after.includes('据他说') && after.includes('他每天花30块'),
    JSON.stringify(after))
  check('★ 写了备份（可回溯）',
    existsSync(join(WS, 'memory', '.backups')) &&
      readdirSync(join(WS, 'memory', '.backups')).length > 0)

  section('⑪ 不刷新快照的话，整理结果会被回滚 —— 这条必须守住')
  const verified = verifyAndRestoreMemory({ workspace: WS })
  check('★★ 整理后过一遍篡改检测：**不回滚**（因为快照被刷新了）',
    verified.tampered.length === 0, JSON.stringify(verified))
  check('文件内容仍是整理后的', readFileSync(join(WS, rel), 'utf8') === after)

  section('⑫ 不存在的文件：明确失败，不抛异常')
  const missing = consolidateFile({ workspace: WS, rel: 'memory/nope.md', apply: true })
  check('缺文件 → ok:false 且给出原因', missing.ok === false && Boolean(missing.why), JSON.stringify(missing.why))

  // ══════════════════════════════════════════════════════════════════════════
  section('⑬ ★★ 定时整理（H2）：能力早就有了，缺的是"谁来按这个按钮"')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // 造一个**真的有重复**的记忆目录：定时整理要能把它收干净
    const WS2 = join(ROOT, 'sched')
    mkdirSync(join(WS2, 'memory'), { recursive: true })
    const dupRel = 'memory/private-777.md'
    writeFileSync(
      join(WS2, dupRel),
      ['# 记忆', '', '- 他喜欢喝冰美式', '- 他喜欢喝冰美式。', '- 他的服务器是 Forge 端'].join('\n') + '\n',
      'utf8',
    )

    const logs = []
    const fakeTimer = (() => {
      let fn = null
      let ms = null
      let cleared = false
      let unrefed = false
      return {
        setInterval: (f, m) => {
          fn = f
          ms = m
          return { unref: () => { unrefed = true } }
        },
        clearInterval: () => { cleared = true },
        // 给测试用的把手
        fire: () => fn?.(),
        state: () => ({ ms, cleared, unrefed, armed: Boolean(fn) }),
      }
    })()

    const sched = createConsolidateScheduler({
      workspace: WS2,
      intervalMs: CONSOLIDATE_INTERVAL_MS,
      // ★ listFiles 必须注入：默认实现要 import memory-store，会形成循环依赖
      listFiles: () => listMemoryFiles(WS2),
      log: (m) => logs.push(String(m)),
      saveSnapshot,
      timer: fakeTimer,
    })

    check('启动前没在跑', sched.isRunning() === false)
    check('start() 成功', sched.start() === true)
    check('★ 间隔就是 1 小时（默认值）', fakeTimer.state().ms === CONSOLIDATE_INTERVAL_MS,
      String(fakeTimer.state().ms))
    check('★★ `unref()` 被调用过 —— 绝不能因为一个整理定时器拖住进程退出',
      fakeTimer.state().unrefed === true)
    check('重复 start() 不叠加（返回 false）', sched.start() === false)

    // 到点了 → 真的整理
    const r1 = sched.tick()
    check('★ 一跳走完：描述了看了几个文件', r1.ok === true && r1.files >= 1, JSON.stringify(r1))
    check('★★ 重复条目被合并掉了（这就是它存在的意义）',
      r1.changed === 1 && r1.before === 3 && r1.after === 2, JSON.stringify(r1))
    check('★ 有变更时**必须记日志**（不然没人知道它干过活）',
      logs.some((l) => l.includes('定时整理') && l.includes('有变化')), logs.join('｜'))
    const after = readFileSync(join(WS2, dupRel), 'utf8')
    check('磁盘上确实合并了', after.split('\n').filter((l) => l.trim().startsWith('- ')).length === 2, after)

    // 没有变更时**不要**刷屏
    const logsBefore = logs.length
    const r2 = sched.tick()
    check('★ 没有变化 → changed 为 0', r2.changed === 0, JSON.stringify(r2))
    check('★★ 而且**不记日志**（每小时一行"没变化"会把该看的那行埋掉）',
      logs.length === logsBefore, logs.slice(logsBefore).join('｜') || '（没有新日志）')

    // 忙的时候跳过（整理会重写文件，绝不能在写记忆的当口动手）
    const busyLogs = logs.length
    const sched2 = createConsolidateScheduler({
      workspace: WS2,
      listFiles: () => listMemoryFiles(WS2),
      isIdle: () => false,
      log: (m) => logs.push(String(m)),
      saveSnapshot,
      timer: fakeTimer,
    })
    const r3 = sched2.tick()
    check('★★ 桥接忙时**跳过**（否则会把刚写进去的那条覆盖掉）',
      r3.ok === true && r3.skipped === 'busy', JSON.stringify(r3))
    check('★ 跳过**不算异常**，也不记日志', logs.length === busyLogs, logs.slice(busyLogs).join('｜') || '（没有新日志）')

    // 单个文件失败不能拖垮整轮
    const sched3 = createConsolidateScheduler({
      workspace: WS2,
      listFiles: () => ['memory/broken.md', dupRel],
      runFile: ({ rel }) => (rel === 'memory/broken.md' ? { ok: false, why: '读不了' } : { ok: true, before: 1, after: 1, changed: false }),
      log: (m) => logs.push(String(m)),
      timer: fakeTimer,
    })
    const r4 = sched3.tick()
    check('★ 一个文件失败不影响其它文件（继续跑完）', r4.ok === true && r4.files === 2, JSON.stringify(r4))
    check('★ 但失败**要留证据**（不许安静地失败）',
      logs.some((l) => l.includes('broken.md') && l.includes('读不了')), logs.slice(-3).join('｜'))

    // 没有工作区 / 关掉定时器
    check('没有 workspace → 明确失败', createConsolidateScheduler({ timer: fakeTimer }).tick().ok === false)
    const off = createConsolidateScheduler({ workspace: WS2, intervalMs: 0, log: (m) => logs.push(String(m)), timer: fakeTimer })
    check('intervalMs <= 0 → 不启动，并说明原因', off.start() === false && logs.some((l) => l.includes('未开启')))
    const tiny = createConsolidateScheduler({ workspace: WS2, intervalMs: 1, timer: fakeTimer, log: () => {} })
    tiny.start()
    check('★★ 间隔有**下限**（配置成 1ms 会被夹到 5 分钟，防止把 CPU 打满）',
      fakeTimer.state().ms === CONSOLIDATE_MIN_INTERVAL_MS, String(fakeTimer.state().ms))
    check('stop() 会清掉定时器', tiny.stop() === true && fakeTimer.state().cleared === true)
    check('stop() 之后再 stop 返回 false（幂等）', tiny.stop() === false)
    check('stats() 能报出跑过几跳', sched.stats().ticks >= 2, JSON.stringify(sched.stats().ticks))
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
if (failed === 0) {
  console.log(`🎉 记忆整理（规则版）测试全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
  process.exit(1)
}
