/**
 * **游戏内对话的接线**（0.3.2 P3）—— 真 `Bridge` + 桩 rpc / onebot。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这一套（纯函数测试抓不到的那一类）
 * ══════════════════════════════════════════════════════════════════════════
 * 本项目的原话是"最贵的缺陷是接线"（先例：任务段那次"从未注入过"的静默事故，
 * 124 项纯函数断言一条都没抓到）。这一套盯的正是那几处**只有走完整桥接才看得见**
 * 的东西：
 *
 *   ① **绑定码走完整桥接时，一次 `rpc.prompt` 都没有发** ——
 *      设计文档 §10.1 的接线级验收第⑤条，逐字要求；
 *   ② 它必须在**语义唤醒闸门之前**生效 —— 用桩判定器断言"码这一轮**根本没问过**
 *      判定器"（放在闸门之后会**静默失效**：`semantic` 下玩家来绑定可能被判"沉默"）；
 *   ③ 未绑定的玩家说话 ⇒ **一次 `rpc.prompt` 都没有**（零成本）+ 只给他本人一条 `tellraw`；
 *   ④ 已绑定的玩家说话 + 命中唤醒词 ⇒ 真的产生了 `session/prompt`，
 *      而且回复**走公屏 `say`**（不是 QQ、不是私聊）；
 *   ⑤ 提示词里的来源标注**如实说是公屏**（不这么做模型会以为在一对一私聊里，
 *      而它说的每一句都会当场印在全服公屏上）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bindUuid, issueCode, lookupByUuid, pendingQualifications, redeemCode } from '../src/servers/bindings.mjs'

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
const GROUP = '700000001'
const OTHER_GROUP = '700000999'
const PLAYER = 'YoCerin'
const UUID = '00000000-0000-4000-8000-000000000001'
const SERVER = { id: 'forge1', name: '主服（Forge 1.20.1）', host: '127.0.0.1', rconPort: 25575, rconPort2: 0, password: 'x', gameChat: true, enabled: true, commandFromQQ: false }

/**
 * 造一个最小可用的真桥接。
 * @param {{semantic?: boolean, players?: object[]}} o
 */
function wiringBridge({ semantic = false, groupAllow = [GROUP], wakeJudge = null } = {}) {
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
    servers: [{ ...SERVER }],
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
  const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log, wakeJudge })
  // ★ 游戏内那条通道的执行器换成桩：**只换执行器**，命令的构造一个都不放宽 ——
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

/** 从桥接日志里捞出刚发出的绑定码（**只有测试这么做**；生产代码绝不记录码）。 */
function codeFrom(text) {
  const m = /绑定码：`([0-9]{6})`/.exec(String(text ?? ''))
  return m ? m[1] : ''
}

console.log('\n=== ① ★★★ 群里发 `/绑定`：**一次 rpc.prompt 都没有**，而且回了一张码 ===')
{
  const { bridge, rpc, sent } = wiringBridge()
  bridge.attach()
  // ★★ 关键：这条消息**没有 @ 机器人、也没有命中关键词** —— 正是真实用法
  const r = await bridge.handleEvent(groupMsg(GROUP, ADMIN, '/绑定'))
  eq(rpc.prompts.length, 0, '★★★ 走完整桥接，**一次 session/prompt 都没发**（设计文档 §10.1 逐字要求）')
  eq(r.reason, 'bind-command', '★ 这一轮以「绑定指令」结束（不是普通聊天）')
  eq(sent.length, 1, '★ 只回了一条')
  ok(/绑定码：`[0-9]{6}`/.test(sent[0].text), '★ 回复里有 6 位绑定码')
  eq(sent[0].peerId, GROUP, '★ 回在**那个群里**（不是私聊 —— 私聊是 fail-closed 的门）')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ② ★★ 不在白名单的群：`/绑定` **一个回话都没有**（fail-closed，不新造名单）===')
{
  const { bridge, rpc, sent } = wiringBridge()
  bridge.attach()
  const r = await bridge.handleEvent(groupMsg(OTHER_GROUP, ADMIN, '/绑定'))
  eq(sent.length, 0, '★★ 群白名单外 ⇒ **不回话**（与普通消息同一条纪律：群里不解释）')
  eq(rpc.prompts.length, 0, '★ 也没有模型调用')
  ok(r.reason === 'bind-command' || r.reason === 'no-trigger' || r.reason === 'group-disabled' || r.reason === 'not-allowed', '★ 如实给出原因', String(r.reason))
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ③ ★★★ 语义唤醒闸门开着时：码这一轮**根本没问过判定器**（放在闸门后会静默失效）===')
{
  let judgeCalls = 0
  const judge = {
    enabled: true,
    judge: async () => {
      judgeCalls += 1
      return { verdict: 'silent', why: '桩：一律判沉默' }
    },
  }
  const { bridge, rpc, sent } = wiringBridge({ semantic: true, wakeJudge: judge })
  bridge.attach()
  const r = await bridge.handleEvent(groupMsg(GROUP, ADMIN, '/绑定'))
  eq(judgeCalls, 0, '★★★ 判定器**一次都没被问过** —— 说明绑定通道确实排在闸门之前')
  eq(sent.length, 1, '★★ 即使判定器"会判沉默"，绑定码照样发得出去（码没白拿）')
  eq(rpc.prompts.length, 0, '★ 依然零模型调用')
  eq(r.reason, 'bind-command', '★ 以绑定指令结束')

  // 对照组：同样开着闸门，一条**普通**群消息**会**经过判定器（证明桩真的接上了）
  await bridge.handleEvent(groupMsg(GROUP, ADMIN, '小鲸鱼 在吗'))
  ok(judgeCalls > 0, '★★ 对照组：普通消息**确实**会问判定器（说明上面那条 0 不是"桩没接上"）', `问了 ${judgeCalls} 次`)
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ④ 提交码：资格生效，但仍然**零模型调用**；且绑的是**发送者** ===')
{
  const { bridge, rpc, sent, WS } = wiringBridge()
  bridge.attach()
  await bridge.handleEvent(groupMsg(GROUP, ADMIN, '/绑定'))
  const code = codeFrom(sent.at(-1)?.text)
  ok(Boolean(code), '（准备）拿到了一张码')

  const r = await bridge.handleEvent(groupMsg(GROUP, ADMIN, `/绑定 ${code}`))
  eq(rpc.prompts.length, 0, '★★ 提交码也是**零模型调用**')
  eq(r.reason, 'bind-command', '★ 以绑定指令结束')
  const pend = pendingQualifications(WS)
  eq(pend.length, 1, '★ 资格生效了')
  eq(pend[0].qqId, ADMIN, '★★★ 资格属于**发送者本人**（绝不绑给消息里写的任何人）')

  // 错的码：一句极短的话，且不产生模型调用
  const before = sent.length
  await bridge.handleEvent(groupMsg(GROUP, ADMIN, '/绑定 000000'))
  eq(sent.length, before + 1, '★ 码不对 ⇒ 回一句（不吵）')
  ok(/不能用/.test(sent.at(-1)?.text ?? ''), '★ 失败话术极短且不猜')
  eq(rpc.prompts.length, 0, '★ 失败路径也不调模型')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑤ 已绑定玩家在游戏里说话：命中唤醒词 ⇒ 真的跑了一轮，回复走**公屏 say** ===')
{
  const { bridge, rpc, sent, WS, gameCommands } = wiringBridge()
  bridge.attach()
  bindUuid({ workspace: WS, uuid: UUID, name: PLAYER, qqId: ADMIN, by: 'test' })

  // 先让他在 QQ 私聊里说一句 —— 拿到"那个 QQ 的会话 id"
  await bridge.handleEvent({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    user_id: ADMIN,
    self_id: '200000001',
    message: [{ type: 'text', data: { text: '小鲸鱼 在吗' } }],
    sender: { user_id: ADMIN, nickname: '主人' },
  })
  eq(rpc.prompts.length, 1, '（准备）QQ 私聊那条跑了一轮')
  const qqSessionId = rpc.prompts[0].sessionId

  const r = await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 在吗' })
  ok(Boolean(r), '★ 这一轮有结果（不是被丢掉）')
  eq(rpc.prompts.length, 2, '★★★ 真的产生了一次 session/prompt')
  const prompt = rpc.prompts[1].text
  ok(/Minecraft/.test(prompt) && /公屏/.test(prompt), '★★★ 来源标注**如实说是公屏**（否则模型会以为在一对一私聊里）')
  ok(/全服所有人都看得见/.test(prompt), '★★★ 并且明确警告"全服都看得见"')
  eq(rpc.prompts[1].sessionId, qqSessionId, '★★★ 会话就是**那个 QQ 的会话**（游戏内的话与他的 QQ 记忆同一条）')

  // ★ 回复必须走游戏，**不能**走 QQ
  const qqReplies = sent.filter((x) => x.kind === 'private')
  eq(qqReplies.length, 1, '★★★ 游戏那一轮的回复**没有**发到 QQ 私聊（只有上面那条 QQ 消息的回复）')
  eq(sent.length, 1, '★ QQ 通道上只有那一条（游戏那条完全没走 QQ）')
  const says = gameCommands.filter((c) => c.what === 'say')
  eq(says.length, 1, '★ 恰好发了一条 `say`')
  eq(says[0].command, 'say 我在。', '★ 命令形状正确（公屏）')
  eq(says[0].serverId, 'forge1', '★ 发到那台服务器上')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑥ 未绑定玩家说话：**零模型调用** + 只给他本人一条 tellraw；每次进服最多一次 ===')
{
  const { bridge, rpc, sent, gameCommands } = wiringBridge()
  bridge.attach()
  // `join` 事件（真实序列里它在聊天之前）
  await bridge.onGameEventForTest(SERVER, { kind: 'join', name: PLAYER })
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })

  const r1 = await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 你好' })
  eq(r1, undefined, '★ 未绑定 ⇒ 这一轮到此为止（不进模型）')
  eq(rpc.prompts.length, 0, '★★★ 未绑定的玩家说话 ⇒ **一次模型调用都没有**（零成本）')
  eq(sent.length, 0, '★★ 也没有往 QQ 发任何东西')
  const tells = gameCommands.filter((c) => c.what === 'tellraw')
  eq(tells.length, 1, '★ 只有一条 tellraw')
  eq(tells[0].command.startsWith(`tellraw ${PLAYER} `), true, '★★ 收件人是**他本人**（不是 @a）')
  ok(/\/绑定/.test(tells[0].command), '★ 提醒里给出了**怎么绑**')

  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 再问一次' })
  eq(gameCommands.filter((c) => c.what === 'tellraw').length, 1, '★★ 第二次说话**不再提示**（每次进服最多一次，刷屏的提示等于没有提示）')
  eq(rpc.prompts.length, 0, '★ 仍然零模型调用')

  // 退服再进 ⇒ 允许再提示一次
  await bridge.onGameEventForTest(SERVER, { kind: 'leave', name: PLAYER })
  await bridge.onGameEventForTest(SERVER, { kind: 'join', name: PLAYER })
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 我回来了' })
  eq(gameCommands.filter((c) => c.what === 'tellraw').length, 2, '★ 重新进服 ⇒ 可以再提示一次（"每次进服"不是"一辈子一次"）')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑦ ★★★ 有资格时：游戏内一说话就把绑定**写死**，并给本人 tellraw 确认 ===')
{
  const { bridge, rpc, sent, WS, gameCommands } = wiringBridge()
  bridge.attach()
  issueCode({ workspace: WS, qqId: ADMIN, chatKey: `group:${GROUP}` })
  // 直接从盘上读码（生产代码只有群里那条回复里有；测试为了不解析文案就这么拿）
  const { readStore } = await import('../src/servers/bindings.mjs')
  const code = readStore(WS).store.codes[ADMIN].code
  redeemCode({ workspace: WS, qqId: ADMIN, code, chatKey: `group:${GROUP}` })
  eq(pendingQualifications(WS).length, 1, '（准备）有一份待绑定资格')

  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 早上好' })
  const bound = lookupByUuid(WS, UUID)
  eq(bound?.qqId, ADMIN, '★★★ 绑定**当场写死**（UUID → QQ）')
  eq(pendingQualifications(WS).length, 0, '★ 那份资格被消费掉了（一次性）')
  const tells = gameCommands.filter((c) => c.what === 'tellraw')
  ok(tells.length >= 1, '★★ 给了本人一条确认')
  ok(/绑定成立/.test(tells[0]?.command ?? ''), '★★ 确认里明说"绑定成立"（抢绑藏不住）')
  // ★ 设计文档 §5.5：服务端**拿不到 QQ 号** ⇒ 确认里不许出现 QQ 号
  ok(!tells.some((t) => t.command.includes(ADMIN)), '★★★ 确认里**没有 QQ 号**（§5.5：服务端只拿到"绑定了没有"）')
  // 绑定之后这一轮**同时**继续跑（玩家叫了它，就该答）
  eq(rpc.prompts.length, 1, '★ 绑定之后这一轮照常继续（他确实叫了小鲸鱼）')
  eq(sent.length, 0, '★ 回复走公屏，不走 QQ')
  ok(gameCommands.some((c) => c.what === 'say'), '★ 回复真的发到公屏了')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑧ 多份资格 ⇒ **绝不猜**：不写绑定，给本人一条"我分不清" ===')
{
  const { bridge, WS, gameCommands } = wiringBridge()
  bridge.attach()
  issueCode({ workspace: WS, qqId: ADMIN, chatKey: 'g', code: '111111' })
  issueCode({ workspace: WS, qqId: '100000002', chatKey: 'g', code: '222222' })
  redeemCode({ workspace: WS, qqId: ADMIN, code: '111111', chatKey: 'g' })
  redeemCode({ workspace: WS, qqId: '100000002', code: '222222', chatKey: 'g' })
  eq(pendingQualifications(WS).length, 2, '（准备）两份资格')

  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 在吗' })
  eq(lookupByUuid(WS, UUID), null, '★★★ **没有**写任何绑定（猜错 = 把别人的身份算到你头上）')
  const tells = gameCommands.filter((c) => c.what === 'tellraw')
  eq(tells.length, 1, '★ 给本人一条说明')
  ok(/2 个/.test(tells[0]?.command ?? ''), '★ 如实说清有几份（不装作没事）')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑨ 已绑定但那个 QQ 不在名单里 ⇒ 不参与（与 QQ 侧 fail-closed 一致）===')
{
  const { bridge, rpc, WS, gameCommands } = wiringBridge()
  bridge.attach()
  const STRANGER = '999999999'
  bindUuid({ workspace: WS, uuid: UUID, name: PLAYER, qqId: STRANGER, by: 'test' })
  await bridge.onGameEventForTest(SERVER, { kind: 'uuid', name: PLAYER, uuid: UUID })
  await bridge.onGameEventForTest(SERVER, { kind: 'chat', name: PLAYER, text: '小鲸鱼 在吗' })
  eq(rpc.prompts.length, 0, '★★ 名单外 ⇒ **一次模型调用都没有**')
  const tells = gameCommands.filter((c) => c.what === 'tellraw')
  eq(tells.length, 1, '★ 如实告诉他"名单里没有"（只给他本人）')
  ok(/名单/.test(tells[0]?.command ?? ''), '★ 说清了是名单问题，不是"我不理你"')
  await bridge.close({ timeoutMs: 200 })
}

console.log('\n=== ⑩ 已绑定但**没叫它** ⇒ 不回答（唤醒判定与 QQ 侧共用同一份判据）===')
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

console.log('\n=== ⑪ 管理员 `/解绑`：能解掉，且**零模型调用**；非管理员发同一形状 ⇒ 按普通聊天 ===')
{
  const { bridge, rpc, sent, WS } = wiringBridge()
  bridge.attach()
  bindUuid({ workspace: WS, uuid: UUID, name: PLAYER, qqId: ADMIN, by: 'test' })
  await bridge.handleEvent(groupMsg(GROUP, ADMIN, `/解绑 ${PLAYER}`))
  eq(lookupByUuid(WS, UUID), null, '★ 管理员解绑成功')
  eq(rpc.prompts.length, 0, '★ 解绑也是零模型调用')
  ok(/解绑了/.test(sent.at(-1)?.text ?? ''), '★ 如实回报')

  // 非管理员发同一形状：**不命中** ⇒ 回到普通聊天（不解释、不拒绝 —— 拒绝等于告诉所有人这里有后门）
  bindUuid({ workspace: WS, uuid: UUID, name: PLAYER, qqId: ADMIN, by: 'test' })
  const before = sent.length
  const r = await bridge.handleEvent(groupMsg(GROUP, '100000077', `/解绑 ${PLAYER}`))
  ok(r.reason !== 'bind-command', '★★ 非管理员发 `/解绑` ⇒ **不命中**这条通道', String(r.reason))
  eq(lookupByUuid(WS, UUID)?.qqId, ADMIN, '★★★ 绑定**没有被解掉**（非管理员解不动）')
  ok(sent.length === before, '★ 也没有任何"你没有权限"的回应（那等于告诉所有人这里有后门）')
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

console.log('\n=== ⑬ 私聊里发 `/绑定`：一句**确定性**指路，**零模型调用**（不让模型去编一套流程）===')
{
  const { bridge, rpc, sent } = wiringBridge()
  bridge.attach()
  const before = sent.length
  const r = await bridge.handleEvent({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    user_id: ADMIN,
    self_id: '200000001',
    message: [{ type: 'text', data: { text: '/绑定' } }],
    sender: { user_id: ADMIN, nickname: '主人' },
  })
  eq(rpc.prompts.length, 0, '★★★ 一次模型调用都没有（否则模型会编出一套绑定流程）')
  eq(r.reason, 'bind-command', '★ 以绑定指令结束')
  eq(sent.length, before + 1, '★ 回了一句')
  ok(/群里/.test(sent.at(-1)?.text ?? ''), '★★ 指路说清了"要在群里做"')

  // 名单外的人：**什么都不回**（fail-closed，与"群里不回"一致）
  const before2 = sent.length
  const r2 = await bridge.handleEvent({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    user_id: '999999999',
    self_id: '200000001',
    message: [{ type: 'text', data: { text: '/绑定' } }],
    sender: { user_id: '999999999', nickname: '陌生人' },
  })
  ok(r2.reason !== 'bind-command', '★★ 名单外的人**不走**绑定通道（交回普通准入判定）', String(r2.reason))
  eq(rpc.prompts.length, 0, '★ 名单外也没有模型调用')
  const strangerMsgs = sent.slice(before2).filter((x) => x.peerId === '999999999')
  eq(strangerMsgs.length, 1, '★ 只收到那句统一的"只对名单内的人开放"')
  ok(/名单/.test(strangerMsgs[0]?.text ?? ''), '★★ 而且**不是**绑定流程的指路（不泄露这里有这条路）')
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
