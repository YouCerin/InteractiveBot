#!/usr/bin/env node
/**
 * 身份核实（"这条消息是谁发的"）的测试。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这个文件必须存在
 * ══════════════════════════════════════════════════════════════════════════
 * 需求原话是"收到指令时验证对话者身份：私聊验证 QQ 号，群聊从 SnowLuma
 * 调用幻想者信息并核验是否为管理员，是则开放所有权限，否则禁止（例如
 * 透露记忆中的隐私）"。
 *
 * 这里面藏着**一个能把整台机器交出去的坑**：
 *   "群里的管理员"有两种解释 ——
 *     · 桥接配置里的 `adminUsers`（主人亲手配的人）
 *     · QQ 群里的 `owner` / `admin`（**任何群**的群主与群管理）
 *   如果按后者发权限，那么任何陌生人只要自己建个群、把机器人拉进去、
 *   给自己一个群管理，就拿到了 DSH 工作区的写权限。
 *
 * 所以这个套件盯的是**两件事必须同时成立**：
 *   ① 身份**真的从协议端查了**（昵称、群内角色），并同步进会话镜像；
 *   ② 身份**绝不参与权限判定** —— 查到"群管理"也不能变成管理员。
 *
 * 反过来说，如果哪天有人"顺手"把 role 接进了 `roster.decide()`，
 * 这个文件里的断言就会红 —— 这正是它存在的意义。
 *
 * ── 为什么不用真协议端 ───────────────────────────────────────────────────
 * 这里全部用**桩**（假 onebot + 假 rpc）。理由有两条：
 *   · 身份核实的失败路径（协议端查不到人）必须能稳定复现，
 *     真协议端上制造不出来；
 *   · 本仓库的运行环境里，**带管道的子进程会被拒绝**（EPERM），
 *     依赖 spawn 的套件跑不了。把这一层做成纯桩，它在任何环境都能跑，
 *     而且不需要花钱、不需要登录 QQ —— "跑不了就说跑不了"，
 *     能跑的就必须真跑。
 *
 * 用法：node mocks/verify-identity.mjs
 * 退出码 0 = 全部通过。
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { Bridge } from '../src/bridge.mjs'
import { SendQueue } from '../src/onebot.mjs'
import { SessionRouter } from '../src/session-bridge.mjs'
import { buildPermissionInstructions, createRoster } from '../src/roster.mjs'
import { PKG_ROOT } from '../src/local.mjs'

const WS = join(PKG_ROOT, '.tmp-verify-identity')

/**
 * 每个桥接用**自己的空工作区**。
 *
 * ⚠️ 为什么不能都指同一个目录（原先是 `join(PKG_ROOT, '.tmp-verify-identity')`）：
 * 那个路径在**包根下**，一旦测试崩在中间就会留下上次的 `MEMORY.md`，
 * 而下一次运行会把它当真实记忆注入提示词 —— 于是"某人的号码出现在提示词里"
 * 这条断言会被**上一轮的残留**弄红，而根因与被测代码毫无关系。
 * 每个用例一份干净目录，这类"假失败"就不可能发生。
 */
let wsSeq = 0
const createdDirs = []
function freshWorkspace() {
  const dir = `${WS}-${process.pid}-${++wsSeq}`
  rmSync(dir, { recursive: true, force: true })
  createdDirs.push(dir)
  return dir
}

const ADMIN = '100000001'
const NON_ADMIN = '100000002'
const STRANGER = '1999999999'
const GROUP = '700000002'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(title) {
  console.log(`\n── ${title} ──────────────────────────────`)
}

/**
 * 造一个桥接 + 桩协议端。
 *
 * @param {object} [opts]
 * @param {object} [opts.access]    覆盖名单配置
 * @param {object} [opts.member]    `get_group_member_info` 的返回值；
 *                                  传 `{ fail: '原因' }` 模拟协议端查不到
 * @param {string[]} [opts.friends] `get_friend_list` 返回的好友昵称表
 * @param {{fail?: string}} [opts.groups] `get_group_list` 的行为
 *        （`{fail:'原因'}` = 拿不到群名，用于验证"不编名字"）
 */
function makeBridge({ access = {}, member = null, friends = null, groups = null } = {}) {
  const WS = freshWorkspace()

  const router = new SessionRouter({ log: () => {} })
  const logs = []
  const log = (m) => logs.push(String(m))

  const config = {
    dsh: { workspace: WS, permissionMode: 'workspace-write' },
    onebot: {},
    access: { adminUsers: [ADMIN], dmAllowlist: [], groupAllowlist: [GROUP], ...access },
    trigger: { private: true, mention: true, keyword: true, groupEnabled: true, keywords: ['小鲸鱼'] },
    send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
    turn: { timeoutMs: 5000 },
    humanize: { enabled: false, chunkChars: 300 },
    persona: { preset: 'none' },
    // 记忆注入关掉：本套件测的是身份，不需要真读工作区里的记忆文件。
    memory: { enabled: false },
    image: { enabled: false },
  }

  const rpc = new EventTarget()
  rpc.calls = []
  rpc.prompt = async (sessionId, contentBlocks) => {
    rpc.calls.push({ sessionId, contentBlocks })
    router.handleEvent(sessionId, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '好的' }] } },
    })
    router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
    return { messageId: 'm1' }
  }

  // 桩 OneBot：记录每一次 action，供"到底查了没有"的断言使用。
  const onebot = new EventTarget()
  onebot.selfId = '200000001'
  onebot.calls = []
  const memberTable = {
    [ADMIN]: { nickname: '管理员', card: '群主大人', role: 'owner' },
    [NON_ADMIN]: { nickname: '路人甲', card: '甲甲', role: 'admin' },
    [STRANGER]: { nickname: '陌生人', card: '', role: 'member' },
  }
  onebot.call = async (action, params, timeoutMs) => {
    onebot.calls.push({ action, params, timeoutMs })
    if (action === 'get_group_member_info') {
      if (member?.fail) throw new Error(String(member.fail))
      const hit = memberTable[String(params?.user_id ?? '')] ?? {}
      return { status: 'ok', retcode: 0, data: { user_id: Number(params?.user_id ?? 0), ...hit } }
    }
    if (action === 'get_friend_list') {
      const list = friends ?? [{ user_id: Number(ADMIN), nickname: '主人' }]
      return { status: 'ok', retcode: 0, data: list }
    }
    if (action === 'get_group_list') {
      if (groups?.fail) throw new Error(String(groups.fail))
      return { status: 'ok', retcode: 0, data: [{ group_id: Number(GROUP), group_name: '摸鱼群' }] }
    }
    return { status: 'ok', retcode: 0, data: null }
  }
  onebot.sent = []
  onebot.send = async (kind, peerId, text) => {
    onebot.sent.push({ kind, peerId, text })
  }

  const sendQueue = new SendQueue({ ...config.send, log })
  const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log })
  return { bridge, rpc, onebot, router, logs, config }
}

const privateMsg = (userId, text = '你好') => ({
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  user_id: userId,
  self_id: '200000001',
  message: [{ type: 'text', data: { text } }],
  sender: { user_id: userId, nickname: `用户${userId}` },
})

const groupMsg = (userId, text = '小鲸鱼在吗') => ({
  post_type: 'message',
  message_type: 'group',
  group_id: GROUP,
  user_id: userId,
  self_id: '200000001',
  message: [{ type: 'text', data: { text } }],
  raw_message: text,
  sender: { user_id: userId, nickname: `用户${userId}` },
})

async function main() {
  /* ══════════════════════════════════════════════════════════════════════
   * ① 私聊：验证 QQ 号（这条早已成立，但必须有回归盯着）
   * ══════════════════════════════════════════════════════════════════════ */
  section('① 私聊：按 QQ 号验证对话者')
  {
    const { bridge, logs } = makeBridge()

    // 管理员：放行
    const admin = await bridge.handleEvent(privateMsg(ADMIN))
    check('管理员私聊被放行', admin.handled !== false || admin.reason !== 'dm-not-allowed',
      JSON.stringify(admin))

    // 陌生人：拒绝，且明确告知（而不是静默无视）
    const stranger = await bridge.handleEvent(privateMsg(STRANGER))
    check('★ 陌生人私聊被拒（名单外不放行）', stranger.handled === false, JSON.stringify(stranger))

    // dmAllowlist 为空时**刻意**退回"只有管理员能私聊"（fail-closed）
    const roster = createRoster({ config: { access: { adminUsers: [ADMIN], dmAllowlist: [] } } })
    check('★ dmAllowlist 为空时陌生人拿不到 USER（不 fail-open）',
      roster.decide({ kind: 'private', peerId: STRANGER, senderId: STRANGER }).respond === false)
    check('★ dmAllowlist 为空时管理员仍可私聊',
      roster.tierOfPrivate(ADMIN) === 'admin')

    // 白名单里的普通人：放行但只读
    const roster2 = createRoster({
      config: { access: { adminUsers: [ADMIN], dmAllowlist: [NON_ADMIN] } },
    })
    check('★ 私聊白名单里的人拿到 USER（只读），不是 STRANGER',
      roster2.tierOfPrivate(NON_ADMIN) === 'user')

    check('★ 每次判定都写审计日志（权限出错是静默的，必须留痕）',
      logs.some((l) => l.includes('身份核实') && l.includes('权限判定=')),
      logs.filter((l) => l.includes('身份核实')).slice(-1)[0] ?? '（没有身份核实日志）')
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ② 群聊：从协议端取昵称与群内角色
   * ══════════════════════════════════════════════════════════════════════ */
  section('② 群聊：从协议端核实发言人是谁')
  {
    const { bridge, onebot } = makeBridge()
    await bridge.handleEvent(groupMsg(NON_ADMIN))

    const call = onebot.calls.find((c) => c.action === 'get_group_member_info')
    check('★ 真的调了 get_group_member_info（不是猜的、不是只读事件里的字段）',
      Boolean(call), JSON.stringify(onebot.calls.map((c) => c.action)))
    check('★ 传的是**群号 + 发言人 QQ 号**（两个都不能少）',
      String(call?.params?.group_id) === GROUP && String(call?.params?.user_id) === NON_ADMIN,
      JSON.stringify(call?.params))
    check('★ 查询带超时（它是附加信息，不许把回话拖住）',
      typeof call?.timeoutMs === 'number' && call.timeoutMs <= 3000, String(call?.timeoutMs))

    const conv = bridge.listConversations().find((c) => c.chatKey === `group:${GROUP}`)
    const sender = conv?.senders?.[NON_ADMIN]
    check('★ 会话镜像里记下了核实到的昵称（群名片优先）',
      sender?.name === '甲甲', JSON.stringify(sender))
    check('★ 会话镜像里记下了群内角色', sender?.roleLabel === '群管理', JSON.stringify(sender))
    check('★ 核实成功标记 verified=true', sender?.verified === true)

    const lastUser = [...(conv?.messages ?? [])].reverse().find((m) => m.role === 'user')
    check('★ 每条消息自己带发言人（一个群有多个说话人，不能只记在会话上）',
      lastUser?.senderId === NON_ADMIN && lastUser?.senderName === '甲甲',
      JSON.stringify(lastUser))
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ③ 最关键的一条：身份 ≠ 权限
   * ══════════════════════════════════════════════════════════════════════ */
  section('③ 身份核实的结果**不得**变成权限（防越权）')
  {
    const { bridge, rpc } = makeBridge()
    await bridge.handleEvent(groupMsg(NON_ADMIN))

    // NON_ADMIN 在协议端是 `admin`（群管理），但他不在 adminUsers 里。
    // 他拿到的提示词必须仍是"普通用户（只读）"。
    const prompt = String(rpc.calls[0]?.contentBlocks?.[0]?.text ?? '')
    check('★ 群管理（协议端 role=admin）拿到的仍是【普通用户（只读）】权限段',
      prompt.includes('【你的权限：普通用户（只读）】') &&
        !prompt.includes('【你的权限：管理员】'),
      (prompt.match(/【你的权限：[^】]*】/) ?? ['（没找到权限段）'])[0])
    check('★ 权限段里明确禁止写文件/跑命令（他没拿到"动手"能力）',
      prompt.includes('文件方面禁止'))

    // 来源标注里必须把"他是谁"和"他能做什么"切开
    const origin = prompt.match(/\[来自 QQ 群[^\]]*\]/)?.[0] ?? ''
    check('★ 来源标注带昵称与群内角色（如实说明他是谁）',
      origin.includes('甲甲') && origin.includes('群管理'), origin)
    check('★★ 群内角色旁边必须标注"与权限无关"（否则模型会自己推出他有权限）',
      origin.includes('与权限无关'), origin)
    check('★ 来源标注里他**不是**管理员',
      !origin.includes('（管理员）'), origin)

    // 真管理员仍要被如实标成管理员 —— 改这一处不能把主人也说成普通用户
    const second = makeBridge()
    await second.bridge.handleEvent(groupMsg(ADMIN, '小鲸鱼帮我看下'))
    const adminPrompt = String(second.rpc.calls[0]?.contentBlocks?.[0]?.text ?? '')
    check('★ 对照：真管理员仍拿到【管理员】权限段',
      adminPrompt.includes('【你的权限：管理员】'))
    check('★ 对照：真管理员的来源标注是（管理员）',
      (adminPrompt.match(/\[来自 QQ 群[^\]]*\]/)?.[0] ?? '').includes('（管理员）'),
      adminPrompt.match(/\[来自 QQ 群[^\]]*\]/)?.[0] ?? '')
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ④ 查不到身份：必须"说不出来"，不能编，也不能影响回话
   * ══════════════════════════════════════════════════════════════════════ */
  section('④ 协议端查不到身份时的行为')
  {
    const { bridge } = makeBridge({ member: { fail: '模拟：协议端查不到成员' } })
    await bridge.handleEvent(groupMsg(NON_ADMIN))

    const conv = bridge.listConversations().find((c) => c.chatKey === `group:${GROUP}`)
    const lastUser = [...(conv?.messages ?? [])].reverse().find((m) => m.role === 'user')
    check('★ 查不到也不编名字（不拿号码当昵称）',
      lastUser?.senderName === undefined, JSON.stringify(lastUser?.senderName))
    check('★ 号码仍然如实保留（"不知道名字"≠"不知道是谁"）',
      lastUser?.senderId === NON_ADMIN)
    check('★ 核实用 verified=false 如实标出（界面据此显示"未核实"）',
      conv?.senders?.[NON_ADMIN]?.verified === false, JSON.stringify(conv?.senders?.[NON_ADMIN]))
    check('★ 消息照常被处理（附加信息失败不能拖垮主流程）',
      conv !== undefined && (conv?.messages?.length ?? 0) > 0)

    // 私聊里查不到好友昵称时同理：不编名字，但号码必须留
    const priv = makeBridge({ friends: [] })
    await priv.bridge.handleEvent(privateMsg(ADMIN))
    const pc = priv.bridge.listConversations().find((c) => c.chatKey === `private:${ADMIN}`)
    const pm = [...(pc?.messages ?? [])].reverse().find((m) => m.role === 'user')
    check('★ 私聊查不到昵称时也只留号码', pm?.senderId === ADMIN && pm?.senderName === undefined,
      JSON.stringify(pm))
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑤ 缓存：不重复查、但也不能把旧身份瞒着不更新
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑤ 身份缓存')
  {
    const { bridge, onebot } = makeBridge()
    await bridge.handleEvent(groupMsg(NON_ADMIN, '小鲸鱼第一次'))
    const after1 = onebot.calls.filter((c) => c.action === 'get_group_member_info').length
    await bridge.handleEvent(groupMsg(NON_ADMIN, '小鲸鱼第二次'))
    const after2 = onebot.calls.filter((c) => c.action === 'get_group_member_info').length
    check('★ 短时间内同一个人不重复查（缓存生效）', after1 === 1 && after2 === 1,
      `${after1} → ${after2}`)

    // 拨快 6 分钟：缓存必须过期重查 —— 群名片和群内角色是会变的，
    // 缓存太久会把"他已经被撤了管理"瞒着不报。
    const realNow = Date.now
    try {
      // eslint-disable-next-line no-global-assign
      Date.now = () => realNow() + 6 * 60 * 1000
      await bridge.handleEvent(groupMsg(NON_ADMIN, '小鲸鱼第三次'))
    } finally {
      Date.now = realNow
    }
    const after3 = onebot.calls.filter((c) => c.action === 'get_group_member_info').length
    check('★ 超过 TTL 后会重查（身份不是永久事实）', after3 === 2, `${after2} → ${after3}`)
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑥ 记忆隐私：非管理员不许复述记忆内容
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑥ 非管理员不得复述记忆内容')
  {
    const userBlock = buildPermissionInstructions('user', 'group')
    const adminBlock = buildPermissionInstructions('admin', 'group')
    check('★ 普通用户段里有"不要说记忆里的内容"这条硬规矩',
      userBlock.includes('不要说记忆里的内容'))
    check('★ 明确禁止念原文/复述/总结',
      userBlock.includes('不要') && userBlock.includes('念出来') && userBlock.includes('复述'))
    check('★ 被追问时给的是"自然带过"的话术，而不是解释机制',
      userBlock.includes('记不太清') && userBlock.includes('不要') && userBlock.includes('解释为什么'))
    check('★ 管理员段没有这条限制（对主人不需要）',
      !adminBlock.includes('不要说记忆里的内容'))

    // 这一条是**提示词层**的约束：如实写在文档里，不能假装是硬墙
    const src = String(userBlock)
    check('（背景）它是提示词约束，不是硬墙 —— 记忆仍会注入到上下文里',
      !src.includes('不会看到记忆'))
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑨ 会话名：左边那列要能看出"这是哪个群/哪个人"
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑦ 会话名（左边那列不能只有一串号码）')
  {
    // 起因：用户在界面上看到左边那列只写 `700000001`，认不出是哪个群。
    // 而**群名桥接早就拿到过**（`get_group_list` 的 `group_name`，配置界面选群用的就是它）
    // —— 只是从来没往会话那边传。这一节盯的就是"已有的信息要接通"。
    const g = makeBridge()
    await g.bridge.handleEvent(groupMsg(NON_ADMIN))
    const gconv = g.bridge.listConversations().find((c) => c.chatKey === `group:${GROUP}`)
    check('★★ 群聊会话带上了群名（来自 get_group_list）',
      gconv?.name === '摸鱼群' && gconv?.nameVerified === true,
      JSON.stringify({ name: gconv?.name, verified: gconv?.nameVerified }))
    check('★ 群名进得了提示词（模型提"咱们群"时不必报一串数字）',
      String(g.rpc.calls[0]?.contentBlocks?.[0]?.text ?? '').includes('「摸鱼群」'),
      (String(g.rpc.calls[0]?.contentBlocks?.[0]?.text ?? '').match(/\[来自 QQ 群[^\]]*\]/) ?? [''])[0])
    check('★ 群号仍然在来源标注里（群名可能重名，号码才是身份）',
      String(g.rpc.calls[0]?.contentBlocks?.[0]?.text ?? '').includes(`[来自 QQ 群 ${GROUP}`))

    // 私聊：显示对方是谁（核实的昵称）。
    const p = makeBridge()
    await p.bridge.handleEvent(privateMsg(ADMIN))
    const pconv = p.bridge.listConversations().find((c) => c.chatKey === `private:${ADMIN}`)
    check('★ 私聊会话带上了对方的昵称（来自 get_friend_list）',
      pconv?.name === '主人' && pconv?.nameVerified === true,
      JSON.stringify({ name: pconv?.name, verified: pconv?.nameVerified }))

    // ★ 拿不到群名时：**留空**，界面显示号码。绝不编名字。
    const f = makeBridge({ groups: { fail: '模拟：拉群列表失败' } })
    await f.bridge.handleEvent(groupMsg(NON_ADMIN))
    const fconv = f.bridge.listConversations().find((c) => c.chatKey === `group:${GROUP}`)
    check('★★ 群名拿不到时留空且 nameVerified=false（界面显示号码，不编名字）',
      fconv?.name === '' && fconv?.nameVerified === false,
      JSON.stringify({ name: fconv?.name, verified: fconv?.nameVerified }))
    check('★ 而且不影响这一轮被处理（附加信息失败不拖垮主流程）',
      (fconv?.messages?.length ?? 0) > 0)
    check('★ 拿不到群名时提示词里的**群标注**只写群号（不编名字）',
      (String(f.rpc.calls[0]?.contentBlocks?.[0]?.text ?? '').match(/\[来自 QQ 群[^\]]*\]/) ?? [''])[0]
        .startsWith(`[来自 QQ 群 ${GROUP}，`),
      (String(f.rpc.calls[0]?.contentBlocks?.[0]?.text ?? '').match(/\[来自 QQ 群[^\]]*\]/) ?? [''])[0])
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑩ 自相矛盾修复：ask_user_question 不再被列进"你可以用"
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑧ 只读工具清单不再与平台规则打架')
  {
    const block = buildPermissionInstructions('user', 'private')
    check('★ ask_user_question 不在"你可以用这些只读能力"里',
      !block.includes('ask_user_question'),
      block.match(/可以用这些只读能力[^\n]*/)?.[0] ?? '')
    check('★ 群成员查询（只读）仍保留给普通用户',
      block.includes('qq_group_members'))
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑧ ★ "无法查询 bot 管理员" 这条反馈的根因守卫
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑨ 权限判据必须自解释（否则模型只能回"我查不了"）')
  {
    // 反馈原话："为什么 bot 显示他无法查询 bot 管理员"。
    // 根因取证：真正的名单（access.adminUsers）从来没有进过提示词，
    // 提示词只给了"你不是管理员"这种**相对标签**，而工具返回的 role 是
    // **QQ 群角色**、记忆里写"谁是管理员"又被硬拦 —— 于是它只能回"查不了"。
    //
    // 这两条断言就是那个缺口的守卫：判据必须说明"它是怎么来的、覆盖谁"。
    const userBlock = buildPermissionInstructions('user', 'group')
    const adminBlock = buildPermissionInstructions('admin', 'group')

    check('★ 权限段开头必须说明"这份判据是系统给的、且是唯一判据"',
      userBlock.startsWith('【关于"谁是管理员"：只有下面这段是权威】'), userBlock.slice(0, 40))
    check('★ 必须点名它判的是【当前正在说话的那个人】（这正是我们能核实的范围）',
      userBlock.includes('当前正在跟你说话的那个人') && adminBlock.includes('当前正在跟你说话的那个人'))
    check('★★ 必须明确"群内角色/工具查到的 role 不是你的管理员"（否则它会把群主当管理员）',
      userBlock.includes('不是') && userBlock.includes('QQ 群里的角色') && userBlock.includes('role'))
    check('★ 必须给出结论句，而不是让模型自己推',
      userBlock.includes('结论：') && adminBlock.includes('结论：'), 
      userBlock.includes('不在这份名单里') ? '（用户：不在名单里）' : '（缺结论）')
    check('★★ 两份结论必须相反（否则"结论句"等于没写）',
      userBlock.includes('不在这份名单里') && adminBlock.includes('就在这份名单里'))
    check('★ 必须说明"不能回答另一个人是不是管理员"，并给出可执行的话术',
      userBlock.includes('管理员是谁') && userBlock.includes('只能确认'))
    check('★★ 明确禁止"我没有查询管理员的功能"这种像坏掉了的说法',
      userBlock.includes('没有查询管理员的功能') && userBlock.includes('不要回答'))
    check('★ 同时禁止猜测（猜错等于整条规则失效）',
      userBlock.includes('不要猜'))
    // ★ 对主人说"你没拿到名单"是**假的**，而且他要的恰恰是"有哪些管理员"能答得出来。
    //   所以管理员版必须多一条例外；普通用户版**绝不能**有（那等于把名单交出去）。
    check('★★ 管理员版多一条例外：他自己问名单可以直接说',
      adminBlock.includes('例外') && adminBlock.includes('有哪些管理员'))
    check('★★ 普通用户版**没有**这条例外（名单不给外人）',
      !userBlock.includes('例外') && !userBlock.includes('有哪些管理员'))
    // 泄露检查：这一节**不许**出现任何具体号码或昵称 —— 它只讲自己的判定范围
    check('★★ 权限段里不含任何 QQ 号码或昵称（不泄露主人的身份）',
      !/\d{5,}/.test(userBlock) && !/\d{5,}/.test(adminBlock))

    // 走完整桥接再确认一次：管理员会话与普通用户会话拿到的判决相反
    const asAdmin = makeBridge()
    await asAdmin.bridge.handleEvent(groupMsg(ADMIN))
    const adminPrompt = String(asAdmin.rpc.calls[0]?.contentBlocks?.[0]?.text ?? '')
    check('★ 端到端：管理员会话里模型能看到"就在这份名单里"',
      adminPrompt.includes('就在这份名单里'))

    const asUser = makeBridge()
    await asUser.bridge.handleEvent(groupMsg(NON_ADMIN))
    const userPrompt = String(asUser.rpc.calls[0]?.contentBlocks?.[0]?.text ?? '')
    check('★ 端到端：普通用户会话里模型能看到"不在这份名单里"',
      userPrompt.includes('不在这份名单里'))
    // ⚠️ 这条断言**必须断言对的东西**（第一版就写错了）：不能断言"提示词里
    //   不出现管理员号码" —— 那个号码是**管理员自己发的群里那条消息的发送者**，
    //   它本来就会出现在来源标注里（`发言人 100000001`），与管理名单无关。
    //   真正要防的泄露是这两种：① 把管理员的**昵称**告诉了普通用户；
    //   ② 让普通用户以为自己是管理员。
    check('★★ 普通用户会话里没有把管理员的身份说出来（昵称不出现、角色不出现）',
      !userPrompt.includes('群主大人') && !userPrompt.includes('就在这份名单里'),
      userPrompt.includes('群主大人') ? '（出现了管理员昵称）' : '')
    check('★★ 普通用户会话里不明示管理员的号码属于谁（同一个人换个身份也不该被认出）',
      !/群号\s*700000002[^\n]*管理员/.test(userPrompt))
  }

  // 收尾：清掉本进程建的临时工作区（每个用例一份）
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
  rmSync(WS, { recursive: true, force: true })

  console.log('')
  if (failures === 0) {
    console.log('✅ 身份核实全部通过（身份查得到、权限不受身份影响、查不到不编）')
    process.exit(0)
  }
  console.log(`❌ 有 ${failures} 条断言失败`)
  process.exit(1)
}

main().catch((error) => {
  console.error('验证脚本自身崩了：', error)
  process.exit(1)
})
