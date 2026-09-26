/**
 * 操作日志（oplog）：**记住自己干过什么**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 两条设计原则（都来自已经踩过的坑）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **① 桥接自己写，不问模型。**
 *   记忆诊断（`docs/0.2.1-memory-diagnosis.md`）已经证明："让模型报告自己做过什么"
 *   这件事漏报率极高 —— 实测几十轮里它一次都没主动记。而**事件流里全都有**：
 *   `tool/call` 带完整 `arguments`、`tool/result` 带内容与 `isError`。
 *   桥接收到了却扔掉（`session-bridge.mjs` 原先只留工具名），那才是原料缺口。
 *   所以这里只做"把已经收到的事件写下来"，**不做任何判断、不依赖任何模型行为**。
 *
 * **② 写的是索引，不是内容仓库。**
 *   实测一次 `web_fetch` 的结果就是整篇文章；操作日志如果存全文，
 *   它会迅速比记忆库大几个数量级，而且**把外部网页内容复制进了本地磁盘**。
 *   所以每条结果只留 `excerpt`（截断），全文留在 DSH 的会话记录里。
 *
 * ── 为什么按 `chatKey + 日期` 分文件 ────────────────────────────────────
 *   · 按 chatKey：一个会话的事只有它能看（与记忆的分档隔离同一思路）
 *   · 按日期：**方便按 TTL 清理**（删旧文件就是删旧日志，不用读内容）
 *
 * ── 隐私：写盘前筛一遍 ─────────────────────────────────────────────────
 *   `pwsh` 的结果里可能带出密钥、身份证号之类的。虽然已经截断到 300 字，
 *   但**能带出一个就够呛**，所以走 `screenForStore` 的判据，命中就把
 *   `excerpt` 换成占位符（**保留结构，只隐内容** —— 这样"这一步失败了"
 *   这件事仍然可查，只是看不到原文）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { screenForStore, logPrivacyBlock, PRIVACY_CATEGORIES } from './privacy.mjs'

/** 类别键 → 中文名（`--ops` 是给人看的，`credential` 这种键读不懂）。 */
const catName = (c) => PRIVACY_CATEGORIES[c] ?? c

/** 默认保留天数（TTL）。超过就删文件。 */
export const OPLOG_TTL_DAYS = 7

/** 单个文件的字节上限 —— 超出就**不再追加**（防它长成一个巨型文件）。 */
export const OPLOG_MAX_BYTES = 2 * 1024 * 1024

/** 本地时区的 `YYYY-MM-DD`（**不用 UTC** —— 用户的"今天"是本地的今天）。 */
export function localDayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** `chatKey` 里的 `:` 等字符在文件名里不安全，统一替换。 */
function safeChatKey(chatKey) {
  return String(chatKey ?? 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_')
}

/** 某个会话某天的日志文件（工作区相对路径）。 */
export function oplogRel(chatKey, day = localDayKey()) {
  return `runtime/oplog/${safeChatKey(chatKey)}-${day}.jsonl`
}

/**
 * 把一条操作流水写成一行 JSONL。
 *
 * **绝不抛异常**：操作日志是观测手段，写不进去也不能影响回合
 *（与 `memory-stats.mjs` 同一条纪律）。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} opts.chatKey
 * @param {object} opts.op        `TurnCollector.ops` 里的一条
 * @param {Date}   [opts.now]
 * @returns {{ok: boolean, rel?: string, why?: string}}
 */
export function appendOp({ workspace, chatKey, op, now = new Date() } = {}) {
  const root = String(workspace ?? '')
  if (!root || !op) return { ok: false, why: '缺少 workspace 或 op' }
  const rel = oplogRel(chatKey, localDayKey(now))
  const abs = join(root, rel)
  try {
    // 隐私：**只筛会被写下去的那个字段**（`excerpt`）。
    // 参数（args）也可能含隐私，但它同样会被筛 —— 见下。
    const row = { ts: now.getTime(), chatKey: String(chatKey ?? ''), ...op }
    let privHit = null
    if (typeof row.excerpt === 'string' && row.excerpt) {
      const r = screenForStore(row.excerpt)
      if (!r.ok) {
        privHit = r.categories
        row.excerpt = `[已隐去：含隐私（${r.categories.map(catName).join('、')}）]`
      }
    }
    if (row.args && typeof row.args === 'object') {
      const r = screenForStore(JSON.stringify(row.args))
      if (!r.ok) {
        privHit = [...(privHit ?? []), ...r.categories]
        row.args = { _redacted: `含隐私（${r.categories.map(catName).join('、')}）` }
      }
    }

    // 体积上限：超了就不再追加（**明说**，不静默丢）
    try {
      if (existsSync(abs) && statSync(abs).size >= OPLOG_MAX_BYTES) {
        return { ok: false, rel, why: `文件已达上限 ${OPLOG_MAX_BYTES} 字节，本回合不再追加` }
      }
    } catch {
      /* 查不到大小就照写 */
    }

    mkdirSync(join(abs, '..'), { recursive: true })
    appendFileSync(abs, `${JSON.stringify(row)}\n`, 'utf8')

    if (privHit) {
      logPrivacyBlock({
        workspace: root,
        side: 'store',
        categories: [...new Set(privHit)],
        length: 0,
        chatKey: String(chatKey ?? ''),
      })
    }
    return { ok: true, rel }
  } catch (error) {
    return { ok: false, rel, why: error?.message ?? String(error) }
  }
}

/**
 * 把一个回合的整条流水追加下去。返回写成功的条数。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} opts.chatKey
 * @param {object[]} opts.ops
 */
export function appendTurnOps({ workspace, chatKey, ops = [] } = {}) {
  let written = 0
  let firstWhy = null
  for (const op of ops) {
    const r = appendOp({ workspace, chatKey, op })
    if (r.ok) written += 1
    else if (!firstWhy) firstWhy = r.why
  }
  return { written, total: ops.length, why: firstWhy }
}

/** 列出某会话的 oplog 文件（相对路径，新的在前）。 */
export function listOplogs({ workspace, chatKey = null } = {}) {
  try {
    const dir = join(String(workspace ?? ''), 'runtime', 'oplog')
    if (!existsSync(dir)) return []
    const prefix = chatKey ? `${safeChatKey(chatKey)}-` : ''
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && f.startsWith(prefix))
      .map((f) => `runtime/oplog/${f}`)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** 读某会话的操作流水（新的在前）。只读。 */
export function readOps({ workspace, chatKey = null, limit = 100, day = null } = {}) {
  const rels = day
    ? (chatKey ? [oplogRel(chatKey, day)] : listOplogs({ workspace, chatKey }))
    : listOplogs({ workspace, chatKey })
  const rows = []
  for (const rel of rels) {
    let text = ''
    try {
      text = readFileSync(join(String(workspace ?? ''), rel), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push({ ...JSON.parse(line), _rel: rel })
      } catch {
        /* 坏行跳过 */
      }
    }
    if (rows.length >= limit * 2) break
  }
  rows.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
  return rows.slice(0, Math.max(1, limit))
}

/**
 * 按 TTL 清理旧日志（**默认预演**）。
 *
 * 判据用**文件名里的日期**，不读内容 —— 所以清理是 O(文件数) 且不需要解析。
 * 解析不出日期的文件**不删**（宁可留着，也不要误删一个不确定的文件）。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {number} [opts.days] 保留天数
 * @param {boolean} [opts.apply] false = 只报告要删哪些
 */
export function pruneOplogs({ workspace, days = OPLOG_TTL_DAYS, apply = false, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - Math.max(0, Number(days) || 0) * 86400000)
  const cutoffKey = localDayKey(cutoff)
  const dir = join(String(workspace ?? ''), 'runtime', 'oplog')
  const removed = []
  const kept = []
  const skipped = []
  try {
    if (!existsSync(dir)) return { removed, kept, skipped, cutoff: cutoffKey }
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      const m = /-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)
      if (!m) {
        skipped.push(f) // 认不出日期 → 不动它
        continue
      }
      if (m[1] < cutoffKey) {
        if (apply) {
          try {
            // ⚠️ `unlinkSync` 而不是 `rmSync`（与 tasks / recipes / memory-files /
            //    images / api 同一教训）：Node v24.9.0 / Windows 上后者删单个文件
            //    会静默失败或崩进程。复核一次，别信"调用没报错"。
            unlinkSync(join(dir, f))
            if (existsSync(join(dir, f))) {
              skipped.push(f)
              continue
            }
          } catch {
            skipped.push(f)
            continue
          }
        }
        removed.push(f)
      } else {
        kept.push(f)
      }
    }
  } catch {
    /* 目录读不到就什么都不做 */
  }
  return { removed, kept, skipped, cutoff: cutoffKey }
}
