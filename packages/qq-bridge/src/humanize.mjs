/**
 * 人味层：让回复不再是"秒回"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这是**账号存活问题**，不是体验优化
 * ══════════════════════════════════════════════════════════════════════════
 * 实测日志显示：收到消息到回复发出只隔 1 秒（782ms、2896ms）。
 * 「秒回 + 7×24 在线」是行为风控最典型的特征向量 —— 真人做不到。
 *
 * 所以这里做三件事：
 *   1. 回复前随机延迟（真人看到消息后要打字，且有反应快慢）
 *   2. 延迟随回复长度递增（回 200 字和回"在的"花的时间不一样）
 *   3. 静默时段（真人夜里会睡；凌晨秒回是最强的"我在线"信号）
 *
 * ── ★★ 延迟是「补到档位」而不是「在耗时之上再加一段」──────────────────
 * 这里的延迟**不是无条件加上去的**：模型自己花掉的时间也算在等待里。
 * 实际已用超过档位目标 ⇒ 一个字都不再等（见 `computeReplyDelay`）。
 * 老实现是附加式的，于是"说好 8 秒"变成"实际 23 秒"（模型 15s + 档位 8s），
 * 使用者看到的就是功能描述与体验对不上。**改这条语义前先读那段注释。**
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
 * 现在是不是静默时段（跟着 `computeReplyDelay` 的时钟口径走）。
 *
 * 为什么要有它：静默时段除了"延迟回得更久"之外还有一条行为要求——
 * **不许发「先应一声」**（凌晨冒出一句"我在想"与"我在线"是同一类信号，
 * 而静默时段存在的全部意义就是不发出这个信号）。桥接在挂定时器时要现判一次，
 * 所以判定必须能单独调用，而不是只藏在 `computeReplyDelay` 里。
 *
 * @param {Date} [now]
 * @param {{ enabled?: boolean, start?: string, end?: string }} [quiet]
 */
export function isQuietNow(now = new Date(), quiet) {
  return isQuietHours(now, quiet)
}

/** 静默时段内应该等多久（下限，随机）。 */
function quietFloorMs(h, random) {
  const min = Math.max(0, h.quietDelayMinMs ?? 45_000)
  const max = Math.max(min, h.quietDelayMaxMs ?? 150_000)
  return Math.round(min + random() * (max - min))
}

/**
 * 计算一条回复**还要**等多少毫秒才发。
 *
 * 组成：基础反应时间（随机） + 打字时间（按字数） = `plannedMs`（这一档的目标等待）
 *
 * ── ★★ 档位是「下限」而不是「附加」（2026-09-30 用户拍板的语义修正）──────
 * 老实现把这个延迟**加在**本轮已经花掉的时间之上：模型想了 15 秒、均衡档再等 8 秒，
 * 使用者实际等了 23 秒 —— 而界面写的是"约 5~9 秒"。**说好的 8 秒怎么等了 23 秒**，
 * 这就是"实际效果与描述不一致"的根因。
 *
 * 现在的语义（与界面文案逐字对应）：
 *   · **实际已用 < 档位目标**（`elapsedMs < plannedMs`）
 *     → 只补到档位目标（`plannedMs - elapsedMs`）。秒回的观感消失，总时长≈档位。
 *   · **实际已用 ≥ 档位目标**（`elapsedMs >= plannedMs`）
 *     → **不再叠加任何延迟，立刻发**。回复慢是模型真的在干活，
 *       那不是风控特征，没必要再罚它等一段。
 *
 * 静默时段同理（它是**下限 45~150 秒**）：已经等了超过这个下限就立刻发，
 * 否则补到下限。**"不拒答、只变慢"这条承诺不变**，变的只是不再无脑叠加。
 *
 * ⚠️ **不传 `elapsedMs` = 老的附加语义**（桥接一定会传）。留着它是为了
 * 让"纯计算"这条用法仍然成立，不是给生产路径留的后门 —— 生产路径漏传的表现
 * 就是回到"说好的 8 秒等了 23 秒"，而那种 bug 从日志上一眼能看出
 * （日志会打"拟人延迟 N 秒"而不是"补到档位"），verify-units 里也有断言盯着。
 *
 * @param {object} opts
 * @param {number} opts.textLength 将要发出的文本长度（字符数）
 * @param {object} opts.humanize    humanize 配置
 * @param {number} [opts.elapsedMs] 本轮**从回合开始到此刻**已经花掉的时间
 *   （= 模型思考 + 调工具的时间；口径由桥接决定，见 bridge.mjs 里的 `turnStartedAt`）。
 *   传了（含 0）就走"档位是下限"的新语义；不传走老的附加语义。
 * @param {Date}   [opts.now]       当前时间（测试可注入）
 * @param {() => number} [opts.random] 随机源（测试可注入，默认 Math.random）
 * @returns {{ delayMs: number, reason: string, plannedMs?: number, elapsedMs?: number }}
 *   `delayMs` 是**现在还要等**的毫秒数；`plannedMs` 是本轮的目标等待（档位），
 *   两者一起进日志 —— 排查"为什么等了这么久"只需要这一行。
 */
export function computeReplyDelay({
  textLength = 0,
  humanize = {},
  elapsedMs,
  now = new Date(),
  random = Math.random,
} = {}) {
  const h = humanize ?? {}
  // 传了 elapsedMs（含 0）就走下限语义：真正要等的是"补到目标为止"。
  const align = typeof elapsedMs === 'number' && Number.isFinite(elapsedMs)
  const already = align ? Math.max(0, elapsedMs) : 0
  /** 把"目标等待"折算成"现在还要等多少"（新语义）/ 原样返回（老语义）。 */
  const settle = (ms) => (align ? Math.max(0, ms - already) : ms)

  if (h.enabled === false) return { delayMs: 0, reason: 'humanize-disabled' }
  if (h.delay === false) return { delayMs: 0, reason: 'delay-disabled' }

  // 静默时段：给一个固定的长延迟（同样按"下限"算：已经等够了就不再多等）。
  if (isQuietHours(now, h.quietHours)) {
    const planned = quietFloorMs(h, random)
    return {
      delayMs: settle(planned),
      reason: 'quiet-hours',
      plannedMs: planned,
      ...(align ? { elapsedMs: already } : {}),
    }
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
  const plannedMs = Math.min(cap, Math.round(react + typing))
  return {
    // ★ 新语义下这里是"还要等多少"（可能为 0 = 立刻发）；老语义下就是总延迟。
    delayMs: settle(plannedMs),
    reason: 'human-like',
    // `plannedMs` 是新语义的核心：它是**这一档的目标等待**，与已经花掉的时间比较
    // 才知道该补时还是该直接发。日志与测试都靠它，别只留 delayMs。
    plannedMs,
    ...(align ? { elapsedMs: already } : {}),
    typingMs: typing,
    reactMs: Math.round(react),
  }
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

/** 一条回复最多拆成几条（防"十行诗"变成十条消息）。 */
export const REPLY_MAX_PARTS = 6
/** 参与拆分的段落还必须**短**（长段落说明那是一整段正文，不是"连发几条"）。 */
export const REPLY_PART_MAX_CHARS = 120

/**
 * ★★ **一条回复该拆成几条消息发**（2026-10-01，用户点名）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（这是一个真实的静默失效）
 * ══════════════════════════════════════════════════════════════════════════
 * `splitIntoMessages` 的第一行是 `if (source.length <= maxChars) return [source]`——
 * 于是**短回复永远只有一条**。而本案的典型场景恰恰全是短回复：
 *
 *     被叫到、但我最后没吐出一个字的时候
 *     （空行）
 *     比如觉得这条不用接就没写正文；……
 *     （空行）
 *     具体是哪条规则判定成空的，我这边看不到，得翻桥接那边的代码
 *
 * 总共 101 字 < 300，所以**三段被糊成一个气泡发出去**（投递账本实测：
 * `total=1`），而说话方式里那句「常拆两条：第一条给反应，第二条补一句」
 * 从一开始就**没有任何一条代码路径能让它生效**。
 * ★ 0.3.0alpha 注：这句现在在**出厂那份人设文件**里（原先在 `styles/闲聊.md`，
 *   中途住过一段 `src/voice.mjs`）—— 文案搬了家，但这一段判据**一个字没动**。
 *
 * ∴ 这里把"分段"提前到长度判断**之前**：段落边界（空行优先，其次单换行）
 *   本来就是模型表达"这几句分开说"的方式。
 *
 * ── 五道闸门（少一道就会把不该拆的东西拆坏）────────────────────────────
 *   ① 段数 2~`REPLY_MAX_PARTS`：1 段本来就只有一条；10 段以上是列表/诗，不拆；
 *   ② **每段都必须短**（≤ `REPLY_PART_MAX_CHARS`）：长段落是一整段正文，
 *      按边界切会给对方发一条被切断的句子；
 *   ③ 总长仍受 `maxChars` 约束（超了走原来的切分逻辑，不在这里处理）；
 *   ④ 不做 trim 之外的改写（原样保留措辞）；
 *   ⑤ 纯函数 —— `#safeSend` 那条路**不调它**（报错/提示是系统在说话，
 *      拆开会让对方以为收到了两条提示）。
 *
 * @param {string} text
 * @param {{ maxChars?: number, minChunk?: number, maxParts?: number, partMaxChars?: number }} [opts]
 * @returns {string[]} 至少一条；空输入返回 `[]`
 */
export function splitReplyForSend(text, opts = {}) {
  const source = String(text ?? '').trim()
  if (!source) return []
  const maxChars = opts.maxChars ?? 300
  const maxParts = opts.maxParts ?? REPLY_MAX_PARTS
  const partMax = opts.partMaxChars ?? REPLY_PART_MAX_CHARS

  // ①② 段落边界：先把空行当硬边界，再看单换行
  const blocks = source
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  let parts = blocks
  if (blocks.length === 1 && blocks[0].includes('\n')) {
    parts = blocks[0]
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  const splittable =
    parts.length >= 2 &&
    parts.length <= maxParts &&
    parts.every((p) => p.length <= partMax) &&
    source.length <= maxChars

  // ③ 不能拆/不该拆 ⇒ 走原来的长度切分（行为与升级前逐字相同）
  if (!splittable) return splitIntoMessages(source, { maxChars, minChunk: opts.minChunk ?? 20 })
  return parts
}
