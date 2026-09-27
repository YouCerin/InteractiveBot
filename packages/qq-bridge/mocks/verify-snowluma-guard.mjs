#!/usr/bin/env node
/**
 * 缺陷 4 的回归测试：SnowLuma 重复启动的第三道防线 + PID 登记。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * SnowLuma 以 `detached: true` 启动（有意：关掉桥接不该连带杀掉它），
 * 所以它一旦被重复启动，**两个实例会抢 3000/3001 与 QQ 登录态，且都不会自己退出**。
 * 已有的两道防线都只覆盖"对面接受我们的 token"这一种情况：
 * 如果端口上蹲着的是别的东西（另一个实例、任意 HTTP 服务），它答 401/403，
 * 于是"端口有东西"这个事实被当成了"没人在跑" —— 再去 spawn 就撞车了。
 *
 * 这套测试盯两件事：
 *   ① **端口被占时绝不启动**（而不是"启动了再发现问题"）；
 *   ② 启动成功后**必须把 PID 登记下来**（以前只写进日志就丢了，
 *      于是"我起了哪个 SnowLuma""要不要停掉它"都答不出来）。
 *
 * 全程用临时目录 + 注入，不碰真实 SnowLuma、不开真端口（除端口探测那一节）。
 *
 * 用法：node mocks/verify-snowluma-guard.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSnowluma } from '../src/snowluma.mjs'
import { checkPortFree, probeHttpAnswered } from '../src/ports.mjs'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-slguard-'))
const REG = join(ROOT, 'cache/processes.json')
const readReg = () => {
  try {
    return JSON.parse(readFileSync(REG, 'utf8')).entries
  } catch {
    return []
  }
}

/** 一份最小可用配置：HTTP 3000 / WS 3001。 */
const cfg = {
  onebot: { httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001' },
  snowluma: { consoleUrl: 'http://127.0.0.1:5099/', probeTimeoutMs: 200 },
}

const noopLog = () => {}

async function main() {
  section('① 端口探测本身：空闲要说空闲，占用要说占用')
  {
    const free = await checkPortFree(34999, { timeoutMs: 300 })
    check('空闲端口 → inUse:false', free.inUse === false, JSON.stringify(free))

    // 起一个真实监听再测
    const { createServer } = await import('node:http')
    const srv = createServer((_q, r) => r.end('ok'))
    await new Promise((r) => srv.listen(34999, '0.0.0.0', r))
    try {
      const busy = await checkPortFree(34999, { timeoutMs: 300 })
      check('★ 被占用 → inUse:true（这就是"端口有东西"的判据）', busy.inUse === true, JSON.stringify(busy))
      const ans = await probeHttpAnswered('http://127.0.0.1:34999/whatever', 500)
      check('裸探测：200 也算"有 HTTP 服务应答"', ans.answered === true && ans.status === 200,
        JSON.stringify(ans))
    } finally {
      await new Promise((r) => srv.close(r))
    }
    const gone = await probeHttpAnswered('http://127.0.0.1:34999/whatever', 300)
    check('关掉之后探测不到（说明它真的在探测而不是恒真）', gone.answered === false, JSON.stringify(gone))
  }

  section('② ★ 端口被占时：绝不启动，改为报告 + 给处置建议')
  {
    const logs = []
    const r = await startSnowluma({
      config: cfg,
      log: (m) => logs.push(m),
      // 注入：控制台不通、桥接没连上（走不到"已在运行"的短路）
      probe: async () => ({ reachable: false }),
      detect: async () => ({ status: 'offline' }),
      // 注入：两个端口都"被占用"
      checkPort: async () => ({ inUse: true, method: 'connect', detail: '注入的占用' }),
      probeAnswered: async () => ({ answered: true, status: 401 }),
      // 注入：找不到入口 —— 若真走到 spawn 会返回 ok:false，用它反证"没走到"
      locateSnowluma: () => ({ cmd: null, cwd: null, kind: null, from: null }),
      findNode: () => process.execPath,
      register: () => ({ ok: true }),
      pkgRoot: ROOT,
    })
    check('★ 返回 ok:true 但 started:false（不是启动失败，是**刻意不启动**）',
      r.ok === true && r.data?.started === false, JSON.stringify(r.data ?? r))
    check('★ 报告里带上"哪些端口被占"', Array.isArray(r.data?.portBusy) && r.data.portBusy.length === 2,
      JSON.stringify(r.data?.portBusy))
    check('提示里说清后果（抢端口与登录态）', /抢端口|登录态/.test(r.data?.hint ?? ''), r.data?.hint)
    const joined = logs.join('\n')
    check('★ 日志明确写出"不再启动新的 SnowLuma"', /不再启动新的 SnowLuma/.test(joined), joined.slice(0, 120))
    check('★ 日志给出可处置的办法（--processes / --kill）', /--processes/.test(joined) && /--kill/.test(joined))
    check('★ **没有走到 spawn**（端口忙就不该有任何启动动作）', !/已发起启动/.test(joined))
  }

  section('③ 端口空闲时：正常启动，并把 PID 登记下来')
  {
    const logs = []
    const registered = []
    const r = await startSnowluma({
      config: cfg,
      log: (m) => logs.push(m),
      probe: async () => ({ reachable: false }),
      detect: async () => ({ status: 'offline' }),
      checkPort: async () => ({ inUse: false, method: 'bind', detail: '空闲' }),
      probeAnswered: async () => ({ answered: false, status: null }),
      // 用一个真实存在、能立刻退出的入口：node -e 的 .mjs 路径不好造，
      // 这里直接给一个真实文件（包内的 ports.mjs 就是 .mjs），
      // SnowLuma 起来后会不会正常工作不在本节关心范围 —— 我们只验"发起了 + 登记了"。
      locateSnowluma: () => ({
        cmd: join(process.cwd(), 'src', 'ports.mjs'),
        cwd: join(process.cwd(), 'src'),
        kind: 'mjs',
        from: '测试注入',
      }),
      findNode: () => process.execPath,
      register: (opts) => {
        registered.push(opts)
        return { ok: true }
      },
      pkgRoot: ROOT,
    })
    check('端口空闲 → 正常发起启动', r.ok === true && r.data?.started === true, JSON.stringify(r.data ?? r))
    check('★ 登记被调用，且带上了 PID 与 profile=snowluma',
      registered.length === 1 && Number.isInteger(registered[0].pid) && registered[0].profile === 'snowluma',
      JSON.stringify(registered[0]))
    check('★ 返回值里标明"PID 已登记"', r.data?.pidRegistered === true)
    check('提示里带上 PID（以便事后 --kill）', new RegExp(`pid ${r.data?.pid}`).test(r.data?.hint ?? ''), r.data?.hint)
  }

  section('④ 登记失败不能影响启动本身（SnowLuma 已经跑起来了，那是既成事实）')
  {
    const logs = []
    const r = await startSnowluma({
      config: cfg,
      log: (m) => logs.push(m),
      probe: async () => ({ reachable: false }),
      detect: async () => ({ status: 'offline' }),
      checkPort: async () => ({ inUse: false, method: 'bind', detail: '空闲' }),
      probeAnswered: async () => ({ answered: false, status: null }),
      locateSnowluma: () => ({
        cmd: join(process.cwd(), 'src', 'ports.mjs'),
        cwd: join(process.cwd(), 'src'),
        kind: 'mjs',
        from: '测试注入',
      }),
      findNode: () => process.execPath,
      register: () => {
        throw new Error('注入的登记失败')
      },
      pkgRoot: ROOT,
    })
    check('★ 登记抛异常时，启动仍然报成功', r.ok === true && r.data?.started === true, JSON.stringify(r.data ?? r))
    check('返回值里如实标明没登记上', r.data?.pidRegistered === false)
    check('日志里有明确的告警（不许静默）', logs.some((m) => /未能登记/.test(m)), logs.join(' | ').slice(0, 140))
  }

  section('⑤ registerExternal 的真实行为（不进 cache/ 的临时目录）')
  {
    const { registerExternal } = await import('../src/process-guard.mjs')
    const r = registerExternal({ pkgRoot: ROOT, pid: 4242, port: 3000, profile: 'snowluma' })
    check('登记成功', r.ok === true)
    const entries = readReg()
    check('★ 登记里能查到它', entries.some((e) => e.pid === 4242 && e.profile === 'snowluma'),
      JSON.stringify(entries))
    check('登记文件确实写到了临时目录（没碰真实 cache/）', existsSync(REG))
    const bad = registerExternal({ pkgRoot: ROOT, pid: 'not-a-pid' })
    check('非法 PID 被拒（不写垃圾进登记）', bad.ok === false, JSON.stringify(bad))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑥ ★★ 等 SnowLuma 就绪再开网页端（修"页面开太早、要手动刷新"）')
  // ══════════════════════════════════════════════════════════════════════════
  //
  // 真实缺陷：start.bat 的 `--snowluma` 是 spawn 完立刻返回的，紧接着打开浏览器
  // 看到的是 SnowLuma 启动中途的页面（未登录/空列表），使用者必须手动刷新一次。
  // 这里把时间**注入**掉（`sleep`），所以断言的是判定逻辑本身，不依赖真实等待。
  {
    const { waitForSnowlumaReady, SNOWLUMA_STATUS } = await import('../src/snowluma.mjs')

    /** 造一个"第 N 次探测才返回某状态"的探测器，并记录被调用次数。 */
    const detector = (states) => {
      let i = 0
      const fn = async () => {
        const s = states[Math.min(i, states.length - 1)]
        i += 1
        return typeof s === 'string' ? { status: s } : s
      }
      fn.calls = () => i
      return fn
    }
    // 注入的 sleep：把"等待"变成"推进"（并记录被 sleep 了几次）
    const fakeSleep = () => {
      const rec = { n: 0 }
      return { sleep: async () => { rec.n += 1 }, rec }
    }

    // ① 已经在跑且已登录 → 一次探测就返回，**零等待**
    {
      const d = detector([SNOWLUMA_STATUS.CONNECTED])
      const s = fakeSleep()
      const r = await waitForSnowlumaReady({ config: cfg, detect: d, log: noopLog, sleep: s.sleep })
      check('★ 已就绪 → 立刻返回（不白等）', r.ok === true && r.polls === 1 && s.rec.n === 0, JSON.stringify({ ok: r.ok, polls: r.polls, sleeps: s.rec.n }))
      check('★ 如实说明"已经在跑且已登录"', /已经在跑/.test(r.hint), r.hint)
    }

    // ② 起来了但没登录 → 继续等，直到 connected
    {
      const d = detector([SNOWLUMA_STATUS.UP_NOT_LOGGED_IN, SNOWLUMA_STATUS.UP_NOT_LOGGED_IN, SNOWLUMA_STATUS.CONNECTED])
      const s = fakeSleep()
      const logs = []
      const r = await waitForSnowlumaReady({ config: cfg, detect: d, log: (m) => logs.push(m), sleep: s.sleep })
      check('★ 未登录时继续等，直到 connected', r.ok === true && r.status === SNOWLUMA_STATUS.CONNECTED, JSON.stringify({ status: r.status, polls: r.polls }))
      check('★ 等了 2 次（不是一次就开）', r.polls === 3 && s.rec.n === 2, JSON.stringify({ polls: r.polls, sleeps: s.rec.n }))
      check('★ 期间有进度提示（否则看起来像卡死）', logs.some((m) => /⏳/.test(m) && /等 QQ 登录/.test(m)), logs.join(' | ').slice(0, 140))
      check('就绪后的说明带上了大致等待秒数', /已就绪/.test(r.hint), r.hint)
    }

    // ③ "在跑但没钩住 QQ" → 等满超时，并**说清是哪一种没就绪**（排查方向完全不同）
    {
      const notHooked = { status: SNOWLUMA_STATUS.OFFLINE, consoleReachable: true }
      const d = detector([notHooked])
      const s = fakeSleep()
      const logs = []
      const r = await waitForSnowlumaReady({ config: cfg, detect: d, log: (m) => logs.push(m), sleep: s.sleep, timeoutMs: 3000, pollMs: 1000 })
      check('★ 超时后 ok=false（如实回报，不假装就绪）', r.ok === false && r.status === SNOWLUMA_STATUS.OFFLINE)
      check('★★ 结论指明"还没钩住 QQ"（而不是含糊的"超时"）', /钩住 QQ/.test(r.hint), r.hint)
      check('★ 并且提示了怎么办（先启动 QQ / 重启一次 QQ）', /启动 QQ|重启一次 QQ/.test(r.hint), r.hint)
      check('超时告警进了日志（不许静默）', logs.some((m) => /还没就绪/.test(m)), logs.join(' | ').slice(0, 140))
    }

    // ④ token 被拒 → **早退**（再等一百年也不会变），把页面打开让使用者去改
    {
      const d = detector([SNOWLUMA_STATUS.AUTH_FAILED, SNOWLUMA_STATUS.CONNECTED])
      const s = fakeSleep()
      const logs = []
      const r = await waitForSnowlumaReady({ config: cfg, detect: d, log: (m) => logs.push(m), sleep: s.sleep, timeoutMs: 60_000 })
      check('★ token 被拒 → 不在那儿干等（只探一次）', r.ok === false && r.polls === 1 && s.rec.n === 0, JSON.stringify({ polls: r.polls, sleeps: s.rec.n }))
      check('★ 并且说明白了该去控制台核对 token', /token/.test(r.hint) || logs.some((m) => /token/.test(m)))
    }

    // ⑤ 探测器自己抛错 → 不能把启动流程带崩，按"没就绪"继续
    {
      let n = 0
      const d = async () => {
        n += 1
        if (n === 1) throw new Error('探测炸了')
        return { status: SNOWLUMA_STATUS.CONNECTED }
      }
      const s = fakeSleep()
      const r = await waitForSnowlumaReady({ config: cfg, detect: d, log: noopLog, sleep: s.sleep })
      check('★ 探测抛错不致命（继续等，最终成功）', r.ok === true && r.polls === 2, JSON.stringify({ ok: r.ok, polls: r.polls }))
    }
  }

  console.log('')
  if (failures === 0) console.log('🎉 SnowLuma 第三防线 + PID 登记 + 就绪等待测试全部通过')
  else console.log(`⚠️ ${failures} 项失败`)
  rmSync(ROOT, { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验证脚本自身崩了：', error)
  rmSync(ROOT, { recursive: true, force: true })
  process.exit(1)
})
