/**
 * 投递回执（0.3.3 · S3）：**「说了但没发出去」要让模型知道**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它修的是什么（E3）
 * ══════════════════════════════════════════════════════════════════════════
 * 投递循环里原来是这样：
 *
 *     if (!verdict.ok) { log(`跳过发送：${verdict.reason}`); continue }
 *
 * 于是被限频/去重丢掉的段落**只进日志**。模型完全不知道有一句话没发出去，
 * 下一轮它照旧按"我说过了"往下聊 —— 而使用者那边是**断的**。
 * 这正是本项目一直在防的那类失败：**它以为自己说了，其实没发出去**。
 *
 * ── 为什么是一张表，而不是"什么失败都回执"────────────────────────────────
 * 回执会占 token，而且**措辞不当会让模型反复道歉**（比不回执更烦）。
 * 有些失败根本不可自救（终检门拦下来的内部泄漏、空段），把它们告诉模型
 * 只会让模型对着一个它无法改变的事实道歉。所以判据是
 * **「模型能不能据此改写或重发」**，写死在下面这张表里。
 *
 * ── 本模块是**纯函数**────────────────────────────────────────────────────
 * 不读盘、不看时钟、不碰网络：输入输出都可直接断言（S3.1 的单测就靠它）。
 * 限次与去重（S3.4）在 `bridge.mjs` 那一侧，因为那需要跨轮记忆。
 */

/** 回执在提示词里的显式前缀 —— 让终检门/人一眼认得出"这不是正文"。 */
export const RECEIPT_PREFIX = '[投递回执]'

/**
 * 「这条丢弃**该不该**回执给模型」——判据表（S3.2 的规格，逐条对应表单）。
 *
 * | 原因 | 回执 | 为什么 |
 * |---|---|---|
 * | 每分钟/每小时上限 | ✅ | 模型能改写或稍后再说 |
 * | 内容去重命中 | ✅ | 模型能换说法 |
 * | 发送异常（协议端报错） | ✅ | 模型能决定是否重试 |
 * | 终检门 dropped（内部泄漏） | ❌ | 回执等于把内部信息再递一遍 |
 * | 空段 / 白名单外 | ❌ | 不是可自救的失败 |
 */
export function shouldReceipt(drop = {}) {
  const reason = String(drop?.reason ?? '')
  const kind = String(drop?.kind ?? '')
  if (!reason.trim()) return false
  // ① **不**可自救的那几类：终检门/空段/白名单/越权
  //    ⚠️ 先判"不"，再判"是" —— 顺序写反的话，
  //    一个既含"上限"又含"泄漏"的复合原因会被误回执。
  if (/内部泄漏|泄漏|终检门|gate|空段|为空|白名单|不在名单|不允许|没有权限|越权|拒收/i.test(reason)) {
    return false
  }
  if (/^(system|gate|none|whitelist)$/i.test(kind)) return false // 占位：未来 kind 分型
  // ② 可自救的三类
  if (/上限|已达|限频|rate/i.test(reason)) return true
  if (/内容重复|重复|duplicate|dedupe/i.test(reason)) return true
  if (/发送失败|超时|timeout|发送异常|协议端|HTTP|ECONN|reset/i.test(reason)) return true
  // ③ 认不出的原因：**不回执**。
  //    ★ 方向很重要：回执是"新增的对外行为"，认不出时宁可不做 ——
  //      但**必须留下日志**（调用方 `collect()` 会把 unrecognized 计数带出去）。
  return false
}

/** 回执措辞里那半句"原因摘要"：把技术原因翻成一句人话（不贴系统报错原文）。 */
export function summarizeReason(reason) {
  const r = String(reason ?? '')
  if (/每分钟上限|maxPerMinute/i.test(r)) return '发得太密，被每分钟上限拦下了'
  if (/每小时上限|maxPerHour/i.test(r)) return '发得太密，被每小时上限拦下了'
  if (/内容重复|重复|duplicate|dedupe/i.test(r)) return '和刚发过的那句重复，被去重拦下了'
  if (/超时|timeout/i.test(r)) return '发送超时，没送到'
  if (/发送失败|协议端|HTTP|ECONN|reset/i.test(r)) return '协议端那边发送失败'
  return '没能发出去'
}

/**
 * 把这一轮的丢弃**收成一段回执**（纯函数）。
 *
 * @param {Array<{index?:number, text?:string, reason?:string, kind?:string}>} dropped
 * @param {{maxItems?:number, maxCharsPerItem?:number}} [opts]
 * @returns {{ok:boolean, text:string, items:Array<{preview:string, why:string}>, unrecognized:string[]}}
 *   `ok:false` = 这一轮**不必回执**（没有可自救的丢弃，或全都不该说）
 */
export function collect(dropped = [], { maxItems = 3, maxCharsPerItem = 40 } = {}) {
  const list = Array.isArray(dropped) ? dropped : []
  const picked = []
  const unrecognized = []
  for (const d of list) {
    const reason = String(d?.reason ?? '').trim()
    if (!reason) continue
    if (!shouldReceipt(d)) {
      // 认不出的原因单独带出去（调用方可以据此留日志）—— 但不进回执
      if (!/内部泄漏|泄漏|终检门|gate|空段|为空|白名单|不在名单|不允许|没有权限|越权|拒收/i.test(reason)) {
        unrecognized.push(reason)
      }
      continue
    }
    const raw = String(d?.text ?? '').trim()
    if (!raw) continue // 空文本没有"改写"的抓手
    const preview = raw.length > maxCharsPerItem ? `${raw.slice(0, maxCharsPerItem)}…` : raw
    picked.push({ preview, why: summarizeReason(reason) })
    if (picked.length >= Math.max(1, maxItems)) break
  }
  if (picked.length === 0) return { ok: false, text: '', items: [], unrecognized }

  const lines = [
    `${RECEIPT_PREFIX} 上一轮有 ${picked.length} 段**没能发出去**（对方没看到它们）：`,
    ...picked.map((p, i) => `· 第 ${i + 1} 段「${p.preview}」—— ${p.why}`),
    '',
    // ★ 措辞原则（表单 §S3 的风险项）：**给动作**，不报故障。
    //   说"你漏发了"会让模型下一轮先道歉一遍（那对使用者是噪音）；
    //   说"要接着说的，用一句新的话重新发"才是可执行的动作。
    '要接着说的，**用一句新的话重新发**（不要逐字重复上一轮、也不要提"回执/通道/上限"这些词）。',
  ]
  return { ok: true, text: lines.join('\n'), items: picked, unrecognized }
}

/**
 * 回执的去重键（S3.4）：**同一批原文**只回执一次。
 *
 * 为什么不拿回执文本当键：那里面带序号与预览截断，同一批内容两次算出来的
 * 文本可能不同（`第 1 段` vs `第 1 段` 其实一样，但顺序会变）。
 * 用"被丢弃原文的指纹"更稳：同一句话反复被去重丢弃 ⇒ 只回执一次。
 */
export function dedupeKey(dropped = []) {
  const parts = (Array.isArray(dropped) ? dropped : [])
    .filter((d) => shouldReceipt(d) && String(d?.text ?? '').trim())
    .map((d) => String(d.text).trim())
  if (parts.length === 0) return ''
  // 简单稳定的指纹（FNV-1a）：不引 crypto，纯函数里也不用 node 模块
  let h = 2166136261
  for (const ch of parts.join('\u0001')) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 16777619)
  }
  return `${parts.length}:${(h >>> 0).toString(16)}`
}
