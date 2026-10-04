/**
 * **启动窗口**测试（0.3.2 收尾）—— `src/servers/starting.mjs`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套守的是什么（不守会出人命的那种）
 * ══════════════════════════════════════════════════════════════════════════
 * 模组服冷启动 **18~60 秒**（首次能到 1~2 分钟），而判 down 的判据是
 * "连续 `failThreshold` 次"（默认 2）、采样间隔默认 30 秒
 * ⇒ **服务端还在加载时就会被判成 down**。后果最重的一条：
 *   `down` 是**唯一允许触发重启**的那一类 ⇒ "我刚把它拉起来，它自己又把那一个
 *   当成挂了、再拉一个" ⇒ **两个 JVM 同写一个世界 = 存档损坏（不可逆）**。
 *
 * ∴ 断言全围着"什么时候算正在启动、什么时候**不许**算"：
 *   ① 没记台账 ⇒ **绝不算**启动中（否则会把"别人的服务端"说成"我在启动它"）；
 *   ② 窗口内 + 端口没开 ⇒ 算启动中；
 *   ③ **端口开了 ⇒ 立刻不算**（剩下的是"等 RCON 登录"，那是另一回事）；
 *   ④ 窗口过了 ⇒ **过期**（不再算启动中，调用方该如实说超时）；
 *   ⑤ 台账**落盘**（桥接重启/崩溃后必须还记得 —— 否则重启窗口里又会误报 down）；
 *   ⑥ 坏台账 ⇒ 当没有（**不猜**），且读它永不抛。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_STARTUP_WINDOW_MS,
  clearStarting,
  describeStarting,
  evaluateStarting,
  markStarting,
  readStarting,
  startingPath,
} from '../src/servers/starting.mjs'

let pass = 0
let fail = 0
const failures = []
function ok(cond, label, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${label}${detail ? `  —— ${detail}` : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, label, same ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`)
}

const mkWs = () => {
  const ws = mkdtempSync(join(tmpdir(), 'qqb-starting-'))
  mkdirSync(join(ws, 'runtime/servers'), { recursive: true })
  return ws
}

console.log('\n=== ① ★★★ 没记台账 ⇒ **绝不算**启动中（否则会把别人的服务端说成我在启动它）===')
{
  const ws = mkWs()
  eq(readStarting({ workspace: ws, serverId: 's1' }), null, '没写过 ⇒ null')
  const ev = evaluateStarting({ state: null, portOpen: false })
  eq(ev.starting, false, '★★★ state=null ⇒ **不算启动中**')
  eq(ev.expired, false, '★ 也不算"过期"（那是两件事）')
  eq(ev.waitedMs, 0, '等待时长 0')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ② 窗口内 + 端口没开 ⇒ 算启动中 ===')
{
  const ws = mkWs()
  const t0 = 1_700_000_000_000
  markStarting({ workspace: ws, serverId: 's1', pid: 4242, windowMs: 60_000, now: t0 })
  const st = readStarting({ workspace: ws, serverId: 's1' })
  eq(st.pid, 4242, '台账里记了 pid（现场核对用）')
  const ev = evaluateStarting({ state: st, portOpen: false, now: t0 + 20_000 })
  eq(ev.starting, true, '★★ 窗口内 + 端口没开 ⇒ 正在启动')
  eq(ev.expired, false, '★ 还没过期')
  eq(ev.waitedMs, 20_000, '已等 20 秒')
  eq(ev.leftMs, 40_000, '还剩 40 秒')

  // ★ 台账必须落盘（桥接重启后还得记得自己在启动）
  ok(existsSync(startingPath(ws, 's1')), '★★★ 台账**落盘**（桥接重启/崩溃后仍认得）')
  const raw = JSON.parse(readFileSync(startingPath(ws, 's1'), 'utf8'))
  eq(raw.startedAt, t0, '落盘的 startedAt 正确')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ③ ★★★ 端口开了 ⇒ **立刻不算**启动中（"等 RCON 登录"是另一回事）===')
{
  const t0 = 1_700_000_000_000
  const st = { startedAt: t0, until: t0 + 60_000, pid: 1 }
  const ev = evaluateStarting({ state: st, portOpen: true, now: t0 + 10_000 })
  eq(ev.starting, false, '★★★ 端口开了 ⇒ 不再算启动中（否则界面会一直挂 🟡）')
  eq(ev.expired, false, '★ 也不算过期')
}

console.log('\n=== ④ 窗口过了 ⇒ **过期**（不再算启动中）===')
{
  const t0 = 1_700_000_000_000
  const st = { startedAt: t0, until: t0 + 60_000, pid: 1 }
  const ev = evaluateStarting({ state: st, portOpen: false, now: t0 + 61_000 })
  eq(ev.starting, false, '★★★ 过期 ⇒ **不再算启动中**（之后按正常判据判 down）')
  eq(ev.expired, true, '★★ 并且**明确标出 expired**（调用方要如实说"启动超时"）')
  eq(ev.leftMs, 0, '剩余 0')
  eq(evaluateStarting({ state: st, portOpen: false, now: t0 + 60_000 }).expired, true, '★ 边界：正好到点就算过期')
}

console.log('\n=== ⑤ 清掉之后 ⇒ 又不算启动中（就绪 / 失败 / 放弃时要清）===')
{
  const ws = mkWs()
  markStarting({ workspace: ws, serverId: 's1', pid: 1 })
  ok(readStarting({ workspace: ws, serverId: 's1' }) !== null, '（准备）写上了')
  clearStarting({ workspace: ws, serverId: 's1' })
  eq(readStarting({ workspace: ws, serverId: 's1' }), null, '★★ 清掉之后读回 null（**不能留下"永远在启动"的假状态**）')
  eq(clearStarting({ workspace: ws, serverId: 's1' }).ok, true, '★ 清两次也不报错（幂等）')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑥ 坏台账 / 缺参数 ⇒ **不猜**，且永不抛 ===')
{
  const ws = mkWs()
  writeFileSync(startingPath(ws, 's1'), '{坏 json', 'utf8')
  eq(readStarting({ workspace: ws, serverId: 's1' }), null, '★★ 坏台账 ⇒ null（当没有，而不是抛）')
  writeFileSync(startingPath(ws, 's2'), JSON.stringify({ serverId: 's2', startedAt: 'x', until: 'y' }), 'utf8')
  eq(readStarting({ workspace: ws, serverId: 's2' }), null, '★★ 字段不是数字 ⇒ null（不猜一个时间）')
  eq(readStarting({ workspace: '', serverId: 's1' }), null, '★ 没工作区 ⇒ null')
  eq(readStarting({ workspace: ws, serverId: '' }), null, '★ 没 serverId ⇒ null')
  eq(markStarting({ workspace: '', serverId: 's1' }).ok, false, '★ 没工作区 ⇒ mark 失败但不抛')
  eq(markStarting({ workspace: ws, serverId: '' }).ok, false, '★ 没 serverId ⇒ mark 失败但不抛')
  // ★ 路径里的非法字符要替换掉（防穿越）
  ok(!startingPath(ws, 'a/b\\c').includes('a/b'), '★ serverId 里的路径字符被替换（防穿越）', startingPath(ws, 'a/b\\c'))
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑦ `describeStarting` 的措辞：必须说清"这不是故障" ===')
{
  const text = describeStarting({ waitedMs: 30_000, leftMs: 150_000 })
  ok(/正在启动/.test(text), '★ 说"正在启动"', text)
  ok(/已等 30 秒/.test(text), '★ 说清已等多久')
  ok(/再等 150 秒/.test(text), '★ 说清最多再等多久')
  ok(/不是故障/.test(text), '★★★ 明说"**不是故障**" —— 否则使用者会以为它挂了')
}

console.log('\n=== ⑧ 默认窗口要有意义（模组服首次启动 1~2 分钟）===')
{
  ok(Number(DEFAULT_STARTUP_WINDOW_MS) >= 120_000, '★ 默认窗口 ≥ 120 秒（模组服首次启动实测 1~2 分钟）', `${DEFAULT_STARTUP_WINDOW_MS}ms`)
  const ws = mkWs()
  markStarting({ workspace: ws, serverId: 's1' })
  const st = readStarting({ workspace: ws, serverId: 's1' })
  ok(st.until - st.startedAt >= 120_000, '★ 不传 windowMs 时用的是默认（够长）')
  rmSync(ws, { recursive: true, force: true })
}

console.log('')
if (fail === 0) {
  console.log(`🎉 启动窗口测试：${pass} 项通过`)
  process.exitCode = 0
} else {
  console.log(`❌ 启动窗口测试：${pass} 项通过、${fail} 项失败`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
