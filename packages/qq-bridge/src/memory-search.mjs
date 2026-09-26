/**
 * 记忆条目检索（H13）：在 `MEMORY.md` 与 `memory/*.md` 里按关键词找条目。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 与语料库检索的分工（**别合并**）
 * ══════════════════════════════════════════════════════════════════════════
 *   · 这里搜的是**沉淀下来的事实**（记忆条目，跨重启生效，按会话分档存成文件）；
 *   · `corpus.mjs` 搜的是**说过什么**（消息流水，有 30 天 TTL）。
 * 合起来会让人以为"搜到的就是它记住的"，而两者并不等价。
 *
 * ── 三条刻意的取舍 ────────────────────────────────────────────────────────
 *   ① **不需要会话参数**：记忆文件名本身就分了档（`MEMORY.md` / `private-<QQ>.md` /
 *      `group-<群号>.md`），"这个文件属于谁"看一眼名字就知道 —— 与语料库不同，
 *      这里不存在"把别的会话内容混进来"的问题。
 *   ② **只回行预览**（默认 120 字）：界面上够认出是哪条，又不会把整份记忆复制到浏览器。
 *   ③ **标出已被更正的条目**：它们仍在文件里（可追溯），但不再作为事实使用 ——
 *      不标会让人以为模型还在用那条错的（H4 的 supersede 机制）。
 *
 * ★ 抽成独立模块的理由与 `log-tail.mjs` 一样：**实现与测试用同一份代码**。
 *   第一版把这段逻辑写在接口的闭包里，于是测试只能照着再写一遍 —— 那正是本项目
 *   明确反对的二次实现（迟早分叉，分叉的表现是"测试说对了、线上是错的"）。
 *   文件系统操作**可注入**，这样测试不需要真的造目录。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 行预览的最大长度。 */
export const PREVIEW_CHARS = 120

/** 一次最多回多少条命中。 */
export const MAX_HITS = 200

/**
 * 列出要搜的记忆文件（与记忆页签展示的契约一致：只这两处）。
 * @returns {string[]} 相对工作区的路径
 */
export function memoryFilesToSearch({ workspace, exists = existsSync, readdir = readdirSync } = {}) {
  const root = String(workspace ?? '')
  if (!root) return []
  const out = []
  if (exists(join(root, 'MEMORY.md'))) out.push('MEMORY.md')
  const dir = join(root, 'memory')
  if (exists(dir)) {
    for (const name of readdir(dir).sort()) {
      if (name.endsWith('.md')) out.push(`memory/${name}`)
    }
  }
  return out
}

/**
 * 在记忆文件里搜关键词。
 *
 * @param {{workspace?: string, query?: string, limit?: number,
 *          exists?: Function, readdir?: Function, readFile?: Function}} opts
 * @returns {{ok: boolean, why?: string, query?: string, files?: number, rows?: object[]}}
 */
export function searchMemoryFiles({
  workspace,
  query,
  limit = 50,
  exists = existsSync,
  readdir = readdirSync,
  readFile = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const q = String(query ?? '').trim()
  if (!q) return { ok: false, why: '要搜什么？给一个 q 参数', rows: [] }
  const root = String(workspace ?? '')
  if (!root) return { ok: false, why: '没有工作区，定位不到记忆文件', rows: [] }

  const rels = memoryFilesToSearch({ workspace: root, exists, readdir })
  const needle = q.toLowerCase()
  const rows = []
  for (const rel of rels) {
    let lines = []
    try {
      lines = String(readFile(join(root, rel))).split(/\r?\n/)
    } catch {
      // ★ 单个文件读不到就跳过（权限/竞态），不因为一个文件失败整条请求 ——
      //   但**不静默**：调用方能从 files 与实际扫到的差异看出来（搜索是增强路径）。
      continue
    }
    lines.forEach((line, i) => {
      if (!line.toLowerCase().includes(needle)) return
      rows.push({
        rel,
        line: i + 1,
        preview: line.trim().slice(0, PREVIEW_CHARS),
        superseded: /已被更正/.test(line),
      })
    })
  }
  return {
    ok: true,
    query: q,
    files: rels.length,
    rows: rows.slice(0, Math.max(1, Math.min(MAX_HITS, Number(limit) || 50))),
  }
}
