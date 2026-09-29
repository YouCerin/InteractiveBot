/**
 * 表情包**端到端**测试（0.2.4）：从"模型回复"到"真的发出那张图"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这一层（前两套测试答不了的问题）
 * ══════════════════════════════════════════════════════════════════════════
 * `verify-sticker-decision.mjs` 证明的是**判定**（纯函数、83 项）。
 * 但"判定说发"到"用户真的收到图"之间还有一整套接线，而每一处都可能坏：
 *
 *   ① 判定结果有没有真的走到 `onebot.send`？（接线漏了 = 判定再对也没用）
 *   ② 发出去的是不是 `image` 段（base64），而不是又发了一次文字？
 *   ③ 只有表情、没有正文时会不会被"没有输出文字"的兜底话术顶掉？
 *   ④ **表情包发送失败会不会连累正文**？（正文已经发出去了，再报"没能发出去"
 *      是**假警报** —— 那是比图没到更糟的失败）
 *   ⑤ 发成功之后有没有记账？（不记账 ⇒ 配额形同虚设，可以一直发）
 *   ⑥ 提示词里到底有没有教这件事？（没教 ⇒ 模型永远不会主动发表情）
 *
 * 用法：node mocks/verify-sticker-e2e.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { Bridge } from '../src/bridge.mjs'
import { SendQueue } from '../src/onebot.mjs'
import { SessionRouter } from '../src/session-bridge.mjs'
import { applyStickerLabels, importStickerFiles, readStickerDecisions, readStickerLibrary } from '../src/sticker-library.mjs'
import { dailyCount, readStickerUsage } from '../src/sticker-quota.mjs'

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
const BOT = '200000001'
const liveBridges = []
/** 本次测试造出来的临时工作区（收尾时只删这些，**绝不**删整个临时目录）。 */
const tmpDirs = []

/** 8×8 PNG（真按 zlib 压，且带明暗结构 —— 纯色图的 aHash 会退化）。 */
function pngBytes(shift = 0) {
  const crcTable = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })()
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(8, 0)
  ihdr.writeUInt32BE(8, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(8 * (1 + 24))
  for (let y = 0; y < 8; y += 1) {
    const base = y * 25
    raw[base] = 0
    for (let x = 0; x < 8; x += 1) {
      const dark = x < 4 + shift
      raw[base + 1 + x * 3] = dark ? 40 : 220
      raw[base + 2 + x * 3] = dark ? 60 : 210
      raw[base + 3 + x * 3] = dark ? 200 : 240
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 造一个**真的有可用图**的工作区（走真实的导入路径，而不是手写 library.json）。 */
function seedLibrary(ws) {
  const srcDir = join(ws, 'seed-images')
  mkdirSync(srcDir, { recursive: true })
  const a = join(srcDir, 'laugh.png')
  const b = join(srcDir, 'agree.png')
  writeFileSync(a, pngBytes(0))
  writeFileSync(b, pngBytes(1))
  return importStickerFiles({ workspace: ws }, [
    // ★ scope 用**与运行期同一个形状**（`group:<群号>`）—— 目录名错了就会
    //   "导进去了但一张都选不到"，那正是这套端到端测试第一次跑出来的真 bug。
    { scope: `group:${GROUP}`, files: [a], primary: 'laugh', labels: ['laugh'], confidence: 0.9 },
    { scope: `group:${GROUP}`, files: [b], primary: 'agree', labels: ['agree'], confidence: 0.9 },
  ])
}

function makeBridge({ replies = [], stickerSendFails = false, stickerQuota = null, library = true } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'sticker-e2e-'))
  tmpDirs.push(ws)
  if (library) seedLibrary(ws)
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
    mcp: { enabled: true },
    skills: {
      sticker: {
        enabled: true,
        libraryDir: 'stickers',
        frequency: 'high',
        scoreThreshold: 2,
        maxReplyChars: 200,
        ...(stickerQuota ?? {}),
      },
    },
  }

  let turn = 0
  const rpc = new EventTarget()
  rpc.prompts = []
  rpc.prompt = async (sessionId, contentBlocks) => {
    rpc.prompts.push(String(contentBlocks?.[0]?.text ?? ''))
    const text = replies[turn] ?? replies[replies.length - 1] ?? '好的'
    turn += 1
    // ★ 必须**同时**发这两个事件：`assistant/message` 给正文、`turn/end` 收尾。
    //   只 return 一个字符串的话，桥接会一直等 `turn/end` —— 表现是
    //   "unsettled top-level await"（第一版就是这么挂住的）。
    router.handleEvent(sessionId, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } },
    })
    router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
    return { messageId: `m${turn}` }
  }
  rpc.cancel = async () => {}

  const sent = []
  const onebot = {
    // ★ 必须给 selfId：群聊的触发靠"被 @ 或命中关键词"，而 @ 的判定要拿它比对
    //   （`cqMentionsSelf(raw, selfId)`）—— 不给的话 @ 永远不成立，
    //   整套端到端断言都会因为"压根没被唤醒"而失败（第一版正是这么挂的）。
    selfId: BOT,
    send: async (kind, peerId, text, opts) => {
      const o = opts ?? {}
      // ★ 表情包是**单独一条**（正文之后补发）：模拟"图失败"就是让这一条抛
      if (o.stickerBase64) {
        if (stickerSendFails) throw new Error('图被协议端拒了（测试构造）')
        sent.push({ kind, peerId, text: String(text ?? ''), stickerBase64: o.stickerBase64, image: true })
        return { status: 'ok' }
      }
      sent.push({ kind, peerId, text: String(text ?? ''), ...o })
      return { status: 'ok' }
    },
    call: async () => ({ status: 'ok', data: {} }),
  }

  const sendQueue = new SendQueue({ ...config.send, log })
  const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log })
  liveBridges.push(bridge)
  return { bridge, rpc, onebot, sent, logs, config, ws }
}

const groupMsg = (text, messageId = null) => ({
  post_type: 'message',
  message_type: 'group',
  message_id: messageId,
  self_id: Number(BOT),
  group_id: Number(GROUP),
  user_id: Number(ADMIN),
  raw_message: `[CQ:at,qq=${BOT}] ${text}`,
  message: [
    { type: 'at', data: { qq: String(BOT) } },
    { type: 'text', data: { text: ` ${text}` } },
  ],
  time: Math.floor(Date.now() / 1000),
})

// ══════════════════════════════════════════════════════════════════════════
section('① 模型主动要：`[sticker:标签]` → 真的发出 image 段（base64）')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, sent, logs } = makeBridge({ replies: ['哈哈哈笑死我了 [sticker:laugh]'] })
  await bridge.handleEvent(groupMsg('讲个笑话', 1))
  const img = sent.find((m) => m.image)
  check('★★ 真的发出了一张图（不是又发一遍文字）', Boolean(img), JSON.stringify(sent.map((m) => (m.image ? 'image' : m.text))))
  check('★ 发的是 base64 图片段', Boolean(img?.stickerBase64?.length), `base64 ${img?.stickerBase64?.length ?? 0} 字节`)
  check('★ 标签**没有**出现在正文里（内部协议绝不外泄）',
    sent.every((m) => !String(m.text).includes('sticker')), sent.map((m) => m.text).join('｜'))
  check('标记被剥掉后正文仍然完整', sent.some((m) => m.text.includes('哈哈哈笑死我了')))
  check('日志说明了发的是哪张', logs.some((l) => l.includes('[sticker] 已发')), logs.filter((l) => l.includes('sticker')).slice(-3).join('｜'))
}

// ══════════════════════════════════════════════════════════════════════════
section('② 自主补：模型没写标签，但正文像"被逗乐" → 桥接自己补一张')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, sent } = makeBridge({ replies: ['哈哈哈哈'] })
  await bridge.handleEvent(groupMsg('你看这个', 2))
  check('★ 正文里抽得出态度 → 补一张', sent.some((m) => m.image), JSON.stringify(sent.map((m) => (m.image ? 'image' : m.text))))
  check('★ 图跟在正文**之后**（读起来是"说完了再给个表情"）',
    sent[0] && !sent[0].image && sent[1]?.image, JSON.stringify(sent.map((m) => (m.image ? 'image' : 'text'))))
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 抽不出态度 → 不补（宁可漏发），但**原因必须可查**')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, sent, ws, logs } = makeBridge({ replies: ['我把配置改好了，重启一下就行。'] })
  await bridge.handleEvent(groupMsg('改好了吗', 3))
  check('★ 平铺直叙的回复 → 一张图都不发', !sent.some((m) => m.image), JSON.stringify(sent))
  // ★ 判据是**决策流水**（用户与控制台真正会去看的那个持久通道）：
  //   桥接日志是当下的，流水是"这三天为什么不发"能回溯的。
  const decisions = readStickerDecisions({ workspace: ws, dir: 'stickers' }, 10)
  check('★ 决策流水里记了"不发"与原因（可回溯）',
    decisions.some((d) => d.action === 'skip' && String(d.reason ?? '').includes('抽不出态度')),
    JSON.stringify(decisions[0] ?? null))
  check('日志里也留了一行（当下就能看到）',
    logs.some((l) => l.includes('[sticker] 不发')), logs.filter((l) => l.includes('[sticker]')).join('｜'))
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 硬否决：模型主动要也不发（道歉/求助场景）')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, sent } = makeBridge({ replies: ['抱歉，这个我做不了 [sticker:laugh]'] })
  await bridge.handleEvent(groupMsg('你能帮我弄吗', 4))
  check('★ 道歉 + 权限被拒 → 图被拦下', !sent.some((m) => m.image), JSON.stringify(sent.map((m) => (m.image ? 'image' : m.text))))
  check('正文照常发出（拦的是图，不是整条回复）', sent.some((m) => m.text.includes('抱歉')))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 只有表情、没有正文 → 仍然发得出去（不会被兜底话术顶掉）')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, sent } = makeBridge({ replies: ['[sticker:laugh]'] })
  await bridge.handleEvent(groupMsg('哈哈', 5))
  check('★★ 只写了标签 → 真的只发了一张图', sent.length === 1 && sent[0].image === true, JSON.stringify(sent.map((m) => (m.image ? 'image' : m.text))))
  check('★ 没有出现"这次没有产生回复内容"这种兜底话术',
    !sent.some((m) => String(m.text).includes('没有产生回复内容')), JSON.stringify(sent.map((m) => m.text)))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ ★★ 图发失败**绝不连累正文**（假警报比图没到更糟）')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, sent, logs } = makeBridge({ replies: ['哈哈哈哈'], stickerSendFails: true })
  const r = await bridge.handleEvent(groupMsg('再讲一个', 6))
  check('★ 正文发出去了', sent.some((m) => !m.image && m.text.includes('哈哈哈哈')))
  check('★★ 没有"我这边没能把回复发出去"这种假警报',
    !sent.some((m) => String(m.text).includes('没能把回复发出去')), JSON.stringify(sent.map((m) => m.text)))
  check('本轮不算发送失败', r?.reason !== 'send-failed', JSON.stringify(r))
  check('★ 但**必须留痕**（图没到是事实，不能静默）',
    logs.some((l) => l.includes('[sticker] 表情包没能发出去')), logs.filter((l) => l.includes('sticker')).join('｜'))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ 发成功要记账（否则配额形同虚设）')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, ws } = makeBridge({ replies: ['哈哈哈哈'] })
  await bridge.handleEvent(groupMsg('来一个', 7))
  const usage = readStickerUsage({ workspace: ws, dir: 'stickers' })
  check('★ 用量台账记了一笔', dailyCount(usage, `group:${GROUP}`, Date.now()) === 1,
    JSON.stringify(usage.scopes))
  const lib = readStickerLibrary({ workspace: ws, dir: 'stickers' })
  const used = Object.values(lib.entries).filter((e) => e.usedCount > 0)
  check('★ 库里的图也记了使用次数', used.length === 1, JSON.stringify(used.map((e) => [e.primary, e.usedCount])))
  check('★ 每会话独立计时（跨群不复用同一套冷却）', Boolean(used[0]?.lastUsedByScope))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑧ 配额：连着几轮不再发（这条只能端到端验）')
// ══════════════════════════════════════════════════════════════════════════
{
  // medium 档：每 2 轮最多 1 次 + 30 秒最小间隔 —— 用它来验"第二轮不再发"
  //
  // ⚠️ 两轮的正文**必须不同**：桥接有一条"刚说过的内容完全相同时直接跳过"的去重
  //    （`#lastDelivered`），两轮都说"哈哈哈哈"时第二轮**根本走不到表情判定** ——
  //    那样测的就不是配额了（第一次跑正是这么误判的）。
  const { bridge, sent, logs } = makeBridge({
    replies: ['哈哈哈哈', '哈哈哈哈哈'],
    stickerQuota: { frequency: 'medium' },
  })
  await bridge.handleEvent(groupMsg('第一句', 8))
  const afterFirst = sent.filter((m) => m.image).length
  await bridge.handleEvent(groupMsg('第二句', 9))
  const afterSecond = sent.filter((m) => m.image).length
  check('★ 第一轮发了', afterFirst === 1, String(afterFirst))
  check('★★ 第二轮被配额拦住（30 秒最小间隔）', afterSecond === 1, `累计 ${afterSecond} 张`)
  check('★ 拦下来的原因写进了日志', logs.some((l) => l.includes('配额')), logs.filter((l) => l.includes('[sticker]')).slice(-2).join('｜'))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑨ 库里没图 → 一次都不发，且**不承诺做不到的事**')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, sent, rpc } = makeBridge({ replies: ['哈哈哈哈 [sticker:laugh]'], library: false })
  await bridge.handleEvent(groupMsg('讲个笑话', 10))
  check('★ 没图 → 不发', !sent.some((m) => m.image))
  check('正文照常（标签被剥掉）', sent.some((m) => m.text.includes('哈哈哈哈')))
  const prompt = rpc.prompts[0] ?? ''
  check('★★ 提示词里**一个字都不提** `[sticker:`（没有的东西不许教）',
    !prompt.includes('[sticker:'), prompt.slice(0, 120))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑩ 有图时提示词必须教（否则模型永远不知道能发表情）')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, rpc } = makeBridge({ replies: ['好的'] })
  await bridge.handleEvent(groupMsg('随便说点', 11))
  const prompt = rpc.prompts[0] ?? ''
  check('★ 教了写法', prompt.includes('[sticker:'), prompt.includes('laugh') ? '（含 laugh）' : '')
  check('★ 教了**真有货**的标签（laugh / agree）',
    prompt.includes('laugh') && prompt.includes('agree'), prompt.match(/可用的表情包标签：[^\n]*/)?.[0] ?? '（没找到那行）')
  check('★ 说明了"标签不会作为文字发出去"', prompt.includes('永远不会作为文字发出去'))
  check('★ 人设段说明了分寸（不带标签清单）',
    prompt.includes('宁可整轮不发') && !prompt.includes('可用的表情包标签：laugh（笑死）\n可用的表情包标签'),
    '')
}

// ══════════════════════════════════════════════════════════════════════════
section('⑪ 关掉技能 → 提示词与发送同时消失')
// ══════════════════════════════════════════════════════════════════════════
{
  const { bridge, sent, rpc } = makeBridge({ replies: ['哈哈哈哈 [sticker:laugh]'] })
  bridge.config.skills.sticker.enabled = false
  await bridge.handleEvent(groupMsg('讲个笑话', 12))
  check('★ 关掉后一张图都不发', !sent.some((m) => m.image))
  check('★ 提示词里也不再提这件事', !(rpc.prompts[0] ?? '').includes('[sticker:'))
}

for (const b of liveBridges) {
  try {
    await b.close?.()
  } catch {
    /* 收尾失败不影响结论 */
  }
}
for (const d of tmpDirs) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {
    /* Windows 上偶尔删不掉（句柄没放），留着不影响结论 */
  }
}
console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
