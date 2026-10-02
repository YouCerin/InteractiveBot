/**
 * 聊天记录评审台 —— **评论 → 点 → 改写草稿**（用户 2026-10-02 定的新形状）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么改成这样（推翻的正是第一版的"标签"）
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版让人**从一张手写标签表里选**（太长 / 像客服 / 乱用省略号…），然后把标签
 * 统计成排行。使用者直接说：**"标签系统并不合理"** —— 他的习惯是
 * **对说得对与不对的地方写一句评论**。这是对的，而且差别是根本性的：
 *
 *   · 标签表是**我预先想好的分类**。人只能在我给的格子里打勾，
 *     我没想到的问题就**永远进不了统计**（这是最要命的：工具会让人以为
 *     "排行榜上没有 = 没问题"）；
 *   · 评论是**人自己的判断**，而"点"应该是**从评论里长出来的**（他的原话：
 *     「从我的评论中整理新的点放上去」），不是我预先设定的。
 *
 * ∴ 现在的形状是：**评论（人写）→ 整 理（归纳成点）→ 草稿（整篇重写）**。
 *   而且"整理"这件事**只有模型做得了**（自由文本的归纳）——这是本工具唯一一次
 *   调模型，且它是人点一下才发生的、结果永远只是**草稿**。
 *
 * ── 两条必须守住的边界 ────────────────────────────────────────────────────
 *   ① **锚点**：整篇重写有机会改坏人格文件，所以有一张"底线要点"表（越权/泄露记忆/
 *      假装成功/别的 bot/不是屈服…）。改写里丢了哪条，就**拒绝应用**并点名说清。
 *      （判据是短词包含，允许同义写法；人确认后可以覆盖 —— 见 store 的 applyDraft。）
 *   ② **失败要说清楚**：模型不通/超时/输出不合法时，如实回 `ok:false` + 为什么，
 *      并附上**本地聚类**的初步分组（至少让人看见"评论都还在"），绝不假装整理过。
 */

import { similarity } from './text-similarity.mjs'

/**
 * **底线要点**：整篇重写时一条都不许丢。
 *
 * 判据刻意用**短词** + `any` 同义写法（而不是整句），因为改写本来就会换措辞：
 * 要求逐字保留整句，等于禁止任何改写；而只要求"这个要点还在"才能既允许精简、
 * 又拦住"把安全底线顺手删掉"。
 */
export const STYLE_ANCHORS = [
  { id: 'precedence', label: '优先级条款（与别处冲突时以本节为准）', any: ['以本节为准'] },
  { id: 'no_leak', label: '不泄露记忆', any: ['不泄露记忆', '不外泄记忆'] },
  { id: 'no_privilege', label: '不越权（权限由代码判定）', any: ['不越权', '权限由代码'] },
  { id: 'no_fake_success', label: '不假装成功', any: ['不假装成功'] },
  { id: 'no_bot_relay', label: '别的机器人不接力', any: ['别的 bot', '别的机器人'] },
  { id: 'not_submit', label: '接梗不是屈服', any: ['不是屈服'] },
  { id: 'honorific_is_line', label: '敬语是台词，不是认输', any: ['敬语是台词'] },
  { id: 'no_made_up', label: '不确定的事实不要编', any: ['不要编', '不许编'] },
  { id: 'down_mood', label: '对方低落时不玩梗', any: ['低落'] },
  { id: 'sexual_refusal', label: '情色暗示看懂并拒绝', any: ['不搞这些'] },
]

/** 一次整理最多带多少条评论 / 多少字符（超了如实截断，不静默）。 */
export const CONSOLIDATE_LIMITS = { comments: 150, chars: 14_000, styleChars: 9_000 }

/** 核对改写后的文本是否保住了全部底线要点。 */
export function checkAnchors({ text, anchors = STYLE_ANCHORS } = {}) {
  const body = String(text ?? '')
  const missing = []
  for (const a of anchors) {
    const hit = (a.any ?? []).some((needle) => body.includes(needle))
    if (!hit) missing.push({ id: a.id, label: a.label, any: a.any ?? [] })
  }
  return { ok: missing.length === 0, missing, checked: anchors.length }
}

/** 一条评论压成提示词里的一行（**编号要留给模型回指**，所以 id 用序号）。 */
function commentLine(entry, index) {
  const verdict = { good: '对', bad: '不对', ok: '还行' }[entry?.verdict] ?? '（没判档）'
  const ctx = (entry?.context ?? [])
    .map((c) => `${c.isBot ? '机器人' : c.name}：${c.text}`)
    .join(' / ')
    .replace(/\s*\n\s*/g, ' ')
  const reply = String(entry?.reply ?? '').replace(/\s*\n\s*/g, ' / ')
  const comment = String(entry?.comment ?? '').replace(/\s*\n\s*/g, ' ').trim()
  // ★★ 标签也要写进这一行（使用者 2026-10-02：「选择标签已经相当于评论了」）。
  //   模型必须看得见"人已经用标签表达了什么"，否则"只点了标签"的评论在提示词里等于空的。
  const tags = (Array.isArray(entry?.points) ? entry.points : [])
    .map((p) => String(p?.title ?? '').trim())
    .filter(Boolean)
  const detail =
    [comment, tags.length ? `标签：${tags.join('、')}` : ''].filter(Boolean).join('｜') ||
    '（只判了档，既没写文字也没点标签）'
  return `[${index + 1}] ${verdict}｜机器人当时说：「${reply}」${ctx ? `｜当时对方说：「${ctx}」` : ''}\n    评论：${detail}`
}

/**
 * 造提示词（**纯函数**，所以提示词本身能被断言钉住）。
 *
 * ★ 三条纪律写进提示词里，缺一条都会产出没法用的草稿：
 *   ① **归纳，不是照抄**；② **在精不在多**（点太多等于没整理）；
 *   ③ 输出**只有 JSON**（解析器不猜散文）。
 */
export function buildConsolidatePrompt({ comments = [], styleText = '', anchors = STYLE_ANCHORS, limits = CONSOLIDATE_LIMITS } = {}) {
  // ★ 新口径：有文本**或**有标签都算"有评论"（只点标签也是评论，必须喂给模型）
  const withText = comments.filter(
    (c) => String(c?.comment ?? '').trim() || (Array.isArray(c?.points) && c.points.length),
  )
  const kept = withText.slice(0, Math.max(1, Number(limits.comments) || 150))
  const lines = []
  let used = 0
  for (let i = 0; i < kept.length; i += 1) {
    const line = commentLine(kept[i], i)
    if (used + line.length > (Number(limits.chars) || 14_000)) break
    used += line.length
    lines.push(line)
  }
  const anchorList = anchors.map((a) => `   · ${a.label}（可用这些说法之一：${(a.any ?? []).join(' / ')}）`).join('\n')

  return {
    prompt: [
      '你在帮人修订一个 QQ 机器人（「小鲸鱼」）的**说话方式**（它在当前那份人设里）。',
      '人已经逐条评审过它的真实发言并写了评论。你要做的是：**基于"评过的发言 + 那些评论"，',
      '给出针对这份说话方式的【修改意见】**。',
      '',
      '⚠️ 你**不需要**、也**不要**输出整份新文件 —— 使用者明确要求「只要意见，修改内容由 LLM 另外执行」。',
      '每条意见都必须是**可以照着动手的一处修改**。',
      '',
      '【现有的说话方式全文（当前那份人设）】',
      String(styleText ?? '').slice(0, Number(limits.styleChars) || 9000),
      '',
      `【人工评审意见（共 ${lines.length} 条）】`,
      lines.join('\n'),
      '',
      '【要求】',
      '1. **归纳，不是照抄**：同一个问题的多条评论算**一条意见**；意见要写成"这一条该改成什么"，',
      '   而不是"某人说过 XX"。宁可少而准：1~6 条最好。',
      '2. 每条意见四个字段，都要具体：',
      '   · `action`：`rewrite`（改现有某条）/ `merge`（并进另一条）/ `delete`（删掉）/ `add`（新增一条）；',
      '   · `target`：**指向现有文件的哪一条/哪一节** —— 尽量引用那一句的**原文片段**（几个字即可），',
      '     并写出它所在的小节名（如 `说话方式` / `底线`）。`add` 时写建议放进哪一节。',
      '   · `advice`：**建议改成什么** —— 直接给出可用的措辞（要短、要能直接抄进文件）；',
      '   · `reason`：为什么这么改（引用评论里的依据，说明"谁在什么情况下说了什么、它答成了什么样"）。',
      '3. `evidence`：这条意见依据的是哪几条评论，填它们的**编号**（数组，如 `["2","5"]`）。',
      '4. 下面这些**底线要点必须继续被这份文件覆盖**（措辞可以改，要点不能丢）。',
      '   如果你认为现有文件里某一条写得不够清楚，就**为它单独出一条意见**；',
      '   如果它已经写得很好、这次不需要动，**不要在意见里提它**：',
      anchorList,
      '5. **只输出 JSON**（不要解释、不要 markdown 代码块），形状严格如下：',
      '{"suggestions":[{"action":"rewrite","target":"说话方式 · 「省略号只在「无语」的时候用」",',
      '  "advice":"……", "reason":"……", "evidence":["2","5"]}],',
      ' "notes":"可选：一句话总体说明（没有就空串）"}',
      '',
      '⚠️ 再强调一次：**不要**给 `rewritten`（整份新文件），**只要** `suggestions`。',
      '',
      '🚨 **JSON 里的字符串有两条硬规矩**（违反了整份输出就作废，人那边只会看到"解析失败"）：',
      '   · **字符串内部不许出现未转义的 ASCII 双引号 `"`**。你要引用那份文案里的原句时',
      '     （它本身就含 `"说多长"` 这种引号），**一律改写成中文引号「」**，',
      '     例如把 `任何关于"说多长"的要求` 写成 `任何关于「说多长」的要求`。',
      '   · **值里不许出现裸换行**：要换行就写两个字符 `\\n`，不要真的回车。',
    ].join('\n'),
    kept: lines.length,
    truncatedComments: withText.length - lines.length,
    chars: used,
    droppedForNoText: comments.length - withText.length,
  }
}

/** 意见的四种动作（写死，免得模型自创第五种）。 */
export const SUGGESTION_ACTIONS = ['rewrite', 'merge', 'delete', 'add']

/**
 * 意见对**底线要点**的覆盖情况（**只提示，不拦**）。
 *
 * ★ 用途变了（2026-10-02 第三版）：上一版用它**拦应用**（丢了要点就 409）；
 *   现在没有"应用"了，所以它只回答一个问题："这份意见里，哪些底线要点被提到了、
 *   哪些一条都没提" —— 没提到不等于错（可能这次就是不用动它们），但值得让人看见。
 * 判据与 `checkAnchors` 同一套（短词包含），只是把被查的文本从"重写后的整篇"
 * 换成"这份意见的全部文字"。
 */
export function anchorCoverage({ suggestions = [], anchors = STYLE_ANCHORS } = {}) {
  const text = suggestions
    .map((s) => `${s?.action ?? ''} ${s?.target ?? ''} ${s?.advice ?? ''} ${s?.reason ?? ''}`)
    .join('\n')
  const covered = []
  const uncovered = []
  for (const a of anchors) {
    const hit = (a.any ?? []).some((needle) => text.includes(needle))
    ;(hit ? covered : uncovered).push({ id: a.id, label: a.label })
  }
  return { covered, uncovered, checked: anchors.length }
}

/**
 * `"` 能不能在这里**开**一个字符串？（判据的由来看 `repairJsonText` 的注释）
 *
 * 合法 JSON 里 `"` 只出现在"该出现键或值"的位置 —— 前面一个有意义的字符是
 * `{` `[` `,` `:`，或什么都没有。反过来说，前面是 `}` `]`、刚收尾的字符串、
 * 裸字面量时，这个 `"` 一定是多打的。
 * ★ 这条判据对**合法输入永远为真**（合法 JSON 不会走到 else 分支）—— 所以它只可能修好。
 */
const canOpenStringAfter = (prev) =>
  prev === '' || prev === '{' || prev === '[' || prev === ',' || prev === ':'

/**
 * **修复模型手写的 JSON**（不改语义，只补它忘了的转义）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这一层（2026-10-02 使用者第一次真跑整理就炸了）
 * ══════════════════════════════════════════════════════════════════════════
 * 失败原文：`模型的 JSON 解析失败：Expected ',' or '}' after property value in JSON
 * at position 99 (line 1 column 100)`。
 *
 * 根因不是模型偶发失手，而是**设计缺陷**：那份说话方式本身含 ASCII 双引号
 * （例如 `…任何关于"说多长""要不要分条"…的要求…`），而我们要模型**引用现有文件的原文**
 * 来指认"改哪一条"。它把原句抄进 JSON 字符串时，那些 `"` 没有转义 ⇒ JSON 当场崩，
 * 位置正好落在第一处引用上。
 * ★ 0.3.0alpha：文案搬过两次（`styles/闲聊.md` → `src/voice.mjs` 的常量 → **人设文件**），
 *   但**那些 ASCII 双引号照旧在**（整篇逐字保留）—— 所以这一层不能删。
 *
 * ── 判定一个 `"` 是"收尾"还是"正文里的引号" ───────────────────────────────
 * 在字符串内部遇到 `"` 时，**往后跳过空白**看下一个字符：
 *   · `,` `}` `]` `:` 或**输入结束** ⇒ 合法的收尾引号；
 *   · 其它 ⇒ 它属于正文，必须转义成 `\"`。
 * 这条判据正是 `"说多长"` 这类引用的识别依据（引号后面跟的是汉字，不是分隔符）。
 *
 * ── 字符串**外面**的 `"` 也要判（2026-10-03 补的第二个洞）─────────────────
 * 上面那条只管"已经在字符串里"，外面看到 `"` 就无条件开一个字符串。于是模型**多打**
 * 一个引号时，后面的 `,` `}` 全被当成正文吞进字符串，最后还是死在
 * `Expected ',' or '}' after property value`，而且位置指着那个引号，离真正的错处挺远。
 * 使用者 2026-10-03 报的就是这条（原文形状，两次都是 `]` 后面多一个 `"`）：
 *   · `…"evidence":["5","26"]}]","notes":"…"`   ← `]` 后面多一个 `"`
 *   · `…"evidence":["5","26"]"}]`               ← 同族（数组收尾后多一个 `"`）
 * 判据：`"` 只有在**该出现键或值**的位置才能开字符串 —— 前面一个有意义的字符是
 * `{` `[` `,` `:`，或什么都没有。反过来，前面是 `}` `]`、刚收尾的字符串、裸字面量时，
 * 这个引号一定是多打的 ⇒ **丢掉它**。
 * ★ 合法 JSON 里 `"` 永远只出现在前一组位置 ⇒ 这条判据**碰不到任何本来合法的输入**，
 *   只可能修好，不可能修坏（这是它敢直接丢字符的理由）。
 * ⚠️ 刻意**不猜**另一种形状："漏了逗号"（`{"a":1"b":2}`、`]"notes"`）。要修它就得猜
 *   "这个引号是串位的还是少了个逗号"，猜错会把**本来能修的**变成修不了的。宁可照旧
 *   失败，并且把模型原文落盘（见 `consolidateComments` 的 `raw`）—— 有了真证据再动它。
 *
 * 另外两种常见手滑一并处理：字符串里的**裸换行**（转成 `\n`）、
 * **尾随逗号**（`,"}` / `,]`，丢掉那个逗号）。
 *
 * @returns {{text: string, changed: boolean, fixes: number}}
 */
export function repairJsonText(input) {
  const s = String(input ?? '')
  let out = ''
  let inStr = false
  let esc = false
  let fixes = 0
  /** 已输出内容里**最后一个有意义的字符**（跳过空白）—— 判定"这里能不能开字符串"要靠它。 */
  let prev = ''
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (!inStr) {
      if (c === '"') {
        if (!canOpenStringAfter(prev)) {
          // ★ 多打的引号（2026-10-03 报的那条）：丢掉它，**别**开字符串。
          //   开下去会把后面的 `,` `}` 一起当成正文吞掉，最后死在离现场很远的位置。
          fixes += 1
          continue
        }
        inStr = true
        out += c
        prev = c
        continue
      }
      // 尾随逗号：`,"}` / `,]` —— 逗号后面（跳过空白）直接是收尾符号
      if (c === ',') {
        let j = i + 1
        while (j < s.length && /\s/.test(s[j])) j += 1
        if (s[j] === '}' || s[j] === ']') {
          fixes += 1
          continue
        }
      }
      out += c
      if (!/\s/.test(c)) prev = c
      continue
    }
    // ── 字符串内部 ────────────────────────────────────────────────────────
    if (esc) {
      out += c
      esc = false
      continue
    }
    if (c === '\\') {
      out += c
      esc = true
      continue
    }
    if (c === '\n') {
      out += '\\n'
      fixes += 1
      continue
    }
    if (c === '\r') {
      out += '\\r'
      fixes += 1
      continue
    }
    if (c === '\t') {
      out += '\\t'
      fixes += 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && /\s/.test(s[j])) j += 1
      const next = s[j]
      const legit =
        next === undefined || next === ',' || next === '}' || next === ']' || next === ':'
      if (legit) {
        inStr = false
        out += c
        prev = c
        continue
      }
      out += '\\"'
      fixes += 1
      continue
    }
    out += c
  }
  return { text: out, changed: fixes > 0, fixes }
}

/**
 * 从 JSON 报错信息里抠出位置，并给出那一小段原文（定位用，别让人对着 "第 100 列" 猜）。
 *
 * ⚠️ 不是所有报错都带 position（例如 `Unexpected end of JSON input`）—— 那种情况下
 * 退化成"原文末尾一小段"：截断类错误的问题几乎总在末尾，给人看的价值一样。
 */
function locateJsonError(error, text) {
  const m = /position (\d+)/.exec(String(error?.message ?? ''))
  if (m) {
    const at = Number(m[1])
    const from = Math.max(0, at - 40)
    const snippet = String(text).slice(from, at + 40).replace(/\s+/g, ' ')
    return `｜位置 ${at} 附近：…${snippet}…`
  }
  const tail = String(text).slice(-60).replace(/\s+/g, ' ')
  return tail ? `｜原文末尾：…${tail}` : ''
}

/** 从模型的回复里抠出 JSON（容错：剥 ``` 围栏、取第一个大括号块、**修复未转义的引号**）。 */
export function parseConsolidation(raw) {
  let text = String(raw ?? '').trim()
  if (!text) return { ok: false, why: '模型返回了空内容' }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) text = fence[1].trim()
  if (!text.startsWith('{')) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return { ok: false, why: '模型没按 JSON 形状回答（找不到 JSON 对象）' }
    text = text.slice(start, end + 1)
  }
  const shape = fence ? 'fence' : 'raw'
  let data = null
  let via = shape
  try {
    data = JSON.parse(text)
  } catch (first) {
    // ★ 第一遍失败 ⇒ 按"它忘了转义"修一次再试（判据见 repairJsonText 的注释）
    const fix = repairJsonText(text)
    if (!fix.changed) {
      return { ok: false, why: `模型的 JSON 解析失败：${first?.message ?? first}${locateJsonError(first, text)}` }
    }
    try {
      data = JSON.parse(fix.text)
      // ★ 如实标出"这份是修过的"——不许把修复当成本来就好（排查时要能分辨）
      via = `${shape}+repaired`
    } catch (second) {
      return {
        ok: false,
        why:
          `模型的 JSON 解析失败（已尝试修复 ${fix.fixes} 处仍未通过）：${second?.message ?? second}` +
          `${locateJsonError(second, fix.text)}`,
      }
    }
  }
  if (!data || typeof data !== 'object') return { ok: false, why: '模型返回的 JSON 不是对象' }
  const incoming = Array.isArray(data.suggestions) ? data.suggestions : []
  const suggestions = incoming
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      action: SUGGESTION_ACTIONS.includes(String(s.action ?? '')) ? String(s.action) : 'rewrite',
      target: String(s.target ?? '').trim(),
      advice: String(s.advice ?? '').trim(),
      reason: String(s.reason ?? '').trim(),
      evidence: Array.isArray(s.evidence) ? s.evidence.map((x) => String(x)) : [],
    }))
    // 没有"建议改成什么"的意见是没法执行的，丢掉它（并在下面如实报数）
    .filter((s) => s.advice)
  if (!suggestions.length) {
    return { ok: false, why: '模型没有给出任何可执行的修改意见（suggestions 为空或都没有 advice）' }
  }
  return {
    ok: true,
    suggestions,
    notes: String(data.notes ?? '').trim(),
    /** 被丢掉的条数（模型给了形状但没给建议正文）—— 如实报出来，不静默吞掉。 */
    droppedEmpty: incoming.length - suggestions.length,
    via,
  }
}

/**
 * 本地**确定性**聚类（模型不可用时的退路）。
 *
 * 它做不了"归纳成规则"（那需要语义），但能把**说法相近的评论聚成组并计数** ——
 * 至少让人看见"哪些评论在说同一件事、说了几遍"，而不是一堆散句。
 * 判据用 `text-similarity.mjs`（仓库已有的字符二元组相似度），阈值 0.34：
 * 刻意松（宁可把两件事并到一起让人自己拆，也不要让同一件事散成五组）。
 */
export function clusterComments({ comments = [], threshold = 0.34, verdict = '' } = {}) {
  const rows = comments.filter((c) => String(c?.comment ?? '').trim() && (!verdict || c.verdict === verdict))
  const clusters = []
  for (const row of rows) {
    const text = String(row.comment).trim()
    const hit = clusters.find((c) => similarity(c.text, text) >= threshold)
    if (hit) {
      hit.count += 1
      hit.ids.push(row.id)
      continue
    }
    clusters.push({ text, count: 1, ids: [row.id] })
  }
  return clusters.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
}

/**
 * 整理一次（**唯一一次模型调用**）：评论 → 针对那份说话方式的**修改意见**。
 *
 * @param {object} opts
 * @param {object[]} opts.comments   评论（含 verdict / comment / reply / context）
 * @param {string} opts.styleText    当前那份说话方式全文（意见要指向它里面的具体条目）
 *   ★ 参数名保留 `styleText`（0.3.0beta 时代是"风格文件全文"）：改名的代价是
 *     调用方、测试与评审台 store 三处一起动，而它的**语义没变** —— 就是"要改的那份文案"。
 * @param {object} [opts.target]     `resolveDirectTarget()` 的结果（ok/baseUrl/apiKey/model）
 * @param {Function} [opts.callModel] `chatOnce`（测试注入；默认由调用方传进来）
 * @returns {Promise<object>} 成功 `{ok:true, suggestions, notes, anchorCoverage, ...}`；
 *   失败 `{ok:false, why, clusters?}`（**永远带 clusters**，让人看到评论没丢）
 */
export async function consolidateComments({
  comments = [],
  styleText = '',
  target = null,
  anchors = STYLE_ANCHORS,
  limits = CONSOLIDATE_LIMITS,
  callModel = null,
  timeoutMs = 120_000,
  maxTokens = 8000,
  temperature = 0.3,
} = {}) {
  const built = buildConsolidatePrompt({ comments, styleText, anchors, limits })
  const fallback = () => ({
    bad: clusterComments({ comments, verdict: 'bad' }),
    good: clusterComments({ comments, verdict: 'good' }),
  })

  if (!built.kept) {
    return { ok: false, why: '一条带评论的评分都没有（只有判档），没什么可整理', clusters: fallback() }
  }
  if (!target?.ok) {
    return { ok: false, why: `模型通路不可用：${target?.why ?? '没解析出可用的 key/端点'}`, clusters: fallback() }
  }
  if (typeof callModel !== 'function') {
    return { ok: false, why: '没有可用的模型调用函数（callModel 没传）', clusters: fallback() }
  }

  const r = await callModel({
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    model: target.model,
    prompt: built.prompt,
    timeoutMs,
    maxTokens,
    temperature,
    label: '评论整理',
  })
  if (!r?.ok) {
    return { ok: false, why: `模型调用失败：${r?.why ?? '未知原因'}`, clusters: fallback(), ms: r?.ms }
  }
  const parsed = parseConsolidation(r.text)
  if (!parsed.ok) {
    // ★ 失败必须**带上模型原文**（不截断）：调用方要把它落盘当证据。
    //   2026-10-03 的教训 —— 只留一句报错，就得靠合成坏 JSON 去反推形状。
    return { ok: false, why: parsed.why, clusters: fallback(), ms: r?.ms, raw: String(r.text ?? '') }
  }
  const coverage = anchorCoverage({ suggestions: parsed.suggestions, anchors })
  return {
    ok: true,
    suggestions: parsed.suggestions,
    notes: parsed.notes,
    droppedEmpty: parsed.droppedEmpty,
    anchorCoverage: coverage,
    via: parsed.via,
    model: target.model,
    ms: r?.ms ?? null,
    usage: r?.usage ?? null,
    promptStats: { kept: built.kept, truncatedComments: built.truncatedComments, chars: built.chars },
  }
}
