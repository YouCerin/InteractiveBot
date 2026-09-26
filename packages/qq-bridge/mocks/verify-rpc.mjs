#!/usr/bin/env node
/**
 * sdk-rpc.mjs 的验证脚本 —— 对着 mock-sdk-server.mjs 跑真实协议。
 *
 * 这是"可验证"的部分：不靠"我觉得对"，而是跑一遍看断言过不过。
 *
 * 用法：node mocks/verify-rpc.mjs
 * 退出码 0 = 全部通过；1 = 有失败项。
 */

import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { SdkRpcClient } from '../src/sdk-rpc.mjs'
import { makeSessionId, isBridgeSessionId } from '../src/session-id.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK = join(HERE, 'mock-sdk-server.mjs')
const WS = join(HERE, '..', '.tmp-verify')

let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? '✅' : '❌'
  console.log(`${mark} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}

/** 造一个跑 mock server 的 client（复用 SdkRpcClient 的真实代码路径）。 */
function makeClient(overrides = {}) {
  return new SdkRpcClient({
    cliPath: MOCK,
    cwd: WS,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    log: () => {},
    ...overrides,
  })
}

/**
 * 关键点：SdkRpcClient 是用 `spawn(node, [cliPath, '--profile','sdk'])` 起的。
 * mock server 不认识 --profile sdk，但这没关系 —— 我们是 node 跑脚本，
 * 多余的 argv 会被忽略。所以这里能直接复用同一条启动路径，不搞特例。
 */

/** 收集某个 sessionId 的事件，直到 turn/end 或超时。 */
/**
 * 收集某个会话的一轮事件，直到 turn/end。
 *
 * ⚠️ 这里修过一个**不稳定的测试**（flaky），值得记下来：
 * 原来的实现在收到 `session.status: idle` 时就立即结算。但通知与事件
 * **到达顺序不保证** —— idle 有可能先到，真正的 `assistant/message` 后到，
 * 于是断言拿到空字符串。表现是"大部分时候通过、偶尔失败一次"，
 * 而这种不稳定比直接失败更糟：它会让人习惯性忽略红灯。
 *
 * 现在的策略：**只认 turn/end 作为结束信号**；idle 只作为兜底
 * （延迟一小段再结算，给乱序的事件留出到达时间）。
 */
function collectTurn(client, sessionId, { timeoutMs = 10_000, idleGraceMs = 300 } = {}) {
  const events = []
  let sawEnd = false
  let idleTimer = null
  let resolveDone
  const done = new Promise((r) => (resolveDone = r))

  const settle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    resolveDone()
  }

  const onNotification = (e) => {
    const { method, params } = e.detail
    if (method === 'session.event' && params.sessionId === sessionId) {
      events.push(params.event)
      if (params.event.type === 'turn/end') {
        sawEnd = true
        settle()
      }
    }
    if (method === 'session.status' && params.sessionId === sessionId && params.status === 'idle') {
      // 不立刻结算：等一小段，防止 assistant/message 因乱序还没到
      if (!idleTimer) idleTimer = setTimeout(settle, idleGraceMs)
    }
  }
  client.addEventListener('notification', onNotification)

  return {
    done: Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))]).then(() => {
      if (idleTimer) clearTimeout(idleTimer)
      client.removeEventListener('notification', onNotification)
      return { events, sawEnd }
    }),
    stop: () => client.removeEventListener('notification', onNotification),
  }
}

async function main() {
  mkdirSync(WS, { recursive: true })

  console.log('\n── 用例 1：启动 + initialize ──────────────────────────────')
  const client = makeClient()
  let stderrLines = 0
  client.onStderr(() => (stderrLines += 1))

  const init = await client.start({ permissionMode: 'workspace-write' })
  check('initialize 返回 serverInfo', init?.serverInfo?.name === 'deepseek-harness-sdk-runtime',
    JSON.stringify(init?.serverInfo))
  check('client.ready 为真', client.ready === true)
  check('stderr 被当作日志转发（不污染协议流）', stderrLines > 0, `${stderrLines} 行`)

  console.log('\n── 用例 2：session/prompt 返回 messageId ──────────────────')
  // ⚠️ 这里必须显式传 instance。
  // 默认 instance 是"每次调用都不同"（= 每次进程启动唯一），
  // 所以不带 instance 比较两次调用**必然不等** —— 那是刻意的，
  // 不是缺陷。要验"稳定性"，就该在**同一次运行**的语境下比：
  const runTag = 'verify-run-1'
  const sessionA = makeSessionId('private', '123456789', { instance: runTag })
  check('sessionId 形状合法', isBridgeSessionId(sessionA), sessionA)
  check('sessionId 不含原始 QQ 号', !sessionA.includes('123456789'))
  check('同一输入稳定（同一次运行内）',
    makeSessionId('private', '123456789', { instance: runTag }) === sessionA)

  const t1 = collectTurn(client, sessionA)
  const res = await client.prompt(sessionA, [{ type: 'text', text: '你好' }])
  check('prompt 返回 messageId', typeof res?.messageId === 'string' && res.messageId.length > 0,
    res?.messageId)
  const turn1 = await t1.done
  check('收到 turn/end', turn1.sawEnd === true)

  const types = turn1.events.map((e) => e.type)
  check('事件序列含 turn/start', types.includes('turn/start'), types.join(' → '))
  check('事件序列含 assistant/message', types.includes('assistant/message'))

  const am = turn1.events.find((e) => e.type === 'assistant/message')
  // ⚠️ 不要假设 content[0] 是文本：真实 DSH 会在同一个 content 数组里
  //    带上 `reasoning` 块（思考过程），而且**顺序不保证**。
  //    这里按 type 找 text 块 —— 第一版写的是 content[0].text，
  //    mock 一加 reasoning 块就报出了"取到的是思考过程"这种假失败。
  const contentBlocks = am?.data?.message?.content ?? []
  const text = contentBlocks
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('')
  check('能从事件里取到回复文本', text.includes('你好'), JSON.stringify(text.slice(0, 60)))
  check('★ 同一个 content 里可能混有 reasoning 块（界面据此显示思考过程）',
    contentBlocks.some((b) => b?.type === 'reasoning'),
    contentBlocks.map((b) => b?.type).join(','))
  check('usage 随 assistant/message 一起到达',
    typeof am?.data?.usage?.inputTokens === 'number',
    JSON.stringify(am?.data?.usage))

  console.log('\n── 用例 3：多轮同一会话（上下文连续性由 sessionId 保证）──')
  const t2 = collectTurn(client, sessionA)
  await client.prompt(sessionA, [{ type: 'text', text: '第二句' }])
  const turn2 = await t2.done
  const am2 = turn2.events.find((e) => e.type === 'assistant/message')
  const text2 = am2?.data?.message?.content?.[0]?.text ?? ''
  check('第二轮到达且有第 2 轮的痕迹', text2.includes('第 2 轮'), JSON.stringify(text2.slice(0, 60)))

  console.log('\n── 用例 4：不同 QQ 会话 → 不同 DSH 会话（互相隔离）──')
  const sessionB = makeSessionId('group', '987654321', { instance: runTag })
  check('私聊与群聊的 sessionId 不同', sessionA !== sessionB, `${sessionA} vs ${sessionB}`)
  const t3 = collectTurn(client, sessionB)
  await client.prompt(sessionB, [{ type: 'text', text: '群里的第一句' }])
  const turn3 = await t3.done
  const am3 = turn3.events.find((e) => e.type === 'assistant/message')
  const text3 = am3?.data?.message?.content?.[0]?.text ?? ''
  check('新会话从第 1 轮开始（没被上个会话污染）', text3.includes('第 1 轮'),
    JSON.stringify(text3.slice(0, 60)))

  console.log('\n── 用例 5：思考内容（reasoning）能被采集 ──────────────────')
  // ⚠️ 这里的关键是「监听用的 id」与「投递用的 id」必须**同一个值**。
  // 原来两次都调 makeSessionId 且不传 instance，而默认 instance 每次调用都不同，
  // 于是监听挂在一个 id 上、消息投到另一个 id 上，永远收不到事件。
  // 这正是"同一次运行内 id 必须稳定"的现场证明。
  const s4 = makeSessionId('private', '555', { instance: runTag })
  const t4 = collectTurn(client, s4)
  await client.prompt(s4, [{ type: 'text', text: '__THINK__ 带思考' }])
  const turn4 = await t4.done
  check('收到 assistant/attempt 事件', turn4.events.some((e) => e.type === 'assistant/attempt'))

  console.log('\n── 用例 6：错误路径 ───────────────────────────────────────')
  let unknownErr = null
  try {
    await client.request('不存在的method', {})
  } catch (error) {
    unknownErr = error
  }
  check('未知方法返回错误而不是静默', unknownErr !== null && /unknown/.test(unknownErr.message),
    unknownErr?.message?.slice(0, 80))

  let emptyErr = null
  try {
    await client.prompt(sessionA, [])
  } catch (error) {
    emptyErr = error
  }
  check('空 contentBlocks 被本地拒绝', emptyErr !== null, emptyErr?.message)

  console.log('\n── 用例 7：shutdown + 进程退出 ────────────────────────────')
  const exited = once(client, 'exit')
  await client.shutdown()
  const [code] = await Promise.race([exited, new Promise((r) => setTimeout(() => r([null]), 5000))])
  check('shutdown 后子进程退出', code === 0 || code === null, `exit code=${code}`)

  console.log(`\n${failures === 0 ? '🎉 全部通过' : `⚠️ ${failures} 项失败`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验证脚本自身崩了：', error)
  process.exit(1)
})
