/**
 * 「先应一声」：回合跑得久了，先发一句垫着，别让人对着静默以为机器人坏了。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要按**情况**分四类，而不是一句通用的
 * ══════════════════════════════════════════════════════════════════════════
 * 一句万能的"稍等"很安全，但它是**谎话的温床**：使用者会以为机器人在搜，
 * 而它可能只是在读本地文件。所以话术要跟**实际正在发生的事**对上：
 *
 *   thinking  长时间思考（没调工具）
 *   searching 联网搜索（调了 web_search / web_fetch 之类）
 *   tooling   调用其他工具（跑命令、读文件、调 QQ 工具）
 *   blocked   权限受阻（有审批被拒 / 越界）
 *
 * `blocked` 这一类尤其重要：它以前只会发一句"这次处理超时了"或者干脆静默，
 * 而真实情况是"它想做的动作被权限挡了"。说清这件事，使用者才知道
 * 该去改配置还是换个说法。
 *
 * ── 素材来源 ──────────────────────────────────────────────────────────
 * 默认话术取自用户给的 `deal.txt`（按"思考时/搜索时/调用工具时/无法执行时"
 * 四组整理）。全部**可编辑**：配置里给了自定义列表就用自定义的。
 *
 * ── 「同一句不要短时间内重复」怎么实现 ────────────────────────────────────
 * 需求是"同一文本不能在短时间内多次出现"。两种朴素做法都不行：
 *   · 纯随机 → 会连着抽到同一句（看起来就是模板）
 *   · 纯轮换 → 又是固定顺序（第三句永远是第三句）
 *
 * 所以这里是**"带冷却的随机"**：
 *   ① 候选池里先**剔除**最近用过的若干条（冷却窗口内不许再用）
 *   ② 在剩下的里面随机
 *   ③ 如果所有候选都在冷却期内（话术很少时会这样），退化成
 *      "选**最久没用过**的那条" —— 保证不会连续重复
 *
 * 冷却窗口同时用**时间**和**条数**衡量：`≥ cooldownMs` 或
 * `≥ keepRecent 条其它话术之后`，哪个先满足算哪个。只看时间会让
 * "话很少但很频繁"的场景退化；只看条数则会在长时间闲置后仍然记仇。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 四个类别。改这里要同步改 CONFIG-UI.md 与 PROJECT.json。 */
export const INTERIM_KINDS = ['thinking', 'searching', 'tooling', 'blocked']

/**
 * 某一轮该算哪一类。**判定顺序就是优先级**。
 *
 * 顺序理由：`blocked` 最具体（我们知道它被挡住了），所以排最前；
 * 其次是 `searching`（联网是"可对外说"的动作）；再次 `tooling`；
 * 都没调才叫 `thinking`。
 */
export function classifyInterim(collector) {
  const tools = (collector?.toolCalls ?? []).map((t) => String(t?.name ?? ''))
  const isWeb = (n) => /web|search|fetch|browse/i.test(n)
  const blocked = (collector?.deniedApprovals ?? 0) > 0
  if (blocked) return 'blocked'
  if (tools.some(isWeb)) return 'searching'
  if (tools.length > 0) return 'tooling'
  return 'thinking'
}

/**
 * 创建一个"先应一声"的挑选器。
 *
 * @param {object} opts
 * @param {object} [opts.messages]       覆盖默认话术，形如 `{ thinking: [...], ... }`
 * @param {string} [opts.historyFile]    去重历史落盘位置（不传则只记内存）
 * @param {number} [opts.cooldownMs]     冷却时间（默认 60 秒）
 * @param {number} [opts.keepRecent]     冷却条数（默认 5）
 * @param {() => number} [opts.now]
 */
export function createInterimPicker({
  messages = {},
  historyFile = null,
  cooldownMs = 60_000,
  keepRecent = 5,
  now = () => Date.now(),
  rng = Math.random,
} = {}) {  /** 每类各自的历史：`[{ text, at }]`，新的在后。 */
  const history = loadHistory(historyFile)

  function poolOf(kind) {
    // ⚠️ 兼容两代键名，别把旧配置当"没配"。
    //
    // 第一版只有三个键 `web` / `working` / `thinking`，重构后变成
    // `thinking` / `searching` / `tooling` / `blocked`。
    // 如果只认新键，**旧配置里的三组话术会被静默忽略**（退回默认），
    // 而使用者完全看不出来 —— 实测就踩到了：配置里明明写了五组自定义话术，
    // 却一句都没生效。
    //
    // 这里接受旧键作为别名，并在找到别名时把它当成自定义（不让它静默失效）。
    const ALIASES = { searching: 'web', tooling: 'working' }
    const custom = messages?.[kind] ?? (ALIASES[kind] ? messages?.[ALIASES[kind]] : undefined)
    if (Array.isArray(custom) && custom.filter((x) => String(x ?? '').trim()).length > 0) {
      return custom.map((x) => String(x).trim()).filter(Boolean)
    }
    return DEFAULT_INTERIM[kind] ?? []
  }

  /**
   * 挑一句话。返回空串表示"这次不发"。
   *
   * @param {object} collector 回合收集器（用来判是哪一类）
   * @param {object} [opts]
   * @param {() => number} [opts.rng] ★ 覆盖随机源（**并行生成**那条路上要用：
   *   池子那句必须在**挂定时器之前**就定下来，否则回调里现抽会让"抽签"跑到
   *   生成结果之后 —— 见 `bridge.mjs` 里那段的说明）
   */
  function pick(collector, { rng: rngOverride } = {}) {
    const roll = typeof rngOverride === 'function' ? rngOverride : rng
    const kind = classifyInterim(collector)
    const pool = poolOf(kind)
    if (pool.length === 0) return ''

    const at = now()
    const past = history[kind] ?? []

    // ① 先剔除"冷却期内用过"的
    //
    // ★ 判定用**与**，不是或：`冷却时间到了` **且** `中间已经说过足够多别的`
    //   两个条件都满足才解禁。
    //
    //   为什么不能用"或"（这是实现里踩过的一个真错误，被单测抓到）：
    //   用或的话，`keepRecent=5` 会让第 6 次就把第一句解禁 —— 此时可能只过了
    //   几百毫秒，于是"冷却时间"形同虚设，同一句在很短时间内就重复出现了，
    //   正是需求里要避免的那种模板感。
    const usable = pool.filter((text) => {
      const lastAt = lastUsedAt(past, text)
      if (lastAt === null) return true // 从没用过 → 一定能用
      const timeOk = at - lastAt >= cooldownMs
      const countOk = past.filter((h) => h.at > lastAt).length >= keepRecent
      return timeOk && countOk
    })

    let chosen
    // ② 从**不含上一句**的池子里随机 —— 这是"绝不连续重复"的硬保证。
    //
    // ⚠️ 为什么随机要覆盖**整个池子**，而不是只覆盖"冷却后剩下的可用子集"：
    //    只从可用子集里选、并且从子集第一个开始（`rng()*0 === 0`），
    //    当可用子集只剩一个元素时就会**连续抽到同一句** —— 实测踩到过
    //    （`A|B` 两条话术时得到 `B A A A`）。而那个 bug 只在"话术少"时才出现，
    //    最容易漏测。所以这里先在整个池子里挑，再用冷却规则纠偏。
    const candidates = pool.filter((text) => text !== lastUsed(past))
    const pickFrom = (list) => list[Math.floor(roll() * list.length)] ?? list[0]

    if (usable.length > 0) {
      // 在"可用且不是上一句"的里面选；若可用集合只有上一句，则退到整个池子
      const fresh = usable.filter((text) => text !== lastUsed(past))
      chosen = pickFrom(fresh.length > 0 ? fresh : candidates.length > 0 ? candidates : usable)
    } else {
      // ③ 全都在冷却里（话术很少）→ 选**最久没用过且不是上一句**的
      const scored = (candidates.length > 0 ? candidates : pool)
        .map((text) => ({ text, lastAt: lastUsedAt(past, text) ?? -Infinity }))
        .sort((a, b) => a.lastAt - b.lastAt)
      chosen = scored[0]?.text ?? pool[0]
    }

    // 记进历史
    history[kind] = [...(history[kind] ?? []), { text: chosen, at }].slice(-50)
    saveHistory(historyFile, history)
    return chosen
  }

  return { pick, classify: classifyInterim, poolOf, history: () => history }
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★★★ 0.3.3：让 **AI 按上下文自己决定**怎么先应一声
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 使用者原话：「为先应一声新增选项，由 ai 根据唤醒时的上下文自主决定如何先应一声」。
 * 三个取舍都是当面问的（他的选择）：
 *   ① **并行生成**：回合一开始就去生成，到 `afterMs` 那一刻生成好了就发它、
 *      没好就退回**话术池**那一句 —— 既不推迟，也不会出现"先应一声比正文还晚"；
 *   ② 给它看的上下文是**当前这句 + 最近几条**；**不告诉它"正在做什么"**
 *      （并行生成时那一刻还没调工具，告诉它等于让它编"我在搜"）；
 *   ③ **允许它决定"这一轮不先应声"**（输出空）。
 *
 * ── 与话术池的分工（不是二选一，是两条腿）────────────────────────────────
 *   · 话术池：**零成本、零延迟**，但只能按"类"挑一句现成的；
 *   · AI：能接上下文（"那张图我看到了"）、能在不该垫场时闭嘴，
 *     但要一次小调用，而且**可能来不及** —— 来不及就由话术池兜底。
 *   ∴ `mode: 'ai'` 不是"把池子删了"，而是"池子退居兜底"。
 *
 * ── 一条硬纪律：**不许编"我正在做什么"**（这条写在提示词里，也在解析里兜）
 *   提示词在这个项目里有一条老规矩：「先应一声必须诚实，按实际在做的事说话」。
 *   而**并行生成**时我们根本不知道这一轮会调什么工具 ——
 *   所以这里只让它说"在弄""我想想"这种**不与具体动作绑死**的话。
 *   反过来，等它真的知道（定时器触发那一刻）再生成就要 1~5 秒，那会推迟垫场白，
 *   得不偿失（选 ① 的代价就落在这一条上，如实记在这里）。
 */

/**
 * 生成用的系统提示词（**只描述要什么**，不举示范句 —— 与四戒同一条规矩）。
 *
 * ★★★ 这一档的**真正功能是"结合上下文自主回应"**（使用者原话），不是"从话术池里挑一句"：
 *   所以这里**不写死**任何"什么情况该说什么"的规则 —— 例如"对方在纠正你时就认一句"
 *   那种规则**故意不加**（使用者明确说过「第三条不加」）。规则化会让它变成按关键词表演，
 *   而自主判断才有机会对上下文；代价是它偶尔会判错，那是提示词与上下文给的料不够，
 *   应当改上下文（见 `buildInterimAiPrompt`），而不是把答案预先写死。
 *   这里只留**两条边界**：① 只说一句、不代替正文（回答/结论留给正文）；② 允许它决定不说。
 */
export const INTERIM_AI_PROMPT = [
  '你在帮一个 QQ 机器人写**一句「先应一声」**：某个回合跑得久了，先发一句话垫着，',
  '免得对方对着静默以为机器人坏了。**正文随后就到**，这一句只是垫场。',
  '',
  '这一句要**结合下面的上下文自己判断**：对方在说什么、你上一条回过什么、这一轮该不该应一声。',
  '不是从一堆固定话术里挑一句 —— 上下文不支持时，什么都不发才是对的。',
  '',
  '要求：',
  '· **一句话**，短。像在 QQ 里随手打的 —— 不写句号、不分条、不用 Markdown、不写列表、不加引号。',
  '· **语气跟画像一致**：软、随口、偶尔自嘲，不承诺具体结果。',
  '· **绝不说你正在做某件具体的事**（"我在搜""我读到文件了"这类）—— 你不知道后面会做什么，说了就是编。',
  '· **不回答对方的问题**、不给结论、不给方案（那些留给正文）。',
  '· **只垫一句，说完就停**：不解释、不补充、不接着往下讲、不复述对方的话。',
  '· **看到你自己上一条回复时**（标着「你（自己）」的那条）：它是用来让你判断语境的，',
  '  **不要接着它往下讲**，也不要替它补充理由。',
  '· **不该垫场时就什么都不发**：对方在认真求助、情绪低落，或者这句本来就只是顺口一说 ——',
  '  这些时候静默比一句俏皮话好（**这条由你自己判断**，没有硬规则）。',
  '',
  '输出**一行 JSON**，不要代码块、不要多余文字：',
  '{"say":"要发的那一句"}  ← 正常垫场',
  '{"say":""}              ← 这一轮不先应声（**合法答案，别硬凑一句**）',
].join('\n')

/** 一次生成的字数上限（超过就**整条不用**，退回话术池 —— 见 `parseInterimAiOutput`）。 */
export const INTERIM_AI_MAX_CHARS = 40

/**
 * `INTERIM_AI_PROMPT` 里那句"输出一行 JSON"的**唯一稳定标记**。
 *
 * 用它判断"这段提示词里到底有没有带上输出契约"，从而做到**幂等**：
 * 调用方自己拼过（`composeInterimPrompt`）就不再重复拼一次。
 */
const CONTRACT_MARK = '输出**一行 JSON**'

/**
 * 把输出契约接到提示词前面（**幂等**）。
 *
 * ⚠️ 为什么这件事必须由本模块做，而不是让调用方自己 `[PROMPT, x].join()`：
 *   2026-10-18 真机自检发现 —— `INTERIM_AI_PROMPT` **导出了但从来没人用**，
 *   于是模型只收到"这段对话"，没有任何"只写一句 JSON"的要求，它就**直接回答了问题**
 *   （日志里连续 5 次 `不是 JSON 且是多行`，每次都退回话术池）。
 *   造好的提示词没送出去，和"从未写过它"是同一种缺陷，而离线断言照样全绿
 *   （假 API 无论收到什么都会回 JSON —— 那是**假绿**）。
 *   ∴ 契约跟着**解析它的人**走：谁 `JSON.parse`，谁就负责要求模型输出 JSON。
 */
export function withContract(prompt) {
  const s = String(prompt ?? '')
  return s.includes(CONTRACT_MARK) ? s : `${INTERIM_AI_PROMPT}\n\n${s}`
}

/**
 * 拼出**完整**的生成请求（契约 + 上下文）。调用方想要一步到位就用它。
 *
 * @param {Parameters<typeof buildInterimAiPrompt>[0]} input
 */
export function composeInterimPrompt(input) {
  return withContract(buildInterimAiPrompt(input))
}

/**
 * 从模型输出里解析出"发什么"。
 *
 * 返回三种之一（**这三种的区分是安全的全部**）：
 *   · `{ok:true, text:'…'}`  → 发这句
 *   · `{ok:true, text:''}`   → **它明确决定不发**（合法，调用方要尊重）
 *   · `{ok:false, why}`      → 解析不出来 / 输出不合法 ⇒ 调用方**退回话术池**
 *
 * ⚠️ 为什么"解析失败"要和"它说不发"分开：把失败当成"不发"会让**每一个坏输出
 *   都表现为"这一轮没有垫场白"**，而这正是最难查的一类静默失效
 *   （看起来像"它决定不说"，实际是坏了）。所以失败必须能回到池子那条腿。
 */
export function parseInterimAiOutput(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: false, why: '模型没有输出' }
  // 允许 ```json 围栏（模型很爱加），但**内容必须是我们要的形状**
  const body = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim()
  let obj = null
  try {
    obj = JSON.parse(body)
  } catch {
    // 退化：没写成 JSON，但整段就是一句话（很短、单行）→ 认它
    //   ⚠️ 只在**短且单行**时认。长段落不能当垫场白（那是"回答"，不是"应一声"）。
    if (body.includes('\n')) return { ok: false, why: '不是 JSON 且是多行' }
    if ([...body].length > INTERIM_AI_MAX_CHARS) return { ok: false, why: '不是 JSON 而且太长' }
    // ⚠️ 还得**像一句话**：纯标点 / 纯符号（`???`、`!!!`、`--`）不是垫场白，
    //   而是"模型没在回答我们的问题"。放行它们会让这一轮发出一串问号。
    //   判据用"含至少一个字母或汉字"，比"排除标点"稳（标点表永远列不全）。
    if (!/[\p{L}\p{Script=Han}]/u.test(body)) return { ok: false, why: '不是一句话（只有符号）' }
    return { ok: true, text: body }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, why: '输出不是对象' }
  // 「不发」的几种写法都接受（模型不一定只用空串）
  const rawSay = obj.say
  if (rawSay === null || rawSay === undefined) return { ok: true, text: '' }
  if (typeof rawSay !== 'string') return { ok: false, why: 'say 不是字符串' }
  const text = rawSay.replace(/\s+/g, ' ').trim()
  if (!text) return { ok: true, text: '' } // 明确的"不发"
  if (text.includes('http') || /[`*_#>\[\]{}]/.test(text)) return { ok: false, why: '像 Markdown/链接，不适合垫场白' }
  if ([...text].length > INTERIM_AI_MAX_CHARS) {
    // ⚠️ **不截断**：截断会把一句话拦腰砍断（"等下，我在想个办法" → "等下，我在想个"）。
    //    整条不用、退回池子，比发半句强。
    return { ok: false, why: `超过 ${INTERIM_AI_MAX_CHARS} 字` }
  }
  return { ok: true, text }
}

/**
 * 拼生成用的**用户提示词**（当前这句 + 最近几条 + 你自己上一条）。
 *
 * @param {object} opts
 * @param {{name?:string, text?:string}} opts.current 当前这条（触发这一轮的那句）
 * @param {Array<{name?:string, text?:string, self?:boolean}>} [opts.recent] 更早的几条（**旧的在前**）
 *   `self: true` = **机器人自己说的话**（镜像里 role='bot' 的那些）。私聊那条路上会带，
 *   因为"上一轮我说了什么"正是判断"对方是不是在纠正我"的唯一依据。
 * @param {string} [opts.persona] 画像里与"怎么说话"有关的一小段（可选，空则不写）
 * @param {string} [opts.lastBotReply] 你自己**上一条**回复的原文（可选）
 * @param {boolean} [opts.private] 私聊语境（决定"最近几条"那段的措辞：私聊不是"群里"）
 */
export function buildInterimAiPrompt({ current = {}, recent = [], persona = '', lastBotReply = '', private: isPrivate = false } = {}) {
  const lines = []
  if (persona) lines.push('【说话方式】', String(persona).trim(), '')
  const rows = (Array.isArray(recent) ? recent : [])
    .filter((r) => String(r?.text ?? '').trim())
    .map((r) => {
      // ★ 自己说的话必须**标出来**：不标的话模型会把它当成对方说的 ——
      //   那比"看不到自己上一句"更乱（它会以为对方刚说了那段，于是接着答）。
      const who = r?.self === true ? '你（自己）' : String(r?.name ?? '某人').trim()
      return `${who}：${String(r.text).trim()}`
    })
  if (rows.length > 0) {
    lines.push(
      isPrivate
        ? '【你们最近这几条（标「你（自己）」的是你自己说的，其余是对方）】'
        : '【你没被叫到的时候，群里刚说了这些（标「你（自己）」的是你自己说的）】',
      ...rows,
      '',
    )
  }
  const last = String(lastBotReply ?? '').trim()
  if (last) {
    lines.push(
      '【你上一条回的是（**这是你自己说的，不是对方说的**）】',
      last,
      '',
      '★ 它只用来让你判断"对方这句是不是在接/在纠正我上一条"——**不要顺着它往下讲**。',
      '',
    )
  }
  lines.push(
    '【现在有人叫你，说的是这句】',
    `${String(current?.name ?? '某人').trim()}：${String(current?.text ?? '').trim()}`,
    '',
    '按上面的上下文，决定这一轮要不要先应一声、以及说什么。',
  )
  return lines.join('\n')
}

/**
 * 造一个"AI 决定先应一声"的生成器（**懒执行 + 预算由闸门管**）。
 *
 * @param {object} opts
 * @param {(input: object, o: object) => Promise<{verdict:string, reason?:string, judged?:boolean, why?:string}>} opts.gate
 *   形如 `createModelGate(...)` 的产物（通路/超时/每小时额度都在它里面）。
 *   它的 `buildPrompt` 会收到 `{ prompt }`（我们**自己拼好整段提示词**再递给它，
 *   因为垫场白不需要按"每条消息"重算输入）。★ 递过去的那段**已经带上输出契约**
 *   （`withContract`，幂等）—— 调用方不需要、也不该再拼一次 `INTERIM_AI_PROMPT`。
 * @param {string} [opts.tag]
 * @param {(m:string)=>void} [opts.log]
 * @returns {{available: boolean, decide: (prompt: string, o?: object) => Promise<{ok:boolean, text:string, why?:string}>}}
 */
export function createInterimAi({ gate = null, tag = 'interim', log = () => {} } = {}) {
  const available = Boolean(gate)
  async function decide(prompt = '', { signal } = {}) {
    if (!gate) return { ok: false, text: '', why: 'AI 垫场白不可用' }
    try {
      // ★ 输出契约在这里统一接上（幂等）：调用方只负责"上下文那半段"，
      //   绝不会因为哪天忘了拼 `INTERIM_AI_PROMPT` 就退化成"模型直接答题"。
      const r = await gate.judge({ prompt: withContract(prompt) }, { signal })
      // ⚠️ 只有 `judged:true` 且**没有** `fallback` 的那一次输出才算"模型真的说了"。
      //   两种不算的情况必须分开对待，而且都不能当成"它决定不说话"：
      //     · `judged:false` = 压根没问模型（通路没配好 / 超预算 / 已取消）；
      //     · `fallback:true` = 问了但结论不可用（超时 / 输出认不出）——
      //       那时 `verdict` 是 `failVerdict`，**内容不是模型说的**，绝不能发出去。
      //   把这两种当成"它说不发"，会让每一次失败都表现成"这一轮没有垫场白"，
      //   而那正是最难查的静默失效（看起来像它决定不说，实际是坏了）。
      if (r?.judged === false) return { ok: false, text: '', why: r?.why || '这次没有真的问模型' }
      if (r?.fallback === true) return { ok: false, text: '', why: r?.why || '模型输出不可用' }
      const parsed = parseInterimAiOutput(r?.verdict)
      if (!parsed.ok) {
        log(`⚠️ [${tag}] 生成的垫场白看不懂（退回话术池）：${parsed.why}`)
        return { ok: false, text: '', why: parsed.why }
      }
      return { ok: true, text: parsed.text }
    } catch (error) {
      // 绝不抛：垫场白失败只该表现为"这一轮用池子那句"
      log(`⚠️ [${tag}] 生成垫场白失败（退回话术池）：${error?.message ?? error}`)
      return { ok: false, text: '', why: error?.message ?? String(error) }
    }
  }
  return { available, decide }
}

function lastUsedAt(past, text) {
  for (let i = past.length - 1; i >= 0; i--) if (past[i].text === text) return past[i].at
  return null
}

/** 上一句说过什么（用于"绝不连续重复"）。 */
function lastUsed(past) {
  return past.length > 0 ? past[past.length - 1].text : null
}

/**
 * 读历史。
 *
 * ⚠️ 任何异常都**吞掉**：历史只是"别让同一句连着出现"的辅助数据。
 * 它坏了、读不到、格式不对 —— 最多是话术可能重复一次，
 * 而**绝不能**因此让"先应一声"整个失效或者抛错影响回合。
 */
function loadHistory(file) {
  if (!file || !existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function saveHistory(file, history) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(history), 'utf8')
  } catch {
    /* 同上：历史写不进去不影响功能 */
  }
}

/**
 * 默认话术。来源：用户给的 `deal.txt`，按四类整理。
 *
 * 保留原样（包括梗），因为**这个项目的语气是刻意设计的**：
 * 客服腔本身就是机器人特征（见 persona.mjs）。擅自"润色"会把
 * 使用者挑好的语气改掉。
 */
export const DEFAULT_INTERIM = {
  thinking: [
    '在想了在想了',
    '等下，思路跟尾巴打结了',
    '正在偷吃token，你等一下',
    '嗯……这个我得想一下',
    '这个问题有点绕，给我几秒',
    'DeepSleep中，请稍等',
    '进度条卡在99%了，再等等',
    '稍等，这个要认真想一下',
    '正在寻找鱼片...',
    '我先吃口白饭，想好了喊你',
    '这个问题……唔，有点东西',
    '等下，先让我喘口气',
  ],
  searching: [
    '等下，我去翻翻',
    '正在潜水找资料',
    '去海里找找，马上回来',
    '等会，我查一下',
    '搜着呢，对面网页加载得比我还摆',
    '稍等，我核实一下',
    '派了只小虾米出去打听，等它游回来',
    '深海信号不太好，你等一下',
    '找到就回来，找不到……也回来',
    '让外包小虾米去查了',
    '我闭着眼搜的，慢点正常',
    '资料沉在深海区，潜下去要点时间',
    '稍等，正在交叉验证几个来源',
    '搜到一半被别的小鲸鱼叼走了，我去追回来',
    '别急，我借一下隔壁海豚的网',
  ],
  tooling: [
    '在摇人了，哦不，摇工具',
    '让外包去干了，我负责监工',
    '正在喊小虾米们起来干活',
    '等下，我翻翻工具箱',
    '稍等，正在调用工具',
    '让它先跑着，跑完我看看结果',
    '工具加载中，跟加载游戏一样慢',
    '派出去的token还没回来',
    '正在做性能测试（不是偷玩）',
    '正在给自己做游戏玩...',
    '稍等，正在执行',
  ],
  blocked: [
    '做不了，这个真超纲了',
    '服务器繁忙，请稍后再试（装的）',
    '啊……这个不行',
    '出错了，但我也不知道错哪了',
    '真当我是便宜货啊，这个不包',
    '试过了，失败了，原因保密',
    '这个我处理不了，超出能力范围了',
    '尾巴抽筋，请病假一分钟',
    '不要，问就是做不到',
    '这个月token配额见底了，干不了你这个',
    '小鲸鱼搁浅了，干不动了',
    '这事归群主管，不归鲸鱼管',
    '婉拒了哈',
    '这条道堵死了，再想想别的办法吧',
    '白饭都吃不上还想让我干活？',
    '提示：该鲸鱼已下班',
    '做不到，我投降，尾巴举起来了',
    '不做，就是不做，哼',
    '这个得请外援，我自己搞不定',
  ],
}
