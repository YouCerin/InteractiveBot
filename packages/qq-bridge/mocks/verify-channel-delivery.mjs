/**
 * 通道对象化（S5）的**接线级**验收 —— C1 / C2 / C3 / C4，0.3.3。
 *
 * 执行单（`docs/0.3.3-speech-pipeline-execution.md` §S5）的四条验收：
 *   · C1 回归 E6：游戏内说话 → 只出现在游戏通道，QQ 私聊**零投递**
 *   · C2 变异：把"通道"改回"由会话键字符串推导"→ C1 必红
 *   · C3 非法 target（`qq:100000001` / `game:` 空）→ **抛错且不发送**，文案说清该填什么
 *   · C4 跨通道：开关关闭时连能力都不可用；开启后只能发白名单内目标
 *
 * ★ C2 的做法说明（与 S1 的 A2 同一条纪律：变异必须**常驻**）：
 *   这里不是"把代码改成旧写法再跑"（那需要改源码），而是构造**同一个字符串**
 *   从两个通道发出去：`game` 通道 → 公屏；`qq-private` 通道 → **当场被拒**。
 *   旧实现里"发去哪儿"由 `kind` 决定，而 `kind` 又是从字符串推的 ——
 *   所以"服务器 id 被当成 QQ 号发出去"在旧结构下**没有地方拦**。
 *   这条断言存在的意义就是：那种事现在会被拒在门口。
 *
 * 用法：node mocks/verify-channel-delivery.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Bridge } from '../src/bridge.mjs'
import { SessionRouter } from '../src/session-bridge.mjs'
import { SendQueue } from '../src/onebot.mjs'
import { normalizeConfig } from '../src/config.mjs'
import { DeliveryTargetError } from '../src/delivery-target.mjs'
import { beginDelivery } from '../src/delivery-ledger.mjs'
import { createCorpus } from '../src/corpus.mjs'

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`✅ ${name}${detail ? `  —— ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`❌ ${name}  —— ${detail}`)
  }
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

const ADMIN = '100000001'
const GROUP = '700000001'
const SERVER = {
  id: 'forge1',
  name: '主服',
  host: '127.0.0.1',
  rconPort: 25575,
  password: 'x',
  gameChat: true,
  enabled: true,
  commandFromQQ: false,
}

/** 造一个最小可用的真桥接（与 `verify-delivery-pipeline` 同一套路子）。 */
function makeBridge({ overrides = {} } = {}) {
  const WS = mkdtempSync(join(tmpdir(), 'dsh-chan-'))
  mkdirSync(join(WS, 'runtime'), { recursive: true })
  const router = new SessionRouter({ log: () => {} })
  const logs = []
  const log = (m) => logs.push(String(m))
  const rpc = new EventTarget()
  rpc.prompts = []
  rpc.prompt = async (sessionId, blocks) => {
    rpc.prompts.push(String(blocks?.[0]?.text ?? ''))
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
  const raw = {
    dsh: { workspace: WS, permissionMode: 'workspace-write' },
    onebot: {},
    access: { adminUsers: [ADMIN], dmAllowlist: [], groupAllowlist: [GROUP] },
    trigger: { private: true, mention: true, keyword: true, groupEnabled: true, keywords: ['小鲸鱼'] },
    send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
    turn: { timeoutMs: 5000 },
    humanize: { enabled: false, chunkChars: 300 },
    persona: { preset: 'none' },
    memory: { enabled: false },
    image: { enabled: false },
    servers: [{ ...SERVER }],
    ...overrides,
  }
  // ★ 走真 `normalizeConfig`：C4 的"默认关"必须在**归一化之后**成立（S1/S3 的教训）
  const config = normalizeConfig(raw)
  const bridge = new Bridge({
    rpc,
    onebot,
    sendQueue: new SendQueue({ ...config.send, log }),
    router,
    config,
    log,
    readServers: () => config.servers,
  })
  const gameCommands = []
  bridge.setGameConsoleForTest(async ({ server, command, what }) => {
    gameCommands.push({ serverId: server?.id ?? '', what, command })
    return { ok: true }
  })
  return { bridge, rpc, sent, logs, WS, config, gameCommands }
}

const catches = async (fn) => {
  try {
    await fn()
    return null
  } catch (error) {
    return error
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('① C1 游戏通道：只说公屏，QQ 通道**零投递**（E6 的常驻回归）')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, sent, gameCommands } = makeBridge()
  const r = await bridge.deliver({ channel: 'game', target: 'forge1', text: '在的，马上来' })
  check('★★★ 游戏通道投递成功', r.ok === true, JSON.stringify(r))
  check('★★★ QQ 通道**一条都没发**（这就是 E6 的回归判据）', sent.length === 0, JSON.stringify(sent))
  const says = gameCommands.filter((c) => c.what === 'say')
  check('★ 公屏恰好一条，且是 `tellraw @a`（不是 `say`）',
    says.length === 1 && String(says[0].command).startsWith('tellraw @a '), JSON.stringify(says))
  check('★★ 带 `<小鲸鱼>` 前缀', /<小鲸鱼>/.test(String(says[0]?.command ?? '')))
  check('★ 发到那台服务器上', says[0]?.serverId === 'forge1')
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('② C2 变异对照：**同一个字符串**，换个通道就发不出去（旧结构下没有地方拦）')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, sent, gameCommands } = makeBridge()
  // 同一个 `forge1`：作为游戏目标合法，作为 QQ 号非法
  const ok = await bridge.deliver({ channel: 'game', target: 'forge1', text: '走游戏' })
  const err = await catches(() => bridge.deliver({ channel: 'qq-private', target: 'forge1', text: '走 QQ' }))
  check('★★★ 作为游戏目标 → 发出去（公屏一条）', ok.ok === true && gameCommands.length === 1)
  check('★★★ 作为 QQ 目标 → **当场抛错**（旧结构里 kind 是推出来的，这里没有拦点）',
    err instanceof DeliveryTargetError, err ? `${err.name}: ${err.message}` : '（没抛）')
  check('★★★ 而且**一条都没发**（拒绝发生在发送之前）', sent.length === 0, JSON.stringify(sent))
  check('★ 错误文案说清 QQ 号该长什么样',
    /纯数字/.test(String(err?.message ?? '')), String(err?.message ?? ''))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('③ C3 非法目标：抛错 + 零投递 + 文案可操作（执行单点名的形状）')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, sent } = makeBridge()
  const cases = [
    { channel: 'qq', target: '100000001', why: '`qq` 不是可出站通道' },
    { channel: 'qq-group', target: 'group:123456', why: '把会话键塞进了 target' },
    { channel: 'game', target: '', why: 'game 的空目标' },
    { channel: 'qq-private', target: 'abc', why: 'QQ 号不是数字' },
  ]
  for (const c of cases) {
    const err = await catches(() => bridge.deliver({ channel: c.channel, target: c.target, text: 'x' }))
    check(`★ 「${c.why}」→ 抛错`, err instanceof DeliveryTargetError, err?.message ?? '（没抛）')
    check(`★ 且文案说清该填什么`, /必须|只能|不能|不要|合法值/.test(String(err?.message ?? '')),
      String(err?.message ?? '').slice(0, 60))
  }
  check('★★★ 四条非法目标之后仍然**零投递**', sent.length === 0, JSON.stringify(sent))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('④ C4 跨通道：默认关 → 白名单放行 → 白名单外拒（三连）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ④-1 默认关（归一化之后）
  {
    const { bridge, sent, logs, config } = makeBridge()
    check('★ 默认配置里跨通道是**关**的（真 normalizeConfig）',
      config.delivery.crossChannel.enabled === false && config.delivery.crossChannel.allow.length === 0)
    const err = await catches(() => bridge.deliver({
      channel: 'qq-group', target: GROUP, text: '跨过去', opts: { from: 'game' },
    }))
    check('★★★ 关着 → 抛错', err instanceof DeliveryTargetError, err?.message ?? '（没抛）')
    check('★★ 而且留了日志（安全边界不许只让调用栈说话）',
      logs.some((l) => /跨通道投递被拒/.test(l)), logs.filter((l) => /跨通道/.test(l)).join('｜') || '（没有）')
    check('★★★ 一条都没发', sent.length === 0, JSON.stringify(sent))

    // ★ 对照：**同通道**不受这个开关影响（否则关掉跨通道会连正常回复都发不出去）
    const same = await bridge.deliver({ channel: 'qq-group', target: GROUP, text: '正常回复', opts: { from: 'qq-group' } })
    check('★★ 同通道照常发（开关只管跨通道）', same.ok === true && sent.length === 1, JSON.stringify(sent))
  }

  // ④-2 开 + 白名单内
  {
    const { bridge, sent, logs } = makeBridge({
      overrides: { delivery: { crossChannel: { enabled: true, allow: [`qq-group:${GROUP}`] } } },
    })
    const r = await bridge.deliver({
      channel: 'qq-group', target: GROUP, text: '跨过去', opts: { from: 'game' },
    })
    check('★★★ 开关开 + 白名单内 → 真的发到群里', r.ok === true && sent.length === 1, JSON.stringify(sent))
    check('★ 发的是群消息（kind=group）', sent[0]?.kind === 'group' && sent[0]?.peerId === GROUP)
    check('★ 日志记下了"白名单内"（可审计）', logs.some((l) => /跨通道投递：game → qq-group/.test(l)),
      logs.filter((l) => /跨通道/.test(l)).join('｜'))
  }

  // ④-3 开 + 白名单外 / 白名单写成通道级
  {
    const { bridge, sent } = makeBridge({
      overrides: { delivery: { crossChannel: { enabled: true, allow: ['qq-group'] } } },
    })
    const err = await catches(() => bridge.deliver({
      channel: 'qq-group', target: GROUP, text: 'x', opts: { from: 'game' },
    }))
    check('★★ 白名单写成通道级（不带目标）→ **不算授权**', err instanceof DeliveryTargetError, err?.message ?? '（没抛）')
    check('★ 且零投递', sent.length === 0, JSON.stringify(sent))
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑤ console 通道：只进控制台预览，一个网络请求都不发')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, sent, gameCommands } = makeBridge()
  const r = await bridge.deliver({ channel: 'console', target: 'main', text: '自检：一切正常' })
  check('★ console 通道投递成功', r.ok === true, JSON.stringify(r))
  check('★★★ QQ 与游戏都**零投递**', sent.length === 0 && gameCommands.length === 0)
  const convs = bridge.listConversations()
  const row = (Array.isArray(convs) ? convs : []).find((c) => String(c?.chatKey ?? '') === 'console:main')
  check('★★ 进了控制台预览（`console:main` 这个会话在）', Boolean(row), JSON.stringify((convs ?? []).map?.((c) => c.chatKey)))
  check('★ 而且带上了通道字段（S5d）', row?.channel === 'console', String(row?.channel))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑥ S5d 存储：账本 / 语料都带 channel；老记录读得出来但**不回写**')
// ══════════════════════════════════════════════════════════════════════════
{
  const WS = mkdtempSync(join(tmpdir(), 'dsh-chan-store-'))
  const ticket = beginDelivery({
    workspace: WS,
    owner: 'test',
    chatKey: 'group:700000001',
    kind: 'group',
    peerId: '700000001',
    channel: 'qq-group',
    chunks: ['一'],
    log: () => {},
  })
  check('★★ 账本句柄造出来了', Boolean(ticket?.id))
  const { readLedger, LEDGER_REL } = await import('../src/delivery-ledger.mjs')
  const row = readLedger({ workspace: WS, rel: LEDGER_REL, log: () => {} }).rows.at(-1)
  check('★★★ 新账本行带 `channel`', row?.channel === 'qq-group', JSON.stringify(row))
  check('★ 老行（没有 channel）读出来是空串而不是瞎猜', row?.channel === 'qq-group')

  const corpus = createCorpus({ workspace: WS, log: () => {} })
  corpus.record({ kind: 'group', peerId: '700000001', text: '带通道的一条', channel: 'qq-group' })
  corpus.record({ kind: 'group', peerId: '700000001', text: '没给通道的一条' })
  const rows = corpus.recent({ chatKey: 'group:700000001', limit: 10, latest: true }).rows
  const withCh = rows.find((r) => r.text === '带通道的一条')
  const without = rows.find((r) => r.text === '没给通道的一条')
  check('★★★ 语料行带 `channel`', withCh?.channel === 'qq-group', String(withCh?.channel))
  check('★★ 没给的留 `null`（**不按 kind 猜**）', without?.channel === null, String(without?.channel))
  corpus.close?.()
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑦ 源码级：出站只剩**一个**出口（旁路是靠这条守住的，不是靠自觉）')
// ══════════════════════════════════════════════════════════════════════════
//
// 为什么这条属于 S5：E4 那个旁路（`#safeSend` 直接 `onebot.send`）就是这么长出来的 ——
// "某个新功能又自己发了一条"。S5 把出站统一成 `deliver()` 之后，`onebot.send(` /
// `sendQueue.run(` 在整个 `bridge.mjs` 里各自只该剩下**一处**（都在 `#deliverToQqChannel`）。
{
  const src = readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const body = strip(src)
  const sends = [...body.matchAll(/this\.onebot\.send\(/g)].length
  const runs = [...body.matchAll(/this\.sendQueue\.run\(/g)].length
  check('★★★ `this.onebot.send(` 在 bridge.mjs 里**只有一处**（QQ 通道的传输层）', sends === 1, String(sends))
  check('★★★ `this.sendQueue.run(` 也只有一处', runs === 1, String(runs))
  check('★★ 而 `this.deliver(` 是被多处用的（说明统一出口真的在承压，不是摆着）',
    [...body.matchAll(/this\.deliver\(/g)].length >= 3,
    String([...body.matchAll(/this\.deliver\(/g)].length))
}

console.log('')
if (failed === 0) {
  console.log(`🎉 通道对象化（S5 · C1–C4）全部通过（${passed} 项）`)
  console.log('   ⚠️ ② 是**变异对照**：同一个字符串在旧结构下无处可拦 —— 现在换个通道就发不出去。')
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
