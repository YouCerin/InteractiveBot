#!/usr/bin/env node
/**
 * QQ 工具 MCP 服务器（stdio，零依赖）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么是"自己实现 MCP"而不是引 `@modelcontextprotocol/sdk`
 * ══════════════════════════════════════════════════════════════════════════
 * 我们实测看过那个 SDK 的依赖：`express`、`hono`、`ajv`、`jose`、`eventsource`、
 * `raw-body`、`cors` … 拷进包会多出几十 MB，直接破坏本项目的"可搬迁、依赖极少"
 * 原则（当前运行期只有 `ws` 一个依赖）。
 *
 * 而我们**只需要协议的一小块**：stdin/stdout 上的 JSON-RPC，
 * 三个方法（initialize / tools/list / tools/call）。跟 `src/sdk-rpc.mjs`
 * 手写 DSH 的 JSON-RPC 客户端是同一个思路。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个文件（它补的是架构缺口）
 * ══════════════════════════════════════════════════════════════════════════
 * 模型跑在 `dsh --profile sdk` 子进程里，**看不到桥接手上的 OneBot 连接**；
 * 而 SDK 只暴露 initialize / session/prompt / shutdown，**没有"调用工具"通道**。
 * 所以桥接没法直接把自己的 QQ 能力塞给模型。
 *
 * 唯一可行的接法：**让 DSH 的 MCP 客户端加载本文件** ——
 * MCP 工具会进模型的工具表，模型就能像调 `read`/`bash` 一样调 QQ 动作。
 * 本文件再通过 HTTP 调 SnowLuma 的 OneBot API 完成真实动作。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 安全策略：**黑名单，不是白名单**
 * ══════════════════════════════════════════════════════════════════════════
 * 需求是"能调用所有 SnowLuma 中的 QQ 功能"，所以白名单会不断漏 ——
 * 而且我们无法穷举 SnowLuma 支持的全部 action。
 * 因此这里用**动作黑名单**：默认放行，只拦"会伤害他人或账号"的动作
 * （踢人、禁言、删好友、退群、改名片、批量操作…）。
 * 这样任何 SnowLuma 能力都能用，而危险面是显式列出的。
 *
 * 用法：由 DSH 的 MCP 客户端拉起（stdio）。
 *   node mcp-qq-server.mjs --config <mcp-qq.config.json>
 * 配置文件由桥接在启动时生成（含端点与 token）。
 */

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// ── 协议版本：与 @modelcontextprotocol/sdk 的 stdio 服务端约定一致 ────────
const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'qq-bridge-qq-tools', version: '0.2.0' }

/**
 * ★ 危险动作黑名单（默认放行其余一切）。
 *
 * 分三类，每类的理由都写在注释里 —— 改这个列表前请先想清楚后果。
 */
const BLOCKED_ACTIONS = {
  // ① 会伤害群里的人：踢人、禁言、改头衔、设管理
  'set_group_kick': '会把群成员踢出群',
  'set_group_ban': '会禁言群成员',
  'set_group_whole_ban': '会开启全员禁言',
  'set_group_admin': '会给人/撤人管理员',
  'set_group_card': '会改别人的群名片',
  'set_group_name': '会改群名',
  'set_group_leave': '会让机器人退群',
  'set_group_special_title': '会改群成员头衔',

  // ② 会伤害账号的社交关系：删好友、退群、改资料
  'delete_friend': '会删好友',
  'set_friend_add_request': '会影响好友请求处理',
  'set_group_add_request': '会影响入群请求处理',
  'set_qq_profile': '会改机器人自己的资料',
  'set_qq_avatar': '会改机器人头像',
  'set_self_longnick': '会改机器人签名',

  // ③ 批量/系统级：一次影响很多人，或改动运行环境
  '_send_group_notice': '会发群公告',
  'send_group_sign': '会群打卡（可能被判定为刷分）',
}

// ── 工具定义（写给模型的说明；措辞直接影响它用不用、怎么用） ─────────────
const TOOLS = [
  {
    name: 'qq_poke',
    description:
      '戳一戳某个 QQ 用户（就是 QQ 里那个"戳一戳"）。私聊里戳对方，或群里戳某个群成员。' +
      '这是轻互动，别连续戳同一个人。',
    inputSchema: {
      type: 'object',
      properties: {
        peerId: { type: 'string', description: '目标 QQ 号' },
        groupId: { type: 'string', description: '群号；填了就是群内戳人，留空则是私聊戳' },
      },
      required: ['peerId'],
    },
    build: ({ peerId, groupId }) =>
      groupId
        ? { action: 'group_poke', params: { group_id: Number(groupId), user_id: Number(peerId) } }
        : { action: 'friend_poke', params: { user_id: Number(peerId) } },
  },
  {
    name: 'qq_send_sticker',
    description: '在会话里发一张 QQ 表情（表情 id，例如 1、4、13）。和文字分开用。',
    inputSchema: {
      type: 'object',
      properties: {
        peerId: { type: 'string', description: '群号或 QQ 号' },
        kind: { type: 'string', enum: ['private', 'group'], description: '会话类型' },
        stickerId: { type: 'string', description: '表情 id' },
      },
      required: ['peerId', 'kind', 'stickerId'],
    },
    build: ({ peerId, kind, stickerId }) => ({
      action: kind === 'group' ? 'send_group_msg' : 'send_private_msg',
      params: {
        [kind === 'group' ? 'group_id' : 'user_id']: Number(peerId),
        message: [{ type: 'face', data: { id: String(stickerId) } }],
      },
    }),
  },
  {
    name: 'qq_recall',
    description: '撤回一条消息。用于"说错了/发错了"时自己收回来。',
    inputSchema: {
      type: 'object',
      properties: { messageId: { type: 'string', description: '要撤回的消息 id' } },
      required: ['messageId'],
    },
    build: ({ messageId }) => ({ action: 'delete_msg', params: { message_id: Number(messageId) } }),
  },
  {
    name: 'qq_group_members',
    description: '查群成员列表（昵称、群名片、角色）。想知道群里都有谁时用。',
    inputSchema: {
      type: 'object',
      properties: { groupId: { type: 'string', description: '群号' } },
      required: ['groupId'],
    },
    build: ({ groupId }) => ({ action: 'get_group_member_list', params: { group_id: Number(groupId) } }),
  },
  {
    name: 'qq_message_detail',
    description: '查某条消息的详情（用于看清引用的是哪句话）。',
    inputSchema: {
      type: 'object',
      properties: { messageId: { type: 'string', description: '消息 id' } },
      required: ['messageId'],
    },
    build: ({ messageId }) => ({ action: 'get_msg', params: { message_id: Number(messageId) } }),
  },
  {
    name: 'qq_group_history',
    description: '查群聊历史消息。想了解"刚才群里在聊什么"时用。',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        count: { type: 'number', description: '取多少条，默认 20' },
        messageId: { type: 'string', description: '从这个消息 id 往前取（可选）' },
      },
      required: ['groupId'],
    },
    build: ({ groupId, count, messageId }) => ({
      action: 'get_group_msg_history',
      params: {
        group_id: Number(groupId),
        count: Number(count ?? 20),
        ...(messageId ? { message_id: Number(messageId) } : {}),
      },
    }),
  },
  {
    name: 'qq_api',
    description:
      '直接调用任意 SnowLuma/OneBot 动作。当上面那些具名工具没覆盖你要做的事时用这个。' +
      '常见可用动作（不限于这些）：send_private_msg、send_group_msg、send_msg、' +
      'delete_msg、get_msg、get_group_list、get_friend_list、get_group_member_info、' +
      'get_group_member_list、get_group_msg_history、get_friend_msg_history、' +
      'get_forward_msg、group_poke、friend_poke、set_input_status、mark_msg_as_read、' +
      'set_msg_emoji_like、get_image、get_record、get_file、upload_group_file、' +
      'get_status、get_version_info、get_cookies、can_send_image、can_send_record。' +
      '如果动作名不存在，SnowLuma 会返回错误，届时换一个动作名即可。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'OneBot 动作名，例如 get_group_list' },
        params: { type: 'object', description: '该动作的参数对象' },
      },
      required: ['action'],
    },
    build: ({ action, params }) => ({ action: String(action), params: params ?? {} }),
  },
]

// ── 运行时状态 ────────────────────────────────────────────────────────────
let config = null

const log = (...a) => process.stderr.write('[mcp-qq] ' + a.join(' ') + '\n')

/** stdio 上只跑协议帧，日志一律走 stderr（与 DSH 自己的约定一致）。 */
function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n')
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

/** 调 SnowLuma 的 OneBot HTTP API。 */
async function callOneBot(action, params = {}) {
  const url = `${config.httpUrl.replace(/\/+$/, '')}/${action}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 20_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.httpToken ? { authorization: `Bearer ${config.httpToken}` } : {}),
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    })
    const text = await res.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, error: `返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}` }
    }
    const ok = body.status === 'ok' || body.retcode === 0
    if (!ok) {
      return {
        ok: false,
        error: `动作 ${action} 失败：retcode=${body.retcode ?? '?'} ${body.wording ?? body.msg ?? ''}`.trim(),
      }
    }
    return { ok: true, data: body.data ?? null }
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, error: `动作 ${action} 超时` }
    }
    return { ok: false, error: `动作 ${action} 请求失败：${error.message}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 执行一个工具调用，返回 MCP 的 content 数组。 */
async function runTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return { isError: true, text: `没有这个工具：${name}` }

  let built
  try {
    built = tool.build(args ?? {})
  } catch (error) {
    return { isError: true, text: `参数不对：${error.message}` }
  }

  // ★ 黑名单拦截
  const blockedReason = BLOCKED_ACTIONS[built.action]
  if (blockedReason) {
    return {
      isError: true,
      text:
        `我这边把这个动作禁用了：${built.action}（${blockedReason}）。\n` +
        `如果确实需要，请让使用者在配置里放开 —— 我不会自己绕过这条限制。`,
    }
  }

  const result = await callOneBot(built.action, built.params)
  if (!result.ok) return { isError: true, text: result.error }

  // 结果可能很大（群成员列表能到几百条），截断以免把上下文塞爆
  let payload = JSON.stringify(result.data)
  if (payload.length > 8000) payload = payload.slice(0, 8000) + `…（已截断，共 ${payload.length} 字符）`
  return { isError: false, text: `${built.action} 成功：${payload}` }
}

// ── JSON-RPC 主循环 ───────────────────────────────────────────────────────
async function handle(frame) {
  const { id, method, params } = frame ?? {}
  if (id === undefined) return // 通知，不需要应答

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })

    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      log(`tools/call ${name} ${JSON.stringify(args).slice(0, 200)}`)
      const out = await runTool(name, args)
      return reply(id, { content: [{ type: 'text', text: out.text }], isError: out.isError === true })
    }

    // MCP 里可选的探活；给了不会有害
    case 'ping':
      return reply(id, {})

    default:
      return replyError(id, -32601, `未实现的方法：${method}`)
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────────
function loadConfig() {
  const i = process.argv.indexOf('--config')
  const path = i >= 0 ? process.argv[i + 1] : null
  if (!path) throw new Error('需要 --config <文件> 参数（由桥接生成）')
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (!parsed.httpUrl) throw new Error('配置文件缺少 httpUrl')
  return parsed
}

try {
  config = loadConfig()
} catch (error) {
  log(`配置加载失败：${error.message}`)
  process.exit(1)
}

log(`已启动，OneBot 端点 ${config.httpUrl}，工具 ${TOOLS.length} 个，黑名单 ${Object.keys(BLOCKED_ACTIONS).length} 项`)

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
  handle(frame).catch((error) => {
    log(`处理出错：${error?.message ?? error}`)
    if (frame?.id !== undefined) replyError(frame.id, -32603, String(error?.message ?? error))
  })
})
rl.on('close', () => {
  log('stdin 关闭，退出')
  process.exit(0)
})
