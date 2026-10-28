/**
 * 「先应一声」的**真实链路**测试（0.3.3 新增）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么单独一套、为什么**必须**走真 config 模块 + 真 HTTP
 * ══════════════════════════════════════════════════════════════════════════
 * 这个功能上线后第一次实测就是**「实装失败」** —— 而当时 `verify-units.mjs` 与
 * `verify-memory-roundtrip.mjs` 里的 interim 断言**全是绿的**。原因很具体：
 *
 *   · 那两套都**注入桩**（`bridge.interimAiInjected`）并手搓 config 字面量；
 *   · 而缺陷在**配置归一化**那一层：
 *     `timeoutMs: Number.isFinite(Number(x)) ? Math.max(200, Number(x)) : 0`
 *     —— `Number(0)` 是有限数，于是 **`0`（= 自动）被夹成 `200ms`**，
 *     与文档「0 = 自动」正面矛盾。每次生成都在 200ms 被掐断，
 *     垫场白**永远**退回话术池，使用者看到的就是"配了也没用"。
 *
 * ∴ 这一套的判据刻意**绕过一切桩**：
 *   ① 配置必须经 **`normalizeConfig()`**（真模块）；
 *   ② 一次生成必须真的打到一个**本地假 HTTP API**（`createServer`）上 ——
 *      这样"200ms 被掐断"这种事才**看得见**（假 API 会记录请求是否被 abort）；
 *   ③ 断言落到**发出去的那句话**上（不是内部状态）。
 *
 * ⚠️ 别把这里的 HTTP 换成桩：换回去就等于把这条防线删掉，而它抓的正是
 *    "所有桩测试都绿、真机上完全不工作"那一类缺陷。
 *
 * ★★ 2026-10-18 第二次自检又靠这一套抓到第二处（见 ⑥）：`INTERIM_AI_PROMPT`
 *    （"输出一行 JSON"的契约）**导出了却从来没有被送出去**，模型只看到对话、
 *    于是直接回答用户 —— 真机日志里连续 5 次 `不是 JSON 且是多行`，全部退回话术池。
 *    而当时的假 API **不管收到什么都回 JSON**（它比真模型"配合"得多），
 *    所以 ② 一直是绿的 —— **假服务端形状错了比没有测试更坏**。
 *    现在假 API **按提示词回话**：收到契约才回 JSON，没收到就像真模型那样答题。
 *
 * 用法：node mocks/verify-interim.mjs
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

import { Bridge } from '../src/bridge.mjs'
import { SessionRouter } from '../src/session-bridge.mjs'
import { SendQueue } from '../src/onebot.mjs'
import { normalizeConfig, validateConfig } from '../src/config.mjs'
import { createCorpus } from '../src/corpus.mjs'
import {
  DEFAULT_INTERIM,
  INTERIM_AI_PROMPT,
  parseInterimAiOutput,
  withContract,
  composeInterimPrompt,
  createInterimAi,
} from '../src/interim.mjs'

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个**本地假 API**：故意慢 `delayMs`，并记录请求有没有被客户端提前掐断。 */
function startFakeApi({ delayMs = 1200, reply = '{"say":"在的在的，我瞄一眼"}', replyFor = null } = {}) {
  const hits = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      const rec = { at: Date.now(), aborted: false, body }
      hits.push(rec)
      // ★★ 默认**按提示词回话**（像真模型一样）：没带 JSON 契约时模型会直接答题，
      //    返回多行散文。这样"契约没送出去"在 ② 里就会红，而不是被假 API 糊过去。
      const text = typeof replyFor === 'function' ? replyFor(body) : reply
      const t = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }))
      }, delayMs)
      // 客户端提前断开 = 生成被 abort ⇒ 记下来（"超时被砍"的唯一证据）
      const markAborted = () => {
        if (res.writableEnded) return
        clearTimeout(t)
        rec.aborted = true
      }
      req.on('aborted', markAborted)
      res.on('close', markAborted)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port }))
  })
}

/** 用**真 config 模块**造一份配置（缺陷就在归一化里，所以这一步不许手搓）。 */
function makeRealConfig({ workspace, port, interim = {}, judge = {}, trigger = null, access = null } = {}) {
  return normalizeConfig({
    dsh: { workspace, permissionMode: 'workspace-write' },
    onebot: {},
    access: {
      adminUsers: ['10001'],
      dmAllowlist: [],
      groupAllowlist: [],
      ...(access ?? {}),
    },
    trigger: {
      private: true,
      mention: true,
      keyword: false,
      groupEnabled: false,
      keywords: [],
      ...(trigger ?? {}),
    },
    send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
    turn: { timeoutMs: 20_000 },
    humanize: { enabled: false, chunkChars: 300, interim: { enabled: true, afterMs: 1500, mode: 'ai', ...interim } },
    wake: { judge: { apiKey: 'fake-key', baseUrl: `http://127.0.0.1:${port}`, model: 'deepseek-flash', ...judge } },
    persona: { preset: 'none' },
    memory: { enabled: false },
    image: { enabled: false },
  })
}

/** 造一个桥接；`replyDelayMs` = 正文要跑多久（要 > afterMs，垫场白才有机会）。 */
function makeBridge({ config, replyDelayMs = 6000, reply = '正文答复', replies = null, delays = null }) {
  const router = new SessionRouter({ log: () => {} })
  const logs = []
  const sent = []
  const queue = Array.isArray(replies) ? [...replies] : null
  const delayQueue = Array.isArray(delays) ? [...delays] : null
  const rpc = new EventTarget()
  rpc.prompt = async (sessionId) => {
    const delay = delayQueue && delayQueue.length > 0 ? delayQueue.shift() : replyDelayMs
    await sleep(delay)
    const text = queue && queue.length > 0 ? queue.shift() : reply
    router.handleEvent(sessionId, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } },
    })
    router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
    return { messageId: 'm1' }
  }
  const onebot = new EventTarget()
  onebot.selfId = '99999'
  onebot.call = async () => ({})
  onebot.send = async (kind, peerId, text) => {
    sent.push(String(text))
  }
  const bridge = new Bridge({
    rpc,
    onebot,
    sendQueue: new SendQueue({ ...config.send, log: () => {} }),
    router,
    config,
    log: (m) => logs.push(String(m)),
  })
  /**
   * 触发一条消息。`{ text, kind, peerId, groupId }`
   * —— 私聊与群聊都要能造（⑦⑨ 要验的正是"两条路的取数不一样"）。
   */
  const fire = ({ text = '帮我看下那个配置', kind = 'private', peerId = '10001', groupId = null } = {}) =>
    bridge.handleEvent(
      kind === 'group'
        ? {
            post_type: 'message',
            message_type: 'group',
            sub_type: 'normal',
            group_id: groupId ?? '70001',
            user_id: peerId,
            self_id: '99999',
            message: [{ type: 'text', data: { text } }],
            sender: { user_id: peerId, nickname: '阿绿' },
          }
        : {
            post_type: 'message',
            message_type: 'private',
            user_id: peerId,
            self_id: '99999',
            message: [{ type: 'text', data: { text } }],
          },
    )
  return { bridge, logs, sent, fire, router, rpc }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('① ★★★ 归一化：`0` 必须保持"自动"（这一条就是"实装失败"的根因）')
// ══════════════════════════════════════════════════════════════════════════
{
  const c0 = normalizeConfig({ humanize: { interim: { mode: 'ai', ai: { timeoutMs: 0 } } } })
  check('★★★ `timeoutMs: 0` ⇒ 归一化后**仍然是 0**（"0 = 自动"的文档与实现必须一致）',
    c0.humanize.interim.ai.timeoutMs === 0, String(c0.humanize.interim.ai.timeoutMs))
  const cMissing = normalizeConfig({ humanize: { interim: { mode: 'ai' } } })
  check('缺省（没写这个键）⇒ 也是 0', cMissing.humanize.interim.ai.timeoutMs === 0,
    String(cMissing.humanize.interim.ai.timeoutMs))
  const cExplicit = normalizeConfig({ humanize: { interim: { mode: 'ai', ai: { timeoutMs: 3000 } } } })
  check('显式给了正数 ⇒ 用那个值', cExplicit.humanize.interim.ai.timeoutMs === 3000,
    String(cExplicit.humanize.interim.ai.timeoutMs))
  // ⚠️ 这条是"**别**顺手把历史配置里的 200 改掉"：那是使用者自己填的值，
  //    静默改写配置比不改更糟（他会以为自己的设置没保存）。
  const cSmall = normalizeConfig({ humanize: { interim: { mode: 'ai', ai: { timeoutMs: 200 } } } })
  check('★ 显式的 200ms 保留原值（**不静默改写使用者的配置**）', cSmall.humanize.interim.ai.timeoutMs === 200,
    String(cSmall.humanize.interim.ai.timeoutMs))
  check('★ 但 200ms 会被 lint 点名（它基本等于"每次都用话术池"）',
    validateConfig(cSmall).warn.some((w) => /humanize\.interim\.ai\.timeoutMs/.test(w) && /太短/.test(w)),
    validateConfig(cSmall).warn.filter((w) => /interim/.test(w)).join('｜') || '（没警告）')
  check('★★ 警告里带**完整键名**（使用者拿着日志要能直接找到该改哪个键）',
    validateConfig(cSmall).warn.some((w) => w.includes('humanize.interim.ai.timeoutMs')))

  const cPool = normalizeConfig({ humanize: { interim: { mode: 'pool' } } })
  check('★ `mode` 只认 `ai`，其余一律回落 `pool`（不静默变成 AI=花钱）',
    cPool.humanize.interim.mode === 'pool' && normalizeConfig({ humanize: { interim: { mode: 'AI' } } }).humanize.interim.mode === 'pool')
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('② ★★★ 真实链路：AI 那句话**真的发出去了**（真归一化 + 真 HTTP）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★★ 假 API 现在**模仿真模型**：提示词里有"输出一行 JSON"才回 JSON，
  //    没有就直接答题（多行散文）—— 那正是 2026-10-18 真机上发生的事。
  const api = await startFakeApi({
    delayMs: 1000,
    replyFor: (body) =>
      String(body).includes('输出**一行 JSON**')
        ? '{"say":"在的在的，我瞄一眼"}'
        : '先说结论：这个配置得看你怎么用。\n\n第一，先确认端口。\n第二，再看日志。',
  })
  const WS = mkdtempSync(join(tmpdir(), 'dsh-interim-real-'))
  // ★ 真配置：只给 mode=ai，**不写 timeoutMs**（= 使用者什么都不填、走默认的情形）
  const config = makeRealConfig({ workspace: WS, port: api.port, interim: { afterMs: 1500 } })
  check('前提：归一化后 timeoutMs 是 0（自动）', config.humanize.interim.ai.timeoutMs === 0,
    String(config.humanize.interim.ai.timeoutMs))

  const { logs, sent, fire } = makeBridge({ config, replyDelayMs: 6000 })
  const p = fire()
  // 等到 afterMs（1.5 秒）+ 生成（1 秒）之后、正文（6 秒）之前
  await sleep(3000)

  check('★★★ 垫场白发的是 **AI 写的那句**（不是话术池）',
    sent.includes('在的在的，我瞄一眼'), JSON.stringify(sent))
  check('★★ 假 API 收到了请求，而且**没有被掐断**（这正是 200ms 缺陷会踩的地方）',
    api.hits.length === 1 && api.hits[0].aborted === false,
    JSON.stringify(api.hits.map((h) => ({ aborted: h.aborted }))))
  check('★ 日志标明这句是 AI 按上下文写的',
    logs.some((l) => /先发一条/.test(l) && /AI 按上下文写的/.test(l)),
    logs.filter((l) => /先发一条/.test(l)).join('｜') || '（没有）')
  check('★ 提示词里带了当前这句（这是"按上下文"的最小证据）',
    api.hits[0]?.body?.includes('帮我看下那个配置') === true,
    String(api.hits[0]?.body ?? '').slice(0, 120))
  // ★★★ 这一条是第二处"实装失败"的抓手：契约（"输出一行 JSON"）必须在请求里。
  //     去掉 `withContract` 之后假 API 就会像真模型一样答题 ⇒ 上面那条"发的是 AI 那句"必红。
  check('★★★ 请求里带了**输出契约**（`INTERIM_AI_PROMPT` 真的送出去了）',
    api.hits[0]?.body?.includes('输出**一行 JSON**') === true,
    String(api.hits[0]?.body ?? '').slice(0, 80))
  check('★★ 契约**只出现一次**（幂等，别把整段提示词拼两遍）',
    (String(api.hits[0]?.body ?? '').match(/输出\*\*一行 JSON\*\*/g) ?? []).length === 1,
    String((String(api.hits[0]?.body ?? '').match(/输出\*\*一行 JSON\*\*/g) ?? []).length))
  await p
  api.server.close()
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('③ 失败的三种样子都必须**退回话术池**（绝不静默）')
// ══════════════════════════════════════════════════════════════════════════
{
  const poolTexts = new Set([
    ...DEFAULT_INTERIM.thinking,
    ...DEFAULT_INTERIM.tooling,
    ...DEFAULT_INTERIM.searching,
    ...DEFAULT_INTERIM.blocked,
  ])

  // ── ③-1 生成太慢 → 退回池子 ──
  {
    const api = await startFakeApi({ delayMs: 4000 })
    const WS = mkdtempSync(join(tmpdir(), 'dsh-interim-slow-'))
    const config = makeRealConfig({ workspace: WS, port: api.port, interim: { afterMs: 1500 } })
    const { logs, sent, fire } = makeBridge({ config, replyDelayMs: 9000 })
    const p = fire()
    await sleep(3200)
    check('★★ 生成没赶上 → 发的是**话术池**那句（不是静默、也不是半截）',
      sent.length === 1 && poolTexts.has(sent[0]), JSON.stringify(sent))
    check('★ 日志如实说"生成没赶上，用话术池"（别让人以为是 AI 写的）',
      logs.some((l) => /生成没赶上，用话术池/.test(l)),
      logs.filter((l) => /先发一条/.test(l)).join('｜') || '（没有）')
    await p
    api.server.close()
  }

  // ── ③-2 它明确说"这一轮不说" → 一条都不发（这是**合法**结果，不是失败）──
  {
    const api = await startFakeApi({ delayMs: 200, reply: '{"say":""}' })
    const WS = mkdtempSync(join(tmpdir(), 'dsh-interim-silent-'))
    const config = makeRealConfig({ workspace: WS, port: api.port, interim: { afterMs: 1200 } })
    const { logs, sent, fire } = makeBridge({ config, replyDelayMs: 5000 })
    const p = fire()
    await sleep(2600)
    check('★★★ 它决定不发 ⇒ **一条垫场白都没有**', sent.length === 0, JSON.stringify(sent))
    check('★★ 而且日志说清"是它的决定"（否则看起来像功能坏了）',
      logs.some((l) => /AI 决定这一轮不先应声/.test(l)),
      logs.filter((l) => /先应声|先发一条/.test(l)).join('｜') || '（没有）')
    await p
    api.server.close()
  }

  // ── ③-3 通路不通（key 错）→ 退回池子，且**不留静默** ──
  {
    const WS = mkdtempSync(join(tmpdir(), 'dsh-interim-badkey-'))
    // 指向一个**没人监听**的端口：直连通路会失败
    const config = makeRealConfig({ workspace: WS, port: 9, interim: { afterMs: 1200 } })
    const { sent, fire } = makeBridge({ config, replyDelayMs: 5000 })
    const p = fire()
    await sleep(2600)
    check('★★ 通路失败 ⇒ 仍然发出**话术池**那句（"先应一声"不会因为 AI 挂了就消失）',
      sent.length === 1 && poolTexts.has(sent[0]), JSON.stringify(sent))
    await p
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('④ 默认档（`pool`）**一次生成都不做** —— 升级不改变现有行为')
// ══════════════════════════════════════════════════════════════════════════
{
  const api = await startFakeApi({ delayMs: 100 })
  const WS = mkdtempSync(join(tmpdir(), 'dsh-interim-pool-'))
  const config = makeRealConfig({ workspace: WS, port: api.port, interim: { afterMs: 1200, mode: 'pool' } })
  check('前提：归一化后 mode 是 pool', config.humanize.interim.mode === 'pool')
  const { sent, logs, fire } = makeBridge({ config, replyDelayMs: 5000 })
  const p = fire()
  await sleep(2000)
  check('★★ 默认档**没打任何模型请求**（不花那份钱）', api.hits.length === 0, JSON.stringify(api.hits.length))
  check('★ 发的仍然是话术池那句',
    sent.length === 1 && [...DEFAULT_INTERIM.thinking, ...DEFAULT_INTERIM.tooling].includes(sent[0]),
    JSON.stringify(sent))
  check('★ 也不该打"AI 自主决定"那行日志',
    !logs.some((l) => /AI 自主决定/.test(l)),
    logs.filter((l) => /先应一声/.test(l)).join('｜') || '（没有）')
  await p
  api.server.close()
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑤ 解析层：三种结果不能混（混了就会把失败说成"它决定沉默"）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('答上 → ok:true + 文本', parseInterimAiOutput('{"say":"在的"}').text === '在的')
  check('明确不发 → ok:true + 空串', parseInterimAiOutput('{"say":""}').text === '')
  check('★★ 解析不出来 → **ok:false**（消费方据此退池子，而不是当成"不发"）',
    parseInterimAiOutput('???').ok === false)
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑥ 输出契约由**解析方**负责接上（第二处「实装失败」的回归）')
// ══════════════════════════════════════════════════════════════════════════
//
// 缺陷形状：`INTERIM_AI_PROMPT` 导出了、注释也写了"这是生成用的系统提示词"，
// 但**没有任何调用方引用它**（真机上模型于是直接答题）。修法不是"在 bridge 里补一句拼接"
// ——那只是把同样的疏漏留给下一次；而是让 `createInterimAi` 统一接上（幂等）。
{
  check('★ `withContract` 会把契约接在前面',
    withContract('只给上下文').startsWith(INTERIM_AI_PROMPT.slice(0, 20)) &&
      withContract('只给上下文').includes('只给上下文'))
  check('★★ 幂等：已经带契约就不再拼一次',
    (withContract(INTERIM_AI_PROMPT).match(/输出\*\*一行 JSON\*\*/g) ?? []).length === 1)
  const composed = composeInterimPrompt({ current: { name: '阿绿', text: '帮我看下日志' }, recent: [] })
  check('★ `composeInterimPrompt` = 契约 + 上下文（都在）',
    composed.includes('输出**一行 JSON**') && composed.includes('帮我看下日志'))

  // ★★★ 接线级：闸门收到的提示词里必须有契约（调用方只传上下文那半段）
  const seen = []
  const ai = createInterimAi({
    gate: { judge: async ({ prompt }) => { seen.push(prompt); return { verdict: '{"say":"在的"}', judged: true } } },
  })
  const r = await ai.decide('【现在有人叫你，说的是这句】阿绿：在不')
  check('★★★ 闸门收到的那段提示词里有契约（忘了拼也不会退化）',
    String(seen[0] ?? '').includes('输出**一行 JSON**'), String(seen[0] ?? '').slice(0, 60))
  check('★★ 而且照样解析出发的那句话', r.ok === true && r.text === '在的', JSON.stringify(r))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑦ ★★★ 私聊：**上一轮自己说了什么**必须进提示词（真机「文不对题」的修法）')
// ══════════════════════════════════════════════════════════════════════════
//
// 真机现象（2026-10-18，使用者原话「垫场白文不对题」）：
//   他问「那垫场白文不对题怎么办」，机器人先垫了一句「啊这样 那我先听着」——
//   而他那句其实是在**纠正上一条**。根因：私聊的"最近几条"那条路只认 `group:`，
//   永远返回空数组 ⇒ 模型只看到孤零零一句「你好像理解错了」。
//
// 判据落在**请求体**上（不是内部状态）：必须带上「你上一条回的是」、标明那是**你自己说的**、
// 并且能看到镜像里的往来（含机器人自己）。
{
  const api = await startFakeApi({
    delayMs: 1000,
    replyFor: (body) => (String(body).includes('输出**一行 JSON**') ? '{"say":"啊，我说岔了"}' : '刚才那段是错的'),
  })
  const WS = mkdtempSync(join(tmpdir(), 'dsh-interim-mirror-'))
  const config = makeRealConfig({ workspace: WS, port: api.port, interim: { afterMs: 1200 } })
  // ★ 第一轮：慢回合（让垫场白有机会），正文是一段**能被下一轮认出来**的话
  const { logs, sent, fire } = makeBridge({
    config,
    replies: ['垫场白的上下文只有当前这句加一点上下文，所以我猜错了方向', '嗯，这次我看懂了'],
    delays: [3000, 6000],
  })
  const p1 = fire({ text: '为什么这次产生了两次回应' })
  await sleep(2200) // 垫场白（第一轮）
  await p1 // 第一轮正文发完 → 镜像里有 bot 那条

  const p2 = fire({ text: '你好像理解错了，我在讨论如何像群友一样说话' })
  await sleep(2200)
  const body = String(api.hits.at(-1)?.body ?? '')
  check('★★★ 请求里带了【你上一条回的是】这一段',
    body.includes('你上一条回的是'), body.slice(0, 80))
  check('★★★ 而且**标注了"这是你自己说的"**（不标会被当成对方说的，比看不到更乱）',
    /这是你自己说的/.test(body), body.slice(-260))
  // ★ 只看"你上一条回的是"那一段里装的是什么（整段 body 一定含当前这句，那是【当前消息】）
  const lastSection = String(body.split('【你上一条回的是')[1] ?? '').split('【现在有人叫你')[0] ?? ''
  check('★★ 那一段里是**上一轮正文的原文**',
    lastSection.includes('垫场白的上下文只有当前这句'), lastSection.slice(0, 160))
  check('★★ 而且**没有**把当前这句塞进那一段（那会让它以为这是自己说过的话）',
    !lastSection.includes('你好像理解错了'), lastSection.slice(0, 160))
  // ★ 只在那一段里找 `你（自己）：` 开头的行 —— 契约里也有「你（自己）」这个词，
  //   整段 includes 会被它带成**假绿**（第一版就是这么绿的，已记在下面）。
  const privateSection = String(body.split('你们最近这几条')[1] ?? '').split('【你上一条回的是')[0] ?? ''
  check('★★★ 私聊里的往来带上了**机器人自己**那几条（那一段里有 `你（自己）：` 的行）',
    /你（自己）：\S/.test(privateSection), privateSection.slice(0, 220))
  check('★★ 私聊那段的措辞是「你们最近这几条」而不是「群里」',
    body.includes('你们最近这几条') && !body.includes('群里刚说了这些'), body.slice(0, 120))
  check('★ 第二轮仍然发出的是一句话（垫场白没被撑成正文）',
    sent.filter((t) => t.includes('我')).every((t) => [...t].length <= 40), JSON.stringify(sent))
  await p2
  api.server.close()
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑧ ★★★ 重启后的第一轮：镜像空 ⇒ 语料库兜底（别留一个"偶尔看不见"的版本）')
// ══════════════════════════════════════════════════════════════════════════
//
// 镜像只在内存里。若只靠它，桥接重启后的第一条消息就退回"看不到自己上一句"——
// 而这个缺陷正是靠"永远看不到"活了一整版。所以镜像没命中时必须回退到语料库。
{
  const api = await startFakeApi({
    delayMs: 1000,
    replyFor: (body) => (String(body).includes('输出**一行 JSON**') ? '{"say":"嗯，我在"}' : '正文'),
  })
  const WS = mkdtempSync(join(tmpdir(), 'dsh-interim-corpus-'))
  // ★ 模拟"重启前"：直接往语料库里写一条机器人说过的话（镜像里**没有**）
  const seed = createCorpus({ workspace: WS, log: () => {} })
  seed.record({ kind: 'private', peerId: '10001', text: '上次我说的是另一套方案，跟这次无关', isBot: true })
  seed.close?.()

  const config = makeRealConfig({ workspace: WS, port: api.port, interim: { afterMs: 1200 } })
  check('前提：语料库是开着的（否则这条路不存在）', config.corpus?.enabled !== false)
  const { fire } = makeBridge({ config, replyDelayMs: 4000, reply: '正文' })
  const p = fire({ text: '你又说错了' })
  await sleep(2200)
  const body = String(api.hits.at(-1)?.body ?? '')
  check('★★★ 镜像里没有上一条时，照样从**语料库**带上了「你上一条回的是」',
    body.includes('你上一条回的是') && body.includes('上次我说的是另一套方案'), body.slice(-240))
  await p
  api.server.close()
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑨ ★★ 群聊：取数口径**没被私聊那条路带跑**（群聊的窗口是 0.3.1 调过的）')
// ══════════════════════════════════════════════════════════════════════════
{
  const api = await startFakeApi({
    delayMs: 1000,
    replyFor: (body) => (String(body).includes('输出**一行 JSON**') ? '{"say":"在的"}' : '正文'),
  })
  const WS = mkdtempSync(join(tmpdir(), 'dsh-interim-group-'))
  // ★ 让这个群**有上一条机器人回复**（否则"群聊也带那段"无从验起）：
  //   直接写进语料库 —— 这也是"重启后"那条路（镜像里没有它）。
  const seed = createCorpus({ workspace: WS, log: () => {} })
  seed.record({ kind: 'group', peerId: '70001', text: '群里我上次说的是先看归属', isBot: true })
  seed.close?.()
  const config = makeRealConfig({
    workspace: WS,
    port: api.port,
    interim: { afterMs: 1200 },
    // ★ 群聊要被唤醒：`trigger.mention` 靠 @ 段，这里用**关键词**那条（与 game-wiring 同一手法）
    trigger: { groupEnabled: true, mention: true, keyword: true, keywords: ['小鲸鱼'] },
    access: { groupAllowlist: ['70001'] },
  })
  const { fire } = makeBridge({ config, replyDelayMs: 4000, reply: '正文' })
  // 群里第一句（没叫它）→ 落进语料库；第二句 @ 它
  await fire({ kind: 'group', groupId: '70001', peerId: '10002', text: '刚在说那个配置文件' })
  const p = fire({ kind: 'group', groupId: '70001', peerId: '10001', text: '小鲸鱼 你看下' })
  await sleep(2200)
  const body = String(api.hits.at(-1)?.body ?? '')
  check('★★ 群聊那一段仍然是「群里刚说了这些」（措辞没被私聊改写）',
    body.includes('群里刚说了这些'), body.slice(0, 160))
  check('★★ 群聊里机器人自己的话**不进**那一段（只在"你上一条"里）',
    !body.includes('群里刚说了这些（标「你（自己）」的是你自己说的）\n你（自己）'), body.slice(0, 240))
  check('★ 群聊也带上了「你上一条回的是」（这一段两条路共用）',
    body.includes('你上一条回的是') && body.includes('群里我上次说的是先看归属'), body.slice(-200))
  await p
  api.server.close()
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑩ 提示词：这一档的**真正功能是结合上下文自主回应**（所以不写死规则）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('★★★ 明说"结合下面的上下文自己判断"（不是从固定话术里挑）',
    /结合下面的上下文自己判断/.test(INTERIM_AI_PROMPT) && /不是从一堆固定话术里挑一句/.test(INTERIM_AI_PROMPT))
  check('★★ 有「只垫一句，说完就停」（看到自己上一句以后容易接着聊，这条必须留）',
    /只垫一句/.test(INTERIM_AI_PROMPT))
  check('★★ 明说「不要接着它往下讲」（针对"看到自己上一句"这件事）',
    /不要接着它往下讲/.test(INTERIM_AI_PROMPT))
  check('★★★ **没有**把"对方在纠正你 ⇒ 就认一句/就别发"写成硬规则（使用者明确要求第三条不加）',
    !/纠正/.test(INTERIM_AI_PROMPT), INTERIM_AI_PROMPT.split('\n').filter((l) => /纠正/.test(l)).join('｜') || '（干净）')
  check('★ 仍然要求不回答、不给结论（原来那条没被削弱，那是"不代替正文"的边界）',
    /不回答对方的问题/.test(INTERIM_AI_PROMPT))
  check('★ 仍然允许"什么都不发"（这条是安全阀，别在收紧时弄丢）',
    /不该垫场时就什么都不发/.test(INTERIM_AI_PROMPT))
  // ★ 提示词里**不写示范句**（与四戒同一条规矩）：不能出现「」包着的整句台词
  const offenders = [...INTERIM_AI_PROMPT.matchAll(/「([^」]{6,40})」/g)].map((m) => m[1]).filter((s) => /。|，/.test(s))
  check('★★ 提示词里没有**示范台词**（只描述要什么，不举句子）',
    offenders.length === 0, offenders.join('｜') || '（干净）')
}

console.log('')
if (failed === 0) {
  console.log(`🎉 「先应一声」真实链路全部通过（${passed} 项）`)
  console.log('   ⚠️ 这一套刻意**不用桩**：走真 normalizeConfig + 真 HTTP —— 台账缺陷正是在桩测试全绿时漏出去的。')
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
