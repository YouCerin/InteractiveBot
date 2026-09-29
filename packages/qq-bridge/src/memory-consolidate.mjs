/**
 * 记忆整理（规则版）：把"流水账"收敛成"可用的记忆"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（真实数据逼出来的）
 * ══════════════════════════════════════════════════════════════════════════
 * 0.2.0 只有"条数上限 60、到顶就拒"这一条硬规则，而"变长了自己合并"
 * 只是提示词里的一句**请求**。实测后果（`memory/private-100000001.md`）：
 *
 *   - 2026-09-26 他说希望机器人以后能有管理 MC 服务器的能力，我列了需要的能力清单（…）
 *   - 2026-09-26 他说他的 MC 服务器是 Forge 端（还没说版本），我提醒 Forge 与 Paper 的差别…
 *   - 据他说,他每天玩 DSH 大概花30块左右,按 token 计费
 *
 * 三类毛病叠在一起：
 *   ① **第一人称转述**（"他说…""我提醒…""我判断…"）—— 记的是对话过程，不是事实
 *   ② **中英标点混用**（`他说,他` 是半角逗号）
 *   ③ **冗余的日期前缀**（每人一份的档案里，"2026-09-26" 几乎总是噪音）
 *
 * ── 范围（**刻意不做的事**）─────────────────────────────────────────────
 * 这一版只做**确定性、可验证、不会改变语义**的整理：
 *   · 解析多行条目（这是前提，见下）
 *   · 标点归一
 *   · 去掉冗余的日期前缀
 *   · 合并高度相似的条目
 *
 * **不做**语义改写（"我提醒 X" → "X"）。理由是它**会改变语义**，
 * 而规则做不到可靠 —— 那属于 LLM 版整理（二期），且必须配反幻觉断言
 * （整理后条数变多 → 整轮放弃）与快照回滚，见 `docs/0.2.1-memory-prompt-plan.md` §2.9。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ 一个必须先修的解析问题：条目是**多行**的
 * ══════════════════════════════════════════════════════════════════════════
 * `memory-store.mjs` 的 `readEntryLines()` 只抓以 `- ` 开头的行，于是：
 *
 *   - 他正在给 InteractiveRobot 加的两个功能（2026-09-26 说的，还没做）：   ← 算 1 条
 *     1) 小概率从表情包库里挑一张最贴场景的发…                        ← 被丢掉
 *     2) 自主决定"先应一声"说什么…                                   ← 被丢掉
 *     我给的思路：表情包=离线一次性打标签…                            ← 被丢掉
 *
 * 一个逻辑条目被算成 1 条、另外 3 行成了"孤儿"。**合并/去重建立在这种解析上必然出错**，
 * 所以这里先按"缩进"把续行归回父条目（见 `parseEntries`）。
 *
 * 注意：**不要**据此去改 `readEntryLines` —— 它的"一行一条"口径是
 * `appendEntry` 做**去重比较**用的（比较"要写的那一行"与"已有的行"），
 * 改成多行会把去重和注入都弄坏。两个用途需要两个函数。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
// ★ 文本度量与"行内标注"从各自的模块来（见 `text-similarity.mjs` 文件头：
//   把纯文本度量抽出来是为了**拍平依赖** —— 否则"写入"要依赖"整理"，
//   而"整理"为了列文件又要依赖"写入"，形成循环依赖）。
import {
  LEADING_DATE_RE,
  LEADING_ATTRIBUTION_RE,
  normalizeForCompare,
  similarity,
} from './text-similarity.mjs'
import { isSuperseded, stripSupersedeNote } from './memory-supersede.mjs'

// ★ 再导出：这两个是"记忆比较"的公开口径，测试与调用方一直从这里取它们。
export { normalizeForCompare, similarity }

// ★ 这里**刻意不再 import `memory-store.mjs`**：`listMemoryFiles` 由调用方注入。
//   原因：memory-store 现在要用本模块（经由 text-similarity）的 `similarity`
//   在写入时判断"这条是不是在更正上面某条" —— 两边互相 import 就是循环依赖。
//   ESM 能容忍它，但那种容忍是"跑起来没事、改一行就炸"，本项目已经为
//   "看不见的接线错误"付过代价（`AGENT.md` 第 9 条）。

/** 中文标点归一：只在"明显是中文语境"时才换，避免误伤数字/URL/英文。 */
const PUNCT_RULES = [
  // 半角逗号 → 全角：两侧至少一侧是 CJK 时才换。
  // （`1,000`、`a,b`、JSON 里的逗号都不该被改）
  { re: /([\u4e00-\u9fa5])\s*,\s*/g, to: '$1，' },
  { re: /\s*,\s*([\u4e00-\u9fa5])/g, to: '，$1' },
  // 半角冒号 → 全角：同样只在 CJK 旁
  { re: /([\u4e00-\u9fa5])\s*:\s*/g, to: '$1：' },
  // 半角问号/叹号 → 全角（这两个在中文语境里几乎不可能是别的意思）
  { re: /([\u4e00-\u9fa5])\?/g, to: '$1？' },
  { re: /([\u4e00-\u9fa5])!/g, to: '$1！' },
  // ⚠️ **半角括号不在这个表里** —— 它用下面的 `normalizeBrackets()` 逐字符处理。
  //   试过写成两条正则（"前面是汉字" / "内容含汉字"），但**边界情形处理不干净**：
  //   `（甲）(乙）` 这种中英混排会被半边转换，产出 `（甲）（乙）` 之外还可能留下
  //   半开半闭。逐字符扫描的规则一眼能看懂，也不会互相干扰。
  // 连续空格压缩（不动行首缩进，那是结构）
  { re: /(\S)[ \t]{2,}(?=\S)/g, to: '$1 ' },
]

const CJK_RE = /[\u4e00-\u9fa5]/

/**
 * 半角括号 → 全角，**逐字符**判定。
 *
 * 什么时候转（一对括号整体判定，避免半开半闭）：
 *   · **紧跟在汉字后面**：`堆放处(store)` —— 中英混排里最常见的一种
 *   · **括号内含汉字**：`(store 堆放处)`、`(甲)`
 * 什么时候不动：
 *   · 纯英文语境：`use (x) here`、`(see below)`
 *   · 已经是全角的那一侧
 *
 * 无括号时**原样返回**（不产生任何改动）。
 */
export function normalizeBrackets(text) {
  const s = String(text ?? '')
  if (!s.includes('(') && !s.includes(')')) return s
  const chars = [...s]
  const out = []
  let prevVisible = '' // 最近一个非空白字符（判断"前面是不是汉字"）
  /** 待决的 ASCII `(` 在 out 里的下标 + 它的前一个可见字符 */
  let pending = null

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]
    if (ch === '(') {
      if (pending) pending = null // 畸形：前一个 `(` 没闭合，放弃它
      pending = { idx: out.length, before: prevVisible }
      out.push(ch)
    } else if (ch === ')' && pending) {
      // 找到与 pending 配对的 `)`：看这对括号是否"沾中文"
      const inside = out.slice(pending.idx + 1).join('')
      const isCjkish = CJK_RE.test(pending.before) || CJK_RE.test(inside)
      if (isCjkish) {
        // ⚠️ 两侧一起换 —— 只换一侧会产出半开半闭的畸形
        out[pending.idx] = '（'
        out.push('）')
      } else {
        out.push(')')
      }
      pending = null
    } else {
      out.push(ch)
    }
    if (ch.trim() !== '') prevVisible = ch
  }
  return out.join('')
}

/** 摘掉转述前缀后只剩这些东西 → 整条没有信息量（例如"他说"）。 */
const NO_INFO_AFTER_ATTRIBUTION_RE = /^[，,。.：:\s]*$/

/**
 * 解析记忆文件为**结构化条目**（含多行续行，且保留分节结构）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ 这里踩过一次，第一版把文件拍平了 —— 改之前务必读完
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版规则是"以 `- ` 开头 = 新条目，其它非空行 = 上一条的续行"。实测直接坏掉：
 *
 *   · 空行被当成续行 → 产出**只有空白的"条目"**
 *   · `## 2026-09-26 桥接新增能力` 这种小标题被当成续行 → 变成 `- ## 2026-09-26 …`
 *
 * 而工作区里的 `MEMORY.md`（30 条、带 4 个日期分节）与 `group-*.md`
 * （带 `## 群内黑话` / `## 事` 分节）**本来就是有结构的文档**。
 * 按那个规则渲染回去 = 把它们拍平，排版全毁。
 *
 * 现在的规则（简单、可预测、不吞结构）：
 *   · 空行 / 只有空白的行        → **独立的空行**，谁的续行都不是
 *   · 以 `- ` 开头               → 新条目
 *   · 以 `#` 开头（markdown 标题）→ **独立的标题行**，不是条目、也不是续行
 *     注：`# 记忆（桥接维护，勿手改）` 是 `appendEntry` 写的文件头，同理
 *   · 其它非空行                 → 上一条的**续行**（`1) …`、缩进的说明等）
 *   · 第一条条目之前的标题/空行  → 文件头（原样保留）
 *
 * **产出的是"行"的有序列表**，不是一个被拍平的结构 —— 渲染时原样放回，
 * 只有条目的正文会被 `tidyText` 处理。这样"没被改的行"一个字节都不动。
 *
 * ⚠️ 不要拿它去替换 `memory-store.mjs` 的 `readEntryLines()`：那个函数的
 *    "一行一条"口径是 `appendEntry` 做**去重比较**用的（比较"要写的这一行"
 *    与"已有的行"），改成多行会把去重和注入一起弄坏。两个用途要两个函数。
 *
 * @param {string} raw 文件全文
 * @returns {{lines: ({type:'entry', lines:string[]}|{type:'blank'}|{type:'heading', text:string}|{type:'raw', text:string})[]}}
 */
export function parseEntries(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  const src = text.split('\n')
  /** @type {any[]} */
  const lines = []
  let seenEntry = false

  for (const line of src) {
    if (line.trim() === '') {
      lines.push({ type: 'blank' })
      continue
    }
    if (line.startsWith('- ')) {
      seenEntry = true
      lines.push({ type: 'entry', lines: [line] })
      continue
    }
    if (line.startsWith('#')) {
      lines.push({ type: 'heading', text: line })
      continue
    }
    // 续行：归到"上一条条目"；若还没出现过条目（纯头部的说明文字），
    // 当作 raw 行原样保留 —— 绝不把头部文字塞成某条记忆的续行。
    const last = lines[lines.length - 1]
    if (seenEntry && last && last.type === 'entry') {
      last.lines.push(line)
      continue
    }
    lines.push({ type: 'raw', text: line })
  }

  return { lines }
}

/** 条目正文（去掉 `- ` 前缀，多行用 \n 连）。 */
export function entryText(entry) {
  const lines = entry?.lines ?? []
  if (lines.length === 0) return ''
  return [lines[0].slice(2), ...lines.slice(1)].join('\n')
}

/** 归一化给**写回用**的文本：标点 + 去冗余日期/转述前缀。**不改语序、不改措辞。** */
export function tidyText(text) {
  let t = String(text ?? '')
  // 只对**首行**去前缀（续行里的日期/转述可能是内容的一部分）
  const parts = t.split('\n')
  parts[0] = parts[0].replace(LEADING_DATE_RE, '')
  parts[0] = parts[0].replace(LEADING_ATTRIBUTION_RE, '')
  t = parts.join('\n')
  for (const r of PUNCT_RULES) t = t.replace(r.re, r.to)
  t = normalizeBrackets(t)
  return t.trim()
}

/**
 * 摘掉转述前缀之后**整条没有信息量**吗（例如原文就是"他说"）？
 * 这种条目应当丢弃 —— 留一条"他说"在档案里毫无价值，还占注入预算。
 */
export function isNoInfoAfterAttribution(text) {
  const t = String(text ?? '').trim()
  if (!LEADING_ATTRIBUTION_RE.test(t) && !LEADING_DATE_RE.test(t)) return false
  const stripped = t.replace(LEADING_DATE_RE, '').replace(LEADING_ATTRIBUTION_RE, '').trim()
  return NO_INFO_AFTER_ATTRIBUTION_RE.test(stripped)
}

/**
 * 整理一个记忆文件的行结构（纯函数，不碰磁盘）。
 *
 * 两条独立的处理，**互不干扰**：
 *   A. **标点/日期归一**：逐条 `tidyText`。不改语序、不改措辞。
 *   B. **去重与合并**：只处理条目（heading / blank / raw 不参与）。
 *
 * 去重与合并**不跨分节**：两个不同小节下的相似条目不会被并到一起 ——
 * 分节本身就是人（或模型）给出的分类意图，跨节合并会把结构搞乱。
 *
 * ⚠️ 合并**只保留一条**，被并掉的进 `merged[]` 供人核对（不静默丢弃）。
 *
 * @param {any[]} lines `parseEntries().lines`
 * @param {{threshold?: number, merge?: boolean}} [opts]
 */
export function consolidateEntries(lines, { threshold = 0.85, merge = true } = {}) {
  const out = []
  const droppedDuplicates = []
  const merged = []
  let before = 0
  // 当前分节里已保留的条目（用于去重/合并）；遇到 heading / blank 就清空
  let sectionKept = []

  for (const node of Array.isArray(lines) ? lines : []) {
    if (node?.type !== 'entry') {
      out.push(node)
      // 分节边界：不跨节去重
      if (node?.type === 'heading' || node?.type === 'blank') sectionKept = []
      continue
    }
    before += 1
    // ── H4：已被更正的条目**原样保留**，且不参与去重/合并 ────────────────────
    //
    // 为什么必须单独一条路：它是**历史**（"这条为什么变成现在这样"的证据），
    // 而整理的两件事（去重、合并）都建立在"这是当前有效的事实"这个前提上。
    // 让它们碰这条会出两种坏事：
    //   · 被当成"重复"删掉 → 证据没了；
    //   · 被当成"相似条目"并进有效条目 → 把被推翻的结论重新焊回有效事实里。
    // 所以：**直接放回原样**（连 `tidyText` 都不做 —— 标注是格式的一部分，
    // 重整它只会引入新的漂移），也不进 `sectionKept`（不能被后面那条当合并目标）。
    if (isSuperseded(entryText(node))) {
      // ⚠️ 必须**物化成 `{type:'entry', text}`**，不能直接 push 原 node：
      //   `parseEntries` 产出的 node 是 `{type:'entry', lines:[…]}`（`text` 为空串），
      //   正文要靠 `entryText()` 拼；而 `renderLines` 读的是 `node.text`。
      //   直接 push 原 node 的后果实测过一次：渲染出 `- undefined`（标注和原文一起没了）。
      out.push({ type: 'entry', text: entryText(node) })
      continue
    }
    // 摘掉冗余前缀后没信息量的（原文只是"他说"）→ 丢掉并记明
    if (isNoInfoAfterAttribution(stripSupersedeNote(entryText(node)))) {
      droppedDuplicates.push({ text: entryText(node), sameAs: '（只有转述前缀、摘掉后为空）' })
      continue
    }
    const text = tidyText(stripSupersedeNote(entryText(node)))
    if (!text) {
      // 归一化后变空（例如原本只有日期）→ 丢掉，但记下来
      droppedDuplicates.push({ text: entryText(node), sameAs: '（归一化后为空）' })
      continue
    }
    const norm = normalizeForCompare(text)

    const dup = sectionKept.find((k) => normalizeForCompare(k.text) === norm)
    if (dup) {
      droppedDuplicates.push({ text, sameAs: dup.text })
      continue
    }

    if (merge) {
      let best = null
      let bestScore = 0
      for (const k of sectionKept) {
        const s = similarity(k.text, text)
        if (s > bestScore) {
          bestScore = s
          best = k
        }
      }
      if (best && bestScore >= threshold) {
        // 留**更长**的那条（信息更多）。
        // ⚠️ 比较要用"**本条**与 best 当前文本"，且判断完再改 best.text ——
        //    第一版先算 `similarity(k.text, text)` 再在分支里改 `best.text`，
        //    于是"先遍历到的短条目"可能被后面的长条目替换掉，
        //    而替换后又影响下一轮的相似度比较 —— 结果**不稳定**（同样的输入
        //    可能因为遍历顺序不同得到不同结果）。现在这个判断是确定的。
        if (text.length >= best.text.length) {
          const replaced = best.text
          best.text = text
          merged.push({ kept: text, mergedAway: replaced, score: Number(bestScore.toFixed(3)) })
        } else {
          merged.push({ kept: best.text, mergedAway: text, score: Number(bestScore.toFixed(3)) })
        }
        continue
      }
    }

    const entry = { type: 'entry', text }
    out.push(entry)
    sectionKept.push(entry)
  }

  return { lines: out, before, after: out.filter((n) => n.type === 'entry').length, droppedDuplicates, merged }
}

/** 把整理结果渲染回文件全文（**没被改的行原样放回**）。 */
export function renderLines(lines) {
  const parts = []
  for (const node of Array.isArray(lines) ? lines : []) {
    if (node?.type === 'entry') {
      // ⚠️ **只有首行**加 `- ` 前缀，续行原样保留。
      //
      // 这里踩过一次：第一版写的是 `parts.push(...String(node.text).split('\n')
      // .map((l) => `- ${l}`))` —— 给**每一行**都加了 `- `，于是缩进续行
      // （`  1) 小概率…`）被写成了 `-   1) 小概率…`。
      // 后果：① 破坏原有排版；② 那行在**下一次解析时变成独立条目**，
      //   条目数漂移 —— 也就是这个整理函数**不幂等**。
      // 幂等是它能被反复调用的前提（自动整理会周期跑），所以这条必须守住。
      const [first, ...rest] = String(node.text).split('\n')
      parts.push(`- ${first}`)
      for (const l of rest) parts.push(l)
      continue
    }
    if (node?.type === 'blank') {
      parts.push('')
      continue
    }
    if (node?.type === 'heading') {
      parts.push(node.text)
      continue
    }
    parts.push(node?.text ?? '')
  }
  // 末尾恰好一个换行（与 appendEntry 的写法一致）
  return `${parts.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * 整理一个记忆文件并写回（**带备份 + 快照刷新**）。
 *
 * ⚠️ **必须刷新快照**：`verifyAndRestoreMemory` 的判据是"文件内容 == 桥接写下的快照"，
 *    整理改了文件却不刷新快照 → 下一次读记忆时会**把整理结果回滚掉**
 *    （表现成"我整理完它又自己变回去了"）。这一点与 `/api/memory/file` 的做法一致。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} opts.rel            相对工作区的记忆文件路径
 * @param {boolean} [opts.apply=false] false = 只算不写（预演）
 * @param {number} [opts.threshold]
 * @param {Function} [opts.saveSnapshot] 传入以在写回后刷新快照
 * @returns {{ok: boolean, rel: string, before: number, after: number, changed: boolean, plan: object, why?: string}}
 */
export function consolidateFile({
  workspace,
  rel,
  apply = false,
  threshold = 0.85,
  merge = true,
  saveSnapshot = null,
} = {}) {
  const root = String(workspace ?? '')
  const abs = join(root, String(rel ?? ''))
  if (!existsSync(abs)) return { ok: false, rel, why: '文件不存在', before: 0, after: 0, changed: false }

  let raw = ''
  try {
    raw = readFileSync(abs, 'utf8')
  } catch (error) {
    return { ok: false, rel, why: `读取失败：${error.message}`, before: 0, after: 0, changed: false }
  }

  const parsed = parseEntries(raw)
  const result = consolidateEntries(parsed.lines, { threshold, merge })
  const next = renderLines(result.lines)
  const changed = next !== raw

  const plan = {
    before: result.before,
    after: result.after,
    droppedDuplicates: result.droppedDuplicates,
    merged: result.merged,
    kept: result.lines.filter((n) => n.type === 'entry').map((n) => n.text),
    preview: next,
  }

  if (!apply || !changed) {
    return { ok: true, rel, before: result.before, after: result.after, changed, plan }
  }

  // ── 写回：先备份，再原子替换，最后刷新快照 ──────────────────────────────
  try {
    const backupDir = join(root, 'memory', '.backups')
    mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(backupDir, `${String(rel).replace(/[\\/]/g, '__')}.${stamp}.bak`), raw, 'utf8')

    const tmp = `${abs}.${process.pid}.tmp`
    writeFileSync(tmp, next, 'utf8')
    renameSync(tmp, abs)
  } catch (error) {
    return { ok: false, rel, why: `写回失败：${error.message}`, before: result.before, after: result.after, changed, plan }
  }

  // ★ 刷新快照 —— 不做这一步，整理结果会在下一次读记忆时被回滚
  if (typeof saveSnapshot === 'function') {
    try {
      saveSnapshot({ workspace: root, rel })
    } catch {
      /* 快照刷新失败不阻塞，但下次读记忆会被回滚 —— 调用方应报出来 */
    }
  }

  return { ok: true, rel, before: result.before, after: result.after, changed, plan }
}

// ══════════════════════════════════════════════════════════════════════════
// 定时整理（H2）：能力早就有了，缺的只是"谁来按这个按钮"
// ══════════════════════════════════════════════════════════════════════════

/**
 * 定时整理的默认间隔：**1 小时**。
 *
 * ★ 为什么需要它（参考项目给的同一个理由，而我们完全适用）：
 *   **QQ 会话永远不会 `/reset`** —— 一个会话可以连续用几个月。
 *   不主动整理，模型写下的"流水账"就会一直堆在记忆文件里，
 *   而记忆是**每轮都要注入**的：堆得越多，越贵，而且越难看出哪条还有用。
 *   本项目实测过同一条消息里出现两个几乎一样的条目（"标点不同、内容相同"），
 *   那正是"需要有人定期收一遍"的证据。
 */
export const CONSOLIDATE_INTERVAL_MS = 60 * 60 * 1000

/**
 * 间隔的**下限**：5 分钟。
 *
 * 为什么要有下限：这个值以后可能变成可配置项，而配置成 `0` / 负数 / 手滑写成毫秒
 * 会把 CPU 打满（整理要读遍所有记忆文件）。所以夹到一个安全范围，而不是照单全收。
 */
export const CONSOLIDATE_MIN_INTERVAL_MS = 5 * 60 * 1000

/**
 * 造一个"定时整理"调度器（**可注入时钟**，所以能离线测）。
 *
 * 三条设计约束（都有具体理由，改动前先读）：
 *
 * ① **只在桥接空闲时动手**：整理会**重写记忆文件**，而写记忆是回合结束时发生的事。
 *    两者撞上就可能把刚写进去的一条覆盖掉（整理用的是"读进来 → 算 → 写回去"）。
 *    所以 `isIdle()` 为假时**这一跳直接跳过**（不是排队 —— 下一个整点还会再来）。
 * ② **失败只记一行日志，绝不抛**：这是增强路径（与 oplog / 台账 / 抽取同一条纪律），
 *    但它**必须留证据**（`AGENT.md` 第 9 条：不许安静地失败）。
 * ③ **只在真的有变更时记日志**：每小时一行"我看了，没变化"会把日志淹掉，
 *    而真正该看的那行"整理了 N 条"就被埋了。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {number} [opts.intervalMs]
 * @param {() => boolean} [opts.isIdle] 返回 false 则这一跳跳过
 * @param {() => string[]} opts.listFiles **必填**（默认要 `listMemoryFiles`，
 *   而那会形成循环依赖 —— 由调用方注入，见文件头）
 * @param {Function} [opts.saveSnapshot] 传 `saveSnapshot` 才会刷新快照基准
 * @param {Function} [opts.log]
 * @param {object} [opts.timer] 可注入的定时器（测试用）
 * @returns {{start: Function, stop: Function, tick: Function, isRunning: Function}}
 */
export function createConsolidateScheduler({
  workspace,
  intervalMs = CONSOLIDATE_INTERVAL_MS,
  isIdle = () => true,
  listFiles = null,
  saveSnapshot = null,
  runFile = consolidateFile,
  threshold = 0.85,
  log = () => {},
  timer = { setInterval, clearInterval },
} = {}) {
  const root = String(workspace ?? '')
  let handle = null
  let ticks = 0
  let lastSummary = null

  function tick() {
    ticks += 1
    if (!root) return { ok: false, why: '缺少 workspace' }
    // ① 忙就跳过（理由见上）—— 跳过**不记日志**，它不是异常
    if (!isIdle()) {
      lastSummary = { ok: true, skipped: 'busy', ticks }
      return lastSummary
    }
    let files = []
    try {
      if (typeof listFiles !== 'function') {
        // 没注入就是接线问题 —— 不许静默（AGENT.md 第 9 条）
        log('❌ [memory] 定时整理：没有注入 listFiles（内部接线问题），这一跳跳过')
        return { ok: false, why: '没有 listFiles' }
      }
      files = listFiles() ?? []
    } catch (error) {
      log(`❌ [memory] 定时整理：列不出记忆文件（这一跳跳过）：${error?.message ?? error}`)
      return { ok: false, why: '列表失败' }
    }

    const changedFiles = []
    let before = 0
    let after = 0
    for (const rel of files) {
      try {
        const r = runFile({ workspace: root, rel, apply: true, threshold, saveSnapshot })
        if (!r?.ok) {
          // 单个文件失败不影响其它文件 —— 但要留证据
          log(`❌ [memory] 定时整理：${rel} 失败：${r?.why ?? '未知原因'}`)
          continue
        }
        before += r.before ?? 0
        after += r.after ?? 0
        if (r.changed) changedFiles.push(rel)
      } catch (error) {
        log(`❌ [memory] 定时整理：${rel} 抛异常（已跳过）：${error?.message ?? error}`)
      }
    }

    // ② 只在真的有变更时说话
    if (changedFiles.length > 0) {
      log(
        `[memory] 定时整理：${changedFiles.length} 个文件有变化（条目 ${before} → ${after}）：` +
          changedFiles.join('、'),
      )
    }
    lastSummary = { ok: true, ticks, files: files.length, changed: changedFiles.length, before, after }
    return lastSummary
  }

  function start() {
    if (handle) return false
    const ms = Number(intervalMs)
    if (!Number.isFinite(ms) || ms <= 0) {
      log('[memory] 定时整理未开启（intervalMs <= 0）')
      return false
    }
    const every = Math.max(CONSOLIDATE_MIN_INTERVAL_MS, ms)
    handle = timer.setInterval(tick, every)
    // ★ `unref()`：**绝不能因为一个整理定时器让进程不退出** ——
    //   桥接是靠 Ctrl+C / SIGTERM 收尾的，一个被引用的 interval 会把退出拖住。
    handle?.unref?.()
    log(`[memory] 定时整理已开启（每 ${Math.round(every / 60000)} 分钟一次，只在桥接空闲时动手）`)
    return true
  }

  function stop() {
    if (!handle) return false
    timer.clearInterval(handle)
    handle = null
    return true
  }

  return { start, stop, tick, isRunning: () => Boolean(handle), stats: () => ({ ticks, lastSummary }) }
}
