/**
 * 服务器控制台**管理员硬闸**测试（0.3.2 收尾）—— `runMcCommand`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套存在的理由（这是本轮最该被钉住的东西）
 * ══════════════════════════════════════════════════════════════════════════
 * 它守的是 **op 级别的服务器权限**（`op` / `ban` / `stop`）。
 * 需求原话是「让 bot 执行指令（**仅听从管理员**）」—— 那么"仅听从管理员"必须是
 * **运行时**判据，而不是提示词里的一句请求。所以这里的断言全是"没授权就不许动"：
 *
 *   ① **没有授权文件 ⇒ 拒绝**（且**一次 RCON 连接都不发起**）；
 *   ② **授权是"user"档 ⇒ 拒绝**（普通人的那一轮不能顺带获得权限）；
 *   ③ **会话隔离**：A 会话的授权不能给 B 会话用（同截图那条教训）；
 *   ④ **域隔离**：截图的授权**不能**当 MC 的用（反之亦然）——
 *      否则"截图开着的会话"顺带拿到 op；
 *   ⑤ **过期 ⇒ 拒绝**；
 *   ⑥ **服务器没开 `commandFromQQ` ⇒ 拒绝**（默认关，危险能力默认关）；
 *   ⑦ **没指明哪一台 / 认不出的 id ⇒ 拒绝，且不猜**；
 *   ⑧ **密码绝不出现在任何返回文本里**（含拒绝路径）。
 *
 * ★ 全程不连真服务端：RCON 客户端是**注入的桩**；授权文件是**真临时文件**
 *   （这一层的正确性恰恰在文件读写与域名字上）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runMcCommand, MAX_COMMAND_CHARS } from '../src/servers/command-gate.mjs'
import { grantFileName, GRANT_SCOPE, writeGrant, readGrant, clearGrant, GRANTS_DIR, SHOTS_DIR, GRANT_TTL_MS } from '../src/screenshot-grant.mjs'
import { TIER } from '../src/roster.mjs'

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
  ok(a === b, label, a === b ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`)
}

const mkWs = () => mkdtempSync(join(tmpdir(), 'qqb-mcgate-'))
const PW = 'rcon-pw-must-not-leak'

/** 一台"什么都配好了、也开了 commandFromQQ"的服务器 */
const srv = (over = {}) => ({
  id: 's1',
  name: '主服',
  host: '127.0.0.1',
  port: 25565,
  rconPort: 25575,
  password: PW,
  enabled: true,
  commandFromQQ: true,
  ...over,
})
const cfg = (servers) => ({ servers })

/** 注入的 RCON 桩：记录被调用了几次（**"一次都没连"是重要断言**） */
function fakeClient({ failConnect = false, body = '' } = {}) {
  const seen = { connects: 0, commands: [], closes: 0 }
  return {
    seen,
    factory: () => ({
      connect: async () => {
        seen.connects += 1
        return failConnect ? { ok: false, layer: 'network', text: '连不上那个 RCON 端口' } : { ok: true }
      },
      exec: async (cmd) => {
        seen.commands.push(cmd)
        return { ok: true, body }
      },
      close: () => {
        seen.closes += 1
      },
    }),
  }
}

// 写一份"这一轮管理员"的 MC 授权（用真实现，顺带把 writeGrant 也测了）
function grantMc(ws, peerKey, tier = TIER.ADMIN) {
  return writeGrant({
    workspace: ws,
    peerKey,
    kind: peerKey.split(':')[0],
    peerId: peerKey.split(':')[1],
    senderId: '100000001',
    tier,
    config: cfg([srv()]),
    scope: GRANT_SCOPE.mc,
  })
}

console.log('\n=== ① 会话键与文件名：MC 域**必须**与截图域分开 ===')
{
  const k = 'group:700000001'
  const shot = grantFileName(k)
  const mc = grantFileName(k, GRANT_SCOPE.mc)
  ok(shot !== mc, '★ 同一个会话，两个域的文件名不同（否则会互相覆盖）')
  ok(mc.startsWith('mc-'), '★ MC 域有 `mc-` 前缀', mc)
  eq(grantFileName(k, 'screenshot'), shot, '★★ 截图域**逐字不变**（技能侧那份实现因此仍然正确）')
}

console.log('\n=== ② 没有授权 ⇒ 拒绝，且**一次 RCON 连接都不发起** ===')
{
  const ws = mkWs()
  mkdirSync(join(ws, GRANTS_DIR, 'mc'), { recursive: true })
  const c = fakeClient()
  const r = await runMcCommand({
    workspace: ws,
    kind: 'group',
    peerId: '700000001',
    serverId: 's1',
    command: 'op 某人',
    config: cfg([srv()]),
    clientFor: c.factory,
    sleep: async () => {},
  })
  eq(r.ok, false, '★★★ 没有授权文件 ⇒ 拒绝')
  eq(c.seen.connects, 0, '★★★ 而且**一次连接都没发起**（判权限在碰网络之前）')
  ok(/只有管理员/.test(r.text), '理由说清"只有管理员能下"', r.text.slice(0, 80))
  ok(!JSON.stringify(r).includes(PW), '★★★ 拒绝文本里没有密码')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ③ 非管理员 ⇒ 拒绝（两条路都要堵：没写文件 / 文件在但不是 admin）===')
{
  // ③-a 真实路径：非管理员那一轮**根本不会写文件** ⇒ 状态是 missing
  const ws = mkWs()
  const w = grantMc(ws, 'group:700000002', TIER.USER)
  eq(w.ok, false, '★★★ 非管理员那一轮**不写授权文件**（"仅听从管理员"的落地点）')
  const c = fakeClient()
  const r = await runMcCommand({
    workspace: ws,
    kind: 'group',
    peerId: '700000002',
    serverId: 's1',
    command: 'op 某人',
    config: cfg([srv()]),
    clientFor: c.factory,
    sleep: async () => {},
  })
  eq(r.ok, false, '★★★ 非管理员那一轮 ⇒ 拒绝')
  eq(c.seen.connects, 0, '★★ 且没有发起连接')
  ok(/只有管理员/.test(r.text), '★ 理由说清"只有管理员能下"', r.text.slice(0, 90))
  ok(!JSON.stringify(r).includes(PW), '★★★ 拒绝文本里没有密码')
  rmSync(ws, { recursive: true, force: true })

  // ③-b 防御性路径：文件**存在**但 tier 不是 admin（被改坏 / 旧版本留下的）
  const ws2 = mkWs()
  const dir = join(ws2, GRANTS_DIR, 'mc')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, grantFileName('group:700000003', GRANT_SCOPE.mc)),
    JSON.stringify({ kind: 'group', peerId: '700000003', senderId: '9', tier: TIER.USER, scope: 'mc', at: Date.now(), exp: Date.now() + 60_000 }),
    'utf8',
  )
  const c2 = fakeClient()
  const r2 = await runMcCommand({
    workspace: ws2,
    kind: 'group',
    peerId: '700000003',
    serverId: 's1',
    command: 'op 某人',
    config: cfg([srv()]),
    clientFor: c2.factory,
    sleep: async () => {},
  })
  eq(r2.ok, false, '★★★ 文件在、但 tier=user ⇒ **也拒绝**（不只看"文件在不在"）')
  eq(c2.seen.connects, 0, '★★ 没有发起连接')
  ok(/不是管理员/.test(r2.text), '★ 理由说清"这一轮的说话人不是管理员"', r2.text.slice(0, 90))
  // ★★ 这句是给**模型**看的：必须明确"不要重试、不要绕"，否则它会换着说法反复试
  ok(/不要重试/.test(r2.text) && /绕过/.test(r2.text), '★★★ 明确告诉模型"不要重试、不要用别的方式绕过"', r2.text.slice(0, 130))
  rmSync(ws2, { recursive: true, force: true })
}

console.log('\n=== ④ 会话隔离：A 会话的授权不能给 B 会话用 ===')
{
  const ws = mkWs()
  grantMc(ws, 'group:700000001') // 只有 A 有授权
  const c = fakeClient()
  const r = await runMcCommand({
    workspace: ws,
    kind: 'group',
    peerId: '999999999', // B
    serverId: 's1',
    command: 'list',
    config: cfg([srv()]),
    clientFor: c.factory,
    sleep: async () => {},
  })
  eq(r.ok, false, '★★★ 另一个会话拿不到授权（按会话，不是全局）')
  eq(c.seen.connects, 0, '★ 没有发起连接')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑤ 域隔离：截图的授权**不能**当 MC 的用 ===')
{
  const ws = mkWs()
  // 写一份**截图域**的管理员授权（配置里截图是开着的）
  const shotWrite = writeGrant({
    workspace: ws,
    peerKey: 'group:700000001',
    kind: 'group',
    peerId: '700000001',
    senderId: '100000001',
    tier: TIER.ADMIN,
    config: { skills: { screenshot: { enabled: true } }, servers: [srv()] },
    scope: GRANT_SCOPE.screenshot,
  })
  eq(shotWrite.ok, true, '（准备）截图域授权写成功')
  const c = fakeClient()
  const r = await runMcCommand({
    workspace: ws,
    kind: 'group',
    peerId: '700000001',
    serverId: 's1',
    command: 'op 某人',
    config: cfg([srv()]),
    clientFor: c.factory,
    sleep: async () => {},
  })
  eq(r.ok, false, '★★★ 截图域的授权**不能**换来 MC 权限（否则"截图开着"顺带给了 op）')
  eq(c.seen.connects, 0, '★★ 没有发起连接')
  // 对照：截图域自己的授权**仍然有效**（域隔离没有把截图弄坏）
  eq(readGrant({ workspace: ws, peerKey: 'group:700000001', scope: GRANT_SCOPE.screenshot }).state, 'ok', '（对照）截图域自己的授权仍然有效')
  // MC 域写一份，两份**互不覆盖**
  const mcWrite = grantMc(ws, 'group:700000001')
  eq(mcWrite.ok, true, '（准备）MC 域授权写成功')
  eq(readGrant({ workspace: ws, peerKey: 'group:700000001', scope: GRANT_SCOPE.mc }).state, 'ok', '（对照）MC 域自己写的那份被认')
  // ★ 两个域现在住**两个目录**（MC 在 `.grants/mc/`，不挤在 screenshots/ 里）
  const mcFiles = readdirSync(join(ws, GRANTS_DIR, 'mc'))
  const shotFiles = readdirSync(join(ws, SHOTS_DIR, GRANTS_DIR))
  eq(mcFiles.length, 1, '★ MC 域目录里只有 MC 那份', mcFiles.join(', '))
  eq(shotFiles.length, 1, '★ 截图域目录里只有截图那份（互不覆盖、互不污染）', shotFiles.join(', '))
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑥ 过期 ⇒ 拒绝；清掉 ⇒ 拒绝 ===')
{
  const ws = mkWs()
  writeGrant({
    workspace: ws,
    peerKey: 'group:700000001',
    kind: 'group',
    peerId: '700000001',
    senderId: '100000001',
    tier: TIER.ADMIN,
    config: cfg([srv()]),
    scope: GRANT_SCOPE.mc,
    now: 1000,
  })
  const c = fakeClient()
  const expired = await runMcCommand({
    workspace: ws,
    kind: 'group',
    peerId: '700000001',
    serverId: 's1',
    command: 'list',
    config: cfg([srv()]),
    clientFor: c.factory,
    sleep: async () => {},
    now: 1000 + GRANT_TTL_MS + 1,
  })
  eq(expired.ok, false, '★★★ 过期 ⇒ 拒绝')
  eq(c.seen.connects, 0, '★ 没有发起连接')
  ok(/过期/.test(expired.text), '理由说清"过期了，请重新发一条消息"')

  clearGrant({ workspace: ws, peerKey: 'group:700000001', scope: GRANT_SCOPE.mc })
  const afterClear = await runMcCommand({
    workspace: ws,
    kind: 'group',
    peerId: '700000001',
    serverId: 's1',
    command: 'list',
    config: cfg([srv()]),
    clientFor: c.factory,
    sleep: async () => {},
  })
  eq(afterClear.ok, false, '★★★ 回合结束清掉之后 ⇒ 拒绝（陈旧授权 = 提权）')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑦ 这台服务器没开 commandFromQQ ⇒ 拒绝（默认关）===')
{
  const ws = mkWs()
  grantMc(ws, 'group:700000001')
  const c = fakeClient()
  const r = await runMcCommand({
    workspace: ws,
    kind: 'group',
    peerId: '700000001',
    serverId: 's1',
    command: 'list',
    config: cfg([srv({ commandFromQQ: false })]),
    clientFor: c.factory,
    sleep: async () => {},
  })
  eq(r.ok, false, '★★★ 服务器自己没打开这个开关 ⇒ 拒绝（**管理员授权也不够**）')
  eq(c.seen.connects, 0, '★ 没有发起连接')
  ok(/commandFromQQ/.test(r.text), '理由直接指出那个开关名')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑧ 没指明哪一台 / 认不出的 id ⇒ 拒绝且不猜 ===')
{
  const ws = mkWs()
  grantMc(ws, 'group:700000001')
  const c = fakeClient()
  const noId = await runMcCommand({
    workspace: ws,
    kind: 'group',
    peerId: '700000001',
    serverId: '',
    command: 'list',
    config: cfg([srv()]),
    clientFor: c.factory,
    sleep: async () => {},
  })
  eq(noId.ok, false, '★★ 没给 serverId ⇒ 拒绝（不猜）')
  const badId = await runMcCommand({
    workspace: ws,
    kind: 'group',
    peerId: '700000001',
    serverId: 'nope',
    command: 'list',
    config: cfg([srv()]),
    clientFor: c.factory,
    sleep: async () => {},
  })
  eq(badId.ok, false, '★★ 认不出的 id ⇒ 拒绝')
  ok(/s1/.test(badId.text), '★ 并列出真实存在的 id（让人知道下一步怎么办）', badId.text.slice(0, 90))
  eq(c.seen.connects, 0, '★ 两次都没有发起连接')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑨ 空命令 / 超长命令 ⇒ 拒绝 ===')
{
  const ws = mkWs()
  grantMc(ws, 'group:700000001')
  const c = fakeClient()
  eq((await runMcCommand({ workspace: ws, kind: 'group', peerId: '700000001', serverId: 's1', command: '   ', config: cfg([srv()]), clientFor: c.factory, sleep: async () => {} })).ok, false, '空命令 ⇒ 拒绝')
  eq((await runMcCommand({ workspace: ws, kind: 'group', peerId: '700000001', serverId: 's1', command: 'x'.repeat(MAX_COMMAND_CHARS + 1), config: cfg([srv()]), clientFor: c.factory, sleep: async () => {} })).ok, false, '超长命令 ⇒ 拒绝')
  eq(c.seen.connects, 0, '★ 都没有发起连接')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑩ 管理员这一轮 ⇒ **真的执行**，且把输出与那句如实提醒带回来 ===')
{
  const ws = mkWs()
  grantMc(ws, 'group:700000001')
  const c = fakeClient({ body: 'There are 0 of a max of 20 players online:' })
  const r = await runMcCommand({
    workspace: ws,
    kind: 'group',
    peerId: '700000001',
    serverId: 's1',
    command: 'list',
    config: cfg([srv()]),
    clientFor: c.factory,
    sleep: async () => {},
  })
  eq(r.ok, true, '★★★ 管理员这一轮 ⇒ 放行')
  eq(c.seen.connects, 1, '★ 连了一次')
  eq(c.seen.commands.length, 1, '★★ 只发了一条命令')
  eq(c.seen.commands[0], 'list', '★★ 命令**原样**发给服务端（没有被改写）')
  ok(String(r.reply).includes('players online'), '★ 带回 RCON 回话')
  ok(typeof r.caveat === 'string' && r.caveat.includes('不保证'), '★★ 带回那句"输出不保证只属于这条命令"')
  ok(!JSON.stringify(r).includes(PW), '★★★ 成功路径里也没有密码')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑪ 连不上 / 抛异常 ⇒ 如实失败（永不抛）===')
{
  const ws = mkWs()
  grantMc(ws, 'group:700000001')
  const bad = fakeClient({ failConnect: true })
  const r1 = await runMcCommand({ workspace: ws, kind: 'group', peerId: '700000001', serverId: 's1', command: 'list', config: cfg([srv()]), clientFor: bad.factory, sleep: async () => {} })
  eq(r1.ok, false, '连不上 ⇒ 失败')
  ok(!JSON.stringify(r1).includes(PW), '★ 失败文本里没有密码')

  const r2 = await runMcCommand({
    workspace: ws,
    kind: 'group',
    peerId: '700000001',
    serverId: 's1',
    command: 'list',
    config: cfg([srv()]),
    clientFor: () => ({
      connect: async () => {
        throw new Error('连接炸了')
      },
      exec: async () => ({ ok: true }),
      close: () => {},
    }),
    sleep: async () => {},
  })
  eq(r2.ok, false, '★★ 抛异常也如实失败（**永不抛**，增强路径纪律）')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑫ writeGrant 的 MC 域开关：默认不写，开了才写 ===')
{
  const ws = mkWs()
  const base = { workspace: ws, peerKey: 'group:1', kind: 'group', peerId: '1', senderId: '100000001', scope: GRANT_SCOPE.mc }
  const off = writeGrant({ ...base, tier: TIER.ADMIN, config: cfg([srv({ commandFromQQ: false })]) })
  eq(off.ok, false, '★★ 没有任何服务器开 commandFromQQ ⇒ 不写（默认关）')
  ok(!existsSync(join(ws, GRANTS_DIR, 'mc')), '★★ 而且**工作区里不留文件**')
  const notAdmin = writeGrant({ ...base, tier: TIER.USER, config: cfg([srv()]) })
  eq(notAdmin.ok, false, '★★★ 说话人不是管理员 ⇒ 不写（**这是"仅听从管理员"的落地点**）')
  const on = writeGrant({ ...base, tier: TIER.ADMIN, config: cfg([srv()]) })
  eq(on.ok, true, '★ 管理员 + 有一台开着 ⇒ 写')
  const body = JSON.parse(readFileSync(on.file, 'utf8'))
  eq(body.tier, 'admin', '★ 文件里记的是 admin')
  eq(body.scope, 'mc', '★★ 文件里标了 scope=mc（域隔离的依据）')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑬ ★★★ 接线级：`/mc` 本地指令通道走**完整桥接**（纯函数测不到接线）===')
//
// 为什么这一节不能省：`#handleMcLocalCommand` 的**位置**才是关键 ——
// 它必须在**语义唤醒闸门之前**且**命中即 return**。放错地方会静默失效
// （命令白下且不报错），而那种错**纯函数断言一条都抓不到**。
{
  const { Bridge } = await import('../src/bridge.mjs')
  const { SessionRouter } = await import('../src/session-bridge.mjs')
  const { SendQueue } = await import('../src/onebot.mjs')

  const ADMIN = '100000001'
  const GROUP = '700000001'

  function wiringBridge({ commandFromQQ = true } = {}) {
    const ws = mkdtempSync(join(tmpdir(), 'qqb-mcwiring-'))
    const router = new SessionRouter({ log: () => {} })
    const logs = []
    const log = (m) => logs.push(String(m))
    const config = {
      dsh: { workspace: ws, permissionMode: 'workspace-write' },
      onebot: {},
      access: { adminUsers: [ADMIN], dmAllowlist: [], groupAllowlist: [GROUP] },
      trigger: { private: true, mention: true, keyword: true, groupEnabled: true, keywords: ['小鲸鱼'] },
      send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
      turn: { timeoutMs: 5000 },
      humanize: { enabled: false, chunkChars: 300 },
      persona: { preset: 'none' },
      memory: { enabled: false },
      image: { enabled: false },
      servers: [srv({ commandFromQQ })],
    }
    const rpc = new EventTarget()
    rpc.prompts = []
    rpc.prompt = async (sessionId) => {
      rpc.prompts.push(sessionId)
      router.handleEvent(sessionId, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '（模型回的话）' }] } },
      })
      router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
      return { messageId: 'm1' }
    }
    const onebot = new EventTarget()
    onebot.selfId = '200000001'
    onebot.call = async () => ({ status: 'ok', retcode: 0, data: null })
    const sent = []
    onebot.send = async (kind, peerId, text) => {
      sent.push({ kind, peerId, text })
      return { status: 'ok', retcode: 0, data: { message_id: `s${sent.length}` } }
    }
    const sendQueue = new SendQueue({ ...config.send, log })
    const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log })
    return { bridge, rpc, sent, logs, ws }
  }

  // ★ 这里刻意**不造群消息**：群里没 @ 机器人时消息走不到本地指令通道（`no-trigger`），
  //   所以测的是通道本身（`handleMcLocalCommandForTest`）。

  // ── ① 管理员发 `/mc list` ⇒ 命中并执行；**不经模型** ──
  //
  // ★★ 为什么不直接"发一条群消息"来测：**群里没 @ 机器人时消息根本走不到这里**
  //   （`no-trigger`，见 `trigger.mjs`）—— 那是既有设计，不是缺陷。
  //   所以这里直接打这条通道，断言"命中之后不经模型 + 回话如实 + 授权被清"。
  {
    const { bridge, rpc, sent, ws } = wiringBridge()
    const r = await bridge.handleMcLocalCommandForTest({
      text: '/mc list',
      kind: 'group',
      peerId: GROUP,
      senderId: ADMIN,
      tier: TIER.ADMIN,
    })
    eq(r.matched, true, '★★★ 管理员发 `/mc list` ⇒ 命中这条通道')
    eq(rpc.prompts.length, 0, '★★★ 而且**一次 session/prompt 都没有**（命中即返回，不经模型）')
    ok(sent.length >= 1, '★ 确实回了一条（无论是执行成功还是被拒，都要如实说）', JSON.stringify(sent.map((s) => s.text.slice(0, 50))))
    const g = readGrant({ workspace: ws, peerKey: `group:${GROUP}`, scope: GRANT_SCOPE.mc })
    eq(g.state, 'missing', '★★★ 这条通道**不写授权**（授权是跑模型前写的）⇒ 它必须走闸，于是被拒')
    ok(/只有管理员|授权/.test(sent.map((s) => s.text).join('\n')), '★★ 回话如实说了"没授权"（不是假装执行了）')
    await bridge.close({ timeoutMs: 300 })
    rmSync(ws, { recursive: true, force: true })
  }

  // ── ② **非管理员**发同样的话 ⇒ `matched:false`（当作普通聊天，不执行也不解释）──
  {
    const { bridge, sent, ws } = wiringBridge()
    const r = await bridge.handleMcLocalCommandForTest({
      text: '/mc list',
      kind: 'group',
      peerId: GROUP,
      senderId: '888888',
      tier: TIER.USER,
    })
    eq(r.matched, false, '★★★ 非管理员 ⇒ **不当成指令**（返回 notMatched，照常走普通聊天）')
    eq(sent.length, 0, '★★★ 而且**一句话都没回** —— 解释/拒绝等于告诉所有人这里有个后门')
    await bridge.close({ timeoutMs: 300 })
    rmSync(ws, { recursive: true, force: true })
  }

  // ── ③ 只是**提到** `/mc` ⇒ 不当成指令（形状判据不能过宽）──
  {
    const { bridge, sent, ws } = wiringBridge()
    const r = await bridge.handleMcLocalCommandForTest({
      text: '我刚看到有人聊 /mc 这个命令',
      kind: 'group',
      peerId: GROUP,
      senderId: ADMIN,
      tier: TIER.ADMIN,
    })
    eq(r.matched, false, '★★ 只是提到 `/mc` ⇒ 不命中（必须以 `/mc` 作为一个词开头）')
    eq(sent.length, 0, '★ 也没回话')
    await bridge.close({ timeoutMs: 300 })
    rmSync(ws, { recursive: true, force: true })
  }

  // ── ④ 多台服务器且没给 id ⇒ 报错不猜（且**不经模型**）──
  {
    const { bridge, rpc, sent, ws } = wiringBridge()
    bridge.config.servers = [srv(), srv({ id: 's2', name: '第二台' })]
    const r = await bridge.handleMcLocalCommandForTest({
      text: '/mc list',
      kind: 'group',
      peerId: GROUP,
      senderId: ADMIN,
      tier: TIER.ADMIN,
    })
    eq(r.matched, true, '（前提）命中通道')
    eq(rpc.prompts.length, 0, '★ 仍然不经模型')
    const said = sent.map((s) => s.text).join('\n')
    ok(/必须指明|有：/.test(said), '★★ 多台且没给 id ⇒ **报错并列出可选项**（不猜）', said.slice(0, 110))
    await bridge.close({ timeoutMs: 300 })
    rmSync(ws, { recursive: true, force: true })
  }
}

console.log('')
if (fail === 0) {
  console.log(`🎉 服务器控制台管理员闸测试：${pass} 项通过`)
  process.exitCode = 0
} else {
  console.log(`❌ 服务器控制台管理员闸测试：${pass} 项通过、${fail} 项失败`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
