/**
 * 人味层：让回复不再是"秒回"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这是**账号存活问题**，不是体验优化
 * ══════════════════════════════════════════════════════════════════════════
 * 实测日志显示：收到消息到回复发出只隔 1 秒（782ms、2896ms）。
 * 「秒回 + 7×24 在线」是行为风控最典型的特征向量 —— 真人做不到。
 *
 * 上一个 QQ 号被处置，最可能的原因就是这种自动化特征。所以这里做三件事：
 *   1. 回复前随机延迟（真人看到消息后要打字，且有反应快慢）
 *   2. 延迟随回复长度递增（回 200 字和回"在的"花的时间不一样）
 *   3. 静默时段（真人夜里会睡；凌晨秒回是最强的"我在线"信号）
 *
 * ── 一个刻意的取舍 ─────────────────────────────────────────────────────
 * 静默时段**不拒答，只大幅延迟**。理由：拒答会让使用者以为机器人坏了，
 * 而"回复很慢"既保留了可用性，又像人。宁可慢，也不要坏。
 *
 * ── 设计原则 ───────────────────────────────────────────────────────────
 * 本模块只做**纯计算**（给定配置和输入，算出该等多少毫秒），不 sleep、
 * 不读时钟以外的外部状态。这样它既好测，也能被桥接在合适的时机调用。
 * 真正的等待在 bridge.mjs 里，而且可以被测试关掉（delay: false）。
 */

/** 把 "HH:MM" 解析成小时数（含小数）；不合法返回 null。 */
export function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h + min / 60
}

/** 取整点小时数（含小数），便于和静默时段比较。 */
function hourOf(date) {
  return date.getHours() + date.getMinutes() / 60
}

/**
 * 判断给定时刻是否落在静默时段内。
 *
 * 必须支持**跨午夜**的区间（比如 23:00–07:00），这是最容易写错的地方：
 * 如果只写 `start <= h && h < end`，23:30 会被判成"不在静默期"，
 * 于是机器人凌晨照常秒回 —— 恰好把这个功能最该防的场景漏掉。
 *
 * @param {Date} date
 * @param {{ enabled?: boolean, start?: string, end?: string }} quiet
 */
export function isQuietHours(date, quiet) {
  if (!quiet?.enabled) return false
  const start = parseClock(quiet.start)
  const end = parseClock(quiet.end)
  if (start === null || end === null) return false
  if (start === end) return false // 起止相同视为不启用，避免"全天静默"这种误配

  const h = hourOf(date)
  // 跨午夜：例如 23:00–07:00 → h >= 23 或 h < 7
  return start > end ? h >= start || h < end : h >= start && h < end
}

/**
 * 计算一条回复应该延迟多少毫秒。
 *
 * 组成：基础反应时间（随机） + 打字时间（按字数）
 *
 * @param {object} opts
 * @param {number} opts.textLength 将要发出的文本长度（字符数）
 * @param {object} opts.humanize    humanize 配置
 * @param {Date}   [opts.now]       当前时间（测试可注入）
 * @param {() => number} [opts.random] 随机源（测试可注入，默认 Math.random）
 * @returns {{ delayMs: number, reason: string }}
 */
export function computeReplyDelay({ textLength = 0, humanize = {}, now = new Date(), random = Math.random } = {}) {
  const h = humanize ?? {}
  if (h.enabled === false) return { delayMs: 0, reason: 'humanize-disabled' }
  if (h.delay === false) return { delayMs: 0, reason: 'delay-disabled' }

  // 静默时段：给一个固定的长延迟。
  if (isQuietHours(now, h.quietHours)) {
    const min = Math.max(0, h.quietDelayMinMs ?? 45_000)
    const max = Math.max(min, h.quietDelayMaxMs ?? 150_000)
    const delayMs = Math.round(min + random() * (max - min))
    return { delayMs, reason: 'quiet-hours' }
  }

  // 基础反应时间：真人看到消息到开始打字，有快有慢。
  const reactMin = Math.max(0, h.reactMinMs ?? 1500)
  const reactMax = Math.max(reactMin, h.reactMaxMs ?? 5000)
  const react = reactMin + random() * (reactMax - reactMin)

  // 打字时间：按字数折算。
  //
  // ⚠️ 这里有一层**单独的封顶**（typingMaxMs），而不是只靠总的 maxDelayMs。
  // 原因：按 5 字/秒算，一条 200 字的回复要打 40 秒 —— 用户会觉得机器人坏了。
  // 8 秒是本项目选定的值：足够让"秒回"这个风控特征消失，
  // 又不至于让人等得难受。所以打字时间 = min(字数 × 每字耗时 × 抖动, typingMaxMs)。
  const charsPerSecond = Math.max(1, h.charsPerSecond ?? 5)
  const perChar = 1000 / charsPerSecond
  const jitter = 0.75 + random() * 0.5 // 0.75~1.25 倍
  const typingCap = Math.max(0, h.typingMaxMs ?? 8000)
  const typing = Math.min(typingCap, Math.round(textLength * perChar * jitter))

  // 总延迟再过一层封顶，防止"反应时间 + 打字时间"叠加后超出预期
  const cap = Math.max(0, h.maxDelayMs ?? 13_000)
  const delayMs = Math.min(cap, Math.round(react + typing))
  return { delayMs, reason: 'human-like', typingMs: typing, reactMs: Math.round(react) }
}

/**
 * 按可读停顿把长文本切成"多条连发"的片段。
 *
 * 为什么需要它：一次把 800 字糊在一条消息里，和真人"分几条发"是两种观感。
 * 而且分条发送天然带上 send 节流的间隔，比单条长消息更像人。
 *
 * 注意：这里只做**切分**，不负责发送与间隔 —— 那些归 SendQueue 管。
 *
 * @param {string} text
 * @param {{ maxChars?: number, minChunk?: number }} [opts]
 * @returns {string[]}
 */
export function splitIntoMessages(text, { maxChars = 300, minChunk = 20 } = {}) {
  const source = String(text ?? '').trim()
  if (!source) return []
  if (source.length <= maxChars) return [source]

  const chunks = []
  let rest = source

  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    let cut = -1
    // 优先在段落/句子边界切，实在没有才硬切
    for (const boundary of ['\n\n', '\n', '。', '！', '？', '；', '. ', '! ', '? ', '; ']) {
      const idx = window.lastIndexOf(boundary)
      if (idx >= minChunk) {
        cut = idx + boundary.length
        break
      }
    }
    if (cut <= 0) cut = maxChars
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }
  if (rest.trim()) chunks.push(rest.trim())
  return chunks.filter(Boolean)
}
