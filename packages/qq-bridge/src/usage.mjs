/**
 * 用量记账：把每个回合真实的 token 消耗落盘，并算成本。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 数据是真的，钱是估的 —— 这个区分贯穿整个模块
 * ══════════════════════════════════════════════════════════════════════════
 * DSH 的 `assistant/message` 事件带 `usage` 字段，实测一轮 15 个步骤全都带。
 * 所以 **token 数是"量出来的"**。而价格 DSH 不给（见 prices.mjs），
 * 所以 **成本是"按 prices.json 估的"**。两者在本模块里**分开放**，
 * 就是为了让界面不可能把它们混为一谈。
 *
 * ── 三个口径（做错了账会差几十倍，全部有实测依据）───────────────────────
 * ① `totalTokens` **不能求和**。它是"这一步的上下文有多大"（一个快照），
 *    随对话推进单调增长。实测那一轮 15 步的 totalTokens 之和与
 *    `input+cacheRead+output` 之和**恰好都等于 252,418** —— 数值上巧合相等，
 *    但**单位不同**：一旦发生上下文裁剪（compaction）后重新增长，
 *    totalTokens 会回落，两者立刻分道扬镳。所以只取**最后一步**的值存为
 *    `lastContextTokens`，绝不参与求和。
 *
 * ② `inputTokens` 是**未命中缓存的**输入。实测恒等式（15 步全成立）：
 *        inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens === totalTokens
 *    而缓存命中价差 50 倍，所以这两个字段**必须分开显示**，
 *    否则看的人完全看不出钱花在哪。
 *
 * ③ `reasoningTokens` 是 `outputTokens` 的**一部分**，不是额外一项。
 *    可以显示，但**绝不能再加一遍**进总量。
 *
 * ── 为什么要自己记账，不读 DSH 的会话日志 ────────────────────────────────
 * DSH 的会话日志（`sessions/<workspace>/<sessionId>/session.v3.jsonl.zstd`）
 * 里确实有 usage，但：
 *   · 那是 **zstd 按帧追加**的格式，**读的时候可能读到半截**
 *     （实测：同一个文件先看到 207 字节的会话头，过一会儿变成 42KB）；
 *   · 它是 DSH 的**内部格式**，版本一变（已有 v0→v1→v2→v3 迁移）就废。
 * 所以本模块维护**自己的**追加式账本，格式由我们定，也不依赖 DSH 的写入时机。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { estimateCost as estimateCostFn } from './prices.mjs'

/**
 * 汇总一组 token。
 *
 * ★ 关键细节：`cacheWrite` / `reasoning` **可能缺席**。
 * 缺席时保持 `null` —— **不要补 0**。
 * `0` 的意思是"测到了 0"，`null` 的意思是"没测到"。这是两件完全不同的事，
 * 而界面要据此决定显示 `0` 还是 `—`。
 */
export function sumTokens(list) {
  const known = (key) => {
    const vals = list.map((t) => t?.[key]).filter((v) => typeof v === 'number' && Number.isFinite(v))
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null
  }
  return {
    input: known('input') ?? 0,
    cacheRead: known('cacheRead') ?? 0,
    cacheWrite: known('cacheWrite'),
    output: known('output') ?? 0,
    reasoning: known('reasoning'),
  }
}

/**
 * 缓存命中率 = 命中 / 全部输入。
 *
 * ★ 分母是**全部输入**（未命中 + 命中），不是只看未命中。
 * ★ 分母为 0 时返回 `null`，**不是 0**：
 *   `0%` 是结论（算了，一次没命中），`null` 是没数据（没有输入，算不出）。
 */
export function cacheHitRate(tokens) {
  const input = Number(tokens?.input) || 0
  const cacheRead = Number(tokens?.cacheRead) || 0
  const total = input + cacheRead + (Number(tokens?.cacheWrite) || 0)
  if (total <= 0) return null
  return cacheRead / total
}

/** 本地日期（按给定时区），形如 `2026-09-25`。用来按天聚合。 */
function localYmd(ms, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    return fmt.format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

/**
 * 用量账本。
 *
 * @param {object} opts
 * @param {string} opts.file          账本路径（相对包根已由调用方解析好）
 * @param {object} opts.priceBook     createPriceBook 的产物
 * @param {(msg: string) => void} [opts.log]
 * @param {boolean} [opts.enabled]
 */
export function createUsageLedger({ file, priceBook, log = () => {}, enabled = true } = {}) {
  const timeZone = () => priceBook?.snapshot()?.peak?.timezone || 'Asia/Shanghai'

  /**
   * 写一条记录。**追加写**，不改动已有内容。
   *
   * 成本在这里就算好并写进去，因为峰谷必须按"**调用发生的那一刻**"判定；
   * 若等查询时再算，同一笔账会因为"现在几点了"而变动 —— 那就不是账。
   */
  function record(entry) {
    if (!enabled) return null
    const at = entry?.at instanceof Date ? entry.at : new Date(entry?.at ?? Date.now())
    const tokens = {
      input: Number(entry?.tokens?.input) || 0,
      cacheRead: Number(entry?.tokens?.cacheRead) || 0,
      cacheWrite: typeof entry?.tokens?.cacheWrite === 'number' ? entry.tokens.cacheWrite : null,
      output: Number(entry?.tokens?.output) || 0,
      reasoning: typeof entry?.tokens?.reasoning === 'number' ? entry.tokens.reasoning : null,
    }

    const priced = priceBook?.rateForAt?.(entry?.route, at) ?? null
    let cost = null
    let rateKey = null
    if (priced) {
      rateKey = priced.rateKey
      cost = estimateCostFn(tokens, priced.rate, priced.rateKey)
    }

    const rec = {
      at: at.toISOString(),
      chatKey: entry?.chatKey ?? null,
      kind: entry?.kind ?? null,
      label: entry?.label ?? null,
      route: entry?.route ?? null,
      tokens,
      turns: 1,
      cacheHitRate: cacheHitRate(tokens),
      lastContextTokens: Number.isFinite(entry?.lastContextTokens) ? entry.lastContextTokens : null,
      rateKey,
      cost,
    }

    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
    } catch (error) {
      // 记账失败不能影响机器人回话 —— 那才是主要职能。
      log(`⚠️ 用量记账写入失败：${error.message}`)
    }
    return rec
  }

  /** 读全部记录。坏行跳过（追加写时进程被杀可能留下半行）。 */
  function readAll() {
    if (!file || !existsSync(file)) return []
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      log(`⚠️ 用量账本读取失败：${error.message}`)
      return []
    }
    const out = []
    let bad = 0
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line)
        if (rec && typeof rec === 'object' && typeof rec.at === 'string') out.push(rec)
      } catch {
        bad += 1
      }
    }
    if (bad) log(`⚠️ 用量账本有 ${bad} 行无法解析，已跳过（多半是写入时被打断的半行）`)
    return out
  }

  /**
   * 按天 / 按会话聚合，并给出总计。
   *
   * @param {number} days 取最近几天；`0` 或负数 = 全部
   */
  function summarize(days = 7) {
    const all = readAll()
    const tz = timeZone()
    const now = Date.now()
    const cutoff = days > 0 ? now - days * 24 * 60 * 60 * 1000 : null
    const rows = cutoff ? all.filter((r) => Date.parse(r.at) >= cutoff) : all

    // ── 按天 ──
    const dayMap = new Map()
    for (const r of rows) {
      const date = localYmd(Date.parse(r.at), tz)
      if (!dayMap.has(date)) dayMap.set(date, [])
      dayMap.get(date).push(r)
    }
    const byDay = [...dayMap.entries()]
      .map(([date, list]) => {
        const tokens = sumTokens(list.map((r) => r.tokens))
        const costs = list.map((r) => r.cost).filter((c) => typeof c === 'number')
        return {
          date,
          turns: list.reduce((a, r) => a + (Number(r.turns) || 1), 0),
          tokens,
          cacheHitRate: cacheHitRate(tokens),
          cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
        }
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1)) // 新的在上，和参考图一致

    // ── 按会话 ──
    // ⚠️ chatKey 来自账本，属于"外部输入"，所以**不拿它当对象键**
    //    （`__proto__` 之类会造成麻烦），改用 Map。
    const chatMap = new Map()
    for (const r of rows) {
      const key = r.chatKey || `unknown:${r.label ?? '?'}`
      if (!chatMap.has(key)) chatMap.set(key, [])
      chatMap.get(key).push(r)
    }
    const bySession = [...chatMap.entries()]
      .map(([chatKey, list]) => {
        const tokens = sumTokens(list.map((r) => r.tokens))
        const costs = list.map((r) => r.cost).filter((c) => typeof c === 'number')
        const last = list[list.length - 1]
        return {
          chatKey,
          kind: last.kind ?? 'unknown',
          label: last.label ?? chatKey,
          turns: list.reduce((a, r) => a + (Number(r.turns) || 1), 0),
          tokens,
          cacheHitRate: cacheHitRate(tokens),
          cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
        }
      })
      .sort((a, b) => b.turns - a.turns)

    // ── 成本可不可用 ──
    // ★ 只有在"每条记录都算出了成本"时才说 available。
    //   部分有、部分没有时给一个残缺的总数，会被读成"总共就花了这么多"，那是错的。
    const costRows = rows.map((r) => r.cost)
    const costAvailable = costRows.length > 0 && costRows.every((c) => typeof c === 'number')
    const snapshot = priceBook?.snapshot?.()
    const lastContextTokens = [...rows].reverse().find((r) => typeof r.lastContextTokens === 'number')
    const totalsTokens = sumTokens(rows.map((r) => r.tokens))

    return {
      range: {
        days,
        from: rows.length ? rows[0].at : null,
        to: rows.length ? rows[rows.length - 1].at : null,
      },
      totals: {
        turns: rows.reduce((a, r) => a + (Number(r.turns) || 1), 0),
        tokens: totalsTokens,
        cacheHitRate: cacheHitRate(totalsTokens),
        lastContextTokens: lastContextTokens?.lastContextTokens ?? null,
      },
      cost: {
        available: costAvailable,
        amount: costAvailable ? costRows.reduce((a, b) => a + b, 0) : null,
        currency: 'CNY',
        basis: costAvailable ? `${snapshot?.source ?? 'prices.json'}@${snapshot?.updatedAt ?? '未标注'}` : null,
        note: '估算值，不是官方账单。',
      },
      byDay,
      bySession,
    }
  }

  return { record, readAll, summarize, file }
}
