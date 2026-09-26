/**
 * 记忆变更审计：**谁、何时、哪条来源、什么档位、结果如何**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有它（以及为什么**不记原文**）
 * ══════════════════════════════════════════════════════════════════════════
 * 记忆现在是**四条通道**往里写（模型标记 / 关键词直写 / 管理员手段 / 整理合并），
 * 而在此之前没有任何一处能回答"这条是谁在什么时候写进去的" ——
 * 出问题时只能去翻 `logs/bridge.log` 的 `[memory] 记忆写入：接受 N 条`，
 * 而那行**不说是哪一条、也不说是哪条通道**。
 *
 * ★ **刻意不记原文**：审计文件如果也存一份记忆内容，那它自己就成了**第二个泄露面**
 *   （与 `privacy.mjs` 的"审计只记类别与长度、绝不记原文"是同一条纪律）。
 *   所以这里只记：时间 / 会话 / 谁 / 来源 / 档位 / 结果 / 原因 / **字数**。
 *   要查内容，去看记忆文件本身（它本来就在那里）。
 *
 * ⚠️ 它同样遵守"增强路径不许弄挂主流程"：**任何失败都只记一行日志**。
 *    但它**必须留证据**（`AGENT.md` 第 9 条）：写失败时会喊一声，而不是静默。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 审计文件（工作区相对路径）。 */
export const AUDIT_REL = 'memory/audit.jsonl'

/** 单行上限（防止一条超长 why 把文件撑爆；原文本来就不记）。 */
export const AUDIT_MAX_BYTES = 512 * 1024

/** 超过上限时保留最近多少行（**截断而不是删除整个文件**）。 */
export const AUDIT_KEEP_ROWS = 500

/** `why` 存进审计时的截断长度。 */
const WHY_MAX_CHARS = 80

/**
 * 追加一条审计。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {object} opts.entry `{source, scope, outcome, chatKey, senderId, why, chars, at}`
 * @param {(m: string) => void} [opts.log]
 * @returns {{ok: boolean, why?: string}}
 */
export function appendAuditEntry({ workspace, entry, log = () => {} } = {}) {
  const root = String(workspace ?? '')
  if (!root || !entry) return { ok: false, why: '缺少 workspace 或 entry' }
  const file = join(root, AUDIT_REL)
  const at = entry.at instanceof Date ? entry.at.toISOString() : String(entry.at ?? new Date().toISOString())
  const row = {
    at,
    chatKey: entry.chatKey ?? null,
    senderId: entry.senderId != null ? String(entry.senderId) : null,
    source: entry.source ?? null,
    scope: entry.scope ?? null,
    outcome: entry.outcome ?? null,
    // ⚠️ **没有 entry.text** —— 见文件头。只留长度。
    chars: Number.isFinite(Number(entry.chars)) ? Number(entry.chars) : null,
    why: entry.why ? String(entry.why).slice(0, WHY_MAX_CHARS) : null,
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    // 先看体积，超了就**先截断再追加**（一次读一次写，代价可接受：
    // 只有超过 512KB 才会走到这里，而那时本来就该收拾了）
    if (existsSync(file) && statSync(file).size > AUDIT_MAX_BYTES) {
      const kept = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-AUDIT_KEEP_ROWS)
      writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
    }
    appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8')
    return { ok: true }
  } catch (error) {
    // ★ 不许静默（AGENT.md 第 9 条）：审计写不进去意味着"变更没有留痕"，
    //   这正是它存在的理由 —— 必须让人看见。
    log(`❌ [memory] 审计写入失败（这次变更没有被留痕）：${error?.message ?? error}`)
    return { ok: false, why: error?.message ?? String(error) }
  }
}

/**
 * 读最近的审计（倒序返回，最多 `limit` 条）。
 *
 * @param {{workspace?: string, limit?: number}} [opts]
 * @returns {object[]} 解析不了的行**跳过**（半个 JSON 行不该让整个体检失败）
 */
export function readAuditEntries({ workspace, limit = 50 } = {}) {
  const root = String(workspace ?? '')
  if (!root) return []
  const file = join(root, AUDIT_REL)
  if (!existsSync(file)) return []
  let lines = []
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
  const out = []
  for (const line of lines.slice(-Math.max(1, Number(limit) || 50) * 4)) {
    try {
      out.push(JSON.parse(line))
    } catch {
      /* 跳过坏行 */
    }
  }
  return out.slice(-Math.max(1, Number(limit) || 50)).reverse()
}

/** 给体检/日志用的一行摘要（不含原文，所以可以直接打给人看）。 */
export function formatAuditRow(r) {
  const when = String(r?.at ?? '').replace('T', ' ').slice(0, 19)
  const who = r?.senderId ? ` · ${r.senderId}` : ''
  const src = { keyword: '关键词直写', marker: '模型提议' }[r?.source] ?? (r?.source ?? '?')
  const outcome =
    { applied: '已写入', deduped: '已存在（去重）', ignored: '被拒' }[r?.outcome] ?? (r?.outcome ?? '?')
  const why = r?.why ? ` —— ${r.why}` : ''
  const chars = Number.isFinite(r?.chars) ? `${r.chars} 字` : ''
  return `${when}  ${src}·${r?.scope ?? '?'}  ${outcome}  ${chars}${who}${why}`
}
