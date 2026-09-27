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
 * 安全策略：**具名工具用黑名单；`qq_api` 用白名单**（0.2.3 起，见下）
 * ══════════════════════════════════════════════════════════════════════════
 * 需求是"能调用所有 SnowLuma 中的 QQ 功能"，所以对**具名工具**用枚举不完 ——
 * 那些工具的动作是写死的，所以用**动作黑名单**：默认放行，只拦"会伤害他人或账号"
 * 的动作（踢人、禁言、删好友、退群、改名片、批量操作…）。
 *
 * ★★ **但 `qq_api` 不一样**：它的 action 是**模型自选的任意字符串**，
 *    对它就等于"默认放行一切"。实测漏过两个高危动作（`get_cookies` = 账号网页凭据、
 *    `upload_group_file` = 一条把本机文件外发的通道）—— 详见 `ALLOWED_API_ACTIONS`
 *    的说明。所以那个口是**只读白名单**（fail-closed）：不在清单里的动作一律拒。
 *
 * ∴ 一句话：**能穷举的用黑名单，不能穷举的用白名单。**
 *
 * 用法：由 DSH 的 MCP 客户端拉起（stdio）。
 *   node mcp-qq-server.mjs --config <mcp-qq.config.json>
 * 配置文件由桥接在启动时生成（含端点与 token）。
 */

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

// ── 协议版本：与 @modelcontextprotocol/sdk 的 stdio 服务端约定一致 ────────
const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'qq-bridge-qq-tools', version: '0.2.5' }

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

/**
 * `qq_api`（万能口）允许的动作 —— **白名单**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么从"黑名单"改成"白名单"（2026-09-27 实测漏洞）
 * ══════════════════════════════════════════════════════════════════════════
 * 原先只有 `BLOCKED_ACTIONS` 这张**黑名单**。对**具名工具**它够用（动作是写死的），
 * 但 `qq_api` 的 action 是**模型自选的任意字符串** —— 对它来说黑名单就是全部防线，
 * 而黑名单天然只拦得住"想得到的"。
 *
 * 实测的漏网：`get_cookies` 与 `upload_group_file` **在描述里被广告给模型**，
 * 却**都不在黑名单里** —— 前者是账号网页凭据（Cookie），后者是一条把本机文件外发的通道。
 * 这不是"忘了加两条"，是**方向错了**：未知的危险动作会永远漏过去。
 * 所以改成白名单：**没列出的一律拒绝**（fail-closed）。
 *
 * ── 为什么"发送类"一律不放行 ────────────────────────────────────────────
 * `send_private_msg` / `send_group_msg` / `send_msg` 看着无害，但**它们是绕过**：
 * 桥接的回复要经过 分条 → 拟人延迟 → 三道节流 → 投递前终检门 → 投递账本；
 * 从 `qq_api` 直发会**跳过全部这些**（包括账号风控相关的节流）。
 * 要发文字就让模型正常回复，要发图用 `qq_send_image`（它自己下载 + 守卫 + base64）。
 * 同理不放行 `delete_*` / `set_*` / `upload_*`。
 *
 * 这一条**不可关**：它是边界，不是功能（同 src/plugins.mjs 的三条纪律口径）。
 */
const ALLOWED_API_ACTIONS = new Set([
  // 只读查询
  'get_status',
  'get_version_info',
  'get_group_list',
  'get_friend_list',
  'get_group_info',
  'get_group_member_info',
  'get_group_member_list',
  'get_group_msg_history',
  'get_friend_msg_history',
  'get_forward_msg',
  // 取媒体（下载与守卫都在宿主这一侧做，本身不产生对外副作用）
  'get_image',
  'get_record',
  'get_file',
  // 能力探测
  'can_send_image',
  'can_send_record',
])

// ── 工具定义（写给模型的说明；措辞直接影响它用不用、怎么用） ─────────────
//
// ★★ H14：**批量注入的提示**（不每个 docstring 重写一遍，避免漂移）
//
// 为什么必须写进**工具描述**而不是只写在提示词里：模型的工具表是它决定"调不调"的
// 直接依据，而人设/权限段离得很远。两类提示各管一件事：
//   · `ADMIN_ONLY_HINT`：**权限**。普通用户是只读的，而工具本身不区分调用者 ——
//     所以要在描述里说清"这是管理员才能做的事，对方不是管理员时别做，直说做不了"。
//   · `HONESTY_HINT`：**如实**。工具返回失败就是没做成；本项目第 6 条铁律是
//     "失败必须让用户知道"，而模型最常见的失败模式恰恰是——调用失败了还回"好的已经做了"。
//
// ⚠️ 判据是每个工具自带的 `adminOnly` 标记，不是靠名字猜（`qq_api` 是万能口，
//    必须算写入侧；`qq_search_history` 只读，不该被限制）。
const ADMIN_ONLY_HINT =
  '【权限】这是**写入/互动类**动作，只有管理员可以让我做。' +
  '如果当前说话的人不是管理员，就直说"这个我做不了"，不要偷偷做、也不要假装做过。'
const READONLY_HINT =
  '【权限】只读动作，普通用户也可以用（但**不能**用它读取与他无关的会话内容）。'
const HONESTY_HINT =
  '【如实】这个工具返回失败就是**没做成** —— 照实说失败原因，不要回"好的已经做了"。'

/** 把提示拼进描述（`tools/list` 时统一应用，保证不会漏掉某个工具）。 */
function described(tool) {
  const hints = `${tool.adminOnly ? ADMIN_ONLY_HINT : READONLY_HINT}${HONESTY_HINT}`
  return `${tool.description}\n${hints}`
}

const TOOLS = [
  {
    name: 'qq_poke',
    adminOnly: true,
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
    adminOnly: true,
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
    // ★ 0.2.2：**把图片真的发到会话里**（这是第三方技能能不能"发图"的关键一环）。
    //
    // ── 为什么不是把 URL 直接交给协议端 ────────────────────────────────────
    // OneBot 的 `image` 段确实可以填 URL，协议端会自己去取。那样做有三个问题：
    //   ① SSRF 面转移到了一个我们管不到的进程（它可能在内网、可能没有守卫）；
    //   ② 防盗链：i.pximg.net 要带 Referer，协议端不会带，必然 403；
    //   ③ 失败原因回不来（协议端只会说"发送失败"），模型没法如实解释。
    // 所以这里**自己下载、自己校验、自己带 Referer**，再以 base64 交给协议端。
    //
    // 守卫（src/images.mjs）：只 http/https、逐跳校验重定向、按内容嗅探类型、
    // 大小/超时封顶；**内网/回环地址默认拒绝**，除非管理员打开了
    // `security.allowPrivateImageHosts`（pixiv 类技能的"本地图片桥"直链就是这个场景）。
    // 这条判断**每次调用现读 config.json**，所以界面上改完立刻生效。
    name: 'qq_send_image',
    adminOnly: true,
    description:
      '把一张**图片**发到指定会话里（不是发链接，是真的发图）。' +
      'url 可以是公网图片直链，也可以是本机/内网地址（需要在配置里打开「允许下载内网/本机图片地址」）。' +
      '★ 必须显式给出 kind 与 peerId（就是当前会话，见你这轮的来源标注）—— 不能跨会话发图。' +
      '★ 图中的文字说明用 caption；只有图不想说话就别写 caption。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片地址（http/https；也可以用 i.pximg.net 之外的直链）' },
        kind: { type: 'string', enum: ['private', 'group'], description: '会话类型（必填）' },
        peerId: { type: 'string', description: '群号或 QQ 号（必填，就是来源标注里那串号码）' },
        caption: { type: 'string', description: '随图发的一句话（可选）' },
      },
      required: ['url', 'kind', 'peerId'],
    },
    // 自己下载 + 组装图片段，不走通用的 build（见 runTool 的特判）
    local: 'sendImage',
  },
  {
    name: 'qq_recall',
    adminOnly: true,
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
    adminOnly: false,
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
    adminOnly: false,
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
    adminOnly: false,
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
    // ★ H7：**本地语料库检索**（不是问协议端要历史，而是搜桥接自己落的库）
    //
    // 与 `qq_group_history` 的分工：那个是"现拉最近 N 条"（实时、不能检索、
    // 协议端一重启就没了）；这个是"用关键词搜过去"（本地、有索引、带 mid）。
    //
    // ⚠️ **必须显式指定会话**（kind + peerId）：语料库里存着所有人所有会话的消息，
    //    不带会话过滤就等于把别的群/别人的私聊内容读进当前上下文 ——
    //    模型再顺口说出来就是**跨会话泄露**。所以缺参数时**拒绝执行**（fail-closed），
    //    而不是"默认搜全部"。
    name: 'qq_search_history',
    adminOnly: false,
    description:
      '在本机保存的聊天记录里**用关键词搜索过去说过的话**（支持中文与英文）。' +
      '想引用搜到的某条消息时，用它给出的 [mid:数字] 写 `[reply:数字]`。' +
      '★ 必须显式给出 kind 与 peerId（就是当前会话的来源标注里那串号码）—— ' +
      '不能跨会话搜索。' +
      '★ **不许编造消息 id**：只能引用这个工具真的返回过的 mid；编的 id 不会生效。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜的关键词（中文/英文都行；越具体越好）' },
        kind: { type: 'string', enum: ['private', 'group'], description: '会话类型（必填）' },
        peerId: { type: 'string', description: 'QQ 号或群号（必填，就是来源标注里那个号码）' },
        limit: { type: 'number', description: '最多返回几条（默认 8，上限 100）' },
      },
      required: ['query', 'kind', 'peerId'],
    },
    // 这个工具**不走 OneBot**，在本地读语料库（见 handle() 里的特判）
    local: 'corpus',
  },
  {
    // ★ H14：**轻量社交**。真人之间的"给这条消息点个赞/贴个表情回应"——
    //   比回一句话更省、更不打扰，适合"看到了，表示一下"的场合。
    //   ⚠️ 动作名 `set_msg_emoji_like` 是**真机探针验过的**（见 mocks/probe-onebot-actions.mjs）：
    //      空参调用返回 `message_id: is required`，说明动作存在、只是缺参数。
    name: 'qq_emoji_like',
    adminOnly: true,
    description:
      '给某条消息贴一个 QQ 表情回应（就是手机 QQ 长按消息的那个"表情回应"）。' +
      '适合"看到了、表示一下"的场合，比回一句话更轻。' +
      'emojiId 不填就是默认的点赞（128077）。',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: '要回应的消息 id' },
        emojiId: { type: 'string', description: '表情 id（默认 128077 = 👍）' },
      },
      required: ['messageId'],
    },
    build: ({ messageId, emojiId }) => ({
      action: 'set_msg_emoji_like',
      params: { message_id: Number(messageId), emoji_id: String(emojiId ?? '128077'), set: true },
    }),
  },
  {
    // ★ H14：**"正在输入"**。拟人节奏的一部分：长篇回复前先让对方看到"它在打字"。
    //   ⚠️ 慎用：这是**状态类**动作，频繁调用没有意义（真人也不会一直显示正在输入）。
    name: 'qq_typing',
    adminOnly: false,
    description:
      '把"对方正在输入"的状态打开一会儿（就是 QQ 里那个"正在输入…"）。' +
      '只在你要花一段时间才回得出话时用一次，别反复调。',
    inputSchema: {
      type: 'object',
      properties: {
        peerId: { type: 'string', description: '目标 QQ 号' },
        eventType: { type: 'number', description: '1 = 正在输入（默认）' },
      },
      required: ['peerId'],
    },
    build: ({ peerId, eventType }) => ({
      action: 'set_input_status',
      params: { user_id: Number(peerId), event_type: Number(eventType ?? 1) },
    }),
  },
  {
    // ★ H14：**人设化转述转发**。
    //
    // 两件事分开做（而不是硬塞进一条消息里）：先**转发原消息**（对方能看到原文，
    // 不用信我的转述），再补一句 `note` 作为我自己的话 —— 这样"我说的"和
    // "原文说的"在聊天里是分开的两条，不会被当成同一句话。
    // ⚠️ 动作名 `forward_friend_single_msg` / `forward_group_single_msg` 也是**探针验过的**。
    name: 'qq_forward_msg',
    adminOnly: true,
    description:
      '把**某一条消息**转发给某人/某个群（转发的是原文，不是我的转述）。' +
      '可以在转发之后补一句 note 作为你自己的话（写你想说的话，别复述原文）。' +
      '注意：转发会把**别人说的话**搬给第三方看 —— 只在确实合适时用。',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: '要转发的消息 id' },
        toId: { type: 'string', description: '转发给谁：QQ 号或群号' },
        toKind: { type: 'string', enum: ['private', 'group'], description: '目标是私聊还是群' },
        note: { type: 'string', description: '转发之后你自己补的一句话（可选）' },
      },
      required: ['messageId', 'toId', 'toKind'],
    },
    build: ({ messageId, toId, toKind }) => ({
      action: toKind === 'group' ? 'forward_group_single_msg' : 'forward_friend_single_msg',
      params: {
        message_id: Number(messageId),
        [toKind === 'group' ? 'group_id' : 'user_id']: Number(toId),
      },
    }),
    // 转发之后的 `note` 要**另发一条**，所以这个工具需要多步（见 runTool 的特判）
    followUp: ({ toId, toKind, note }) =>
      note && String(note).trim()
        ? {
            action: toKind === 'group' ? 'send_group_msg' : 'send_private_msg',
            params: {
              [toKind === 'group' ? 'group_id' : 'user_id']: Number(toId),
              message: [{ type: 'text', data: { text: String(note).trim() } }],
            },
          }
        : null,
  },
  {
    // ★ H14：**把搜到的历史打包成"合并转发"发出去**（配合 H7 语料库）。
    //
    // 与 `qq_forward_msg` 的区别：那个转发**一条**消息，这个把**多条**合成一个
    // "聊天记录"卡片 —— 适合"上次大家讨论的那几条，我给你打包"。
    // ★ 它**只从本会话的本地语料库**取（fail-closed：kind + peerId 必填），
    //   所以不会把别的群/别人的私聊内容打包发出去。
    name: 'qq_forward_log',
    adminOnly: true,
    description:
      '把本会话里搜到的若干条历史消息**打包成一张"聊天记录"卡片**发给某人/某个群。' +
      '适合"上次讨论的那几条，我给你打包过去"。' +
      '★ 必须给出本会话的 kind 与 peerId（来源标注里那串号码）—— 只打包本会话的内容。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '用关键词挑要打包的消息' },
        kind: { type: 'string', enum: ['private', 'group'], description: '本会话类型（必填）' },
        peerId: { type: 'string', description: '本会话号码（必填）' },
        toId: { type: 'string', description: '发给谁：QQ 号或群号' },
        toKind: { type: 'string', enum: ['private', 'group'], description: '目标是私聊还是群' },
        limit: { type: 'number', description: '最多打包几条（默认 10，上限 20）' },
      },
      required: ['query', 'kind', 'peerId', 'toId', 'toKind'],
    },
    local: 'forwardLog',
  },
  {
    name: 'qq_at_all_remain',
    adminOnly: false,
    description: '查某个群今天还能 @全体成员 几次（群主/管理员才有这个额度）。',
    inputSchema: {
      type: 'object',
      properties: { groupId: { type: 'string', description: '群号' } },
      required: ['groupId'],
    },
    build: ({ groupId }) => ({ action: 'get_group_at_all_remain', params: { group_id: Number(groupId) } }),
  },
  {
    name: 'qq_api',
    adminOnly: true,
    generic: true,
    description:
      '直接调用 SnowLuma/OneBot 的**只读**动作。当上面那些具名工具没覆盖你要查的东西时用这个。' +
      '允许的动作（**白名单，没列出的一律会被拒绝**）：get_status、get_version_info、' +
      'get_group_list、get_friend_list、get_group_info、get_group_member_info、' +
      'get_group_member_list、get_group_msg_history、get_friend_msg_history、get_forward_msg、' +
      'get_image、get_record、get_file、can_send_image、can_send_record。' +
      '⚠️ 发送类动作（send_private_msg / send_group_msg / send_msg / delete_msg / upload_group_file…）' +
      '**不在这里面、也不会放行** —— 要说话就直接回复，要发图用 qq_send_image。' +
      '如果动作名不在白名单里，工具会明确告诉你"不在允许清单里"，换一个已列出的动作即可。',
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

/**
 * 本地语料库检索（H7）。
 *
 * ⚠️ **fail-closed**：`kind` 与 `peerId` 缺一不可 —— 语料库里存着**所有**会话的消息，
 *    不带会话过滤就等于把别的群/别人的私聊读进当前上下文，模型再顺口说出来
 *    就是**跨会话泄露**。所以缺参数时**拒绝执行**，而不是"默认搜全部"。
 */
async function runCorpusSearch({ query, kind, peerId, limit } = {}) {  if (!config?.workspace) {
    return { isError: true, text: '这条路走不通：桥接没有把工作区告诉这个工具（H7 的配置没生效）。' }
  }
  const k = String(kind ?? '').trim()
  const peer = String(peerId ?? '').trim()
  const q = String(query ?? '').trim()
  if (!q) return { isError: true, text: '要搜什么？把关键词给我（query）。' }
  if ((k !== 'private' && k !== 'group') || !peer) {
    return {
      isError: true,
      text:
        '搜历史**必须指定会话**（kind 用 private/group，peerId 用 QQ 号或群号，' +
        '就是你这轮来源标注里那串数字）—— 我不能跨会话搜索，那是别人的隐私。',
    }
  }
  try {
    // 只读打开：桥接是唯一写入方，工具进程只读（避免两个进程同时写同一个库）
    const { createCorpus, renderSearchResults } = await import('../src/corpus.mjs')
    const c = createCorpus({ workspace: config.workspace, readOnly: true, log: () => {} })
    const r = c.search({ query: q, chatKey: `${k}:${peer}`, limit: limit ?? 8 })
    c.close()
    if (!r.ok) return { isError: true, text: `搜不了：${r.why ?? '语料库不可用'}` }
    if (r.rows.length === 0) {
      return { isError: false, text: `本会话里没有搜到「${q}」。（也可能这条消息早于语料库启用，或者已经被 30 天 TTL 清掉了。）` }
    }
    return { isError: false, text: renderSearchResults({ rows: r.rows, query: q, mode: r.mode }) }
  } catch (error) {
    return { isError: true, text: `搜历史时出错：${error?.message ?? error}` }
  }
}

/** 动态加载语料库模块的旧入口（已改为 `await import`，保留是为了不改变调用方形状）。 */

/* ────────────────────────────────────────────────────────────────────────
 * 0.2.2：发图（qq_send_image）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 单张**发出**的图片字节上限（默认 8MB）。
 *
 * 为什么比入站那个 `image.maxBytes`（10MB）更小：入站是下载到本地磁盘，
 * 出站要把图 **base64 之后塞进一次 HTTP 请求体**（体积 ×1.34），而协议端的
 * 请求体上限不由我们决定。所以这里再压一道，并且与 `image.maxBytes` 取**更小**的那个。
 */
const SEND_IMAGE_MAX_BYTES = 8 * 1024 * 1024

/**
 * 现读 config.json（**不缓存**）。
 *
 * 为什么要现读：`security.allowPrivateImageHosts` 是"随时开关"的一部分 ——
 * 缓存在进程里就意味着"界面上打开了，还得重启桥接才生效"，而那正是这一版要消灭的毛病。
 * 读不到（文件没有 / 被改坏）时返回 null，调用方按**保守**处理（不放行内网、用默认上限）。
 */
function readLiveConfig() {
  if (!config?.configPath) return null
  try {
    // 去 BOM：文件是桥接生成的（无 BOM），但手工用记事本改过就会带上，而
    // `JSON.parse` 遇 BOM 直接抛 —— 表现成"界面上打开了这个开关却没生效"。
    return JSON.parse(readFileSync(config.configPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/**
 * ★ 0.2.2：把一张图片**真的发进会话**。
 *
 * 三步，每一步的失败都要能翻译成"人能看懂、且知道下一步怎么办"的中文：
 *   ① 守卫放行？→ 内网地址被拒时要**明确说清是哪个开关**（否则使用者只会看到"下载失败"）
 *   ② 取回来的是不是真图片？（按内容嗅探，不信 Content-Type）
 *   ③ 协议端收不收？（base64 段，避免把 URL 交给另一个进程去取）
 */
async function runSendImage({ url, kind, peerId, caption } = {}) {
  const u = String(url ?? '').trim()
  const k = String(kind ?? '').trim()
  const peer = String(peerId ?? '').trim()
  const cap = String(caption ?? '').trim()

  if (!u) return { isError: true, text: '要发哪张图？把图片地址给我（url）。' }
  // ★ fail-closed：与 qq_search_history / qq_forward_log 同一条纪律 ——
  //   会话必须显式给出，否则我可能把图发到别人的会话里（那是不可挽回的）。
  if ((k !== 'private' && k !== 'group') || !peer) {
    return {
      isError: true,
      text:
        '发图**必须指定会话**（kind 用 private/group，peerId 用 QQ 号或群号，' +
        '就是你这轮来源标注里那串数字）—— 我不会往不确定的会话里发东西。',
    }
  }

  let images
  try {
    images = await import('../src/images.mjs')
  } catch (error) {
    return { isError: true, text: `发图能力不可用（模块加载失败）：${error?.message ?? error}` }
  }

  const live = readLiveConfig()
  const allowPrivate = live?.security?.allowPrivateImageHosts === true
  const cfgMax = Number(live?.image?.maxBytes)
  const maxBytes = Math.min(Number.isFinite(cfgMax) && cfgMax > 0 ? cfgMax : images.DEFAULT_MAX_BYTES, SEND_IMAGE_MAX_BYTES)
  const cfgTimeout = Number(live?.image?.timeoutMs)

  const got = await images.fetchImageBytes(u, {
    allowPrivateHosts: allowPrivate,
    maxBytes,
    timeoutMs: Number.isFinite(cfgTimeout) && cfgTimeout > 0 ? cfgTimeout : images.DEFAULT_TIMEOUT_MS,
  })
  if (!got.ok) {
    // ★ "怎么办"必须写在报错里：被守卫拦下是最容易误判成网络故障的一种失败。
    const isGuard = /内网|回环|localhost/i.test(got.reason)
    const hint = isGuard && !allowPrivate
      ? '（这是本机/内网的图片地址，被安全设置挡住了：需要在**控制台 → 扩展 → 给扩展用的安全开关**里打开「允许下载内网/本机图片地址」）'
      : ''
    return { isError: true, text: `图没发出去：${got.reason}${hint}` }
  }

  const media = images.sniffImageMediaType(got.bytes)
  if (!media) {
    return {
      isError: true,
      text: '那个地址返回的不是支持的图片（只认 PNG/JPEG/WebP/GIF）—— 检查一下直链是不是过期或指向了网页。',
    }
  }

  const message = []
  if (cap) message.push({ type: 'text', data: { text: cap } })
  message.push({ type: 'image', data: { file: `base64://${Buffer.from(got.bytes).toString('base64')}` } })

  const sent = await callOneBot(k === 'group' ? 'send_group_msg' : 'send_private_msg', {
    [k === 'group' ? 'group_id' : 'user_id']: Number(peer),
    message,
  })
  if (!sent.ok) {
    return { isError: true, text: `图取回来了，但**发送失败**：${sent.error}` }
  }
  return {
    isError: false,
    text: `已发图（${media}，${Math.round(got.bytes.byteLength / 1024)} KB）${cap ? '，附了一句话' : ''}。`,
  }
}

/**
 * ★ H14：把本会话搜到的历史打包成一张"合并转发"卡片发出去。
 *
 * 两条纪律：
 *   ① **只从本会话的本地语料库取**（`kind` + `peerId` 必填）—— 否则就是把
 *      别的群/别人的私聊打包发给第三方，那是不可挽回的泄露；
 *   ② 节点条数**夹到上限**（默认 10、最多 20）：合并转发卡片塞几百条没人看，
 *      而且会撑爆协议端的请求体。
 */
async function runForwardLog({ query, kind, peerId, toId, toKind, limit } = {}) {
  if (!config?.workspace) {
    return { isError: true, text: '这条路走不通：桥接没有把工作区告诉这个工具（H7 的配置没生效）。' }
  }
  const k = String(kind ?? '').trim()
  const peer = String(peerId ?? '').trim()
  const q = String(query ?? '').trim()
  const tId = String(toId ?? '').trim()
  const tKind = String(toKind ?? '').trim()
  if (!q) return { isError: true, text: '要用什么关键词挑消息？把 query 给我。' }
  if ((k !== 'private' && k !== 'group') || !peer) {
    return {
      isError: true,
      text: '打包历史**必须指定本会话**（kind 用 private/group，peerId 用来源标注里那串号码）—— 我不能把别的会话的内容打包出去。',
    }
  }
  if ((tKind !== 'private' && tKind !== 'group') || !tId) {
    return { isError: true, text: '要发给谁？toId 与 toKind（private/group）都要给。' }
  }
  const cap = Math.min(20, Math.max(1, Number(limit) || 10))
  try {
    const { createCorpus } = await import('../src/corpus.mjs')
    const c = createCorpus({ workspace: config.workspace, readOnly: true, log: () => {} })
    const r = c.search({ query: q, chatKey: `${k}:${peer}`, limit: cap })
    c.close()
    if (!r.ok) return { isError: true, text: `搜不了：${r.why ?? '语料库不可用'}` }
    if (!r.rows?.length) {
      return { isError: false, text: `本会话里没有搜到「${q}」，所以没有打包任何东西。` }
    }
    const nodes = r.rows.slice(0, cap).map((row) => ({
      type: 'node',
      data: {
        // 合并转发卡片里的"谁说的"：语料库有人名就用人名，没有就用号码
        name: String(row.senderName ?? row.senderId ?? (row.isBot ? '我' : '某人')),
        uin: String(row.senderId ?? config.selfId ?? '0'),
        content: String(row.text ?? '').slice(0, 500),
      },
    }))
    const sent = await callOneBot('send_forward_msg', {
      [tKind === 'group' ? 'group_id' : 'user_id']: Number(tId),
      message_type: tKind,
      messages: nodes,
    })
    if (!sent.ok) return { isError: true, text: `打包发送失败：${sent.error}` }
    return { isError: false, text: `已把本会话里「${q}」相关的 ${nodes.length} 条打包发出去（合并转发）。` }
  } catch (error) {
    return { isError: true, text: `打包历史时出错：${error?.message ?? error}` }
  }
}

/** 当前档位下**对模型可见**的工具（`tools/list` 用它；`runTool` 也用它做 fail-closed 校验）。 */
function visibleTools() {
  const readonly = config?.profile === 'readonly'
  return TOOLS.filter((t) => {
    if (t.generic && config?.genericApi === false) return false
    if (readonly && t.adminOnly) return false
    return true
  })
}

/** 执行一个工具调用，返回 MCP 的 content 数组。 */
async function runTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return { isError: true, text: `没有这个工具：${name}` }
  // ★ fail-closed：被档位隐藏的工具，**即使被直接调用也要拒**。
  //   只过滤 `tools/list` 是不够的 —— 模型（或任何本地进程）可以照旧按名字调用。
  if (!visibleTools().includes(tool)) {
    return {
      isError: true,
      text: `工具 ${name} 在当前档位下不可用（控制台 →「扩展」→ QQ 原生功能 里可调整档位）。`,
    }
  }

  // ── H7/H14：本地语料库（**不走 OneBot**，也不经过 build/黑名单那条路）──────
  //
  // ★ 0.2.3：语料库的开关在**分派这一层**统一拦，而不是在两个实现里各写一遍。
  //   理由有两个，第二个才是要紧的：
  //     ① 两个入口（`qq_search_history` / `qq_forward_log`）共用同一份库，
  //        守卫写两处必然有一天只改一处；
  //     ② ★ **fail-closed 的方向要选对**：关掉之后必须回"**被关掉了**"，
  //        绝不能回"没搜到" —— 后者会被模型转述成"语料库里没有这条记录"，
  //        那是一句**谎话**（本项目最忌讳的"说了做不到"）。
  //
  //   `readLiveConfig()` 是**每次调用现读** config.json 的，所以这个开关是
  //   真正的"随时开关"（与技能的开关同一条纪律，见文件头）。
  //   读不到配置（文件被删/写坏）时**按"开着"处理** —— 方向与 `runSendImage`
  //   那边的保守相反，因为这里是**只读**的：误判成"关"会让模型平白说一句
  //   "我搜不了"，而误判成"开"最多是照常查一次本地库。
  if (tool.local === 'corpus' || tool.local === 'forwardLog') {
    const live = readLiveConfig()
    if (live?.corpus?.enabled === false) {
      return {
        isError: true,
        text:
          `本地语料库被关掉了（配置里 corpus.enabled = false），所以现在${tool.local === 'corpus' ? '搜不了' : '打包不了'}历史。` +
          '★ 请**如实告诉对方你查不了**，不要凭印象编，也不要说"没有这条记录"。',
      }
    }
    if (tool.local === 'corpus') return runCorpusSearch(args ?? {})
    return runForwardLog(args ?? {})
  }
  // ── 0.2.2：发图（自己下载 + 守卫 + base64 段）────────────────────────────
  if (tool.local === 'sendImage') return runSendImage(args ?? {})

  let built
  try {
    built = tool.build(args ?? {})
  } catch (error) {
    return { isError: true, text: `参数不对：${error.message}` }
  }

  // ★★ 两道闸，顺序固定（2026-09-27 起）：
  //   ① 万能口 `qq_api` 走**白名单**（fail-closed）：没列出的一律拒。
  //      这是修掉实测漏洞的那一步 —— 详见 ALLOWED_API_ACTIONS 的说明。
  //   ② 黑名单**保留**作为第二层：具名工具的动作是写死的，但黑名单能挡住
  //      "某个具名工具日后被改成危险动作"这类回归。
  if (tool.generic && !ALLOWED_API_ACTIONS.has(built.action)) {
    return {
      isError: true,
      text:
        `这个动作不在允许清单里：${built.action}。\n` +
        `qq_api 只放行**只读**动作（查群/好友/成员/历史、取媒体、能力探测）。\n` +
        `要发消息就直接回复、要发图就用 qq_send_image —— 它们会走完整的投递链` +
        `（分条 / 拟人节奏 / 节流 / 投递前终检门），而从 qq_api 直发会**绕过全部这些**。`,
    }
  }

  const blockedReason = BLOCKED_ACTIONS[built.action]
  if (blockedReason) {
    return {
      isError: true,
      text: `我这边把这个动作禁用了：${built.action}（${blockedReason}）。我不会自己绕过这条限制。`,
    }
  }

  const result = await callOneBot(built.action, built.params)
  if (!result.ok) return { isError: true, text: result.error }

  // ★ H14：有些动作是**多步**的（转发之后补一句 note）。第二步失败**必须说出来** ——
  //   否则"转发成功了但我的话没发出去"会看起来像"我说了那句话"。
  let followUpNote = ''
  if (typeof tool.followUp === 'function') {
    try {
      const second = tool.followUp(args ?? {})
      if (second) {
        const r2 = await callOneBot(second.action, second.params)
        followUpNote = r2.ok ? '' : `\n⚠️ 但后面那句补充的话**没发出去**：${r2.error}`
      }
    } catch (error) {
      followUpNote = `\n⚠️ 但后面那句补充的话**没发出去**：${error?.message ?? error}`
    }
  }

  // 结果可能很大（群成员列表能到几百条），截断以免把上下文塞爆
  let payload = JSON.stringify(result.data)
  if (payload.length > 8000) payload = payload.slice(0, 8000) + `…（已截断，共 ${payload.length} 字符）`
  return { isError: false, text: `${built.action} 成功：${payload}${followUpNote}` }
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
        // ★ 用 visibleTools()：档位（readonly / 通用口）在这里生效
        tools: visibleTools().map((t) => ({
          name: t.name,
          // ★ H14：描述统一经 `described()` 拼上权限提示与"如实"提示 ——
          //   写在这里而不是每个工具手抄一遍，避免漏掉某个工具、也避免两处措辞漂移。
          description: described(t),
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

/** 给测试用：直接塞一份配置（不读文件、不启动主循环）。 */
export function __setConfig(cfg) {
  config = cfg
}

/** 启动主循环（DSH 以脚本方式拉起时走这里）。 */
function startServer() {
  try {
    config = loadConfig()
  } catch (error) {
    log(`配置加载失败：${error.message}`)
    process.exit(1)
  }

  log(
    `已启动，OneBot 端点 ${config.httpUrl}，工具 ${TOOLS.length} 个，` +
      // ★ 两个数都要报：只报黑名单会让人以为 `qq_api` 是"默认放行"的口，
      //   而它现在恰恰是**最严**的那一层（只读白名单）。这两个数字合起来才是真实防线。
      `黑名单 ${Object.keys(BLOCKED_ACTIONS).length} 项、qq_api 只读白名单 ${ALLOWED_API_ACTIONS.size} 项` +
      `（档位 ${config.profile ?? 'full'}）`,
  )

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
}

// ★★ 只有**被当作脚本直接拉起**时才启动主循环。
//
// 为什么加这个判断：DSH 是以脚本方式 spawn 本文件的（那才是生产路径），
// 但"能被 import"让工具定义、提示拼接、参数构造这些**纯逻辑**可以在
// **不需要子进程**的环境里被测到 —— 本项目实测过：受限沙箱里带管道的 spawn 会 EPERM，
// 于是 `verify-mcp.mjs` 只能整份跳过（跳过不算通过）。把纯逻辑与启动分开之后，
// 那一半至少永远测得到。生产路径**一个字都没变**。
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) startServer()

export { TOOLS, BLOCKED_ACTIONS, described, runTool, runCorpusSearch, runForwardLog, runSendImage, readLiveConfig }
