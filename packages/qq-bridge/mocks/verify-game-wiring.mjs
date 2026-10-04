/**
 * **游戏内对话的接线**（0.3.2 P3）—— 真 `Bridge` + 桩 rpc / onebot。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这一套（纯函数测试抓不到的那一类）
 * ══════════════════════════════════════════════════════════════════════════
 * 本项目的原话是"最贵的缺陷是接线"（先例：任务段那次"从未注入过"的静默事故，
 * 124 项纯函数断言一条都没抓到）。这一套盯的正是那几处**只有走完整桥接才看得见**
 * 的东西。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 流程（2026-10-04 使用者定的口径）
 * ══════════════════════════════════════════════════════════════════════════
 * ```
 * 玩家进服（未绑定）          → 只给他本人一条 tellraw：怎么拿码
 * 玩家在**游戏里**说 \mc bind  → 生成一张 6 位码（与那个 UUID 挂在一起）
 *                                → 只给他本人 tellraw：码 + 下一步
 * 玩家在**群里直接**发 \mc bind <码>（**不用 @ 我** —— 这条通道在唤醒判定**之前**）
 *                            → 桥接本地拦截（一次模型调用都没有）→ **当场绑定**
 *                            → 群里回一句 + **在游戏里给那个玩家一条成功通知**
 * ```
 * ★★ 为什么是**反斜杠**：使用者 2026-10-04 实测 `//mc bind` 在游戏里**不行** ——
 *   以 `/` 开头的输入会被服务端当命令，而那句"未知命令"**不写进控制台日志**，
 *   我们的游戏内事件源看不到。`\` 在游戏里只是普通字符 ⇒ 那句话以**聊天**发出 ⇒ 进日志。
 *   斜杠那几个形状**仍然收**（零代价的兜底，装了服务端插件之后就能用）——
 *   第 ④-b 节专门盯这件事。
 *
 * ∴ 关键断言：① 取码与提交**都不产生模型调用**；② 提交那一刻**就**绑上了
 *   （不再有"下次说话才落实"）；③ **每个玩家只收到给他本人的** tellraw；
 *   ④ 绑定成功通知**立刻**回到游戏里（抢绑藏不住）。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lookupByUuid, lookupByQq, listBindings, bindUuid, readStore, writeStore } from '../src/servers/bindings.mjs'

let pass = 0
let fail = 0
const failures = []
function ok(cond, label, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${label}${detail ? `  —— ${detail}` : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, label, same ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`)
}

const { Bridge } = await import('../src/bridge.mjs')
const { SessionRouter } = await import('../src/session-bridge.mjs')
const { SendQueue } = await import('../src/onebot.mjs')

const ROOT = mkdtempSync(join(tmpdir(), 'qqb-gamewire-'))
const ADMIN = '100000001'
const MEMBER = '100000077'
const GROUP = '700000001'
const OTHER_GROUP = '700000999'
const PLAYER = 'YoCerin'
const UUID = '00000000-0000-4000-8000-000000000001'
const SERVER = { id: 'forge1', name: '主服（Forge 1.20.1）', host: '127.0.0.1', rconPort: 25575, password: 'x', gameChat: true, enabled: true, commandFromQQ: false }

/**
 * 造一个最小可用的真桥接。
 * @param {{semantic?: boolean, groupAllow?: string[], wakeJudge?: object|null,
 *          readServers?: Function|null, servers?: object[]|null}} o
 */
function wiringBridge({ semantic = false, groupAllow = [GROUP], wakeJudge = null, readServers = null, servers = null } = {}) {
  const WS = join(ROOT, `ws-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(WS, 'runtime'), { recursive: true })
  const router = new SessionRouter({ log: () => {} })
  const logs = []
  const log = (m) => logs.push(String(m))
  const config = {
    dsh: { workspace: WS, permissionMode: 'workspace-write' },
    onebot: {},
    access: { adminUsers: [ADMIN], dmAllowlist: [], groupAllowlist: groupAllow },
    trigger: { private: true, mention: true, keyword: true, groupEnabled: true, keywords: ['小鲸鱼'] },
    send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
    turn: { timeoutMs: 5000 },
    humanize: { enabled: false, chunkChars: 300 },
    persona: { preset: 'none' },
    memory: { enabled: false, affect: { prewake: 'off' } },
    image: { enabled: false },
    wake: { policy: semantic ? 'semantic' : 'off' },
    servers: servers ?? [{ ...SERVER }],
  }

  const rpc = new EventTarget()
  rpc.prompts = []
  rpc.prompt = async (sessionId, contentBlocks) => {
    rpc.prompts.push({ sessionId, text: String(contentBlocks?.[0]?.text ?? '') })
    router.handleEvent(sessionId, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '我在。' }] } },
    })
    router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
    return { messageId: 'm1' }
  }

  const onebot = new EventTarget()
  onebot.selfId = '200000001'
  onebot.call = async () => ({ status: 'ok', retcode: 0, data: null })
  const sent = []
  onebot.send = async (kind, peerId, text, opts) => {
    sent.push({ kind, peerId, text, ...(opts ?? {}) })
    return { status: 'ok', retcode: 0, data: { message_id: `s${sent.length}` } }
  }

  const sendQueue = new SendQueue({ ...config.send, log })
  const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log, wakeJudge, readServers })
  // ★ 游戏内那条通道的执行器换成桩：**只换执行器**，命令的构造一个字都不放宽 ——
  //   这里收到的 `command` 正是真机上会发给 RCON 的那一串。
  const gameCommands = []
  bridge.setGameConsoleForTest(async ({ server, command, what }) => {
    gameCommands.push({ serverId: server?.id ?? '', what, command })
    return { ok: true }
  })
  return { bridge, rpc, sent, logs, WS, router, gameCommands }
}

const groupMsg = (groupId, userId, text) => ({
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  group_id: groupId,
  user_id: userId,
  self_id: '200000001',
  message: [{ type: 'text', data: { text } }],
  sender: { user_id: userId, nickname: `用户${userId}` },
})

const privateMsg = (userId, text) => ({
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  user_id: userId,
  self_id: '200000001',
  message: [{ type: 'text', data: { text } }],
  sender: { user_id: userId, nickname: '主人' },
})

/** 从 tellraw 命令里把码抠出来（**只有测试这么做**；生产代码绝不把码写进日志）。 */
function codeFromTellraw(command) {
  const m = /(\d{6})/.exec(String(command ?? ''))
  return m ? m[1] : ''
}

console.log('\n=== ① ★★★ 玩家在游戏里说 `mc bind` ⇒ 一张只发给**他本人**的码，零模型调用 ===')
{
  const { bridge, rpc, sent, gameCommands } = wiringBridge()
  bridge.attach()
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })

  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '\\mc bind' })
  eq(rpc.prompts.length, 0, '★★★ 取码**一次模型调用都没有**')
  eq(sent.length, 0, '★★ 也没往 QQ 发任何东西（码是游戏内的私密消息）')
  const tells = gameCommands.filter((c) => c.what === 'tellraw')
  eq(tells.length, 1, '★ 恰好一条 tellraw')
  ok(tells[0].command.startsWith(`tellraw ${PLAYER} `), '★★★ 收件人是**他本人**（不是 @a）')
  ok(/\d{6}/.test(tells[0].command), '★ 里面给了 6 位码')
  ok(/\\mc bind/.test(tells[0].command), '★★ 而且告诉了他下一步：群里发 `\\mc bind <码>`')
  ok(Boolean(codeFromTellraw(tells[0].command)), '★ 码能从那串命令里读出来（形状是我们要的）')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ② ★★★ 群里 `/mc bind <码>` ⇒ **当场绑定** + 回游戏通知本人，零模型调用 ===')
{
  const { bridge, rpc, sent, WS, gameCommands } = wiringBridge()
  bridge.attach()
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '\\mc bind' })
  const code = codeFromTellraw(gameCommands.at(-1)?.command)
  const tellsBefore = gameCommands.filter((c) => c.what === 'tellraw').length

  const r = await bridge.handleEvent(groupMsg(GROUP, ADMIN, `\\mc bind ${code}`))
  eq(rpc.prompts.length, 0, '★★★ 提交码也**零模型调用**')
  eq(r.reason, 'bind-command', '★ 这一轮以「绑定指令」结束')

  // ★★★ 提交那一刻就绑上了（不再有"下次说话才落实"）
  eq(lookupByUuid(WS, UUID)?.qqId, ADMIN, '★★★ **当场**写死了映射')
  eq(lookupByQq(WS, ADMIN)?.uuid, UUID, '★ 两个方向都在')
  eq(Object.keys(readStore(WS).store.codes).length, 0, '★ 码被消费掉了（一次性）')

  ok(sent.some((x) => /绑好了/.test(x.text)), '★ 群里回了一句"绑好了"')

  // ★★★ 而且**在游戏里**给那个玩家发了成功通知（使用者明确要求的那一步）
  const tells = gameCommands.filter((c) => c.what === 'tellraw')
  eq(tells.length, tellsBefore + 1, '★★★ 多了一条 tellraw —— 绑定成功通知回到了游戏里')
  const last = tells.at(-1).command
  ok(last.startsWith(`tellraw ${PLAYER} `), '★★ 那条通知是给**那个玩家本人**的')
  ok(/绑定成功/.test(last), '★★★ 内容就是"绑定成功"')
  ok(!last.includes(ADMIN), '★★★ 通知里**没有 QQ 号**（设计文档 §5.5：服务端只拿到"绑定了没有"）')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ③ ★★★ 语义唤醒闸门开着时：取码/提交两轮**根本没问过判定器** ===')
{
  let judgeCalls = 0
  const judge = {
    enabled: true,
    judge: async () => {
      judgeCalls += 1
      return { verdict: 'silent', why: '桩：一律判沉默' }
    },
  }
  const { bridge, rpc, sent, gameCommands } = wiringBridge({ semantic: true, wakeJudge: judge })
  bridge.attach()
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '\\mc bind' })
  const code = codeFromTellraw(gameCommands.at(-1)?.command)

  const r = await bridge.handleEvent(groupMsg(GROUP, ADMIN, `\\mc bind ${code}`))
  eq(judgeCalls, 0, '★★★ 判定器**一次都没被问过** —— 绑定通道确实排在闸门之前')
  ok(sent.some((x) => /绑好了/.test(x.text)), '★★ 即使判定器"会判沉默"，绑定照样成立（这一步没白做）')
  eq(rpc.prompts.length, 0, '★ 依然零模型调用')
  eq(r.reason, 'bind-command', '★ 以绑定指令结束')

  // 对照组：同样开着闸门，一条**普通**群消息**会**经过判定器（证明桩真的接上了）
  await bridge.handleEvent(groupMsg(GROUP, ADMIN, '小鲸鱼 在吗'))
  ok(judgeCalls > 0, '★★ 对照组：普通消息**确实**会问判定器（说明上面那个 0 不是"桩没接上"）', `问了 ${judgeCalls} 次`)
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ④ 形状不对的提交：**必须在这里拦下**，不许掉进管理员控制台那条路 ===')
{
  const { bridge, rpc, sent, WS } = wiringBridge()
  bridge.attach()
  await bridge.handleEvent(groupMsg(GROUP, ADMIN, '\\mc bind abc'))
  ok(sent.some((x) => /6 位数字/.test(x.text)), '★★ `\\mc bind abc` ⇒ 一句"码是 6 位数字"')
  eq(rpc.prompts.length, 0, '★ 零模型调用')
  eq(listBindings(WS).length, 0, '★ 什么都没绑上')

  const before = sent.length
  await bridge.handleEvent(groupMsg(GROUP, ADMIN, '\\mc bind'))
  eq(sent.length, before + 1, '★ `\\mc bind`（没码）⇒ 指路')
  ok(/游戏里/.test(sent.at(-1)?.text ?? ''), '★★ 指路说清"码要在游戏里拿"（**不在这里发码**）')
  ok(/反斜杠/.test(sent.at(-1)?.text ?? ''), '★★★ 而且说清是**反斜杠**（斜杠在游戏里进不来，实测过）')
  // ★★★ 使用者 2026-10-04 的第二处修正：群里**不用 @ 它**。第一版教程写的是
  //   「@小鲸鱼 \mc bind 码」，而这条通道跑在 `decideTrigger` **之前** ⇒ @ 一直是多余的。
  //   措辞错了会让人以为不 @ 就没反应（白等），∴ 两条都钉死。
  ok(!/@小鲸鱼/.test(sent.at(-1)?.text ?? ''), '★★★ 群里那句指路**不教人 @ 小鲸鱼**')
  ok(/不用 ?@ ?我/.test(sent.at(-1)?.text ?? ''), '★★★ 并**明说不必 @**')
  eq(rpc.prompts.length, 0, '★ 零模型调用')

  // ★★ 别的 `mc <子命令>`**不许**被绑定通道吞掉（它们要走管理员控制台那条路）
  const r = await bridge.handleEvent(groupMsg(GROUP, ADMIN, '/mc list'))
  ok(r.reason !== 'bind-command', '★★★ `/mc list` **不走**绑定通道（那是控制台指令）', String(r.reason))
  const r2 = await bridge.handleEvent(groupMsg(GROUP, ADMIN, '\\mc list'))
  ok(r2.reason !== 'bind-command', '★★★ `\\mc list` 也**不走**绑定通道（反斜杠在控制台通道同样认）', String(r2.reason))
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ④-b 老的单斜杠形状仍然收（**零代价的兜底**，装了服务端插件之后就能用）===')
{
  const { bridge, WS, gameCommands } = wiringBridge()
  bridge.attach()
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  // 游戏内：`/mc bind` 也认（真机上进不来，但认它不花什么）
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '/mc bind' })
  const code = codeFromTellraw(gameCommands.at(-1)?.command)
  ok(Boolean(code), '★ 游戏内 `/mc bind` 也给码（认它是零代价的兜底）')
  // 群里：单斜杠同样能绑定
  await bridge.handleEvent(groupMsg(GROUP, ADMIN, `/mc bind ${code}`))
  eq(lookupByUuid(WS, UUID)?.qqId, ADMIN, '★★ 群里单斜杠 `/mc bind <码>` 照样绑定')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑤ ★★★ 未绑定玩家**进服那一刻**就收到提醒；每次进服最多一次；而已绑定的人一个字都不发 ===')
{
  const { bridge, rpc, gameCommands } = wiringBridge()
  bridge.attach()
  // ★ 真机顺序：`UUID of player X is …` 在 `X joined the game` **之前**
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'join', name: PLAYER })

  const tells0 = gameCommands.filter((c) => c.what === 'tellraw')
  eq(tells0.length, 1, '★★★ **进服那一刻**就发了提醒（不是等他先说话 —— 使用者明确要求）')
  ok(tells0[0].command.startsWith(`tellraw ${PLAYER} `), '★★ 只给他本人')
  ok(/\\mc bind/.test(tells0[0].command), '★ 提醒里给出了 `\\mc bind`')
  ok(/反斜杠/.test(tells0[0].command), '★★★ 并说清是**反斜杠**（玩家一定会按习惯打斜杠）')
  ok(!/@小鲸鱼/.test(tells0[0].command), '★★★ 提醒里**不教人 @ 小鲸鱼**（群里直接发就行，@ 是多余的）')
  ok(/不用 ?@ ?我/.test(tells0[0].command), '★★★ 并且**明说"不用 @ 我"**（不说清就会有人 @ 了再等）')
  ok(!/\/mc/.test(tells0[0].command), '★★ 提醒里不出现 `/mc`（正斜杠是错的形状）')
  eq(rpc.prompts.length, 0, '★ 提醒不产生任何模型调用')

  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 你好' })
  eq(rpc.prompts.length, 0, '★★★ 未绑定的玩家说话 ⇒ **一次模型调用都没有**（零成本）')
  eq(gameCommands.filter((c) => c.what === 'tellraw').length, 1, '★★ 说话时**不再重复**提醒（这一趟已经提醒过了）')

  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 再问一次' })
  eq(gameCommands.filter((c) => c.what === 'tellraw').length, 1, '★★ 第二次说话也不再提示（每次进服最多一次）')

  // ★★★ 但"已经提示过"**不能**把 `\mc bind` 也挡住 —— 那是玩家主动来绑定的
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '\\mc bind' })
  const tells2 = gameCommands.filter((c) => c.what === 'tellraw')
  eq(tells2.length, 2, '★★★ 提示过之后 `\\mc bind` **照样**给码（这两件事是独立的）')
  ok(/\d{6}/.test(tells2.at(-1).command), '★ 新码给了')

  // 退服再进 ⇒ 允许再提示一次
  await bridge.onGameEventForTest(SERVER, { kind: 'leave', name: PLAYER })
  await bridge.onGameEventForTest(SERVER, { kind: 'join', name: PLAYER })
  eq(gameCommands.filter((c) => c.what === 'tellraw').length, 3, '★ 重新进服 ⇒ 又提醒一次（"每次进服"不是"一辈子一次"）')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑤-b ★★★ 已绑定的玩家进服：**一个字都不发**（误报"你还没绑定"比不提醒更糟）===')
{
  const { bridge, WS, gameCommands } = wiringBridge()
  bridge.attach()
  bindUuid({ workspace: WS, uuid: UUID, name: PLAYER, qqId: ADMIN, by: 'test' })
  // ① 先看到 uuid 事件（真机顺序），再进服
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'join', name: PLAYER })
  eq(gameCommands.filter((c) => c.what === 'tellraw').length, 0, '★★★ 已绑定 ⇒ 进服**不发**任何提醒')

  // ② 万一没看到 uuid 事件，也要靠**绑定表里的名字**认出他（不能误报）
  const b2 = wiringBridge()
  b2.bridge.attach()
  bindUuid({ workspace: b2.WS, uuid: UUID, name: PLAYER, qqId: ADMIN, by: 'test' })
  await b2.bridge.onGameEventForTest(SERVER, { kind: 'join', name: PLAYER })
  eq(
    b2.gameCommands.filter((c) => c.what === 'tellraw').length,
    0,
    '★★★ 没有 uuid 事件时靠**名字**也认得出他已绑定 ⇒ 依然不误报',
  )
  await b2.bridge.close({ timeoutMs: 100 })
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑤-c 未绑定的人**说话**：默认不回；只有**明确叫了名字**才补一条提醒 ===')
{
  // 使用者的理由：「不能确定每次玩家都在跟小鲸鱼说话」⇒ 说话时不该回他什么。
  // 但"桥接启动时他已经在线"这一类拿不到进服事件 ⇒ 有一个人永远不知道要绑定。
  // ∴ 留一个**窄**兜底：他明确叫了名字（命中唤醒词）时补发**一次**（每次进服最多一次）。
  const { bridge, rpc, gameCommands } = wiringBridge()
  bridge.attach()
  // 故意**不发 join**（模拟"桥接起来时他已经在服里了"）
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })

  // ① 普通闲聊 ⇒ 什么都不回（不进模型、也不提醒）
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '今天天气不错' })
  eq(rpc.prompts.length, 0, '★★ 未绑定的闲聊 ⇒ 零模型调用')
  eq(gameCommands.length, 0, '★★★ 而且**一个字都不回**（不能确定他在跟小鲸鱼说话）')

  // ② 明确叫了名字 ⇒ 补一次提醒
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 在吗' })
  const tells = gameCommands.filter((c) => c.what === 'tellraw')
  eq(tells.length, 1, '★★★ 明确叫了名字 ⇒ 补发**一条**绑定提醒（那条情况我们确定他在跟它说话）')
  ok(/\\mc bind/.test(tells[0].command), '★ 提醒里给的是 `\\mc bind`')
  ok(tells[0].command.startsWith(`tellraw ${PLAYER} `), '★★ 只给他本人')
  eq(rpc.prompts.length, 0, '★★ 而且仍然**不进模型**（未绑定 = 零成本）')

  // ③ 再叫一次 ⇒ 不再重复（每次进服最多一次）
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鱼 你在吗' })
  eq(gameCommands.filter((c) => c.what === 'tellraw').length, 1, '★★ 再叫也不再重复提醒（"每次进服最多一次"仍然成立）')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑥ 已绑定玩家在游戏里说话：命中唤醒词 ⇒ 真的跑了一轮，回复走**公屏 tellraw @a** ===')
{
  const { bridge, rpc, sent, WS, gameCommands } = wiringBridge()
  bridge.attach()
  bindUuid({ workspace: WS, uuid: UUID, name: PLAYER, qqId: ADMIN, by: 'test' })

  // 先让他在 QQ 私聊里说一句 —— 拿到"那个 QQ 的会话 id"
  await bridge.handleEvent(privateMsg(ADMIN, '小鲸鱼 在吗'))
  eq(rpc.prompts.length, 1, '（准备）QQ 私聊那条跑了一轮')
  const qqSessionId = rpc.prompts[0].sessionId

  const r = await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 在吗' })
  ok(Boolean(r), '★ 这一轮有结果（不是被丢掉）')
  eq(rpc.prompts.length, 2, '★★★ 真的产生了一次 session/prompt')
  const prompt = rpc.prompts[1].text
  ok(/Minecraft/.test(prompt) && /公屏/.test(prompt), '★★★ 来源标注**如实说是公屏**（否则模型会以为在一对一私聊里）')
  ok(/全服所有人都看得见/.test(prompt), '★★★ 并且明确警告"全服都看得见"')
  eq(rpc.prompts[1].sessionId, qqSessionId, '★★★ 会话就是**那个 QQ 的会话**（游戏内的话与他的 QQ 记忆同一条）')

  const qqReplies = sent.filter((x) => x.kind === 'private')
  eq(qqReplies.length, 1, '★★★ 游戏那一轮的回复**没有**发到 QQ 私聊（只有上面那条 QQ 消息的回复）')
  eq(sent.length, 1, '★ QQ 通道上只有那一条（游戏那条完全没走 QQ）')
  const says = gameCommands.filter((c) => c.what === 'say')
  eq(says.length, 1, '★ 恰好发了一条公屏发言')
  eq(
    says[0].command,
    'tellraw @a {"text":"<小鲸鱼> 我在。"}',
    '★★★ 公屏那条是 `tellraw @a` 且**带 `<小鲸鱼>` 前缀**（`say` 会渲染成 `[Server] …` 带配色，不像玩家）',
  )
  ok(!/"color"/.test(says[0].command), '★★ **不带颜色**（使用者要求"不要高亮"）')
  eq(says[0].serverId, 'forge1', '★ 发到那台服务器上')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑦ ★★★ 绑定了就能说话（**门是绑定，不是私聊白名单**）；但权限仍然只是只读 ===')
{
  // 使用者 2026-10-04 定的取舍：「**已绑定的玩家**在游戏里叫它就回」。
  // 上一版把 QQ 的私聊白名单也当成一道门 ⇒ 玩家好不容易绑上了却**说不上话**。
  const { bridge, rpc, WS, gameCommands } = wiringBridge()
  bridge.attach()
  bindUuid({ workspace: WS, uuid: UUID, name: PLAYER, qqId: MEMBER, by: 'test' }) // MEMBER **不在**任何名单里
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 在吗' })
  eq(rpc.prompts.length, 1, '★★★ 绑定了 ⇒ **真的跑了一轮**（不再因为 QQ 不在白名单里而拒答）')
  ok(
    /【你的权限：普通用户（只读）】/.test(rpc.prompts[0].text),
    '★★★ 但权限**只是只读**（提示词里明写「普通用户（只读）」）—— 绑定不该顺便把人提权',
  )
  eq(
    gameCommands.filter((c) => c.what === 'tellraw').length,
    0,
    '★ 而且**不再**发"你不在名单里"那种话（那句话已经不成立了）',
  )

  // ★ 管理员绑的还是管理员（权限只由 adminUsers 决定）
  const b2 = wiringBridge()
  b2.bridge.attach()
  bindUuid({ workspace: b2.WS, uuid: UUID, name: PLAYER, qqId: ADMIN, by: 'test' })
  await b2.bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await b2.bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 在吗' })
  eq(b2.rpc.prompts.length, 1, '（准备）管理员那条也跑了一轮')
  ok(/【你的权限：管理员】/.test(b2.rpc.prompts[0].text), '★★★ 绑的是管理员 QQ ⇒ 提示词里仍然是「管理员」（没有降级）')
  await b2.bridge.close({ timeoutMs: 100 })
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑧ 已绑定但**没叫它** ⇒ 不回答（唤醒判定与 QQ 侧共用同一份判据）===')
{
  const { bridge, rpc, WS, gameCommands } = wiringBridge()
  bridge.attach()
  bindUuid({ workspace: WS, uuid: UUID, name: PLAYER, qqId: ADMIN, by: 'test' })
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '今天天气不错' })
  eq(rpc.prompts.length, 0, '★★ 没唤醒 ⇒ 零模型调用（公屏上的闲聊不该烧钱）')
  eq(gameCommands.length, 0, '★ 也不说话（不插嘴）')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑨ 管理员 `/mc unbind`：能解掉、零模型调用；非管理员发同一形状 ⇒ 按普通聊天 ===')
{
  const { bridge, rpc, sent, WS } = wiringBridge()
  bridge.attach()
  bindUuid({ workspace: WS, uuid: UUID, name: PLAYER, qqId: ADMIN, by: 'test' })
  await bridge.handleEvent(groupMsg(GROUP, ADMIN, `\\mc unbind ${PLAYER}`))
  eq(lookupByUuid(WS, UUID), null, '★ 管理员解绑成功')
  eq(rpc.prompts.length, 0, '★ 解绑也是零模型调用')
  ok(/解绑了/.test(sent.at(-1)?.text ?? ''), '★ 如实回报')

  bindUuid({ workspace: WS, uuid: UUID, name: PLAYER, qqId: ADMIN, by: 'test' })
  const before = sent.length
  const r = await bridge.handleEvent(groupMsg(GROUP, MEMBER, `\\mc unbind ${PLAYER}`))
  ok(r.reason !== 'bind-command', '★★ 非管理员发 `\\mc unbind` ⇒ **不命中**这条通道', String(r.reason))
  eq(lookupByUuid(WS, UUID)?.qqId, ADMIN, '★★★ 绑定**没有被解掉**（非管理员解不动）')
  ok(sent.length === before, '★ 也没有任何"你没有权限"的回应（那等于告诉所有人这里有后门）')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑩ 不在白名单的群：`/mc bind <码>` 一个回话都没有（fail-closed）===')
{
  const { bridge, rpc, sent, WS, gameCommands } = wiringBridge()
  bridge.attach()
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '\\mc bind' })
  const code = codeFromTellraw(gameCommands.at(-1)?.command)

  const r = await bridge.handleEvent(groupMsg(OTHER_GROUP, ADMIN, `\\mc bind ${code}`))
  eq(sent.length, 0, '★★ 群白名单外 ⇒ **不回话**（与普通消息同一条纪律：群里不解释）')
  eq(rpc.prompts.length, 0, '★ 也没有模型调用')
  eq(lookupByUuid(WS, UUID), null, '★★★ 而且**没有绑上**（白名单是硬门）')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑪ 私聊里发 `/mc bind`：一句**确定性**指路，零模型调用 ===')
{
  const { bridge, rpc, sent } = wiringBridge()
  bridge.attach()
  const before = sent.length
  const r = await bridge.handleEvent(privateMsg(ADMIN, '/mc bind'))
  eq(rpc.prompts.length, 0, '★★★ 一次模型调用都没有（否则模型会编出一套流程）')
  eq(r.reason, 'bind-command', '★ 以绑定指令结束')
  eq(sent.length, before + 1, '★ 回了一句')
  ok(/群里/.test(sent.at(-1)?.text ?? ''), '★★ 指路说清了"要在群里做"')

  // 名单外的人：**什么都不回**（fail-closed）
  const before2 = sent.length
  const r2 = await bridge.handleEvent(privateMsg('999999999', '/mc bind'))
  ok(r2.reason !== 'bind-command', '★★ 名单外的人**不走**绑定通道（交回普通准入判定）', String(r2.reason))
  eq(rpc.prompts.length, 0, '★ 名单外也没有模型调用')
  const strangerMsgs = sent.slice(before2).filter((x) => x.peerId === '999999999')
  eq(strangerMsgs.length, 1, '★ 只收到那句统一的"只对名单内的人开放"')
  ok(/名单/.test(strangerMsgs[0]?.text ?? ''), '★★ 而且**不是**绑定流程的指路（不泄露这里有这条路）')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑫ 提示词里的来源标注：空串时**逐字不变**（QQ 那条路一个字都不受影响）===')
{
  const { bridge, rpc } = wiringBridge()
  bridge.attach()
  await bridge.handleEvent(groupMsg(GROUP, ADMIN, '小鲸鱼 在吗'))
  eq(rpc.prompts.length, 1, '（准备）QQ 群那条真的跑了')
  ok(/来自 QQ 群/.test(rpc.prompts[0].text), '★★ QQ 那条路的来源标注**照旧**（没被游戏通道的改动带偏）')
  ok(!/Minecraft/.test(rpc.prompts[0].text), '★★ 也没有混进游戏那句话')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑬ 在界面上打开 `gameChat` ⇒ 读控制台的循环**真的起来**（那个复选框不许撒谎）===')
{
  const off = [{ ...SERVER, gameChat: false }]
  let served = off
  const { bridge } = wiringBridge({ servers: off, readServers: () => served })
  bridge.attach()
  eq(bridge.gameChatStats().running, false, '（准备）gameChat 关着 ⇒ **没有**读控制台的循环')

  served = [{ ...SERVER, gameChat: true }]
  const r = bridge.reloadServers()
  eq(r.changed, true, '★ 列表变了（保存生效）')
  eq(
    bridge.gameChatStats().running,
    true,
    '★★★ 打开 gameChat 之后循环**真的起来了** —— 否则界面提示"已即时生效、不必重启桥接"就是**撒谎**',
  )

  served = [{ ...SERVER, gameChat: false }]
  bridge.reloadServers()
  eq(bridge.gameChatStats().running, false, '★ 再关掉 ⇒ 循环停掉（不会偷偷继续读日志）')
  await bridge.close({ timeoutMs: 200 })
  eq(bridge.gameChatStats().running, false, '★ 收尾时也停掉（不留一个还在读日志的定时器）')
}

console.log('\n=== ⑭ 同一张码不能用第二次：归属不会被第二个人抢走 ===')
{
  const { bridge, WS, gameCommands } = wiringBridge()
  bridge.attach()
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '\\mc bind' })
  const code = codeFromTellraw(gameCommands.at(-1)?.command)

  await bridge.handleEvent(groupMsg(GROUP, ADMIN, `\\mc bind ${code}`))
  eq(listBindings(WS).length, 1, '（准备）绑上了一条')
  await bridge.handleEvent(groupMsg(GROUP, MEMBER, `\\mc bind ${code}`))
  eq(listBindings(WS).length, 1, '★★★ 还是只有一条（同一张码不能用第二次）')
  eq(lookupByUuid(WS, UUID)?.qqId, ADMIN, '★★★ 归属**没有被第二个人抢走**')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑮ 认不出 UUID ⇒ 绝不发一张没处挂的码 ===')
{
  const { bridge, rpc, gameCommands } = wiringBridge()
  bridge.attach()
  // ★ 没收到过 uuid 事件 ⇒ 认不出他是谁 ⇒ **不发码**
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '\\mc bind' })
  const tells = gameCommands.filter((c) => c.what === 'tellraw')
  eq(tells.length, 1, '★ 回了一条 tellraw')
  ok(/重进/.test(tells[0].command), '★★ 让他重进一次（而不是发一张挂不到人身上的码）')
  ok(!/\d{6}/.test(tells[0].command), '★★★ 而且**没有**给码')
  eq(rpc.prompts.length, 0, '★ 零模型调用')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑯ 取码时记的那台服不见了 ⇒ 改成在别的服上通知，并**留下痕迹** ===')
{
  const other = { ...SERVER, id: 'forge2', name: '副服' }
  const { bridge, WS, gameCommands, logs } = wiringBridge({ servers: [{ ...SERVER }, other] })
  bridge.attach()
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '\\mc bind' })
  const code = codeFromTellraw(gameCommands.at(-1)?.command)
  // 把码搬到一台"已经不存在的服务器"上（模拟码里那台被删/改名）
  const { store } = readStore(WS)
  store.codes[code].serverId = 'gone'
  writeStore(WS, store)

  await bridge.handleEvent(groupMsg(GROUP, ADMIN, `/mc bind ${code}`))
  eq(lookupByUuid(WS, UUID)?.qqId, ADMIN, '★ 绑定照样成立（找不到那台服不该让绑定失败）')
  ok(
    logs.some((l) => /现在找不到/.test(l)),
    '★★★ 而且**留了一行日志**说明"码里那台服找不到、改成在所有开了 gameChat 的服上通知"',
  )
  const tells = gameCommands.filter((c) => c.what === 'tellraw')
  ok(tells.some((c) => c.serverId === 'forge2'), '★ 副服上确实发了通知')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑰ ★★★ 控制台预览里**单独一个「游戏内对话」窗口**（不混进那个人的 QQ 私聊）===')
{
  const { bridge, WS, gameCommands } = wiringBridge()
  bridge.attach()
  // ★ 先**不绑定**：进服那条提醒会进窗口（notice），顺便把它也验掉
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'join', name: PLAYER })
  const afterJoin = bridge.listConversations().find((c) => c.chatKey === `game:${SERVER.id}`)
  ok(Boolean(afterJoin), '★★★ 一进服就建出了 `game:forge1` 窗口（进服提醒把它带出来了）')
  ok(
    (afterJoin?.messages ?? []).some((m) => m.role === 'notice' && /还没绑定/.test(String(m.text))),
    '★★ 进服提醒在窗口里记为 **notice**',
  )
  // 取码那条也是 notice（**只给他本人**的话）
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '\\mc bind' })
  const withCode = bridge.listConversations().find((c) => c.chatKey === `game:${SERVER.id}`)
  ok(
    (withCode?.messages ?? []).filter((m) => m.role === 'notice').length >= 2,
    '★★★ 绑定码那条也进了窗口（**只给他本人**的话照样看得见）',
  )

  // ★ 绑定之后再说一句 ⇒ 窗口里该有玩家那句与它回公屏那句
  bindUuid({ workspace: WS, uuid: UUID, name: PLAYER, qqId: ADMIN, by: 'test' })
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 在吗' })

  // ★ 那个人的 **QQ 私聊** 会话与**游戏内**窗口必须是两个
  await bridge.handleEvent(privateMsg(ADMIN, '小鲸鱼 在吗'))
  const convs = bridge.listConversations()
  const game = convs.find((c) => c.chatKey === `game:${SERVER.id}`)
  const priv = convs.find((c) => c.chatKey === `private:${ADMIN}`)
  ok(Boolean(priv), '（对照）那个人的 QQ 私聊会话也在（各是各的）')
  eq(game?.kind, 'game', '★ 它的 kind 是 `game`（界面据此显示 🎮 与「游戏内对话」）')
  eq(game?.peerId, SERVER.id, '★ peerId 是**服务器 id**（不是 QQ 号）')
  ok(
    /游戏内对话 · 主服/.test(String(game?.name ?? '')),
    '★★ 窗口名 = 「游戏内对话 · <服务器名>」（来自我们自己的配置，不是猜的）',
    String(game?.name),
  )
  ok(
    !convs.some((c) => c.chatKey === `private:${ADMIN}` && c.messages.some((m) => /游戏内|还没绑定/.test(String(m.text)))),
    '★★★ 游戏内那条**没有**混进 QQ 私聊窗口',
  )

  // ★ 窗口里三样都要有：玩家说的、它回的公屏话、以及只发给本人的 notice
  const roles = (game?.messages ?? []).map((m) => m.role)
  ok(roles.includes('user'), '★★ 窗口里有**玩家说的那句**')
  ok(roles.includes('bot'), '★★ 也有**它回公屏的那句**（否则看起来像"它没理人"）')
  ok(roles.includes('notice'), '★★ 还有**只发给本人的那些话**（进服提醒/绑定码/绑定成功）')
  const userMsg = (game?.messages ?? []).find((m) => m.role === 'user')
  eq(userMsg?.senderName, PLAYER, '★★★ 说话人显示的是**游戏里的名字**（不是 QQ 号）')
  eq(userMsg?.senderId, ADMIN, '★ 同时留着绑定的 QQ 号（可以用来核对是谁）')
  ok(
    (game?.messages ?? []).some((m) => m.role === 'notice' && new RegExp(`→ ${PLAYER}：`).test(String(m.text))),
    '★★★ 私密那些记成「→ 玩家：正文」—— 它是**点对点**的，不是公屏发言，这个区别看得出',
  )
  void gameCommands
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑱ 窗口里的"搜历史"是真的能搜到（游戏内消息也进语料库）===')
{
  const { bridge, WS } = wiringBridge()
  bridge.attach()
  bindUuid({ workspace: WS, uuid: UUID, name: PLAYER, qqId: ADMIN, by: 'test' })
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 记住铁傀儡农场' })
  const r = bridge.searchHistory({ chatKey: `game:${SERVER.id}`, query: '铁傀儡', limit: 5 })
  ok(r.ok, '★ 语料库可用（没关）')
  // ★ 字段名是 `preview`（截断预览），不是 `content`/`text` —— 断言写错会**假失败**
  ok(
    (r.rows ?? []).some((row) => /铁傀儡/.test(String(row.preview ?? ''))),
    '★★★ 游戏内那句话**进了语料库**（所以那个窗口里的"搜历史"不是摆设）',
    JSON.stringify((r.rows ?? []).slice(0, 1)),
  )
  await bridge.close({ timeoutMs: 200 })
}

rmSync(ROOT, { recursive: true, force: true })

console.log('')
if (fail === 0) {
  console.log(`🎉 游戏内对话接线测试：${pass} 项通过`)
  process.exitCode = 0
} else {
  console.log(`❌ 游戏内对话接线测试：${pass} 项通过、${fail} 项失败`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
