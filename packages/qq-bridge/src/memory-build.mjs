/**
 * **按需建档**：把"还没计入记忆的消息"立刻整理成记忆条目（控制台那个按钮的后端）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它解决什么（以及为什么必须由用户按一下）
 * ══════════════════════════════════════════════════════════════════════════
 * 平时的记忆只有两条路进来：① 确定性通道（"记住 X"、情绪倾注）；② 回合后抽取（每 5 轮、
 * 而且吃的是**任务台账与操作**，不是消息）。于是"聊了半天，值得记的事一条没记"
 * 是常态 —— 真机实测：一个群 549 条发言、46 个回合，**结论是 0 条记忆**。
 * 这个模块给使用者一个**显式出口**：挑一个群或一个人，把游标之后的消息交给抽取模型
 * 提炼成条目，**立刻落盘**，并如实回报哪些被内容闸门拒了。
 *
 * ── 三条纪律（都对应本项目已有的教训）────────────────────────────────────
 *   ① **归属由代码裁定**：模型看到的是一份编号清单（形如 `#1 = 昵称(QQ号)`），
 *      输出里只许写 `#n`；编号→QQ 的映射在这里做，写不在清单里的编号**直接丢弃**。
 *      ⚠️ 所以准确的措辞是"**模型没有任何办法指定一个不在场的人**"，
 *      **不是**"它看不到 QQ 号" —— 清单里本来就带着号码（那些号码在正常提示词的
 *      来源标注里也一直都有，不是这一段新引入的）。第一版注释写成"拿不到 QQ 号"，
 *      是**错的**（2026-09-30 更正）。
 *   ② **落盘照旧过那一道闸门**：所有条目走 `applyMemoryItems`（`screenEntry` 是唯一
 *      内容闸门：身份/权限、像指令、第三方负面定性、隐私七类），被拒的**如实回报**。
 *   ③ **失败不抛、也不静默**：模型不可用 / 解析不出 / 超时 ⇒ `{ok:false, why}`，
 *      由界面显示；**游标不前进**（这样一点"重试"就还能把这些消息再交一次）。
 *
 * ── 游标（什么算"已计入"）────────────────────────────────────────────────
 * `runtime/memory-cursor.json` 里按会话记 `lastId`（语料库的自增 id）。
 *   · 一旦这一批消息**被交给模型并成功解析**，游标就前进 —— 哪怕一条都没采纳
 *     （"考虑过了、确实不值得记"也是一种结论，否则每次都会重复烧同一批消息）；
 *   · 但**模型失败时不前进**（上面第 ③ 条）。
 * `--userId` 另有一条独立游标（`<会话>|user:<QQ>`），所以"给整群建档"与
 * "单独给某人建档"不会互相吃掉对方的进度。
 *
 * ⚠️ 它**不写原文**：模型被告知"只写结论"，且条目照旧过闸门。语料库才是原文的家。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { applyMemoryItems, SCOPE } from './memory-store.mjs'
import { appendAuditEntry } from './memory-audit.mjs'
import { nicknameFor } from './contacts.mjs'
import { parseLooseJson } from './extract.mjs'

/** 游标侧车（与 corpus/oplog/tasks 同级，放 runtime/）。 */
export const CURSOR_REL = 'runtime/memory-cursor.json'
export const CURSOR_VERSION = 1

/**
 * 一批最多交给模型多少条消息、多少字（防止一次点按钮把上下文打爆）。
 *
 * ★ `chars` 是**总字数**上限（每条正文之外还给发言人前缀留约 24 字的余量）。
 *   ⚠️ 它曾经是个**死常量**（只声明、没人用，等于"文档声称有、代码没做"）——
 *   2026-09-30 补上：60 条 × 单条 500 字极端情况下有 3 万字，那已经不是"一批"了。
 *   现在**先按条数截、再按字数截**，被截掉多少都如实报在 `skipped` 里。
 */
export const BUILD_LIMITS = { messages: 60, chars: 6000, perMessage: 500 }

/** 每行给发言人前缀（`[#12 昵称] `）预留的字数余量 —— 提示词的开销要算进去。 */
const PER_MESSAGE_OVERHEAD = 24

/**
 * 会话名：只为了让模型知道"这是哪儿"（**取不到就留空，绝不编**）。
 *
 * ★ 为什么单独抽成一个函数：它是**接线**（群名要从 `roster.groupNameOf` 拿、
 *   私聊要从称呼表拿），而接线最容易"看起来接上了、其实没接" ——
 *   本项目为此付过最贵的一次学费（任务段在真机上从未注入过）。抽出来才能用桩测。
 * ★ 群名走的是 `get_group_list` 的**缓存**（与界面会话列表同一个来源、同一份缓存），
 *   不是新增一次协议查询；查不到就返回空串，提示词里如实写「没查到名字」。
 *
 * @param {object} opts
 * @param {'group'|'private'} opts.kind
 * @param {string} opts.peerId
 * @param {string} opts.workspace
 * @param {Function|null} [opts.groupNameOf] `roster.groupNameOf(call, groupId)`
 * @param {Function|null} [opts.call]        `(action, params, timeoutMs) => Promise`
 * @returns {Promise<string>} 空串 = 不知道叫什么
 */
export async function resolveChatLabel({ kind, peerId, workspace, groupNameOf = null, call = null } = {}) {
  const id = String(peerId ?? '').trim()
  if (!id) return ''
  try {
    if (kind === 'private') return String(nicknameFor({ workspace, qq: id }) ?? '')
    if (typeof groupNameOf === 'function' && typeof call === 'function') {
      return String((await groupNameOf(call, id)) ?? '')
    }
  } catch {
    /* 名字只影响可读性，取不到不影响建档本身 */
  }
  return ''
}

/** 一条消息在提示词里的样子：`#3 [昵称] 正文`（编号**只给发言人**，机器人自己用 ——）。 */
function renderTranscript(messages) {
  return messages
    .map((m) => {
      const who = m.isBot ? '（机器人自己）' : `[${m.speakerIndex != null ? `#${m.speakerIndex} ` : ''}${m.senderName ?? m.userId ?? '?'}]`
      return `${who} ${m.text}`
    })
    .join('\n')
}

/**
 * 构造抽取提示词（**纯函数**，可离线测）。
 *
 * @param {object} opts
 * @param {'group'|'private'} opts.kind
 * @param {string} opts.chatLabel   会话名（群名/对方昵称），只用于让模型知道"这是哪儿"
 * @param {{speakers: {index:number,name:string,userId:string}[], messages: object[]}} opts.batch
 * @returns {string}
 */
export function buildMemoryPrompt({ kind, chatLabel = '', batch }) {
  const speakers = batch?.speakers ?? []
  const list = speakers.length
    ? speakers.map((s) => `#${s.index} = ${s.name || '（没查到昵称）'}(${s.userId})`).join('、')
    : '（这一段里没有别人说话）'
  const lines = [
    `你在帮一个 QQ 机器人整理**${kind === 'group' ? '群聊' : '私聊'}**里还没被记下来的对话。`,
    `对话来自：${chatLabel || '（没查到名字）'}`,
    `说话人编号：${list}`,
    '',
    '请提炼出**值得长期记住**的条目。只输出一个 JSON 对象：',
    '{"entries":[{"who":"#1","scope":"person","text":"一句话结论"}],"note":"可选的补充说明"}',
    '',
    '规则（写错会被系统拒绝，并且**会**把原因回给你）：',
    '- `who` 只能写上面出现过的编号（`#1`/`#2`…）；**不要写 QQ 号**（你也不知道，写了会被拒）。',
    '- `scope` 三选一：',
    '  · `person` —— **关于某个人本身**的事（他的偏好、习惯、在做的事、怎么对待他）。**必须带 who**。',
    '  · `group`  —— 只跟这个会话有关的事（群规、群内梗、这里发生过的事）。**不要带 who**。',
    '  · `global` —— 对谁都成立、且不含任何人私事的通用约定。**不要带 who**。',
    '- 写**结论**，不写过程：不要写"我回答了他什么"，只写以后还用得上的那部分。',
    '- 一次最多 8 条；**宁少勿多**。这一段确实没什么值得记的，就输出 {"entries":[]} 并在 note 里说明。',
    '- **不记隐私**：身份证号、手机号、银行卡号、密码密钥、具体住址、健康医疗、生物特征。',
    '- **不记对不在场的人的负面评价**（"某某是个小丑"这类一律不记）。',
    '- 不要把对话原文抄进来，用你自己的话概括。',
    '',
    '=== 还没记下来的对话 ===',
    renderTranscript(batch?.messages ?? []),
  ]
  return lines.join('\n')
}

/**
 * 从这一段对话里抽出**发言人清单**（编号顺序 = 首次出现顺序）。
 *
 * ★ 机器人自己**不进清单**：它不是"某个人"，也不该有个人档案。
 */
export function speakersOf(messages = []) {
  const seen = new Map()
  for (const m of messages) {
    if (m.isBot) continue
    const id = String(m.userId ?? '').trim()
    if (!/^\d{5,15}$/.test(id)) continue
    if (!seen.has(id)) seen.set(id, { index: seen.size + 1, userId: id, name: String(m.senderName ?? '').trim() })
  }
  return [...seen.values()]
}

/** 归一化模型输出：只保留认得出的条目（**认不出就丢，不猜**）。 */
export function normalizeBuildOutput(raw) {
  const parsed = parseLooseJson(String(raw ?? ''))
  if (!parsed || typeof parsed !== 'object') return { ok: false, why: '抽取输出解析不出 JSON' }
  const list = Array.isArray(parsed.entries) ? parsed.entries : []
  const entries = []
  for (const e of list) {
    const text = String(e?.text ?? '').trim()
    if (!text) continue
    const scope = ['person', 'group', 'global'].includes(String(e?.scope)) ? String(e.scope) : 'group'
    const who = String(e?.who ?? '').trim()
    entries.push({ who, scope, text })
  }
  return { ok: true, entries, note: String(parsed.note ?? '') }
}

// ══════════════════════════════════════════════════════════════════════════
// 游标
// ══════════════════════════════════════════════════════════════════════════

/** 游标键：整会话，或"会话 + 某个人"（两者各走各的进度）。 */
export function cursorKeyOf({ chatKey, userId = null } = {}) {
  const ck = String(chatKey ?? '').trim()
  if (!ck) return null
  const u = String(userId ?? '').trim()
  return u ? `${ck}|user:${u}` : ck
}

export function readCursorFile({ workspace, log = () => {} } = {}) {
  const p = join(String(workspace ?? ''), CURSOR_REL)
  try {
    if (!existsSync(p)) return { version: CURSOR_VERSION, chats: {} }
    let text = readFileSync(p, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.chats !== 'object' || !parsed.chats) {
      log(`⚠️ [memory-build] ${CURSOR_REL} 结构不对，按空处理（会从头再考虑一遍消息）`)
      return { version: CURSOR_VERSION, chats: {} }
    }
    return { version: CURSOR_VERSION, chats: parsed.chats }
  } catch (error) {
    log(`⚠️ [memory-build] 读游标失败（按空处理）：${error?.message ?? error}`)
    return { version: CURSOR_VERSION, chats: {} }
  }
}

/** 读某个键的游标（没有就 0 = 从头）。 */
export function readCursor({ workspace, chatKey, userId = null, log = () => {} } = {}) {
  const key = cursorKeyOf({ chatKey, userId })
  if (!key) return { ok: false, why: '会话为空', lastId: 0 }
  const rec = readCursorFile({ workspace, log }).chats[key]
  return { ok: true, key, lastId: Number(rec?.lastId) || 0, rec: rec ?? null }
}

/** 推进游标（原子写：tmp + rename）。 */
function writeCursor({ workspace, key, lastId, considered = 0, entries = 0, now = Date.now() }) {
  const p = join(String(workspace ?? ''), CURSOR_REL)
  const data = readCursorFile({ workspace })
  data.chats[key] = {
    chatKey: key,
    lastId: Number(lastId) || 0,
    at: now,
    considered: (Number(data.chats[key]?.considered) || 0) + considered,
    entries: (Number(data.chats[key]?.entries) || 0) + entries,
  }
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: CURSOR_VERSION, chats: data.chats }, null, 1)}\n`, 'utf8')
  renameSync(tmp, p)
  return data.chats[key]
}

// ══════════════════════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════════════════════

/**
 * 把一批消息整理成记忆。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {'group'|'private'} opts.kind
 * @param {string} opts.peerId          群号 / 对方 QQ
 * @param {string|null} [opts.userId]   只给这个人建档（游标独立）
 * @param {string} [opts.chatLabel]     会话名（给模型看的上下文，只影响可读性）
 * @param {object[]} opts.messages      `corpus.recent()` 的形状（含 id / userId / text / isBot）
 * @param {Function} [opts.runner]      `({prompt}) => {ok,text,why,ms}`；不传 = 只做预演/报错
 * @param {boolean} [opts.apply]        true 才落盘 + 推进游标
 * @param {Function} [opts.log]
 * @returns {Promise<object>} 一份**如实**的报告（界面直接显示它）
 */
export async function buildMemoryFromMessages({
  workspace,
  kind,
  peerId,
  userId = null,
  chatLabel = '',
  messages = [],
  runner = null,
  apply = false,
  log = () => {},
} = {}) {
  const root = String(workspace ?? '')
  const chatKey = `${kind}:${String(peerId ?? '')}`
  const cursor = readCursor({ workspace: root, chatKey, userId, log })
  // ── 截批：**先按条数、再按总字数**（两个上限都要真的生效）──────────────
  //   ★ 为什么字数那一道不能省：单条截到 500 字，但 60 条就是 3 万字 ——
  //     那已经不是"一批"了，一次点击能把上下文打掉一大块。
  //   ★ 为什么"至少留一条"：第一条本身就超上限时也要交给模型（否则按钮变成
  //     "什么都不做"，而使用者完全不知道为什么）。单条已被 `perMessage` 截过，
  //     所以实际上第一条必然放得下。
  const withinCount = messages.slice(0, BUILD_LIMITS.messages)
  const batch = []
  let usedChars = 0
  let truncatedBy = withinCount.length < messages.length ? 'messages' : null
  for (const m of withinCount) {
    const cost = String(m?.text ?? '').length + PER_MESSAGE_OVERHEAD
    if (batch.length > 0 && usedChars + cost > BUILD_LIMITS.chars) {
      truncatedBy = 'chars'
      break
    }
    batch.push(m)
    usedChars += cost
  }
  const base = {
    ok: false,
    chatKey,
    userId: userId ?? null,
    cursorBefore: cursor.lastId,
    considered: batch.length,
    skipped: Math.max(0, messages.length - batch.length),
    /** 这一批是被哪个上限截住的（`null` = 没截）：界面要能说清"为什么只看了一部分" */
    truncatedBy,
    batchChars: usedChars,
  }
  if (batch.length === 0) {
    return { ...base, ok: true, why: '没有新的消息需要处理（游标已经是最新）', entries: [], applied: [], ignored: [] }
  }
  const speakers = speakersOf(batch)
  const prompt = buildMemoryPrompt({ kind, chatLabel, batch: { speakers, messages: batch } })

  if (!apply) {
    // 预演：把"会交给模型什么"如实给出来，不调用、不落盘
    return { ...base, ok: true, dryRun: true, speakers, prompt, entries: [], applied: [], ignored: [] }
  }
  if (typeof runner !== 'function') {
    return { ...base, why: '没有可用的模型通路（直连未配置、headless 也不可用）—— 游标**没有**前进，可以稍后重试' }
  }

  let out = null
  try {
    out = await runner({ prompt })
  } catch (error) {
    out = { ok: false, why: `抽取异常：${error?.message ?? error}` }
  }
  if (!out?.ok) {
    return { ...base, why: out?.why ?? '抽取失败', raw: out?.text ?? null }
  }
  const parsed = normalizeBuildOutput(out.text)
  if (!parsed.ok) {
    // ★ 失败要带原文片段（本项目最贵的一类缺陷是"失败但没有证据"）
    return { ...base, why: parsed.why, raw: String(out.text ?? '').slice(0, 300) }
  }

  // ── 归属：**编号 → QQ 由代码做**；person 档还要有合法的 who ──────────────
  const byUser = new Map() // userId -> items[]
  const plain = [] // group / global（与"谁说的"无关）
  const ignored = []
  for (const e of parsed.entries) {
    if (e.scope === 'person') {
      const hit = speakers.find((s) => `#${s.index}` === e.who)
      if (!hit) {
        ignored.push({ scope: e.scope, who: e.who, entry: e.text, why: `编号「${e.who || '(空)'}」不在这一段的发言人清单里 —— 不猜是谁，已丢弃` })
        continue
      }
      if (!byUser.has(hit.userId)) byUser.set(hit.userId, [])
      byUser.get(hit.userId).push({ scope: SCOPE.PERSON, text: e.text, source: 'build' })
      continue
    }
    plain.push({ scope: e.scope === 'global' ? SCOPE.GLOBAL : SCOPE.FACT, text: e.text, source: 'build' })
  }

  const appliedAll = []
  const wroteFiles = new Set()
  const ignoredAll = [...ignored]
  // ① person：**按人分组**分别落盘（`applyMemoryItems` 一次只认一个发言人）
  for (const [uid, items] of byUser) {
    const r = applyMemoryItems({ workspace: root, kind, peerId, senderId: uid, tier: 'user', items, log })
    appliedAll.push(...r.applied.map((a) => ({ ...a, userId: uid })))
    // ★ 被拒的也带上归属：审计要能回答"这条本来是想记给谁的"
    ignoredAll.push(...r.ignored.map((i) => ({ ...i, userId: uid })))
    for (const f of r.wroteFiles) wroteFiles.add(f)
  }
  // ② group / global：与发言人无关，用第一个说话人（只为拿到合法的落点）
  if (plain.length > 0) {
    const r = applyMemoryItems({
      workspace: root,
      kind,
      peerId,
      senderId: speakers[0]?.userId ?? String(peerId),
      tier: 'user',
      items: plain,
      log,
    })
    appliedAll.push(...r.applied)
    for (const f of r.wroteFiles) wroteFiles.add(f)
    ignoredAll.push(...r.ignored)
  }

  // ── 审计：**这条路以前完全没有留痕**（2026-09-30 补）─────────────────────
  //
  // ⚠️ 为什么这里必须补：`memory/audit.jsonl` 此前只有**桥接在自己回合结算里**
  //   写（来源 marker/keyword/cue/promise），而 `applyMemoryItems` **自己不写审计** ——
  //   于是"按需建档"改了什么，只有返回值与一行日志，事后翻不出一份带时间戳的凭证。
  //   而 2026-09-30 那次真机事故（两份记忆被改）之所以只能靠时间戳推断，就是这个缺口。
  // ★ 格式与桥接那条路**逐字一致**（同一张表、同样不记原文，只记长度），
  //   于是"这份记忆是谁改的"在一张文件里就能看全。
  for (const a of appliedAll) {
    appendAuditEntry({
      workspace: root,
      entry: {
        chatKey,
        senderId: a.userId ?? speakers[0]?.userId ?? String(peerId),
        source: a.source ?? 'build',
        scope: a.scope ?? null,
        outcome: a.deduped ? 'deduped' : 'applied',
        chars: String(a.entry ?? '').length,
      },
      log,
    })
  }
  for (const i of ignoredAll) {
    appendAuditEntry({
      workspace: root,
      entry: {
        chatKey,
        // ★ 归属尽量带上（person 档被拒时知道本来想记给谁）；group/global 没有归属
        senderId: i.userId ?? null,
        source: i.source ?? 'build',
        scope: i.scope ?? null,
        outcome: 'ignored',
        chars: String(i.entry ?? '').length,
        why: i.why,
      },
      log,
    })
  }

  // ── 游标：解析成功就前进（哪怕一条都没采纳 —— "考虑过了"也是一种结论）──
  const lastId = batch[batch.length - 1].id
  const moved = writeCursor({
    workspace: root,
    key: cursor.key,
    lastId,
    considered: batch.length,
    entries: appliedAll.length,
  })

  log(
    `[memory-build] ${chatKey}${userId ? `|user:${userId}` : ''}：看 ${batch.length} 条 → ` +
      `采纳 ${appliedAll.length} 条、忽略 ${ignoredAll.length} 条（游标 ${cursor.lastId} → ${lastId}）` +
      (base.skipped > 0 ? `｜还有 ${base.skipped} 条**这一轮没看**（被${base.truncatedBy === 'chars' ? '总字数' : '条数'}上限截住，下次再点会接着处理）` : ''),
  )
  return {
    ...base,
    ok: true,
    speakers,
    entries: parsed.entries,
    note: parsed.note,
    applied: appliedAll,
    ignored: ignoredAll,
    wroteFiles: [...wroteFiles],
    cursorAfter: moved.lastId,
    ms: out.ms ?? null,
  }
}
