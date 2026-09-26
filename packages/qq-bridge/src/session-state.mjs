/**
 * 会话状态机（**规则版**）：这段对话"聊到哪了"（H10）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 与 `tasks.mjs` 的分工（**两条轴，别混**）
 * ══════════════════════════════════════════════════════════════════════════
 * | | `tasks.mjs`（任务台账） | `session-state.mjs`（本模块） |
 * |---|---|---|
 * | 回答的问题 | **"我在做什么任务、做到哪一步"** | **"这段对话的走向"** |
 * | 粒度 | **任务**（一次委托） | **对话**（一直持续的那个会话） |
 * | 跨重启 | ✅ 落盘 | ❌ 只在内存（对话重启后本来就是新的） |
 * | 来源 | 工具调用流水（机械提炼） | 轮次与发言角色（规则统计） |
 *
 * 两者**都在注入提示词**，所以边界必须写死，否则会长成两套互相重复的东西：
 *   · 台账说"我做过 8 步、试过 2 个没成的" → 防**重复劳动**
 *   · 本模块说"这是第 12 轮、他刚问了我一句我还没答、我上一轮在翻文件" → 防**答非所问与复读**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么**不花模型调用**（而参考项目花了）
 * ══════════════════════════════════════════════════════════════════════════
 * 参考项目每轮回复后用**一次 LLM 调用**更新 16 字段状态机。我们不这么做，两个理由：
 *   ① 本项目**没有直连模型 API 的代码**，要走 DSH 就得再起一个进程（那是 R4 抽取在做的事，
 *      而它每 5 轮才一次；每轮都做等于把成本翻倍）；
 *   ② 更重要的：**"这段对话聊到哪了"里最有用的那几样本来就不需要语义** ——
 *      第几轮、谁在说话、上一轮我在干什么、我有没有问了他还没答。这些**规则算得出来**。
 *
 * ★ 因此本模块**刻意不算"话题"**（`currentThread`）—— 那是语义判断，规则硬做会写出
 *   一个看起来像话题、其实是"用户上一句话的前 20 字"的东西，反而误导模型。
 *   需要话题时，`tasks.mjs` 的 `goal`（用户原话）已经在提示词里了。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 水位（watermark / epoch）
 * ══════════════════════════════════════════════════════════════════════════
 * 每个会话维护一个**单调递增**的 `seq`：
 *   · `lastUserSeq`     = 最近收到的那条用户消息的序号
 *   · `lastConsumedSeq` = 当前这一轮正在回答的那条消息的序号
 * 两者的关系就是桥接里"旧回合作废"（`superseded`）那套机制的**显式形式**：
 * `lastUserSeq > lastConsumedSeq` = **又来了一条更新的消息**。
 * 把它显式化有两个好处：可离线测（不必真造两条并发消息）、以及能在注入里如实说明。
 */

/** 会话状态的闲置窗口：超过它就把这段对话当成"翻篇了"（与任务台账一致）。 */
export const SESSION_IDLE_MS = 30 * 60 * 1000

/** 工具分类：一格里最多留几个（只用于"别重复同一类动作"）。 */
export const MAX_MOVES = 6

/** 一次注入最多说几个"悬着的话头"。 */
export const MAX_OPEN_LOOPS = 2

/**
 * 工具名 → **动作类别**（不是动作全文）。
 *
 * 与 `tasks.describeAction` 的区别：那边要"读文件 a.txt"这种**具体描述**（干过什么），
 * 这边只要"读文件"这一**类**（别重复同一类动作）。两者用途不同，不合并。
 */
export function classifyMove(toolName) {
  const n = String(toolName ?? '')
  if (!n) return null
  if (n === 'web_search') return '搜索'
  if (n === 'web_fetch') return '抓网页'
  if (n === 'read' || n === 'read_image') return '读文件'
  if (n === 'glob' || n === 'grep') return '找东西'
  if (n === 'write' || n === 'edit') return '改文件'
  if (n === 'pwsh') return '跑命令'
  if (n.startsWith('job_')) return '后台任务'
  if (n.includes('qq_send_sticker')) return '发表情'
  if (n.includes('qq_poke')) return '戳一戳'
  if (n.includes('qq_')) return '查 QQ'
  return '用工具'
}

/** 从一回合的 ops 里提取"我上一轮干过哪几类事"（去重、保序）。 */
export function movesFromOps(ops = []) {
  const out = []
  for (const op of Array.isArray(ops) ? ops : []) {
    if (op?.type !== 'tool/call') continue
    const cat = classifyMove(op.name)
    if (cat && !out.includes(cat)) out.push(cat)
  }
  return out.slice(0, MAX_MOVES)
}

/**
 * 这句话是不是在**真的提问**（用于"我上一轮问了他还没答"）。
 *
 * ⚠️ 刻意保守，两条限制：
 *   ① 只看**最后一句**是否以问号结尾（长回答里夹一个反问不算"我在等他答"）；
 *   ② 回复太长（>120 字）时不算 —— 那是"讲完了顺口一问"，不是"卡在等他回话"。
 * 宁可漏（少提醒一次），也不要误报（把每轮都标成"我在等他回答"）。
 */
export function looksLikeQuestion(text) {
  const t = String(text ?? '').trim()
  if (!t || t.length > 120) return false
  const lastLine = t.split('\n').filter((l) => l.trim()).slice(-1)[0] ?? ''
  return /[？?]\s*$/.test(lastLine.trim())
}

/**
 * 造一个会话状态存储（**只在内存**，见文件头分工表）。
 *
 * @param {{idleMs?: number, now?: () => number}} [opts]
 */
export function createSessionStateStore({ idleMs = SESSION_IDLE_MS, now = () => Date.now() } = {}) {
  /** chatKey → state */
  const states = new Map()

  function fresh(chatKey, at) {
    return {
      chatKey: String(chatKey),
      startedAt: at,
      updatedAt: at,
      turnCount: 0,
      userTurns: 0,
      botTurns: 0,
      lastSpeakerRole: 'unknown',
      lastUserText: '',
      lastUserAt: 0,
      lastBotMoves: [],
      /** 悬着的话头：我上一轮问了他、他还没答。 */
      openLoops: [],
      lastUserSeq: 0,
      lastConsumedSeq: 0,
      seq: 0,
    }
  }

  /** 取状态；闲置超窗就**当成新对话**（与 tasks 台账同一条规则）。 */
  function get(chatKey) {
    const key = String(chatKey ?? '')
    if (!key) return null
    const at = now()
    const cur = states.get(key)
    if (!cur) return null
    if (at - cur.updatedAt > idleMs) {
      states.delete(key)
      return null
    }
    return cur
  }

  function ensure(chatKey) {
    const key = String(chatKey ?? '')
    if (!key) return null
    let st = get(key)
    if (!st) {
      st = fresh(key, now())
      states.set(key, st)
    }
    return st
  }

  /**
   * 记一条**用户**消息（只在这条消息真的会被回应时调用 —— 没唤醒的群消息不算对话）。
   *
   * @returns {number} 这条消息的序号（= `lastUserSeq`），调用方要把它带进这一轮
   */
  function noteUser({ chatKey, text = '', role = 'unknown' } = {}) {
    const st = ensure(chatKey)
    if (!st) return 0
    st.seq += 1
    st.lastUserSeq = st.seq
    st.turnCount += 1
    st.userTurns += 1
    st.updatedAt = now()
    st.lastSpeakerRole = String(role)
    st.lastUserText = String(text ?? '').slice(0, 120)
    st.lastUserAt = st.updatedAt
    // ⚠️ 这里**刻意不清 `openLoops`** —— 清掉的话，提示词里那句
    //    "你上一轮问了他：「…」—— 他这一轮开口了，先看他是不是在回答这个"
    //    就**永远渲染不出来**（`noteUser` 跑在拼提示词**之前**，清完再渲染等于没有）。
    //    生命周期由 `noteBot` 决定：每次机器人回话要么写上新的问句、要么清空，
    //    所以话头**恰好活一轮**，不会跨轮堆积。
    return st.lastUserSeq
  }

  /** 这一轮开始回答哪条消息（水位：`lastConsumedSeq`）。 */
  function noteConsumed({ chatKey, seq } = {}) {
    const st = ensure(chatKey)
    if (!st) return 0
    const n = Number(seq)
    st.lastConsumedSeq = Number.isFinite(n) && n > 0 ? n : st.lastUserSeq
    st.updatedAt = now()
    return st.lastConsumedSeq
  }

  /**
   * 记一条**机器人**回复（在真的发出去之后调用）。
   *
   * @param {{chatKey?: string, text?: string, ops?: object[]}} opts
   */
  function noteBot({ chatKey, text = '', ops = [] } = {}) {
    const st = ensure(chatKey)
    if (!st) return null
    st.seq += 1
    st.turnCount += 1
    st.botTurns += 1
    st.updatedAt = now()
    st.lastSpeakerRole = 'bot'
    st.lastBotMoves = movesFromOps(ops)
    // 悬着的话头：只有"真的在问他一句短的"才算（见 looksLikeQuestion 的取舍）
    if (looksLikeQuestion(text)) {
      const line = String(text).split('\n').filter((l) => l.trim()).slice(-1)[0].trim()
      st.openLoops = [{ text: line.slice(0, 60), at: st.updatedAt }].slice(0, MAX_OPEN_LOOPS)
    } else {
      st.openLoops = []
    }
    return st
  }

  /** 读一份快照（给排查/CLI/测试用）—— **返回副本**，外面改不动内部状态。 */
  function read(chatKey) {
    const st = get(chatKey)
    return st ? { ...st, lastBotMoves: [...st.lastBotMoves], openLoops: st.openLoops.map((l) => ({ ...l })) } : null
  }

  /** 有没有更新的消息还没被回答（水位比较；`superseded` 那套机制的显式形式）。 */
  function hasPendingNewer(chatKey) {
    const st = get(chatKey)
    if (!st) return false
    return st.lastUserSeq > st.lastConsumedSeq
  }

  function clear() {
    states.clear()
  }

  return { noteUser, noteConsumed, noteBot, read, hasPendingNewer, clear, size: () => states.size }
}

/**
 * 把状态渲染成**注入提示词的那一段**。
 *
 * 三条措辞纪律：
 *   ① **空的不写**：第 1 轮什么都没发生时不注入（省 token，也不给模型添噪音）；
 *   ② **说清这是"对话走向"，不是任务**（与任务台账并存，别让它以为这是两件事）；
 *   ③ **"悬着的话头"要给明确指令**（"他在回答你上一轮问的" / "你上一轮问了他还没答"），
 *      而不是只丢一句陈述 —— 陈述句模型会当背景，指令它才会用。
 *
 * @param {object} state `read()` 的结果
 * @param {{maxMoves?: number}} [opts]
 * @returns {string} 空串 = 没什么可说的
 */
export function renderSessionStateBlock(state, { maxMoves = MAX_MOVES } = {}) {
  if (!state || !state.chatKey) return ''
  const lines = []
  // 第 1 轮（还没有机器人发言）时不注入：那时没有任何"走向"可说
  if (state.botTurns === 0) return ''
  lines.push(`【对话走向（不是任务台账 —— 那个说的是"我在做什么"，这里说的是"我们聊到哪了"）】`)
  // ⚠️ 用**来回数**（= 对方说了几次）而不是 `turnCount`：`turnCount` 把每条消息都算一轮，
  //    于是第 3 次对话会渲染成"这是第 5 轮" —— 模型读到它会误判"聊了很久"。
  //    两个计数都如实报出来（"对方 3 次 / 你 2 次"），不合成一个含糊的数字。
  lines.push(`这是第 ${state.userTurns} 个来回（对方说了 ${state.userTurns} 次，你回了 ${state.botTurns} 次）。`)
  if (state.lastBotMoves?.length) {
    lines.push(
      `你上一轮动了这些：${state.lastBotMoves.slice(0, maxMoves).join('、')}。` +
        '**别重复同一类动作** —— 同一件事换个说法再搜一遍、同一个文件再读一遍，都是复读。',
    )
  }
  if (state.openLoops?.length) {
    lines.push(`⚠️ 你上一轮问了他：「${state.openLoops[0].text}」—— 他这一轮开口了，**先看他是不是在回答这个**。`)
  }
  return lines.join('\n')
}
