/**
 * 读 SnowLuma 的终端输出（给界面上的"终端"面板用）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么读**日志文件**，而不是抓它的 stdout
 * ══════════════════════════════════════════════════════════════════════════
 * 这个选择是实测出来的，不是偏好。SnowLuma 自己把日志写成 UTF-8 的
 * `logs/snowluma-YYYY-MM-DD.log`，中文正常，而且**已经按天轮转**（我们不必自己管增长）：
 *
 *     00:25:52 OK [200000001] [Event] 私聊 [无忘远霞(100000001)]: 确认一下群聊开关打开了吗
 *
 * ── ⚠️ 一处被实测纠正的旧说法（2026-10-03，0.3.0alpha 实机报告 BUG-3）────
 * 这里原来断言"由我们接管 stdout 并重定向到文件，同样的内容会变成 GBK 编码的乱码"
 * （当时给的例子是 `绉佽亰 [鏃犲繕杩滈湠…`）。那条结论是**用 pipe 测出来的**，
 * 不能推广到文件句柄：
 * 报告用 `Start-Process -RedirectStandardOutput`（文件句柄）捕获，内容是干净的 UTF-8；
 * 本机也用 Node 子进程复测过（`stdio: ['ignore', fd, fd]`，中文与
 * `initial credentials:` 行同时写 stdout/stderr）—— **179 字节，UTF-8 完全正确**，
 * 没有替换字符，中文逐字对得上。
 * 推测差别在"写控制台受代码页影响"与"写文件/管道走 UTF-8"之间。
 *
 * ★ 所以现在的分工是：**这个文件仍然只读 SnowLuma 自己的日志**（界面要的是它那种
 *   `HH:MM:SS LEVEL [UIN] 内容` 的结构化行），而它的**启动输出**另外落到
 *   `logs/snowluma-console.log`（首次登录的引导密码只在那里，见 `snowluma-console.mjs`）。
 *   两者不是重复：一个给人看消息流水，一个保住只在启动时出现过一次的东西。
 *
 * ── 增量轮询 ────────────────────────────────────────────────────────────
 * 界面要的是"像终端一样滚动"，每 2 秒重读整个文件是浪费（文件可能很大）。
 * 所以支持 `offset`：客户端回传上次拿到的字节位置，我们只从那里读新增部分。
 * 文件被轮转（换日期）或变小（被截断）时，offset 失效 → 从头返回并告知，
 * **不能假装没发生**，否则界面会缺一段日志而毫无察觉。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 日志行形状：`HH:MM:SS LEVEL [UIN] [模块] 内容` */
const LINE_RE = /^(\d{2}:\d{2}:\d{2})\s+(\w+)\s+(.*)$/

/**
 * 找出当前该读哪个日志文件。
 *
 * SnowLuma 按 `snowluma-YYYY-MM-DD.log` 命名。取**文件名里日期最大**的那个，
 * 而不是"修改时间最新"的 —— 跨天时旧文件可能因为正在收尾而被写一次，
 * 用 mtime 排序会瞬间指错文件。日期在文件名里，就按日期排。
 *
 * @returns {{file: string|null, date: string|null, dir: string|null}}
 */
export function findLatestSnowlumaLog(installDir) {
  if (!installDir) return { file: null, date: null, dir: null }
  const dir = join(installDir, 'logs')
  if (!existsSync(dir)) return { file: null, date: null, dir: null }

  let names
  try {
    names = readdirSync(dir)
  } catch {
    return { file: null, date: null, dir }
  }
  const dated = names
    .map((name) => ({ name, date: /^snowluma-(\d{4}-\d{2}-\d{2})\.log$/.exec(name)?.[1] ?? null }))
    .filter((x) => x.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1)) // 日期大的在前

  if (!dated.length) return { file: null, date: null, dir }
  return { file: join(dir, dated[0].name), date: dated[0].date, dir }
}

/**
 * 解析一行日志。
 *
 * 解析不出来也**不丢** —— 原样放在 `raw` 里返回。
 * 理由：这是"给人看的终端"，任何一行都可能是有用的信息；
 * 因为我们没看懂格式就把它藏起来，比显示一行未解析的原文糟糕得多。
 */
export function parseLogLine(raw) {
  const m = LINE_RE.exec(raw)
  if (!m) return { time: null, level: null, rest: null, text: raw, raw }
  return {
    time: m[1],
    level: m[2].toUpperCase(),
    rest: m[3],
    text: raw,
    raw,
  }
}

/**
 * SnowLuma 日志的读取器。
 *
 * @param {object} opts
 * @param {string} opts.installDir SnowLuma 安装目录
 * @param {number} [opts.maxBytes] 单次最多读多少字节（防止一次把巨型文件读进内存）
 */
export function createSnowlumaLogReader({ installDir, maxBytes = 256 * 1024 } = {}) {
  /**
   * @param {object} [opts]
   * @param {number} [opts.offset] 上次读到的字节位置（增量轮询）
   * @param {number} [opts.lines]  只回最近 N 行（首次加载用；给了它就不看 offset）
   * @param {boolean} [opts.includeDebug] 是否包含 DEBUG 行（默认包含）
   */
  function read({ offset = 0, lines = 0, includeDebug = true } = {}) {
    const { file, date, dir } = findLatestSnowlumaLog(installDir)
    if (!file) {
      return {
        ok: true,
        data: {
          available: false,
          file: null,
          dir,
          lines: [],
          offset: 0,
          truncated: false,
          droppedDebug: 0,
          note: '还没有 SnowLuma 日志。它没运行过，或者日志目录不在预期位置。',
        },
      }
    }

    let stat
    try {
      stat = statSync(file)
    } catch (error) {
      return { ok: false, error: `读日志文件失败：${error.message}` }
    }
    const size = stat.size

    // ── 决定从哪读 ──────────────────────────────────────────────────────
    let start = 0
    let rotated = false
    let tailMode = false

    if (lines > 0) {
      // 首次加载：只要最后 N 行。从尾部回读一块就够，不必整个文件读进来。
      tailMode = true
      start = Math.max(0, size - maxBytes)
    } else if (offset > 0 && offset <= size) {
      start = offset
    } else if (offset > 0) {
      // ★ offset 超出文件大小 = 文件被轮转或截断了。
      //   必须**如实告知**，否则界面会以为"没有新日志"，而其实是换文件了。
      rotated = true
      start = 0
    }

    let text
    try {
      // 日志是 UTF-8（这是选它而不是 stdout 的原因之一）
      const buf = readFileSync(file)
      let slice = buf.subarray(start)
      if (slice.length > maxBytes) slice = slice.subarray(slice.length - maxBytes)
      text = slice.toString('utf8')
    } catch (error) {
      return { ok: false, error: `读日志文件失败：${error.message}` }
    }

    // 从中间开始时，第一行可能是半截（切在字符中间也是）—— 丢掉它。
    // 表现是"某行看着像从中间开始的"，比显示一行断裂的乱码好。
    let body = text
    if (start > 0 && !tailMode) {
      const nl = body.indexOf('\n')
      body = nl >= 0 ? body.slice(nl + 1) : ''
    }

    let all = body.split('\n').filter((l) => l.trim())
    // 尾读时前面那半行也要丢掉
    if (tailMode && start > 0 && all.length) all = all.slice(1)

    const parsed = all.map(parseLogLine)
    const kept = includeDebug ? parsed : parsed.filter((l) => l.level !== 'DEBUG')
    const droppedDebug = parsed.length - kept.length
    const out = lines > 0 ? kept.slice(-lines) : kept

    return {
      ok: true,
      data: {
        available: true,
        file,
        date,
        dir,
        lines: out,
        // 下次从哪继续（按**文件真实大小**算，而不是我们解析后的行数）
        offset: size,
        rotated,
        truncated: start + text.length < size,
        droppedDebug,
        totalBytes: size,
      },
    }
  }

  return { read, locate: () => findLatestSnowlumaLog(installDir) }
}
