/**
 * 会话桥接：把「DSH 的事件流」翻译成人话。
 *
 * ── 它解决的问题 ───────────────────────────────────────────────────────
 * sdk 服务器不会直接回你一句"答案是 X"。它回的是**一串事件**：
 *
 *   turn/start            ← 这一轮开始了
 *   tool/call             ← 它决定去查个文件
 *   tool/result           ← 文件内容回来了
 *   assistant/message     ← 它说话了（**答案在这里**）
 *   turn/end              ← 这一轮结束了
 *
 * 所以我们需要一个"回合收集器"：把这一串事件收拢起来，等到 turn/end，
 * 再交出一份结果（说了什么、花了多少 token、发生了什么错误）。
 *
 * ── 一个容易踩的坑（来自同类项目的实录）──────────────────────────────
 * 收集文本时**只认 assistant/message**，绝不能去累加 assistant/chunk 之类
 * 的增量事件 —— 否则同一句话会被算两次，表现为回复文字翻倍
 * （"收到" → "收到收到"）。这里从设计上就只认 assistant/message。
 */

/**
 * 从 assistant/message 事件里取出文本。
 *
 * 取证（官方 SessionEventMap，逐字）：
 *   'assistant/message': { turn; step; message: AssistantMessage;
 *                          stream: AssistantStreamRecord[]; usage?: TokenUsage; }
 * 而 AssistantMessage.content 是块数组，块形如 { type:'text', text }。
 */
export function textOfAssistantMessage(data) {
  const content = data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** 取出这一轮的思考内容（reasoning 块）。 */
export function reasoningOfAssistantMessage(data) {
  const content = data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * 一个回合（turn）的收集器。
 *
 * 用法：
 *   const turn = new TurnCollector(sessionId)
 *   // 把每个 session.event 都喂进来
 *   turn.push(event)
 *   // 等它结束
 *   const result = await turn.finished()
 */
export class TurnCollector {
  #resolve = null
  #promise = null
  #settled = false

  constructor(sessionId, { timeoutMs = 10 * 60_000, label = '' } = {}) {
    this.sessionId = sessionId
    this.label = label
    this.timeoutMs = timeoutMs
    this.texts = []
    this.thinking = ''
    // 累加后的用量。初始为空对象（不是 null）：`#accumulateUsage` 依赖它做累加基准，
    // 而"这个回合到底有没有用量"用 `steps` 判断更明确（steps=0 就是没测到）。
    this.usage = {}
    this.toolCalls = []
    this.approvals = []
    /**
     * 被拒绝的审批数量。
     *
     * 用途：回合中途「先应一声」要判断"是不是卡在权限上"（`blocked` 那一类）。
     * 只看 `toolCalls` 是看不出来的 —— 工具**调了但被挡在审批那一步**，
     * 从工具列表上看和"正在跑"一模一样，而使用者实际等来的是失败。
     */
    this.deniedApprovals = 0
    this.endReason = null
    this.error = null
    this.startedAt = Date.now()
    this.endedAt = null
    this.eventTypes = []

    this.#promise = new Promise((resolve) => (this.#resolve = resolve))

    this.timer = setTimeout(() => {
      this.#settle({ timedOut: true })
    }, timeoutMs)
    // 不要让这个定时器单独把进程吊住；主进程有自己的生命周期管理。
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** 喂一个会话事件进来。 */
  push(event) {
    if (this.#settled || !event) return
    const type = String(event.type ?? '')
    this.eventTypes.push(type)
    const data = event.data ?? {}

    switch (type) {
      case 'assistant/message': {
        const text = textOfAssistantMessage(data)
        if (text) this.texts.push(text)
        const reasoning = reasoningOfAssistantMessage(data)
        if (reasoning) this.thinking += reasoning
        // ★ 用量必须**逐步累加**，不能只留最后一步。
        //
        // 一个回合有很多步（实测一轮 15 步），每步都带一份 usage。
        // 而 `totalTokens` 是"这一步上下文有多大"的**快照**（随步递增），
        // 累加它等于把同一段上下文重复计费十几次；所以：
        //   · 四个**可累加**的量分别求和；
        //   · `lastContextTokens` 只取**最后一步**的值（那是真正的上下文占用）。
        this.#accumulateUsage(data.usage, data.message?.source)
        break
      }
      case 'tool/call': {
        this.toolCalls.push({ name: data.name ?? '?', callId: data.callId ?? null })
        break
      }
      case 'approval/asked': {
        this.approvals.push({
          id: data.id ?? null,
          toolName: data.toolName ?? '?',
          reason: data.reason ?? '',
          outcome: null,
        })
        break
      }
      case 'approval/decided': {
        // 把结果回填到对应的审批记录上（这就是"越界被拒绝"的证据来源）
        const outcome = data.outcome ?? 'unknown'
        const target = this.approvals.find((a) => a.id === (data.id ?? null))
        if (target) target.outcome = outcome
        else this.approvals.push({ id: data.id ?? null, toolName: '?', reason: '', outcome })
        // 「先应一声」要据此判断"卡在权限上"，所以顺手计数。
        // `unavailable` = 无人可答（自动拒绝）；`rejected` = 有人明确拒绝。
        // 对使用者来说两种都是"做不了"，所以都算。
        if (outcome === 'unavailable' || outcome === 'rejected') this.deniedApprovals += 1
        break
      }
      case 'turn/end': {
        this.endReason = data.reason ?? null
        this.#settle({})
        break
      }
      default:
        break
    }
  }

  /** 主动终止（例如超时或用户取消）。 */
  abort(reason = 'aborted') {
    this.#settle({ aborted: true, abortReason: reason })
  }

  /**
   * 累加一步的用量。
   *
   * ── 口径（做错了账会差几十倍，全部有实测依据）──────────────────────────
   *   · `inputTokens` = **未命中缓存**的输入（贵的那部分）
   *   · `cacheReadTokens` = 缓存命中（约 1/50 价）—— 两者必须分开
   *   · `reasoningTokens` 是 `outputTokens` 的**一部分**，可以显示，
   *     但**绝不能再加一遍**进总量
   *   · `totalTokens` **不累加**，只留最后一步当"上下文占用"的观测值
   *
   * 实测恒等式（一轮 15 步全部成立）：
   *   inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens === totalTokens
   * 所以 `inputTokens` 确实是"未缓存"的那部分，不是全部输入。
   *
   * 缺席的字段保持 `null`（**不补 0**）：`0` 是"测到了 0"，`null` 是"没测到"。
   */
  #accumulateUsage(usage, source) {
    if (!usage || typeof usage !== 'object') return
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

    const prev = this.usage
    const cacheWrite = num(usage.cacheWriteTokens)
    const reasoning = num(usage.reasoningTokens)

    this.usage = {
      input: (prev?.input ?? 0) + (num(usage.inputTokens) ?? 0),
      cacheRead: (prev?.cacheRead ?? 0) + (num(usage.cacheReadTokens) ?? 0),
      // 有一步报了就当有：全部步骤都缺席才保持 null
      cacheWrite:
        cacheWrite === null && prev?.cacheWrite === null
          ? null
          : (prev?.cacheWrite ?? 0) + (cacheWrite ?? 0),
      output: (prev?.output ?? 0) + (num(usage.outputTokens) ?? 0),
      reasoning:
        reasoning === null && prev?.reasoning === null
          ? null
          : (prev?.reasoning ?? 0) + (reasoning ?? 0),
      // ⚠️ 不累加，只覆盖 —— 见上面注释
      lastContextTokens: num(usage.totalTokens) ?? prev?.lastContextTokens ?? null,
    }

    const route = source && source.provider && source.model
      ? `${source.provider}/${source.model}`
      : null
    if (route) this.usage.route = route
    this.usage.steps = (prev?.steps ?? 0) + 1
  }

  #settle(extra) {
    if (this.#settled) return
    this.#settled = true
    clearTimeout(this.timer)
    this.endedAt = Date.now()
    this.#resolve({
      sessionId: this.sessionId,
      label: this.label,
      text: this.texts.join('\n').trim(),
      thinking: this.thinking.trim(),
      usage: this.usage,
      toolCalls: this.toolCalls,
      approvals: this.approvals,
      deniedApprovals: this.deniedApprovals,
      endReason: this.endReason,
      durationMs: this.endedAt - this.startedAt,
      eventTypes: this.eventTypes,
      ...extra,
    })
  }

  finished() {
    return this.#promise
  }
}

/**
 * 会话路由器：管理「QQ 会话键 → 活跃回合」的登记。
 *
 * 为什么需要它：sdk 的事件通知只带 sessionId，不带"这是哪个 QQ 会话"。
 * 我们必须自己维护一张表：哪个 sessionId 现在正在等结果。
 * 同时它承担一个安全职责 —— **不认识的 sessionId 的事件直接丢弃**
 * （否则子代理或其他来源的事件可能被误发到 QQ 群里）。
 */
export class SessionRouter {
  #active = new Map() // sessionId -> TurnCollector
  #meta = new Map() // sessionId -> { kind, peerId, chatKey }

  constructor({ log = () => {} } = {}) {
    this.log = log
  }

  /** 登记一个会话对应的 QQ 身份。 */
  bind(sessionId, meta) {
    this.#meta.set(sessionId, meta)
  }

  metaOf(sessionId) {
    return this.#meta.get(sessionId) ?? null
  }

  isKnown(sessionId) {
    return this.#meta.has(sessionId)
  }

  /** 开始收集某会话的回合。 */
  beginTurn(sessionId, opts) {
    const collector = new TurnCollector(sessionId, opts)
    this.#active.set(sessionId, collector)
    return collector
  }

  /** 收到一个 session.event 时调用。返回是否被消费。 */
  handleEvent(sessionId, event) {
    const collector = this.#active.get(sessionId)
    if (!collector) return false
    collector.push(event)
    return true
  }

  /** 回合结束后解除登记。 */
  clear(sessionId) {
    this.#active.delete(sessionId)
  }

  get pendingCount() {
    return this.#active.size
  }
}
