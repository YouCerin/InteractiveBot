#!/usr/bin/env node
/**
 * 进程登记（缺陷 3）的回归测试。
 *
 * ── 这套测试在盯什么 ────────────────────────────────────────────────────
 * 缺陷 3 的定义是：**没有任何 PID 记录**，于是"上一个进程卡住关不掉"这类事故
 * 只能靠人手动杀进程收场。修好之后，登记表必须能回答三个问题：
 *   ① 现在有几个桥接在跑？
 *   ② 哪条登记已经失效（该清理）？
 *   ③ 要停掉一个，会不会误杀"PID 被复用"后的无关进程？
 *
 * 第 ③ 条最要紧：**误杀比多跑一个严重得多**。所以判定与动手都必须
 * "PID + instanceId 双重匹配"，不确定时一律拒绝。
 *
 * 全部在临时目录里跑，不碰真实 cache/。
 *
 * 用法：node mocks/verify-process-guard.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessGuard, readInstanceArg, REGISTRY_REL, summarizeProcesses, runningBridges } from '../src/process-guard.mjs'

let failures = 0
// ★ 断言总数：原先只打印「全部通过」、不打印项数 ⇒ PROJECT.json 里那些「N 项断言」
//   的数字**没法用机器核对**，只能人手求和 —— 而它已经漂了（见 README 里的旧数字）。
let total = 0
function check(name, ok, detail = '') {
  total += 1
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-guard-'))
const file = join(ROOT, REGISTRY_REL)
const writeReg = (entries) => {
  mkdirSync(join(ROOT, 'cache'), { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 1, entries }, null, 2), 'utf8')
}
const readReg = () => JSON.parse(readFileSync(file, 'utf8')).entries

/**
 * 起一个"活着但不干活"的进程，用来提供真实存在的 PID。
 *
 * ★ 用纯 `setInterval` 保活，**不** `stdin.resume()`：后者在管道对端被关闭时
 *   会让进程退出（实测：间歇性地"刚起来就没了"，然后 guard 把 PID 判死 ——
 *   那是正确行为，却会让断言报出一堆看起来毫不相关的失败）。
 *   夹具自己的存活必须尽量稳，否则测的就不是 guard 了。
 */
function spawnIdle(instanceId = '') {
  const arg = instanceId ? `--instance-id=${instanceId}` : '--noop'
  return new Promise((resolve) => {
    // spawn 在某些受限环境里会**同步抛**（不只是异步 emit error），两个都要接住
    let child
    try {
      child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', arg], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      return resolve({ child: null, blocked: `${error?.code ?? ''} ${error?.message ?? error}`.trim() })
    }
    let settled = false
    const done = (ok, why = null) => {
      if (settled) return
      settled = true
      resolve({ child: ok ? child : null, blocked: why })
    }
    child.once('error', (e) => done(false, `${e?.code ?? ''} ${e?.message ?? e}`.trim()))
    child.once('exit', (code, sig) => done(false, `夹具子进程立刻退出了（code=${code} signal=${sig}）`))
    child.once('spawn', () => setTimeout(() => done(Boolean(child.pid)), 150))
    setTimeout(() => done(Boolean(child.pid)), 2000)
  })
}

/** PID 现在还在不在（夹具自检用）。 */
function isAlive(pid) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function main() {
  section('① 没有登记文件时：不崩、自登记、登记表可读')
  {
    check('前置：cache/processes.json 尚不存在', !existsSync(file))
    const g = createProcessGuard({ pkgRoot: ROOT, port: 3410 })
    const r = g.claim()
    check('claim 不抛异常', Boolean(r?.self))
    check('★ 自己已被登记', readReg().some((e) => e.pid === process.pid), JSON.stringify(readReg()))
    check('登记里带 instanceId（防 PID 复用的判据）', typeof r.self.instanceId === 'string' && r.self.instanceId.length > 0,
      r.self.instanceId)
    check('登记里带端口与启动时间', r.self.port === 3410 && Number.isFinite(r.self.startedAtMs))
    g.release()
    check('release 后自己的条目被摘掉', !readReg().some((e) => e.pid === process.pid))
  }

  section('② 死条目必须被清理（这是"卡住的进程"留下的残渣）')
  {
    writeReg([
      { pid: 999999, profile: 'bridge', instanceId: 'deadbeef', updatedAtMs: Date.now(), port: 1 },
      { pid: process.pid, profile: 'bridge', instanceId: 'self', updatedAtMs: Date.now(), port: 2 },
    ])
    const g = createProcessGuard({ pkgRoot: ROOT, port: 3410 })
    const r = g.claim()
    check('★ PID 不存在的条目被判死并清理', r.cleaned.some((c) => c.pid === 999999), JSON.stringify(r.cleaned))
    check('清理后登记表里不再有它', !readReg().some((e) => e.pid === 999999))
    check('自己的旧条目不会导致自冲突', r.conflicts.length === 0, JSON.stringify(r.conflicts))
    g.release()
  }

  // ── ③-b 已确认死掉的同 profile 条目**不算冲突** ────────────────────────
  //
  // ★ 复现的是实测遇到的一个假警告：杀完旧实例后，`--processes` 的列表显示
  //   `23404 dead` + `28312 alive` 两条，**下面却照样报"有 1 个其它桥接在跑"**，
  //   并指引去 kill 一个已经不存在的 pid。
  //   根因：`claim()` 只按 `profile` 相等就推 conflicts（含 state='dead'），
  //   而 `list()` 的冲突过滤是 `alive || stale` —— 两处口径不一致。
  //
  // ⚠️ 这一段**刻意排在 spawn 闸门之前**：它不需要新进程，
  //    用 `process.pid`（确定活着、心跳新鲜）当"另一个桥接"就够了。
  //    放在闸门之后的话，受限环境会整段被跳过 —— 而那正是最需要它的环境。
  section('③-b 已死的同 profile 条目不算冲突（这曾是假警告的来源）')
  {
    // 「活着的那条」必须满足两个条件，缺一条这段就白测：
    //   ① **不是当前进程**（否则会被 `claim()` 当自己的旧条目跳过 —— 这里踩过）
    //   ② 心跳新鲜 → 分类走 `alive` 那一支，**不必读命令行**
    //      （受限环境读不到命令行，会掉进 suspect；而这一段要在受限环境也能跑）
    // ⚠️ 不要用 `process.kill(pid, 0)` 来"确认它存在" —— 沙箱会以 EPERM 抛出，
    //    于是断言变成"它不存在"而失败（这里踩过）。判据用下面的 `state === 'alive'` 即可，
    //    那正是被测代码自己的口径，也更贴题。
    const LIVE_PID = 4 // Windows 上 pid 4 = System，跨版本都在
    check('前提：选用的"活着"的 PID 不是当前进程', LIVE_PID !== process.pid)
    writeReg([
      // 一个确认不存在的 pid，且 profile 与本进程相同
      { pid: 999998, profile: 'bridge', instanceId: 'gone', updatedAtMs: Date.now(), port: 3410 },
      // 一个真的活着、心跳新鲜的"另一个桥接"
      { pid: LIVE_PID, profile: 'bridge', instanceId: 'aaaa1111', updatedAtMs: Date.now(), port: 3411 },
    ])
    const g = createProcessGuard({ pkgRoot: ROOT, port: 3410 })
    const r = g.claim()
    check('前提：选用的 PID 被分类为 alive（否则下面那条断言不成立）',
      r.conflicts.some((c) => c.pid === LIVE_PID && c.state === 'alive'),
      JSON.stringify(r.conflicts))
    check('★★ 死条目不进 conflicts（否则会指引人去杀一个不存在的 pid）',
      !r.conflicts.some((c) => c.pid === 999998), JSON.stringify(r.conflicts))
    check('死条目仍然被清掉（清理与冲突是两件事）',
      r.cleaned.some((c) => c.pid === 999998))
    check('★ 活着的那个仍然被报成冲突（别为了修假警告把真警告也修没了）',
      r.conflicts.some((c) => c.pid === LIVE_PID), JSON.stringify(r.conflicts))
    check('conflicts 里的每一条都不是 dead 状态',
      r.conflicts.every((c) => c.state !== 'dead'), JSON.stringify(r.conflicts.map((c) => c.state)))
    g.release()
  }

  section('③-c runningBridges：CLI 冲突判定必须按**数量**，不能按 isSelf')
  {
    // ★ 复现实测遇到的第二个假警告：进程表清干净后只剩**唯一一个**桥接，
    //   `--processes` 却仍报「有 1 个其它桥接在跑」并指引去 kill 它。
    //   根因：CLI 是另一个进程，`isSelf` 对它恒为 false，所以
    //   `!isSelf && alive` 会把唯一那个也当成"其它"。
    //   正确口径：**1 条 = 正常，≥2 条 = 真冲突**。
    // 入参形状对齐 `list()` 的返回：{ pid, profile, state, isSelf }
    const mk = (pid, state, isSelf = false) => ({ pid, profile: 'bridge', state, isSelf })

    check('★ 只有一条在跑 → 不算冲突（这是那个假警告的复现点）',
      runningBridges([mk(35092, 'alive', false)]).length === 1)
    check('两条在跑 → 两条都算（真的会抢事件流）',
      runningBridges([mk(1, 'alive'), mk(2, 'alive')]).length === 2)
    check('alive + stale 都算在跑（卡住的那个也在抢）',
      runningBridges([mk(1, 'alive'), mk(2, 'stale')]).length === 2)
    check('dead 不算在跑（PID 都没了）',
      runningBridges([mk(1, 'dead'), mk(2, 'alive')]).length === 1)
    check('suspect 不算在跑（读不到命令行，无法确认；保守不报，避免又指错人）',
      runningBridges([mk(1, 'suspect')]).length === 0)
    check('别的 profile（如 snowluma 协议端）不算桥接冲突',
      runningBridges([{ pid: 9, profile: 'snowluma', state: 'alive' }]).length === 0)
    check('空表 / 非数组入参都不抛',
      runningBridges([]).length === 0 && runningBridges(null).length === 0)
  }

  section('③ 活的"另一个桥接"必须被报成冲突（但不许自动杀）')
  {
    const spawned = await spawnIdle('aaaa1111')
    if (!spawned.child) {
      console.log(`  ⚠️ 本环境起不了子进程（${spawned.blocked}）—— 行为断言跳过，这不算通过`)
      console.log('     请在正常 Windows 会话里重跑')
      rmSync(ROOT, { recursive: true, force: true })
      process.exit(0)
    }
    const other = spawned.child
    writeReg([
      {
        pid: other.pid,
        profile: 'bridge',
        instanceId: 'aaaa1111',
        updatedAtMs: Date.now(), // 心跳新鲜
        port: 3411,
      },
    ])
    const g = createProcessGuard({ pkgRoot: ROOT, port: 3410 })
    const r = g.claim()
    check('★ 另一个桥接被判为冲突并**报告**', r.conflicts.some((c) => c.pid === other.pid), JSON.stringify(r.conflicts))
    check('冲突条目的状态是 alive', r.conflicts[0]?.state === 'alive', r.conflicts[0]?.state)
    check('★ 没有把它从登记里删掉（不臆断别人死了）', readReg().some((e) => e.pid === other.pid))


    section('④ killEntry：PID + instanceId 双重匹配，防误杀')
    {
      // ★ 这一节把"读不到命令行"与"读到了但对不上"**分开测**。
      //   两者是不同的事：前者是本环境的限制（拒绝但给手动办法），
      //   后者才说明 PID 被复用（必须拒绝）。第一版混在一起测，
      //   结果沙箱里读不到命令行时，两条断言都失败，看不出到底哪条逻辑不对。
      const withCmd = (cmdFor) =>
        createProcessGuard({
          pkgRoot: ROOT,
          port: 3410,
          readCmd: (pid) => cmdFor(pid),
        })

      // 4a. 能读到命令行，但里面没有那条 instanceId → 判定 PID 被复用 → 拒绝
      const mismatch = withCmd(() => 'C:\\other\\program.exe --unrelated')
        .killEntry(other.pid)
      check('★ 命令行里没有登记的 instanceId → 判为 PID 复用并**拒绝杀**',
        mismatch.ok === false && mismatch.pidReused === true, JSON.stringify(mismatch))

      // 4b. 读不到命令行（受限环境）→ 拒绝，但明确告诉你怎么手动处理
      const unreadable = withCmd(() => null).killEntry(other.pid)
      check('★ 读不到命令行 → 拒绝并给出**可执行**的手动办法（不是含糊的失败）',
        unreadable.ok === false && unreadable.environmentLimited === true && /taskkill/.test(unreadable.error),
        unreadable.error)

      // 4c. instanceId 对得上 → 允许（用一个真实子进程验证"确实杀得掉"）
      const victim = await spawnIdle('bbbb2222')
      const v = victim.child
      writeReg([
        ...readReg().filter((e) => e.pid !== v.pid),
        { pid: v.pid, profile: 'bridge', instanceId: 'bbbb2222', updatedAtMs: Date.now(), port: 9 },
      ])
      const okKill = withCmd((pid) => `node something --instance-id=bbbb2222 (pid ${pid})`).killEntry(v.pid)
      check('★ instanceId 对得上 → 允许停掉', okKill.ok === true, JSON.stringify(okKill))
      await sleep(300)
      check('且进程真的没了', v.exitCode !== null || v.signalCode !== null,
        `exitCode=${v.exitCode} signalCode=${v.signalCode}`)

      // 4d. 不能杀自己
      const self = g.killEntry(process.pid)
      check('拒绝杀当前进程自己（要停请用 /api/stop 或 Ctrl+C）', self.ok === false, self.error)

      // 4e. 已经不在运行的条目
      writeReg([{ pid: 999998, profile: 'bridge', instanceId: 'x', updatedAtMs: Date.now() }])
      const gone = g.killEntry(999998)
      check('对已不在运行的 PID 返回明确的失败', gone.ok === false && /已经不在运行/.test(gone.error), gone.error)
    }

    section('⑤ 心跳过期：进程还在但很久没刷新 → 报 stale（可能卡住）')
    {
      const stuck = await spawnIdle('cccc3333')
      if (stuck.child) {
        writeReg([
          {
            pid: stuck.child.pid,
            profile: 'bridge',
            instanceId: 'cccc3333',
            updatedAtMs: Date.now() - 10 * 60_000, // 十分钟没心跳
            port: 3412,
          },
        ])
        // ★ 先把前提断言出来：这个夹具进程**现在确实还活着**。
        //   否则它一旦退出，guard 判它 dead 是**正确行为**，而断言会失败 ——
        //   报出来的信息看起来像 guard 的 bug，实际上与 guard 无关。
        //   （这条教训在 verify-lifecycle 里也踩过一次：前提不成立时的失败最难读。）
        check('前提：夹具子进程此刻仍然活着（否则本节的结论无意义）', isAlive(stuck.child.pid),
          `pid=${stuck.child.pid} exitCode=${stuck.child.exitCode}`)
        // staleMs 注入成 1 秒，避免真等两分钟；readCmd 注入成"命令行里有那个 instanceId"
        const g2 = createProcessGuard({
          pkgRoot: ROOT,
          port: 3410,
          staleMs: 1000,
          readCmd: () => 'node x.mjs --instance-id=cccc3333',
        })
        g2.claim()
        const entry = g2.list().find((e) => e.pid === stuck.child.pid)
        check('★ 心跳过期但命令行对得上 → stale（不判死、不清理）', entry?.state === 'stale',
          `${entry?.state} / ${entry?.reason}`)
        check('stale 的条目仍然留在登记里', readReg().some((e) => e.pid === stuck.child.pid))

        // 顺带验证：读不到命令行时**不能**判死（否则会清掉活着的登记）
        //
        // ★ 必须用一个**新起的、还活着**的子进程。第一版复用了上面那个，
        //   而它在上一段结尾已经被 kill 了 —— 于是"被判 dead 并清理"其实是
        //   **正确行为**，测试却在期待 suspect。这类"前提已经不成立"的断言
        //   会报出看起来毫不相关的失败（这一课在 verify-lifecycle 里也踩过）。
        const stillAlive = await spawnIdle('dddd4444')
        writeReg([
          {
            pid: stillAlive.child.pid,
            profile: 'bridge',
            instanceId: 'dddd4444',
            updatedAtMs: Date.now() - 10 * 60_000,
          },
        ])
        const g3 = createProcessGuard({ pkgRoot: ROOT, staleMs: 1000, readCmd: () => null })
        const r3 = g3.claim()
        check('★ 读不到命令行时判 suspect、**不清理**（判死会清掉活着的登记 → 多跑一个机器人）',
          r3.cleaned.length === 0 && g3.list().some((e) => e.state === 'suspect'),
          JSON.stringify({ cleaned: r3.cleaned.length, states: g3.list().map((e) => e.state) }))
        stillAlive.child.kill()
        stuck.child.kill()
      }
    }

    other.kill()
  }

  section('⑥ 参数与摘要')
  {
    check('能读出 --instance-id=', readInstanceArg(['node', 'x.mjs', '--instance-id=deadbeef']) === 'deadbeef')
    check('没有该参数时返回 null', readInstanceArg(['node', 'x.mjs']) === null)
    check('摘要把"还在运行"的数量说清楚',
      summarizeProcesses([{ state: 'alive' }, { state: 'dead' }, { state: 'stale' }]) === '2 个在运行（登记 3 条）',
      summarizeProcesses([{ state: 'alive' }, { state: 'dead' }, { state: 'stale' }]))
  }

  console.log('')
  if (failures === 0) console.log(`🎉 进程登记测试全部通过（${total} 项）`)
  else console.log(`⚠️ ${failures} 项失败（共 ${total} 项）`)
  rmSync(ROOT, { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验证脚本自身崩了：', error)
  rmSync(ROOT, { recursive: true, force: true })
  process.exit(1)
})
