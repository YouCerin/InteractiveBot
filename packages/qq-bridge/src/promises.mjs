/**
 * **承诺通道**：把"答应过的事"确定性地记下来（用户要求：作出承诺需要记录）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这是独立的一条通道（而不是交给模型/标记档）
 * ══════════════════════════════════════════════════════════════════════════
 * 「承诺」是长期记忆里**代价最高**的一类：
 *   · 机器人自己许的诺（"我明天帮你查"）—— 忘了就是**说话不算数**，
 *     而且用户会明确感觉到"你上次答应我的"；
 *   · 对方许的诺（"你等我，我周四给你看结果"）—— 忘了就会重复追问、
 *     或者在对方兑现时显得莫名其妙。
 * 而本项目已两次实测：**靠模型自觉写标记的漏报率接近 100%**。
 * 所以它和"记住 X"、情绪倾注一样，由桥接本地判定、命中即必然落盘。
 *
 * ── 双向（两边都记），但落点不同 ──────────────────────────────────────────
 *   `from: 'bot'`  机器人自己许的诺  → 落**会话层**（它在这个会话里答应的事）
 *   `from: 'user'` 对方许的诺        → 落**会话层**（群聊层 / 私聊里就是那个人）
 * ⚠️ 机器人的那条只在**这一轮真的会发出去**时才记（`bridge` 传 `sent`）：
 *    被更新的消息作废的那一轮，用户根本没看到那句话，记成"我答应过"就是**假记忆**。
 *
 * ── 判据保守（宁可漏，不可误报）──────────────────────────────────────────
 * 只认**明确的承诺句式**：承诺词 + 一个**未来指向**（"明天/等下/以后/回头/我这就…"）
 * 或明确的承诺动词（"包在我身上/交给我/我保证/我答应/我记下了"）。
 * 反例（都**不**认）：
 *   · "我会觉得…"（`会` 后面不是动作）—— 用"承诺词后必须紧跟动作/时间"收紧；
 *   · "如果以后有空"（假设句）—— 含"如果/要是/假如"的一律不认；
 *   · "他说他会来"（转述第三方的承诺）—— 含第三方主语的不认（与情绪通道同一条纪律）。
 */

/** 承诺词（第一人称 + 未来动作）。 */
const PLEDGE_RE = /(?:我|咱)(?:会|一定|保证|答应|尽量|尽快|回头|等下|待会|待会儿|明天|后天|今晚|马上|这就)/

/** 更硬的承诺短语：本身就是承诺，**后面不需要再有内容**（"包在我身上"）。 */
const PLEDGE_HARD_RE = /(包在我身上|交给我|一言为定|说话算数|我保证|我答应你|我负责)/

/** 时间承诺：`我` + 时间词 + **动作动词**（三者齐了才算，防"我周三没空"这种误报）。 */
const TIME_RE = /(回头|待会|待会儿|明天|后天|今晚|马上|下周|下个月|月底|周[一二三四五六日天]|星期[一二三四五六日天])/
const ACTION_RE = /(给你|帮你|帮你|帮您|发|寄|做|查|问|看|弄|写|改|带|买|请|告诉|回复|安排|处理|搞定|弄好|出来|回来|过来|上线|更新|补|整理|对一下|确认)/

/**
 * 心理动词：`我会觉得…` 不是承诺。
 * ★ 这条是压测抓出来的（"我会觉得这样不好"原本被记成了承诺）。
 */
const MENTAL_AFTER_RE = /^(?:觉得|认为|以为|希望|担心|猜|知道|理解|明白|喜欢|讨厌|介意|想(?:要|说)?)/

/** 假设/条件句：含这些一律不认（"如果以后有空我帮你"不是承诺）。 */
const HYPOTHETICAL_RE = /(如果|要是|假如|倘若|万一|有空(?:的话)?|说不定|也许|大概|可能)/

/** 转述第三方：含这些一律不认（"他说他会来"）。 */
const THIRD_PARTY_RE = /(我(?:的)?(?:朋友|同学|同事|室友|哥|姐|弟|妹|对象|老婆|老公|领导|老板|亲戚)|(?:他|她|他们|她们)(?:说|讲|答应|会|要))/

/** 承诺内容的最大长度（记忆条目上限 300，这里更紧：承诺本来就该是一句话）。 */
export const PROMISE_MAX_CHARS = 120

/**
 * 从一句话里判定承诺。
 *
 * @param {{text?: string, from?: 'bot'|'user'}} opts
 * @returns {{hit: boolean, from: string, text?: string, why?: string}}
 */
export function detectPromise({ text, from = 'user' } = {}) {
  const t = String(text ?? '')
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return { hit: false, from, why: '空文本' }

  // 按句号/换行切开，**逐句**判（一句里既有假设又有承诺时，别让假设句把承诺句带走）
  for (const raw of t.split(/[。！？\n；;]/)) {
    const s = raw.trim()
    if (!s || s.length > 200) continue
    if (HYPOTHETICAL_RE.test(s)) continue
    if (THIRD_PARTY_RE.test(s)) continue

    // ① 硬承诺短语：本身就是承诺，不要求后面还有内容
    const hard = PLEDGE_HARD_RE.exec(s)
    if (hard) {
      const content = s.length > PROMISE_MAX_CHARS ? `${s.slice(0, PROMISE_MAX_CHARS)}…` : s
      return { hit: true, from, text: content, why: `命中明确承诺「${hard[0]}」` }
    }

    // ② 承诺词 + 动作（`我会…`）——后面必须紧跟实质内容，且不能是心理动词
    const soft = PLEDGE_RE.exec(s)
    if (soft) {
      const rest = s.slice(soft.index + soft[0].length).trim()
      if (rest.length >= 2 && !MENTAL_AFTER_RE.test(rest)) {
        const content = s.length > PROMISE_MAX_CHARS ? `${s.slice(0, PROMISE_MAX_CHARS)}…` : s
        return { hit: true, from, text: content, why: `命中承诺句式「${soft[0]}」` }
      }
    }

    // ③ 时间承诺：`我` + 时间词 + 动作动词（三者齐了才算 —— 防"我周三没空"）
    const time = TIME_RE.exec(s)
    if (time && /(?:我|咱)/.test(s) && ACTION_RE.test(s)) {
      const content = s.length > PROMISE_MAX_CHARS ? `${s.slice(0, PROMISE_MAX_CHARS)}…` : s
      return { hit: true, from, text: content, why: `命中时间承诺「${time[0]}」+ 动作` }
    }
  }
  return { hit: false, from, why: '没有承诺句式' }
}

/**
 * 承诺条目怎么写（**带来源**，因为它将来会被读回来当"我答应过什么"用）。
 *
 * @param {{from: 'bot'|'user', text: string}} opts
 * @returns {string} 形如「（我许的诺）我明天帮你查那个仓库」/「（他许的诺）他周四给你看结果」
 */
export function promiseEntryText({ from, text } = {}) {
  // ★ 先洗掉 @提及：QQ 里的 `@小鲸鱼` 是**平台标记**，不是承诺内容
  //   （真机实测条目长这样：「（对方许的诺）@小鲸鱼 我周四给你看结果」——
  //   被 @ 的是机器人自己，留在档案里只会让将来的自己读得莫名其妙）。
  const body = String(text ?? '')
    .replace(/@[^\s@]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!body) return ''
  const clipped = body.length > PROMISE_MAX_CHARS ? `${body.slice(0, PROMISE_MAX_CHARS)}…` : body
  return from === 'bot' ? `（我许的诺）${clipped}` : `（对方许的诺）${clipped}`
}
