/**
 * 回合后抽取（R4b）：从刚结束的任务里提炼**配方**，以及**用户习惯**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么拖到最后才做（以及它唯一的通路是什么）
 * ══════════════════════════════════════════════════════════════════════════
 * 设计文档（`docs/0.2.1-runtime-memory-design.md` §6）要求"一次调用同时产出
 * 三类结果"，而**这一次额外调用需要一条模型通路**。当时本项目**没有直连模型 API
 * 的代码**（`dsh.apiKey` 只用于注入 DSH 子进程的环境变量），所以只有两条路：
 *
 *   · 用桥接自己那条 sdk 会话 —— ❌ 不行。那会话是**用户对话的载体**，
 *     拿它跑抽取会把内部 prompt 混进用户上下文，且每 5 轮就污染一次。
 *   · **起一个一次性的 DSH 进程** —— ✅ 这条路可行：`dsh --profile headless "<prompt>"`
 *     就是"答一次、打印结果、退出"。实测本机 2.8~4.4 秒返回，零侵入。
 *
 * ★★ **0.2.3 补充：现在有第二条路了** —— `src/model-direct.mjs` 的 `chatOnce()`
 *    （一次 `/chat/completions`，约 1 秒、一次小 completion）。本模块**暂时仍然
 *    用 `runHeadless`**（它跑得通、而且抽取每个回合只跑一次，2.8~4.4 秒可以接受），
 *    但"没有直连通路"这句话**已经过期**：要换过去是换个 runner 的事
 *    （`extractRecipe({ runner })` 本来就是可注入的）。
 *    保留现状的理由写在这里，免得下一个人以为"忘了换"。
 * ⚠️ 上面那句"本项目没有直连模型 API 的代码"在 0.2.3 之前是真的、现在是假的 ——
 *    它被刻意留着并加了这一行更正，因为**过期的技术前提比没有前提更危险**。
 *
 * ⚠️ 实测踩到的坑（第二次）：headless **会把 reasoning 写到 stderr**，
 *    stdout 只有答案。早期用 `2>&1` 抓输出会把思考过程混进来。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 第三个坑：headless 产出的 JSON **不合法**
 * ══════════════════════════════════════════════════════════════════════════
 * 即使提示词里明确写了「所有键名必须用双引号」并给了带引号的示例，
 * 模型**稳定输出无引号的"裸词 JSON"**：
 *
 *   {title:品牌口碑核查,trigger:{keywords:[帮我查一下某品牌靠不靠谱],...}}
 *
 * 实测强化措辞**无效**（试过一次，输出照旧）。所以只能自己解析：
 * `parseLooseJson()` 是一个逐字符扫描器，能在"值"的位置补上缺失的引号，
 * 边界由结构符（`, ] }`）与嵌套层数决定。
 *
 * ★ **这一点决定了整个 R4b 的可靠性**：抽取返回的东西必须先变成**合法对象**
 *   才能进 `normalizeRecipe` 的字段校验。否则整条链路就是"有时能用"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 成本与默认值
 * ══════════════════════════════════════════════════════════════════════════
 * 这是**唯一会产生额外模型调用**的功能。所以：
 *   · 默认 `everyN = 5`（每 5 个回合一次）
 *   · 每次调用**最多一条配方**、`maxTokens` 由调用方给足
 *   · 失败**一律静默**（增强路径，绝不影响聊天）
 *   · 抽到的配方**先入库、置信度为初始 0.5**，只有反复用成功才会升上去 ——
 *     也就是说"第一次抽出来的做法不会立刻被当成经验注入"
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/** 默认抽取节奏（每几个回合一次）。 */
export const DEFAULT_EVERY_N = 5

/** 单次抽取的超时（毫秒）。实测一次 3~5 秒，给足余量。 */
export const DEFAULT_TIMEOUT_MS = 60_000

/** 喂给抽取的"做过的事"最多几条（太多会拖长 prompt、也没必要）。 */
export const MAX_OPS_FOR_PROMPT = 12

// ══════════════════════════════════════════════════════════════════════════
// 宽松 JSON 解析（这是本模块最要紧的一块）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 逐字符扫描，给"裸词"补上引号。**返回修复后的文本，不解析。**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须自己写（而不是要求模型输出合法 JSON）
 * ══════════════════════════════════════════════════════════════════════════
 * 实测：提示词里明写「所有键名必须用双引号」+ 给出带引号的示例，
 * 模型**照旧**输出 `{title:品牌口碑核查,trigger:{keywords:[...]}}`。
 * 再强化措辞只是浪费时间 —— 只能自己解析。
 *
 * 规则（逐字符扫描，不靠正则猜）：
 *   · 进入 `"…"` 后按**字符串**处理（支持 `\"` 转义）—— 于是含逗号/冒号/
 *     括号的**带引号**值不会被误切
 *   · 遇到 `:` 时回头把**刚写出的裸键**补上引号
 *   · `:` 之后的**裸值**读到**任何结构符**（`,` `{` `[` `}` `]`）为止，
 *     然后补上引号
 *
 * ⚠️ 这里修过两个 bug，都是"只做一半"：
 *   ① **只给值补引号，没管键** → `{a:1}` 变成 `{a:"1"}`，键还是裸的，
 *      `JSON.parse` 照旧抛 `Expected property name`。
 *   ② **裸值扫描遇到 `[` 不停**（还把它推进栈继续吞）→ `{keywords:[a,b]}`
 *      里的 `[a,b]` 被当成一个整体加引号，再配上留下的 `]` 变成
 *      `"{keywords:["..."]"}` —— 必然解析失败。
 *      结构符开头的值**本来就不该被引号包住**，碰到就该退出去让主循环接手。
 *
 * 单独导出是为了**可测**：解析失败时能直接把修复结果打出来看，
 * 而不是只能看到一个 `null`（踩 bug ② 时排查很费劲）。
 *
 * @param {string} body 已经抠好的 `{...}` / `[...]`
 * @returns {string}
 */
export function quoteBareTokens(body) {
  const src = String(body ?? '')
  let out = ''
  let i = 0
  let inStr = false
  let esc = false
  const stack = []

  /** 在 `:` 处调用：把刚写出的裸键补上引号（合法 JSON 的那一支已有引号，不动）。 */
  const quotePendingKey = () => {
    if (stack.length === 0 || stack[stack.length - 1] !== '{') return
    let k = out.length - 1
    let depth = 0
    while (k >= 0) {
      const ch = out[k]
      if (ch === '}' || ch === ']') depth += 1
      else if (ch === '{' || ch === '[') {
        if (depth === 0) break
        depth -= 1
      } else if (ch === ',' && depth === 0) break
      k -= 1
    }
    const seg = out.slice(k + 1)
    if (seg.includes('"')) return // 已有引号
    const key = seg.trim()
    if (!key) return
    out = `${out.slice(0, k + 1)}"${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }

  while (i < src.length) {
    const c = src[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      i += 1
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i += 1
      continue
    }
    if (c === '{' || c === '[') {
      stack.push(c)
      out += c
      i += 1
      continue
    }
    if (c === '}' || c === ']') {
      stack.pop()
      out += c
      i += 1
      continue
    }
    if (c === ':') {
      quotePendingKey()
      out += c
      i += 1
      continue
    }

    // ── 裸 token（键 / 值 / 数组元素）──────────────────────────────────────
    //
    // ⚠️ 这里修过 bug ③：**数组元素也是裸 token**，不能只在 `:` 之后处理。
    //    第一版只在"前一个非空字符是 `:`"时补引号，于是
    //    `{keywords:[帮我查一下…,这品牌可信吗]}` 里的数组元素**没被补**，
    //    解析照旧失败。所以把这个判断提到主循环：
    //      · 前一个非空字符是 `:`  → 这是**值**
    //      · 否则（`[`、`,` 之后）→ 可能是**键**（在 `{}` 里）或**数组元素**
    //    两种都读一个裸 token 并补引号；**读到任何结构符就停**，
    //    因为结构符开头的值/元素本来就不该被引号包住。
    //
    // ⚠️⚠️ 并且**必须保证 i 前进** —— 第一版漏了这一点，当 `src[i]` 是空白
    //    时 `j` 会停在 `i`，于是**死循环**（实测直接把探针跑到超时）。
    //    下面每个分支都保证 `i` 至少 +1。
    if (/\s/.test(c)) {
      out += c
      i += 1
      continue
    }
    let j = i
    while (j < src.length) {
      const ch = src[j]
      if (ch === ',' || ch === '{' || ch === '[' || ch === '}' || ch === ']' || ch === ':') break
      j += 1
    }
    if (j === i) {
      // 理论上到不了（结构符都在上面处理过了），但守住"一定前进"
      out += c
      i += 1
      continue
    }
    const tok = src.slice(i, j).trim()
    if (tok) {
      // ⚠️ **JSON 字面量保持不加引号** —— 这里修过一个 bug：
      //    第一版无脑给每个裸 token 加引号，于是 `{skip:true}` 变成
      //    `{"skip":"true"}` —— **字符串 `"true"` 而不是布尔 `true`**。
      //    后果很实际：`parsed.skip === true` 判断失效（`"true" === true` 为假），
      //    "不值得沉淀就 skip"这条最重要的语义会**静默失效**。
      //    数字同理（`{n:1}` 应该得到 1 而不是 "1"）。
      const isLiteral = /^(true|false|null)$/.test(tok) || /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(tok)
      out += isLiteral ? tok : `"${tok.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    }
    i = j
    continue
  }
  return out
}

/**
 * 删掉"**根对象提前闭合**"的那个多余 `}`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（真实事故，2026-09-26 22:36 生产环境）
 * ══════════════════════════════════════════════════════════════════════════
 * 第一次真机跑到自动抽取时，日志是这么一行：
 *
 *     [extract] 抽取未成功（已忽略）：抽取输出解析不出 JSON
 *
 * 从 DSH 落盘的抽取会话里取回原文，看到模型是这么写的（**上下两个 `}` 都是多的**）：
 *
 *     {"title":"…","trigger":{…},"steps":["…","…"]},"pitfalls":[…]},"verify":"…"}
 *                                                    ↑              ↑
 *                                     第一个把根对象**提前关掉**，后面还接着
 *                                     `,"pitfalls":…`；第二个在 pitfalls 之后再关一次。
 *                                     于是整份输出对 `JSON.parse` 来说是
 *                                     "根对象后面还有杂字"，直接判死。
 *
 * 这不是模型"写得不合法所以活该" —— R4 的全部意义就是**把不可靠的输出变成可靠对象**
 * （见文件头）。而且这个形状**有唯一解**：在根对象内部（`depth === 1`）出现一个 `}`，
 * 它后面（跳过空白）还有 `,` 或新的键 —— 合法 JSON 里这种形状**不可能存在**
 * （根对象闭合之后只允许空白）。所以那一个 `}` 一定是多余的，删掉它就是**唯一**的修法，
 * 不涉及任何猜测；连多几个都能逐个删掉（上面这份真实输出要删**两个**）。
 *
 * ⚠️ 边界（为什么不会误删）：
 *   · 只在 `depth === 1` 时动手 —— 根数组 `[{…}]` 里的 `}` 处于 depth 2，不受影响；
 *   · 只在后面还真有 `,` / `"` 时动手 —— 末尾那个合法的 `}` 后面什么都没有，保留；
 *   · 字符串感知（`inStr`/`esc`）—— 值里写 `"}"` 不会被当成结构符。
 *
 * @param {string} text
 * @returns {string}
 */
export function dropPrematureRootClose(text) {
  const src = String(text ?? '')
  let out = ''
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === '{' || c === '[') {
      depth += 1
      out += c
      continue
    }
    if (c === '}' || c === ']') {
      if (c === '}' && depth === 1) {
        let k = i + 1
        while (k < src.length && /\s/.test(src[k])) k += 1
        // 后面还有内容 → 这个 `}` 是提前闭合，丢掉（**不改变 depth**）
        if (src[k] === ',' || src[k] === '"') continue
      }
      depth = Math.max(0, depth - 1)
      out += c
      continue
    }
    out += c
  }
  return out
}

/**
 * 抠出**第一个括号配平**的 `{…}` / `[…]`（字符串感知）。
 *
 * 为什么不能再用 `lastIndexOf('}')`（**上一版就是这么写的，这里修的是它**）：
 * 那种"从头取到最后一个 `}`"的切法在模型**末尾多说了话**时会连杂字一起切进来，
 * 于是一份本来完整的 JSON 会因为尾部一句"希望有帮助"而解析失败；
 * 而在"提前闭合"那种畸形里，它又会把两份内容焊在一起。
 * 配平扫描则**只取结构上确实闭合的那一段**，多说的部分自然被排除。
 *
 * 没配平（模型写一半就断了）→ 返回 `null`：**宁可失败，也不要交出一份被截断的配方**
 * （截断的配方会变成一条错误的长期记忆，比没有配方更糟）。
 *
 * @param {string} text
 * @returns {string|null}
 */
export function firstBalancedSpan(text) {
  const src = String(text ?? '')
  const start = src.search(/[[{]/)
  if (start < 0) return null
  const stack = []
  let inStr = false
  let esc = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === '{' || c === '[') {
      stack.push(c)
      continue
    }
    if (c === '}' || c === ']') {
      const open = stack.pop()
      if (!open) return null
      if ((open === '{') !== (c === '}')) return null // 括号错配（`{…]` 这种）
      if (stack.length === 0) return src.slice(start, i + 1)
    }
  }
  return null // 没闭合完
}

/**
 * 解析"裸词 JSON"：键与字符串值都可以不带引号。
 *
 * **先试原生 `JSON.parse`**，只有它失败才走修复 ——
 * 合法的 JSON 一律原样解析，不冒被修复器改坏的风险。
 *
 * 修复链条（每一步都为真实遇到过的形状负责，见各自注释）：
 *   ① `dropPrematureRootClose` 删掉根对象提前闭合的那个 `}`（真机事故）
 *   ② `firstBalancedSpan` 只取配平的那一段（尾部多话/畸形拼接）
 *   ③ `quoteBareTokens` 给裸键裸值补引号（另一个真机事故）
 *
 * @param {string} raw
 * @returns {any|null} 失败返回 null（与 `JSON.parse` 抛错区分开：调用方要的是"能拿到对象吗"）
 */
export function parseLooseJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    /* 落到修复 */
  }
  // 只在"第一个结构符之后"做修复：前面可能有模型说的客套话
  const start = text.search(/[[{]/)
  if (start < 0) return null
  const span = firstBalancedSpan(dropPrematureRootClose(text.slice(start)))
  if (!span) return null
  try {
    return JSON.parse(quoteBareTokens(span))
  } catch {
    return null
  }
}

/** 从模型输出里抠出第一个 JSON 对象（容忍前后有杂字）。 */
export function extractJsonObject(raw) {
  return parseLooseJson(raw)
}

// ══════════════════════════════════════════════════════════════════════════
// 抽取提示词
// ══════════════════════════════════════════════════════════════════════════

/**
 * 把任务台账 + 操作流水压成一段"做过的事"。
 *
 * 为什么两样都要：台账有目标（用户到底要什么），流水有细节（试过什么、
 * 什么失败了）。只给其中一样，抽出来的配方都会缺一块。
 */
export function summarizeForPrompt({ task = null, ops = [] } = {}) {
  const lines = []
  if (task?.goal) lines.push(`用户的要求：${String(task.goal).slice(0, 120)}`)
  const steps = Array.isArray(task?.steps) ? task.steps : []
  // 台账的步骤已经是提炼过的人话；不够就用 oplog 的工具调用兜底
  if (steps.length > 0) {
    for (const s of steps.slice(-MAX_OPS_FOR_PROMPT)) {
      const mark = s.outcome === 'ok' ? '成功' : s.outcome === 'failed' ? '失败' : s.outcome === 'blocked' ? '被权限拒绝' : '结果未知'
      lines.push(`- ${s.action} → ${mark}${s.result ? `：${String(s.result).slice(0, 60)}` : ''}`)
    }
  } else {
    for (const op of ops.filter((o) => o.type === 'tool/call').slice(-MAX_OPS_FOR_PROMPT)) {
      lines.push(`- 调用了 ${op.name}`)
    }
  }
  return lines.join('\n')
}

/**
 * 抽取提示词。
 *
 * ⚠️ 里面那句"**不值得沉淀就输出 skip**"很重要：没有它，模型会给每一次
 *    闲聊都编一条配方，配方库很快就被垃圾灌满 —— 而注入是按匹配来的，
 *    垃圾配方会挤掉真配方。这是"宁少勿多"的落点。
 */
export function buildExtractPrompt({ task = null, ops = [], kind = 'group' } = {}) {
  const who = kind === 'group' ? '群里' : '私聊里'
  return [
    `你在帮一个 QQ 机器人回顾它刚在${who}做完的一件事，判断**这件事的做法值不值得沉淀成"以后同类任务可以直接套用"的经验**。`,
    '',
    '只输出一个 JSON 对象。格式：',
    '{"title":"这件事叫什么（≤20字）","trigger":{"keywords":["用户会怎么说出这类需求","再给两种说法"],"intent":"这类需求的意图"},"steps":["做法1","做法2","做法3"],"pitfalls":["踩过的坑或不该做的事"],"verify":"怎么判断做成了"}',
    '',
    '要求：',
    '- `steps` 要写**可复用的做法**，不是流水账（不要写"我调用了 read"，要写"先列目录再挑着读"）',
    '- `pitfalls` 写**真的踩到的坑**（尤其被权限拒绝、走不通的路）',
    '- `keywords` 写**用户会怎么说出这类需求**的说法，不是工具名',
    '- **如果这件事不值得沉淀**（一次性的闲聊、没有可复用的做法、只是问候），',
    '  就只输出 {"skip":true}',
    '',
    '=== 这件事的经过 ===',
    summarizeForPrompt({ task, ops }) || '（没有记录到具体操作）',
  ].join('\n')
}

// ══════════════════════════════════════════════════════════════════════════
// 调用 headless
// ══════════════════════════════════════════════════════════════════════════

/**
 * 起一个一次性 DSH 进程跑抽取。
 *
 * ⚠️ 两个前提（由调用方保证）：
 *   ① `cliPath` 指向 dsh 的 `lib/bin.js`
 *   ② 这台机器上 `headless` profile 可用（`dsh --profile headless "..."`）
 *
 * ⚠️ **只收 stdout**：实测 headless 把 reasoning 写到 stderr，
 *    混进来会把思考过程当成答案（早期用 `2>&1` 抓到过）。
 *
 * @param {object} opts
 * @param {string} opts.cliPath
 * @param {string} opts.prompt
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.cwd]
 * @param {string} [opts.nodePath]
 * @param {Function} [opts.log]
 * @param {string} [opts.label]  只影响报错文案（0.2.3）
 * @param {AbortSignal} [opts.signal] 取消（0.2.3）
 * @returns {Promise<{ok: boolean, text?: string, why?: string, ms?: number, aborted?: boolean}>}
 *
 * ── 0.2.3：加了 `label` 与 `signal`（唤醒判定器要用同一个函数）──────────────
 * 唤醒判定器（`src/wake-judge.mjs`）是**第二个**需要"一次额外模型调用"的功能，
 * 它**复用本函数**是刻意的：spawn 只有一份，key 处理/超时/沙箱/windowsHide
 * 才不会各长一套。为此补两个参数：
 *   · `label`：报错文案原来是硬编码的"抽取"，判定器里会变成误导（"抽取超时"）；
 *   · `signal`：**能真的取消**。唤醒闸门的硬纪律之一是"新消息到来时必须能取消旧判定"，
 *     而这个子进程是我们自己起的，所以可以 `kill()` —— 这一点比"race 一下就返回"
 *     强得多：后者会让被取消的那次调用照样把 token 烧完。
 * 默认值不变 ⇒ 抽取那条链路的行为一个字都没改。
 */
export function runHeadless({
  cliPath,
  prompt,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd,
  nodePath,
  log = () => {},
  label = '抽取',
  signal,
}) {
  return new Promise((resolve) => {
    const started = Date.now()
    if (signal?.aborted) {
      resolve({ ok: false, why: `${label}在开始前已被取消`, ms: 0, aborted: true })
      return
    }
    if (!cliPath || !existsSync(cliPath)) {
      resolve({ ok: false, why: `找不到 dsh CLI：${cliPath ?? '(空)'}` })
      return
    }
    const bin = nodePath || process.execPath
    let child = null
    // ★ 取消 = 真的杀掉子进程（能省掉这一轮 token），而不是仅仅不再等它
    const onAbort = () => {
      try {
        child?.kill()
      } catch {
        /* 已经退出：kill 抛错无所谓 */
      }
    }
    try {
      signal?.addEventListener('abort', onAbort, { once: true })
      child = execFile(
        bin,
        [cliPath, '--profile', 'headless', String(prompt)],
        { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          signal?.removeEventListener('abort', onAbort)
          const ms = Date.now() - started
          const text = String(stdout ?? '').trim()
          if (error) {
            // 超时/取消/非零退出：**如实报**，但不抛（增强路径）
            const why = signal?.aborted
              ? `${label}被取消`
              : error.killed
                ? `${label}超时（${timeoutMs}ms）`
                : `${label}进程失败：${String(error.message).slice(0, 120)}${stderr ? `｜stderr: ${String(stderr).slice(0, 160)}` : ''}`
            resolve({ ok: false, why, ms, text, aborted: Boolean(signal?.aborted) })
            return
          }
          if (!text) {
            resolve({ ok: false, why: `${label}没有输出（stdout 为空）`, ms })
            return
          }
          resolve({ ok: true, text, ms })
        },
      )
    } catch (error) {
      signal?.removeEventListener('abort', onAbort)
      resolve({ ok: false, why: `起不了${label}进程：${error?.message ?? error}` })
      return
    }
    child?.on?.('error', (e) => log(`[extract] 子进程错误：${e?.message ?? e}`))
  })
}

/**
 * 完整抽取：跑 headless → 宽松解析 → 归一化。
 *
 * ⚠️ **任何一步失败都只返回 `{ok:false, why}`，绝不抛** ——
 *    这是"每 5 轮顺带做一次"的增强路径，坏了也绝不能让聊天陪葬
 *    （与 memory-stats / oplog / tasks 同一条纪律）。
 *
 * @param {object} opts
 * @param {object} [opts.runner] 可注入的 runner（测试用桩；默认 `runHeadless`）
 * @returns {Promise<{ok: boolean, why?: string, skipped?: boolean, recipe?: object, raw?: string, ms?: number}>}
 */
export async function extractRecipe({ cliPath, task, ops, kind, timeoutMs, cwd, nodePath, runner = runHeadless, log = () => {} } = {}) {
  const prompt = buildExtractPrompt({ task, ops, kind })
  try {
    const r = await runner({ cliPath, prompt, timeoutMs, cwd, nodePath, log })
    if (!r.ok) return { ok: false, why: r.why, ms: r.ms }
    const parsed = parseLooseJson(r.text)
    if (!parsed) return { ok: false, why: '抽取输出解析不出 JSON', raw: r.text, ms: r.ms }
    if (parsed.skip === true) return { ok: true, skipped: true, raw: r.text, ms: r.ms }
    return { ok: true, recipe: parsed, raw: r.text, ms: r.ms }
  } catch (error) {
    return { ok: false, why: `抽取异常：${error?.message ?? error}` }
  }
}

/** 读一个 fixture（测试用；路径相对包根）。 */
export function readFixture(pkgRoot, rel) {
  try {
    return readFileSync(`${pkgRoot}/${rel}`, 'utf8')
  } catch {
    return null
  }
}
