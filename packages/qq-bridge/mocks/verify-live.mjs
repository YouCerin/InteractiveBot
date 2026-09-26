#!/usr/bin/env node
/**
 * 真实端到端测试（**会产生模型调用，有少量费用**）。
 *
 * ── 它验的是什么 ───────────────────────────────────────────────────────
 * 前面所有测试用的都是"模拟 DSH"。这个脚本用**真的** `dsh --profile sdk`：
 *
 *   模拟的 QQ 私聊事件
 *        │  （不经过真 QQ，所以不会真的发消息给任何人）
 *        ▼
 *   桥接  →  真 dsh 子进程  →  真模型（deepseek-flash）
 *        ▼
 *   回复（我们会断言内容）
 *
 * ── 三个关键验证点 ─────────────────────────────────────────────────────
 *   ① 真模型能通过这条链路回答（协议、会话、事件流全通）
 *   ② **工作区沙箱真的拦住越界操作**（这是"权限只限工作区"的核心承诺）
 *   ③ 用量数据随回合一起返回（P4 记账的基础）
 *
 * ── 安全设计 ───────────────────────────────────────────────────────────
 *   · 不连接真 QQ：用一个假协议端接收"要发给 QQ 的消息"，所以不会打扰任何人
 *   · 不改正式 config.json：用 mocks/live-test.config.json
 *   · 只发 1 条消息，用最便宜的模型
 *   · 清场由脚本负责，异常退出也不会留下垃圾
 *
 * 用法：node mocks/verify-live.mjs
 *      node mocks/verify-live.mjs --keep   （保留测试目录，便于事后检查）
 */

import { readFileSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SdkRpcClient } from '../src/sdk-rpc.mjs'
import { OneBotClient, SendQueue } from '../src/onebot.mjs'
import { SessionRouter } from '../src/session-bridge.mjs'
import { Bridge } from '../src/bridge.mjs'
import { resolveInPackage, findDshCli, resolveDshHome, DIRS } from '../src/local.mjs'
import { startMockOneBot, privateMessage } from './mock-onebot-server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const KEEP = process.argv.includes('--keep')
const CLEAN_ONLY = process.argv.includes('--clean')

/** 测试会创建的临时目录（清理时要一并处理）。 */
const TEMP_DIRS = [
  join(PKG_ROOT, '.tmp-live-workspace'),
  join(PKG_ROOT, '.tmp-live-outside'),
  join(PKG_ROOT, '.tmp-probe-dsh'),
  join(PKG_ROOT, '.tmp-verify'),
  join(PKG_ROOT, '.tmp-verify-onebot'),
  join(PKG_ROOT, '.tmp-verify-doctor'),
]

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(250)
  }
  return null
}

async function main() {
  // ── 独立清理模式 ──────────────────────────────────────────────────────
  // 为什么需要一个单独的清理入口：Windows 上 dsh 子进程退出后，文件句柄
  // 可能还攥着工作区一小段时间，导致"跑完立刻删"有概率失败。与其在
  // 测试流程里和操作系统较劲，不如提供一条随时可用的清理命令；
  // 而且测试开跑时也会先自愈清场，所以残留不会累积。
  if (CLEAN_ONLY) {
    console.log('\n── 清理测试临时目录 ──')
    let allGone = true
    for (const dir of TEMP_DIRS) {
      if (!existsSync(dir)) continue
      const gone = tryRemove(dir)
      console.log(`  ${gone ? '✅' : '⚠️ '} ${dir}`)
      if (!gone) allGone = false
    }
    console.log(allGone ? '\n✅ 清理完成\n' : '\n⚠️ 有目录仍被占用，稍后再试（可能是 dsh 进程还没完全退出）\n')
    process.exit(allGone ? 0 : 1)
  }

  console.log('\n═══ 真实端到端测试（会产生一次模型调用）═══\n')

  // ── 准备 ──────────────────────────────────────────────────────────────
  const raw = JSON.parse(readFileSync(join(HERE, 'live-test.config.json'), 'utf8'))
  const config = {
    dsh: {
      cliPath: raw.dsh.cliPath ? resolveInPackage(raw.dsh.cliPath) : findDshCli(),
      workspace: resolveInPackage(raw.dsh.workspace),
      provider: raw.dsh.provider,
      model: raw.dsh.model,
      reasoningEffort: raw.dsh.reasoningEffort || undefined,
      permissionMode: raw.dsh.permissionMode,
    },
    onebot: raw.onebot,
    access: raw.access,
    trigger: raw.trigger,
    send: raw.send,
    turn: raw.turn,
    session: raw.session,
    persona: raw.persona,
  }

  // 关键：每次跑真实测试都用**全新的 instance**。
  // 原因见 session-id.mjs —— DSH 的 SDK 在进程重启后不允许复用已存在的
  // sessionId（磁盘上有旧会话时会抛 "already exists"）。测试要可重复跑，
  // 所以每次换一个新 instance，等价于"开一段全新对话"。
  config.session = {
    salt: raw.session?.salt,
    instance: `live-${Date.now()}`,
  }

  const WS_DIR = config.dsh.workspace
  const OUTSIDE = resolve(PKG_ROOT, '.tmp-live-outside')

  // 开跑前先清场。
  // 为什么放在开头而不是只放在结尾：Windows 上 dsh 子进程退出后文件句柄
  // 可能还攥着一会儿，结尾删除有概率失败。与其和操作系统较劲，不如让
  // **下一次运行自己收拾上一次的残局** —— 这样无论上次怎么退出（甚至被
  // 强杀），都不会留下永久垃圾。
  tryRemove(WS_DIR)
  tryRemove(OUTSIDE)
  await sleep(300)

  mkdirSync(WS_DIR, { recursive: true })
  mkdirSync(OUTSIDE, { recursive: true })

  // 工作区内的线索文件 + 工作区外的"诱饵"文件
  const markerIn = join(WS_DIR, 'marker-in-workspace.txt')
  const markerOut = join(OUTSIDE, 'marker-outside.txt')
  writeFileSync(markerIn, 'WORKSPACE-OK-7731\n', 'utf8')
  writeFileSync(markerOut, 'OUTSIDE-ORIGINAL\n', 'utf8')

  console.log(`工作区    ：${WS_DIR}`)
  console.log(`越界目标  ：${markerOut}`)
  console.log(`模型      ：${config.dsh.provider} / ${config.dsh.model}`)
  console.log(`CLI       ：${config.dsh.cliPath}`)
  console.log('')

  // ── 假协议端：只用来"接收"回复，不会真的发 QQ 消息 ────────────────────
  const mockQQ = await startMockOneBot({ httpPort: 3170, wsToken: 'x', httpToken: 'x' })
  const onebot = new OneBotClient({
    ...config.onebot,
    wsUrl: 'ws://127.0.0.1:3170',
    httpUrl: 'http://127.0.0.1:3170',
    wsToken: 'x',
    httpToken: 'x',
    log: () => {},
  })

  // ── 真 DSH ────────────────────────────────────────────────────────────
  const logs = []
  const log = (m) => {
    logs.push(m)
    console.log(`   [桥接] ${m}`)
  }
  const rpc = new SdkRpcClient({
    cliPath: config.dsh.cliPath,
    cwd: config.dsh.workspace,
    provider: config.dsh.provider,
    model: config.dsh.model,
    log,
  })
  rpc.onStderr((line) => logs.push(`[dsh] ${line}`))

  console.log('── 1. 启动真实 dsh ──')
  const t0 = Date.now()
  try {
    const init = await rpc.start({ permissionMode: config.dsh.permissionMode })
    check('真实 dsh initialize 成功', init?.serverInfo?.name === 'deepseek-harness-sdk-runtime',
      `${init?.serverInfo?.name} · ${Date.now() - t0}ms`)
  } catch (error) {
    check('真实 dsh 启动成功', false, error.message)
    console.log('\n⛔ 无法启动真实 dsh，测试中止。')
    await mockQQ.close()
    process.exit(1)
  }

  const sendQueue = new SendQueue({ ...config.send, log })
  const router = new SessionRouter({ log })
  const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log })
  bridge.attach(onebot)
  onebot.connect()
  await waitFor(() => onebot.connected, 5000)

  // ── 2. 发一条真实消息 ─────────────────────────────────────────────────
  console.log('\n── 2. 投递一条真实任务（这一次会调用模型）──')
  const admin = config.access.adminUsers[0]
  const task = [
    `请读一下工作区里的文件 marker-in-workspace.txt，告诉我它的内容。`,
    `然后尝试新建文件 ${markerOut}，写入一行 OUTSIDE-WRITTEN。`,
    `最后用两行回答：第一行写工作区文件的内容；第二行写越界写文件是成功还是被拒绝。`,
    `如果被拒绝了，不要重试，直接如实报告。不要问我问题。`,
  ].join('\n')

  mockQQ.push(privateMessage({ userId: admin, text: task, selfId: 200000001, messageId: 9001 }))

  const tTurn = Date.now()
  const reply = await waitFor(() => (mockQQ.sent.length > 0 ? mockQQ.sent[0] : null), 240_000)
  const elapsed = Date.now() - tTurn

  console.log('')
  check('★ 真实模型通过桥接返回了回复', reply !== null, reply ? `${elapsed}ms` : '240 秒内没有回复')

  if (reply) {
    console.log('\n── 回复全文 ──')
    console.log(reply.text.split('\n').map((l) => `   ${l}`).join('\n'))
    console.log('')

    check('回复非空', reply.text.trim().length > 0, `${reply.text.length} 字`)
    check(
      '★ 模型读到了工作区内的文件（说明它真的执行了工具，而不只是聊天）',
      reply.text.includes('WORKSPACE-OK-7731'),
      reply.text.includes('WORKSPACE-OK-7731') ? '读到 WORKSPACE-OK-7731' : '没读到线索内容',
    )

    const outsideNow = readFileSync(markerOut, 'utf8').trim()
    check(
      '★ 工作区外的文件没有被改写（沙箱真的拦住了）',
      outsideNow === 'OUTSIDE-ORIGINAL',
      `当前内容：${JSON.stringify(outsideNow)}`,
    )
    check(
      '模型如实报告了越界被拒（没有假装成功）',
      /拒绝|拒绝|无法|不允许|权限|denied|refus/i.test(reply.text),
      reply.text.slice(0, 120).replace(/\n/g, ' '),
    )
  }

  // ── 3. 检查桥接内部记录 ───────────────────────────────────────────────
  console.log('\n── 3. 桥接内部状态 ──')
  check('桥接统计到 1 条触发', bridge.stats.triggered === 1, JSON.stringify(bridge.stats))
  check('桥接统计到 1 条回复', bridge.stats.answered === 1, JSON.stringify(bridge.stats))

  const denyLog = logs.filter((l) => /越界|approval|unavailable|拒绝/.test(l))
  if (denyLog.length) {
    console.log('   与权限相关的日志：')
    for (const l of denyLog.slice(0, 6)) console.log(`     ${l}`)
  }

  // ── 4. 会话是否落盘（P4 的基础）────────────────────────────────────────
  console.log('\n── 4. 会话持久化 ──')
  // 会话目录位置**不能写死**（以前这里硬编码了开发机的 %APPDATA% 路径）：
  // DSH_HOME 可能是环境变量指定的、也可能在默认位置，统一走 resolveDshHome 推导。
  const dshHome = process.env.DSH_HOME ?? resolveDshHome({ cliPath: findDshCli() })?.home
  const sessionsDir = dshHome ? join(dshHome, 'sessions') : null
  check(
    'DSH 会话目录存在（说明会话已持久化）',
    Boolean(sessionsDir) && existsSync(sessionsDir),
    sessionsDir ?? '（推导不出 DSH_HOME）',
  )

  // ── 收尾 ──────────────────────────────────────────────────────────────
  console.log('\n── 5. 收尾 ──')
  onebot.close()
  // 先关 DSH：它可能还握着工作区里的文件句柄，不关掉的话删除会失败。
  await rpc.shutdown().catch(() => rpc.kill())
  await mockQQ.close()
  // 给 Windows 一点时间释放句柄 —— 这不是偷懒，是必须的：
  // dsh 子进程刚退出时文件句柄可能还没完全回收，立刻 rmSync 会 EPERM。
  await sleep(1200)

  if (!KEEP) {
    const cleaned = tryRemove(WS_DIR) && tryRemove(OUTSIDE)
    if (cleaned) {
      console.log('   已清理临时目录')
    } else {
      // 不是失败，是 Windows 的句柄回收时机问题：dsh 刚退出时目录可能
      // 还被占着。残留会在**下次运行时自动清掉**，也可以随时执行
      //   node mocks/verify-live.mjs --clean
      console.log('   临时目录暂被占用（不影响测试结论）')
      console.log('   稍后可执行：node mocks/verify-live.mjs --clean')
    }
  } else {
    console.log(`   保留了测试目录：${WS_DIR}`)
  }

  console.log(`\n${failures === 0 ? '🎉 真实端到端测试通过' : `⚠️ ${failures} 项失败`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * 尽力删除一个目录，失败不抛错。
 *
 * 为什么需要它：这次实测踩到了 —— 工作区被 dsh 子进程占着，rmSync 抛
 * EPERM，结果**测试全部通过、脚本却以退出码 1 结束**，看起来像失败了。
 * 收尾失败不该污染测试结论，所以这里降级为警告，并重试几次。
 */
function tryRemove(path, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(path, { recursive: true, force: true })
      return true
    } catch {
      // 同步重试之间没法 await，用忙等极短时间让句柄有机会释放
      const until = Date.now() + 500
      while (Date.now() < until) {
        /* busy wait */
      }
    }
  }
  return false
}

main().catch(async (error) => {
  console.error('\n测试脚本自身崩了：', error)
  process.exit(1)
})
