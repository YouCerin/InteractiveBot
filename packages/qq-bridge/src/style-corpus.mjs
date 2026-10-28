/**
 * 语感语料的**清洗与分层抽样**（0.3.3 · P1，纯函数）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这条路径要回答的问题
 * ══════════════════════════════════════════════════════════════════════════
 * 使用者要做一份语料，让机器人学**群友怎么说话**（含"说什么"的偏好），
 * 流程是「规则预筛 → 人工剔除 → 蒸馏成画像/样本」。本模块只做**第一步**：
 * 把 38,981 条原始消息砍成一份**可以给人过目**的候选池（默认 150 条）。
 *
 * ── 三条判据（都是拿真数据量出来的，别凭直觉改）────────────────────────────
 * 1. **`is_bot` 是唯一权威判据，名字只能当辅助证据。**
 *    真库里 1,578 行署名「小鲸鱼」，但那是 `user_id 340954227` 的**另一个真人**
 *    （机器人 QQ 是 200000001，它自己的行 `sender_name` 是 null 且 `is_bot=1`）。
 *    ∴ 按名字过滤会**误删一个真人**；本模块只按 `is_bot` 过滤，名字只写进统计。
 * 2. **单拎一句学不到东西**（"6"/"草"/"?"）。每条样本都带**前几条上下文**，
 *    包括上下文里的机器人行 —— 那是"它在接什么话"的证据，不是要学的样本。
 * 3. **分层抽样，不是均匀抽样。** 真库里 26,474 条挤在 2 天（一个群的爆发），
 *    均匀抽会让语感几乎全部来自那一群那两天。∴ 按群分层（权重 sqrt，避免大群吞掉全部），
 *    并在群内按人设上限（单个人不能超过配额的两成）。
 *
 * ── 边界（写死在这里，别在调用点放宽）──────────────────────────────────────
 * · 本模块**不读盘、不联网、不看时钟**：输入是行数组，输出是样本 + 统计（可断言）。
 * · **绝不静默补齐**：候选不够目标数时如实返回 `shortfall`，不复制、不编造。
 * · **不判"好人坏人"**：人工剔除是第二步的事。这里只按**结构性噪声**筛
 *   （纯图占位、链接、命令、@ 前缀、复读、过长），不做任何语义判断 ——
 *   语义判断交给人，这也是"人工剔除"存在的理由。
 */

/** 单条样本正文的长度窗口（真人消息实测平均 15 字、95% 在 40 字以内）。 */
export const STYLE_LIMITS = {
  minChars: 2,
  maxChars: 40,
  /** 每条样本带几条上文（含机器人自己的行 —— 那是语境，不是样本）。 */
  contextCount: 2,
  /** 单个人在一个群里的样本上限 = ceil(该群配额 × 这个比例)。0.2 = 两成。 */
  perSpeakerRatio: 0.2,
  /** 群权重用 `count^weightExp`：0.5 = sqrt（大群有优势，但不会吞掉全部）。 */
  weightExp: 0.5,
}

/** 结构性噪声：这些**不是**"不会说话"，是"不是话"。 */
const NOISE = [
  { why: '纯图/表情占位', test: (t) => /^\[(图片|表情包?|贴纸|视频|语音|文件|动画表情)[^\]]*\]$/u.test(t) },
  { why: '带链接', test: (t) => /https?:\/\//i.test(t) },
  { why: '命令/占位符', test: (t) => /^\\|^\/|\[mid:|\[reply:|\[at:/u.test(t) },
  { why: '以 @ 开头（多半是点名/复读别人）', test: (t) => /^@/.test(t) },
  { why: '整条是标点或符号（"???""。。。""6"这类不算话）', test: (t) => !/[\p{L}\p{Script=Han}]/u.test(t) },
  { why: '像系统提示/公告（带【】开头或含"公告"）', test: (t) => /^【|公告|^\[系统/u.test(t) },
]

/** 归一化后用来判"复读"的键（同一群里同一句只说一次）。 */
export function normalizeForDedupe(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[。，！？、…~～]/g, '')
    .toLowerCase()
}

/**
 * **低俗/攻击性关键词**预筛（0.3.3 · 使用者要求加的那一层）。
 *
 * ⚠️ 它只是**减少人工负担**，不是判据：
 *   · 关键词表永远不全 —— 第一版实测只命中候选池的 5%，而肉眼抽查 4 条里有 2 条明显不该学；
 *   · 一定有误伤（"屎山""尿性"这种自嘲词也在表里）。
 *   ∴ 被它拦下的条目**要能看见**（`stats.toxicRejected`），别做成黑箱。
 *   ★ 只匹配**明确的**侮辱/性/暴力词；不做"语气是否阴阳怪气"这种判断（那是人的事）。
 */
export const TOXIC_PATTERNS = [
  /傻逼|沙比|煞笔|sb(?![\p{L}])/iu,
  /你妈|尼玛|妈的|妈了|日你|操你|操死|狗日|丢你老母/u,
  /去死|死全家|滚出去|滚蛋|狗东西/u,
  /鸡巴|jb(?![\p{L}])|撸管|撸得|打飞机|约炮|约一炮/u,
  /屎|尿|屁眼|骚货|贱人|婊子/u,
  /fuck|shit|bitch|pussy|dick|nigga/iu,
]

/** 这一句命中了低俗/攻击性关键词吗（命中就返回那一条正则的源码，便于统计）。 */
export function screenToxic(text) {
  const t = String(text ?? '')
  for (const re of TOXIC_PATTERNS) {
    if (re.test(t)) return { ok: false, why: '低俗/攻击性关键词（预筛，理由只作参考）', pattern: String(re) }
  }
  return { ok: true }
}

/**
 * 判断一行能不能当样本（**只做结构判断**）。
 *
 * @param {{text?: string, isBot?: boolean}} row
 * @param {{minChars?: number, maxChars?: number}} [opts]
 * @returns {{ok: true, text: string} | {ok: false, why: string}}
 */
export function isLearnable(row, { minChars = STYLE_LIMITS.minChars, maxChars = STYLE_LIMITS.maxChars, toxicity = true } = {}) {
  const raw = String(row?.text ?? '')
  const text = raw.replace(/\s+/g, ' ').trim()
  if (row?.isBot === true) return { ok: false, why: '机器人自己说的（is_bot）' }
  if (!text) return { ok: false, why: '空' }
  const len = [...text].length
  // ★ 理由里**不带具体字数**：带了会让统计按长度分裂成一堆"太长（52 字）""太长（53 字）"，
  //   反而看不出"主要筛掉的是什么"（第一版就这么裂成了 30 多行）。
  if (len < minChars) return { ok: false, why: `太短（少于 ${minChars} 字）` }
  if (len > maxChars) return { ok: false, why: `太长（超过 ${maxChars} 字）` }
  for (const rule of NOISE) {
    if (rule.test(text)) return { ok: false, why: rule.why }
  }
  // ★ 最后一道：低俗/攻击性关键词（使用者要求加的预筛层）。
  //   放在结构判断**之后**：先筛"不是话"的，再筛"是话但不该学"的 ——
  //   这样统计里两类的数量才对得上（顺序反了会让"纯图占位"也被算进"低俗"）。
  if (toxicity !== false) {
    const tox = screenToxic(text)
    if (!tox.ok) return { ok: false, why: tox.why }
  }
  return { ok: true, text }
}

/** 确定性 PRNG（mulberry32）—— 同一个 seed 必须给出同一份候选池（可复现）。 */
export function makeRng(seed = 1) {
  let a = Number(seed) >>> 0 || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 名字比对用的归一化：小写、去掉括号/破折号/空格这类装饰。 */
function normName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[【】\[\]<>《》()（）\-_—·\s]/g, '')
}

/**
 * 把"群名（或群号）"解析成 `chatKey` 列表（0.3.3 · 只从指定几个群里取）。
 *
 * ★ 为什么按**包含**匹配而不是全等：真实群名带前缀（`<CJLU>岁岁粉丝后援会`、
 *   `【CJLU】三角洲行动`、`Minecraft-中国计量大学`），使用者记的是**人话名字**。
 *   归一化（小写 + 去括号/短横/空格）之后用 `includes`，`minecraft中国计量大学`
 *   能命中 `Minecraft-中国计量大学`，又不会命中 `打洲社-中国计量大学`。
 *
 * ★ 三条不许放宽的判据：
 *   1. **歧义要报错**（一条查询命中多个群 ⇒ 拒绝，不"取第一个"）—— 取第一个等于替使用者猜；
 *   2. **没命中要报错并列出可用群名**（否则他会以为"筛过了"，其实一个群都没匹配上）；
 *   3. 纯数字直接当群号（不必在 roster 里，语料可能留着已退的群）。
 *
 * @param {{roster?: Array<{groupId:string, name:string}>, wanted?: string[]}} opts
 * @returns {{ok:true, groups:string[], matched:Array<{query:string, groupId:string|null, name:string}>}
 *          | {ok:false, why:string}}
 */
export function matchGroups({ roster = [], wanted = [] } = {}) {
  const list = (Array.isArray(roster) ? roster : [])
    .map((g) => ({ groupId: String(g?.groupId ?? '').trim(), name: String(g?.name ?? '').trim() }))
    .filter((g) => g.groupId)
  const queries = (Array.isArray(wanted) ? wanted : []).map((q) => String(q ?? '').trim()).filter(Boolean)
  if (!queries.length) return { ok: false, why: '没有指定群（fail-closed：不给就不知道该取哪些群）' }

  const groups = []
  const matched = []
  const problems = []
  for (const q of queries) {
    if (/^\d{5,15}$/.test(q)) {
      groups.push(`group:${q}`)
      matched.push({ query: q, groupId: q, name: '' })
      continue
    }
    const nq = normName(q)
    const hits = list.filter((g) => normName(g.name).includes(nq))
    if (hits.length === 0) {
      problems.push(`「${q}」没有任何群名能对上`)
      continue
    }
    if (hits.length > 1) {
      // ★ 歧义：说出命中了哪几个，让人自己把名字写全 —— 不替他挑
      problems.push(`「${q}」同时命中 ${hits.map((h) => `「${h.name}」(${h.groupId})`).join('、')}，请写得更具体`)
      continue
    }
    groups.push(`group:${hits[0].groupId}`)
    matched.push({ query: q, groupId: hits[0].groupId, name: hits[0].name })
  }
  if (problems.length) {
    return {
      ok: false,
      why: `${problems.join('；')}。当前拿到的群名：${list.map((g) => `「${g.name}」`).join('、') || '（一个都没有）'}`,
    }
  }
  return { ok: true, groups, matched }
}

/**
 * 把清洗后的行按群分层抽样成候选池。
 *
 * @param {object} opts
 * @param {Array<{chatKey:string, text:string, isBot?:boolean, senderName?:string|null,
 *                userId?:string|null, createdAt?:number, messageId?:string|null}>} opts.rows
 *   同一群的行**必须按时间升序**（本函数用"前几条"当上下文，不自己排序）。
 * @param {number} [opts.targetCount] 目标条数（默认 150）
 * @param {number} [opts.seed] 随机种子（同种子 ⇒ 同结果）
 * @param {string[]} [opts.groups] 只在这些群里选（缺省 = 全部 `group:`）
 * @param {number} [opts.contextCount]
 * @param {number} [opts.perSpeakerRatio]
 * @returns {{samples: Array<object>, stats: object}}
 */
export function curate({
  rows = [],
  targetCount = 150,
  seed = 20261018,
  groups = null,
  contextCount = STYLE_LIMITS.contextCount,
  perSpeakerRatio = STYLE_LIMITS.perSpeakerRatio,
  weightExp = STYLE_LIMITS.weightExp,
  toxicity = true,
} = {}) {
  const stats = {
    input: Array.isArray(rows) ? rows.length : 0,
    dropped: {},
    /** 被**关键词预筛**拦下的条目（只留前 20 条，供人回看：预筛一定会误伤） */
    toxicRejected: [],
    /** 每个群里"能当样本"的行数（清洗后） */
    eligibleByGroup: {},
    /** 每个群实际选了几条、每个发言人几条 */
    pickedByGroup: {},
    pickedBySpeaker: {},
    /** 目标没填满时的缺口（**如实报**，不补齐） */
    shortfall: 0,
    seed,
    targetCount,
    /** 名字层面的观察，只写统计：库里可能存在"署名和机器人同名但不是机器人"的人 */
    nameCollisions: {},
  }
  const bump = (why) => {
    stats.dropped[why] = (stats.dropped[why] ?? 0) + 1
  }

  const allow = Array.isArray(groups) && groups.length > 0 ? new Set(groups) : null
  // ── ① 按群分桶（保持时间顺序；上下文要靠它）────────────────────────────
  const buckets = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const chatKey = String(row?.chatKey ?? '')
    if (!chatKey.startsWith('group:')) {
      bump('不是群聊')
      continue
    }
    if (allow && !allow.has(chatKey)) {
      bump('不在指定群里')
      continue
    }
    if (!buckets.has(chatKey)) buckets.set(chatKey, [])
    buckets.get(chatKey).push(row)
    // 名字观察：署名叫“小鲸鱼”但 is_bot 不是 true 的行 —— 记下来，别拿它当过滤依据
    const name = String(row?.senderName ?? '')
    if (/小鲸鱼/.test(name) && row?.isBot !== true) {
      stats.nameCollisions[name] = (stats.nameCollisions[name] ?? 0) + 1
    }
  }

  // ── ② 逐群清洗 + 去复读 ────────────────────────────────────────────────
  const eligible = new Map() // chatKey -> [{row, text, index}]
  for (const [chatKey, list] of buckets) {
    const seen = new Set()
    const keep = []
    list.forEach((row, index) => {
      const v = isLearnable(row, { toxicity })
      if (!v.ok) {
        bump(v.why)
        // ★ 预筛拦下的**留个样本**：关键词表一定误伤，人得能回看
        if (String(v.why).startsWith('低俗') && stats.toxicRejected.length < 20) {
          stats.toxicRejected.push({
            chatKey,
            sender: String(row?.senderName ?? row?.userId ?? ''),
            text: String(row?.text ?? '').slice(0, 60),
          })
        }
        return
      }
      const key = normalizeForDedupe(v.text)
      if (seen.has(key)) {
        bump('复读（同群同句）')
        return
      }
      seen.add(key)
      keep.push({ row, text: v.text, index })
    })
    eligible.set(chatKey, keep)
    stats.eligibleByGroup[chatKey] = keep.length
  }

  // ── ③ 分层配额（权重 = count^weightExp）────────────────────────────────
  const keys = [...eligible.keys()].filter((k) => eligible.get(k).length > 0)
  const weights = keys.map((k) => [k, Math.pow(eligible.get(k).length, weightExp)])
  const totalWeight = weights.reduce((s, [, w]) => s + w, 0)
  const quota = new Map()
  if (totalWeight > 0) {
    for (const [k, w] of weights) {
      const raw = (targetCount * w) / totalWeight
      quota.set(k, Math.max(1, Math.min(eligible.get(k).length, Math.floor(raw))))
    }
  }

  // ── ④ 群内抽样（确定性洗牌 + 每人上限）─────────────────────────────────
  const rng = makeRng(seed)
  const picked = []
  const pickedPerGroup = new Map()
  for (const k of keys) {
    const list = [...eligible.get(k)]
    // Fisher–Yates（用确定性 rng）
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1))
      ;[list[i], list[j]] = [list[j], list[i]]
    }
    const want = quota.get(k) ?? 0
    const cap = Math.max(2, Math.ceil(want * perSpeakerRatio))
    const bySpeaker = new Map()
    const mine = []
    for (const item of list) {
      if (mine.length >= want) break
      const who = String(item.row?.senderName ?? item.row?.userId ?? '(无名)')
      const used = bySpeaker.get(who) ?? 0
      if (used >= cap) continue
      bySpeaker.set(who, used + 1)
      mine.push({ ...item, who })
    }
    pickedPerGroup.set(k, mine.length)
    for (const [who, n] of bySpeaker) stats.pickedBySpeaker[who] = (stats.pickedBySpeaker[who] ?? 0) + n
    picked.push(...mine.map((item) => ({ chatKey: k, ...item })))
  }

  // ── ⑤ 没填满就用**剩余供给**补（仍然遵守每人上限，且不重复）─────────────
  if (picked.length < targetCount) {
    const taken = new Set(picked.map((p) => `${p.chatKey}#${p.index}`))
    const pool = []
    for (const k of keys) {
      for (const item of eligible.get(k)) {
        if (!taken.has(`${k}#${item.index}`)) pool.push({ chatKey: k, ...item })
      }
    }
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    for (const item of pool) {
      if (picked.length >= targetCount) break
      const who = String(item.row?.senderName ?? item.row?.userId ?? '(无名)')
      const cap = Math.max(2, Math.ceil((targetCount / Math.max(1, keys.length)) * perSpeakerRatio))
      if ((stats.pickedBySpeaker[who] ?? 0) >= cap) continue
      stats.pickedBySpeaker[who] = (stats.pickedBySpeaker[who] ?? 0) + 1
      pickedPerGroup.set(item.chatKey, (pickedPerGroup.get(item.chatKey) ?? 0) + 1)
      picked.push(item)
    }
  }

  // ── ⑥ 组装样本（带上下文）+ 如实报缺口 ──────────────────────────────────
  const samples = picked.slice(0, targetCount).map((item) => {
    const list = buckets.get(item.chatKey) ?? []
    const before = []
    for (let i = item.index - 1; i >= 0 && before.length < contextCount; i -= 1) {
      const r = list[i]
      const text = String(r?.text ?? '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      before.unshift({
        // ★ 上下文里**保留**机器人自己的行：那段是"它在接什么话"的证据
        self: r?.isBot === true,
        name: String(r?.senderName ?? r?.userId ?? (r?.isBot ? '小鲸鱼' : '某人')),
        text: text.slice(0, 60),
      })
    }
    return {
      chatKey: item.chatKey,
      sender: item.who,
      text: item.text,
      at: Number(item.row?.createdAt ?? 0) || null,
      messageId: item.row?.messageId ?? null,
      before,
    }
  })

  stats.pickedByGroup = Object.fromEntries([...pickedPerGroup.entries()])
  stats.pickedTotal = samples.length
  stats.shortfall = Math.max(0, targetCount - samples.length)
  return { samples, stats }
}
