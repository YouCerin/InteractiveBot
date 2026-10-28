/**
 * 定时任务（0.3.2 P1）离线套件。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这套件存在的**唯一**理由：「恰好一次」
 * ══════════════════════════════════════════════════════════════════════════
 * 需求原话是「小鲸鱼会**且仅会**一次报告」（`docs/0.3.2-task-manager-plan.md` §1）。
 * 定时提醒同理：**说两遍比漏一遍更糟**（本项目把重复回复判定为更严重的失败）。
 *
 * 而"恰好一次"最容易错的地方**不会报错**，只会表现成"它怎么又说了一遍"：
 *   · 拿 `Date.now()` 当去重键 ⇒ 每一跳都是新的键 ⇒ 每分钟重发一遍；
 *   · 认领写在调模型**之后** ⇒ 崩在中间就重发；
 *   · 重启后只看"上次跑到哪"（内存态）⇒ 昨天那条又发一遍。
 * 所以这三条各有一条**变异断言**（把实现改成错的写法，这里必须变红）。
 *
 * 另一半是"**不许静默**"：
 *   · 迟到超过容差 ⇒ 不补发，但**必须**记进错过台账；
 *   · 认领失败 ⇒ **宁可不发**（可能重复），但必须喊；
 *   · `sending` 之后崩 ⇒ **不自动重做**（同投递账本的结论），但启动时必须报出来。
 *
 * 全程不碰真盘（`workspace` 是临时目录，用完删）、不连 QQ、不调模型、不花钱。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import {
  DEFAULT_LATE_TOLERANCE_MS,
  FIRES_REL,
  MISSED_REL,
  SCHEDULE_DIR,
  candidateInstants,
  claimFire,
  deleteTask,
  dueAt,
  formatStamp,
  hmText,
  instantFromZoned,
  isScheduleUserData,
  listTasks,
  markTaskFired,
  msUntilNext,
  normalizeRepeat,
  normalizeTask,
  noteHistory,
  noteMissed,
  occurrenceKey,
  parseHm,
  pruneLedgers,
  readFireIndex,
  readLedger,
  readTask,
  renderMissedBlock,
  renderScheduleTaskBlock,
  safeTaskId,
  settleFire,
  taskRel,
  writeTask,
} from '../src/schedule.mjs'
import { createScheduleRunner, DEFAULT_TICK_MS, MIN_TICK_MS } from '../src/schedule-runner.mjs'

let pass = 0
let fail = 0
const failures = []
function ok(cond, label) {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${label}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ❌ ${label}`)
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(a === e, `${label}${a === e ? '' : `（得到 ${a}，期望 ${e}）`}`)
}
function throwsOrNot(fn, label) {
  try {
    fn()
    ok(true, label)
  } catch (error) {
    ok(false, `${label}（抛了：${error?.message ?? error}）`)
  }
}

const roots = []
function tmpRoot() {
  const d = mkdtempSync(join(tmpdir(), 'qqb-sched-'))
  roots.push(d)
  return d
}

const TZ = 'Asia/Shanghai'
/** 2026-03-01 08:00:00 +08:00 = 2026-03-01T00:00:00Z */
const T0800 = instantFromZoned('2026-03-01', 8 * 60, TZ)

function baseTask(over = {}) {
  return {
    id: 'wake8',
    title: '8 点叫我',
    enabled: true,
    repeat: { kind: 'daily', at: '08:00', weekdays: null },
    target: { kind: 'private', peerId: '100000001' },
    prompt: '叫我起床',
    requestedBy: '主人',
    ignoreQuietHours: true,
    timezone: TZ,
    // ★ 任务创建于 8:00 前一秒 ⇒ `createdAt` 这条硬下界**恰好等于**那个触发点，
    //   所以这条基线任务会正常触发（若下界取"创建之后"，它会连当天那次都不算账）
    createdAt: T0800 - 1000,
    ...over,
  }
}

console.log('\n=== ① 时区：不许用 date.getHours()（prices.mjs 的那条教训）===')
{
  eq(hmText(0), '00:00', 'hmText(0) = 00:00')
  eq(hmText(8 * 60 + 5), '08:05', 'hmText 补零')
  eq(hmText(23 * 60 + 59), '23:59', 'hmText 上界')
  eq(hmText(9999), '23:59', 'hmText 越界夹回')
  eq(typeof parseHm('8:00'), 'number', 'parseHm 认 8:00')
  eq(parseHm('8:00'), 480, 'parseHm 8:00 = 480')
  eq(parseHm('24:00'), null, 'parseHm 拒绝 24:00（不猜成 00:00）')
  eq(parseHm('08:60'), null, 'parseHm 拒绝 08:60')
  eq(parseHm('八点'), null, 'parseHm 认不出就 null')

  // ★ 这条是本节的要害：同一份输入，进程时区换了结果必须**一模一样**
  const inst = instantFromZoned('2026-03-01', 8 * 60, TZ)
  eq(inst, Date.UTC(2026, 2, 1, 0, 0, 0), 'Asia/Shanghai 08:00 = 00:00Z（+8 小时）')
  eq(instantFromZoned('2026-03-01', 8 * 60, 'UTC'), Date.UTC(2026, 2, 1, 8, 0, 0), 'UTC 的 08:00 就是 08:00Z')
  const old = process.env.TZ
  process.env.TZ = 'America/New_York'
  eq(instantFromZoned('2026-03-01', 8 * 60, TZ), inst, '换进程时区后结果不变（这正是不用 getHours 的理由）')
  if (old === undefined) delete process.env.TZ
  else process.env.TZ = old

  eq(formatStamp(inst, TZ), '2026-03-01 08:00', 'formatStamp 按任务时区渲染')
  eq(formatStamp(NaN, TZ), '?', 'formatStamp 认不出就 ?，不编')
}

console.log('\n=== ② 任务定义：认不出一律拒绝，绝不静默改写成别的 ===')
{
  const good = normalizeTask(baseTask())
  ok(good.ok, '合法任务通过校验')
  eq(good.task.repeat, { kind: 'daily', at: '08:00', weekdays: null }, 'daily 的 repeat 收敛成规范形状')
  eq(good.task.ignoreQuietHours, true, 'ignoreQuietHours 默认 true（定时提醒的语义）')
  eq(good.task.lateToleranceMs, DEFAULT_LATE_TOLERANCE_MS, '容差窗口有默认值')
  eq(good.task.timezone, TZ, '时区默认 Asia/Shanghai')

  eq(normalizeTask(null).ok, false, 'null 拒绝')
  eq(normalizeTask({}).ok, false, '空对象拒绝')
  eq(normalizeTask({ id: 'a', title: 't' }).ok, false, '缺 prompt 拒绝')
  eq(normalizeTask({ id: 'a', prompt: 'p' }).ok, false, '缺 title 拒绝')
  eq(normalizeTask({ id: 'a', title: 't', prompt: 'p' }).ok, false, '缺 target 拒绝')
  eq(
    normalizeTask({ id: 'a', title: 't', prompt: 'p', target: { kind: 'group' } }).ok,
    false,
    'target 缺 peerId 拒绝',
  )
  // ★ 最要紧的一条：认不出的 repeat **不许**悄悄变成"每天 0 点"
  const badRepeat = normalizeTask(baseTask({ repeat: { kind: 'every-full-moon' } }))
  eq(badRepeat.ok, false, '认不出的 repeat.kind 拒绝（不许静默改写）')
  ok(/认不出/.test(badRepeat.why), '拒绝时说明原因')
  eq(normalizeRepeat({ kind: 'daily', at: '25:00' }).ok, false, 'daily 25:00 拒绝')
  eq(normalizeRepeat({ kind: 'interval', everyMs: 1000 }).ok, false, 'interval 小于 1 分钟拒绝（防打满 CPU）')
  eq(normalizeRepeat({ kind: 'daily', at: '08:00', weekdays: [9] }).ok, false, 'weekdays 里没有合法值时拒绝')
  eq(
    normalizeRepeat({ kind: 'daily', at: '08:00', weekdays: [1, 1, 3] }).repeat.weekdays,
    [1, 3],
    'weekdays 去重并排序',
  )
  eq(normalizeRepeat({ kind: 'once', at: '不是时间' }).ok, false, 'once 的时间认不出就拒绝')

  // 文件名安全（id 同时是文件名 ⇒ 必须挡路径穿越）
  eq(safeTaskId('../../etc/passwd'), '.._.._etc_passwd', 'id 里的路径分隔被清理')
  // ★ 判据必须只看**文件名那一段**：目录名本身（`runtime/schedule`）本来就带分隔符
  const relName = taskRel('../../x').slice(SCHEDULE_DIR.length + 1)
  ok(!/[/\\]/.test(relName), '★ taskRel 的文件名里**没有任何路径分隔符**（防穿越的判据）')
  ok(taskRel('../../x').startsWith(`${SCHEDULE_DIR}/`), '★ 而且它一定落在 runtime/schedule/ 之内')
  ok(!taskRel('../../x').includes('/../'), '不会拼出 /../ 这种回溯')
}

console.log('\n=== ③ 下一次该触发了没有：算出来的时刻必须是确定性的 ===')
{
  const t = normalizeTask(baseTask()).task
  const isClaimed = () => false

  const d1 = dueAt(t, { now: T0800, isClaimed })
  eq(d1?.scheduledAt, T0800, '正好那一刻 ⇒ 判定为到点')
  eq(d1?.lateByMs, 0, '正好到点，迟到 0')

  const d2 = dueAt(t, { now: T0800 + 30_000, isClaimed })
  eq(d2?.scheduledAt, T0800, '过了 30 秒 ⇒ 仍然是**同一个**触发点（键不变！）')
  eq(d2?.occurrenceKey, d1?.occurrenceKey, '键必须一致 —— 这就是"恰好一次"的地基')

  // ★ 注意这里的语义：`dueAt` 回答的是"**有没有欠着一次**"，不是"现在几点"。
  //   所以「认领集合为空」时它一定会找到最近那个已到点的触发点（哪怕在昨天）
  //   —— 那正是重启后能发现"我漏了一次"的原因。**预期 null 的只有一种情况：
  //   从没到过点（任务刚建、时间还没到）**。
  const prevDay = T0800 - 86_400_000
  const d3 = dueAt(t, { now: T0800 - 1000, isClaimed: () => true })
  eq(d3, null, '到点之前的时刻 + 历史都已认领 ⇒ null（这才叫"还没到点"）')
  const neverDue = normalizeTask(baseTask({ id: 'never', createdAt: T0800 - 1000 })).task
  eq(dueAt(neverDue, { now: T0800 - 1000, isClaimed: () => true }), null, '一条从未到过点的任务 ⇒ null')

  // 昨天那次到点但没认领 ⇒ 会一路找到昨天（这正是"迟到"能被发现的原因）
  //   ★ 用一条**昨天就建好**的任务来测这条边界（基线任务建于 8:00 前一秒，
  //     按 effectiveFrom 的语义它本来就不该去追昨天）
  const aged = normalizeTask(baseTask({ id: 'aged', createdAt: T0800 - 86_400_000 })).task
  eq(aged.effectiveFrom, T0800 - 86_400_000, '昨天建的任务：effectiveFrom 就是创建时刻')
  const fresh1 = normalizeTask(baseTask({ id: 'fresh' })).task
  eq(fresh1.effectiveFrom, T0800, '8:00 前一秒建的「每天 8:00」：effectiveFrom = 当天 8:00（当天照常算账）')

  const d4 = dueAt(aged, { now: T0800 + 60_000, isClaimed: () => false })
  eq(d4?.scheduledAt, T0800, '认领集合为空时，返回的是**最近一个**已到点的触发点')
  const d5 = dueAt(aged, { now: T0800 + 60_000, isClaimed: (k) => k === occurrenceKey(aged.id, T0800) })
  eq(d5?.scheduledAt, prevDay, '今天那次已认领 ⇒ 继续往前找到昨天那次')

  // ★ 变异：把键换成"当前时刻"，同一个触发点在两次调用里就会变成两个键
  const keyA = occurrenceKey(t.id, dueAt(t, { now: T0800 + 1000, isClaimed })?.scheduledAt)
  const keyB = occurrenceKey(t.id, dueAt(t, { now: T0800 + 2000, isClaimed })?.scheduledAt)
  eq(keyA, keyB, '★ 两次调用（时刻不同）得到同一个键 —— 用 Date.now() 当键就会变红')

  // weekdays 过滤（任务用两周前建的，于是"上周一"确实算它的账）
  const mon = normalizeTask(
    baseTask({ repeat: { kind: 'daily', at: '08:00', weekdays: [1] }, createdAt: T0800 - 14 * 86_400_000 }),
  ).task
  // 2026-03-01 是周日
  const sunday = instantFromZoned('2026-03-01', 8 * 60, TZ)
  eq(
    dueAt(mon, { now: sunday + 60_000, isClaimed: () => false })?.scheduledAt,
    instantFromZoned('2026-02-23', 8 * 60, TZ),
    '周一任务在周日不会触发（往前找到上周一）',
  )
  eq(
    dueAt(mon, { now: instantFromZoned('2026-03-02', 8 * 60, TZ), isClaimed: () => false })?.scheduledAt,
    instantFromZoned('2026-03-02', 8 * 60, TZ),
    '到了周一就触发',
  )

  // 停用的任务永不触发
  const off = normalizeTask(baseTask({ enabled: false })).task
  eq(dueAt(off, { now: T0800 + 1000, isClaimed }), null, 'enabled:false 的任务永不触发')

  // interval（锚点 = effectiveFrom = max(创建时刻, 最近一个已到点的触发点)）
  const iv = normalizeTask(baseTask({ id: 'iv', repeat: { kind: 'interval', everyMs: 300_000 }, createdAt: T0800 })).task
  eq(iv.effectiveFrom, T0800, 'interval 的锚点 = effectiveFrom')
  eq(dueAt(iv, { now: T0800 + 301_000, isClaimed: () => false })?.scheduledAt, T0800 + 300_000, 'interval 按锚点步进')
  // 锚点那次（T0800）已经到点且没认领 ⇒ **欠着一次**，所以是它，不是"还没到点"
  eq(dueAt(iv, { now: T0800 + 100_000, isClaimed: () => false })?.scheduledAt, T0800, 'interval：锚点那次还没认领 ⇒ 就是它')
  // 锚点与第二个点都认领过之后，下一个点是 T0800+600s（还没到）⇒ null
  eq(
    dueAt(iv, {
      now: T0800 + 301_000,
      isClaimed: (k) => k === occurrenceKey('iv', T0800) || k === occurrenceKey('iv', T0800 + 300_000),
    }),
    null,
    'interval：已到过的点全认领了、下一个还没到 ⇒ null',
  )

  // once
  const once = normalizeTask(baseTask({ id: 'o1', repeat: { kind: 'once', at: new Date(T0800).toISOString() } })).task
  eq(dueAt(once, { now: T0800 + 1, isClaimed: () => false })?.scheduledAt, T0800, 'once 到点触发')
  eq(dueAt(once, { now: T0800 + 1, isClaimed: (k) => k === occurrenceKey('o1', T0800) }), null, 'once 认领过就不再触发')

  // 候选生成器必须终止（死循环是这类代码的经典坑）
  let n = 0
  for (const _ of candidateInstants(t, T0800 + 60_000, T0800 - 10 * 86_400_000)) {
    n += 1
    if (n > 5000) break
  }
  ok(n > 0 && n <= 5000, `候选生成器有界并会终止（跑了 ${n} 个候选）`)

  // 算"还有多久"（只用于展示）
  // ★ 语义：先问"现在欠不欠一次"。`(k) => true`（历史全认领）时才是纯未来计算
  const agedForNext = normalizeTask(baseTask({ id: 'next', createdAt: T0800 - 86_400_000 })).task
  eq(agedForNext.effectiveFrom, T0800 - 86_400_000, '昨天建的任务：算账起点就是创建时刻')
  const until = msUntilNext(agedForNext, { now: T0800 - 60_000, isClaimed: () => true })
  eq(until, 60_000, 'msUntilNext：历史都认领过 ⇒ 给下一跳的等待时间')
  eq(
    msUntilNext(agedForNext, { now: T0800 - 60_000, isClaimed: () => false }),
    0,
    '★ 历史里有没认领的点（昨天那次）⇒ 0 —— 与 `dueAt` **同一个口径**，否则巡检会显示"还要等一天"而它马上就要发',
  )
  eq(
    msUntilNext(agedForNext, {
      now: T0800 - 60_000,
      isClaimed: (k) => k === occurrenceKey('next', T0800 - 86_400_000),
    }),
    60_000,
    '昨天的认领了、今天还没到点 ⇒ 60 秒后触发',
  )
  eq(
    msUntilNext(agedForNext, { now: T0800 + 60_000, isClaimed: (k) => k === occurrenceKey('next', T0800) }),
    0,
    '★ 今天那次已到点、还没认领 ⇒ 0（"现在就该发"）',
  )
  // 全部认领过 ⇒ 等明天那次
  eq(
    msUntilNext(agedForNext, {
      now: T0800 + 60_000,
      isClaimed: (k) => k === occurrenceKey('next', T0800) || k === occurrenceKey('next', T0800 - 86_400_000),
    }),
    86_400_000 - 60_000,
    'msUntilNext：今天那次也认领过 ⇒ 等明天 8:00',
  )
  eq(msUntilNext(off, { now: T0800, isClaimed: () => false }), null, '停用任务没有"下一次"')
  // ★ 任务创建之前的点不算它的账（这条是实测抓出来的缺陷的回归）
  const bornToday = normalizeTask(baseTask({ id: 'born', createdAt: T0800 + 60_000 })).task
  // 创建于 8:01 ⇒ 第一个"在它之后"的触发点是**明天 8:00**
  eq(bornToday.effectiveFrom, T0800 + 86_400_000, '★ 创建于 8:01 的「每天 8:00」：算账起点是明天 8:00（当天 8:00 不算它的账）')
  eq(dueAt(bornToday, { now: T0800 + 120_000, isClaimed: () => false }), null, '★ 所以它当天不会去追 8:00 那一笔（实测缺陷的回归）')
}

console.log('\n=== ④ 落盘：任务读写 / 坏任务不拖垮别的 / 删除用 unlinkSync ===')
{
  const ws = tmpRoot()
  const w = writeTask({ workspace: ws, task: baseTask(), now: T0800 })
  ok(w.ok, '写一条任务成功')
  ok(existsSync(join(ws, taskRel('wake8'))), '任务文件真的落在 runtime/schedule/ 下')
  const back = readTask({ workspace: ws, id: 'wake8' })
  eq(back?.title, '8 点叫我', '读回来内容对得上')

  writeTask({ workspace: ws, task: baseTask({ id: 'b2', title: '提醒吃饭' }), now: T0800 })
  const all = listTasks({ workspace: ws })
  eq(all.tasks.length, 2, '列出两条任务')
  eq(all.problems.length, 0, '没有坏任务')

  // 坏任务：一条烂 JSON 不许让整个调度器停摆，但**必须被看见**
  writeFileSync(join(ws, SCHEDULE_DIR, 'broken.json'), '{ 这不是 JSON', 'utf8')
  const all2 = listTasks({ workspace: ws })
  eq(all2.tasks.length, 2, '坏任务被跳过，好任务照常列出')
  eq(all2.problems.length, 1, '★ 坏任务被单独报出来（不许静默跳过）')
  eq(all2.problems[0].id, 'broken', '报出的是哪一条')

  // 写校验不过就不写（不许写半个）
  const bad = writeTask({ workspace: ws, task: { id: 'x', title: 't' } })
  eq(bad.ok, false, '校验不过拒绝写入')
  ok(!existsSync(join(ws, taskRel('x'))), '拒绝写入时磁盘上一个字都没留下')

  // 更新任务不该清掉 lastFiredAt（清了就会重发一次）
  markTaskFired({ workspace: ws, id: 'wake8', scheduledAt: T0800, now: T0800 + 1000 })
  eq(readTask({ workspace: ws, id: 'wake8' }).lastScheduledAt, T0800, 'markTaskFired 记下上次触发点')
  writeTask({ workspace: ws, task: baseTask({ title: '改了个名字' }), now: T0800 + 5000 })
  const after = readTask({ workspace: ws, id: 'wake8' })
  eq(after.title, '改了个名字', '更新生效')
  eq(after.lastScheduledAt, T0800, '★ 更新任务**保留** lastFiredAt/lastScheduledAt（否则会重发一次）')
  eq(after.createdAt, T0800 - 1000, 'createdAt 也保留（interval 的锚点、以及"创建前不算账"的下界都靠它）')

  const del = deleteTask({ workspace: ws, id: 'wake8' })
  ok(del.ok, '删除任务成功（走 unlinkSync）')
  ok(!existsSync(join(ws, taskRel('wake8'))), '文件真的没了')
  eq(deleteTask({ workspace: ws, id: 'wake8' }).ok, false, '删不存在的任务如实报错')

  // 发布卫生：任务定义属于使用者数据
  ok(isScheduleUserData('runtime/schedule/wake8.json'), '任务定义被认成使用者数据')
  ok(isScheduleUserData(FIRES_REL), '触发台账被认成使用者数据')
  ok(isScheduleUserData(MISSED_REL), '错过台账被认成使用者数据')
  ok(isScheduleUserData('runtime/schedule-history.jsonl'), '执行历史被认成使用者数据')
  ok(!isScheduleUserData('src/schedule.mjs'), '源码**不是**使用者数据（别误挡）')
  ok(!isScheduleUserData('runtime/tasks/group_1.json'), '任务台账**不是**本模块的数据（两条轴别混）')
}

console.log('\n=== ⑤ 台账：JSONL / 坏行 / 后者胜 / 裁剪 ===')
{
  const ws = tmpRoot()
  const task = normalizeTask(baseTask()).task
  claimFire({ workspace: ws, task, scheduledAt: T0800, now: T0800, lateByMs: 0 })
  let idx = readFireIndex({ workspace: ws })
  eq(idx.map.get(occurrenceKey('wake8', T0800))?.status, 'claimed', '认领写进去了')

  settleFire({ workspace: ws, key: occurrenceKey('wake8', T0800), status: 'delivered', chars: 12, now: T0800 + 5000 })
  idx = readFireIndex({ workspace: ws })
  eq(idx.map.get(occurrenceKey('wake8', T0800))?.status, 'delivered', '同一键后者胜（delivered 覆盖 claimed）')
  eq(idx.map.get(occurrenceKey('wake8', T0800))?.chars, 12, '补上的结果字段读得到')

  // 坏行：跳过并计数，不许整份读不出来
  writeFileSync(join(ws, FIRES_REL), `${readFileSync(join(ws, FIRES_REL), 'utf8')}这不是 JSON\n`, 'utf8')
  const withBad = readFireIndex({ workspace: ws })
  ok(withBad.ok, '有坏行时整份仍然读得出来')
  ok(withBad.bad >= 1, '坏行被计数（不许静默吞掉）')

  // 历史：模型现写 ⇒ 原文是唯一能事后核对的东西
  const h = noteHistory({ workspace: ws, task, scheduledAt: T0800, text: '起床了！', now: T0800 + 6000 })
  ok(h.ok, '执行历史能写')
  const hist = readLedger('runtime/schedule-history.jsonl', { workspace: ws })
  eq(hist.rows.at(-1)?.text, '起床了！', '历史里存的是**实际发出去的原文**')

  // 错过台账
  noteMissed({ workspace: ws, task, scheduledAt: T0800 - 86_400_000, now: T0800, lateByMs: 50 * 60_000 })
  const m = readLedger(MISSED_REL, { workspace: ws })
  eq(m.rows.length, 1, '错过台账写入成功')
  eq(m.rows[0].taskId, 'wake8', '错过记录带任务 id')

  // 裁剪：超过上限丢最旧，且保留最近的
  const ws2 = tmpRoot()
  for (let i = 0; i < 20; i += 1) {
    settleFire({ workspace: ws2, key: `k${i}`, status: 'delivered', now: T0800 + i })
  }
  const pr = pruneLedgers({ workspace: ws2, maxLines: 5 })
  const prFires = pr.find((x) => x.rel === FIRES_REL)
  eq(prFires?.kept, 5, '裁剪后只留 5 行')
  eq(prFires?.dropped, 15, '如实报出丢了几行')
  const kept = readLedger(FIRES_REL, { workspace: ws2 })
  eq(kept.rows.at(-1)?.key, 'k19', '裁掉的是**最旧**的，最新的还在')

  // 读不存在的台账：是"空"，不是"错"
  const empty = readLedger(MISSED_REL, { workspace: tmpRoot() })
  ok(empty.ok && empty.rows.length === 0, '台账不存在时返回空且不报错（新装的机器就是这样）')
}

console.log('\n=== ⑥ ★★★ 恰好一次：三次真实事故形状的变异断言 ===')
{
  const ws = tmpRoot()
  const task = normalizeTask(baseTask()).task
  const calls = []
  const bridge = {
    resolveTarget: () => ({ ok: true, sessionId: 'qq-abc', chatKey: 'private:100000001', tier: 'admin' }),
    runProactiveTurn: async ({ task: t, scheduledAt }) => {
      calls.push(`${t.id}@${scheduledAt}`)
      return { ok: true, text: '起床了！', via: 'model' }
    },
  }
  let clock = T0800
  const runner = createScheduleRunner({
    workspace: ws,
    bridge,
    tickMs: 30_000,
    log: () => {},
    now: () => clock,
  })
  writeTask({ workspace: ws, task: baseTask(), now: T0800 - 1000 })

  // ① 到点那一跳发一次
  await runner.tick()
  eq(calls.length, 1, '到点后发一次')
  // ② 同一分钟内的下一跳 **不能再发**
  clock = T0800 + 30_000
  await runner.tick()
  clock = T0800 + 60_000
  await runner.tick()
  eq(calls.length, 1, '★ 同一触发点在后续 tick 上**不会重复发**（这就是"恰好一次"）')
  // ③ 第二天到点再发一次（不是"只发一次就再也不发"）
  clock = T0800 + 86_400_000
  await runner.tick()
  eq(calls.length, 2, '第二天到点照常触发（去重是按触发点，不是按任务）')

  // ④ 重启（新建一个 runner，同一份盘）**不许**把昨天那条再发一遍
  const calls2 = []
  const bridge2 = {
    resolveTarget: () => ({ ok: true, sessionId: 'qq-abc', chatKey: 'private:100000001', tier: 'admin' }),
    runProactiveTurn: async ({ task: t, scheduledAt }) => {
      calls2.push(`${t.id}@${scheduledAt}`)
      return { ok: true, text: '起床了！' }
    },
  }
  const runner2 = createScheduleRunner({ workspace: ws, bridge: bridge2, log: () => {}, now: () => clock })
  await runner2.tick()
  eq(calls2.length, 0, '★ 重启后**不会**重发已经认领过的触发点（去重靠台账，不靠内存）')

  // ⑤ 停用 / 认领失败 / 目标不可用 三条失败路径都不许静默
  const logs = []
  const ws3 = tmpRoot()
  const failRunner = createScheduleRunner({
    workspace: ws3,
    bridge: {
      resolveTarget: () => ({ ok: false, why: '名单里没有这个会话' }),
      runProactiveTurn: async () => ({ ok: true, text: '不该走到这里' }),
    },
    log: (m) => logs.push(String(m)),
    now: () => T0800,
  })
  writeTask({ workspace: ws3, task: baseTask(), now: T0800 - 1000 })
  await failRunner.tick()
  ok(
    logs.some((l) => l.includes('目标会话不可用')),
    '目标会话不可用时**留痕**（不许静默：那会表现成"到点了它什么都没说"）',
  )
  eq(readFireIndex({ workspace: ws3 }).map.get(occurrenceKey('wake8', T0800))?.status, 'failed', '失败也落进台账（可查）')
  const logs2 = []
  const emptyRunner = createScheduleRunner({
    workspace: ws3,
    bridge: {
      resolveTarget: () => ({ ok: true, sessionId: 's', chatKey: 'private:1', tier: 'admin' }),
      runProactiveTurn: async () => ({ ok: false, why: '模型没有产出内容' }),
    },
    log: (m) => logs2.push(String(m)),
    now: () => T0800 + 86_400_000,
  })
  await emptyRunner.tick()
  ok(logs2.some((l) => l.includes('没有产出内容')), '模型空回复时留痕，且**不重跑模型**')
  eq(calls.length, 2, '空回复那一轮没有额外请求（不重跑）')
}

console.log('\n=== ⑦ 迟到与错过：不补发，但必须留证据 ===')
{
  const ws = tmpRoot()
  const logs = []
  const calls = []
  let clock = T0800 + 20_000 // 晚了 20 秒（在容差内）
  const runner = createScheduleRunner({
    workspace: ws,
    bridge: {
      resolveTarget: () => ({ ok: true, sessionId: 's', chatKey: 'private:1', tier: 'admin' }),
      runProactiveTurn: async ({ lateByMs }) => {
        calls.push(lateByMs)
        return { ok: true, text: '起床了（晚了点）' }
      },
    },
    log: (m) => logs.push(String(m)),
    now: () => clock,
  })
  writeTask({ workspace: ws, task: baseTask(), now: T0800 - 1000 })
  await runner.tick()
  eq(calls.length, 1, '容差窗口内 ⇒ 照常触发')
  ok(calls[0] >= 20_000, '把"晚了多少"如实传给执行侧（它要在提示词里说明，不许假装准时）')

  // 超过容差 ⇒ 不补发 + 记错过台账
  const ws2 = tmpRoot()
  const logs2 = []
  const calls2 = []
  const late = T0800 + 30 * 60_000
  const runner2 = createScheduleRunner({
    workspace: ws2,
    bridge: {
      resolveTarget: () => ({ ok: true, sessionId: 's', chatKey: 'private:1', tier: 'admin' }),
      runProactiveTurn: async () => {
        calls2.push(1)
        return { ok: true, text: 'x' }
      },
    },
    log: (m) => logs2.push(String(m)),
    now: () => late,
  })
  writeTask({ workspace: ws2, task: baseTask(), now: T0800 - 1000 })
  // ★ 不预先认领：这一跳面对的就是"任务建好之后第一次到点、但已经迟到 30 分钟"
  await runner2.tick()
  eq(calls2.length, 0, '★ 迟到超过容差 ⇒ **不补发**（使用者拍板的口径）')
  const missedRows = readLedger(MISSED_REL, { workspace: ws2 }).rows
  eq(missedRows.length, 1, '★ 但**必须**记进错过台账（不许静默消失）')
  eq(missedRows[0].scheduledAt, T0800, '错过台账记的是原来的触发点')
  ok(
    logs2.some((l) => l.includes('不补发')),
    '日志里明确说"不补发"（使用者要知道发生了什么）',
  )
  // 认领掉之后不许反复记错过
  await runner2.tick()
  eq(readLedger(MISSED_REL, { workspace: ws2 }).rows.length, 1, '错过只记一次（认领掉了，不会每跳重记）')

  // 错过台账 → 提示词段
  const block = renderMissedBlock(missedRows, { timeZone: TZ, max: 5 })
  ok(block.includes('没有发出去'), '错过段明说"没发出去"')
  ok(block.includes('不要现在补发'), '错过段明说**不要补发**（否则模型会一口气全倒出来）')
  ok(block.includes('8 点叫我'), '错过段带上任务名（人话，不是 id）')
  eq(renderMissedBlock([]), '', '没有错过时一个字都不产生（提示词逐字基线因此不受影响）')
}

console.log('\n=== ⑧ 重启残局：claimed 接着做完 / sending 只报告不重做 ===')
{
  const ws = tmpRoot()
  // ★ 任务的算账下界（effectiveFrom）就是 T0800，所以残局正好落在这一次上
  const task = normalizeTask(baseTask()).task
  eq(task.effectiveFrom, T0800, '残局用例的前置：effectiveFrom = T0800')
  // 造一个"认领了但没开工"的残局
  claimFire({ workspace: ws, task, scheduledAt: T0800, now: T0800, lateByMs: 0 })
  const logs = []
  const calls = []
  const runner = createScheduleRunner({
    workspace: ws,
    bridge: {
      resolveTarget: () => ({ ok: true, sessionId: 's', chatKey: 'private:1', tier: 'admin' }),
      runProactiveTurn: async ({ scheduledAt }) => {
        calls.push(scheduledAt)
        return { ok: true, text: '补上了' }
      },
    },
    log: (m) => logs.push(String(m)),
    now: () => T0800 + 10_000,
  })
  writeTask({ workspace: ws, task: baseTask(), now: T0800 - 1000 })
  await runner.tick()
  eq(calls.length, 1, '★ `claimed`（认领了没开工）⇒ 重启后**接着做完**（同一次触发）')
  eq(calls[0], T0800, '接着做的是**原来那个**触发点（不是新的）')
  eq(readFireIndex({ workspace: ws }).map.get(occurrenceKey('wake8', T0800))?.status, 'delivered', '做完后状态是 delivered')
  ok(logs.some((l) => l.includes('接着做完')), '启动对账时把残局说清楚了')
  // 再做一次 tick：已经 delivered，不许再发
  await runner.tick()
  eq(calls.length, 1, '做完之后不再重复')

  // `sending`（开过工）⇒ 只报告，绝不重做
  const ws2 = tmpRoot()
  const logs2 = []
  const calls2 = []
  claimFire({ workspace: ws2, task, scheduledAt: T0800, now: T0800, lateByMs: 0 })
  settleFire({ workspace: ws2, key: occurrenceKey('wake8', T0800), status: 'sending', now: T0800 })
  const runner2 = createScheduleRunner({
    workspace: ws2,
    bridge: {
      resolveTarget: () => ({ ok: true, sessionId: 's', chatKey: 'private:1', tier: 'admin' }),
      runProactiveTurn: async () => {
        calls2.push(1)
        return { ok: true, text: '不该重做' }
      },
    },
    log: (m) => logs2.push(String(m)),
    now: () => T0800 + 10_000,
  })
  writeTask({ workspace: ws2, task: baseTask(), now: T0800 - 1000 })
  const rec = runner2.reconcile()
  eq(rec.maybeSent.length, 1, '启动对账认出"可能已经说出去"的那条')
  eq(rec.dangling.length, 0, '它不是"没开工"那一类')
  ok(
    logs2.some((l) => l.includes('不自动重做')),
    '★ 明确报出"不自动重做"（与投递账本同一条结论：重复比漏更糟）',
  )
  await runner2.tick()
  eq(calls2.length, 0, '★ `sending` 之后崩溃 ⇒ **一次都不重做**')
}

console.log('\n=== ⑨ 执行器：定时器 / 开关 / 配额 / 不许拖住进程 ===')
{
  const ws = tmpRoot()
  const task = normalizeTask(baseTask()).task
  const logs = []
  // 可注入定时器 ⇒ 能离线验证 start/stop 与 unref
  const timers = []
  const timer = {
    setInterval: (fn, ms) => {
      const h = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true } }
      timers.push(h)
      return h
    },
    clearInterval: (h) => {
      h.cleared = true
    },
  }
  const runner = createScheduleRunner({ workspace: ws, bridge: null, log: (m) => logs.push(String(m)), timer })
  ok(runner.start(), 'start 成功')
  eq(timers.length, 1, '挂了一个 interval')
  eq(timers[0].ms, DEFAULT_TICK_MS, '默认 30 秒一跳')
  ok(timers[0].unrefCalled, '★ 调了 unref()（绝不能让任务定时器把进程退出拖住）')
  runner.stop()
  ok(timers[0].cleared, 'stop 清掉了定时器')
  eq(runner.isRunning(), false, 'stop 之后不再运行')
  eq(runner.start(), true, '可以再次启动')
  runner.stop()

  // 没注入 bridge ⇒ 不许静默
  const logs2 = []
  const r2 = createScheduleRunner({ workspace: ws, log: (m) => logs2.push(String(m)), now: () => T0800 })
  const t = await r2.tick()
  eq(t.ok, false, '没注入执行能力时 tick 报告失败')
  ok(logs2.some((l) => l.includes('内部接线问题')), '★ 接线缺失必须喊（AGENT.md 第 9 条）')

  // 关闭开关 ⇒ 一次都不动手（零成本）
  const logs3 = []
  let called = 0
  const r3 = createScheduleRunner({
    workspace: ws,
    bridge: {
      resolveTarget: () => ({ ok: true, sessionId: 's', chatKey: 'private:1', tier: 'admin' }),
      runProactiveTurn: async () => {
        called += 1
        return { ok: true, text: 'x' }
      },
    },
    config: { schedule: { enabled: false } },
    log: (m) => logs3.push(String(m)),
    now: () => T0800,
  })
  writeTask({ workspace: ws, task, now: T0800 - 1000 })
  const t3 = await r3.tick()
  eq(t3.skipped, 'disabled', '关掉之后这一跳直接跳过')
  eq(called, 0, '★ 关掉 = 一次模型调用都不产生')
  eq(r3.start(), false, '关掉时 start 不挂定时器')
  ok(logs3.some((l) => l.includes('未开启')), '关掉这件事在启动时说清楚（别让人以为它在跑）')

  // tick 间隔下限
  const r4 = createScheduleRunner({ workspace: ws, bridge: null, config: { schedule: { tickMs: 10 } }, log: () => {} })
  ok(MIN_TICK_MS >= 10_000, '间隔下限存在（防手滑把 CPU 打满）')
  eq(r4.stats().ticks, 0, 'stats 可读（巡检要用）')

  // tick 抛异常不许带走进程
  const logs4 = []
  const r5 = createScheduleRunner({
    workspace: ws,
    bridge: {
      resolveTarget: () => {
        throw new Error('炸了')
      },
      runProactiveTurn: async () => ({ ok: true, text: 'x' }),
    },
    log: (m) => logs4.push(String(m)),
    now: () => T0800,
  })
  const t5 = await r5.tick()
  ok(t5.ok, 'resolveTarget 抛异常时 tick **仍然返回**（不许把这一跳搞挂）')
  ok(logs4.some((l) => l.includes('抛异常')), '抛异常留痕')
  eq(readFireIndex({ workspace: ws }).map.get(occurrenceKey('wake8', T0800))?.status, 'failed', '失败记账（可查）')
}

console.log('\n=== ⑩ 提示词措辞：三条纪律（不许它回"好的我知道了"）===')
{
  const task = normalizeTask(baseTask()).task
  const block = renderScheduleTaskBlock({ task, scheduledAt: T0800, now: T0800 })
  ok(block.includes('定时任务'), '段落标题表明这是定时任务')
  ok(block.includes('不是对方刚说的话'), '★ ① 明说这不是对方刚说的话（否则它会回"好的我记下了"）')
  ok(block.includes('叫我起床'), '把任务原文给它（它照着说）')
  ok(block.includes('2026-03-01 08:00'), '把约定的时刻告诉它')
  ok(block.includes('直接说那句'), '★ ③ 明说直接说那句话（别做元讨论）')
  ok(!block.includes('晚了'), '准时时不提迟到（不许无中生有）')

  const late = renderScheduleTaskBlock({ task, scheduledAt: T0800, now: T0800 + 7 * 60_000 })
  ok(late.includes('晚了约 7 分钟'), '★ ② 迟到时如实说明晚了多少（假装准时就是骗人）')
  ok(late.includes('别假装你准时'), '并明确要求不许假装准时')

  eq(renderScheduleTaskBlock({ task: null }), '', '没有任务时一个字都不产生')
}

console.log('\n=== ⑪ 改名/收尾行为的回归 ===')
{
  // 认领失败 ⇒ 宁可不发（可能重复），但必须喊
  const logs = []
  const runner = createScheduleRunner({
    workspace: '',
    bridge: { resolveTarget: () => ({ ok: true }), runProactiveTurn: async () => ({ ok: true, text: 'x' }) },
    log: (m) => logs.push(String(m)),
    now: () => T0800,
  })
  const t = await runner.tick()
  eq(t.ok, false, '没有 workspace 时如实失败')
  ok(logs.some((l) => l.includes('workspace')), '缺 workspace 时喊出来')
  throwsOrNot(() => {}, '（占位）空操作不抛')
  const listed = listTasks({ workspace: tmpRoot() })
  ok(listed.ok && listed.tasks.length === 0, '新装的机器：没有任何任务时为"空"，不是"错"')
}

console.log('\n=== ⑫ ★★★ 接线级：走**完整桥接**（纯函数测试看不见接线）===')
//
// 为什么这一节不能省（本项目的原话）：离线测试只能证明"纯函数对"，
// 而**错在接线**——那个段在真机上从未注入过，而 124 项纯函数断言全绿。
// 所以这里造一个真 Bridge + 桩 rpc，断言"到点真的产生了 session/prompt""那段真的进去了"。
{
  const { Bridge } = await import('../src/bridge.mjs')
  const { SessionRouter } = await import('../src/session-bridge.mjs')
  const { SendQueue } = await import('../src/onebot.mjs')

  const ADMIN = '100000001'
  const GROUP = '700000001'

  /** 造一个最小可用的真桥接（只给这一节需要的字段，其余按既有桩的形状）。 */
  function wiringBridge({ scheduleEnabled = true } = {}) {
    const WS = tmpRoot()
    const router = new SessionRouter({ log: () => {} })
    const logs = []
    const log = (m) => logs.push(String(m))
    const config = {
      dsh: { workspace: WS, permissionMode: 'workspace-write' },
      onebot: {},
      access: { adminUsers: [ADMIN], dmAllowlist: [], groupAllowlist: [GROUP] },
      trigger: { private: true, mention: true, keyword: true, groupEnabled: true, keywords: ['小鲸鱼'] },
      send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
      turn: { timeoutMs: 5000 },
      humanize: { enabled: false, chunkChars: 300 },
      persona: { preset: 'none' },
      memory: { enabled: false },
      image: { enabled: false },
      // ★ 定时任务：这一节要验的就是它开着的时候
      schedule: { enabled: scheduleEnabled },
    }

    const rpc = new EventTarget()
    rpc.prompts = []
    rpc.prompt = async (sessionId, contentBlocks) => {
      rpc.prompts.push(String(contentBlocks?.[0]?.text ?? ''))
      router.handleEvent(sessionId, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '起床了！' }] } },
      })
      router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
      return { messageId: 'm1' }
    }

    const onebot = new EventTarget()
    onebot.selfId = '200000001'
    onebot.call = async () => ({ status: 'ok', retcode: 0, data: null })
    const sent = []
    onebot.send = async (kind, peerId, text, opts) => {
      sent.push({ kind, peerId, text, ...(opts ?? {}) })
      return { status: 'ok', retcode: 0, data: { message_id: `s${sent.length}` } }
    }

    const sendQueue = new SendQueue({ ...config.send, log })
    const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log })
    return { bridge, rpc, sent, logs, WS, router }
  }

  const privateMsg = (userId, text) => ({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    user_id: userId,
    self_id: '200000001',
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: userId, nickname: `用户${userId}` },
  })

  // ── ① 目标会话判据：**没来过消息 ⇒ 拒发**（fail-closed，不往陌生号码发）──
  {
    const { bridge } = wiringBridge()
    bridge.attach()
    const r = bridge.resolveScheduleTarget({ kind: 'private', peerId: '999999999' })
    eq(r.ok, false, '★ 从没来过消息的号码 ⇒ 拒绝（§4 的"号码不猜"）')
    ok(/没有来过消息|从没有来过消息/.test(r.why ?? ''), '拒绝原因说清"从没有来过消息"')
    await bridge.close({ timeoutMs: 200 })
  }

  // ── ② 来过消息之后 ⇒ 通过，且 sessionId 用**构造期固定的 instance** ──
  {
    const { bridge, rpc, sent, WS } = wiringBridge()
    bridge.attach()
    await bridge.handleEvent(privateMsg(ADMIN, '在吗'))
    const afterChat = bridge.resolveScheduleTarget({ kind: 'private', peerId: ADMIN })
    ok(afterChat.ok, '来过消息之后 ⇒ 目标可解析')
    ok(Boolean(afterChat.sessionId), '给了 sessionId')
    eq(afterChat.chatKey, `private:${ADMIN}`, 'chatKey 与会话键同口径')

    // ★★ 最关键的那一条：**到点真的产生了一次 session/prompt**，而且不是唤醒判定
    //   （没有触发词、没有人 @ 它 —— 这一轮完全由时钟发起）
    const before = rpc.prompts.length
    const due = Date.now()
    writeTask({
      workspace: WS,
      task: {
        id: 'wake8',
        title: '8 点叫我',
        repeat: { kind: 'once', at: new Date(due - 1000).toISOString() },
        target: { kind: 'private', peerId: ADMIN },
        prompt: '叫我起床',
        requestedBy: '主人',
        timezone: TZ,
      },
      now: due - 2000,
    })
    const tick = await bridge.scheduleNow()
    eq(tick.ok, true, '手动跑一跳成功')
    eq(rpc.prompts.length, before + 1, '★★ 到点**真的产生了一次 session/prompt**（时钟发起，不是被谁叫醒）')
    const prompt = String(rpc.prompts.at(-1) ?? '')
    ok(prompt.includes('定时任务'), '★ 提示词里**真的有**定时任务那一段（接线没断）')
    ok(prompt.includes('叫我起床'), '任务原话进了提示词')
    ok(prompt.includes('不是对方刚说的话'), '★ 并且明说这不是对方刚说的话（否则它会回"好的我记下了"）')
    // 发出的条数：1 条 = 上面那句"在吗"的回复，1 条 = 定时任务那条（**不写死总数**，
    // 只按正文找那一条 —— 写死总数或位置会在别的环节多发一条时变成假失败）
    const taskMsg = sent.find((x) => x.text === '起床了！')
    ok(Boolean(taskMsg), '定时任务那条真的发出去了（走的是 #deliver 那条管线）')
    eq(taskMsg?.peerId, ADMIN, '发给了任务指定的会话')

    // ── ③ 台账留痕：认领 → 开工 → 结果，三段都在 ──
    const rows = readLedger(FIRES_REL, { workspace: WS }).rows
    const statuses = rows.map((r) => r.status)
    ok(statuses.includes('claimed'), '台账里有 claimed（**在调模型之前**写的）')
    ok(statuses.includes('sending'), '台账里有 sending（开工标记 —— "绝不自动重做"那条边界的落点）')
    ok(statuses.includes('delivered'), '台账里有 delivered（结果）')
    const hist = readLedger('runtime/schedule-history.jsonl', { workspace: WS }).rows
    eq(hist.at(-1)?.text, '起床了！', '★ 执行历史记下了**实际发出去的原文**（模型现写 ⇒ 唯一能事后核对的）')

    // ── ④ ★★ 主动回合**不进 `#pending`**：使用者随后说一句话，不许把它作废 ──
    //   这一条是真机风险的回归：若主动回合进了 pending，用户随后那条发言会被
    //   判成"同一发言人连发"而作废掉那次定时任务 ⇒ 表现是"8 点的提醒偶尔不说"。
    //
    //   ★ 造法必须**确定性**：让"模型产出主动那条的回复"发生在用户消息之后
    //     （桩里用一个可控的 promise），而不是靠两个 setImmediate 抢时序 ——
    //     抢时序会留下未结算的 promise（本项目已有一条同类教训：unref 的定时器
    //     会让测试以 "unsettled top-level await + 退出码 13" 的样子失败，而不是断言失败）。
    const due2 = Date.now()
    writeTask({
      workspace: WS,
      task: {
        id: 'wake8b',
        title: '第二次',
        repeat: { kind: 'once', at: new Date(due2 - 500).toISOString() },
        target: { kind: 'private', peerId: ADMIN },
        prompt: '再说一次',
        timezone: TZ,
      },
      now: due2 - 1000,
    })

    const gate = (() => {
      let open
      const p = new Promise((r) => {
        open = r
      })
      return { p, open }
    })()
    let armed = false
    const origPrompt = rpc.prompt
    rpc.prompt = async (sessionId, blocks) => {
      if (armed) {
        const text = String(blocks?.[0]?.text ?? '')
        // 只有"定时任务那一轮"才等闸门（普通回合照常立刻产出）
        if (text.includes('定时任务')) {
          armed = false
          await gate.p
          return origPrompt(sessionId, blocks)
        }
      }
      return origPrompt(sessionId, blocks)
    }

    const before2 = sent.length
    armed = true
    const proactive = bridge.scheduleNow()
    // 让"用户随后那条"落在主动回合**已经开工、还没产出**的窗口里
    const userMsg = bridge.handleEvent(privateMsg(ADMIN, '在吗在吗'))
    gate.open()
    const [tickRes] = await Promise.all([proactive, userMsg])
    rpc.prompt = origPrompt

    ok(tickRes?.ok === true, '★ 主动那条没有被随后到达的用户消息作废（它不在 #pending 里）')
    const newTexts = sent.slice(before2).map((x) => x.text)
    ok(newTexts.includes('起床了！'), '★ 而且它**真的发出去了**（"没被作废"的证据是消息本身，不是返回值）')

    await bridge.close({ timeoutMs: 300 })
  }

  // ── ⑤ 关掉开关 ⇒ 一个定时器都不挂、一跳都不动手（零成本）──
  {
    const { bridge, rpc, logs } = wiringBridge({ scheduleEnabled: false })
    bridge.attach()
    const r = bridge.scheduleNow()
    eq(r.ok, false, '关掉时 scheduleNow 如实说"没启动"')
    eq(rpc.prompts.length, 0, '★ 关掉 = 一次模型调用都不产生')
    ok(
      logs.every((l) => !l.includes('[schedule] 定时任务已开启')),
      '关掉时不会打印"已开启"（别让人以为它在跑）',
    )
    await bridge.close({ timeoutMs: 200 })
  }

  // ── ⑥ ★★★ 0.3.2 补：界面上"从关到开"必须**就地生效**，不许等重启 ──────
  //
  // 用户报的原文：「我在拓展中开启了定时任务功能，但是标签页中显示未开启且读不到
  // 定时任务」。其中"开了却不跑"这一半的形状是：扩展服务改的是活配置对象，
  // 而**定时器对象**原先只在 `attach()` 里建 ⇒ 开关显示已开启，一条都不会触发。
  // 现在开关落盘时会调 `bridge.syncScheduleRunner()`（幂等），这一段钉住它。
  {
    const { bridge, rpc, sent, logs } = wiringBridge({ scheduleEnabled: false })
    bridge.attach()
    eq(bridge.scheduleStats().running, false, '（准备）关着 ⇒ 定时器没挂上')

    // 模拟"在扩展页把它打开"：活配置对象被就地改了（扩展服务就是这么做的）
    bridge.config.schedule.enabled = true
    const on = bridge.syncScheduleRunner()
    eq(on.changed, true, '★ 开关变了 ⇒ 就地挂上')
    eq(on.running, true, '★★ 定时器真的挂上了')
    eq(bridge.scheduleStats().running, true, '★★★ 状态查询也如实说它挂上了（界面据此显示"已开启"）')
    ok(logs.some((l) => l.includes('定时任务已开启')), '★ 而且留了一行日志（+ immediately 生效这件事可查）')

    // ★ 幂等：再调一次不许挂出第二个定时器
    const again = bridge.syncScheduleRunner()
    eq(again.changed, false, '★★ 再同步一次什么都不做（幂等：不会挂出第二个 interval）')
    eq(again.running, true, '★ 仍然是在跑')

    // ★ 挂上之后**真的会触发**（这才是"生效"的证据，不是返回值）
    const before = sent.length
    const due = Date.now()
    writeTask({
      workspace: bridge.config.dsh.workspace,
      task: {
        id: 'hot8',
        title: '8 点叫我',
        repeat: { kind: 'once', at: new Date(due - 1000).toISOString() },
        target: { kind: 'private', peerId: ADMIN },
        prompt: '叫我起床',
        requestedBy: '主人',
        timezone: TZ,
      },
      now: due - 2000,
    })
    // 先造一条"来过消息"的记录（目标判定要它，fail-closed）
    await bridge.handleEvent(privateMsg(ADMIN, '在吗'))
    const tick = await bridge.scheduleNow()
    eq(tick.ok, true, '★★ 就地挂上之后**立刻能跑一跳**（不必重启桥接）')
    ok(sent.slice(before).some((x) => x.text === '起床了！'), '★★★ 而且那条提醒真的发出去了')
    eq(rpc.prompts.length >= 1, true, '★ 产生了一次模型调用')

    // 关掉 ⇒ 摘掉
    bridge.config.schedule.enabled = false
    const off = bridge.syncScheduleRunner()
    eq(off.changed, true, '★ 关掉 ⇒ 就地摘掉')
    eq(bridge.scheduleStats().running, false, '★★ 状态查询如实说没挂上')
    eq(bridge.scheduleNow().ok, false, '★ 摘掉之后不再跑（一条都不触发）')
    await bridge.close({ timeoutMs: 200 })
  }
}

// ── 收尾 ────────────────────────────────────────────────────────────────
for (const d of roots) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {
    /* 临时目录清理失败无所谓 */
  }
}

console.log(`\n${fail === 0 ? '🎉' : '❌'} 定时任务测试：${pass} 项通过、${fail} 项失败`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
