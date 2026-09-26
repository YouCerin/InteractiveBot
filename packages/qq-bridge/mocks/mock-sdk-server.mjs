#!/usr/bin/env node
/**
 * 模拟的 DSH SDK 服务器（测试替身）。
 *
 * ── 它是什么 ───────────────────────────────────────────────────────────
 * 一个"冒牌"的 `dsh --profile sdk`：说的协议一模一样，但收到 prompt 后
 * 不会真的去调大模型，而是立刻编造一段回复。
 *
 * ── 为什么要用它 ───────────────────────────────────────────────────────
 * 1. 讲协议：桥接只要能和这个替身跑通，换成真 dsh 就只差一个路径。
 * 2. 绕限制：起真的 dsh 子进程需要 stdio 管道，而某些沙箱环境禁止管道。
 *    替身同样是子进程，但它不加载 7MB 的运行时，排查协议问题时干扰更少。
 * 3. 造边界：真 dsh 很难稳定复现「回合跑很久」「进程突然死」这类情况，
 *    替身可以随手触发（见下面的关键词）。
 *
 * ── 测试关键词（发进 prompt 文本里就会触发）────────────────────────────
 *   __SLOW__    → 延迟 3 秒才发回合结果（测超时/并发）
 *   __DIE__     → 立刻退出进程（测重连）
 *   __NOEVENT__ → 只回应答、不发任何事件（测"回答不上来"的兜底）
 *   __THINK__   → 额外发一条 reasoning 事件（测思考内容采集）
 *
 * ── 纪律 ───────────────────────────────────────────────────────────────
 * stdout 只跑协议帧，日志一律走 stderr。这与真 sdk 服务器的要求一致
 * （官方原话："Stdout is reserved for protocol frames"）。
 */

import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

const log = (...args) => process.stderr.write('[mock-sdk] ' + args.join(' ') + '\n')

let nextSeq = 1000
const sessions = new Map() // sessionId -> { turns: number, lastUserText: string }

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n')
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

/** 从 contentBlocks 里抽出文本（真服务器的 durablePromptContent 也做类似的事）。 */
function textOf(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return ''
  return contentBlocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function handlePrompt(id, params) {
  const sessionId = params?.sessionId
  const contentBlocks = params?.contentBlocks

  if (typeof sessionId !== 'string' || !sessionId) {
    return replyError(id, -32602, 'session/prompt: sessionId 必须是非空字符串')
  }
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
    return replyError(id, -32602, 'session/prompt: contentBlocks 不能为空')
  }

  const text = textOf(contentBlocks)
  const rec = sessions.get(sessionId) ?? { turns: 0, lastUserText: '' }
  rec.turns += 1
  rec.lastUserText = text
  sessions.set(sessionId, rec)

  if (text.includes('__DIE__')) {
    log('收到 __DIE__，主动退出进程')
    process.exit(7)
  }

  // 应答先发：真服务器也是先 return { messageId }，事件在之后陆续到达。
  const messageId = `msg-${randomUUID()}`
  reply(id, { messageId })

  if (text.includes('__NOEVENT__')) {
    log(`session ${sessionId}: 按 __NOEVENT__ 要求，只应答不发事件`)
    return
  }

  if (text.includes('__SLOW__')) await sleep(3000)

  const event = (type, data) => {
    notify('session.event', { sessionId, event: { type, seq: ++nextSeq, time: Date.now(), data } })
  }

  notify('session.status', { sessionId, status: 'running' })
  event('turn/start', { turn: rec.turns })

  if (text.includes('__THINK__')) {
    event('assistant/attempt', {
      turn: rec.turns,
      step: 1,
      stream: [{ type: 'reasoning-delta', text: '（替身的思考过程）' }],
    })
  }

  event('assistant/message', {
    turn: rec.turns,
    step: 1,
    message: {
      id: messageId,
      role: 'assistant',
      content: [
        // ★ reasoning 块：真实 DSH 就在 content 里带它，桥接从这儿取思考过程。
        // 只发 stream 里的 reasoning-delta 是不够的（那不是持久事件）。
        { type: 'reasoning', text: `（替身的思考过程）第 ${rec.turns} 轮` },
        { type: 'text', text: `收到（第 ${rec.turns} 轮）：${text}` },
      ],
    },
    stream: [],
    usage: {
      inputTokens: 42 + rec.turns,
      outputTokens: 7,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    },
  })

  event('turn/end', { turn: rec.turns, reason: { kind: 'completed' } })
  notify('session.status', { sessionId, status: 'idle' })
}

async function handle(frame) {
  const { id, method, params } = frame ?? {}

  // 通知（无 id）不处理，替身用不到
  if (id === undefined) return

  switch (method) {
    case 'initialize': {
      if (!params || typeof params.cwd !== 'string' || !params.cwd) {
        return replyError(id, -32602, 'initialize: cwd 必填')
      }
      log(`initialize cwd=${params.cwd} provider=${params.provider} model=${params.model}`)
      return reply(id, {
        serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1-mock' },
      })
    }
    case 'session/prompt':
      return handlePrompt(id, params)
    case 'shutdown': {
      log('shutdown：清理并退出')
      reply(id, null)
      // 与真实现一致：应答先冲刷出去，再退出。
      setTimeout(() => process.exit(0), 20)
      return
    }
    default:
      return replyError(id, -32601, `unknown DeepSeek Harness SDK runtime method: ${method}`)
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let frame
  try {
    frame = JSON.parse(text)
  } catch {
    log(`收到非 JSON 输入，已忽略：${text.slice(0, 120)}`)
    return
  }
  // 并发处理各帧，但 handlePrompt 内部是异步的 —— 不 await，模拟真服务器的
  // "prompt 立刻返回 messageId、回合在后台跑"语义。
  handle(frame).catch((error) => {
    log(`处理帧出错：${error?.message ?? error}`)
    if (frame?.id !== undefined) replyError(frame.id, -32603, String(error?.message ?? error))
  })
})

rl.on('close', () => {
  log('stdin 关闭，退出')
  process.exit(0)
})

log('已启动，等待 JSON-RPC 帧')
