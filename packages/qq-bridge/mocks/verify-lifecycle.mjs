#!/usr/bin/env node
/**
 * 进程生命周期回归测试：**"退不掉"必须被测出来**。
 *
 * ── 为什么单独有一套 ────────────────────────────────────────────────────
 * 起因是一次真实事故：上一个进程卡住关不掉，和新进程抢 PID / 端口。
 * 审查（见 docs/process-lifecycle.md）认定两个根因：
 *
 *   ① `shutdown()` 只 `await this.request('shutdown')` —— 子进程若永不回话，
 *      调用方被**无限拖住**，而调用方是退出流程 ⇒ 进程退不掉；
 *   ② `kill()` 发完 kill 就返回、**不确认子进程死没死**，紧接着
 *      `process.exit(0)` —— 子进程若杀不动就成了孤儿，继续持有工作区，
 *      下一次启动会出现"两个 agent 写同一份工作区"。
 *
 * 这套测试用"只会占着不退出、什么协议都不懂的哑子进程"复现这两种情形，
 * 断言修复后的可观察行为（不依赖 DSH、不花钱、不需要 QQ）。
 *
 * 用法：node mocks/verify-lifecycle.mjs
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SdkRpcClient } from '../src/sdk-rpc.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

/**
 * 造一个"活着但不合作"的子进程：读着 stdin，永不回应、也永不自己退出。
 *
 * ★ 注意 `spawn` 的失败（例如沙箱 `EPERM`）**不是抛异常**，而是异步 emit `error`；
 *   而且更阴的是：被拒绝时它还会 emit `spawn`，只是 `pid` 是 undefined。
 *   所以这里两个事件都听，并用"有没有 pid"来判定到底起没起来。
 *
 * @returns {Promise<{child: import('node:child_process').ChildProcess|null, blocked: string|null}>}
 */
function spawnDumbChild() {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      return resolve({ child: null, blocked: String(error?.message ?? error) })
    }
    let settled = false
    const done = (ok, why = null) => {
      if (settled) return
      settled = true
      resolve({ child: ok ? child : null, blocked: why })
    }
    child.once('error', (error) => done(false, `${error?.code ?? ''} ${error?.message ?? error}`.trim()))
    child.once('spawn', () => {
      // 被沙箱拒绝时也会走到这里，但 pid 为空 —— 用 pid 判定才算数
      if (child.pid) done(true)
      else done(false, 'spawn 事件到达但没有 pid（多半是被策略拒绝）')
    })
    setTimeout(() => done(Boolean(child.pid), child.pid ? null : '超时未确认子进程已启动'), 2000)
  })
}

/**
 * 造一个"启动后自己很快退出"的子进程（exitCode 0）。
 *
 * ★ 存在的理由：③ 要测的是"对**已经退出**的子进程调 kill/shutdown"。
 *   第一版图省事复用了 `spawnDumbChild()`（那个**永不退出**），于是"前提"
 *   从来没成立过，后面的断言全在错误的前提下跑 —— 表现是一条看起来莫名其妙的失败。
 *   这就是为什么要先把前提单独断言出来。
 */
async function spawnSelfExitingChild() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  })
  const exited = await waitExit(child, 3000)
  return { child, exited }
}

/**
 * 等一个子进程退出，返回它是否真的退出（而不是"我以为它退了"）。
 *
 * ★ 判据必须同时看 `exitCode` 与 `signalCode`：**被信号杀死的进程 exitCode 永远是
 *   null**，只有 signalCode 有值。只看 exitCode 会得到"它没退"的错判 ——
 *   第一版这里超时时还无条件返回 true，于是"以为它退了"却没退，
 *   后面的用例跟着一起误判（这正是那个假断言的来源）。
 */
function waitExit(child, ms) {
  const isDead = () => child.exitCode !== null || child.signalCode !== null
  return new Promise((resolve) => {
    if (isDead()) return resolve(true)
    let timer = null
    const done = (ok) => {
      if (timer) clearTimeout(timer)
      child.off('exit', onExit)
      resolve(ok)
    }
    const onExit = () => done(true)
    child.once('exit', onExit)
    timer = setTimeout(() => done(isDead()), ms)
  })
}

async function main() {
  // ── 先探一下本环境到底允不允许带管道的子进程 ──
  const probe = await spawnDumbChild()
  const spawnBlocked = probe.blocked
  if (probe.child) {
    // 探针用完就收拾掉，别给后面的用例留孤儿
    probe.child.kill()
  } else {
    console.log(`\n⚠️ 本环境不允许启动带管道的子进程：${spawnBlocked}`)
    console.log('   → 行为断言（①②③）**跳过**；静态防线（④）照常执行。')
    console.log('   → 这不算通过：请在正常 Windows 会话（或 `npm test` 的常规环境）里再跑一次。')
  }

  if (!spawnBlocked) {
    section('① shutdown 对"永不回话的子进程"必须有硬截止，并如实报告超时')
    {
      const client = new SdkRpcClient({ cliPath: 'unused', cwd: ROOT })
      const spawned = await spawnDumbChild()
      const child = spawned.child
      client.attachExistingChild(child)
      await sleep(150)

      const startedAt = Date.now()
      console.log(`  · shutdown 之前的状态：${JSON.stringify(client.lifecycleState())}`)
      // 哑进程不认 JSON-RPC，所以这条请求永远不会有应答。
      // 关键断言：**必须在超时后返回**，而不是把调用方无限拖住。
      const r = await client.shutdown({ timeoutMs: 600 })
      const ms = Date.now() - startedAt
      console.log(`  · shutdown 之后的状态：${JSON.stringify(client.lifecycleState())}`)

      check('★ shutdown 在超时后返回（没有把退出流程拖死）', ms < 5000, `耗时 ${ms}ms`)
      check('★ 如实报告"优雅失败"，不谎报成功', r.graceful === false && r.timedOut === true,
        JSON.stringify(r))

      const killed = await client.kill({ graceMs: 2000, confirmMs: 2000 })
      check('随后 kill() 能收拾掉它', killed.stopped === true, JSON.stringify(killed))
    }

    section('② kill 必须"确认退出"才算成功（不是发完就返回）')
    {
      const client = new SdkRpcClient({ cliPath: 'unused', cwd: ROOT })
      const spawned = await spawnDumbChild()
      const child = spawned.child
      client.attachExistingChild(child)
      await sleep(150)
      check('哑子进程已起来', child.exitCode === null, `pid=${child.pid}`)

      const r = await client.kill({ graceMs: 2000, confirmMs: 2000 })
      check('kill() 报告已停止', r.stopped === true, JSON.stringify(r))
      // ★ 判据：**两种终止方式都算**（正常退出 exitCode / 被信号杀死 signalCode）
      check('★ 报告与事实一致：进程真的没了', child.exitCode !== null || child.signalCode !== null,
        `exitCode=${child.exitCode} signalCode=${child.signalCode} pid=${r.pid}`)
      check('记录了用哪种方式停掉的（便于排查）', typeof r.method === 'string', String(r.method))
    }

    section('③ 没有子进程 / 已退出时：不假装做了事')
    {
      const client = new SdkRpcClient({ cliPath: 'unused', cwd: ROOT })
      const r1 = await client.kill()
      check('从未启动时 kill() 返回 alreadyGone（不是"我杀掉了它"）',
        r1.stopped === true && r1.alreadyGone === true, JSON.stringify(r1))

      const { child, exited: reallyExited } = await spawnSelfExitingChild()
      // ★ 前提必须先成立：这个子进程确实是自己退出的（用的是专门的辅助函数，
      //   不是那个"永不退出"的哑子进程）
      check('前提：这个子进程确实已经自己退出了', reallyExited === true && child.exitCode === 0,
        `exited=${reallyExited} exitCode=${child.exitCode}`)

      const client2 = new SdkRpcClient({ cliPath: 'unused', cwd: ROOT }).attachExistingChild(child)
      const r2 = await client2.kill()
      check('子进程早已退出时同样返回 alreadyGone',
        r2.stopped === true && r2.alreadyGone === true, JSON.stringify(r2))

      const s = await client2.shutdown({ timeoutMs: 300 })
      check('对已退出的子进程 shutdown 直接成功（不白等）',
        s.graceful === true && s.alreadyGone === true, JSON.stringify(s))
    }
  }

  section('④ 静态防线：这两条根治点不许被删掉（行为测试之外的钉子）')
  {
    // 行为测试覆盖"运行起来对不对"；这里再钉一遍源码，防止将来有人重构时
    // 把超时/确认逻辑删掉而测试恰好没覆盖到那条分支。
    const sdk = readFileSync(join(ROOT, 'src', 'sdk-rpc.mjs'), 'utf8')
    const idx = readFileSync(join(ROOT, 'src', 'index.mjs'), 'utf8')

    check('sdk-rpc：kill() 用 taskkill 整树强杀（/T 连子代理一起）',
      /taskkill/.test(sdk) && /'\/T'/.test(sdk))
    check('sdk-rpc：kill() 会等 exit 事件（waitExit）', /waitExit/.test(sdk))
    check('sdk-rpc：shutdown() 有硬截止（Promise.race）', /Promise\.race/.test(sdk))
    check('sdk-rpc：超时后清掉定时器（否则 timer 会把退出拖住）',
      /finally \{[\s\S]{0,200}clearTimeout\(timer\)/.test(sdk))
    check('index：收尾有总预算 SHUTDOWN_BUDGET_MS', /SHUTDOWN_BUDGET_MS/.test(idx))
    check('index：会读 kill() 的确认结果并如实报错', /未能确认 DSH 子进程退出/.test(idx))
    check('index：未捕获异常后主动收尾退出（不再带病长跑）',
      /uncaughtException[\s\S]{0,500}shutdown\(/.test(idx))
    check('index：重启是"先释放端口再起新进程"（handoff）',
      /已释放配置接口端口，开始拉起新进程/.test(idx))
    check('index：端口占用有重试，不再静默降级', /bindApiWithRetry/.test(idx))
  }

  console.log('')
  if (spawnBlocked && failures === 0) {
    console.log('⚠️ 只跑了静态防线（行为断言因环境限制被跳过）—— 这**不算**完整通过，')
    console.log('   请在能启动子进程的环境里再跑一次：node mocks/verify-lifecycle.mjs')
  } else if (failures === 0) {
    console.log('🎉 进程生命周期测试全部通过')
  } else {
    console.log(`⚠️ ${failures} 项失败`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验证脚本自身崩了：', error)
  process.exit(1)
})
