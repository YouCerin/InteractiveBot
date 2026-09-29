/**
 * 表情包的**配额与状态**：三档频率、冷却、每日上限、失败冷却。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么配额必须落盘（而不是放内存）
 * ══════════════════════════════════════════════════════════════════════════
 * 这是设计上的一个洞，不是优化项：每日上限如果只在内存里，**桥接重启一次配额就清零**。
 * 而"发太多表情"是账号风控相关的行为特征 —— 一个靠重启就能绕过的限制等于没有限制。
 * 所以计数写进 `usage.json`（机器写、可丢、格式坏掉就重置为保守值）。
 *
 * ── 为什么冷却的判据是"时间 + 轮数"两个都要 ─────────────────────────────
 * 只有时间：一轮对话里对方连发三条，30 秒内可能发三次（受每轮上限保护，但观感差）。
 * 只有轮数：三轮可能只过了 4 秒（对方在刷屏），连续两条表情贴在一起。
 * 两个一起判，才对应"既不太密、也不太频繁"这个真实要求。
 *
 * ── 失败冷却为什么单独一条 ───────────────────────────────────────────────
 * 发送失败（通道断了、图被拒）时**不要立刻再试**：协议端可能已经收到但报错，
 * 重试会让对端看到两张一样的图。所以失败进 5 分钟冷却，并且**照样消耗一次配额**
 * （宁可少发，也不要"因为失败所以多试几次"）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { USAGE_FILE, scopeDirName, stickerRoot, writeJsonAtomic } from './sticker-library.mjs'

/** 失败后的冷却（毫秒）。 */
export const FAILURE_COOLDOWN_MS = 5 * 60 * 1000

/** 同一张图在**同一会话**里多久不许复用（毫秒）。 */
export const SAME_IMAGE_COOLDOWN_MS = 30 * 60 * 1000

/**
 * 三档频率的预设。
 *
 * 默认 `medium`（用户选定）。三档都是**预设**，展开成下面这几个独立数值；
 * 用户单独改了某个数值时仍然生效（预设只是默认值，不是互斥的模式）。
 *
 * `days` = 每日上限（按 `chatKey|日期` 计）。
 */
export const FREQUENCY_PRESETS = Object.freeze({
  low: Object.freeze({ minGapMs: 120_000, everyTurns: 3, maxPerTurn: 1, dailyLimit: 30 }),
  medium: Object.freeze({ minGapMs: 30_000, everyTurns: 2, maxPerTurn: 1, dailyLimit: 80 }),
  high: Object.freeze({ minGapMs: 10_000, everyTurns: 1, maxPerTurn: 2, dailyLimit: 200 }),
})

/** 出厂默认档。 */
export const DEFAULT_FREQUENCY = 'medium'

/** 三档的中文名（界面与日志用）。 */
export const FREQUENCY_NAMES = Object.freeze({ low: '低（保守）', medium: '中', high: '高' })

/**
 * 把配置收敛成一份**确定的**档位参数。
 *
 * 规则：先取预设，再用配置里显式给出的数值覆盖；非法值一律**回落预设**（不抛错 ——
 * 一个表情功能不该因为配置写错而让整个桥接起不来）。
 */
export function resolveFrequency(config = {}) {
  const level = String(config?.frequency ?? '').trim()
  const preset = FREQUENCY_PRESETS[level] ?? FREQUENCY_PRESETS[DEFAULT_FREQUENCY]
  const useLevel = FREQUENCY_PRESETS[level] ? level : DEFAULT_FREQUENCY
  const num = (v, fallback) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  return {
    level: useLevel,
    explicit: Boolean(FREQUENCY_PRESETS[String(config?.frequency ?? '').trim()]),
    minGapMs: num(config?.minGapMs, preset.minGapMs),
    everyTurns: Math.max(1, Math.round(num(config?.everyTurns, preset.everyTurns))),
    maxPerTurn: Math.max(1, Math.round(num(config?.maxPerTurn, preset.maxPerTurn))),
    dailyLimit: Math.max(1, Math.round(num(config?.dailyLimit, preset.dailyLimit))),
  }
}

/** 空台账。 */
export function emptyUsage() {
  return { version: 1, scopes: {}, updatedAt: null }
}

/** 读台账。坏了就**重置为保守值**（返回空台账），绝不因台账坏掉打断对话。 */
export function readStickerUsage({ workspace, dir } = {}) {
  const root = stickerRoot({ workspace, dir })
  if (!root) return emptyUsage()
  const file = join(root, USAGE_FILE)
  if (!existsSync(file)) return emptyUsage()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const usage = emptyUsage()
    // ★ 坏值必须**逐层**挡住：JSON 合法但 scopes 不是对象（或某槽不是对象）时，
    //   如果直接信任它，后面 `slot.sentAt` 之类的取值会抛错 —— 而这里是每轮都要跑的路径，
    //   抛一次就等于这条消息永远发不出去。所以只收"形状对得上"的部分。
    if (raw && typeof raw === 'object' && raw.scopes && typeof raw.scopes === 'object') {
      for (const [key, slot] of Object.entries(raw.scopes)) {
        if (!slot || typeof slot !== 'object') continue
        usage.scopes[key] = {
          day: typeof slot.day === 'string' ? slot.day : '',
          count: Number.isFinite(Number(slot.count)) ? Number(slot.count) : 0,
          sentAt: Array.isArray(slot.sentAt) ? slot.sentAt : [],
          images: slot.images && typeof slot.images === 'object' ? slot.images : {},
          failures: Array.isArray(slot.failures) ? slot.failures : [],
        }
      }
    }
    return usage
  } catch {
    return emptyUsage()
  }
}

/** 写台账。 */
export function writeStickerUsage({ workspace, dir } = {}, usage) {
  const root = stickerRoot({ workspace, dir })
  if (!root) return { ok: false }
  try {
    writeJsonAtomic(join(root, USAGE_FILE), { version: 1, ...usage, updatedAt: new Date().toISOString() })
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** 台账里的一个会话槽（不存在就初始化）。 */
function slotOf(usage, scope) {
  const key = scopeDirName(scope)
  if (!usage.scopes[key] || typeof usage.scopes[key] !== 'object') {
    usage.scopes[key] = { day: '', count: 0, sentAt: [], images: {}, failures: [] }
  }
  const slot = usage.scopes[key]
  if (!Array.isArray(slot.sentAt)) slot.sentAt = []
  if (!slot.images || typeof slot.images !== 'object') slot.images = {}
  if (!Array.isArray(slot.failures)) slot.failures = []
  return slot
}

/** `YYYY-MM-DD`（本地日；每日上限按"当地的一天"才算得对）。 */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 把时间戳归一到毫秒（ISO 字符串与数字都收）。 */
function toMs(v) {
  if (v == null) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : null
}

/** 台账里"当天的计数"读出来（跨天自动归零，但**不写盘** —— 纯读）。 */
export function dailyCount(usage, scope, now = Date.now()) {
  const key = scopeDirName(scope)
  const slot = usage?.scopes?.[key]
  if (!slot) return 0
  return slot.day === dayKey(now) ? Number(slot.count ?? 0) : 0
}

/**
 * 配额检查（**纯函数**：只读传入的状态，不写盘）。
 *
 * 判定顺序：失败冷却 → 最小间隔 → 每 N 轮 → 每日上限 → 同图冷却。
 * 顺序有意义：先报最"硬"的原因（失败了就别再试），最后才是观感类的原因。
 *
 * @param {{ turnCount?: number, recentStickerRels?: string[], rel?: string, now?: number, quota?: object }} input
 * @returns {{ ok: boolean, reason?: string, waitMs?: number }}
 */
export function checkStickerQuota(input = {}) {
  const now = Number(input.now ?? Date.now())
  const quota = input.quota ?? resolveFrequency({})
  const scope = input.scope ?? 'global'
  const usage = input.usage ?? emptyUsage()
  const slot = usage?.scopes?.[scopeDirName(scope)]

  // ① 失败冷却
  const lastFailure = (slot?.failures ?? []).map(toMs).filter((t) => t != null).sort((a, b) => b - a)[0]
  if (lastFailure != null) {
    const left = FAILURE_COOLDOWN_MS - (now - lastFailure)
    if (left > 0) {
      return { ok: false, reason: `上次发送失败，冷却中（还有 ${Math.ceil(left / 1000)} 秒）`, waitMs: left }
    }
  }

  // ② 最小间隔
  const sentAt = (slot?.sentAt ?? []).map(toMs).filter((t) => t != null).sort((a, b) => b - a)
  const lastSent = sentAt[0] ?? null
  if (lastSent != null) {
    const left = Number(quota.minGapMs ?? 0) - (now - lastSent)
    if (left > 0) {
      return { ok: false, reason: `距上次发表情才 ${Math.round((now - lastSent) / 1000)} 秒（下限 ${Math.round(quota.minGapMs / 1000)} 秒）`, waitMs: left }
    }
  }

  // ③ 每 N 轮最多一次
  const everyTurns = Number(quota.everyTurns ?? 2)
  const turns = Number(input.turnCount ?? 0)
  if (everyTurns > 1 && lastSent != null && turns > 0) {
    // 这一轮是第 N 轮时，距上次发送至少隔了 everyTurns-1 轮
    if (turns % everyTurns !== 0) {
      return { ok: false, reason: `档位要求每 ${everyTurns} 轮最多 1 次（当前第 ${turns} 轮）` }
    }
  }

  // ④ 每日上限
  const used = dailyCount(usage, scope, now)
  if (used >= Number(quota.dailyLimit ?? 80)) {
    return { ok: false, reason: `今天这个会话已发满 ${quota.dailyLimit} 张（每日上限）` }
  }

  // ⑤ 同一张图在这个会话里的冷却
  const rel = String(input.rel ?? '')
  if (rel) {
    const lastImage = toMs(slot?.images?.[rel])
    if (lastImage != null) {
      const left = SAME_IMAGE_COOLDOWN_MS - (now - lastImage)
      if (left > 0) {
        return { ok: false, reason: `这张图在 ${Math.round((now - lastImage) / 60000)} 分钟前刚发过`, waitMs: left }
      }
    }
  }

  // 最近发过的图（供打分侧扣分，避免"换了个标签但还是同一张脸"）
  const recent = [...(input.recentStickerRels ?? [])]
  return { ok: true, recent, sentToday: used }
}

/**
 * 记录一次发送（成功）。**只在发送成功后调用**。
 *
 * 同时做三件事：最小间隔计时、当天计数（跨天自动归零）、同图冷却。
 */
export function recordStickerSent({ workspace, dir, scope, rel, now = Date.now() } = {}) {
  const read = { workspace, dir }
  const usage = readStickerUsage(read)
  const slot = slotOf(usage, scope)
  const day = dayKey(now)
  if (slot.day !== day) {
    slot.day = day
    slot.count = 0
  }
  slot.count = Number(slot.count ?? 0) + 1
  slot.sentAt = [...slot.sentAt, now].slice(-50)
  if (rel) slot.images[rel] = now
  // 失败冷却：成功一次就清掉（说明通道已经好了）
  slot.failures = []
  const written = writeStickerUsage(read, usage)
  return { ok: true, count: slot.count, day, written }
}

/** 记录一次发送失败（进冷却、**照样算消耗**）。 */
export function recordStickerFailure({ workspace, dir, scope, rel, now = Date.now() } = {}) {
  const read = { workspace, dir }
  const usage = readStickerUsage(read)
  const slot = slotOf(usage, scope)
  slot.failures = [...slot.failures, now].slice(-10)
  // ★ 失败也算一次：宁可少发，也不要"因为失败所以多试几次"
  const day = dayKey(now)
  if (slot.day !== day) {
    slot.day = day
    slot.count = 0
  }
  slot.count = Number(slot.count ?? 0) + 1
  slot.sentAt = [...slot.sentAt, now].slice(-50)
  writeStickerUsage(read, usage)
  return { ok: true, cooldownMs: FAILURE_COOLDOWN_MS }
}

/** 台账摘要（控制台"今天发了多少"用）。 */
export function stickerUsageSummary({ workspace, dir } = {}, now = Date.now()) {
  const usage = readStickerUsage({ workspace, dir })
  const out = []
  for (const [key, slot] of Object.entries(usage.scopes ?? {})) {
    out.push({
      scope: key,
      today: slot.day === dayKey(now) ? Number(slot.count ?? 0) : 0,
      lastSentAt: (slot.sentAt ?? []).map(toMs).filter((t) => t != null).sort((a, b) => b - a)[0] ?? null,
      failures: (slot.failures ?? []).length,
    })
  }
  return out
}
