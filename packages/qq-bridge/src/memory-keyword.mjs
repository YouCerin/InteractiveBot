/**
 * 关键词确定性写入：用户说「记住 X」→ **不依赖模型**，必然落盘。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这一层（这是整个 0.2.1 记忆专项里最贵的一条教训）
 * ══════════════════════════════════════════════════════════════════════════
 * 现在的写入通道**只有一条**：模型在回复里自愿写 `<<<MEMORY fact …>>>`。
 * 而实测证明"靠模型自觉"的漏报率极高 ——
 *   · 参考项目 `D:\QQagent_DeepSeek` 本机 58 次调用里，它一次都没主动记；
 *   · 我们这里几十轮真实运行，`--memory --stats` 里 `proposed` 长期是 0 或 1。
 * 后果是：用户**明确说了**"记住这个"，机器人也回了"好的记住了"，
 * 而磁盘上什么都没有 —— 这是本项目最不能接受的那种失败：
 * **失败了却让用户以为成功了**（`AGENT.md` 第 6 条）。
 *
 * 所以「记住 X」这一类**明确的指令**不能走模型，必须在桥接里本地判定 + 直接落盘：
 *   · **零额外模型调用**（N9）；
 *   · **不看本轮模型表现** —— 就算这一轮超时了，用户那句话仍然是完整的，
 *     照样要记下（这一点与"模型提议的记忆"正好相反，见 `bridge.mjs` 的 `#settleMemory`）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 边界（写清楚，免得以后有人以为它无所不能）
 * ══════════════════════════════════════════════════════════════════════════
 * · 它只处理**明确的祈使句**（"记住…"）。委婉的说法（"这个挺重要的"）它认不出来 ——
 *   那部分靠"回合后抽取"（M1' 第 2 项，尚未做）。
 * · 它**只写 `fact` 档**（本人/本群的事实）。**绝不写 `directive`** ——
 *   行为指令会跨群生效，那条路的判据是"管理员 + 私聊"，不能因为一句话就放宽
 *   （见 `memory-store.mjs` 的 `applyMemoryItems`）。
 * · 抽出来的内容**照旧过 `screenEntry`**：隐私、身份、越权类内容一样会被拦，
 *   拦了会写回执如实告诉对方"没记上"。**确定性 ≠ 绕过闸门**。
 */

/** 内容长度上限（`screenEntry` 那边还有一道 300 字的上限，这里更紧一点）。 */
export const KEYWORD_MAX_CHARS = 200

/**
 * 触发词表（**祈使形态**）。
 *
 * ⚠️ 刻意**不含**「记得」「记住吗」这类：
 *   · "你还记得吗" 是**问句**，不是要求（问句在下面被单独排除）；
 *   · "我记得你说过" 是**说话人自己**在回忆，更不是要求。
 *   实测里这两种写法在群里比"记住 X"更常见，误判会把闲聊变成记忆污染。
 */
const TRIGGERS = [
  '帮我记住',
  '记住',
  '记一下',
  '记下来',
  '记下',
  '别忘了',
  '别忘记',
  '以后都',
  '以后一直',
  '从今以后',
]

/** 问句（"记住了吗""你还记得吗""记住了没"）——不是要求。 */
const QUESTION_TAIL_RE = /(吗|呢|么|嘛|没|没有)\s*[?？]?\s*$/

/** 说话人自己记住了（"我记住了""我都记下了"）——主语是对方，不是要求机器人记。 */
const SELF_SUBJECT_RE = /我\s*(?:都\s*)?(?:会\s*)?(?:记住|记下|记牢|记得)\s*了/

/** 前后要剥掉的标点与语气词（**只剥标点与"哈吧啊哦呀嘛嗯"**）。 */
const LEAD_TRIM_RE = /^[\s:：,，。.、;；!！?？~～\-—]+/
const TAIL_TRIM_RE = /[\s:：,，。.、;；!！~～\-—]+$/
const TAIL_PARTICLE_RE = /[哈吧啊哦呀嘛嗯]+$/

/**
 * 触发词后面紧跟的语气词 + 标点（`记住啊，我搬到上海了`）。
 *
 * ⚠️ **必须要求语气词后面还有标点或空白**才剥 —— 否则
 * `记住阿姨的生日是 3 月 2 号` 会被剥成 `姨的生日…`，那是把内容吃掉了。
 * （这条是测试抓出来的：第一版只剥尾部语气词，于是 `记住啊，…` 抽出来是 `啊，我搬到上海了`。）
 */
const LEAD_PARTICLE_RE = /^(?:哈|吧|啊|哦|呀|嘛|嗯|诶|唉|哎)[\s:：,，。.、!！~～]+/

/** 抽出来只是这些 → 等于没说内容。 */
const EMPTY_ENTRIES = new Set(['这样', '那样', '这个', '那个', '一下', '下来', '它', '这件事', '这事'])

/**
 * 判断一句话是不是「记住 X」这类**明确的写入要求**，并把 X 抽出来。
 *
 * 支持两种语序（都实测出现过）：
 *   · 内容在后：`记住我喜欢喝冰美式` / `帮我记住：服务器是 Forge 端`  → 取触发词之后
 *   · 内容在前：`我的服务器是 Forge 端，记住啊`                        → 取触发词之前
 *
 * @param {{text?: string}} [opts] `text` = 本轮用户的**原文**
 * @returns {{hit: boolean, entry?: string, trigger?: string, why?: string}}
 *   `hit:true` 且 `entry` 为空串 = 说了"记住"但没说内容（调用方不该写，但该如实回一句）
 */
export function parseRememberRequest({ text } = {}) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return { hit: false }

  // ── 先排除两类"看起来像、其实不是"的写法 ──────────────────────────────
  if (QUESTION_TAIL_RE.test(raw)) return { hit: false, why: '问句' }
  if (SELF_SUBJECT_RE.test(raw)) return { hit: false, why: '主语是说话人自己' }

  // ── 找**最靠前**的触发词（"帮我记住"比"记住"更具体，但位置判断更可靠）──
  let at = -1
  let trigger = ''
  for (const t of TRIGGERS) {
    const i = raw.indexOf(t)
    if (i < 0) continue
    if (at < 0 || i < at || (i === at && t.length > trigger.length)) {
      at = i
      trigger = t
    }
  }
  if (at < 0) return { hit: false }

  // 触发词前面紧跟"我" → 是说话人在说自己（"我记住…"），不是要求
  if (/我\s*$/.test(raw.slice(0, at))) return { hit: false, why: '主语是说话人自己' }

  const after = raw
    .slice(at + trigger.length)
    .replace(LEAD_TRIM_RE, '')
    .replace(LEAD_PARTICLE_RE, '') // `记住啊，…` → 剥掉"啊，"
    .replace(LEAD_TRIM_RE, '')
    .replace(TAIL_TRIM_RE, '')
    .replace(TAIL_PARTICLE_RE, '')
    .trim()
  const before = raw
    .slice(0, at)
    .replace(TAIL_TRIM_RE, '')
    .replace(LEAD_TRIM_RE, '')
    .trim()

  // 内容在后的写法优先；只有它为空时才看前面（"X，记住"）
  const entry = (after || before).slice(0, KEYWORD_MAX_CHARS).trim()

  if (!entry || entry.length < 2 || EMPTY_ENTRIES.has(entry)) {
    return { hit: true, entry: '', trigger, why: '只说了"记住"，但没说清要记什么' }
  }
  return { hit: true, entry, trigger }
}
