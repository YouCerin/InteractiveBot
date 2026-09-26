/**
 * 唤醒判定（决定"这条消息要不要回"）。
 *
 * ── 用户定的规则（这是全部依据）────────────────────────────────────────
 *   · 私聊           → 回，且必须回
 *   · 群里被 @        → 回，且必须回
 *   · 群里命中关键词   → 回，且必须回
 *   · 其余情况        → **不回**
 *   · 不需要"潜水"判断 → 一旦触发就必答，不存在"触发了但选择沉默"
 *
 *   ★ 群聊**只有这两种唤醒方式**（@ 与关键词）—— 没有"自动搭话""随机插嘴"
 *     这类行为。这是刻意的：群聊里最容易被当成机器人、也最容易惹人烦。
 *
 * ── 这个设计带来的一个重要简化 ─────────────────────────────────────────
 * 一旦"触发即必答"，我们就不需要：
 *   · 让模型自己决定说不说（省掉了和模型博弈的哨兵机制）
 *   · 桥接层再判断一次要不要发（省掉了一次判断）
 * 代价是：命中关键词时一定会产生一次模型调用。所以关键词表要克制 ——
 * 宁可少写几个词，也不要写"你好""哈哈"这种群聊高频词，否则等于全响应。
 */

import { cqMentionsSelf } from './text.mjs'

/** 判定结果的原因标签，用于日志与统计。 */
export const REASON = {
  PRIVATE: 'private',
  MENTION: 'mention',
  KEYWORD: 'keyword',
  NONE: 'none',
  GROUP_DISABLED: 'group-disabled',
}

/**
 * @param {object} input
 * @param {'private'|'group'} input.kind
 * @param {string} input.text          已渲染好的可读文本
 * @param {boolean} input.mentioned    消息段里是否 @ 了自己
 * @param {string} [input.raw]         原始 CQ 字符串（兜底判定用）
 * @param {string|number|null} input.selfId
 * @param {string[]} input.keywords
 * @param {{
 *   private?: boolean, mention?: boolean, keyword?: boolean, groupEnabled?: boolean
 * }} input.switches
 * @returns {{ respond: boolean, reason: string, hit?: string }}
 */
export function decideTrigger({ kind, text, mentioned, raw, selfId, keywords, switches }) {
  const sw = {
    private: switches?.private !== false,
    mention: switches?.mention !== false,
    keyword: switches?.keyword !== false,
    // ★ 群聊总开关**默认关闭**（fail-closed）。
    //   群聊涉及账号风控，而且要"确实想开"才开 —— 所以缺省是不开，
    //   而不是像另外几个开关那样缺省是开。
    groupEnabled: switches?.groupEnabled === true,
  }

  // ① 私聊：只要开关开着，无条件回。
  //    注意这里**不看关键词**——私聊是"一对一找它说话"，还要求关键词就太蠢了。
  if (kind === 'private') {
    return sw.private
      ? { respond: true, reason: REASON.PRIVATE }
      : { respond: false, reason: REASON.NONE }
  }

  // ── 以下都是群聊 ──
  // 群聊总开关关着 → 直接不回。**不做任何其它判定**，
  // 这样"关掉群聊"就是真的零成本（关键词扫都不扫）。
  if (!sw.groupEnabled) {
    return { respond: false, reason: REASON.GROUP_DISABLED }
  }

  // ② 群聊：被 @ 优先（@ 的语义最强，命中就走）。
  if (sw.mention) {
    const isMentioned = mentioned === true || cqMentionsSelf(raw, selfId)
    if (isMentioned) return { respond: true, reason: REASON.MENTION }
  }

  // ③ 群聊：关键词
  if (sw.keyword && Array.isArray(keywords) && keywords.length > 0) {
    const haystack = String(text ?? '').toLowerCase()
    for (const rawWord of keywords) {
      const word = String(rawWord ?? '').trim().toLowerCase()
      if (!word) continue
      if (haystack.includes(word)) {
        return { respond: true, reason: REASON.KEYWORD, hit: rawWord }
      }
    }
  }

  // ④ 群里既没 @ 也没命中关键词 → 不回。
  //    这条分支很重要：它意味着**零成本**（不建会话、不调模型）。
  //    也是"群聊里只做两种唤醒、不乱插嘴"的落地处。
  return { respond: false, reason: REASON.NONE }
}

/**
 * 配置自检：把"配错了会静默变全响应"的情况显式暴露出来。
 *
 * 为什么需要它：关键词是"包含匹配"，所以写一个单字关键词（比如"我"）
 * 几乎等于全响应；写一个群聊高频词（"哈哈"）会让机器人变成复读机。
 * 这类错误不会报错、不会崩，只会悄悄烧钱 —— 必须在启动时就警告。
 *
 * @returns {{ level: 'error'|'warn', message: string }[]}
 */
export function lintKeywords(keywords) {
  const out = []
  if (!Array.isArray(keywords)) return out

  const highFrequency = new Set([
    '我', '你', '他', '的', '了', '是', '在', '有', '不', '好', '啊', '吧', '吗',
    '哈哈', '哈哈哈', '草', '6', '笑死', '在吗', '那个', '什么', '怎么', '为什么',
    '吗', '呢', '哦', '嗯', 'ok', 'okay', 'hi', 'hello', '你好',
  ])

  for (const rawWord of keywords) {
    const word = String(rawWord ?? '').trim()
    if (!word) {
      out.push({ level: 'error', message: '关键词表里有空字符串，请删掉' })
      continue
    }
    const lower = word.toLowerCase()
    if (word.length <= 1) {
      out.push({
        level: 'warn',
        message: `关键词「${word}」只有 1 个字，包含匹配下几乎等于"全响应"，建议改成长一点的词`,
      })
    }
    if (highFrequency.has(lower)) {
      out.push({
        level: 'warn',
        message: `关键词「${word}」是群聊高频词，会把机器人变成复读机，强烈建议删除`,
      })
    }
  }
  return out
}
