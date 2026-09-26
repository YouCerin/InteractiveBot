/**
 * 任务台账测试：**"不丢主线的锚"**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套最要紧的一条：**目标与主线不能依赖模型**
 * ══════════════════════════════════════════════════════════════════════════
 * 设计文档原本让模型写 `goal` / `mainline`。这里**刻意先不做**，理由是已被两次
 * 实测验证的教训：靠模型自觉的路径漏报率极高（记忆诊断：本机 58 次 + 我们这里
 * 几十轮真实运行，它一次都没主动记）。而任务台账是**每轮都要用**的东西 ——
 * 它一旦空着，"不丢主线"就完全失效。
 *
 * 所以下面的断言都在盯"**没有任何模型参与，台账仍然完整**"：
 *   · `goal` 直接取用户原话（`goalSource: 'user-message'`）
 *   · `steps` 从 `ops` 机械提炼
 *   · `tried` / `blocked` 由结果与审批状态推导
 *
 * 另一组要紧的是**措辞纪律**：注入段里"第 N 步"是我们自己的编号，
 * 而 `replyToMessageId` 用的是**真正的消息 id** —— 混称会让模型拿步骤号去引用消息，
 * 那是用户可见的错误。所以渲染里必须显式声明"不要当消息引用"。
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  describeAction,
  stepsFromOps,
  blockedFromSteps,
  noteTaskTurn,
  readTask,
  listTasks,
  renderTaskBlock,
  archiveStaleTasks,
  forgetTask,
  parseRollback,
  rollbackTask,
  taskRel,
  taskIdleMs,
  isTaskStale,
  MAX_STEPS,
  TASK_IDLE_MS,
  TASK_KEEP_DONE_MS,
} from '../src/tasks.mjs'

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

// ── ops fixture：形状照抄 `TurnCollector.ops`（R1 产出的真实结构）────────────
let seq = 0
const opCall = (name, args, { turn = 1, step = null, callId = null } = {}) => ({
  at: 1790427000000 + (seq += 1000),
  turn,
  step: step ?? seq / 1000,
  type: 'tool/call',
  name,
  callId: callId ?? `c${seq}`,
  args,
})
const opResult = (step, { ok = true, excerpt = 'ok', callId = null } = {}) => ({
  at: step.at + 500,
  turn: step.turn,
  step: step.step,
  type: 'tool/result',
  callId: callId ?? step.callId,
  ok,
  bytes: String(excerpt).length,
  excerpt,
  hasImage: false,
})

const ROOT = mkdtempSync(join(tmpdir(), 'qq-bridge-tasks-'))

try {
  // ══════════════════════════════════════════════════════════════════════════
  section('① 工具 → 人话动作（认不出就如实用工具名，不编语义）')
  // ══════════════════════════════════════════════════════════════════════════
  check('read → 读文件', describeAction('read', { file_path: 'a.txt' }) === '读文件 a.txt',
    describeAction('read', { file_path: 'a.txt' }))
  check('write → 写文件', describeAction('write', { file_path: 'b.md' }).startsWith('写文件'))
  check('pwsh → 跑命令', describeAction('pwsh', { command: 'npm test' }) === '跑命令 npm test')
  check('web_search → 搜索（多 query 合并）',
    describeAction('web_search', { queries: ['a', 'b'] }) === '搜索 a / b',
    describeAction('web_search', { queries: ['a', 'b'] }))
  check('mcp__qq__qq_poke → 戳一戳', describeAction('mcp__qq__qq_poke', {}) === '戳一戳')
  check('★ 认不出的工具：用工具名 + 参数摘要，**不编语义**',
    describeAction('some_new_tool', { alpha: 'x', beta: 'y' }) === 'some_new_tool（alpha=x beta=y）',
    describeAction('some_new_tool', { alpha: 'x', beta: 'y' }))
  check('参数超长被截断', describeAction('read', { file_path: 'x'.repeat(200) }).length < 80,
    String(describeAction('read', { file_path: 'x'.repeat(200) }).length))

  // ══════════════════════════════════════════════════════════════════════════
  section('② 从 ops 提炼步骤：call/result 配对，结果没回来**不猜**')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const c1 = opCall('read', { file_path: 'a.txt' })
    const c2 = opCall('write', { file_path: 'b.txt' })
    const c3 = opCall('pwsh', { command: 'boom' })
    const ops = [
      c1, opResult(c1, { ok: true, excerpt: 'file body' }),
      c2, opResult(c2, { ok: true, excerpt: 'Updated file' }),
      c3, opResult(c3, { ok: false, excerpt: 'command failed' }),
      opCall('grep', { pattern: 'x' }), // ← 结果没回来（回合被中止）
    ]
    const steps = stepsFromOps(ops)
    check('3 次带结果的调用 + 1 次没结果 = 4 步', steps.length === 4, String(steps.length))
    check('步骤带人话动作', steps[0].action === '读文件 a.txt', steps[0].action)
    check('成功 → ok', steps[0].outcome === 'ok')
    check('失败 → failed（并带 failed 标记）', steps[2].outcome === 'failed' && steps[2].failed === true,
      JSON.stringify(steps[2]))
    check('★★ 结果没回来 → **pending**（不能猜成失败 —— 猜错会让模型以为那步白做了）',
      steps[3].outcome === 'pending', JSON.stringify(steps[3]))
    check('结果摘要被收进步骤（截断）', steps[0].result === 'file body', steps[0].result)
  }

  section('③ 审批被拒 → blocked（这是"别再硬试"的依据）')
  {
    const ops = [
      { at: 1, turn: 1, step: 1, type: 'approval', toolName: 'pwsh', outcome: null, reason: '越界' },
      { at: 2, turn: 1, step: 1, type: 'approval/decided', outcome: 'unavailable' },
    ]
    const steps = stepsFromOps(ops)
    check('审批步 → blocked', steps[0]?.outcome === 'blocked', JSON.stringify(steps[0]))
    const b = blockedFromSteps(steps)
    check('blocked 里带"为什么"（越界 vs 审批被拒要分开）',
      b.length === 1 && b[0].why.includes('越界'), JSON.stringify(b))
  }
  check('空 ops 不抛', stepsFromOps([]).length === 0 && stepsFromOps(null).length === 0)

  // ══════════════════════════════════════════════════════════════════════════
  section('④ ★★ 台账：**零模型参与**也能完整')
  // ══════════════════════════════════════════════════════════════════════════
  const WS = join(ROOT, 'ws')
  const KEY = 'group:700000001'
  const t0 = new Date('2026-09-26T21:00:00')
  {
    const c1 = opCall('web_search', { queries: ['克莱德洛'] })
    const c2 = opCall('write', { file_path: 'note.md' })
    const c3 = opCall('pwsh', { command: 'nope' })
    const r = noteTaskTurn({
      workspace: WS, chatKey: KEY, now: t0,
      userText: '帮我查一下克莱德洛这个品牌靠不靠谱',
      ops: [
        c1, opResult(c1, { ok: true, excerpt: '3 条结果' }),
        c2, opResult(c2, { ok: true, excerpt: 'Updated file' }),
        c3, opResult(c3, { ok: false, excerpt: 'command not found' }),
      ],
    })
    check('noteTaskTurn 成功', r.ok === true, JSON.stringify(r.why ?? ''))
    check('★★ 目标 = 用户原话（**没有任何模型参与**）',
      r.task.goal === '帮我查一下克莱德洛这个品牌靠不靠谱' && r.task.goalSource === 'user-message',
      JSON.stringify({ goal: r.task.goal, src: r.task.goalSource }))
    check('3 步都记下了', r.task.steps.length === 3, String(r.task.steps.length))
    check('★ 失败的做法进 `tried`（"别重复走"的依据）',
      r.task.tried.length === 1 && r.task.tried[0].approach.includes('nope'),
      JSON.stringify(r.task.tried))
    check('success 不进 tried', r.task.tried.every((t) => !t.approach.includes('克莱德洛')))
    check('turns 计数 +1', r.task.turns === 1, String(r.task.turns))
    check('状态 active', r.task.status === 'active')
  }

  section('⑤ 落盘 + 读回（原子写、按会话分文件）')
  {
    check('文件路径按会话命名', taskRel(KEY) === 'runtime/tasks/group_700000001.json', taskRel(KEY))
    check('文件真的存在', existsSync(join(WS, taskRel(KEY))))
    const back = readTask({ workspace: WS, chatKey: KEY })
    check('读回来目标一致', back?.goal === '帮我查一下克莱德洛这个品牌靠不靠谱', JSON.stringify(back?.goal))
    check('读回来步骤一致', back?.steps?.length === 3)
    check('没有 .tmp 残留（原子写的证据）',
      readdirSync(join(WS, 'runtime', 'tasks')).every((f) => !f.includes('.tmp')))
    check('坏 JSON 读回 null 而不抛',
      (() => {
        writeFileSync(join(WS, taskRel('bad:1')), '{ 坏', 'utf8')
        try {
          return readTask({ workspace: WS, chatKey: 'bad:1' }) === null
        } catch {
          return false
        }
      })())
  }

  section('⑥ 同一步不重复记（重入保护）')
  {
    const c1 = opCall('read', { file_path: 'a.txt' })
    const ops = [c1, opResult(c1, { ok: true, excerpt: 'body' })]
    const before = readTask({ workspace: WS, chatKey: KEY }).steps.length
    noteTaskTurn({ workspace: WS, chatKey: KEY, now: new Date(t0.getTime() + 60000), userText: '', ops })
    noteTaskTurn({ workspace: WS, chatKey: KEY, now: new Date(t0.getTime() + 61000), userText: '', ops })
    const after = readTask({ workspace: WS, chatKey: KEY }).steps.length
    check('★ 同一批 ops 喂两次只记一次', after === before + 1, `${before} → ${after}`)
  }

  section('⑦ 任务边界：闲置超过阈值就开新任务')
  {
    // ⚠️ 时间基准必须**从盘上读**，不能用前面那个 t0 ——
    //    ⑥ 已经用 `t0 + 60_000` 的活动推进过 lastActiveAt，
    //    拿 t0 当基准会让"闲置了多久"算错（第一版就是这么错的，
    //    表现为"startedAt 没更新"这种看起来像代码 bug 的假失败）。
    const before = readTask({ workspace: WS, chatKey: KEY })
    const base = Number(before.lastActiveAt)
    const stepsBefore = before.steps.length

    const later = new Date(base + TASK_IDLE_MS + 60000) // 明确超过阈值
    noteTaskTurn({ workspace: WS, chatKey: KEY, now: later, userText: '换个话题：帮我写个脚本', ops: [] })
    const t = readTask({ workspace: WS, chatKey: KEY })
    check('★ 闲置后开新任务（步骤清零）', t.steps.length === 0,
      `${stepsBefore} → ${t.steps.length}`)
    check('目标换成新的那句', t.goal === '换个话题：帮我写个脚本', t.goal)
    check('startedAt 更新到这一刻', t.startedAt === later.getTime(),
      `${t.startedAt} vs ${later.getTime()}`)
    check('turns 重新从 1 开始', t.turns === 1, String(t.turns))

    // 阈值内则继续同一任务
    const soon = new Date(later.getTime() + 60000)
    noteTaskTurn({ workspace: WS, chatKey: KEY, now: soon, userText: '再补一句', ops: [] })
    const t2 = readTask({ workspace: WS, chatKey: KEY })
    check('阈值内继续同一任务（turns 累加到 2）', t2.turns === 2, String(t2.turns))
    check('startedAt 不变（还是同一个任务）', t2.startedAt === later.getTime(), String(t2.startedAt))
    // ★★ 真机缺陷（2026-09-26 22:36）：原先**无条件**用本轮用户原话覆盖目标，
    //    于是用户一句"原来如此，太棒了"把目标冲掉了 —— 注入就成了
    //    「对方最近的要求：原来如此，太棒了」，抽取那边也照着这句"要求"去理解。
    //    判据改成与"重做标记生命周期"同一个概念：**动手了才算这一轮推进了任务**。
    check('★★ 只说话没动手 → 目标**不被覆盖**（一句道谢不该变成"对方最近的要求"）',
      t2.goal === '换个话题：帮我写个脚本', t2.goal)

    const worked = new Date(soon.getTime() + 60000)
    const c = opCall('read', { file_path: 'a.txt' })
    noteTaskTurn({
      workspace: WS, chatKey: KEY, now: worked, userText: '顺便再查一下价格',
      ops: [c, opResult(c, { ok: true, excerpt: '有货' })],
    })
    const t3 = readTask({ workspace: WS, chatKey: KEY })
    check('★ 真的动手了 → 目标更新成那一轮的要求（同一任务里他会把要求说细）',
      t3.goal === '顺便再查一下价格', t3.goal)
  }

  section('⑧ 步骤上限（更早的仍在 oplog 里）')
  {
    const many = []
    for (let i = 0; i < MAX_STEPS + 5; i += 1) {
      const c = opCall('read', { file_path: `f${i}.txt` })
      many.push(c, opResult(c, { ok: true, excerpt: `body${i}` }))
    }
    noteTaskTurn({ workspace: WS, chatKey: 'cap:1', now: t0, userText: '很多步', ops: many })
    const t = readTask({ workspace: WS, chatKey: 'cap:1' })
    check(`★ 台账只留最近 ${MAX_STEPS} 步`, t.steps.length === MAX_STEPS, String(t.steps.length))
    check('留的是**最近**的（最后一步是 f14）',
      t.steps[t.steps.length - 1].action.includes(`f${MAX_STEPS + 4}.txt`),
      t.steps[t.steps.length - 1].action)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑨ ★★ 注入渲染：措辞纪律（弄错会让用户看到错误引用）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const c1 = opCall('read', { file_path: 'a.txt' })
    const c2 = opCall('pwsh', { command: 'boom' })
    noteTaskTurn({
      workspace: WS, chatKey: 'render:1', now: t0, userText: '帮我看看这个文件',
      ops: [c1, opResult(c1, { ok: true, excerpt: 'body' }), c2, opResult(c2, { ok: false, excerpt: 'failed' })],
      })
    // 再灌一次带审批的，制造 blocked
    noteTaskTurn({
      workspace: WS, chatKey: 'render:1', now: new Date(t0.getTime() + 60000), userText: '',
      ops: [
        { at: 9, turn: 1, step: 9, type: 'approval', toolName: 'pwsh', outcome: null, reason: '越界' },
        { at: 10, turn: 1, step: 9, type: 'approval/decided', outcome: 'unavailable' },
      ],
    })
    const task = readTask({ workspace: WS, chatKey: 'render:1' })
    const block = renderTaskBlock(task)
    check('渲染出内容', block.length > 0)
    check('★ 说清这是**你自己干过的**，不是对方说的话',
      block.includes('你自己') && block.includes('不是对方说的话'), block.split('\n')[0])
    check('带对方最近的要求', block.includes('帮我看看这个文件'))
    check('成功了标 ✓、失败了标 ✗', block.includes('✓') && block.includes('✗'))
    check('失败的做法单独列出（别重复走）', block.includes('试过但') && block.includes('boom'))
    check('被挡住的单独列出（换做法别硬试）', block.includes('被挡住的'), block)
    check('★★ 显式禁止把步骤当消息引用（否则它会拿步骤号去 replyToMessageId）',
      block.includes('不要') && block.includes('消息') && block.includes('#'), 
      block.split('\n').slice(-1)[0])
    check('★★ 不把步骤编号叫成"消息 id"', !/第\s*\d+\s*步.{0,6}消息\s*id/.test(block))
    check('空台账/非 active 不渲染', renderTaskBlock(null) === '' && renderTaskBlock({ status: 'done' }) === '')
    check('只有目标没有步骤也不渲染（省 token）',
      renderTaskBlock({ status: 'active', goal: 'x', steps: [], blocked: [] }) === '')
  }

  section('⑩-b 闲置台账要降级（不能一直自称"当前任务"）')
  {
    // 这一节修的是一个**真实缺陷**：闲置判定原先只在 `noteTaskTurn`
    //（回合结束）里做，而注入发生在回合开始 —— 于是超过 TASK_IDLE_MS 的台账
    // 仍以【当前任务】注入，同一轮结尾却会被判成"新任务"，两边自相矛盾。
    const NOW = new Date('2026-09-26T21:00:00')
    const mk = (idleAgoMs) => ({
      status: 'active',
      goal: '帮我查一下佳洁士的母公司',
      startedAt: NOW.getTime() - idleAgoMs - 60_000,
      lastActiveAt: NOW.getTime() - idleAgoMs,
      steps: [{ at: 1, action: '搜索 P&G 品牌数', outcome: 'ok', result: '65 个品牌' }],
      tried: [],
      blocked: [],
    })

    check('闲置时长算得出来', taskIdleMs(mk(5 * 60_000), NOW) === 5 * 60_000, String(taskIdleMs(mk(5 * 60_000), NOW)))
    check('★ 没有 lastActiveAt → 判不了，返回 null（不是 0 也不是 Infinity）',
      taskIdleMs({ status: 'active' }, NOW) === null && taskIdleMs({ lastActiveAt: 0 }, NOW) === null)
    check('时钟倒退也不会算出负数（夹到 0）', taskIdleMs(mk(-60_000), NOW) === 0)

    check('窗口内不算闲置', isTaskStale(mk(TASK_IDLE_MS - 1000), NOW) === false)
    check('★ 边界是**严格大于**（正好等于窗口仍算当前）', isTaskStale(mk(TASK_IDLE_MS), NOW) === false)
    check('超过窗口算闲置', isTaskStale(mk(TASK_IDLE_MS + 1000), NOW) === true)

    const fresh = renderTaskBlock(mk(5 * 60_000), { now: NOW })
    check('★★ 窗口内仍是【当前任务】', fresh.includes('【当前任务'), fresh.split('\n')[0])
    check('窗口内仍叫"对方最近的要求"', fresh.includes('对方最近的要求'))
    check('窗口内不出现"可能已经结束"', !fresh.includes('可能已经结束'))

    const stale = renderTaskBlock(mk(90 * 60_000), { now: NOW })
    check('★★ 超过窗口降级成【上一件事】', stale.includes('【上一件事'), stale.split('\n')[0])
    check('★ 明说"可能已经结束"', stale.includes('可能已经结束'), stale.split('\n')[0])
    check('★ 闲置时长写成人话（1 小时 30 分钟）', stale.includes('1 小时 30 分钟'), stale.split('\n')[1])
    check('★ 禁止"对方没提也主动接着做"',
      stale.includes('不要主动接着做') && stale.includes('也不要主动提它'), stale.split('\n')[1])
    check('★ 但保留了接续的入口（对方说"继续"时仍能参考）',
      stale.includes('继续') && stale.includes('才参考'))
    check('★ 目标还在（降级 ≠ 丢内容）', stale.includes('帮我查一下佳洁士的母公司'))
    check('降级后仍标注"这是你自己干的、不是对方说的话"',
      stale.includes('你自己') && stale.includes('不是对方说的话'))
    check('降级后步骤仍在', stale.includes('搜索 P&G 品牌数') && stale.includes('已做过 1 步'))

    // 两边规则必须一致：同一份台账，渲染说"可能已结束"，noteTaskTurn 就该开新任务
    const WS2 = join(WS, 'idle-two-sides')
    mkdirSync(join(WS2, 'runtime', 'tasks'), { recursive: true })
    // ★ 必须用 taskRel 算文件名：chatKey 里的 `:` 会被换成 `_`，
    //   拼字面量 `idle:1.json` 会写到另一个文件上，测试就"通过"得毫无意义。
    writeFileSync(join(WS2, taskRel('idle:1')), JSON.stringify({ ...mk(90 * 60_000), chatKey: 'idle:1' }))
    const before = readTask({ workspace: WS2, chatKey: 'idle:1' })
    check('★ 渲染端判为闲置', isTaskStale(before, NOW) === true, JSON.stringify(before?.lastActiveAt ?? null))
    noteTaskTurn({ workspace: WS2, chatKey: 'idle:1', ops: [], userText: '在吗', now: NOW })
    const after = readTask({ workspace: WS2, chatKey: 'idle:1' })
    check('★★ 记账端同一时刻也开了新任务（两边不再自相矛盾）',
      after.turns === 1 && after.steps.length === 0 && after.goal === '在吗',
      JSON.stringify({ turns: after.turns, steps: after.steps.length, goal: after.goal }))
  }

  section('⑩ 作废的步骤要明说不要当事实（为 R3 预留）')
  {
    const block = renderTaskBlock({
      status: 'active',
      goal: 'g',
      steps: [
        { at: 1, action: '读文件 a', outcome: 'ok', result: 'ok' },
        { at: 2, action: '写文件 b', outcome: 'superseded', result: '' },
        { at: 3, action: '跑命令 c', outcome: 'ok', result: 'ok' },
      ],
      blocked: [],
      tried: [],
    })
    check('★ 作废的步骤**不出现在列表里**', !block.includes('写文件 b'), block)
    check('★ 但要说明"有 N 步已作废，不要当事实"', block.includes('作废') && block.includes('不要'),
      block)
  }

  section('⑪ 归档：移走而不是删除')
  {
    // 造一个已完成且很旧的台账
    const old = new Date(Date.now() - TASK_KEEP_DONE_MS - 3600000)
    mkdirSync(join(WS, 'runtime', 'tasks'), { recursive: true })
    writeFileSync(join(WS, taskRel('done:1')), JSON.stringify({
      chatKey: 'done:1', status: 'done', startedAt: old.getTime(), lastActiveAt: old.getTime(),
      turns: 3, steps: [], tried: [], blocked: [],
    }), 'utf8')
    const dry = archiveStaleTasks({ workspace: WS })
    check('★ 预演：报告要归档但**不真移**',
      dry.moved.includes(taskRel('done:1')) && existsSync(join(WS, taskRel('done:1'))),
      JSON.stringify(dry.moved))
    const applied = archiveStaleTasks({ workspace: WS, apply: true })
    check('实做：移到 archive/（**不是删除**）',
      applied.moved.includes(taskRel('done:1')) &&
        !existsSync(join(WS, taskRel('done:1'))) &&
        existsSync(join(WS, 'runtime', 'archive', 'done_1.json')),
      JSON.stringify(applied.moved))
    check('活跃的台账不动',
      archiveStaleTasks({ workspace: WS }).moved.every((m) => !m.includes('group_700000001')))
  }

  section('⑫ 管理手段与容错')
  {
    check('forgetTask 删得掉', forgetTask({ workspace: WS, chatKey: KEY }) === true)
    check('再删返回 false（不抛）', forgetTask({ workspace: WS, chatKey: KEY }) === false)
    check('listTasks 列出剩余台账', Array.isArray(listTasks({ workspace: WS })))
    let threw = false
    try {
      noteTaskTurn({ workspace: '', chatKey: 'x', ops: [] })
      noteTaskTurn({ workspace: WS, chatKey: '', ops: [] })
      readTask({ workspace: '', chatKey: 'x' })
      archiveStaleTasks({ workspace: join(ROOT, 'nope') })
    } catch {
      threw = true
    }
    check('★ 缺参/坏路径都不抛异常', threw === false)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑬ R3 触发词识别：本地匹配，**不依赖模型**')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const cases = [
      ['回到第3步', 3, 'replay', 'explicit'],
      ['回到第 3 步', 3, 'replay', 'explicit'],
      ['退回第2步', 2, 'replay', 'explicit'],
      ['返回第 12 步', 12, 'replay', 'explicit'],
      ['重做第2步', 2, 'retry', 'explicit'],
      ['重新做第 4 步', 4, 'retry', 'explicit'],
      ['撤销第5步', 5, 'abandon', 'explicit'],
      ['撤消第5步', 5, 'abandon', 'explicit'],
      ['回到上一步', null, 'replay', 'last'],
      ['退到前一步', null, 'replay', 'last'],
      ['撤销这一步', null, 'abandon', 'this'],
      ['重做这一步', null, 'retry', 'this'],
      ['撤销本步', null, 'abandon', 'this'],
    ]
    for (const [text, step, mode, which] of cases) {
      const r = parseRollback(text)
      check(`识别「${text}」`, r.hit === true && r.step === step && r.mode === mode && r.which === which,
        JSON.stringify(r))
    }
    // ★ "上一步"与"这一步"必须是**两个不同**的语义（合成一个会让一半用户拿到相反结果）
    check('★★ 上一步 ≠ 这一步（指代要分开）',
      parseRollback('回到上一步').which === 'last' && parseRollback('撤销这一步').which === 'this')
    for (const t of ['今天天气不错', '帮我看看这个文件']) {
      const r = parseRollback(t)
      check(`「${t}」不误命中`, r.hit === false, JSON.stringify(r))
    }
    // ⚠️ 已知假阳性：含触发词但其实是普通句子。代价是"多回退一次"（可再回退回来）。
    //    要收窄得靠语义判断，而那是"依赖模型"的路 —— 与设计取舍冲突，
    //    所以如实断言"会命中"，把取舍固化下来而不是假装它不存在。
    check('★ 含触发词的普通句子**会**命中（已知假阳性，如实固化）',
      parseRollback('回到第3步之前我们先确认一下').hit === true)
  }

  section('⑭ R3 回退：编号从 1 起、作废保留、可再回退')
  {
    const RB = 'rb:1'
    const mk = (n) => {
      const ops = []
      for (let i = 0; i < n; i += 1) {
        const c = opCall('read', { file_path: `f${i + 1}.txt` })
        ops.push(c, opResult(c, { ok: true, excerpt: `body${i + 1}` }))
      }
      return ops
    }
    noteTaskTurn({ workspace: WS, chatKey: RB, now: t0, userText: '做五件事', ops: mk(5) })
    const before = readTask({ workspace: WS, chatKey: RB })
    check('前提：5 步都在', before.steps.length === 5, String(before.steps.length))

    const r = rollbackTask({ workspace: WS, chatKey: RB, step: 3, mode: 'retry', note: '第三个文件读错了' })
    check('回退成功', r.ok === true, JSON.stringify(r.why ?? ''))
    check('目标步对得上（第 3 步 = f3.txt）', r.target?.action === '读文件 f3.txt', r.target?.action)

    const t = readTask({ workspace: WS, chatKey: RB })
    check('★★ 1~3 有效、4~5 标记 superseded（**保留不删**）',
      t.steps.slice(0, 3).every((s) => s.outcome !== 'superseded') &&
        t.steps.slice(3).every((s) => s.outcome === 'superseded'),
      JSON.stringify(t.steps.map((s) => s.outcome)))
    check('★★ 作废的步骤**仍在数组里**（可追溯，不是删除）', t.steps.length === 5, String(t.steps.length))
    check('★ 记下了原状态（再往前回时能恢复）', t.steps[3].wasOutcome === 'ok', JSON.stringify(t.steps[3]))
    check('checkpoint 记到第 3 步', t.checkpoint?.step === 3 && t.checkpoint?.invalidatedAfter === 3,
      JSON.stringify(t.checkpoint))
    check('redo 记下姿势与备注', t.redo?.step === 3 && t.redo?.mode === 'retry' && t.redo?.note.includes('读错'),
      JSON.stringify(t.redo))
    check('回退历史留痕', Array.isArray(t.rollbacks) && t.rollbacks.length === 1, JSON.stringify(t.rollbacks))

    section('⑮ 回退后注入：先说清"作废"，再列有效步骤')
    const block = renderTaskBlock(t)
    check('★★ 有【已回退到第 N 步】声明', block.includes('已回退到第 3 步'), block.split('\n').slice(0, 6).join('\n'))
    check('★ 说清要做的是哪种姿势（retry = 换方法再试）', block.includes('换个方法再试'))
    check('★ 带上了补充说明', block.includes('第三个文件读错了'))
    check('★★ 明确"之后的步骤已作废、不要当事实"',
      block.includes('作废') && block.includes('不要把它们当成已发生的事实'))
    check('★ 同时提醒"你上下文里可能还留着那些内容"（如实说明我们清不掉它）',
      block.includes('上下文') && block.includes('忽略即可'))
    check('作废的步骤**不出现在步骤列表里**', !block.includes('读文件 f4.txt'), block)
    check('显示的是"已做过 3 步"（只数有效的）', block.includes('已做过 3 步'), block)

    section('⑯ 连续回退：更早的位置要能**恢复**之前作废的步骤')
    const r2 = rollbackTask({ workspace: WS, chatKey: RB, step: 5 })
    const t2 = readTask({ workspace: WS, chatKey: RB })
    check('回退到更靠后的第 5 步 → 第 4、5 步恢复',
      t2.steps.every((s) => s.outcome !== 'superseded'),
      JSON.stringify(t2.steps.map((s) => s.outcome)))
    check('★ 恢复的是**原状态**（不是笼统的 ok）', t2.steps[3].outcome === 'ok', t2.steps[3].outcome)

    const r3 = rollbackTask({ workspace: WS, chatKey: RB, step: 2 })
    const t3 = readTask({ workspace: WS, chatKey: RB })
    check('再回退到第 2 步：1~2 有效、3~5 作废',
      t3.steps.slice(0, 2).every((s) => s.outcome !== 'superseded') &&
        t3.steps.slice(2).every((s) => s.outcome === 'superseded'),
      JSON.stringify(t3.steps.map((s) => s.outcome)))
    check('★★ 这修掉了一个真问题：不做恢复的话第 4~5 步会**永久作废**',
      t3.steps[3].outcome === 'superseded' && t3.steps[4].wasOutcome === 'ok',
      JSON.stringify(t3.steps.map((s) => [s.outcome, s.wasOutcome])))

    section('⑰ 越界：不猜、给可用范围')
    const bad = rollbackTask({ workspace: WS, chatKey: RB, step: 99 })
    check('超出范围 → 失败并给出范围', bad.ok === false && bad.range?.[1] === 5, JSON.stringify(bad))
    check('理由里含"只到第 N 步"（人话）', /只到第\s*5\s*步/.test(bad.why ?? ''), bad.why)
    check('step=0 也拒', rollbackTask({ workspace: WS, chatKey: RB, step: 0 }).ok === false)
    check('非数字也拒', rollbackTask({ workspace: WS, chatKey: RB, step: 'abc' }).ok === false)
    check('没有台账的会话 → 明确失败', rollbackTask({ workspace: WS, chatKey: 'nope:1', step: 1 }).ok === false)
    check('缺参不抛', (() => {
      try {
        rollbackTask({})
        return true
      } catch {
        return false
      }
    })())

    section('⑱ redo 标记的生命周期：新步骤落进来才清')
    {
      const t4 = readTask({ workspace: WS, chatKey: RB })
      check('前提：还有 redo 标记', Boolean(t4.redo), JSON.stringify(t4.redo ?? null))
      // 只说了句话、没动手 → 不该清
      noteTaskTurn({ workspace: WS, chatKey: RB, now: new Date(t0.getTime() + 1000), userText: '再等等', ops: [] })
      check('★ 只有话、没动手 → redo 仍在（否则声明过早消失）',
        Boolean(readTask({ workspace: WS, chatKey: RB }).redo))
      // 真的动了 → 清掉
      const c = opCall('write', { file_path: 'z.txt' })
      noteTaskTurn({
        workspace: WS, chatKey: RB, now: new Date(t0.getTime() + 2000), userText: '',
        ops: [c, opResult(c, { ok: true, excerpt: 'done' })],
      })
      const t5 = readTask({ workspace: WS, chatKey: RB })
      check('★ 真的动手之后 redo 被清掉', !t5.redo && t5.redoDoneAt > 0, JSON.stringify({ redo: t5.redo, at: t5.redoDoneAt }))
      check('清理后注入里不再有回退声明', !renderTaskBlock(t5).includes('已回退到'))
    }
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
if (failed === 0) {
  console.log(`🎉 任务台账测试全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
  process.exit(1)
}
