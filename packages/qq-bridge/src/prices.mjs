/**
 * 价目表：加载 + 峰谷时段判定 + 成本估算。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么价格要我们自己维护（这是本模块存在的唯一理由）
 * ══════════════════════════════════════════════════════════════════════════
 * 查过 DSH 的实现（`dsh-token-meter` / `dsh-llm-deepseek`）：
 *   · `dsh-token-meter` 里确实有 "pricing"，但那是**视觉 token 折算**
 *     （把图片折算成多少 token），不是人民币价目表；
 *   · `dsh-llm-deepseek` 里**没有单价**。
 * 结论：**DSH 从头到尾不给钱数。** 所以要显示成本，只能自己维护一张表。
 *
 * 这决定了本模块的两个设计：
 *   ① 价格放在**独立文件** `prices.json`（改它不需要重启桥接）；
 *   ② 一切成本都必须叫「**估算**」，且界面上要能追溯到这张表。
 *
 * ── 峰谷时段 ─────────────────────────────────────────────────────────────
 * DeepSeek 的高峰时段是**北京时间周一至周五 9:00-12:00、14:00-18:00**
 * （不含法定节假日），高峰价是空闲价的 2 倍。
 *
 * ⚠️ 法定节假日**无法靠日期算出来**（国务院每年发通知，还有调休补班），
 * 所以 `holidays` 是一张**人工维护**的表，默认空。
 * 空着时节假日会被判成高峰 —— 也就是**偏保守（可能偏高）**。
 * 这一点必须如实告诉使用者，不能假装精确。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** 时段名。`peak` = 高峰（贵），`offPeak` = 空闲（便宜）。 */
export const PERIOD = { PEAK: 'peak', OFF_PEAK: 'offPeak' }

/** 给界面直接用的文案（界面不要自己拼，这里改一处就够）。 */
export const PERIOD_INDICATOR = {
  [PERIOD.PEAK]: '当前：高峰时段',
  [PERIOD.OFF_PEAK]: '当前：低谷时段',
}

/**
 * 峰谷判定不出来时的结果。
 *
 * ★ 为什么要有这个东西：拿不到价目表时我们**不知道**现在是什么时段。
 * 这时必须显示「时段未知」，**绝不能显示"低谷"** ——
 * 万一正好在高峰，使用者会以为便宜而放心烧 token。
 * 用假的好消息换真损失，是最不划算的一种错。
 */
export const UNKNOWN_PERIOD = {
  period: null,
  isPeak: null,
  rateKey: null,
  indicator: '时段未知',
  reason: 'no-prices',
  reasonText: '没有可用的价目表，无法判断当前时段。',
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** `"HH:MM"` → 当天第几分钟。用于比较，避免字符串比较的坑。 */
export function toMinutes(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * 取某个时刻在指定时区的"墙上时间"。
 *
 * ★ 必须用 Intl，**不能直接 `date.getHours()`**。
 * `getHours()` 给的是**运行进程当地时区**的小时数；桥接跑在别的时区时，
 * 就会拿"当地下午 3 点"去套"北京高峰窗口"。
 * 这是那种没人报障、但账一直错的 bug —— 时区对的人永远测不出来。
 *
 * 实测：把进程 TZ 设成 UTC / America/New_York / Asia/Tokyo，本函数结果不变。
 *
 * 另：`hour12:false` 在个别 locale 下午夜会输出 `"24:00"`（会让解析出错）。
 * 实测 en-CA 在 Node 24 下输出 `"00"`，无此问题 —— 但换 locale 时要复验。
 */
export function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  const out = {}
  for (const part of fmt.formatToParts(date)) out[part.type] = part.value
  return {
    ymd: `${out.year}-${out.month}-${out.day}`,
    hm: `${out.hour}:${out.minute}`,
    weekday: WEEKDAY_INDEX[out.weekday] ?? 0,
  }
}

/**
 * 判断某时刻属于高峰还是空闲。
 *
 * 判定顺序（**顺序本身就是规则**）：节假日 → 周末 → 是否落在窗口内。
 * 窗口按**左闭右开**：`09:00` 算高峰，`12:00` 算低谷 ——
 * 否则整点那一刻会有两个答案。
 *
 * @param {object} peak `prices.json` 里的 peak 段
 * @param {Date} [now]
 * @returns {{period: string, isPeak: boolean, rateKey: string, indicator: string,
 *            reason: string, reasonText: string, at: string, weekday: number}}
 */
export function computePeriod(peak, now = new Date()) {
  const tz = peak?.timezone || 'Asia/Shanghai'
  const { ymd, hm, weekday } = zonedParts(now, tz)

  const base = {
    at: `${ymd}T${hm}:00`,
    weekday,
    timezone: tz,
  }

  const holidays = new Set(Array.isArray(peak?.holidays) ? peak.holidays : [])
  const days = Array.isArray(peak?.days) && peak.days.length ? peak.days : [1, 2, 3, 4, 5]
  const windows = Array.isArray(peak?.windows) ? peak.windows : []

  const offPeak = (reason, reasonText) => ({
    ...base,
    period: PERIOD.OFF_PEAK,
    isPeak: false,
    rateKey: PERIOD.OFF_PEAK,
    indicator: PERIOD_INDICATOR[PERIOD.OFF_PEAK],
    reason,
    reasonText,
  })
  const peakResult = (reasonText) => ({
    ...base,
    period: PERIOD.PEAK,
    isPeak: true,
    rateKey: PERIOD.PEAK,
    indicator: PERIOD_INDICATOR[PERIOD.PEAK],
    reason: 'window',
    reasonText,
  })

  if (holidays.has(ymd)) {
    return offPeak('holiday', `${ymd} 在节假日表里，按空闲时段计价。`)
  }
  if (!days.includes(weekday)) {
    return offPeak('weekend', '今天是周末，全天按空闲时段计价。')
  }

  const cur = toMinutes(hm)
  if (cur === null) return { ...UNKNOWN_PERIOD, ...base }

  for (const w of windows) {
    const start = toMinutes(w?.start)
    const end = toMinutes(w?.end)
    if (start === null || end === null) continue
    // 跨午夜的窗口（如 23:00-07:00）语义会歧义，这里**明确不支持**：
    // start >= end 视为配置错误而跳过，以免把半夜判成高峰。
    if (start >= end) continue
    if (cur >= start && cur < end) {
      return peakResult(`落在高峰时段窗口 ${w.start}–${w.end} 内。`)
    }
  }
  return offPeak('outside-window', '今天是工作日，但当前不在高峰时段窗口内。')
}

/**
 * 下一次峰谷切换的时刻（ISO）。拿不到就返回 null。
 *
 * 用途：界面可以显示"还有 N 分钟到低谷"，比单纯一个状态更有行动价值。
 * 只找当天的剩余窗口边界；找不到就返回 null（**不要**编一个明天的出来，
 * 那种"看起来精确其实错的"信息比没有更糟）。
 */
export function nextChangeAt(peak, now = new Date()) {
  const tz = peak?.timezone || 'Asia/Shanghai'
  const { ymd, hm, weekday } = zonedParts(now, tz)
  const holidays = new Set(Array.isArray(peak?.holidays) ? peak.holidays : [])
  const days = Array.isArray(peak?.days) && peak.days.length ? peak.days : [1, 2, 3, 4, 5]
  if (holidays.has(ymd) || !days.includes(weekday)) return null

  const cur = toMinutes(hm)
  if (cur === null) return null
  const bounds = []
  for (const w of Array.isArray(peak?.windows) ? peak.windows : []) {
    const s = toMinutes(w?.start)
    const e = toMinutes(w?.end)
    if (s === null || e === null || s >= e) continue
    bounds.push(s, e)
  }
  const next = bounds.filter((b) => b > cur).sort((a, b) => a - b)[0]
  if (next === undefined) return null
  const hh = String(Math.floor(next / 60)).padStart(2, '0')
  const mm = String(next % 60).padStart(2, '0')
  return `${ymd}T${hh}:${mm}:00`
}

/** 从价目表里取某条路由的单价组。取不到返回 null（**不要编默认价**）。 */
export function rateFor(prices, route) {
  const table = prices?.routes
  if (!table || typeof table !== 'object') return null
  if (route && typeof table[route] === 'object' && table[route] !== null) return table[route]
  // 路由对不上时的兜底：整张表只有一条路由，那就用它。
  // 为什么敢这么兜：使用者通常只配一个模型；而"算不出价"会让整块成本显示 —
  // 相比之下"用唯一那条价"更可能是他想要的。多条路由时**不猜**，返回 null。
  const keys = Object.keys(table).filter((k) => !k.startsWith('_'))
  if (keys.length === 1) return table[keys[0]]
  return null
}

/**
 * 估算一次调用的成本（元）。
 *
 *    成本 = 未缓存输入/1e6 × cacheMiss
 *         + 缓存命中  /1e6 × cacheHit
 *         + 输出      /1e6 × output
 *
 * `reasoningTokens` **不单独计费** —— 它本来就是 `outputTokens` 的一部分，
 * 再加一遍就是重复计费。
 *
 * @returns {number|null} 取不到单价时返回 null（调用方要显示 `—` 而不是 ¥0）
 */
export function estimateCost(tokens, rate, rateKey) {
  if (!rate || !tokens) return null
  const miss = rate.cacheMissPerM?.[rateKey]
  const hit = rate.cacheHitPerM?.[rateKey]
  const out = rate.outputPerM?.[rateKey]
  if (![miss, hit, out].every((v) => typeof v === 'number' && Number.isFinite(v))) return null

  const input = Number(tokens.input) || 0
  const cacheRead = Number(tokens.cacheRead) || 0
  const output = Number(tokens.output) || 0
  return (input / 1e6) * miss + (cacheRead / 1e6) * hit + (output / 1e6) * out
}

/**
 * 价目表读取器。
 *
 * ★ 为什么做成"每次读盘"而不是启动时读一次：
 * 价格会变，而改 `prices.json` **不应该需要重启机器人**
 * （这正是把它从 config.json 里分出来的原因）。
 * 文件很小，读盘成本可以忽略；再加一层 mtime 缓存避免无谓的解析。
 */
export function createPriceBook({ file, log = () => {} } = {}) {
  const absPath = file && isAbsolute(file) ? file : resolve(String(file ?? 'prices.json'))
  let cache = { mtimeMs: -1, data: null }

  function loadRaw() {
    if (!existsSync(absPath)) {
      return { loaded: false, error: `找不到价目表：${absPath}`, data: null }
    }
    let stat
    try {
      stat = statSync(absPath)
    } catch (error) {
      return { loaded: false, error: `读价目表失败：${error.message}`, data: null }
    }
    if (cache.data && cache.mtimeMs === stat.mtimeMs) {
      return { loaded: true, data: cache.data }
    }
    try {
      const text = readFileSync(absPath, 'utf8')
      const data = JSON.parse(text)
      cache = { mtimeMs: stat.mtimeMs, data }
      return { loaded: true, data }
    } catch (error) {
      // 解析失败要**明确失败**，不要回退到旧缓存 —— 否则使用者改错了价格
      // 却看到旧价格生效，会以为"改了没用"。
      log(`⚠️ 价目表解析失败：${error.message}`)
      return { loaded: false, error: `价目表不是合法 JSON：${error.message}`, data: null }
    }
  }

  /** 给 `/api/usage/prices` 用的完整视图。 */
  function snapshot(now = new Date()) {
    const { loaded, data, error } = loadRaw()
    if (!loaded) {
      return {
        source: absPath,
        loaded: false,
        error,
        now: UNKNOWN_PERIOD,
        warning: '价目表不可用，成本无法估算，时段也无法判断。',
      }
    }
    const peak = data?.peak ?? {}
    const holidays = Array.isArray(peak.holidays) ? peak.holidays : []
    const period = computePeriod(peak, now)
    return {
      source: absPath,
      updatedAt: data?._更新日期 ?? null,
      loaded: true,
      peak: {
        timezone: peak.timezone || 'Asia/Shanghai',
        windows: Array.isArray(peak.windows) ? peak.windows : [],
        days: Array.isArray(peak.days) && peak.days.length ? peak.days : [1, 2, 3, 4, 5],
        holidays,
      },
      now: {
        ...period,
        holidaysKnown: holidays.length > 0,
        nextChangeAt: nextChangeAt(peak, now),
      },
      routes: data?.routes ?? {},
      warning: holidays.length
        ? '价格会变，请定期核对官方页面。'
        : 'holidays 为空：法定节假日会被按高峰计价（偏高）。价格会变，请定期核对官方页面。',
    }
  }

  return {
    path: absPath,
    snapshot,
    /** 算成本用：返回 { rate, rateKey } 或 null。 */
    rateForAt(route, at = new Date()) {
      const { loaded, data } = loadRaw()
      if (!loaded) return null
      const rate = rateFor(data, route)
      if (!rate) return null
      const { rateKey } = computePeriod(data?.peak ?? {}, at)
      if (!rateKey) return null
      return { rate, rateKey }
    },
    periodAt(at = new Date()) {
      const { loaded, data } = loadRaw()
      if (!loaded) return UNKNOWN_PERIOD
      return computePeriod(data?.peak ?? {}, at)
    },
  }
}
