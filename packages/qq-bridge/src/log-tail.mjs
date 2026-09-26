/**
 * 日志增量切片（H13）：给"日志流"接口用的**纯函数**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么单独抽出来
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版把这段逻辑直接写在 `index.mjs` 的接口实现里，于是**测试里只能照着再写一遍**
 * —— 而"测试里二次实现一遍"正是本项目明确反对的做法（解析/渲染的二次实现迟早分叉，
 * 分叉的表现是"测试说对了、线上是错的"）。抽成纯函数之后，实现与测试用同一份代码。
 *
 * ── 游标语义（写清楚，免得以后有人"优化"掉）──────────────────────────────
 *   · 游标 = **已经给过的行数**（不是字节偏移）。对"只追加"的日志足够，且简单。
 *   · **游标超出总行数时回到 0**：日志文件被截断/轮转（行数变少）时，
 *     老游标会永远大于行数 —— 不夹回开头就会**永远收不到新日志**，
 *     而界面上只会显示"没有新日志"，看不出是游标的问题。
 *   · 单次最多给 1000 行（防止一次把界面刷爆）。
 */
export function sliceLogLines({ lines = [], since = 0, limit = 200, max = 1000 } = {}) {
  const all = Array.isArray(lines) ? lines : []
  const start = Number(since) > all.length ? 0 : Math.max(0, Number(since) || 0)
  const take = Math.max(1, Math.min(max, Number(limit) || 200))
  const slice = all.slice(start, start + take)
  const cursor = start + slice.length
  return { lines: slice, cursor, total: all.length, eof: cursor >= all.length, reset: start === 0 && Number(since) > all.length }
}

/** 把日志原文切成行（去掉空行；CRLF 也认）。 */
export function splitLogText(raw) {
  return String(raw ?? '').split(/\r?\n/).filter(Boolean)
}
