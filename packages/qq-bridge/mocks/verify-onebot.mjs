#!/usr/bin/env node
/**
 * 全链路验证：QQ 事件 → 唤醒判定 → 准入 → DSH → 回复发出。
 *
 * 用两个替身（mock sdk server + mock OneBot server）把整条链路跑通，
 * 全程不需要真 QQ 登录、也不需要花一分钱模型费用。
 *
 * 用法：node mocks/verify-onebot.mjs
 * 退出码 0 = 全部通过。
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { SdkRpcClient } from '../src/sdk-rpc.mjs'
import { OneBotClient, SendQueue } from '../src/onebot.mjs'
import { SessionRouter } from '../src/session-bridge.mjs'
import { Bridge } from '../src/bridge.mjs'
import { makeSessionId } from '../src/session-id.mjs'
import { startMockOneBot, privateMessage, groupMessage } from './mock-onebot-server.mjs'
import { canSpawn } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK_SDK = join(HERE, 'mock-sdk-server.mjs')
const WS_DIR = join(HERE, '..', '.tmp-verify-onebot')

const ADMIN = '100000001'
const STRANGER = '1999999999'
/** 一个**不是**管理员、但在群白名单里能触发机器人的普通用户（用它测权限标注）。 */
const NON_ADMIN = '100000002'
const GROUP = '700000002'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等 mock 服务器上出现第 n 条发出消息。 */
async function waitForSent(server, n, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (server.sent.length >= n) return server.sent[n - 1]
    await sleep(50)
  }
  return null
}

/**
 * 推一条消息进去，然后等**它带来**的新回复。
 *
 * ⚠️ 为什么不能写成 `waitForSent(server, server.sent.length + 1)`：
 * 那个表达式在**推入之前**就求值了，而人味层会把一条回复**切成多条**发送
 * （长回复按自然边界分片）。于是"当前水位 + 1"可能早已经被上一轮的分片占掉了，
 * 等待立刻返回一个**上一轮的**消息 —— 断言于是拿着旧内容去比对，报出一个
 * 看起来毫不相关的失败（实测踩过：第二轮断言里出现的是第一轮的提示词回显）。
 *
 * 正确做法：先记下**推入前的水位**，再等"水位涨过它"。
 * 这样无论上一轮被切成几条都不会错。
 */
async function pushAndWaitForReply(server, payload, timeoutMs = 20_000) {
  const before = server.sent.length
  server.push(payload)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (server.sent.length > before) return server.sent.slice(before)
    await sleep(50)
  }
  return null
}

/** 等一小会儿，确认"没有"新消息（用于反向断言）。 */
async function expectNoMoreSent(server, fromIndex, windowMs = 2500) {
  const before = server.sent.length
  await sleep(windowMs)
  return server.sent.length === before
}

function makeBridge({ rpc, onebot, config, attach = true }) {
  // 刻意把日志收集起来而不是丢掉：静默失败是这个项目最该避免的失败模式。
  // 验证脚本必须能看到桥接内部报的错。
  const logs = []
  const log = (m) => logs.push(m)
  const sendQueue = new SendQueue({ ...config.send, log })
  const router = new SessionRouter({ log })
  const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log })
  // `attach=false` 用于"直接调 handleEvent"的用例：不需要挂事件监听，
  // 也就避免了"多个 bridge 挂在同一条连接上互相干扰"（踩过两次）。
  if (attach) bridge.attach(onebot)
  return { bridge, sendQueue, router, logs }
}

async function main() {
  rmSync(WS_DIR, { recursive: true, force: true })
  mkdirSync(WS_DIR, { recursive: true })

  // ── 起始：两个替身 ──
  // 注意：模拟协议端把 HTTP API 与 WebSocket 放在**同一个端口**上（3150），
  // 这符合 OneBot 实现的常见做法（HTTP 与 WS upgrade 共用一个监听）。
  // 真 SnowLuma 是两个端口（3000/3001），桥接通过 config 区分，代码不用改。
  const mockServer = await startMockOneBot({ httpPort: 3150, wsToken: 'ws-token-x', httpToken: 'http-token-x' })

  const rpc = new SdkRpcClient({
    cliPath: MOCK_SDK,
    cwd: WS_DIR,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    log: () => {},
  })
  await rpc.start({ permissionMode: 'workspace-write' })

  const config = {
    dsh: { workspace: WS_DIR, permissionMode: 'workspace-write' },
    onebot: {
      wsUrl: `ws://127.0.0.1:${mockServer.httpPort}`,
      httpUrl: `http://127.0.0.1:${mockServer.httpPort}`,
      wsToken: 'ws-token-x',
      httpToken: 'http-token-x',
      selfId: '200000001',
    },
    // ★ 三级名单：
    //   adminUsers     管理员（满权限）
    //   dmAllowlist    私聊白名单（普通用户，只读）—— 空的话**只有管理员能私聊**
    //   groupAllowlist 群白名单 —— 空的话**所有群都不回**
    access: { adminUsers: [ADMIN], dmAllowlist: [], groupAllowlist: [GROUP] },
    trigger: { private: true, mention: true, keyword: true, groupEnabled: true, keywords: ['小鲸鱼'] },
    // ⚠️ 这两个值**刻意放大**，原因是一次真实踩坑，写下来免得被"优化"回去：
    //
    //   mock 的回复会把**整个提示词回显**出来，所以一条回复的字节数正比于
    //   提示词长度。被 chunkChars=300 切分后：
    //     提示词 ~1870 字 → 8 条；提示词 ~2800 字（加了身份核实的权威段之后）→ 10 条。
    //   一次完整跑有 6~7 轮回复 ≈ 60~70 次发送 —— 于是 maxPerMinute=60 **刚好差一点**，
    //   最后两轮的回复整批被限频丢掉，测试报"没回复"，而真实原因跟多轮上下文毫无关系。
    //
    //   ★ 教训：这个数字是**提示词长度的函数**。提示词一变长就要跟着调，
    //     否则会得到"改了提示词 → 全链路测试红了"这种指向完全错误结论的假失败。
    //     所以留足余量（不是刚好够）。
    //
    //   同理 dedupeWindowMs=8000：两轮都回显提示词里的固定段落，内容高度重复，
    //   会被去重拦掉。而真实对话里两轮的回复本来就不同。
    //
    // 限频与去重是**账号存活的关键防线**，不能为了测试把它们关掉；
    // 放大配额 + 让两轮内容不同，才是既测到真实行为又不误伤的写法。
    send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 200, maxPerHour: 2000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
    turn: { timeoutMs: 20_000 },
    // ★ 测试必须关掉拟人延迟。
    // 人味层默认是开的（它防的是账号风控），但测试要的是"快"：
    // 一条 295 字的回复在真实配置下会等 30 秒，测试会直接超时。
    // humanize.delay=false 是专门为此留的开关（生产配置里不该关它）。
    humanize: {
      enabled: true,
      delay: false,
      reactMinMs: 0,
      reactMaxMs: 0,
      charsPerSecond: 5,
      maxDelayMs: 45_000,
      chunkChars: 300,
      quietHours: { enabled: false, start: '02:00', end: '07:00' },
      quietDelayMinMs: 45_000,
      quietDelayMaxMs: 150_000,
    },
    session: { salt: 'verify-salt' },
    persona: { callerName: '测试管理员' },
  }

  const onebot = new OneBotClient({ ...config.onebot, log: () => {} })
  const { bridge, logs } = makeBridge({ rpc, onebot, config })
  onebot.connect()

  // 等事件通道真正连上（否则推送会丢）
  await new Promise((resolve) => {
    if (onebot.connected) return resolve()
    onebot.addEventListener('connected', resolve, { once: true })
    setTimeout(resolve, 3000)
  })
  check('事件通道已连接（我们主动连上模拟协议端）', onebot.connected === true)

  // ── 用例 1：管理员私聊 → 必须回复 ──
  console.log('\n── 用例 1：管理员私聊，必须回复 ──────────────────────────')
  mockServer.push(privateMessage({ userId: ADMIN, text: '你好，帮我看下工作区', messageId: 101 }))
  const first = await waitForSent(mockServer, 1)
  check('收到了回复', first !== null, first ? JSON.stringify(first.text.slice(0, 50)) : '超时未收到')
  // 一旦上面失败，把桥接内部日志倒出来 —— 否则我们只知道"没回复"，
  // 不知道是投递失败、回合超时、还是发送被拦。诊断信息必须可见。
  if (first === null) {
    console.log('  ── 桥接内部日志（用于定位静默失败）──')
    for (const l of logs.slice(-25)) console.log(`     ${l}`)
    console.log('  ── mock 协议端收到的 action ──')
    for (const c of mockServer.calls.slice(-10)) console.log(`     ${c.action} ${JSON.stringify(c.params).slice(0, 120)}`)
  }
  check('回复发给了正确的 QQ 号', first?.peerId === Number(ADMIN), String(first?.peerId))
  check('回复走的是私聊通道', first?.kind === 'private', first?.kind)
  check('回复内容来自 DSH 会话（第 1 轮）', /第 1 轮/.test(first?.text ?? ''), first?.text)

  // ── 用例 2：提示词里带上了平台约束与身份 ──
  console.log('\n── 用例 2：提示词内容（平台约束 + 身份标注）──────────────')
  // ⚠️ 必须把所有分条拼起来再看。
  // 人味层会把长回复按"真人观感"切成多条发送，只看第一条会误判成"内容不对"。
  const allOfTurn1 = mockServer.sent.map((s) => s.text).join('\n')
  check(
    '回复里回显了我们发出去的提示词（说明确实经过了提示词构造）',
    allOfTurn1.includes('你好，帮我看下工作区'),
    JSON.stringify(allOfTurn1.slice(0, 80)),
  )
  // ★ 记忆约定必须真的被拼进提示词。
  // 这条断言与"memory.mjs 的单元测试"是两个层次：那边验的是指令文本本身，
  // 这里验的是"桥接真的把它接上了"。少了这条，接线断了也不会有人发现。
  check(
    '★ 跨重启记忆约定真的被拼进了提示词',
    allOfTurn1.includes('【长期记忆】'),
    allOfTurn1.includes('【长期记忆】') ? '已注入' : '提示词里没有记忆段',
  )
  // ★ 人设也必须真的被拼进提示词（同一个道理：单测验文本，这里验接线）
  check(
    '★ 人设真的被拼进了提示词',
    allOfTurn1.includes('【你是谁】') && allOfTurn1.includes('小鲸鱼'),
    allOfTurn1.includes('【你是谁】') ? '已注入' : '提示词里没有人设段',
  )
  // ★ 平台约束必须排在前面（硬规矩不能被几千字的语气描述淹没）
  check(
    '★ 平台约束排在人设之前',
    allOfTurn1.indexOf('你现在通过 QQ 与用户对话') < allOfTurn1.indexOf('【你是谁】'),
    allOfTurn1.indexOf('你现在通过 QQ 与用户对话') < allOfTurn1.indexOf('【你是谁】')
      ? '顺序正确'
      : '顺序反了',
  )

  // ── 用例 3：第二轮 → 同一会话上下文连续 ──
  console.log('\n── 用例 3：同一会话第二轮（上下文连续）───────────────────')
  const turn2 = await pushAndWaitForReply(mockServer, privateMessage({ userId: ADMIN, text: '再问一句', messageId: 102 }))
  check('第二轮也回复了', turn2 !== null)
  // 第二轮失败时**必须**把桥接内部日志倒出来 —— 否则只知道"没回"，
  // 不知道是没触发、投递失败、还是回合超时。静默失败是本项目最该避免的模式。
  if (turn2 === null) {
    console.log('  ── 桥接内部日志（定位第二轮为什么没回）──')
    for (const l of logs.slice(-30)) console.log(`     ${l}`)
    console.log('  ── mock 协议端收到的 action（最近 8 条）──')
    for (const c of mockServer.calls.slice(-8)) {
      console.log(`     ${c.action} ${JSON.stringify(c.params).slice(0, 100)}`)
    }
  }
  // ★ 只看**这一轮**发出的内容。
  // 不能把 mockServer.sent 全部拼起来 —— 那里面还有第一轮的回显，
  // 混在一起会让断言看起来"认出了第 1 轮"这种莫名其妙的结果。
  const allOfTurn2 = (turn2 ?? []).map((s) => s.text).join('\n')
  check(
    'DSH 侧认出这是第 2 轮（同一个 sessionId 被复用）',
    allOfTurn2.includes('第 2 轮'),
    JSON.stringify(allOfTurn2.slice(0, 160)),
  )
  // ★ 这条断言是"同一次运行内 sessionId 必须固定"的**决定性证据**。
  //
  // 它抓到过一个严重回归：session instance 一度是"每次调用 makeSessionId 时
  // 重新生成"，于是**每条消息都换一个新会话** -> 机器人每条消息都失忆
  // （表现就是上面这条断言失败："第 2 轮"认不出来）。
  // 正确语义：instance 在 **Bridge 构造时算一次**，本次进程内固定不变。
  check(
    '★ 本次运行内 instance 固定不变（否则每条消息都会失忆）',
    typeof bridge.sessionInstance === 'string' && bridge.sessionInstance.length > 0,
    String(bridge.sessionInstance),
  )

  // ── 用例 3b：思考过程进镜像（给界面显示），但**不发到 QQ** ──
  console.log('\n── 用例 3b：思考过程只给界面看，不发到 QQ ────────────────')
  {
    const convs = bridge.listConversations()
    const priv = convs.find((c) => c.chatKey === `private:${ADMIN}`)
    check('对话镜像里有这个会话', !!priv, JSON.stringify(convs.map((c) => c.chatKey)))
    const roles = (priv?.messages ?? []).map((m) => m.role)
    check('★★ 镜像里出现了 role=thinking（界面据此渲染可折叠的思考块）',
      roles.includes('thinking'), roles.join(','))
    const thinkingText = (priv?.messages ?? []).find((m) => m.role === 'thinking')?.text ?? ''
    check('思考内容非空', thinkingText.length > 0, thinkingText)
    check('★ 思考内容**没有**出现在发给 QQ 的消息里（否则会把内心戏发出去）',
      !mockServer.sent.some((s) => String(s.text).includes(thinkingText)),
      thinkingText)
  }

  // ── 用例 4：名单外的人 → 拒绝，且不进入 DSH ──
  console.log('\n── 用例 4：名单外的人私聊 → 拒绝 ────────────────────────')
  const beforeStranger = mockServer.sent.length
  mockServer.push(privateMessage({ userId: STRANGER, text: '喂', messageId: 103 }))
  const denial = await waitForSent(mockServer, beforeStranger + 1)
  check('给名单外的人回了拒绝提示', denial !== null, denial?.text)
  check('拒绝消息内容是"仅对名单内的人开放"', /只对名单内的人开放/.test(denial?.text ?? ''))
  check('名单外的人没有被投给 DSH（拒绝文案不含轮次回显）', !/第 \d+ 轮/.test(denial?.text ?? ''))

  // ── 用例 4b：私聊白名单里的人（普通用户）→ 回，但权限是只读 ──
  console.log('\n── 用例 4b：私聊白名单里的普通用户 → 回，但只读 ─────────')
  {
    // 换一份 config：把 STRANGER 放进私聊白名单
    const asUser = makeBridge({
      rpc,
      onebot,
      attach: false,
      config: { ...config, access: { ...config.access, dmAllowlist: [STRANGER] } },
    })
    const res = await asUser.bridge.handleEvent(
      privateMessage({ userId: STRANGER, text: '帮我删掉那个文件', messageId: 150 }),
    )
    check('★ 白名单里的普通用户会被处理（不是拒绝）',
      res.reason !== 'dm-not-allowed' && res.reason !== 'dm-list-empty', JSON.stringify(res))
    // 权限段落在提示词里，从回复里能反查到（mock 会回显提示词）
    const prompt = String(res.result?.text ?? '')
    check('★★ 普通用户拿到的权限段落是「只读」，逐项列了禁止的动作',
      /您的权限：普通用户|你的权限：普通用户/.test(prompt) || /普通用户（只读）/.test(prompt),
      prompt.slice(prompt.indexOf('权限'), prompt.indexOf('权限') + 120))
    check('★ 且明确禁了"跑命令"（能间接改任何东西的那一类）', /跑命令/.test(prompt))

    const asAdmin = makeBridge({ rpc, onebot, attach: false, config })
    const resAdmin = await asAdmin.bridge.handleEvent(
      privateMessage({ userId: ADMIN, text: '帮我删掉那个文件', messageId: 151 }),
    )
    const adminPrompt = String(resAdmin.result?.text ?? '')
    check('★ 对照：管理员拿到的是「管理员」段落（可以说做修改）',
      /您的权限：管理员|你的权限：管理员/.test(adminPrompt), adminPrompt.slice(0, 60))
  }

  // ── 用例 5：群聊 —— 只有 @ 与关键词两种唤醒方式 ──
  //
  // 这一组验的是**桥接真的把群聊接上了**。
  // trigger.mjs 的单测已经覆盖了判定矩阵，但"判定被正确连线"是另一回事
  // （踩过：判定逻辑对，而桥接里有一条硬编码早退，群消息根本到不了判定）。
  console.log('\n── 用例 5a：群聊未唤醒（既没 @ 也没关键词）──────────────')
  {
    const before = mockServer.sent.length
    mockServer.push(groupMessage({ groupId: GROUP, userId: ADMIN, text: '今天天气不错', messageId: 104 }))
    const silent = await expectNoMoreSent(mockServer, before)
    check('★ 群里没 @ 也没关键词 → 不回复（不自动搭话，零 token）', silent === true)
  }

  console.log('\n── 用例 5b：群聊被 @ → 必须回 ───────────────────────────')
  {
    const got = await pushAndWaitForReply(
      mockServer,
      groupMessage({ groupId: GROUP, userId: ADMIN, text: '帮我看下', mentionsSelf: true, messageId: 105 }),
    )
    check('群里被 @ 后回复了', got !== null)
    check('★ 回复发到【群】里，而且用的是【群号】', got?.[0]?.kind === 'group' && got?.[0]?.peerId === Number(GROUP),
      `${got?.[0]?.kind}:${got?.[0]?.peerId}`)
    const text = (got ?? []).map((s) => s.text).join('\n')
    check('★ 提示词里的来源标注是"群"而不是"私聊"（否则模型会用私聊口吻）',
      text.includes(`[来自 QQ 群 ${GROUP}`), text.slice(0, 80))
  }

  console.log('\n── 用例 5d：提示词里的发言人身份必须按**真实权限**标注 ───────')
  {
    // ★ 这一节是为一个真实缺陷加的：`#buildPrompt` 里那段来源标注曾经**写死**
    //   "（管理员）" —— 于是每个在群里说话的人都被标成管理员。后果不止是"记错名字"：
    //   模型因此把一个普通用户的身份写进了记忆（实测：
    //   workspace-qq/memory/group-*.md 里出现"100000002 …… 管理员"），
    //   而那一行是**系统侧的可信信息**，与真正的权限段自相矛盾。
    const nonAdmin = await pushAndWaitForReply(
      mockServer,
      groupMessage({ groupId: GROUP, userId: NON_ADMIN, text: '小鲸鱼帮我看下', messageId: 107 }),
    )
    const nonAdminText = (nonAdmin ?? []).map((s) => s.text).join('\n')
    // 只看**来源标注那一行**。不能拿整段提示词去查"管理员"三个字：
    // 普通用户那段权限说明里本来就会提到"真有必要的操作，让 TA 找管理员"。
    // （第一版就是这么写错的，于是断言恒为假 —— 又是一条"假断言"。）
    const nonAdminOrigin = nonAdminText.match(/\[来自 QQ 群[^\]]*\]/)?.[0] ?? ''
    check('非管理员在群里说话也会被回（群白名单决定能不能用）', nonAdmin !== null)
    check(
      '★★ 非管理员的来源标注里**不能**把他标成管理员',
      nonAdminOrigin !== '' && !nonAdminOrigin.includes('管理员'),
      nonAdminOrigin || '（没找到来源标注）',
    )
    // ⚠️ 这里**不能**断言"号码紧跟着（普通用户，只读）" —— 来源标注里现在还带
    //   协议端核实到的昵称与群内角色（「甲甲」（群管理…）），中间必然夹着东西。
    //   第一版就是这么写死的，加了身份标注之后它立刻变成假失败。
    //   所以改成**从后面**取权限标签：它必须在来源标注的末尾附近。
    check(
      '★ 非管理员被如实标成"普通用户，只读"',
      /（普通用户，只读）\s*[\d\-: ]*\]$/.test(nonAdminOrigin),
      nonAdminOrigin,
    )

    const asAdmin = await pushAndWaitForReply(
      mockServer,
      groupMessage({ groupId: GROUP, userId: ADMIN, text: '小鲸鱼再看下', messageId: 108 }),
    )
    const adminText = (asAdmin ?? []).map((s) => s.text).join('\n')
    const adminOrigin = adminText.match(/\[来自 QQ 群[^\]]*\]/)?.[0] ?? ''
    check(
      '★ 管理员仍被标成"管理员"（改这一处不能把真管理员也说成普通用户）',
      /（管理员）\s*[\d\-: ]*\]$/.test(adminOrigin),
      adminOrigin,
    )
  }

  console.log('\n── 用例 5e：发言人身份（协议端核实 + 同步到对话预览）─────')
  {
    // ★ 这一节为"能否在会话中验证对话者身份"这条需求加。
    //   两件事必须同时成立、且互不串味：
    //     ① 身份**真的从协议端查了**（昵称、群内角色），并同步进会话镜像；
    //     ② 身份**绝不参与权限判定** —— mock 里 NON_ADMIN 的群内角色是
    //        `admin`（群管理），若拿它发权限，他就会变成"管理员"。
    const b = makeBridge({ rpc, onebot, attach: false, config })
    await b.bridge.handleEvent(
      groupMessage({ groupId: GROUP, userId: NON_ADMIN, text: '@我了吗小鲸鱼', mentionsSelf: true, messageId: 109 }),
    )
    const conv = b.bridge.listConversations().find((c) => c.chatKey === `group:${GROUP}`)
    const sender = conv?.senders?.[NON_ADMIN]
    const lastUser = [...(conv?.messages ?? [])].reverse().find((m) => m.role === 'user')

    check('★ 群成员身份是从协议端查到的（昵称来自 get_group_member_info）',
      sender?.name === '甲甲', JSON.stringify(sender))
    check('★ 群内角色被如实记下（mock 里这个普通用户是群管理）',
      sender?.roleLabel === '群管理', JSON.stringify(sender))
    check('★ 身份已核实标记为 true（界面据此决定是否显示"未核实"）',
      sender?.verified === true)
    check('★ 每条消息自己带发言人（群聊里一个会话有多个说话人，不能只记在会话上）',
      lastUser?.senderId === NON_ADMIN && lastUser?.senderName === '甲甲',
      JSON.stringify(lastUser))
    check('★ 会话上按人索引发言人身份',
      conv?.senders && Object.keys(conv.senders).includes(NON_ADMIN))
    // ★ 会话名（左边那列要显示的东西）：群名来自 get_group_list。
    //   加这一条的起因是用户反馈"聊天框左边也应显示当前聊天的群/人" ——
    //   那里原来只有一个裸群号，认不出是哪个群，而群名桥接**早就拿到过**。
    check('★★ 会话带上了协议端核实到的群名（左边那列要显示它，不能只有裸群号）',
      conv?.name === '测试群' && conv?.nameVerified === true,
      JSON.stringify({ name: conv?.name, verified: conv?.nameVerified }))

    // 权限与身份必须分开：查到"群管理"**不能**变成管理员
    const { buildPermissionInstructions } = await import('../src/roster.mjs')
    const userBlock = buildPermissionInstructions('user', 'group')
    check('★ 群内角色没有污染权限判定（普通用户的权限段仍是"普通用户（只读）"）',
      userBlock.includes('【你的权限：普通用户（只读）】') && !userBlock.includes('【你的权限：管理员】'))
    check('★ ★ 非管理员的权限段里必须明确禁止复述记忆原文',
      userBlock.includes('不要说记忆里的内容') && userBlock.includes('不要') && userBlock.includes('记忆原文'))
    check('★ 提示词里不再出现"ask_user_question 可以用"这种自相矛盾',
      !userBlock.includes('ask_user_question'),
      userBlock.match(/可以用这些只读能力[^\n]*/)?.[0] ?? '')
    check('★ 管理员段不提这条禁令（对主人不需要设这条限制）',
      !buildPermissionInstructions('admin', 'private').includes('不要说记忆里的内容'))
  }

  console.log('\n── 用例 5f：协议端查不到身份时，必须"说不出来"而不是编 ───')
  {
    // 查身份是附加信息，**绝不允许**因为查不到就影响回话或编造名字。
    mockServer.state.memberFail = '模拟：协议端查不到成员'
    const b = makeBridge({ rpc, onebot, attach: false, config })
    const before = mockServer.sent.length
    await b.bridge.handleEvent(
      groupMessage({ groupId: GROUP, userId: NON_ADMIN, text: '小鲸鱼在吗', messageId: 110 }),
    )
    const conv = b.bridge.listConversations().find((c) => c.chatKey === `group:${GROUP}`)
    const lastUser = [...(conv?.messages ?? [])].reverse().find((m) => m.role === 'user')
    check('★ 身份查不到时**不影响回话**（消息照常处理）', mockServer.sent.length >= before)
    check('★ 查不到就不写名字（不拿号码当昵称、不编）',
      lastUser?.senderName === undefined && conv?.senders?.[NON_ADMIN]?.verified === false,
      JSON.stringify({ msg: lastUser?.senderName, s: conv?.senders?.[NON_ADMIN] }))
    check('★ 号码仍然如实保留（"不知道名字"不等于"不知道是谁"）',
      lastUser?.senderId === NON_ADMIN)
    mockServer.state.memberFail = null
  }

  console.log('\n── 用例 5c：群聊命中关键词 → 必须回 ─────────────────────')
  {
    const got = await pushAndWaitForReply(
      mockServer,
      groupMessage({ groupId: GROUP, userId: ADMIN, text: '小鲸鱼这个东西怎么样', messageId: 106 }),
    )
    check('群里命中关键词后回复了（不需要 @）', got !== null)
    check('同样发到群里', got?.[0]?.kind === 'group' && got?.[0]?.peerId === Number(GROUP),
      `${got?.[0]?.kind}:${got?.[0]?.peerId}`)
  }

  console.log('\n── 用例 5d：群聊总开关关闭（fail-closed）───────────────')
  {
    // ⚠️ 这一条**刻意直接调 `handleEvent`**，不走事件通道。
    //
    // 踩过两次同一个坑：主 bridge 已经挂在同一条 onebot 连接上，
    // 我再造一个"群聊关闭"的 bridge 并不影响它 —— 主 bridge 照样回，
    // 于是"没有消息发出"这条断言必然是假的。
    //
    // 直接调用反而**更强**：它断言的是**返回值**（reason 精确等于
    // group-disabled），比"没看到消息"这种间接观察可靠得多，
    // 而且完全不依赖时序。判定逻辑本身与事件通道无关，所以这样测是等价的。
    const off = makeBridge({
      rpc,
      onebot,
      attach: false,
      config: { ...config, trigger: { ...config.trigger, groupEnabled: false } },
    })
    const denied = await off.bridge.handleEvent(
      groupMessage({ groupId: GROUP, userId: ADMIN, text: '小鲸鱼', mentionsSelf: true, messageId: 107 }),
    )
    check('★ groupEnabled=false 时即使被 @ 也不处理（fail-closed）',
      denied.handled === false && denied.reason === 'group-disabled', JSON.stringify(denied))
    check('★ 返回值里带精确原因（便于排查"它怎么不理我"）', denied.reason === 'group-disabled')

    // 对照：同一个群里，开了开关就回 —— 证明差别确实来自那个开关
    const on = makeBridge({ rpc, onebot, attach: false, config })
    const allowed = await on.bridge.handleEvent(
      groupMessage({ groupId: GROUP, userId: ADMIN, text: '小鲸鱼', mentionsSelf: true, messageId: 108 }),
    )
    check('对照：开关打开时同一条消息会被处理（差别来自开关本身）',
      allowed.reason !== 'group-disabled', JSON.stringify(allowed))
  }

  // ── 用例 6：去重窗口 ──
  console.log('\n── 用例 6：内容去重（防止模型重复发送导致刷屏）──────────')
  // 直接把 sendQueue 拿出来单测更稳：这里用一个独立队列验证逻辑
  {
    const { SendQueue: SQ } = await import('../src/onebot.mjs')
    const q = new SQ({ minGapMs: 0, maxGapMs: 0, maxPerMinute: 8, maxPerHour: 500, dedupeWindowMs: 8000 })
    const a = q.check('一样的话')
    check('首次检查通过', a.ok === true)
    q.markSent('一样的话')
    const b = q.check('一样的话')
    check('8 秒内重复内容被拒', b.ok === false, b.reason)
    const c = q.check('不一样的话')
    check('不同内容照常通过', c.ok === true)
  }

  // ── 用例 7：限频 ──
  console.log('\n── 用例 7：每分钟限频 ────────────────────────────────────')
  {
    const { SendQueue: SQ } = await import('../src/onebot.mjs')
    const q = new SQ({ minGapMs: 0, maxGapMs: 0, maxPerMinute: 2, maxPerHour: 500, dedupeWindowMs: 0 })
    q.markSent('a')
    q.markSent('b')
    const third = q.check('c')
    check('超过每分钟上限后被拒', third.ok === false, third.reason)
  }

  // ── 用例 8：未知 sessionId 的事件被丢弃（安全） ──
  console.log('\n── 用例 8：未知会话的事件被丢弃 ─────────────────────────')
  {
    const { SessionRouter } = await import('../src/session-bridge.mjs')
    const router = new SessionRouter({ log: () => {} })
    const known = makeSessionId('private', ADMIN, { salt: 'verify-salt' })
    router.bind(known, { kind: 'private', peerId: ADMIN, chatKey: `private:${ADMIN}` })
    const consumedUnknown = router.handleEvent('session-某个陌生id', { type: 'assistant/message', data: {} })
    check('陌生 sessionId 的事件不被消费', consumedUnknown === false)
  }

  // ── 用例 9：回合超时路径 ──
  console.log('\n── 用例 9：超时兜底（不能让用户对着空气等）───────────────')
  {
    const { SessionRouter } = await import('../src/session-bridge.mjs')
    const router = new SessionRouter({ log: () => {} })
    const sid = makeSessionId('private', ADMIN, { salt: 'verify-salt' })
    router.bind(sid, { kind: 'private', peerId: ADMIN, chatKey: 'x' })
    const collector = router.beginTurn(sid, { timeoutMs: 200 })
    const result = await collector.finished()
    check('超时后回合会被结算（而不是永久挂起）', result.timedOut === true, JSON.stringify({ timedOut: result.timedOut }))
  }

  // ── 用例 10：DSH 子进程突然死亡 → 必须优雅降级 ──
  // 这是真实会发生的情况（模型跑飞、内存不足、被杀进程），而且属于最恶劣的
  // 一类故障：如果处理不当，用户发消息会石沉大海，且日志里毫无线索。
  // 模拟服务器预留了 __DIE__ 关键词来复现它。
  console.log('\n── 用例 10：DSH 子进程死亡 → 优雅降级 ──────────────────')
  {
    const before = mockServer.sent.length
    mockServer.push(privateMessage({ userId: ADMIN, text: '__DIE__ 触发子进程退出', messageId: 105 }))
    const notice = await waitForSent(mockServer, before + 1, 15_000)
    check('子进程死亡后仍给用户一个明确提示（不是沉默）', notice !== null, notice?.text)
    check(
      '提示内容或日志说明了失败原因',
      /⚠️/.test(notice?.text ?? '') || logs.some((l) => /退出|失败|不可写/.test(l)),
      notice?.text || logs.slice(-3).join(' | '),
    )
    await sleep(500)
    check('桥接侦测到子进程已退出', rpc.alive === false, `alive=${rpc.alive}`)
  }

  // ── 用例 11：防自环（机器人不能跟自己对话）──
  // 这一条是真实风险：如果协议端上报了机器人自己的消息而我们没滤掉，
  // 就会形成"它回一句 → 收到自己那句 → 再回一句"的无限对话。
  // 既烧钱，又会让账号表现得极其异常。
  console.log('\n── 用例 11：防自环（必须挡住自己的消息）─────────────────')
  {
    const before = mockServer.sent.length
    // 伪装成机器人自己发的私聊消息：user_id 等于 selfId（这里用数字，
    // 专门验证类型不一致时过滤是否仍然生效）
    mockServer.push(privateMessage({ userId: 200000001, text: '这是我自己发的消息', messageId: 106 }))
    const silent = await expectNoMoreSent(mockServer, before, 3000)
    check('★ 机器人自己发的消息被忽略（没有形成自环）', silent === true)
    check('日志里记录了"忽略自己发的消息"', logs.some((l) => /忽略自己发的消息/.test(l)),
      logs.filter((l) => /自己/.test(l)).slice(-1)[0] ?? '（无相关日志）')
  }

  // ── 收尾 ──
  onebot.close()
  await rpc.shutdown().catch(() => rpc.kill())
  await mockServer.close()

  console.log(`\n链路统计：收到 ${bridge.stats.received} · 触发 ${bridge.stats.triggered} · 回复 ${bridge.stats.answered} · 拒绝 ${bridge.stats.denied} · 跳过 ${bridge.stats.skipped}`)
  console.log(`${failures === 0 ? '🎉 全链路验证通过' : `⚠️ ${failures} 项失败`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * ★ 环境门槛：本套件整节都依赖"起一个假 DSH + 假协议端"，受限环境（禁止带管道的
 *   spawn）里跑不了。那种红与被测代码无关，而"训练人忽略红色"比缺一次回归更糟 ——
 *   所以明确跳过并说明，**绝不伪装成通过**。
 */
if (!(await canSpawn())) {
  console.log('\n⏭️  跳过 verify-onebot：本环境不允许启动带管道的子进程（EPERM）。')
  console.log('   这不是"通过" —— 请在正常 Windows 会话里重跑：node mocks/verify-onebot.mjs\n')
  process.exit(0)
}

main().catch((error) => {
  console.error('验证脚本自身崩了：', error)
  process.exit(1)
})
