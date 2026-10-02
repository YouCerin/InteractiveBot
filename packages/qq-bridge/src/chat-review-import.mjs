/**
 * 聊天记录评审台 —— **导入**：把各种形状的聊天记录变成统一的「回合」。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有这一层（而不是让页面自己解析）
 * ══════════════════════════════════════════════════════════════════════════
 * 要评的是**机器人接话接得好不好**，所以被评的最小单位不是"一条消息"，
 * 而是「对方说的话 + 机器人那句话」。这个配对逻辑必须只有一份，
 * 而且必须是**纯函数**：页面上看到的条数、报告里统计的条数、最后生成的
 * 反例清单，必须来自同一套判据（三处各写一遍必然会漂）。
 *
 * ── 输入有三种，输出只有一种 ──────────────────────────────────────────────
 *   ① 合并转发 JSON（QQ 的"合并转发"导出、`get_forward_msg` 的返回、OneBot 事件数组）；
 *   ② 纯文本聊天记录（`昵称: 内容` 一行一条，也允许 `[12:34] 昵称：内容`）；
 *   ③ 本地语料库的行（`corpus.mjs` 的 `transcript()`，形状见 `rowToEntry`）。
 * 三者都先变成 `entry = { name, text, at, fromBot }`，再统一走 `buildTurns()`。
 *
 * ── 三条不肯让步的纪律 ────────────────────────────────────────────────────
 * ① **认不出来就说认不出来**：解析不出的行进 `warnings`，逐条带行号与原文片段。
 *    绝不"猜一个昵称"或"把整段塞进第一条" —— 那会让评审者对着假数据打分。
 * ② **不许把非文字段当文字**：图片/表情/语音/合并转发在正文里折叠成 `[图片]` 这类标记，
 *    并且**整条只有标记**的机器人发言会被跳过（没有文字可评），跳过的理由要报出来。
 * ③ **id 必须稳定**：同一份记录重复导入不能产生新条目，否则评审者会对同一条打两次分。
 *    所以 id 由「会话 + 时间 + 正文指纹」拼出来，而不是数组下标。
 */

/** 默认把哪些昵称当成"机器人自己"（配置里没给时用）。 */
export const SELF_NAMES_DEFAULT = ['小鲸鱼', '小鱼', 'D指导', 'deepseek', 'DeepSeek', '小鲸鱼 bot']

/** OneBot 消息段 → 正文标记。**只保留能让人看懂"这里有个非文字东西"的信息。** */
const SEGMENT_LABEL = {
  image: '[图片]',
  face: '[表情]',
  mface: '[表情]',
  marketface: '[表情]',
  bface: '[表情]',
  sface: '[表情]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  json: '[卡片]',
  xml: '[卡片]',
  forward: '[合并转发]',
  share: '[链接]',
  music: '[音乐]',
  location: '[位置]',
  poke: '[戳一戳]',
  dice: '[骰子]',
  rps: '[猜拳]',
}

/**
 * 一个消息段数组（或一个字符串）→ 纯文本。
 *
 * ★ `at` 段写成 `@昵称`：评审"它有没有接住被 @ 的那句话"时，看不到 @ 就判断不了。
 * ★ `reply` 段**丢弃**：它只是"这条在回哪条"的指针，正文里出现 `[回复]` 会干扰阅读
 *   （引用关系在合并转发里本来也看不出来）。
 */
export function segmentsToText(message) {
  if (message == null) return ''
  if (typeof message === 'string') return message.trim()
  if (!Array.isArray(message)) return ''
  const parts = []
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    const type = String(seg.type ?? '')
    const data = seg.data ?? {}
    if (type === 'text') {
      parts.push(String(data.text ?? ''))
      continue
    }
    if (type === 'at') {
      const who = String(data.name ?? data.qq ?? '').trim()
      parts.push(who ? `@${who}` : '@某人')
      continue
    }
    if (type === 'reply') continue
    const label = SEGMENT_LABEL[type]
    if (label) parts.push(label)
  }
  return parts.join('').replace(/[ \t]+/g, ' ').trim()
}

/**
 * 时间戳归一化成**毫秒**。
 *
 * OneBot 的 `time` 是**秒**，而语料库里是毫秒 —— 第一版没归一化，
 * 结果是导入的记录全部显示成 1970 年（而且排序全乱），所以这里必须做，
 * 判据是"小于 1e12 的一律当秒"（1e12 ms ≈ 2001 年，任何合理的秒级时间戳都远小于它）。
 */
export function normalizeAt(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

/** 名字的归一化（比较用）：去掉首尾空白与常见后缀，大小写不敏感。 */
function nameKey(name) {
  return String(name ?? '')
    .trim()
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
}

/**
 * 判断一条发言是不是机器人自己说的。
 *
 * 判据刻意**宽松但可见**：带 `is_bot`/`isBot` 字段的按字段（语料库与 OneBot 都有，
 * 这是最可靠的）；否则按昵称比对 `selfNames`。
 */
function isBotEntry({ name, flags = {}, selfKeys }) {
  if (flags.isBot === true) return true
  if (flags.isBot === false) return false
  const key = nameKey(name)
  if (!key) return false
  return selfKeys.has(key)
}

/** 正文指纹（FNV-1a 32 位，十六进制）—— 只用来生成稳定 id，不做安全用途。 */
export function fingerprint(text) {
  let h = 0x811c9dc5
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 批次 id：可读、可排序、不含路径分隔符（它会被当文件名用）。 */
export function batchIdFor(label, at = Date.now()) {
  const stamp = new Date(at).toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const tag = String(label ?? '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return `${tag ? `${tag}-` : ''}${stamp}`
}

/** 昵称里那些"看起来是名字"的字段，按可靠性排序。 */
function pickName(node) {
  const sender = node?.sender ?? {}
  const raw =
    sender.card ||
    sender.nickname ||
    node?.nickname ||
    node?.name ||
    node?.sender_name ||
    sender.name ||
    ''
  return String(raw ?? '').trim()
}

/**
 * 从任意一种"合并转发 / 消息列表"的 JSON 里抽出条目。
 *
 * 接受这几种形状（实测见到的都在里面，多一种就少一次"导不进来"）：
 *   · `{ messages: [...] }`（`get_forward_msg` 的返回，最常见）
 *   · `{ data: { messages: [...] } }`（OneBot 的 action 包装）
 *   · `{ data: { message: [...] } }` / `{ message: [...] }`（单条，没有 sender 就靠外层）
 *   · `[ {...}, {...} ]`（裸数组：既可能是节点，也可能是 OneBot 事件）
 *   · 每个节点可以是 `{sender:{nickname}, message:[段]}`、
 *     `{sender:{nickname}, content:'…'}`、`{nickname, text}`、或一个 OneBot 事件
 *     （`{post_type:'message', sender:{...}, message:[...], time}`）。
 *
 * @returns {{ok: boolean, entries: object[], warnings: string[], why?: string}}
 */
export function parseForwardJson(text) {
  let data = null
  try {
    data = JSON.parse(String(text ?? ''))
  } catch (error) {
    return {
      ok: false,
      entries: [],
      warnings: [],
      why: `JSON 解析失败：${error?.message ?? error}（如果这是一份纯文本记录，把格式切成「纯文本」）`,
    }
  }

  const warnings = []
  // ── 把"装节点的那个数组"找出来 ────────────────────────────────────────
  let nodes = null
  let containerAt = null
  const consider = (value, from) => {
    if (Array.isArray(value) && nodes === null) {
      nodes = value
      containerAt = from
    }
  }
  if (Array.isArray(data)) {
    consider(data, '顶层数组')
  } else if (data && typeof data === 'object') {
    consider(data.messages, 'messages')
    const inner = data.data
    if (inner && typeof inner === 'object') {
      consider(inner.messages, 'data.messages')
      // 单条消息：`data.message` 是**段数组**，它本身就是要当一条的能力
      if (Array.isArray(inner.message)) {
        nodes = [{ message: inner.message, sender: inner.sender ?? data.sender ?? null, time: inner.time ?? data.time }]
        containerAt = 'data.message（单条）'
      }
    }
    if (nodes === null && Array.isArray(data.message)) {
      nodes = [{ message: data.message, sender: data.sender ?? null, time: data.time }]
      containerAt = 'message（单条）'
    }
  }

  if (!Array.isArray(nodes)) {
    return {
      ok: false,
      entries: [],
      warnings: [],
      why: '这份 JSON 里找不到消息数组（认得的写法：messages / data.messages / data.message / 顶层数组）',
    }
  }

  const entries = []
  nodes.forEach((node, i) => {
    if (!node || typeof node !== 'object') {
      warnings.push(`第 ${i + 1} 项不是对象，已跳过`)
      return
    }
    const name = pickName(node)
    // 正文来源按可靠性：段数组 > content > text > raw_message
    let body = ''
    if (Array.isArray(node.message)) body = segmentsToText(node.message)
    else if (typeof node.content === 'string') body = node.content
    else if (typeof node.text === 'string') body = node.text
    else if (typeof node.raw_message === 'string') body = node.raw_message
    body = String(body ?? '').trim()
    if (!body) {
      warnings.push(`第 ${i + 1} 项没有正文（只有图片/表情或空），已跳过`)
      return
    }
    if (!name) warnings.push(`第 ${i + 1} 项没有昵称，按「某人」处理（这会影响"是不是机器人"的判断）`)
    entries.push({
      name: name || '某人',
      text: body,
      at: normalizeAt(node.time ?? node.timestamp ?? node.at ?? node.created_at),
      // `is_bot` 显式给了就用它（语料库/OneBot 形状），没给就留给 selfNames 判
      flags: {
        ...(typeof node.is_bot === 'boolean' ? { isBot: node.is_bot } : {}),
        ...(typeof node.isBot === 'boolean' ? { isBot: node.isBot } : {}),
        ...(typeof node.post_type === 'string' && node.post_type !== 'message' ? { isBot: false } : {}),
      },
    })
  })

  if (!entries.length) {
    return { ok: false, entries: [], warnings, why: `认出了消息数组（${containerAt}），但里面一条可用正文都没有` }
  }
  return { ok: true, entries, warnings }
}

/** 纯文本里的"昵称: 内容"分隔。前导的 `[12:34]` / `2026-10-02 12:34` 时间戳会被剥掉。 */
const TEXT_LINE_RE = /^\s*(?:\[?\d{0,4}[-/]?\d{0,2}[-/]?\d{0,2}[ T]?\d{0,2}:?\d{0,2}:?\d{0,2}\]?\s*)?([^:：]{1,24})\s*[:：]\s*(.*)$/

/**
 * 纯文本聊天记录 → 条目。
 *
 * 认「昵称: 内容」与「昵称：内容」；**没有冒号的行并进上一条**（真人复制出来的记录里
 * 长句经常被换行折断，直接丢掉会平白少掉半句话），并把它记成一条 warning 说明
 * 并了多少行 —— 既不丢内容，也不假装那是单独一条发言。
 */
export function parsePlainText(text) {
  const warnings = []
  const entries = []
  let merged = 0
  const lines = String(text ?? '').split(/\r?\n/)
  lines.forEach((line, i) => {
    const raw = line.trim()
    if (!raw) return
    const m = TEXT_LINE_RE.exec(raw)
    if (m) {
      const name = String(m[1] ?? '').trim()
      const body = String(m[2] ?? '').trim()
      if (!name || !body) {
        warnings.push(`第 ${i + 1} 行冒号两侧有一侧是空的，已跳过：${raw.slice(0, 30)}`)
        return
      }
      entries.push({ name, text: body, at: null, flags: {} })
      return
    }
    const prev = entries[entries.length - 1]
    if (prev) {
      prev.text = `${prev.text}\n${raw}`
      merged += 1
      return
    }
    warnings.push(`第 ${i + 1} 行认不出「昵称: 内容」，而且前面还没有任何一条可并入，已跳过：${raw.slice(0, 30)}`)
  })
  if (merged) warnings.push(`有 ${merged} 行没有昵称，已并入上一条（复制出来的记录里长句常被换行折断）`)
  if (!entries.length) {
    return { ok: false, entries: [], warnings, why: '一行都没认出「昵称: 内容」这种写法' }
  }
  return { ok: true, entries, warnings }
}

/** 语料库的一行（`corpus.transcript()` 的形状）→ 条目。 */
export function rowToEntry(row) {
  return {
    name: String(row?.senderName ?? row?.userId ?? (row?.isBot ? '机器人' : '某人')).trim() || '某人',
    text: String(row?.text ?? '').trim(),
    at: normalizeAt(row?.createdAt ?? row?.at),
    flags: { isBot: Boolean(row?.isBot), rowId: Number(row?.id) || null },
  }
}

/** 整条只有非文字标记（`[图片]` 这种）⇒ 没有文字可评，跳过它。 */
export function isOnlyMarkers(text) {
  const t = String(text ?? '').trim()
  if (!t) return true
  return t.replace(/\[[^\]]{1,6}\]/g, '').replace(/[\s\u3000]+/g, '') === ''
}

/**
 * 条目 → 回合（**纯函数**，导入与语料库两条路共用）。
 *
 * 规则：
 *   · 只有**机器人自己的**发言才当 `reply`；
 *   · `context` 取它前面最多 `contextBefore` 条（跳过空正文），由旧到新；
 *   · 整条只有标记的回复跳过，并如实计数；
 *   · 同一批内按 id 去重（重复导入同一份记录不该出现两份）；
 *   · 只保留**最后** `limit` 个回合（评审关心的是最近的表现；且这样"拉 200 条"
 *     与"导入 200 条"的语义一致）。
 */
export function buildTurns({
  entries = [],
  selfNames = SELF_NAMES_DEFAULT,
  chatKey = 'import',
  chatLabel = '',
  batch = '',
  source = 'import',
  contextBefore = 1,
  limit = 200,
} = {}) {
  const selfKeys = new Set((selfNames ?? []).map(nameKey).filter(Boolean))
  const ctxN = Math.max(0, Math.min(3, Number(contextBefore) || 0))
  const max = Math.max(1, Math.min(2000, Number(limit) || 200))
  const items = []
  const seen = new Set()
  let skippedMarkers = 0

  entries.forEach((entry, i) => {
    if (!entry || !String(entry.text ?? '').trim()) return
    if (!isBotEntry({ name: entry.name, flags: entry.flags ?? {}, selfKeys })) return
    const reply = String(entry.text).trim()
    if (isOnlyMarkers(reply)) {
      skippedMarkers += 1
      return
    }
    const context = []
    for (let k = i - 1; k >= 0 && context.length < ctxN; k -= 1) {
      const e = entries[k]
      if (!e || !String(e.text ?? '').trim()) continue
      context.unshift({
        name: String(e.name ?? '某人'),
        text: String(e.text).trim(),
        isBot: isBotEntry({ name: e.name, flags: e.flags ?? {}, selfKeys }),
      })
    }
    const at = normalizeAt(entry.at)
    // ★ id 里带**正文指纹**：同一个人前后说两句一样的话时，只靠时间会撞成一条
    const id = `${source === 'corpus' ? 'c' : 'i'}:${chatKey}:${at ?? `#${i}`}:${fingerprint(reply)}`
    if (seen.has(id)) return
    seen.add(id)
    items.push({
      id,
      batch,
      source,
      chatKey,
      chatLabel: chatLabel || chatKey,
      at,
      context,
      reply,
    })
  })

  return { items: items.slice(-max), total: items.length, skippedMarkers }
}
