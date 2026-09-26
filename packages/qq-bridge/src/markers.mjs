/**
 * 带内标记（in-band markers）：模型用**文本里的标记**表达"元意图"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有它（这是"说了做不到"的修复）
 * ══════════════════════════════════════════════════════════════════════════
 * 任务台账的注入段里一直写着这么一句（**从 0.2.1 之前就在**）：
 *
 *     「引用回复要用【本次唤醒】/【过去状态】里带 # 的消息 id」
 *
 * 而 **这两个段根本不存在**（真机提示词里搜不到），并且：
 *   · 发送侧只有 `[{type:'text'}]`，**没有 reply 段** —— 机器人**根本不能引用回复**；
 *   · `text.mjs` 把"用户在回复哪条"解析成了 `replyTo`，但**全仓库零消费**。
 * 也就是说：提示词在**承诺一个不存在的能力**。这是本项目最不能接受的一类问题
 * （`AGENT.md` 第 6 条：不许让用户以为成功了）。
 *
 * 现在把它补成真的通道：**提示词给出消息 id → 模型写 `[reply:id]` → 桥接校验 → 真的引用发送**。
 *
 * ── 两条设计纪律 ──────────────────────────────────────────────────────────
 * ① **剥离无条件**：标记是我们**内部协议**，绝不能让用户看到（与 `<<<MEMORY` 同理）。
 *    哪怕这一轮不打算用引用（比如 id 校验不过），标记也一定要从正文里去掉。
 * ② **校验不过就丢掉引用，不猜**：`[reply:123]` 里的 123 必须是我们**在这个会话里
 *    真的见过**的消息 id（近若干条）。否则 QQ 会显示一条指向空气的引用，
 *    或者引用到**别人的**会话里去 —— 后者是真正的错误。
 *    （参考项目拿本地语料库校验；我们还没有语料库（H7），所以先校验"本会话近期见过的 id"，
 *      这条比"不校验"严格、比"全库校验"弱，边界如实写在文档里。）
 */

/** `[reply:123]` / `[reply: 123]`（大小写不敏感）。 */
export const REPLY_RE = /\[\s*reply\s*:\s*([^\]\s]{1,32})\s*\]/gi

/** `[sticker:偷笑]` / `[sticker: 14 ]`。 */
export const STICKER_RE = /\[\s*sticker\s*:\s*([^\]]{1,32})\s*\]/gi

/** OneBot 的消息 id 就是整数（各实现都如此）；不是这个形状的一律不认。 */
const ID_RE = /^\d{1,20}$/

/**
 * 从模型回复里把带内标记抠出来，并**从正文里剥干净**。
 *
 * @param {string} text
 * @returns {{text: string, replyTo: string|null, sticker: string|null, notes: string[]}}
 *   `replyTo` = 数字字符串（形状不对就是 null）；`sticker` = 名字（**未解析**，交给调用方查表）
 */
export function parseOutMarkers(text) {
  const src = String(text ?? '')
  const notes = []
  if (!src) return { text: '', replyTo: null, sticker: null, notes }

  let replyTo = null
  let sticker = null

  // 先扫一遍取出值，再统一剥掉 —— 分成两步是因为"剥"要处理重复标记。
  for (const m of src.matchAll(REPLY_RE)) {
    const id = String(m[1] ?? '').trim().replace(/^#/, '')
    if (!ID_RE.test(id)) {
      notes.push(`[reply:${m[1]}] 不是消息 id（只认数字）→ 已丢弃`)
      continue
    }
    if (replyTo && replyTo !== id) notes.push(`同一条里有多个 [reply:…]，只取第一个`)
    if (!replyTo) replyTo = id
  }
  for (const m of src.matchAll(STICKER_RE)) {
    const name = String(m[1] ?? '').trim()
    if (!name) continue
    if (!sticker) sticker = name
  }
  if (src.match(STICKER_RE)?.length > 1) notes.push('同一条里有多个 [sticker:…]，只取第一个')

  // ★ 剥离**无条件**执行（见文件头 ①）
  const clean = src
    .replace(REPLY_RE, '')
    .replace(STICKER_RE, '')
    // 剥掉标记后可能留下孤零零的空格/空行，收拾一下（但不做 trim 之外的花样）
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { text: clean, replyTo, sticker, notes }
}

/**
 * 把 `[sticker:名字]` 解析成可发送的 QQ 表情。
 *
 * ★ 这一层的表**默认是空的**（`config.send.stickers`）—— 也就是说：
 *   **没有配置表情表时，`[sticker:…]` 会被剥掉但不是发送**，并记一行日志。
 *   为什么不做一张内置的"名字 → QQ 表情 id"表：那需要**逐个确认 id 对应的到底是哪个表情**，
 *   猜错就是**用户可见的错误**（发了个"菜刀"给人家）。宁可不发，也不发错。
 *   真正的表情库属于 M5' 的技能系统（含离线打标签 + 本地选图），届时由它填这张表。
 *
 * @param {string} name
 * @param {Record<string, string|number>} [table] `config.send.stickers`
 * @returns {{kind: 'face', id: string}|null}
 */
export function resolveSticker(name, table = {}) {
  const key = String(name ?? '').trim()
  if (!key || !table || typeof table !== 'object') return null
  const hit = table[key]
  if (hit === undefined || hit === null) return null
  const id = String(hit).trim()
  // 值必须是数字（QQ 表情 id 就是数字）—— 别的形状一律不认，免得把乱七八糟的东西发出去
  if (!/^\d{1,6}$/.test(id)) return null
  return { kind: 'face', id }
}

/** 表里都有哪些名字（给提示词与日志用；按名字排序，稳定）。 */
export function stickerNames(table = {}) {
  if (!table || typeof table !== 'object') return []
  return Object.keys(table).sort()
}

/**
 * 渲染"怎么用标记"那几行提示词。
 *
 * ⚠️ **只在真有东西可教时才教**：没有表情表时**不提** `[sticker:…]` ——
 *    提示词里凡是写了的能力都必须是真的（这正是这一轮在修的毛病）。
 *
 * @param {{stickers?: Record<string,string|number>, messageId?: string|null}} [opts]
 * @returns {string} 空串 = 什么都不用教
 */
export function renderMarkerInstructions({ stickers = {}, messageId = null } = {}) {
  const lines = []
  if (messageId) {
    lines.push(
      `【想引用回复】当前这条消息的 id 是 #${messageId}（跟在来源标注里那个 # 号后面）。`,
      '想**引用**某条消息就把它写进回复里：`[reply:#' + String(messageId) + ']`（只写数字也行）。',
      '⚠️ 只有你在上面**真的看到过**的 id 才有效 —— 系统会校验，编一个不会生效（那一条会被丢掉，正文照发）。',
    )
  }
  const names = stickerNames(stickers)
  if (names.length > 0) {
    lines.push(
      `想发表情就在回复里写 \`[sticker:名字]\`。可用的名字：${names.join('、')}。` +
        '（名字不在这张表里的会被丢掉，正文照发。）',
    )
  }
  if (lines.length === 0) return ''
  // 单独成段，并放在**易变区**（每轮的 id 都不同，绝不能进稳定前缀 —— 那会打断前缀缓存）
  return ['【这一轮可用的标记】', ...lines].join('\n')
}

/** 内置提示（给 README / AGENT.md 引用，避免文档与代码漂移）。 */
export const MARKER_NAMES = { reply: '[reply:<消息id>]', sticker: '[sticker:<名字>]' }
