/**
 * 情绪倾注的**确定性识别**：判断"这句话是不是在向机器人倾倒自己的情绪"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须是确定性的（不能问模型）
 * ══════════════════════════════════════════════════════════════════════════
 * 需求原话：「对面向机器人倾注情绪时需要记录」。而本项目已有两次实测证明
 * **"靠模型自觉"这条路的漏报率接近 100%**（本机几十轮 0 次提议；参考项目
 * 58 次运行 0 次调用，见 `docs/0.2.1-memory-diagnosis.md`）。
 * 所以"必须记下来"这件事**不能挂在模型的自觉上** —— 它得由桥接本地判定，
 * 零模型调用、可离线测、命中即必然落盘（与 `memory-keyword.mjs` 同一条思路）。
 *
 * ── 只判"该不该记"，不判"他有多难过" ────────────────────────────────────
 * 这里**刻意不做情感强度打分**：
 *   · 打分不可解释，而且必然引出"要不要衰减"（设计决策 D9 禁止强度浮点）；
 *   · 群友能感知到分数就会被刷（`docs/0.2.9-per-person-memory-plan.md` §8.1）。
 * 输出只有两样**有限集合内的标签**：`state`（他处于什么状态）与
 * `need`（他希望你怎样对待他）。这两样是**可执行**的，而且都能从原话直接读出来。
 *
 * ── 两件比"能识别"更重要的事 ──────────────────────────────────────────────
 * ① **不记别人的事**（真实性的第一道）：情绪词前面紧挨着第三方主语时
 *    （「我朋友最近很累」「他难受」），说的是**别人**，落到"关于这个人"的档案里
 *    就是一条假记忆。所以有 `THIRD_PARTY_RE` + 就近窗口判定。
 * ② **宁可漏，不可误报**（真实性的第二道）：弱情绪词（累/烦/困）在日常闲聊里
 *    出现得极频繁（「这游戏好累」），单独命中**不记**；必须同时有
 *    "倾注信号"（第二人称/求助）或明确的需要表达才算。
 *    强情绪词（崩溃/想哭/撑不住/孤独）单独命中就记。
 *
 * ── 它**不做**什么（边界，免得以后有人指望它）────────────────────────────
 *   · 不做反讽/玩笑识别（「我死了哈哈哈」会被记成 low）—— 规则做不到，
 *     宁可留这条已知边界，也不假装能识别；
 *   · 不读历史（只看当前这一条消息）；
 *   · 不产生任何发给用户的内容，也不影响权限与事实判断。
 */

/**
 * 状态白名单（**封闭集合**）。
 *
 * 为什么封闭：写进档案的值会被渲染进提示词，自由文本等于给了一个
 * "往提示词里塞任意字符串"的通道（与 `contacts.mjs` 里昵称必须清洗同理）。
 */
export const AFFECT_STATES = Object.freeze(['low', 'anxious', 'angry', 'tired', 'lonely', 'excited'])

/** 希望被怎样对待（封闭集合）。`unknown` = 只看出状态、没看出需要。 */
export const AFFECT_NEEDS = Object.freeze(['listen', 'space', 'advice', 'distract', 'stay', 'unknown'])

/** 强/弱。弱情绪词必须配"倾注信号"或"需要表达"才记（防误报）。 */
export const STRENGTH = Object.freeze({ STRONG: 'strong', WEAK: 'weak' })

/**
 * 第三方主体：情绪词**附近**出现这些词 ⇒ 说的是别人，不记。
 *
 * ⚠️ 必须配"就近窗口"用（见 `nearThirdParty()`）：整句匹配会把
 * 「我朋友很累，我也好累」这种**自己也在里面**的句子整句误杀。
 */
const THIRD_PARTY_RE =
  /(我(?:的)?(?:朋友|同学|同事|室友|哥|姐|弟|妹|妈|爸|父母|对象|男朋友|女朋友|老婆|老公|领导|老板|亲戚)|他|她|他们|她们|别人|有人|那个人|某某)/

/**
 * 倾注信号：把话题**指向机器人**的词。
 *
 * 弱情绪词配它才算"向机器人倾注"（而不是在自己碎碎念或吐槽游戏）。
 */
const POUR_SIGNAL_RE =
  /(跟你说|跟你讲|跟你聊|你会不会|你会|你肯|你愿意|只有你|你别|你能|陪我|听我|我想跟你)/

/**
 * 指物的指示代词：情绪词紧跟在这些词后面 ⇒ 说的是**那件事/那个东西**，不是他的状态。
 *
 * ★ 为什么必须有它（一个会**错记**的假阳性）：
 *   「这游戏**崩溃**了」「那服务器**崩溃**了」—— `崩溃` 是强情绪词，
 *   没有这道闸就会写成"他情绪低落的时候（细节他没说）"，那是一条**假记忆**，
 *   而且会一直注入下去。同理还有「这电影**好累**人」之类。
 *   ⚠️ 但它**必须放过时间状语**：「我最近**这阵子**好累」里的"这"指的是时间，
 *      人确实累 —— 所以用否定前瞻把 `这阵子/这次/这几天/这段/这会让` 这类排掉。
 */
const NON_SELF_SUBJECT_RE = /(这个|那个|这些|那些|这|那|它|它们)(?!阵子|次|几天|段|会儿|回|阵|两年|半年)/

/**
 * 情绪词前面 `window` 个字以内有没有第三方主语。
 *
 * ★ 必须"就近"而不是"整句含"：反例「我朋友很累，我也好累」——
 *   整句含「朋友」会把**他自己**那句一起误杀。
 */
export function nearThirdParty(text, index, window = 6) {
  const from = Math.max(0, index - window)
  return THIRD_PARTY_RE.test(text.slice(from, index))
}

/** 情绪词前面 `window` 个字以内有没有**指物**的主语（见 `NON_SELF_SUBJECT_RE`）。 */
export function nearNonSelfSubject(text, index, window = 4) {
  const from = Math.max(0, index - window)
  return NON_SELF_SUBJECT_RE.test(text.slice(from, index))
}

/**
 * 否定式：情绪词前面不远处是否定词 ⇒ 说的是**没有**这回事。
 *
 * ★ 真机抓到的假阳性（2026-09-30 群聊回放）：
 *   「至少**不用**担心等会儿要干嘛这个问题」——「担心」是强情绪词，
 *   而这句话的语气恰恰是**松了口气**。记成"他焦虑的时候"就是一条反过来的假记忆。
 *   同理还有「不累」「没崩溃」「别难过」（最后那句是在**安慰对方**）。
 *
 * ⚠️ 三个细节都是被真实句子逼出来的：
 *   ① **窗口要够**：否定词与情绪词之间常夹一个字（「不**用**担心」「没**有**难过」
 *      「不**太**开心」），只往前看 1~2 个字会漏掉；
 *   ② **「忍不住」「舍不得」是否定式肯定** —— 「忍**不住**想哭」是真的想哭，
 *      所以 `不` 后面紧跟 `住/得` 时**不算**否定（否则会误杀最典型的那种倾诉）；
 *   ③ 已知边界：被否定的部分隔得较远时认不出来（「不是很难受」里 `不` 与 `难受`
 *      之间还夹着 `是很`），以及「不管多累」这类会被当成否定放过。
 *      **宁可漏，也不放大窗口** —— 窗口一大会把真倾诉误杀，那是更坏的方向。
 */
const NEGATION_RE = /(?:(?:不|别|没|无|勿|免|甭)(?![住得])[^，。！？；、]{0,2})$/

export function nearNegation(text, index, window = 3) {
  const from = Math.max(0, index - window)
  return NEGATION_RE.test(text.slice(from, index))
}

/**
 * 需要线索的**指向检查**：这些线索说的是"**向我**要什么"，所以前面出现
 * 另一个主体（机器人/他/助理…）时就不是在跟我说话。
 *
 * ★ 真机抓到的假阳性（同上）：「可以搓一个**机器人陪我聊天**（）」——
 *   「陪我聊」命中了"想有人听着"，但陪他聊的是**他准备做的那个机器人**，
 *   不是眼前这个。记成"他想有人听着"是错的。
 * ⚠️ 刻意**不含**「小鲸鱼/小鱼」：那是**机器人自己的名字**，说了就是要我陪。
 */
const NEED_ACTOR_RE = /(机器人|智能体|助理|助手|AI|bot|Bot|GPT|他|她|他们|它)/

export function nearNeedActor(text, index, window = 6) {
  const from = Math.max(0, index - window)
  return NEED_ACTOR_RE.test(text.slice(from, index))
}

/** 找出**最早出现且不是转述、不是否定、也不是说别的东西**的状态线索。 */
function pickState(text) {
  const candidates = []
  for (const cue of STATE_CUES) {
    cue.re.lastIndex = 0
    let m
    while ((m = cue.re.exec(text)) !== null) {
      candidates.push({ at: m.index, word: m[0], state: cue.state, strength: cue.strength })
      if (m.index === cue.re.lastIndex) cue.re.lastIndex += 1 // 防零宽死循环
    }
  }
  candidates.sort((a, b) => a.at - b.at)
  for (const c of candidates) {
    if (nearThirdParty(text, c.at)) continue
    if (nearNonSelfSubject(text, c.at)) continue
    if (nearNegation(text, c.at)) continue // 「不用担心」「不累」「没崩溃」
    return c
  }
  // 全被排除时，把第一条的**排除原因**带出去（供日志解释"为什么没记"）
  if (candidates.length === 0) return null
  const first = candidates[0]
  return {
    ...first,
    excluded: nearThirdParty(text, first.at)
      ? 'third-party'
      : nearNonSelfSubject(text, first.at)
        ? 'non-self-subject'
        : 'negated',
  }
}


/**
 * 状态线索。**顺序即优先级**：强线索排在弱线索之前，取"最早出现且不是转述"的那条。
 */
const STATE_CUES = [
  { re: /(抑郁|崩溃|我崩了|想哭|哭出来|撑不住|撑不下去|绝望|不想活|活着(?:好)?累|没意思)/gu, state: 'low', strength: STRENGTH.STRONG },
  { re: /(难过|难受|委屈|失落|沮丧|心痛|不开心|心情不好|情绪低落|低落|郁闷|emo)/giu, state: 'low', strength: STRENGTH.STRONG },
  { re: /(焦虑|紧张|害怕|担心|心慌|不安|压力(?:大|好大|很大|山大)|睡不着|失眠)/gu, state: 'anxious', strength: STRENGTH.STRONG },
  { re: /(生气|气死|气炸|火大|暴躁|想骂|愤怒)/gu, state: 'angry', strength: STRENGTH.STRONG },
  { re: /(孤独|孤单|没人(?:理|懂|理解|在乎)|只有我一个)/gu, state: 'lonely', strength: STRENGTH.STRONG },
  { re: /(累死|累坏|好累|太累|疲惫|心力交瘁|没力气|困死)/gu, state: 'tired', strength: STRENGTH.STRONG },
  { re: /(太好了|好开心|太开心|开心|好耶|太爽|激动|兴奋)/gu, state: 'excited', strength: STRENGTH.STRONG },
  // ── 弱线索（单字/高频，日常闲聊里到处是）──────────────────────────────
  { re: /(累|困|乏了)/gu, state: 'tired', strength: STRENGTH.WEAK },
  { re: /(烦|烦人)/gu, state: 'angry', strength: STRENGTH.WEAK },
]

/** 需要线索（顺序即优先级）。 */
const NEED_CUES = [
  { re: /(别问|想静静|静一静|别管我|让我一个人|不要问|不想说)/gu, need: 'space' },
  { re: /(听我说|听我讲|陪我说|陪我聊|想跟你说|跟你说个事|你会不会觉得|只有你)/gu, need: 'listen' },
  { re: /(怎么办|该怎么办|该怎么做|给点建议|你说我该|帮我分析|我该不该)/gu, need: 'advice' },
  { re: /(别提了|别说了|别说这个|聊点别的|换个话题|不说这个)/gu, need: 'distract' },
]

/**
 * **接纳 / 归属**信号：说的是"我希望你留在这里"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么单独一类（用户原话，2026-09-30）
 * ══════════════════════════════════════════════════════════════════════════
 * 用户点名的例句：「没事，你在这里和我们聊天，大家都很高兴，这就是完美的时间线」。
 * 这类话**既不是倾诉、也不是求助** —— 它是**对机器人的接纳**。原来的判定器对它毫无反应
 * （`高兴` 不在情绪词表里，`大家` 还是第三人称主语），而它恰恰是最该被记住的一类：
 * 它告诉机器人"你在这里是被欢迎的"，也告诉它**该继续待着**而不是缩回去。
 *
 * 判据分强弱两档（防误报）：
 *   · **强**（单独出现就算）：`完美的时间线` / `别走` / `留下来` / `你就是我们…一员`；
 *   · **弱**（必须配一个正面词）：`你在这里` / `有你在` / `和我们聊天` + `高兴|开心|喜欢|挺好|真好|欢迎|完美`。
 *     ⚠️ 弱档必须配对，否则「你在这里等我一下」这种普通句也会被当成接纳。
 */
const BOND_STRONG_RE = /(完美的时间线|别走|留下来|有你在(?:就)?(?:真)?好|你就是我们|算我们(?:群)?一员|我们(?:都)?很喜欢你)/

const BOND_WEAK_RE = /(你在这里|有你在|和我们聊|和你聊|你陪我们)/

const BOND_WARM_RE = /(高兴|开心|喜欢|挺好|真好|欢迎|完美|不介意|愿意)/

/**
 * 判定"这句话是不是在**接纳/欢迎机器人**"。
 * @returns {{hit: boolean, why?: string}}
 */
export function detectBondSignal({ text } = {}) {
  const t = normalize(text)
  if (t.length < AFFECT_MIN_CHARS) return { hit: false }
  // 否定式同样要放过（「你在这里也没人高兴」不是接纳）
  const strong = BOND_STRONG_RE.exec(t)
  if (strong && !nearNegation(t, strong.index)) return { hit: true, why: `命中接纳信号「${strong[0]}」` }
  const weak = BOND_WEAK_RE.exec(t)
  if (weak && !nearNegation(t, weak.index)) {
    const warm = BOND_WARM_RE.exec(t)
    // ★ 正面词**自己**也要过否定闸：「你在这里也没人高兴」里被否定的是 `高兴`
    //   （`没` 紧贴在它前面），只检查 `你在这里` 会漏掉这一整句。
    if (warm && !nearNegation(t, warm.index)) {
      return { hit: true, why: `命中归属信号「${weak[0]}」+ 正面词「${warm[0]}」` }
    }
  }
  return { hit: false }
}

/** 单条消息参与判定的最大长度（长文只取前 300 字就够判情绪，且省时间）。 */
export const AFFECT_SCAN_CHARS = 300

/** 短于这个长度不做判定（"累" 这种单字不成句，判它误报率太高）。 */
export const AFFECT_MIN_CHARS = 2

/** 归一化：去控制字符、压空白。**不改变语义**，只让它可判。 */
function normalize(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, AFFECT_SCAN_CHARS)
}

/** 找需要线索（同样跳过转述、否定、以及"不是跟我说的"）。 */
function pickNeed(text) {
  for (const cue of NEED_CUES) {
    cue.re.lastIndex = 0
    let m
    while ((m = cue.re.exec(text)) !== null) {
      if (!nearThirdParty(text, m.index) && !nearNegation(text, m.index) && !nearNeedActor(text, m.index)) {
        return { at: m.index, word: m[0], need: cue.need }
      }
      if (m.index === cue.re.lastIndex) cue.re.lastIndex += 1
    }
  }
  return null
}

/**
 * 判定一条消息是不是"在向机器人倾注情绪"。
 *
 * @param {{text?: string}} opts
 * @returns {{
 *   hit: boolean, state: string|null, need: string|null,
 *   strength: string|null, why: string, word?: string
 * }}
 *   `why` 是给人看的原因（进日志与审计），**不是**给模型的。
 */
export function detectAffectPour({ text } = {}) {
  const t = normalize(text)
  if (t.length < AFFECT_MIN_CHARS) return { hit: false, state: null, need: null, strength: null, why: '太短，不判' }

  const stateHit = pickState(t)
  const needHit = pickNeed(t)
  const poured = POUR_SIGNAL_RE.test(t)

  // ── 接纳 / 归属（用户点名的例句走这一支）────────────────────────────────
  // ★ 位置在情绪判定**之前**：这类话往往既没有情绪词也没有需要线索，
  //   但它是最该记住的一类（"你在这里是被欢迎的"）。命中就记 need='stay'。
  // ★★ 「没有可用状态」而不是「没有状态线索」：用户那句原话里还带着
  //   「大家都**开心**了😉」—— 那是个**被拒的**状态线索（第三方主语）。
  //   原来写成 `!stateHit`，于是整句在下一道闸被 `hit:false` 掉，
  //   接纳信号**恰好被别人的情绪挡住**。被拒的状态本来就不参与结论，不该挡。
  const bond = detectBondSignal({ text: t })
  const usableState = stateHit && !stateHit.excluded
  if (bond.hit && !usableState && !needHit) {
    return { hit: true, state: null, need: 'stay', strength: null, word: '', why: bond.why }
  }

  // ── 真实性的第一、二道闸：命中了，但说的**不是他自己** ──────────────────
  //   ① third-party：「我朋友很累」—— 落到他的档案里就是一条假记忆；
  //   ② non-self-subject：「这游戏崩溃了」—— 强情绪词，但主语是那件事。
  //   两种都**不记**。没有需要表达时直接放过；有需要表达时只记"需要"那一半
  //   （「我难受，你别问了」里"别问了"确实是他对机器人的要求，与状态无关）。
  if (stateHit?.excluded && !needHit) {
    const whyWord =
      stateHit.excluded === 'third-party'
        ? '紧邻第三方主语，判为转述别人的事'
        : stateHit.excluded === 'negated'
          ? '紧邻否定词（"不用担心"这类），语义是相反的'
          : '主语是那件事/那个东西，不是他的状态'
    return { hit: false, state: null, need: null, strength: null, why: `命中「${stateHit.word}」但${whyWord}` }
  }

  const usable = stateHit && !stateHit.excluded
  const state = usable ? stateHit.state : null
  const strength = usable ? stateHit.strength : null
  // ★ 接纳信号与真实状态可以**同一条消息里都有**（「你在这里真好，不过我今天好累」）。
  //   显式的需要表达优先（那句更具体）；没有显式需要时，接纳补上 `stay`，
  //   于是两种信号都不丢 —— 条目读作「他很累的时候希望你留在这里、继续和大家聊天」。
  const need = needHit?.need ?? (bond.hit ? 'stay' : null)
  const word = (usable ? stateHit.word : null) ?? needHit?.word ?? ''

  if (state && strength === STRENGTH.STRONG) {
    return { hit: true, state, need, strength, word, why: `命中强情绪词「${word}」` }
  }
  if (state && strength === STRENGTH.WEAK && (need || poured)) {
    return {
      hit: true,
      state,
      need,
      strength,
      word,
      why: `弱情绪词「${word}」+${need ? '需要表达' : '倾注信号'}`,
    }
  }
  if (!state && need) {
    const suffix = stateHit?.excluded ? '（状态那句说的是别的人/别的事，没记）' : ''
    return { hit: true, state: null, need, strength: null, word, why: `命中需要表达「${word}」${suffix}` }
  }
  if (state && strength === STRENGTH.WEAK) {
    return { hit: false, state: null, need: null, strength: null, why: `只有弱情绪词「${word}」，没有倾注信号，按闲聊放过` }
  }
  return { hit: false, state: null, need: null, strength: null, why: '没有情绪/需要线索' }
}

/**
 * 「他处于这个状态**的时候**」——写成时间状语，而不是"他现在如何"。
 *
 * ★ 为什么不做成"当前状态"：长期记忆是**跨重启、跨会话**的，
 *   把"他现在很难过"存成长期事实，一周后它就成了一句假话。
 *   而"他难过的时候想有人听着"**什么时候读都是对的** —— 它是
 *   关于**怎么对待他**的知识，不是关于此刻的断言。
 */
const STATE_WHEN = {
  low: '情绪低落的时候',
  anxious: '焦虑的时候',
  angry: '生气的时候',
  tired: '很累的时候',
  lonely: '觉得孤单的时候',
  excited: '心情不错的时候',
}

/** 他希望被怎样对待（同样只留可执行的那一点）。 */
const NEED_THEN = {
  listen: '想有人听着',
  space: '想自己待一会儿',
  advice: '想听点建议',
  distract: '想换个话题',
  // ★ 接纳/归属：说的是"希望你留在这里"。落成条目就是**这条**——
  //   它同时是"他对机器人的态度"和"机器人该怎么做"（继续待着，别缩回去）。
  stay: '希望你留在这里、继续和大家聊天',
  unknown: '',
}

/**
 * 把判定结果写成**一句可长期保存、且值得长期保存的话**。
 *
 * ★★ 为什么是模板而不是原文（这一条同时是隐私与"真实"两条要求的落点）：
 *   · **隐私**：倾诉里往往混着具体人事与隐私（"我离婚了""我妈查出…"），
 *     存原文等于把最脆弱的那段永久留在磁盘上，而且每一轮都会被注入；
 *   · **真实**：模板只保留**他自己表达出的**状态与需要，不含任何
 *     由模型替他补的细节 —— 我们不会记下他没说过的事。
 *
 * ★ 措辞纪律（三条，都有理由）：
 *   ① **写成时间状语**（"…的时候"）而不是当下断言 ⇒ 什么时候读都成立，
 *      不会变成一句过期的假话（见 `STATE_WHEN`）；
 *   ② **不许写成祈使句**（"以后要…""必须…""别再说…"）⇒ 那会被
 *      `screenEntry` 判成"像行为指令"而拒绝 —— 行为指令是**管理员专属**的
 *      另一档，不能靠一次情绪表达就绕过去。测试里钉着这条边界；
 *   ③ 结尾用**陈述**而不是命令（"细节他没说"而非"别追问"）⇒
 *      它告诉未来的自己"你不知道发生了什么"，从而不会编细节；
 *      而陈述句永远不会被误判成"在下指令"。
 *   ⚠️ 那个结尾**只在有状态时**加：`stay`（接纳/归属）这类只有需要的条目
 *      没有"发生了什么"可言，硬加一句"细节他没说"会显得莫名其妙。
 *
 * @returns {string} 形如「他情绪低落的时候想有人听着（细节他没说）」/「他希望你留在这里、继续和大家聊天」
 */
export function affectEntryText({ state = null, need = null } = {}) {
  const s = STATE_WHEN[state] ?? ''
  const n = NEED_THEN[need] ?? ''
  if (!s && !n) return ''
  const core = s && n ? `他${s}${n}` : s ? `他${s}` : `他${n}`
  return s ? `${core}（细节他没说）` : core
}
