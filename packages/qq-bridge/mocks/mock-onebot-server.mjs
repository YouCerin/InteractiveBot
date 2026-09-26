#!/usr/bin/env node
/**
 * 模拟的 OneBot v11 协议端（测试替身）。
 *
 * ── 它模拟了 SnowLuma 的什么 ───────────────────────────────────────────
 *   · HTTP API（默认 3100 端口）→ 接收 send_private_msg / send_group_msg 等
 *   · WebSocket 服务端（默认 3101）→ 我们连上去，它推事件给我们
 *
 * 与真 SnowLuma 的差别：它不会真的发 QQ 消息，只是把发出去的记在一个
 * 内存列表里，供验证脚本断言。这样"回复内容对不对"就可以被自动检查，
 * 而不需要人盯着手机看。
 *
 * ── 为什么端口用 3100/3101 而不是 3000/3001 ────────────────────────────
 * 避免和真的 SnowLuma 抢端口。真跑的时候改 config.json 即可。
 *
 * 用法（独立跑，用于手工目视）：
 *   node mocks/mock-onebot-server.mjs
 * 作为库用（验证脚本这么用）：
 *   import { startMockOneBot } from './mock-onebot-server.mjs'
 *
 * ── 前提 ───────────────────────────────────────────────────────────────
 * 本替身**依赖 vendor/node_modules/ws**。按"整个包可搬迁"的原则，它不
 * 自己去找标准 node_modules，而是走 src/vendor.mjs。所以运行前必须先
 * 执行过 `node setup.mjs`。下面的 assertVendored 会在缺失时直接给出
 * "请先跑 setup.mjs"的明确提示，而不是抛 Node 那套难懂的解析失败。
 */

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { assertVendored, vendorRequire } from '../src/vendor.mjs'

// 与 src/onebot.mjs 一致：从 vendor 加载 ws，不依赖标准 node_modules，
// 这样整个包换地方也能跑。
assertVendored('ws')
const { WebSocketServer } = vendorRequire('ws')

const log = (...args) => {
  if (process.env.MOCK_QUIET !== '1') process.stderr.write('[mock-onebot] ' + args.join(' ') + '\n')
}

export function startMockOneBot({ httpPort = 3100, wsPort = 3101, wsToken = 'ws-token', httpToken = 'http-token' } = {}) {
  /** 记录所有被发送出去的消息，供断言。 */
  const sent = []
  /** 记录所有收到的 action 调用。 */
  const calls = []
  /** 已连接的 WebSocket 客户端。 */
  const sockets = new Set()
  /**
   * 可变的测试开关（给用例现场改）。
   *   · `memberFail`：非空时 `get_group_member_info` 一律失败 ——
   *     用来验证"身份核实失败**不影响回话**，且不编名字"。
   */
  const state = { memberFail: null, groupListFails: false }

  const http = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8')

      // 鉴权：模拟真协议端的行为（token 不对要拒绝，否则我们测不出配置错误）
      const auth = req.headers.authorization ?? ''
      if (httpToken && auth !== `Bearer ${httpToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'failed', retcode: 1403, wording: 'token 不正确' }))
        return
      }

      const action = (req.url ?? '/').replace(/^\//, '')
      let params = {}
      try {
        params = bodyText ? JSON.parse(bodyText) : {}
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'failed', retcode: 1400, wording: 'body 不是合法 JSON' }))
        return
      }

      calls.push({ action, params })

      const ok = (data) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data }))
      }

      switch (action) {
        case 'get_login_info':
          return ok({ user_id: 200000001, nickname: '测试机器人' })
        case 'get_friend_list':
          return ok([{ user_id: 100000001, nickname: '管理员' }])
        case 'get_group_list':
          // 测试钩子：`server.state.groupListFails = true` 时模拟"拿不到群名"，
          // 用来验证会话名**留空**（界面显示号码）而不是编一个名字出来。
          if (state.groupListFails) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: '模拟：拉群列表失败' }))
            return
          }
          return ok([{ group_id: 700000002, group_name: '测试群' }])
        // 群成员资料（身份核实用）。**刻意让一个普通群成员在群里是"群管理"**
        // —— 用来验证"群内角色不参与权限判定"：他仍该被标成普通用户（只读）。
        case 'get_group_member_info': {
          // 测试钩子：`server.memberFail = '超时'` 时模拟协议端查不到人。
          if (state.memberFail) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(
              JSON.stringify({ status: 'failed', retcode: 1404, wording: String(state.memberFail) }),
            )
            return
          }
          const uid = String(params.user_id ?? '')
          const table = {
            '100000001': { nickname: '管理员', card: '群主大人', role: 'owner' },
            '100000002': { nickname: '路人甲', card: '甲甲', role: 'admin' },
            '1999999999': { nickname: '陌生人', card: '', role: 'member' },
          }
          const hit = table[uid]
          if (!hit) return ok({ user_id: Number(uid) || 0, nickname: '', card: '', role: '' })
          return ok({ user_id: Number(uid), ...hit, level: '1' })
        }
        case 'send_private_msg':
        case 'send_group_msg': {
          const segments = params.message ?? []
          const text = segments
            .filter((s) => s?.type === 'text')
            .map((s) => s.data?.text ?? '')
            .join('')
          sent.push({
            kind: action === 'send_private_msg' ? 'private' : 'group',
            peerId: params.user_id ?? params.group_id,
            text,
            at: Date.now(),
          })
          return ok({ message_id: 10000 + sent.length })
        }
        default:
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: `不支持 action: ${action}` }))
          return
      }
    })
  })

  const wss = new WebSocketServer({ server: http, path: '/' })

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const provided = []
    const queryToken = url.searchParams.get('access_token')
    if (queryToken) provided.push(queryToken)
    const auth = req.headers.authorization ?? ''
    if (auth.startsWith('Bearer ')) provided.push(auth.slice('Bearer '.length))

    // ⚠️ 鉴权规则刻意严格：**提供的凭据必须全部正确**。
    // 曾经的写法是"任一正确即放行"，结果掩盖了一个真实问题 ——
    // 客户端同时用 query 和 header 传 token 时，只要有一个对就能连上，
    // 于是"token 配错"这种最常见的故障在替身上测不出来。
    // 替身太宽松 = 测试没有意义，所以这里改成 fail-closed。
    const authorized = !wsToken || (provided.length > 0 && provided.every((t) => t === wsToken))

    if (!authorized) {
      log(`拒绝未授权连接（提供了 ${provided.length} 个凭据，均需与配置一致）`)
      socket.close(4401, 'unauthorized')
      return
    }
    log('事件通道已连接')
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return new Promise((resolve, reject) => {
    http.on('error', reject)
    http.listen(httpPort, '127.0.0.1', () => {
      log(`HTTP API 监听 127.0.0.1:${httpPort}，WebSocket 监听同端口 ${httpPort}（path /）`)
      resolve({
        httpPort,
        wsPort: httpPort,
        sent,
        calls,
        /** 可变测试开关（见文件头的 `state` 说明）。 */
        state,
        /** 推一个事件给所有已连接客户端。 */
        push(event) {
          const payload = JSON.stringify(event)
          let count = 0
          for (const socket of sockets) {
            if (socket.readyState === 1) {
              socket.send(payload)
              count += 1
            }
          }
          log(`已推送事件 post_type=${event.post_type} 给 ${count} 个客户端`)
          return count
        },
        get sentCount() {
          return sent.length
        },
        close() {
          for (const socket of sockets) {
            try {
              socket.close()
            } catch {
              /* ignore */
            }
          }
          wss.close()
          return new Promise((r) => http.close(() => r()))
        },
      })
    })
  })
}

/** 构造一条私聊消息事件。 */
export function privateMessage({ userId, text, selfId = 200000001, messageId = 1 }) {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: selfId,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageId,
    user_id: userId,
    raw_message: text,
    font: 0,
    sender: { user_id: userId, nickname: `用户${userId}` },
    message: [{ type: 'text', data: { text } }],
  }
}

/** 构造一条群消息事件。 */
export function groupMessage({ groupId, userId, text, selfId = 200000001, mentionsSelf = false, messageId = 1 }) {
  const segments = []
  if (mentionsSelf) segments.push({ type: 'at', data: { qq: String(selfId) } })
  segments.push({ type: 'text', data: { text } })
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: selfId,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: groupId,
    user_id: userId,
    raw_message: (mentionsSelf ? `[CQ:at,qq=${selfId}] ` : '') + text,
    font: 0,
    sender: { user_id: userId, nickname: `群友${userId}`, role: 'member' },
    message: segments,
  }
}

// 直接运行时的最小演示
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = await startMockOneBot()
  log('按 Ctrl+C 退出')
  process.on('SIGINT', async () => {
    await server.close()
    process.exit(0)
  })
}
