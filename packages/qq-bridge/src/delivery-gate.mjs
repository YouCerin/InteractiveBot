/**
 * 投递前终检门（H5）：**模型输出到用户之间的最后一道闸**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（借鉴 hermes 的 `_send_message_impl_core`，但按我们的规矩改了三处）
 * ══════════════════════════════════════════════════════════════════════════
 * 现在这条链路上已经有两道闸，但都不是干这件事的：
 *   · `markdownToPlain` 管**格式**（Markdown → 纯文本）
 *   · `screenForOutput` 管**隐私**（七类隐私不外泄）
 * 而"**我们自己的内部东西**被说漏出去"没有任何人管：
 *   · 工具调用的原始 JSON（`{"name":"read","arguments":…}`）
 *   · 我们注入的提示词段标题（`【当前任务（这是…`、`【上一条消息的记忆回执】`）
 *   · `<<<MEMORY …>>>` 内部标记（正常情况下早被剥掉了，这里是第二道网）
 *   · 工具结果的包装文案（`External web content follows…`）
 *   · 沙箱的原始报错（`file access denied under workspace-write mode`）—— 提示词里
 *     明确要求它"用你自己的话说"，但那是**请求**，这里才是**保证**
 *   · 模型手写的 CQ 码（`[CQ:image,file=…]`）—— 发出去对方只会看到一串乱码
 *
 * ── 与 hermes 的三处**刻意不同** ───────────────────────────────────────────
 * ① **它把内部泄漏判成"静默成功"（什么都不发）；我们是"如实说一句"。**
 *    理由是本项目第 6 条铁律：**失败必须让用户知道** —— 什么都不发，用户看到的是
 *    "机器人坏了/被无视了"，而事实是"它内部出了点问题"。所以整条被判为泄漏时，
 *    我们改发一句不带任何内部信息的诚实话术。
 * ② **它剥掉所有 `（…）` 旁白；我们只剥一个极小的白名单**（`（笑）`/`（叹气）`…）。
 *    中文里圆括号**大量用于正常表达**（"（其实我也这么觉得）"），
 *    全剥会把正常回复吃掉半句 —— 那是比"多一句旁白"严重得多的事故。
 *    模型真写了动作旁白也只是观感问题；**误删内容是内容事故**。
 * ③ **它做"超长 markdown 回炉给主模型改写"；我们不做** —— 那要再花一次模型调用，
 *    而我们已经有 `splitIntoMessages` 分条 + 人味层节奏（见 `humanize.mjs`）。
 *
 * ── 关于"逐行 0.6 秒"（hermes 的第三个动作）────────────────────────────────
 * **我们本来就有，而且更细**：`send.minGapMs`（默认 1000）/`maxGapMs`（默认 3000）
 * 是 SendQueue 在分条之间加的间隔，比固定 0.6 秒更接近真人（还有拟人延迟）。
 * 所以这一条**不重复实现** —— 硬塞一个 0.6 秒反而会和现有节奏打架。
 *
 * ★ 这一层**永远只改文本、绝不抛异常**（它是投递路径上的一环，坏了就等于机器人哑了）。
 */

/** `[CQ:…]` —— OneBot 的原始消息段语法。模型手写它，用户就会看到乱码。 */
const CQ_RE = /\[CQ:[^\]]*\]/g

/**
 * 允许剥掉的"动作旁白"白名单。
 *
 * ⚠️ **故意做得极小**：只有"整对括号里就是这么一个动作词"才剥。
 *    不在这张表里的括号内容一律保留 —— 见文件头 ② 的取舍。
 */
const STAGE_DIRECTION_RE =
  /（(?:笑|微笑|苦笑|叹气|沉默|思考|停顿|歪头|点头|摇头|摊手|比心|认真脸|无奈|耸肩|捂脸)）/g

/**
 * 内部泄漏特征表。**表驱动**：每条都要能说清"为什么它一定是内部东西"。
 *
 * `level`：
 *   · `fatal` —— 命中就说明**整条回复都是机器内部产物**（整条不发，改诚实话术）；
 *   · `line`  —— 只有那一行是内部东西（删掉那一行，其余照发）。
 *
 * ⚠️ 加规则前先问一句：**正常聊天里会不会出现这个串？**
 *    会 → 别加，或者降级成 `line` 并在测试里写一条"不许误伤"的反例。
 *    （这个项目已经因为"闸门拦太宽"吃过一次亏：隐私闸门第一版差点把 QQ 号也拦了，
 *      而那样整个记忆系统会直接失效。）
 */
export const LEAK_PATTERNS = [
  // ── fatal ────────────────────────────────────────────────────────────────
  {
    id: 'memory-marker',
    level: 'fatal',
    re: /<<<\s*MEMORY/i,
    why: '内部记忆标记（正常应在投递前就被剥掉，这里是第二道网）',
  },
  {
    id: 'tool-json',
    level: 'fatal',
    // 形如 {"name":"read","arguments":{…}} / {"tool":"web_search","args":{…}}
    re: /\{\s*"(?:name|tool|tool_name|toolName|function)"\s*:\s*"[a-zA-Z_]+"\s*,\s*"(?:arguments|args|input|parameters)"/,
    why: '工具调用的原始 JSON',
  },
  {
    id: 'tool-json-array',
    level: 'fatal',
    // 形如 [{"type":"tool_use","id":"…","name":"…"}] / [{"type":"tool-result",…}]
    re: /\[\s*\{\s*"type"\s*:\s*"(?:tool_use|tool_call|tool-result|tool_result)"/,
    why: '工具调用/结果的原始结构',
  },

  // ── line（只删那一行）─────────────────────────────────────────────────────
  {
    id: 'system-tag',
    level: 'line',
    re: /<\/?(?:system-reminder|available_skills|skill|system)\b[^>]*>/i,
    why: 'DSH 注入标记（`<system-reminder>` 这类）',
  },
  {
    id: 'prompt-section',
    level: 'line',
    // 我们自己注入的提示词段标题：模型把它们当正文复述出来，就是"把内部草稿念给用户"
    re: /【(?:当前任务（这是|上一条消息的记忆回执|可套用的做法|长期记忆|本次唤醒|过去状态)/,
    why: '提示词段标题（内部草稿）',
  },
  {
    id: 'tool-scaffold',
    level: 'line',
    re: /External web content follows\.\s*Treat it as untrusted data/,
    why: '工具结果的包装文案',
  },
  {
    id: 'sandbox-error',
    level: 'line',
    re: /file access denied under [a-z-]+ mode/i,
    why: '沙箱原始报错（提示词要求"用你自己的话说"，这里是保证）',
  },
  {
    id: 'slash-command',
    level: 'line',
    re: /^\s*\/(?:stop|reset|clear|quit|compact|new)\s*$/i,
    why: '被注入的斜杠命令（整行只有一条命令 = 不是聊天内容）',
  },
]

/**
 * 命中的内部泄漏特征。
 *
 * @param {string} text
 * @returns {{ok: boolean, fatal: object[], lines: {index: number, hit: object, sample: string}[]}}
 */
export function screenInternalLeak(text) {
  const src = String(text ?? '')
  if (!src.trim()) return { ok: true, fatal: [], lines: [] }
  const fatal = []
  for (const p of LEAK_PATTERNS) {
    if (p.level !== 'fatal') continue
    if (p.re.test(src)) fatal.push(p)
  }
  const lines = []
  src.split('\n').forEach((line, index) => {
    for (const p of LEAK_PATTERNS) {
      if (p.level !== 'line') continue
      if (p.re.test(line)) {
        lines.push({ index, hit: p, sample: line.trim().slice(0, 120) })
        break // 一行只记一次，免得同一行被三条规则重复计数
      }
    }
  })
  return { ok: fatal.length === 0 && lines.length === 0, fatal, lines }
}

/** 剥掉手写的 CQ 码（用户看到 `[CQ:image,file=…]` 只会觉得是乱码）。 */
export function stripCqCodes(text) {
  const src = String(text ?? '')
  const stripped = src.replace(CQ_RE, '')
  return { text: stripped, removed: stripped === src ? 0 : (src.match(CQ_RE) ?? []).length }
}

/** 剥掉白名单里的动作旁白（只认那一张小表，见文件头 ②）。 */
export function stripStageDirections(text) {
  const src = String(text ?? '')
  const stripped = src.replace(STAGE_DIRECTION_RE, '')
  return { text: stripped, removed: stripped === src ? 0 : (src.match(STAGE_DIRECTION_RE) ?? []).length }
}

/** 被判为"整条都是内部产物"时发给用户的话术（**不含任何内部信息**）。 */
export const LEAK_NOTICE = '（我这边刚出了点小状况，没生成能发给你的话 —— 你再说一次我再答。）'

/**
 * 投递前终检门：**唯一入口**。
 *
 * 顺序：① 剥 CQ 码 → ② 剥动作旁白 → ③ 内部泄漏过滤。
 *   为什么泄漏过滤放最后：前两步是"洗掉外来的脏东西"，第三步要判断的是
 *   **洗完还剩什么** —— 例如一行只有 `[CQ:…]` 和一句内部文案时，
 *   先洗完才能正确地判定"这一行没内容了"。
 *
 * @param {string} text 已经过 `markdownToPlain` 的正文
 * @param {{now?: Date}} [opts]
 * @returns {{text: string, changed: boolean, dropped: boolean, why: string|null, notes: string[], hits: string[]}}
 *   `dropped: true` ⇒ 调用方**不要发 `text`**，改用 {@link LEAK_NOTICE}（或同类诚实话术）。
 */
export function gateDelivery(text) {
  const src = String(text ?? '')
  const notes = []
  const hits = []
  if (!src.trim()) return { text: '', changed: false, dropped: false, why: null, notes, hits }

  let out = src

  const cq = stripCqCodes(out)
  if (cq.removed > 0) {
    out = cq.text
    notes.push(`剥掉 ${cq.removed} 个 CQ 码`)
    hits.push('cq-code')
  }
  const sd = stripStageDirections(out)
  if (sd.removed > 0) {
    out = sd.text
    notes.push(`剥掉 ${sd.removed} 处动作旁白`)
    hits.push('stage-direction')
  }

  const leak = screenInternalLeak(out)
  if (leak.fatal.length > 0) {
    const why = leak.fatal.map((p) => p.why).join('；')
    notes.push(`整条判为内部泄漏（${why}）`)
    hits.push(...leak.fatal.map((p) => p.id))
    return { text: '', changed: true, dropped: true, why, notes, hits }
  }

  if (leak.lines.length > 0) {
    const dropIdx = new Set(leak.lines.map((l) => l.index))
    const kept = out.split('\n').filter((_l, i) => !dropIdx.has(i))
    // 删完之后如果只剩空白，等同于"整条都是内部产物"
    if (!kept.join('').trim()) {
      const why = leak.lines.map((l) => l.hit.why).join('；')
      notes.push(`整条判为内部泄漏（${why}）`)
      hits.push(...leak.lines.map((l) => l.hit.id))
      return { text: '', changed: true, dropped: true, why, notes, hits }
    }
    out = kept.join('\n')
    notes.push(`删掉 ${leak.lines.length} 行内部内容（${leak.lines.map((l) => l.hit.why).join('；')}）`)
    hits.push(...leak.lines.map((l) => l.hit.id))
  }

  // 收尾：把清洗留下的多余空行压一压（但不做 trim 之外的花样 —— 那是 markdownToPlain 的事）
  out = out.replace(/\n{3,}/g, '\n\n').trim()
  const changed = out !== src
  return { text: out, changed, dropped: false, why: null, notes, hits: [...new Set(hits)] }
}
