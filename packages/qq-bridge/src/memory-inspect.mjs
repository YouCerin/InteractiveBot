/**
 * 记忆体检：**看真实工作区里到底记了什么、下一轮会注入什么**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（"它说记住了"和"它真的记住了"是两件事）
 * ══════════════════════════════════════════════════════════════════════════
 * 离线测试（`verify-memory-roundtrip.mjs`）证明的是**机制**通不通：
 * 给定一条提议，桥接会不会正确剥离、落盘、出回执、下一轮注入。
 *
 * 但"**这个机器人此刻到底记着什么**"是运行时状态，测试答不了。而这件事
 * 恰恰是使用者最想确认的 —— 因为最常见的失败长这样：
 *   · 机器人嘴上说"好的记住了"，实际什么都没写（它只是没提议）
 *   · 条目被内容级规则挡了，但使用者没看到回执，以为记上了
 *   · 写进去了，可下一轮没注入（或注入到了别的会话），于是"记了等于没记"
 *   · 模型/人绕过桥接改了文件，下一次读之前被回滚
 *
 * 所以这个工具做的是：**把工作区里的真实状态摊开给人看**，
 * 并且**如实标注每一段的来源**（哪个文件、几条、什么时候写的）。
 *
 * ── 三条硬规矩 ─────────────────────────────────────────────────────────
 *   ① **只读**。绝不写、绝不删、绝不消费回执（那是桥接下一轮要做的事）。
 *      它可以在机器人正在跑的时候安全执行。
 *   ② **不猜**。文件不在就写"无"；注入内容按 `readMemoryForPrompt` 的真实
 *      逻辑算，不另写一套估算（两份逻辑必然会分叉）。
 *   ③ **说清边界**。它只回答"记了什么、会不会被注入"；
 *      "模型会不会**用**它"只能从真实对话里看（文档里给了做法）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { readMemoryForPrompt, listMemoryFiles, snapshotNameOf } from './memory-store.mjs'

/** 递归列出目录下的文件（相对路径），用于快照目录、回执目录。 */
function listFilesRel(root, sub) {
  const dir = join(String(root ?? ''), sub)
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => `${sub}/${e.name}`)
      .sort()
  } catch {
    return []
  }
}

/** 数一个记忆文件里有几条条目（`- ` 开头的行；兼容模型自己写的旧格式）。 */
function countEntries(root, rel) {
  const p = join(String(root ?? ''), rel)
  try {
    if (!existsSync(p)) return null
    const entries = readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
    return {
      entries: entries.length,
      bytes: statSync(p).size,
      mtime: statSync(p).mtime,
      last: entries.slice(-1)[0]?.slice(2) ?? '',
    }
  } catch {
    return null
  }
}

/**
 * 检查"真实文件"与"桥接快照"是否一致 —— 这就是 `verifyAndRestoreMemory`
 * 用的判据。**本函数只报告，不回滚**（回滚是桥接启动/读记忆时的行为）。
 *
 * ⚠️ 快照路径必须走 `snapshotNameOf`（`memory-store.mjs` 里的唯一口径）。
 *    这里原来自己拼 `rel.replace(/^memory\//, 'memory__')` —— 对根目录的
 *    `MEMORY.md` 恰好也对（它不含 `memory/` 前缀），但那是**巧合**；
 *    一旦文件布局变化就会与 `saveSnapshot` 分叉，表现成"体检说一致、实际不一致"。
 *
 * @returns {{rel: string, same: boolean|null, why?: string}[]}
 */
export function checkSnapshots(workspace) {
  const root = String(workspace ?? '')
  const out = []
  for (const rel of listMemoryFiles(root)) {
    const actual = join(root, rel)
    const snap = join(root, 'memory', '.snapshots', snapshotNameOf(rel))
    if (!existsSync(snap)) {
      out.push({ rel, same: null, why: '还没有快照（这条是桥接之前写入的，或从未经桥接写过）' })
      continue
    }
    try {
      const a = readFileSync(actual, 'utf8')
      const b = readFileSync(snap, 'utf8')
      out.push({ rel, same: a === b })
    } catch (error) {
      out.push({ rel, same: null, why: error?.message ?? String(error) })
    }
  }
  return out
}

/**
 * 摊开一个工作区的记忆状态。**不写盘**。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {{kind: 'private'|'group', peerId: string, label?: string}[]} [opts.conversations]
 *        要预览注入的会话（通常是配置里的白名单 + 群列表）。不传就只列文件。
 */
export function inspectMemory({ workspace, conversations = [] } = {}) {
  const root = String(workspace ?? '')
  const files = listMemoryFiles(root).map((rel) => ({ rel, ...(countEntries(root, rel) ?? {}) }))
  const receipts = listFilesRel(root, 'memory/.receipts').map((rel) => {
    let text = ''
    try {
      // ★ 只读**不消费**：消费是桥接下一轮的事，这里动了会让回执丢掉。
      text = readFileSync(join(root, rel), 'utf8').trim()
    } catch {
      /* 读不到就当空 */
    }
    return { rel, text }
  })
  const snapshots = checkSnapshots(root)
  const injections = conversations.map(({ kind, peerId, label }) => {
    let r = { text: '', files: [], blocks: [] }
    try {
      // 与桥接**同一份逻辑**算注入内容（不另写一套估算）——
      // `blocks` 是 `readMemoryForPrompt` 直接给的结构化副本，不是这里解析文本得来的。
      const got = readMemoryForPrompt({ workspace: root, kind, peerId })
      r = { text: got.text ?? '', files: got.files ?? [], blocks: got.blocks ?? [] }
    } catch {
      /* 计算失败就当空，下面会显示"无" */
    }
    return { kind, peerId, label, ...r }
  })
  return { workspace: root, files, receipts, snapshots, injections }
}

/** 把体检结果排版成人看的样子。
 *
 * @param {object} report `inspectMemory()` 的返回值
 * @param {{full?: boolean}} [opts] `full:true` 时把注入内容整段打出来；
 *        默认只给**分档摘要**（见下"为什么默认不打全"）
 */
export function formatMemoryReport(report, { full = false } = {}) {
  const lines = []
  lines.push(`记忆体检（只读，不会改动任何文件）`)
  lines.push(`工作区：${report.workspace}`)
  lines.push('')

  lines.push('── ① 记忆文件（这是"真的记下来的东西"）──')
  if (report.files.length === 0) {
    lines.push('   （一个都没有）')
    lines.push('   ⚠️ 这说明从没有条目成功落盘过。可能原因：没人提过议、')
    lines.push('      或提议都被内容级规则挡了（见下面 ③ 的回执）。')
  }
  for (const f of report.files) {
    lines.push(`   ${f.rel}   ${f.entries} 条  ${f.bytes} 字节  最后写入 ${f.mtime?.toISOString?.() ?? '?'}`)
    if (f.last) lines.push(`      最后一条：${f.last}`)
  }

  // ★ 写了却**不会被注入**的记忆文件 —— 这是"记了等于没记"的静默失败。
  //   实测就有：`memory/self-unknowns.md` 有 14 条，但它不在注入清单里，
  //   所以下一轮模型根本读不到它。使用者会以为"它知道"，其实它不知道。
  //   这里必须主动报出来，而不是等人去比对文件名和注入清单。
  const injectedFiles = new Set(report.injections.flatMap((i) => i.files ?? []))
  const neverInjected = report.files.filter((f) => !injectedFiles.has(f.rel))
  if (neverInjected.length > 0 && report.injections.length > 0) {
    lines.push('')
    lines.push('   ⚠️ **存在但不会被注入**的记忆文件（模型下一轮读不到它）：')
    for (const f of neverInjected) {
      lines.push(`      ${f.rel}（${f.entries} 条）`)
    }
    lines.push('      注入清单只有：MEMORY.md、memory/private-<QQ>.md、memory/group-<群号>.md、')
    lines.push('                    memory/group-<群号>-slang.md、memory/directives.md、memory/facts-global.md')
    lines.push('      要让别的文件生效，得把它并进上面某一档（或改代码的注入清单）。')
  }

  lines.push('')
  lines.push('── ② 下一轮会注入什么（按会话）──')
  if (report.injections.length === 0) {
    lines.push('   （没指定会话）加 --inject 可指定，例如：')
    lines.push('     --inject private:100000001 --inject group:700000001')
  }
  for (const inj of report.injections) {
    const head = `${inj.kind}:${inj.peerId}${inj.label ? `（${inj.label}）` : ''}`
    if (!inj.text.trim()) {
      lines.push(`   ${head} →   无（这个会话下一轮读不到任何记忆）`)
      continue
    }
    lines.push(`   ${head} →   ${inj.text.length} 字节 · ${inj.blocks?.length ?? 0} 档`)
    // 为什么默认**不打全文**：全局记忆动辄 1.5k 字节且每个会话都一样，
    // 整段铺出来会把"到底记了什么"淹掉。默认给每档的条数与头一条预览，
    // 要全文再加 --full。
    for (const b of inj.blocks ?? []) {
      const preview = String(b.text ?? '').slice(0, 80).replace(/\s+/g, ' ')
      // ⚠️ 措辞要说准：`entries` 是这个文件里总共几条，`shown` 是**真的注入了**几条。
      //    第一版写成「N 条（已截断注入，最多 N 条）」，看着像"被截断"，
      //    其实 16 条全注入了 —— 那种自相矛盾的提示比没有提示更误导。
      const note = b.more > 0 ? `，注入了前 ${b.shown} 条（另有 ${b.more} 条未展开）` : ''
      lines.push(`      〔${b.label}〕共 ${b.entries} 条${note}`)
      if (full) {
        for (const l of String(b.text ?? '').split(' ')) if (l.trim()) lines.push(`         ${l}`)
      } else if (preview) {
        lines.push(`         ${preview}${String(b.text ?? '').length > 80 ? '…' : ''}`)
      }
    }
  }

  lines.push('')
  lines.push('── ③ 待消费的回执（桥接下一轮会读掉并删掉）──')
  if (report.receipts.length === 0) {
    lines.push('   （无。说明上一轮没有提议，或回执已经被消费掉了）')
  }
  for (const r of report.receipts) {
    lines.push(`   ${r.rel}`)
    for (const l of r.text.split('\n')) if (l.trim()) lines.push(`      ${l}`)
  }
  lines.push('   ⚠️ 看到「没记下」就是在说：**那条被拒了**，机器人若说"记住了"就是在骗人。')

  lines.push('')
  lines.push('── ④ 快照一致性（检测绕过桥接的改动）──')
  if (report.snapshots.length === 0) {
    lines.push('   （没有记忆文件）')
  }
  for (const s of report.snapshots) {
    if (s.same === true) lines.push(`   ✅ ${s.rel} 与快照一致`)
    else if (s.same === false) {
      lines.push(`   ⚠️ ${s.rel} 与快照**不一致** —— 有人/模型绕过桥接改了它，`)
      lines.push('      桥接下次读记忆时会**回滚**到快照')
    } else lines.push(`   · ${s.rel} 无法比对：${s.why}`)
  }

  lines.push('')
  lines.push('── 这个工具**不能**回答的 ──')
  lines.push('   它只说明"记了什么、会不会注入"。')
  lines.push('   "模型会不会主动提议、会不会用上"是模型行为，只能从真实对话里看：')
  lines.push('     · 说一件值得长期记住的事（偏好/约定/黑话），再问它一次')
  lines.push('     · 或者直接看机器人日志里有没有 `[memory] 记忆写入：` 这一行')
  lines.push('   （注入全文加 --full）')
  return lines.join('\n')
}
