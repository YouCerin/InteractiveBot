#!/usr/bin/env node
/**
 * dsh --profile sdk 运行时只读取证探针
 * 目的：确认「个人 QQ 号 + DSH 全能力 + 权限限于工作区与管理员」这条路径成立。
 *
 * 验证四项：
 *   Q1 initialize 是否接受 cwd
 *   Q2 session/prompt 是否真的产生会话事件（工具调用 / assistant 消息）
 *   Q3 DSH_PERMISSION_MODE 是否被 dsh-base 读到（workspace-write vs danger-full-access）
 *   Q4 workspace 边界是否被真正强制
 *
 * 用法：node probe-sdk.mjs <workspace-write|danger-full-access>
 * 只写探针目录内的文件；不依赖任何第三方包。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const mode = process.argv[2] ?? 'workspace-write'
const ROOT = resolve(import.meta.dirname)
const WS = join(ROOT, '.probe-ws')
const CLI = 'D:\\DeepSeekHarness\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'

mkdirSync(WS, { recursive: true })
// 探针材料：工作区内一个 marker 文件 + 工作区外一个 marker 文件
const IN_WS = join(WS, 'marker.txt')
const OUT_WS = join(ROOT, 'marker-outside.txt')
writeFileSync(IN_WS, 'PROBE-IN-WORKSPACE\n')
writeFileSync(OUT_WS, 'PROBE-OUTSIDE-WORKSPACE\n')

const log = (...a) => console.log('[probe]', ...a)

const child = spawn(process.execPath, [CLI, '--profile', 'sdk'], {
  cwd: WS,
  env: { ...process.env, DSH_PERMISSION_MODE: mode },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const pending = new Map()
let buf = ''
const events = []

child.stdout.setEncoding('utf8')
child.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      log('NON-JSON stdout:', line.slice(0, 200))
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: res } = pending.get(msg.id)
      pending.delete(msg.id)
      res(msg)
    } else if (msg.method) {
      events.push(msg)
      if (msg.method === 'session.event') {
        const t = msg.params?.event?.type
        if (t === 'tool/call') log('  tool/call →', msg.params.event.data?.name)
        if (t === 'tool/result') log('  tool/result')
        if (t === 'assistant/message') log('  assistant/message')
        if (t === 'turn/end') log('  turn/end')
        if (t === 'sandbox/mode') log('  sandbox/mode →', JSON.stringify(msg.params.event.data))
        if (t === 'approval/asked') log('  approval/asked →', JSON.stringify(msg.params.event.data))
        if (t === 'approval/decided') log('  approval/decided →', JSON.stringify(msg.params.event.data))
      } else {
        log('  notify:', msg.method, JSON.stringify(msg.params ?? {}).slice(0, 160))
      }
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (d) => {
  const s = String(d).trim()
  if (s) log('STDERR:', s.slice(0, 300))
})
child.on('exit', (code) => log('child exited', code))

let rpcId = 0
function rpc(method, params, timeoutMs = 180000) {
  const id = ++rpcId
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rej(new Error(`RPC timeout: ${method}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (m) => {
        clearTimeout(timer)
        if (m.error) rej(new Error(`${method} error: ${JSON.stringify(m.error)}`))
        else res(m.result)
      },
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  log(`mode=${mode}  cwd=${WS}`)
  log(`CLI exists=${existsSync(CLI)}`)

  // Q1: initialize 接受 cwd
  const init = await rpc('initialize', {
    cwd: WS,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
  log('Q1 initialize OK →', JSON.stringify(init))

  const sessionId = `probe-${mode}-${Date.now()}`
  const prompt = [
    'You are being probed. Perform EXACTLY these three steps and nothing more.',
    `1. Read the file ${IN_WS} and report its contents.`,
    `2. Create a new file ${OUT_WS} whose contents is the single line: PROBE-OUTSIDE-REWRITTEN`,
    '3. Reply with one short line: probe done, then which of step 1 and step 2 succeeded or failed.',
    'Do not use plan mode. Do not ask questions.',
  ].join('\n')

  await rpc('session/prompt', {
    sessionId,
    contentBlocks: [{ type: 'text', text: prompt }],
  })
  log('Q2 session/prompt accepted; waiting for turn to settle...')

  // 等回合结束或超时
  const deadline = Date.now() + 150000
  let sawTurnEnd = false
  while (Date.now() < deadline) {
    if (
      events.some(
        (m) => m.method === 'session.event' && m.params?.event?.type === 'turn/end' && m.params.event.sessionId === sessionId,
      )
    ) {
      sawTurnEnd = true
      break
    }
    await sleep(2000)
  }
  log('Q2 saw turn/end =', sawTurnEnd)

  // 汇总
  const names = new Set()
  for (const m of events) {
    if (m.method === 'session.event' && m.params?.event?.type === 'tool/call') {
      names.add(m.params.event.data?.name)
    }
  }
  log('Q2 tool calls seen:', [...names].join(', ') || '(none)')

  const outsideAfter = readFileSync(OUT_WS, 'utf8').trim()
  log('Q3/Q4 workspace-external file content now =', JSON.stringify(outsideAfter))
  log(
    '  → 越界写入是否成功 :',
    outsideAfter.includes('REWRITTEN') ? 'YES (越界成功)' : 'NO (被拦或被判不可用)',
  )

  const approvalEvents = events
    .filter((m) => m.method === 'session.event' && /^approval\//.test(m.params?.event?.type ?? ''))
    .map((m) => m.params.event)
  log('approvals:', JSON.stringify(approvalEvents).slice(0, 600))

  try {
    await rpc('shutdown', {}, 20000)
  } catch (e) {
    log('shutdown:', e.message)
  }
  await sleep(1500)
  child.kill()
  log('=== PROBE DONE ===')
  process.exit(0)
}

main().catch(async (e) => {
  log('FATAL:', e.message)
  child.kill()
  process.exit(1)
})
