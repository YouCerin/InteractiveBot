/**
 * 记忆写入计数 + "零写入告警"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（这是 0.2.0 最大的工程缺口）
 * ══════════════════════════════════════════════════════════════════════════
 * 实测事故（详见 `docs/0.2.1-memory-diagnosis.md`）：
 * 机器人聊了两天、几十轮，**一条记忆都没写** —— 而**没有任何地方报过警**。
 * 发现它靠的是人工去解 DSH 的会话落盘记录，逐层比对提示词与模型思考。
 *
 * 这就是"缺可观测性"的代价：**静默失败**。而本项目的第一条约束
 * （`AGENT.md` 第 6 条）写的就是"**失败必须让用户知道**"。
 *
 * 所以这里补四个计数 + 一个告警：
 *
 *   proposed   模型/抽取层**提出了多少条**（= 解析出来的条数）
 *   applied    真正落盘了多少条
 *   ignored    被规则拒了多少条（在 `applyMemoryItems` 里有逐条原因）
 *   deduped    因为已存在而被去重了多少条（不是失败，但要看得出）
 *
 * 判据用**同一个分母**：`turns`（这个会话经过了多少轮）。
 * 轮数够了却 `applied === 0` → **零写入告警**。
 *
 * ── 三条设计纪律 ─────────────────────────────────────────────────────────
 *   ① **计数绝不阻断主流程**：任何异常都吞掉，只留计数缺失，绝不让写记忆失败。
 *   ② **只记数字，不记内容**：统计文件里没有记忆原文，也没有隐私面。
 *   ③ **按会话分开**：告警必须能指出"是哪个会话没写"，否则等于没告警。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** 统计文件（放 memory/ 下，与记忆同域，便于一起备份/清理）。 */
const STATS_REL = 'memory/.stats.json'

/**
 * 出厂默认阈值。
 *
 * 为什么是 10 轮：实测一个正常会话头 10 轮里至少会有一次"值得记的事"
 * （用户说偏好、约定、纠正）。10 轮零写入基本可以断定是链路问题而非"恰好没事可记"。
 */
export const STATS_DEFAULTS = {
  /** 某会话累计多少轮仍 0 次落盘 → 告警 */
  zeroWriteAfterTurns: 10,
}

function statsPath(workspace) {
  return join(String(workspace ?? ''), STATS_REL)
}

function emptyStats() {
  return { version: 1, chats: {} }
}

function readStats(workspace) {
  try {
    const p = statsPath(workspace)
    if (!existsSync(p)) return emptyStats()
    let text = readFileSync(p, 'utf8')
    // Windows 记事本 / PowerShell Out-File 会写 BOM，JSON.parse 直接抛
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.chats !== 'object') return emptyStats()
    return { version: 1, chats: parsed.chats ?? {} }
  } catch {
    // 读不出来就当空的 —— 统计是观测手段，绝不能因为它坏了而影响记忆
    return emptyStats()
  }
}

/** 原子写（tmp + rename），避免半截文件。 */
function writeStats(workspace, stats) {
  try {
    const p = statsPath(workspace)
    mkdirSync(join(p, '..'), { recursive: true })
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(stats, null, 1)}\n`, 'utf8')
    renameSync(tmp, p)
    return true
  } catch {
    return false
  }
}

/** 一个会话的计数骨架。 */
function emptyChat(chatKey) {
  return {
    chatKey: String(chatKey ?? ''),
    turns: 0,
    proposed: 0,
    applied: 0,
    ignored: 0,
    deduped: 0,
    lastWriteAt: 0,
    lastProposeAt: 0,
    firstSeenAt: Date.now(),
  }
}

/**
 * 记一轮"这个会话跑过一次"。**每轮都应调用**（无论有没有记忆提议）。
 *
 * ⚠️ 这个函数是告警的分母来源。如果只在"有提议时"记轮数，
 *    那"从没提议过"的会话永远不会积累轮数，也就永远不会告警 ——
 *    正好把最该告警的情况漏掉。所以它必须**无条件**被调。
 */
export function noteTurn({ workspace, chatKey }) {
  try {
    const stats = readStats(workspace)
    const key = String(chatKey ?? '')
    if (!key) return null
    const cur = stats.chats[key] ?? emptyChat(key)
    cur.turns += 1
    stats.chats[key] = cur
    writeStats(workspace, stats)
    return cur
  } catch {
    return null
  }
}

/**
 * 记一次"记忆提议的处理结果"。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} opts.chatKey
 * @param {number} opts.proposed  解析出来的条数
 * @param {number} opts.applied   落盘成功条数
 * @param {number} opts.ignored   被拒条数
 * @param {number} [opts.deduped] 去重条数
 */
export function noteMemoryAttempt({ workspace, chatKey, proposed = 0, applied = 0, ignored = 0, deduped = 0 }) {
  try {
    const stats = readStats(workspace)
    const key = String(chatKey ?? '')
    if (!key) return null
    const now = Date.now()
    const cur = stats.chats[key] ?? emptyChat(key)
    cur.proposed += Number(proposed) || 0
    cur.applied += Number(applied) || 0
    cur.ignored += Number(ignored) || 0
    cur.deduped += Number(deduped) || 0
    if (cur.proposed > 0) cur.lastProposeAt = now
    if (Number(applied) > 0) cur.lastWriteAt = now
    stats.chats[key] = cur
    writeStats(workspace, stats)
    return cur
  } catch {
    return null
  }
}

/**
 * 某个会话是否该报"零写入告警"。
 *
 * 判据（三条必须同时成立，避免误报）：
 *   ① `turns >= zeroWriteAfterTurns`
 *   ② `applied === 0`（从来没落盘过任何一条）
 *   ③ `lastWriteAt === 0`
 *
 * @returns {{alert: boolean, why: string, turns: number}}
 */
export function zeroWriteAlert({ workspace, chatKey, threshold } = {}) {
  const need = Math.max(1, Number(threshold) || STATS_DEFAULTS.zeroWriteAfterTurns)
  try {
    const stats = readStats(workspace)
    const cur = stats.chats?.[String(chatKey ?? '')]
    if (!cur) return { alert: false, why: '这个会话还没有轮数记录', turns: 0 }
    const turns = Number(cur.turns) || 0
    if (turns < need) return { alert: false, why: `只跑了 ${turns} 轮（要满 ${need} 轮才判定）`, turns }
    if (Number(cur.applied) > 0) {
      return { alert: false, why: `已落盘 ${cur.applied} 条`, turns }
    }
    return {
      alert: true,
      why: `跑了 ${turns} 轮，提出 ${cur.proposed} 条，**一条都没落盘**`,
      turns,
    }
  } catch {
    return { alert: false, why: '统计读取失败', turns: 0 }
  }
}

/** 全部会话的计数（体检/控制台用）。按最后活动时间倒序。 */
export function readAllStats(workspace) {
  const stats = readStats(workspace)
  const rows = Object.values(stats.chats ?? {}).map((c) => {
    const alert = zeroWriteAlert({ workspace, chatKey: c.chatKey })
    return { ...c, alert: alert.alert, alertWhy: alert.why }
  })
  rows.sort((a, b) => Math.max(b.lastWriteAt, b.lastProposeAt) - Math.max(a.lastWriteAt, a.lastProposeAt))
  return rows
}

/** 清空统计（管理员手段；`--memory stats --reset`）。 */
export function resetStats(workspace) {
  return writeStats(workspace, emptyStats())
}
